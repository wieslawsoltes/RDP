"""Browser/worker/WS/TLS/NLA licensing and persistence gating; co-developed peer."""
from __future__ import annotations
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    subprocess.run(['npm', 'run', 'build:pages'], cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix='rdp-license-browser-') as temporary:
        temp = Path(temporary)
        shutil.copytree(ROOT / 'dist/pages', temp / 'RDP')
        manifest = json.loads((temp / 'RDP/build.json').read_text())
        assert not any('licensing/' in name or 'gateway/' in name for name in manifest['files'])
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(temp))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 8799), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with (temp / 'fixture.log').open('w+') as log:
            fixture = subprocess.Popen(['node', 'tests/fixtures/LicensingBrowser.js'], cwd=ROOT,
                stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT, text=True)
            try:
                def wait_log(value: str) -> None:
                    deadline = time.monotonic() + 15
                    while True:
                        log.seek(0); output = log.read()
                        if value in output:
                            return
                        if fixture.poll() is not None or time.monotonic() >= deadline:
                            raise AssertionError({'expected': value, 'output': output})
                        time.sleep(0.025)

                wait_log('LICENSE_BROWSER_READY')
                with sync_playwright() as playwright:
                    executable = os.environ.get('CHROMIUM') or shutil.which('google-chrome') or shutil.which('chromium')
                    browser = playwright.chromium.launch(headless=True, executable_path=executable)
                    try:
                        page = browser.new_page(viewport={'width': 1440, 'height': 1100})
                        errors: list[str] = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.add_init_script('''(() => {
                            globalThis.licenseProbe = [];
                            const NativeWorker = globalThis.Worker;
                            globalThis.Worker = class extends NativeWorker {
                                constructor(...args) {
                                    super(...args);
                                    this.addEventListener('message', ({data}) => {
                                        if (data.type === 'licensing') licenseProbe.push(data);
                                    });
                                }
                            };
                        })();''')
                        page.goto('http://127.0.0.1:8799/RDP/')
                        page.locator('#gateway-url').fill('http://127.0.0.1:8798')
                        page.locator('#bridge-token').fill('browser-fixture-token-0123456789abcdef')
                        page.locator('#load-targets').click()
                        expect(page.locator('#form-message')).to_contain_text('2 allowlisted targets', timeout=15000)

                        def connect(target: str) -> None:
                            page.locator('#target-id').select_option(target)
                            page.locator('#backend').select_option('canvas')
                            page.locator('#username').fill('User')
                            page.locator('#domain').fill('LAB')
                            page.locator('#password').fill('Password')
                            page.locator('#connect-button').click()
                            expect(page.locator('#password')).to_have_value('')

                        connect('issued')
                        wait_log('LICENSE_SAVE_PENDING')
                        expect(page.locator('.session-foot')).to_contain_text('licensing')
                        expect(page.locator('.session-overlay')).to_be_visible()
                        assert not page.evaluate('() => licenseProbe.some(p => p.complete)')
                        fixture.stdin.write('release\n'); fixture.stdin.flush()
                        expect(page.locator('.session-foot')).to_contain_text('active', timeout=15000)
                        wait_log('LICENSE_SAVE_COMMITTED')
                        first = page.evaluate('() => licenseProbe.splice(0)')
                        assert [p['status'] for p in first] == ['requesting-license', 'challenge-verified', 'license-issued'], first
                        assert all(sorted(p) == ['complete', 'status', 'type'] for p in first), first
                        expect(page.locator('.session-overlay')).not_to_be_visible()
                        page.get_by_role('button', name='Disconnect and close session', exact=True).click()

                        connect('issued')
                        expect(page.locator('.session-foot')).to_contain_text('active', timeout=15000)
                        wait_log('LICENSE_PEER 2 18')
                        cached = page.evaluate('() => licenseProbe.splice(0)')
                        assert [p['status'] for p in cached] == ['cached-license', 'valid-client'], cached
                        assert all(sorted(p) == ['complete', 'status', 'type'] for p in cached), cached
                        page.get_by_role('button', name='Disconnect and close session', exact=True).click()

                        connect('bad')
                        expect(page.locator('.session-overlay h2')).to_have_text('LICENSE_MAC', timeout=15000)
                        expect(page.locator('.session-foot')).to_contain_text('failed')
                        assert not page.evaluate('() => licenseProbe.some(p => p.complete)')
                        page.get_by_role('button', name='Disconnect and close session', exact=True).click()
                        fixture.stdin.write('check\n'); fixture.stdin.flush()
                        wait_log('LICENSE_FIXTURE_CHECKED')
                        assert not errors, errors
                        print(json.dumps({'newLicenseIssued': True, 'activationWaitsForPersistence': True,
                            'cachedLicenseAccepted': True, 'badMacCannotActivate': True,
                            'browserContainsNoLicensingCryptoOrCal': True, 'pageErrors': errors,
                            'scope': 'Chromium, loopback WS/TLS/NLA and co-developed RDP peer; not independent Windows or hardware qualification'}, indent=2))
                    finally:
                        browser.close()
            finally:
                fixture.terminate()
                try:
                    fixture.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    fixture.kill(); fixture.wait()
                if fixture.stdin:
                    fixture.stdin.close()
                server.shutdown(); server.server_close()


if __name__ == '__main__':
    main()

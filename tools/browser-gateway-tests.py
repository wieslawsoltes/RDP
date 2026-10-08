"""Static subpath + separate gateway browser test using a co-developed RDP peer."""
from __future__ import annotations
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def main() -> None:
    subprocess.run(['npm', 'run', 'build:pages'], cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix='rdp-browser-') as temporary:
        temp = Path(temporary)
        shutil.copytree(ROOT / 'dist/pages', temp / 'RDP')
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(temp))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 8799), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with (temp / 'gateway.log').open('w+') as log:
            gateway = subprocess.Popen(['node', 'tests/fixtures/GatewayBrowser.js'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 10
                while True:
                    if gateway.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    try:
                        with socket.create_connection(('127.0.0.1', 8798), timeout=0.25):
                            break
                    except OSError:
                        if time.monotonic() >= deadline: raise RuntimeError('Gateway fixture startup timed out')
                        time.sleep(0.05)
                with sync_playwright() as playwright:
                    executable = os.environ.get('CHROMIUM') or shutil.which('google-chrome') or shutil.which('chromium')
                    browser = playwright.chromium.launch(headless=True, executable_path=executable)
                    try:
                        page = browser.new_page(viewport={'width': 1440, 'height': 1100})
                        errors = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.goto('http://127.0.0.1:8799/RDP/')
                        expect(page.locator('#gateway-url')).to_have_value('http://127.0.0.1:8787')
                        page.locator('#gateway-url').fill('http://127.0.0.1:8798')
                        page.locator('#bridge-token').fill('browser-fixture-token-0123456789abcdef')
                        page.locator('#load-targets').click()
                        expect(page.locator('#form-message')).to_contain_text('1 allowlisted target', timeout=15000)
                        expect(page.locator('#target-id')).to_have_value('fixture')
                        page.locator('#backend').select_option('canvas')
                        page.locator('#username').fill('User')
                        page.locator('#domain').fill('LAB')
                        page.locator('#password').fill('Password')
                        page.locator('#connect-button').click()
                        expect(page.locator('.session-foot')).to_contain_text('active', timeout=15000)
                        expect(page.locator('#password')).to_have_value('')
                        page.get_by_role('button', name='Disconnect and close session', exact=True).click()
                        page.locator('#gateway-url').fill('http://127.0.0.1:8797')
                        expect(page.locator('#bridge-token')).to_have_value('')
                        expect(page.locator('#target-id option')).to_have_count(0)
                        page.locator('#start-lab').click()
                        expect(page.locator('.session-foot')).to_contain_text('active', timeout=15000)
                        page.get_by_role('combobox', name='Remote desktop resolution').select_option('800x600')
                        expect(page.locator('.session-foot')).to_contain_text('800 × 600', timeout=15000)
                        page.get_by_role('button', name='Disconnect and close session', exact=True).click()
                        page.set_viewport_size({'width': 390, 'height': 844})
                        expect(page.locator('#start-lab')).to_be_visible()
                        page.goto('http://127.0.0.1:8799/RDP/apps/client/gateway.html')
                        expect(page.get_by_role('heading', name='Connect your browser.')).to_be_visible()
                        assert not errors, errors
                        print(json.dumps({'staticSubpath': '/RDP/', 'separateGateway': True,
                            'websocketTlsNlaActivation': True, 'endpointChangeClearsSecrets': True,
                            'labResize': '800x600', 'mobileViewport': '390x844', 'pageErrors': errors,
                            'scope': 'HTTP cross-origin loopback, co-developed RDP server, Canvas renderer; not public HTTPS-to-loopback or Windows/GPU qualification'}, indent=2))
                    finally:
                        browser.close()
            finally:
                gateway.terminate()
                try: gateway.wait(timeout=5)
                except subprocess.TimeoutExpired: gateway.kill(); gateway.wait()
                server.shutdown()
                server.server_close()

if __name__ == '__main__':
    main()

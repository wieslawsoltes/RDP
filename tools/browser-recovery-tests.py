"""Real Chromium + separate gateway + TLS/NLA RDP peer, with dropped pongs."""
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
TOKEN = 'browser-fixture-token-0123456789abcdef'


def main() -> None:
    subprocess.run(['npm', 'run', 'build:pages'], cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix='rdp-recovery-') as temporary:
        temp = Path(temporary)
        shutil.copytree(ROOT / 'dist/pages', temp / 'RDP')
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(temp))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 8799), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with (temp / 'gateway.log').open('w+') as log:
            gateway = subprocess.Popen(['node', 'tests/fixtures/HeartbeatBrowser.js'], cwd=ROOT,
                                       stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 15
                while True:
                    if gateway.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    try:
                        with socket.create_connection(('127.0.0.1', 8798), timeout=0.25):
                            break
                    except OSError:
                        if time.monotonic() >= deadline:
                            raise RuntimeError('Gateway fixture startup timed out')
                        time.sleep(0.05)
                with sync_playwright() as playwright:
                    executable = os.environ.get('CHROMIUM') or shutil.which('google-chrome') or shutil.which('chromium')
                    browser = playwright.chromium.launch(headless=True, executable_path=executable)
                    try:
                        page = browser.new_page(viewport={'width': 1440, 'height': 1100})
                        errors = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.goto('http://127.0.0.1:8799/RDP/')
                        page.locator('#connection-name').fill('Recovery fixture')
                        page.locator('#gateway-url').fill('http://127.0.0.1:8798')
                        page.locator('#bridge-token').fill(TOKEN)
                        page.locator('#load-targets').click()
                        expect(page.locator('#form-message')).to_contain_text('1 allowlisted target', timeout=15000)
                        page.locator('#backend').select_option('canvas')
                        page.locator('#username').fill('User')
                        page.locator('#domain').fill('LAB')
                        page.locator('#password').fill('Password')
                        page.locator('#connect-button').click()
                        expect(page.locator('.session-foot')).to_contain_text('active', timeout=15000)
                        # A changed endpoint must not be silently reverted by retry.
                        page.locator('#overview-tab').click()
                        page.locator('#gateway-url').fill('http://127.0.0.1:8797')
                        page.get_by_role('button', name='Recovery fixture', exact=True).click()
                        expect(page.get_by_label('Gateway connection health')).to_have_text('Gateway: unresponsive', timeout=15000)
                        expect(page.get_by_role('heading', name='GATEWAY_HEARTBEAT_TIMEOUT')).to_be_visible(timeout=15000)
                        expect(page.get_by_role('combobox', name='Remote desktop resolution')).to_be_disabled()
                        expect(page.get_by_role('button', name='Return to connection setup with fresh credentials', exact=True)).to_be_visible()
                        page.get_by_role('button', name='Return to connection setup with fresh credentials', exact=True).click()
                        expect(page.locator('.session-tab')).to_have_count(0)
                        expect(page.locator('#gateway-url')).to_have_value('http://127.0.0.1:8797')
                        expect(page.locator('#bridge-token')).to_have_value('')
                        expect(page.locator('#password')).to_have_value('')
                        expect(page.locator('#username')).to_have_value('User')
                        expect(page.locator('#form-message')).to_contain_text('fresh credentials')
                        # Explicitly select the gateway again and require fresh discovery.
                        page.locator('#gateway-url').fill('http://127.0.0.1:8798')
                        page.locator('#bridge-token').fill(TOKEN)
                        page.locator('#load-targets').click()
                        expect(page.locator('#form-message')).to_contain_text('1 allowlisted target', timeout=15000)
                        page.locator('#password').fill('Password')
                        page.locator('#connect-button').click()
                        expect(page.locator('.session-foot')).to_contain_text('active', timeout=15000)
                        expect(page.get_by_label('Gateway connection health')).to_have_text('Gateway: responsive', timeout=10000)
                        expect(page.get_by_role('button', name='Return to connection setup with fresh credentials', exact=True)).to_be_hidden()
                        expect(page.locator('#password')).to_have_value('')
                        page.get_by_role('button', name='Disconnect and close session', exact=True).click()
                        assert not errors, errors
                        print(json.dumps({'droppedGatewayPongs': True, 'boundedDisconnect': True,
                            'disabledRemoteResizeAfterFailure': True, 'explicitReconnection': True,
                            'endpointNotRestoredSilently': True, 'freshCredentialsAndDiscovery': True,
                            'secondTlsNlaSessionActive': True, 'pageErrors': errors,
                            'scope': 'HTTP loopback Chromium, co-developed RDP peer, Canvas; not Windows interoperability, hardware or RDP automatic session resumption'}, indent=2))
                    finally:
                        browser.close()
            finally:
                gateway.terminate()
                try:
                    gateway.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    gateway.kill()
                    gateway.wait()
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    main()

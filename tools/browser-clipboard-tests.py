"""Chromium OS clipboard + GUI + worker + WebSocket/TLS/NLA CLIPRDR wire test."""
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
    with tempfile.TemporaryDirectory(prefix='rdp-clipboard-') as temporary:
        temp = Path(temporary)
        shutil.copytree(ROOT / 'dist/pages', temp / 'RDP')
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(temp))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 8799), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with (temp / 'gateway.log').open('w+') as log:
            env = {**os.environ, 'RDP_RICH_CLIPBOARD_FIXTURE': '1'}
            gateway = subprocess.Popen(['node', 'tests/fixtures/GatewayBrowser.js'], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 10
                while True:
                    if gateway.poll() is not None:
                        log.seek(0); raise RuntimeError(log.read())
                    try:
                        with socket.create_connection(('127.0.0.1', 8798), timeout=0.25): break
                    except OSError:
                        if time.monotonic() >= deadline: raise RuntimeError('Gateway fixture startup timed out')
                        time.sleep(0.05)
                with sync_playwright() as playwright:
                    executable = os.environ.get('CHROMIUM') or shutil.which('google-chrome') or shutil.which('chromium')
                    browser = playwright.chromium.launch(headless=True, executable_path=executable)
                    try:
                        context = browser.new_context(permissions=['clipboard-read', 'clipboard-write'], viewport={'width': 1440, 'height': 1100})
                        page = context.new_page(); errors = []; external = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.on('request', lambda req: external.append(req.url) if 'clipboard.invalid' in req.url else None)
                        page.goto('http://127.0.0.1:8799/RDP/')
                        page.locator('#gateway-url').fill('http://127.0.0.1:8798')
                        page.locator('#bridge-token').fill('browser-fixture-token-0123456789abcdef')
                        page.locator('#load-targets').click()
                        expect(page.locator('#target-id')).to_have_value('fixture', timeout=15000)
                        page.locator('#backend').select_option('canvas')
                        page.locator('#username').fill('User'); page.locator('#domain').fill('LAB'); page.locator('#password').fill('Password')
                        page.locator('details').filter(has=page.locator('#rich-clipboard')).locator('summary').click()
                        expect(page.locator('#rich-clipboard')).not_to_be_checked()
                        page.locator('#rich-clipboard').check()
                        page.locator('#connect-button').click()
                        expect(page.locator('.session-foot')).to_contain_text('active', timeout=15000)
                        page.get_by_role('button', name='Text clipboard', exact=True).click()
                        status = page.get_by_label('Rich clipboard status')
                        expect(status).to_contain_text('Remote offers: text, html, image')
                        await_remote = page.get_by_role('button', name='Copy received formats to this device', exact=True)
                        # A remote fetch must not overwrite the OS clipboard or execute HTML.
                        page.evaluate("navigator.clipboard.writeText('unchanged until explicit copy')")
                        page.get_by_role('button', name='Fetch remote HTML', exact=True).click()
                        page.get_by_role('button', name='Fetch remote image', exact=True).click()
                        expect(status).to_contain_text('Received: text, HTML, image')
                        assert page.evaluate('navigator.clipboard.readText()') == 'unchanged until explicit copy'
                        assert page.evaluate('globalThis.clipboardExecuted') is None
                        assert not external, external
                        await_remote.click()
                        expect(page.locator('#toast')).to_contain_text('Received formats copied')
                        remote = page.evaluate("""async () => {
                            const item = (await navigator.clipboard.read())[0];
                            const text = await (await item.getType('text/plain')).text();
                            const html = await (await item.getType('text/html')).text();
                            const bitmap = await createImageBitmap(await item.getType('image/png'));
                            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
                            ctx.drawImage(bitmap, 0, 0); bitmap.close();
                            return { text, html, pixels: [...ctx.getImageData(0,0,2,1).data] };
                        }""")
                        assert remote['text'] == 'Remote rich clipboard fixture', remote
                        assert 'Remote Zażółć 🙂' in remote['html'], remote
                        assert remote['pixels'] == [255,0,0,255,0,255,0,255], remote
                        # OS -> adapter -> worker -> CLIPRDR -> peer echoes all representations.
                        page.evaluate("""async () => {
                            const { writeBrowserClipboard } = await import('/RDP/apps/client/BrowserClipboard.js');
                            return writeBrowserClipboard({ text: 'Local Zażółć 🙂', html: '<em>Local Zażółć 🙂</em>',
                                image: { width: 2, height: 1, rgba: Uint8Array.of(0,0,255,255,255,255,0,255) } });
                        }""")
                        page.get_by_role('button', name='Read and send rich clipboard', exact=True).click()
                        expect(page.get_by_label('Received remote clipboard text')).to_have_value('Local Zażółć 🙂', timeout=15000)
                        page.get_by_role('button', name='Fetch remote HTML', exact=True).click()
                        page.get_by_role('button', name='Fetch remote image', exact=True).click()
                        expect(status).to_contain_text('Received: text, HTML, image')
                        await_remote.click(); expect(page.locator('#toast')).to_contain_text('Received formats copied')
                        echo = page.evaluate("""async () => {
                            const { readBrowserClipboard } = await import('/RDP/apps/client/BrowserClipboard.js');
                            const data = await readBrowserClipboard();
                            return { text: data.text, html: data.html, pixels: [...data.image.rgba] };
                        }""")
                        assert echo['text'] == 'Local Zażółć 🙂' and 'Local Zażółć 🙂' in echo['html'], echo
                        assert echo['pixels'] == [0,0,255,255,255,255,0,255], echo
                        # Delay an OS read, close the tab, then resolve it. No worker send may follow.
                        page.evaluate("""() => {
                            globalThis.lateClipboardWrites = 0;
                            const original = Worker.prototype.postMessage;
                            Worker.prototype.postMessage = function(m, ...rest) {
                                if (m.type === 'clipboard-content') globalThis.lateClipboardWrites++;
                                return original.call(this,m,...rest);
                            };
                            Object.defineProperty(navigator.clipboard, 'read', { configurable: true,
                                value: () => new Promise(resolve => globalThis.resolveClipboard = resolve) });
                        }""")
                        page.get_by_role('button', name='Read and send rich clipboard', exact=True).click()
                        page.get_by_role('button', name='Disconnect and close session', exact=True).click()
                        page.evaluate("resolveClipboard([new ClipboardItem({'text/plain': new Blob(['late'], {type:'text/plain'})})])")
                        page.wait_for_timeout(100)
                        assert page.evaluate('lateClipboardWrites') == 0
                        assert not errors, errors
                        print(json.dumps({'clipboard': ['Unicode text', 'HTML', 'PNG', 'DIBV5', 'DIB'],
                            'bidirectionalWebsocketTlsNla': True, 'workerTransfers': True,
                            'explicitWritesOnly': True, 'htmlNotExecuted': True, 'cancelAfterClose': True,
                            'remotePixelsExact': True, 'localRoundtripPixelsExact': True, 'pageErrors': errors,
                            'scope': 'Chromium controlled clipboard permission; loopback co-developed RDP peer; not Windows or public HTTPS-to-loopback qualification'}, indent=2))
                    finally: browser.close()
            finally:
                gateway.terminate()
                try: gateway.wait(timeout=5)
                except subprocess.TimeoutExpired: gateway.kill(); gateway.wait()
                server.shutdown(); server.server_close()

if __name__ == '__main__': main()

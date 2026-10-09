"""Actual GUI/worker/Canvas order test. Requires ordinary Chromium navigation.

Uses the co-developed TLS/NLA RDP fixture. Never disables browser policy or
certificate validation. A blocked browser is a failed test, not a skipped pass.
"""
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

def expected_pixels() -> list[int]:
    out = [0x112233] * (32 * 20)
    def put(x: int, y: int, value: int) -> None:
        out[y * 32 + x] = value
    for y in range(4):
        for x in range(4):
            put(x + 2, y + 2, (x * 50 + 5) << 16 | (y * 50 + 10) << 8 | (x + y + 30))
    before = out.copy()
    for y in range(4):
        for x in range(4):
            put(x + 3, y + 3, before[(y + 2) * 32 + x + 2] ^ before[(y + 3) * 32 + x + 3])
    rows = [0xaa, 0x55, 0x81, 0x42, 0x24, 0x18, 0xff, 0]
    for y in range(2, 10):
        for x in range(10, 18):
            put(x, y, 0x123456 if rows[y % 8] & (128 >> (x % 8)) else 0xfedcba)
    for y in range(2, 6):
        for x in range(22, 26):
            put(x, y, 0xfedcba)
    for y in range(2):
        for x in range(3):
            c = (220 - x * 10) << 16 | (80 + y * 20) << 8 | 90
            put(x + 1, y + 12, c)
            put(x + 8, y + 12, c)
    def apply(base, rectangles, transform):
        before = out.copy()
        for y in range(20):
            for x in range(32):
                def inside(r):
                    return r[0] <= x < r[0]+r[2] and r[1] <= y < r[1]+r[3]
                if inside(base) and any(inside(r) for r in rectangles):
                    put(x, y, transform(x, y, before))
    apply((0,14,14,6), [(1,15,5,3),(5,16,4,2)], lambda x,y,b: 0x224466)
    apply((10,10,12,8), [(12,11,5,4),(16,13,5,3)],
          lambda x,y,b: b[y*32+x] ^ (0x010203 if ((x+2)&7)==((y-1)&7) else 0xa0b0c0))
    apply((20,10,12,10), [(22,12,4,3),(25,14,4,3)], lambda x,y,b: b[y*32+x]^0xffffff)
    apply((3,2,20,9), [(9,4,8,3),(4,3,6,4)], lambda x,y,b: b[y*32+x-1])
    put(31, 19, 0xf012ab)
    return out

def main() -> None:
    subprocess.run(['npm', 'run', 'build:pages'], cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix='rdp-gdi-browser-') as temporary:
        temp = Path(temporary)
        shutil.copytree(ROOT / 'dist/pages', temp / 'RDP')
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(temp))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 8799), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with (temp / 'gateway.log').open('w+') as log:
            gateway = subprocess.Popen(['node', 'tests/fixtures/GatewayBrowser.js'], cwd=ROOT,
                env={**os.environ, 'RDP_GDI_FIXTURE': '1'}, stdout=log, stderr=subprocess.STDOUT)
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
                        if time.monotonic() >= deadline:
                            raise RuntimeError('Gateway fixture startup timed out')
                        time.sleep(0.05)
                with sync_playwright() as playwright:
                    executable = os.environ.get('CHROMIUM') or shutil.which('google-chrome') or shutil.which('chromium')
                    browser = playwright.chromium.launch(headless=True, executable_path=executable)
                    try:
                        page = browser.new_page(viewport={'width': 1440, 'height': 1100})
                        errors: list[str] = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.goto('http://127.0.0.1:8799/RDP/')
                        expect(page.locator('#orders')).not_to_be_checked()
                        page.locator('#gateway-url').fill('http://127.0.0.1:8798')
                        page.locator('#bridge-token').fill('browser-fixture-token-0123456789abcdef')
                        page.locator('#load-targets').click()
                        expect(page.locator('#form-message')).to_contain_text('1 allowlisted target', timeout=15000)
                        page.locator('#backend').select_option('canvas')
                        page.locator('#username').fill('User')
                        page.locator('#domain').fill('LAB')
                        page.locator('#password').fill('Password')
                        page.locator('summary').filter(has_text='Display & integration').click()
                        page.locator('#orders').check()
                        page.locator('#width').fill('200')
                        page.locator('#height').fill('200')
                        page.locator('#connect-button').click()
                        expect(page.locator('.session-foot')).to_contain_text('active', timeout=15000)
                        page.wait_for_function("""() => {
                            const c = document.querySelector('canvas.desktop-canvas');
                            if (!c || c.width !== 200) return false;
                            const p = c.getContext('2d').getImageData(31,19,1,1).data;
                            return p[0] === 240 && p[1] === 18 && p[2] === 171;
                        }""")
                        pixels = page.evaluate("""() => {
                            const data = document.querySelector('canvas.desktop-canvas').getContext('2d').getImageData(0,0,32,20).data;
                            return Array.from({length:640}, (_,i) => data[i*4]*65536 + data[i*4+1]*256 + data[i*4+2]);
                        }""")
                        assert pixels == expected_pixels(), 'GDI/Canvas pixels differ from the independent scene oracle'
                        expect(page.locator('#password')).to_have_value('')
                        page.get_by_role('button', name='Disconnect and close session', exact=True).click()
                        assert not errors, errors
                        print(json.dumps({'pixelsCompared': 640, 'pixelDifferences': 0,
                            'orders': ['OpaqueRect', 'ScrBlt', 'PatBlt', 'MemBlt', 'MultiDstBlt', 'MultiPatBlt', 'MultiScrBlt', 'MultiOpaqueRect'], 'revision2Cache': True,
                            'offscreen': True, 'mixedFastSlowBitmapUpdates': True, 'websocketTlsNla': True,
                            'scope': 'Canvas in Chromium and co-developed peer; not independent Windows or physical GPU qualification'}, indent=2))
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

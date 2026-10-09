"""Real Canvas comparison of decoded large pointers; no browser security overrides."""
from __future__ import annotations
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CHECK = r"""async () => {
    const { parseLargePointerShape } = await import('/RDP/packages/protocol/Pointer.js');
    const { CanvasRenderer } = await import('/RDP/packages/render/CanvasRenderer.js');
    const { Writer } = await import('/RDP/packages/binary/Writer.js');
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const renderer = await CanvasRenderer.create(canvas);
    renderer.resize(512, 512);
    const data = new Uint8Array(512 * 512 * 4);
    for (let p = 0; p < data.length; p += 4) data.set([96, 64, 32, 255], p);
    renderer.apply([{ x: 0, y: 0, width: 512, height: 512,
        drawWidth: 512, drawHeight: 512, bpp: 32, stride: 2048, bottomUp: false, data }]);
    let compared = 0;
    for (const bpp of [24, 32]) {
        const n = 384, xor = new Uint8Array(n * n * bpp / 8), and = new Uint8Array(n * n / 8);
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
            const row = n - 1 - y, p = (row * n + x) * bpp / 8;
            if (bpp === 32) xor.set([x & 255, y & 255, (x + y) & 255, 128], p);
            else xor.set([255, 255, 255], p);
            if (x % 2) and[row * 48 + (x >>> 3)] |= 128 >>> (x & 7);
        }
        const wire = new Writer().u16le(bpp).u16le(0).u16le(173).u16le(211)
            .u16le(n).u16le(n).u32le(and.length).u32le(xor.length).put(xor).put(and).finish();
        const shape = parseLargePointerShape(wire);
        renderer.setPointer({ type: 'shape', shape });
        for (const [px, py] of [[0, 0], [256, 256], [511, 511]]) {
            renderer.setPointer({ type: 'position', x: px, y: py }); renderer.present();
            const actual = renderer.context.getImageData(0, 0, 512, 512).data;
            for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
                const sx = x - px + 173, sy = y - py + 211;
                const inside = sx >= 0 && sx < n && sy >= 0 && sy < n;
                const expected = [32, 64, 96, 255];
                if (inside && bpp === 24)
                    for (let c = 0; c < 3; c++) expected[c] = (expected[c] & (sx % 2 ? 255 : 0)) ^ 255;
                if (inside && bpp === 32) {
                    const rgb = [(sx + sy) & 255, sy & 255, sx & 255];
                    for (let c = 0; c < 3; c++) expected[c] = Math.round((expected[c] * 127 + rgb[c] * 128) / 255);
                }
                const p = (y * 512 + x) * 4;
                for (let c = 0; c < 4; c++)
                    if (actual[p + c] !== expected[c]) throw new Error(`Cursor mismatch ${bpp}bpp (${x},${y}) channel ${c}: ${actual[p+c]} != ${expected[c]}`);
                compared++;
            }
        }
    }
    renderer.setPointer({ type: 'hidden' }); renderer.present();
    const hidden = renderer.context.getImageData(0, 0, 512, 512).data;
    for (let i = 0; i < hidden.length; i += 4)
        if (hidden[i] !== 32 || hidden[i+1] !== 64 || hidden[i+2] !== 96 || hidden[i+3] !== 255)
            throw new Error('Cursor changed the retained desktop or left stale pixels');
    renderer.destroy(); canvas.remove();
    return { backend: 'Canvas 2D', maximumPointer: '384x384', comparedPixels: compared,
        differences: 0, alphaAndXor: true, clippedHotspots: true, restoredDesktop: true };
}"""

def main() -> None:
    with tempfile.TemporaryDirectory(prefix='rdp-pointer-') as temporary:
        temp = Path(temporary)
        shutil.copytree(ROOT / 'dist/pages', temp / 'RDP')
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(temp))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            with sync_playwright() as playwright:
                executable = os.environ.get('CHROMIUM') or shutil.which('google-chrome') or shutil.which('chromium')
                browser = playwright.chromium.launch(headless=True, executable_path=executable)
                try:
                    page = browser.new_page()
                    page.goto(f'http://127.0.0.1:{server.server_port}/RDP/')
                    print(json.dumps(page.evaluate(CHECK), indent=2))
                finally:
                    browser.close()
        finally:
            server.shutdown()
            server.server_close()

if __name__ == '__main__':
    main()

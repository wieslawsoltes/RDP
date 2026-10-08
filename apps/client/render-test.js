import { createRenderer } from '../../packages/render/RendererFactory.js';
import { toRgba, rgbaToBgr24, defaultPalette } from '../../packages/codecs/Pixels.js';
import { compositeCursorPixel } from '../../packages/render/Cursor.js';
window.validateRenderer = async (backend) => {
    const host = document.querySelector('#host');
    host.replaceChildren();
    let lost = null;
    const renderer = await createRenderer(host, { preferred: backend, onLost: message => { lost = message; } });
    renderer.resize(256, 160);
    const palette = defaultPalette();
    for (let i = 0; i < 256; i++)
        palette.set([i, 255 - i, (i * 37) & 255, 255], i * 4);
    renderer.setPalette(palette);
    const rectangles = [], background = new Uint8Array(256 * 160 * 4);
    for (let y = 0; y < 160; y++)
        for (let x = 0; x < 256; x++)
            background.set([x, y, x ^ y, 255], (y * 256 + x) * 4);
    rectangles.push({ x: 0, y: 0, width: 256, height: 160, drawWidth: 256, drawHeight: 160, stride: 768, bpp: 24, bottomUp: true, data: rgbaToBgr24(background, 256, 160) });
    for (const [i, bpp] of [8, 15, 16, 24, 32].entries())
        for (const bottomUp of [true, false]) {
            const width = 13, height = 11, stride = (width * ((bpp + 7) >> 3) + 3) & ~3, data = new Uint8Array(stride * height);
            for (let j = 0; j < data.length; j++)
                data[j] = (j * 43 + i * 57) & 255;
            rectangles.push({ x: 7 + i * 27, y: bottomUp ? 9 : 28, width, height, drawWidth: width - 1, drawHeight: height - 2, bpp, bottomUp, stride, data });
        }
    rectangles.push({ ...rectangles[1], x: 8, y: 10, data: rectangles[1].data.map(v => 255 - v) });
    const expected = new Uint8Array(256 * 160 * 4);
    for (const r of rectangles) {
        const rgba = toRgba(r, palette);
        for (let y = 0; y < r.drawHeight; y++)
            expected.set(rgba.subarray(y * r.width * 4, (y * r.width + r.drawWidth) * 4), ((r.y + y) * 256 + r.x) * 4);
    }
    renderer.apply(rectangles);
    const actual = await renderer.readSurface();
    let mismatches = 0, firstMismatch = null;
    for (let i = 0; i < actual.length; i++)
        if (actual[i] !== expected[i]) {
            mismatches++;
            firstMismatch ||= { index: i, actual: actual[i], expected: expected[i] };
        }
    const cursor = { width: 4, height: 4, hotX: 1, hotY: 1, pixels: Uint8Array.from({ length: 64 }, (_, i) => i % 4 === 3 ? (i & 4 ? 255 : 0) : (i & 8 ? 255 : 0)), mode: 1 };
    renderer.setPointer({ kind: 'shape', shape: cursor });
    renderer.setPointer({ kind: 'position', x: 13, y: 13 });
    renderer.present();
    const expectedWithCursor = expected.slice();
    for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
            compositeCursorPixel(expectedWithCursor, ((12 + y) * 256 + 12 + x) * 4, cursor.pixels, (y * 4 + x) * 4, 1);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const visible = document.createElement('canvas');
    visible.width = 256;
    visible.height = 160;
    const ctx = visible.getContext('2d');
    ctx.drawImage(renderer.canvas, 0, 0);
    const shown = ctx.getImageData(0, 0, 256, 160).data;
    let cursorMismatches = 0;
    for (let i = 0; i < shown.length; i++)
        if (shown[i] !== expectedWithCursor[i])
            cursorMismatches++;
    window.activeRenderer = renderer;
    return { backend: renderer.stats.backend, mismatches, firstMismatch, cursorMismatches, lost, stats: renderer.stats, pixelCount: 40960 };
};

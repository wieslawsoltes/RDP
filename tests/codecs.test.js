import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeInterleaved } from '../packages/codecs/InterleavedRle.js';
import { toRgba, defaultPalette, rgbaToBgr24 } from '../packages/codecs/Pixels.js';
import { planBatches } from '../packages/render/BatchPlanner.js';
import { compositeCursorPixel } from '../packages/render/Cursor.js';
import { Writer } from '../packages/binary/Writer.js';
const decode = (data, width = 8, height = 1) => [...decodeInterleaved(Uint8Array.from(data), width, height, 8)];
const cases = [
    ['regular background', [0x08], 8, [0, 0, 0, 0, 0, 0, 0, 0]],
    ['regular foreground', [0x28], 8, [255, 255, 255, 255, 255, 255, 255, 255]],
    ['regular color run', [0x68, 42], 8, [42, 42, 42, 42, 42, 42, 42, 42]],
    ['regular image', [0x88, 1, 2, 3, 4, 5, 6, 7, 8], 8, [1, 2, 3, 4, 5, 6, 7, 8]],
    ['foreground/background mask LSB first', [0x41, 0x55], 8, [255, 0, 255, 0, 255, 0, 255, 0]],
    ['lite set foreground', [0xc8, 7], 8, [7, 7, 7, 7, 7, 7, 7, 7]],
    ['lite set foreground/background', [0xd1, 7, 0x33], 8, [7, 7, 0, 0, 7, 7, 0, 0]],
    ['lite dither', [0xe4, 1, 2], 8, [1, 2, 1, 2, 1, 2, 1, 2]],
    ['mega background', [0xf0, 8, 0], 8, [0, 0, 0, 0, 0, 0, 0, 0]],
    ['mega foreground', [0xf1, 8, 0], 8, [255, 255, 255, 255, 255, 255, 255, 255]],
    ['mega mask', [0xf2, 8, 0, 0x80], 8, [0, 0, 0, 0, 0, 0, 0, 255]],
    ['mega color', [0xf3, 8, 0, 3], 8, [3, 3, 3, 3, 3, 3, 3, 3]],
    ['mega image', [0xf4, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8], 8, [1, 2, 3, 4, 5, 6, 7, 8]],
    ['mega set foreground', [0xf6, 8, 0, 9], 8, [9, 9, 9, 9, 9, 9, 9, 9]],
    ['mega set mask', [0xf7, 8, 0, 6, 0x0f], 8, [6, 6, 6, 6, 0, 0, 0, 0]],
    ['mega dither', [0xf8, 4, 0, 8, 9], 8, [8, 9, 8, 9, 8, 9, 8, 9]],
    ['special mask 03', [0xf9], 8, [255, 255, 0, 0, 0, 0, 0, 0]],
    ['special mask 05', [0xfa], 8, [255, 0, 255, 0, 0, 0, 0, 0]],
    ['special black/white', [0xfd, 0xfe], 2, [255, 0]],
    ['consecutive background insertion', [0x02, 0x02], 4, [0, 0, 255, 0]],
];
for (const [name, bytes, width, expected] of cases)
    test(`RLE ${name}`, () => assert.deepEqual(decode(bytes, width), expected));
test('RLE background uses previous row and resets insertion at first scanline boundary', () => { assert.deepEqual(decode([0x88, 1, 2, 3, 4, 5, 6, 7, 8, 0x08], 8, 2), [1, 2, 3, 4, 5, 6, 7, 8, 1, 2, 3, 4, 5, 6, 7, 8]); assert.deepEqual(decode([0x08, 0x08], 8, 2), Array(16).fill(0)); });
for (const bpp of [8, 15, 16, 24])
    test(`RLE literal image at ${bpp} bpp is byte exact`, () => {
        const data = Uint8Array.from({ length: 64 * ((bpp + 7) >> 3) }, (_, i) => (i * 37) & 255), bytes = new Writer().u8(0xf4).u16le(64).put(data).finish();
        assert.deepEqual(decodeInterleaved(bytes, 8, 8, bpp), data);
    });
test('RLE rejects zero runs, overflow, truncated literals and trailing bytes', () => {
    for (const bytes of [[0xf0, 0, 0], [0xf0, 9, 0], [0x88, 1, 2], [0x08, 0xfd], [0xfc]])
        assert.throws(() => decode(bytes));
});
test('Packed BGR24 roundtrips odd-width aligned rows', () => {
    const rgba = Uint8Array.from({ length: 5 * 7 * 4 }, (_, i) => i % 4 === 3 ? 255 : i & 255), data = rgbaToBgr24(rgba, 5, 7);
    assert.deepEqual(new Uint8Array(toRgba({ width: 5, height: 7, bpp: 24, stride: 16, bottomUp: true, data })), rgba);
});
test('RGB565 and RGB555 expansion handles primary colors and white exactly', () => {
    for (const [bpp, colors] of [[16, [0xf800, 0x07e0, 0x001f, 0xffff]], [15, [0x7c00, 0x03e0, 0x001f, 0x7fff]]]) {
        const data = new Writer();
        for (const color of colors)
            data.u16le(color);
        assert.deepEqual([...toRgba({ width: 4, height: 1, stride: 8, bpp, data: data.finish() })], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    }
});
test('Classic cursor supports transparent, black, white and destination inversion', () => {
    for (const [pixel, expected] of [[[0, 0, 0, 255], [12, 34, 56, 255]], [[0, 0, 0, 0], [0, 0, 0, 255]], [[255, 255, 255, 0], [255, 255, 255, 255]], [[255, 255, 255, 255], [243, 221, 199, 255]]]) {
        const base = Uint8Array.of(12, 34, 56, 255);
        compositeCursorPixel(base, 0, pixel, 0, 1);
        assert.deepEqual([...base], expected);
    }
});
test('Batch planner isolates overlaps while parallelizing disjoint rectangles', () => {
    const rect = (x, y) => ({ x, y, width: 4, height: 4, drawWidth: 4, drawHeight: 4, stride: 12, bpp: 24, data: new Uint8Array(48) });
    const result = planBatches([rect(0, 0), rect(10, 0), rect(2, 1), rect(20, 1)], 40, 40);
    assert.equal(result.batches.length, 2);
    assert.throws(() => planBatches([rect(39, 0)], 40, 40));
});

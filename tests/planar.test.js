import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePlanar } from '../packages/codecs/Planar.js';
import { toRgba } from '../packages/codecs/Pixels.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
import { Reader } from '../packages/binary/Reader.js';
import { Writer, concat } from '../packages/binary/Writer.js';
import { parseBitmapUpdate } from '../packages/protocol/BitmapUpdate.js';
import { clientCapabilities } from '../packages/protocol/Capabilities.js';

const bytes = (...values) => Uint8Array.from(values);
const stream = (header, ...planes) => concat(bytes(header), ...planes.map(p => Uint8Array.from(p)));
const decode = (input, width, height, options) => [...decodePlanar(input, width, height, options)];
const channel = (image, c) => [...image].filter((_, i) => i % 4 === c);

// A test-only literal encoder, using the forward transform, independent of
// the decoder's scanline state machine. It deliberately emits no RUNs.
function literalPlane(plane, width, height) {
    const out = [];
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width;) {
            const n = Math.min(15, width - x);
            out.push(n * 16);
            for (let j = 0; j < n; j++, x++) {
                const index = y * width + x;
                if (y === 0) out.push(plane[index]);
                else {
                    let delta = (plane[index] - plane[index - width] + 256) % 256;
                    if (delta >= 128) delta -= 256;
                    out.push(delta >= 0 ? delta * 2 : -delta * 2 - 1);
                }
            }
        }
    }
    return out;
}

function bitmapRecord(payload, width, height, flags = 0x401, drawWidth = width) {
    const compression = flags === 1 ? new Writer().u16le(0).u16le(payload.length)
        .u16le(width * 4).u16le(width * height * 4).finish() : new Uint8Array();
    return new Writer().u16le(0).u16le(0).u16le(drawWidth - 1).u16le(height - 1)
        .u16le(width).u16le(height).u16le(32).u16le(flags)
        .u16le(compression.length + payload.length).put(compression).put(payload).finish();
}

const simple = stream(0x20, [10, 20, 30, 40], [50, 60, 70, 80], [90, 100, 110, 120]);

test('Planar raw RGB emits tightly packed BGRA without delta conversion', () => {
    assert.deepEqual(decode(simple, 2, 2), [90, 50, 10, 255, 100, 60, 20, 255, 110, 70, 30, 255, 120, 80, 40, 255]);
});
test('Planar raw ARGB preserves the explicit alpha plane', () => {
    assert.deepEqual(decode(stream(0, [0, 127], [10, 20], [30, 40], [50, 60]), 2, 1),
        [50, 30, 10, 0, 60, 40, 20, 127]);
});
test('Planar output owns bytes even when input is a scoped subarray', () => {
    const storage = concat(bytes(99), simple, bytes(98));
    const out = decodePlanar(storage.subarray(1, -1), 2, 2);
    const snapshot = out.slice();
    storage.fill(0);
    assert.deepEqual(out, snapshot);
});
test('Planar raw streams accept exactly zero or one arbitrary padding byte', () => {
    for (const pad of [0, 1, 127, 255])
        assert.deepEqual(decode(concat(simple, bytes(pad)), 2, 2), decode(simple, 2, 2));
    assert.throws(() => decode(concat(simple, bytes(0, 0)), 2, 2), ProtocolError);
});
test('Planar RLE matches the published MS-RDPEGDI 6 by 3 plane example', () => {
    const wire = [0x13, 0xff, 0x20, 0xfe, 0xfd, 0x60, 0x01, 0x7d, 0xf5, 0xc2, 0x9a, 0x38, 0x60, 0x01, 0x67, 0x8b, 0xa3, 0x78, 0xaf];
    const expected = [255, 255, 255, 255, 254, 253, 254, 192, 132, 96, 75, 25, 253, 140, 62, 14, 135, 193];
    const out = decodePlanar(stream(0x30, wire, wire, wire), 6, 3);
    for (const c of [0, 1, 2]) assert.deepEqual(channel(out, c), expected);
});
test('Planar RLE decodes all 256 encoded deltas with modulo-256 arithmetic', () => {
    const expected = Array(256).fill(127);
    const first = literalPlane(expected, 256, 1), second = [];
    for (let start = 0; start < 256; start += 15) {
        const n = Math.min(15, 256 - start);
        second.push(n * 16);
        for (let i = start; i < start + n; i++) {
            second.push(i);
            const delta = i % 2 ? -(i + 1) / 2 : i / 2;
            expected.push((127 + delta + 256) % 256);
        }
    }
    const plane = [...first, ...second];
    assert.deepEqual(channel(decodePlanar(stream(0x30, plane, plane, plane), 256, 2), 2), expected);
});
test('Planar run-only subsegments retain the last raw value and reset at each row', () => {
    const plane = [0x13, 0x42, 0xf2, 0xf1, 0xf2, 0xf1, 0x04]; // 4+47+31; 47+31+4
    assert.deepEqual(channel(decodePlanar(stream(0x30, plane, plane, plane), 82, 2), 2), Array(164).fill(0x42));
});
test('Planar tests every extended RUN encoding boundary', () => {
    for (let raw = 0; raw < 16; raw++) {
        for (const marker of [1, 2]) {
            const n = (marker === 1 ? 16 : 32) + raw;
            const plane = [0x10, 23, raw * 16 + marker];
            assert.deepEqual(channel(decodePlanar(stream(0x30, plane, plane, plane), n + 1, 1), 1), Array(n + 1).fill(23));
        }
    }
});
test('Planar RUN deltas apply to each corresponding pixel in the preceding row', () => {
    const plane = [0x40, 10, 20, 30, 40, 0x13, 9, 0x04];
    assert.deepEqual(channel(decodePlanar(stream(0x30, plane, plane, plane), 4, 3), 0),
        [10, 20, 30, 40, 5, 15, 25, 35, 5, 15, 25, 35]);
});
test('Planar RLE alpha has independent scanline history', () => {
    const a = [0x13, 0x80, 0x13, 1], r = [0x13, 10, 0x04], g = [0x13, 20, 0x04], b = [0x13, 30, 0x04];
    const out = decodePlanar(stream(0x10, a, r, g, b), 4, 2);
    assert.deepEqual(channel(out, 3), [128, 128, 128, 128, 127, 127, 127, 127]);
    assert.deepEqual(channel(out, 0), Array(8).fill(30));
});
test('Planar raw and literal-RLE forms agree on deterministic varied dimensions', () => {
    for (let height = 1; height <= 9; height++) for (const width of [1, 2, 3, 15, 16, 17, 31]) {
        const planes = [0, 1, 2, 3].map(c => Array.from({ length: width * height }, (_, i) => (i * 61 + c * 47) % 256));
        assert.deepEqual(decodePlanar(stream(0, ...planes), width, height),
            decodePlanar(stream(0x10, ...planes.map(p => literalPlane(p, width, height))), width, height));
    }
});
test('Planar chroma recovery sign-extends the reconstructed 9-bit value at all loss levels', () => {
    const clip = v => Math.min(255, Math.max(0, v));
    for (let loss = 1; loss <= 7; loss++) for (let co = 0; co < 256; co++) {
        const cg = (co * 29 + 31) % 256;
        const signed9 = v => { const recovered = (v * 2 ** loss) % 512; return recovered >= 256 ? recovered - 512 : recovered; };
        const co2 = signed9(co) / 2, cg2 = signed9(cg) / 2;
        assert.deepEqual(decode(stream(0x20 | loss, [100], [co], [cg]), 1, 1),
            [clip(100 - co2 - cg2), clip(100 + cg2), clip(100 + co2 - cg2), 255]);
    }
});
test('Planar odd 3 by 3 subsampling uses ceil-sized chroma planes', () => {
    const out = decodePlanar(stream(0x29, Array(9).fill(100), [2, 4, 6, 8], [0, 0, 0, 0]), 3, 3);
    assert.deepEqual(channel(out, 2), [102, 102, 104, 102, 102, 104, 106, 106, 108]);
    assert.deepEqual(channel(out, 0), [98, 98, 96, 98, 98, 96, 94, 94, 92]);
});
test('Planar RLE subsampled planes keep their own row widths and histories', () => {
    const y = [10, 20, 30, 40, 50, 60, 70, 80, 90], co = [2, 4, 6, 8], cg = [0, 1, 2, 3];
    assert.deepEqual(decodePlanar(stream(0x39, literalPlane(y, 3, 3), literalPlane(co, 2, 2), literalPlane(cg, 2, 2)), 3, 3),
        decodePlanar(stream(0x29, y, co, cg), 3, 3));
});
test('Planar Microsoft 24-bit YCoCg correction is explicit and does not alter RGB streams', () => {
    const input = stream(0x21, [100], [10], [5]);
    assert.deepEqual(decode(input, 1, 1), [85, 105, 105, 255]);
    assert.deepEqual(decode(input, 1, 1, { sourceBpp: 24 }), [105, 105, 85, 255]);
    assert.deepEqual(decode(simple, 2, 2, { sourceBpp: 24 }), decode(simple, 2, 2));
});
test('Planar rejects zero controls, row overflow, trailing RLE bytes and invalid headers', () => {
    for (const input of [bytes(0x30, 0), bytes(0x30, 0x03), bytes(0x30, 0x20, 1, 2), bytes(0x30, 0xf2)])
        assert.throws(() => decode(input, 1, 1), ProtocolError);
    const valid = stream(0x30, [0x10, 1], [0x10, 2], [0x10, 3]);
    assert.throws(() => decode(concat(valid, bytes(0)), 1, 1), ProtocolError);
    for (const header of [0x28, 0x38, 0x40, 0x60, 0x80, 0xa0, 0xff])
        assert.throws(() => decode(bytes(header, 1, 2, 3), 1, 1), ProtocolError);
});
test('Planar rejects every truncated prefix of raw and RLE streams', () => {
    const compressed = stream(0x30, [0x40, 1, 2, 3, 4, 0x04], [0x40, 4, 3, 2, 1, 0x04], [0x40, 0, 10, 20, 30, 0x04]);
    for (const [input, width, height] of [[simple, 2, 2], [compressed, 4, 2]])
        for (let n = 0; n < input.length; n++)
            assert.throws(() => decode(input.subarray(0, n), width, height), ProtocolError);
});
test('Planar validates dimensions, input type and decode budget before allocating', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, 8193, Number.MAX_SAFE_INTEGER]) {
        assert.throws(() => decode(simple, value, 1), ProtocolError);
        assert.throws(() => decode(simple, 1, value), ProtocolError);
    }
    assert.throws(() => decode(simple, 8192, 8192), ProtocolError);
    assert.throws(() => decode([], 1, 1), ProtocolError);
    for (const options of [null, { maxDecodedBytes: -1 }, { maxDecodedBytes: 1 }, { maxDecodedBytes: Infinity }, { sourceBpp: 16 }])
        assert.throws(() => decode(simple, 2, 2, options), ProtocolError);
    assert.equal(decodePlanar(simple, 2, 2, { maxDecodedBytes: 28 }).length, 16);
});
test('Planar bitmap updates decode both compression header forms and preserve orientation', () => {
    for (const flags of [1, 0x401]) {
        const body = new Writer().u16le(1).put(bitmapRecord(simple, 2, 2, flags)).finish();
        const [bitmap] = parseBitmapUpdate(new Reader(body), { width: 200, height: 200 });
        assert.equal(bitmap.bpp, 32);
        assert.equal(bitmap.stride, 8);
        assert.equal(bitmap.bottomUp, true);
        assert.deepEqual([...toRgba(bitmap)], [30, 70, 110, 255, 40, 80, 120, 255, 10, 50, 90, 255, 20, 60, 100, 255]);
    }
});
test('Planar bitmap updates keep multiple records and destination cropping isolated', () => {
    const body = new Writer().u16le(2).put(bitmapRecord(simple, 2, 2, 0x401, 1)).put(bitmapRecord(simple, 2, 2, 1)).finish();
    const [first, second] = parseBitmapUpdate(new Reader(body), { width: 200, height: 200 });
    assert.equal(first.drawWidth, 1);
    assert.equal(second.drawWidth, 2);
    first.data.fill(0);
    assert.deepEqual([...second.data], decode(simple, 2, 2));
});
test('Planar capability advertises alpha omission only for 32-bit and keeps lossy modes disabled', () => {
    for (const bpp of [8, 15, 16, 24, 32]) {
        const cap = clientCapabilities({ width: 800, height: 600, bpp })[1];
        assert.equal(cap[23], bpp === 32 ? 8 : 0);
        assert.equal(cap[23] & 6, 0);
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { chunk, png } from './fixtures/Clipboard.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
import { concat } from '../packages/binary/Writer.js';
import { encodeClipboardHtml, decodeClipboardHtml, encodeClipboardDib, decodeClipboardDib,
    inspectClipboardPng, CLIPBOARD_LIMIT } from '../packages/codecs/ClipboardFormats.js';
const encoder = new TextEncoder(), decoder = new TextDecoder();
const image = { width: 3, height: 2, rgba: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0,
    1, 2, 3, 255, 127, 128, 129, 64, 253, 254, 255, 255) };

test('CF_HTML uses UTF-8 offsets for astral and non-ASCII fragments', () => {
    for (const html of ['', '<b>Zażółć 😀</b>', '<table><tr><td>日本語</td></tr></table>', '<!--StartHTML:1--><script>untrusted()</script>']) {
        const bytes = encodeClipboardHtml(html);
        assert.equal(decodeClipboardHtml(bytes), html);
        const header = decoder.decode(bytes.subarray(0, 105));
        const start = Number(/StartFragment:(\d+)/.exec(header)[1]);
        const end = Number(/EndFragment:(\d+)/.exec(header)[1]);
        assert.equal(end - start, encoder.encode(html).length);
        assert.equal(bytes.at(-1), 0);
    }
});
test('CF_HTML accepts no-context fragments and different header line endings', () => {
    const make = (newline) => {
        const template = `Version:0.9${newline}StartHTML:-1${newline}EndHTML:-1${newline}StartFragment:0000000000${newline}EndFragment:0000000000${newline}`;
        const fragment = '<b>🙂</b>', n = encoder.encode(fragment).length;
        const header = template.replace('StartFragment:0000000000', `StartFragment:${String(template.length).padStart(10, '0')}`)
            .replace('EndFragment:0000000000', `EndFragment:${String(template.length + n).padStart(10, '0')}`);
        return encoder.encode(header + fragment);
    };
    for (const newline of ['\r', '\n', '\r\n']) assert.equal(decodeClipboardHtml(make(newline)), '<b>🙂</b>');
});
test('CF_HTML rejects malformed offsets, duplicate fields, NUL and split UTF-8 characters', () => {
    const bytes = encodeClipboardHtml('<b>🙂</b>'), input = decoder.decode(bytes);
    for (const [old, replacement] of [[/StartHTML:\d+/, 'StartHTML:9999999999'], [/StartFragment:\d+/, 'StartFragment:0000000001'],
        [/EndFragment:\d+/, 'EndFragment:-1'], [/Version:1.0/, 'Version:9.9']])
        assert.throws(() => decodeClipboardHtml(encoder.encode(input.replace(old, replacement))), ProtocolError);
    assert.throws(() => decodeClipboardHtml(encoder.encode(input.replace('Version:1.0\r\n', 'Version:1.0\r\nVersion:1.0\r\n'))), ProtocolError);
    const corrupt = bytes.slice(), offset = Number(/StartFragment:(\d+)/.exec(input)[1]);
    corrupt[offset + 3] = 0xff;
    assert.throws(() => decodeClipboardHtml(corrupt), ProtocolError);
    assert.throws(() => encodeClipboardHtml('\0'), ProtocolError);
    assert.throws(() => encodeClipboardHtml('界'.repeat(CLIPBOARD_LIMIT / 2)), ProtocolError);
});
test('PNG dimensions and all chunks are validated before browser decode', () => {
    const wire = png(); assert.deepEqual(inspectClipboardPng(wire), { width: 1, height: 1 });
    const wrapped = concat(Uint8Array.of(0), wire, Uint8Array.of(0));
    assert.deepEqual(inspectClipboardPng(wrapped.subarray(1, -1)), { width: 1, height: 1 });
    assert.throws(() => inspectClipboardPng(png(8193, 1)), ProtocolError);
    assert.throws(() => inspectClipboardPng(png(8192, 8192)), ProtocolError);
    for (let i = 0; i < wire.length; i++) assert.throws(() => inspectClipboardPng(wire.subarray(0, i)), ProtocolError);
    const corrupt = wire.slice(); corrupt[corrupt.length - 5] ^= 1;
    assert.throws(() => inspectClipboardPng(corrupt), ProtocolError);
    assert.throws(() => inspectClipboardPng(concat(wire, Uint8Array.of(0))), ProtocolError);
});
test('PNG rejects animations, unknown critical chunks and noncontiguous image data', () => {
    const wire = png(), prefix = wire.slice(0, 33), rest = wire.slice(33);
    for (const name of ['acTL', 'fcTL', 'fdAT', 'ABCD'])
        assert.throws(() => inspectClipboardPng(concat(prefix, chunk(name, new Uint8Array()), rest)), ProtocolError);
    assert.throws(() => inspectClipboardPng(concat(wire.subarray(0, -12), chunk('tEXt', new Uint8Array()), chunk('IDAT', new Uint8Array()), wire.subarray(-12))), ProtocolError);
});
test('DIBV5 roundtrips alpha, odd widths and bottom-up rows without sharing storage', () => {
    const wire = encodeClipboardDib(image), decoded = decodeClipboardDib(wire);
    assert.deepEqual(decoded, image);
    wire.fill(0); assert.deepEqual(decoded.rgba, image.rgba);
});
test('CF_DIB fallback flattens alpha onto white, aligns rows and ignores RGB reserved bytes', () => {
    const wire = encodeClipboardDib(image, false), decoded = decodeClipboardDib(wire);
    assert.equal(wire.length, 40 + 12 * 2);
    for (let i = 0; i < image.rgba.length; i += 4) {
        for (let c = 0; c < 3; c++) assert.equal(decoded.rgba[i + c], Math.round((image.rgba[i + c] * image.rgba[i + 3] + 255 * (255 - image.rgba[i + 3])) / 255));
        assert.equal(decoded.rgba[i + 3], 255);
    }
});
test('Top-down and bottom-up DIB payloads yield identical row order', () => {
    const b = encodeClipboardDib(image), v = new DataView(b.buffer), row = b.slice(124, 136);
    b.copyWithin(124, 136, 148); b.set(row, 136); v.setInt32(8, -2, true);
    assert.deepEqual(decodeClipboardDib(b), image);
});
test('1/4/8-bit DIB palette pixels and row padding are decoded', () => {
    for (const bits of [1, 4, 8]) {
        const b = new Uint8Array(40 + 8 + 4), v = new DataView(b.buffer);
        v.setUint32(0, 40, true); v.setInt32(4, 3, true); v.setInt32(8, 1, true);
        v.setUint16(12, 1, true); v.setUint16(14, bits, true); v.setUint32(32, 2, true);
        b.set([0, 0, 255, 0, 0, 255, 0, 0], 40);
        b.set(bits === 1 ? [0x40] : bits === 4 ? [0x01, 0] : [0, 1, 0], 48);
        assert.deepEqual([...decodeClipboardDib(b).rgba], [255, 0, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255]);
        if (bits !== 1) { b[48] = 0xff; assert.throws(() => decodeClipboardDib(b), ProtocolError); }
    }
});
test('16-bit default RGB555 and external RGB565 masks expand full range', () => {
    for (const compression of [0, 3]) {
        const n = compression ? 12 : 0, b = new Uint8Array(40 + n + 8), v = new DataView(b.buffer);
        v.setUint32(0, 40, true); v.setInt32(4, 3, true); v.setInt32(8, 1, true); v.setUint16(12, 1, true);
        v.setUint16(14, 16, true); v.setUint32(16, compression, true);
        if (compression) [0xf800, 0x7e0, 0x1f].forEach((m, i) => v.setUint32(40 + i * 4, m, true));
        [compression ? 0xf800 : 0x7c00, compression ? 0x7e0 : 0x3e0, 31].forEach((m, i) => v.setUint16(40 + n + i * 2, m, true));
        assert.deepEqual([...decodeClipboardDib(b).rgba], [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    }
});
test('DIB rejects truncation, overlapping/noncontiguous masks and external profiles', () => {
    const b = encodeClipboardDib(image);
    for (let i = 0; i < b.length; i++) assert.throws(() => decodeClipboardDib(b.subarray(0, i)), ProtocolError);
    for (const [offset, value] of [[4, 0xffffffff], [8, 0x80000000], [16, 1], [40, 0xf0f000], [44, 0xff0000], [56, 0x4c494e4b], [112, 124]]) {
        const bad = b.slice(); new DataView(bad.buffer).setUint32(offset, value, true);
        assert.throws(() => decodeClipboardDib(bad), ProtocolError);
    }
    assert.throws(() => encodeClipboardDib({ width: 8192, height: 8192, rgba: new Uint8Array() }), ProtocolError);
});
test('Malformed clipboard codecs return controlled failures under bounded smoke fuzzing', () => {
    let state = 0x434c4950;
    const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    const inputs = [encodeClipboardDib(image), encodeClipboardHtml('<b>Test🙂</b>'), png()];
    const parsers = [decodeClipboardDib, decodeClipboardHtml, inspectClipboardPng];
    for (let i = 0; i < 10000; i++) {
        const n = i % 3, input = inputs[n].slice();
        for (let j = 0, count = 1 + next() % 5; j < count; j++) input[next() % input.length] = next() & 255;
        try { parsers[n](input); } catch (e) { assert.ok(e instanceof ProtocolError, `${i}: ${e.stack}`); }
    }
});

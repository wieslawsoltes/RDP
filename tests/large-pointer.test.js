import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLargePointerShape, parsePointerShape, PointerCache } from '../packages/protocol/Pointer.js';
import { Writer, concat } from '../packages/binary/Writer.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
import { clientCapabilities } from '../packages/protocol/Capabilities.js';
import { clientCore } from '../packages/protocol/Gcc.js';
import { sanitizeProfile, importRdp, exportRdp } from '../packages/profiles/Profiles.js';
import { Session } from '../packages/protocol/Session.js';
import { LoopbackServer } from '../packages/lab/LoopbackServer.js';
import { compositeCursorPixel } from '../packages/render/Cursor.js';

function pointer(width, height, bpp = 32, { index = 3, noAnd = false, large = true, hotX = 0, hotY = 0 } = {}) {
    const xorStride = (Math.ceil(width * bpp / 8) + 1) & ~1, andStride = (Math.ceil(width / 8) + 1) & ~1;
    const xor = new Uint8Array(xorStride * height), and = new Uint8Array(noAnd ? 0 : andStride * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const row = height - 1 - y;
        if (bpp >= 24) {
            const o = row * xorStride + x * (bpp / 8);
            xor.set([x & 255, y & 255, (x + y) & 255], o);
            if (bpp === 32) xor[o + 3] = (x * 17 + y) & 255;
        } else if (bpp === 1 && (x + y) % 2) xor[row * xorStride + (x >>> 3)] |= 0x80 >>> (x & 7);
        if (!noAnd && x % 2) and[row * andStride + (x >>> 3)] |= 0x80 >>> (x & 7);
    }
    const w = new Writer().u16le(bpp).u16le(index).u16le(hotX).u16le(hotY).u16le(width).u16le(height);
    if (large) w.u32le(and.length).u32le(xor.length);
    else w.u16le(and.length).u16le(xor.length);
    return w.put(xor).put(and).finish();
}
function packets(payload, code = 12) {
    const chunks = [];
    for (let offset = 0; offset < payload.length; offset += 16000) {
        const data = payload.subarray(offset, offset + 16000);
        const fragment = payload.length <= 16000 ? 0 : offset === 0 ? 2 : offset + data.length === payload.length ? 1 : 3;
        const update = new Writer().u8(code | fragment << 4).u16le(data.length).put(data).finish();
        chunks.push(new Writer().u8(0).u16be((update.length + 3) | 0x8000).put(update).finish());
    }
    return chunks;
}
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

test('Large pointer 384x384 decodes 32-bit mask lengths, bottom-up rows and hotspots exactly', () => {
    const wire = pointer(384, 384, 32, { hotX: 383, hotY: 383 }), shape = parseLargePointerShape(wire);
    assert.equal(wire.length, 608276);
    assert.equal(shape.width, 384); assert.equal(shape.height, 384); assert.equal(shape.hotX, 383); assert.equal(shape.hotY, 383);
    assert.equal(shape.mode, 2);
    for (const [x, y] of [[0, 0], [383, 0], [0, 383], [383, 383], [17, 65]])
        assert.deepEqual([...shape.pixels.slice((y * 384 + x) * 4, (y * 384 + x) * 4 + 4)], [(x + y) & 255, y & 255, x & 255, (x * 17 + y) & 255]);
    wire.fill(0);
    assert.deepEqual([...shape.pixels.slice(4, 8)], [1, 0, 1, 17]);
});
test('Large pointer optional AND and one padding byte preserve alpha bytes', () => {
    for (const noAnd of [false, true]) {
        const wire = pointer(97, 1, 32, { noAnd });
        const plain = parseLargePointerShape(wire);
        const padded = parseLargePointerShape(concat(wire, Uint8Array.of(219)));
        assert.deepEqual(plain.pixels, padded.pixels);
        assert.throws(() => parseLargePointerShape(concat(wire, Uint8Array.of(1, 2))), ProtocolError);
    }
});
test('Large color and monochrome pointers retain AND/XOR inversion and row padding', () => {
    for (const bpp of [1, 24]) {
        const shape = parseLargePointerShape(pointer(99, 3, bpp));
        assert.equal(shape.mode, 1);
        for (const [x, y] of [[0, 0], [1, 0], [98, 2]]) {
            const o = (y * 99 + x) * 4, base = Uint8Array.of(52, 86, 120, 255), mask = x % 2 ? 255 : 0;
            compositeCursorPixel(base, 0, shape.pixels, o, shape.mode);
            const expected = bpp === 1 ? Array(3).fill((x + y) % 2 ? 255 : 0) : [(x + y) & 255, y, x];
            assert.deepEqual([...base], [(52 & mask) ^ expected[0], (86 & mask) ^ expected[1], (120 & mask) ^ expected[2], 255]);
        }
    }
});
test('Large pointer 15/16-bit RGB primaries use correct packed channel widths', () => {
    for (const bpp of [15, 16]) {
        const wire = pointer(97, 1, bpp), view = new DataView(wire.buffer);
        view.setUint16(20, bpp === 16 ? 0xf800 : 0x7c00, true);
        view.setUint16(22, bpp === 16 ? 0x07e0 : 0x03e0, true);
        view.setUint16(24, 0x1f, true);
        const shape = parseLargePointerShape(wire);
        assert.deepEqual([...shape.pixels.slice(0, 12)], [255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 0]);
    }
});
test('Regular and large pointers share all 32 cache slots; replacement and clearing work', () => {
    const events = [], cache = new PointerCache(e => events.push(e));
    cache.shape(pointer(32, 32, 24, { large: false, index: 31 }), true);
    cache.large(pointer(384, 1, 32, { index: 31 }));
    cache.cached(new Writer().u16le(31).finish());
    assert.equal(events[2].shape.width, 384);
    assert.equal(cache.cache.size, 1);
    cache.clear();
    assert.throws(() => cache.cached(new Writer().u16le(31).finish()), ProtocolError);
    assert.throws(() => cache.large(pointer(97, 1, 32, { index: 32 })), ProtocolError);
});
test('Large pointer rejects out-of-range shapes, hotspots, lengths and truncated inputs before allocation', () => {
    for (const [w, h] of [[0, 1], [1, 0], [385, 1], [1, 385]])
        assert.throws(() => parseLargePointerShape(pointer(w, h)), ProtocolError);
    assert.throws(() => parseLargePointerShape(pointer(97, 1, 32, { hotX: 97 })), ProtocolError);
    const wire = pointer(1, 1);
    for (let n = 0; n < wire.length; n++) assert.throws(() => parseLargePointerShape(wire.subarray(0, n)), ProtocolError);
    for (const offset of [12, 16]) {
        const bad = wire.slice(); new DataView(bad.buffer).setUint32(offset, 0xffffffff, true);
        assert.throws(() => parseLargePointerShape(bad), ProtocolError);
    }
    assert.throws(() => parseLargePointerShape(new Uint8Array(608278)), ProtocolError);
    assert.throws(() => parseLargePointerShape([]), ProtocolError);
    assert.throws(() => parsePointerShape(pointer(97, 1, 24, { large: false }), true), ProtocolError);
});
test('Large-pointer capability declares both sizes with sufficient multifragment capacity', () => {
    const caps = clientCapabilities({ width: 800, height: 600 });
    const get = type => caps.find(b => new DataView(b.buffer, b.byteOffset).getUint16(0, true) === type);
    assert.deepEqual([...get(27)], [27, 0, 6, 0, 3, 0]);
    assert.ok(new DataView(get(26).buffer).getUint32(4, true) >= 608299);
});
test('Fragmented large-pointer packets traverse the activated session and cached-pointer path', async t => {
    const events = [];
    let client;
    const server = new LoopbackServer({ send: bytes => queueMicrotask(() => client.receive(bytes)) });
    client = new Session({ options: { selectedProtocol: 1, requestedProtocols: 1, width: 640, height: 400 }, send: bytes => queueMicrotask(() => server.receive(bytes)), emit: event => events.push(event) });
    t.after(() => { client.close(); server.close(); });
    client.start(); await tick(); assert.equal(client.state, 'active');
    const wire = pointer(384, 384);
    for (const frame of packets(wire)) for (let p = 0; p < frame.length; p += 997) client.receive(frame.subarray(p, p + 997));
    assert.equal(client.state, 'active', JSON.stringify(events.filter(e => e.type === 'error')));
    const event = events.find(e => e.type === 'pointer' && e.shape?.width === 384);
    assert.ok(event); assert.equal(event.shape.pixels.length, 589824);
    const count = events.length;
    client.fastUpdate(10, new Writer().u16le(3).finish());
    assert.equal(events.length, count + 1); assert.equal(events.at(-1).shape, event.shape);
});
test('32-bit profiles request the correct GCC flag with a 24-bit fallback field', () => {
    for (const bpp of [15, 16, 24, 32]) {
        const core = clientCore({ width: 800, height: 600, bpp }), view = new DataView(core.buffer);
        assert.equal(view.getUint16(140, true), Math.min(24, bpp));
        assert.equal(view.getUint16(142, true) & 8, 8);
        assert.equal(view.getUint16(144, true) & 2, bpp === 32 ? 2 : 0);
        assert.equal(sanitizeProfile({ bpp }).bpp, bpp);
    }
    assert.equal(importRdp('session bpp:i:32').profile.bpp, 32);
    assert.match(exportRdp({ bpp: 32 }), /session bpp:i:32/);
});
test('Requested 32-bit session respects a server 24-bit fallback during activation', () => {
    const client = new Session({ options: { bpp: 32 }, send: () => {} });
    client.state = 'licensing'; client.userId = 1001; client.ioChannel = 1003;
    client.license(new Writer().u8(0xff).u8(3).u16le(16).u32le(7).u32le(2).u16le(4).u16le(0).finish());
    const caps = clientCapabilities({ width: 800, height: 600, bpp: 24 }), all = concat(...caps);
    const demand = new Writer().u32le(123).u16le(0).u16le(all.length + 4).u16le(caps.length).u16le(0).put(all).u32le(0).finish();
    client.share(1, 1002, demand);
    assert.equal(client.options.bpp, 24); assert.equal(client.state, 'activating');
    client.close();
});

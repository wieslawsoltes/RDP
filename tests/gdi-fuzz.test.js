import test from 'node:test';
import assert from 'node:assert/strict';
import { GdiOrders } from '../packages/render/gdi/Orders.js';
import { Reader } from '../packages/binary/Reader.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
import { concat } from '../packages/binary/Writer.js';
import * as W from './fixtures/GdiWire.js';

test('GDI 100000 bounded random and mutated stateful order streams fail only with controlled protocol errors', t => {
    let state = 0x47444933;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    const cases = [
        W.opaque(1, 2, 8, 8, 0x123456), W.dst(0, 0, 12, 12, 0x55), W.scr(1, 1, 8, 8, 0xcc, 0, 0),
        W.pattern(2, 2, 12, 12, { style: 3, hatch: 3, extra: new Uint8Array(7).fill(0x81) }),
        W.mem(1, 1, 1, 1), W.mem(2, 2, 1, 1, { brush: { fore: 0xff0000 } }),
        W.cache1(0, 1, 1, 1, 24, Uint8Array.of(9, 8, 7, 0)),
        W.cache2(0, 1, 1, 1, 24, Uint8Array.of(9, 8, 7, 0)),
        W.createOffscreen(1, 2, 2), W.switchSurface(65535),
        Uint8Array.of(0x41), Uint8Array.of(0x19, 10, 3, 1, 255),
    ];
    let accepted = 0, rejected = 0;
    for (let i = 0; i < 100000; i++) {
        const revision = (i & 1) + 1, g = new GdiOrders({ width: 16, height: 16, revision, maxWork: 16384 });
        const cache = revision === 1 ? W.cache1(0, 0, 1, 1, 24, new Uint8Array(4)) : W.cache2(0, 0, 1, 1, 24, new Uint8Array(4));
        g.receive(new Reader(concat(W.opaque(0, 0, 1, 1, 0x123456), cache)), 2);
        let input;
        if (i % 3 === 0) input = Uint8Array.from({ length: random() % 96 }, () => random() & 255);
        else {
            input = cases[random() % cases.length].slice();
            if (i % 3 === 1) {
                for (let n = 0, count = 1 + random() % 4; n < count; n++) input[random() % input.length] ^= 1 << (random() % 8);
            }
        }
        try {
            const result = g.receive(new Reader(input), 1);
            assert.ok(result.length <= 1);
            for (const bitmap of result) assert.equal(bitmap.data.byteLength, bitmap.width * bitmap.height * 4);
            accepted++;
        } catch (error) {
            assert.ok(error instanceof ProtocolError, `Unexpected ${error?.name} at case ${i}: ${Buffer.from(input).toString('hex')}`);
            assert.equal(g.closed, true); assert.equal(g.screen.pixels.length, 0); assert.equal(g.cache.bytes, 0);
            rejected++;
        } finally { g.close(); }
    }
    assert.ok(accepted > 0 && rejected > 0);
    t.diagnostic(JSON.stringify({ seed: '0x47444933', rounds: 100000, accepted, rejected, unexpected: 0,
        scope: 'Bounded deterministic mutation smoke test; no coverage guidance or independent protocol oracle' }));
});

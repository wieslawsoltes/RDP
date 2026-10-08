import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePlanar } from '../packages/codecs/Planar.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';

test('Planar 100000 deterministic bounded malformed streams produce only controlled failures', t => {
    let state = 0x504c4e52;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    let accepted = 0, rejected = 0;
    for (let i = 0; i < 100000; i++) {
        const width = 1 + random() % 16, height = 1 + random() % 16;
        const input = Uint8Array.from({ length: random() % 192 }, () => random() & 255);
        try {
            const out = decodePlanar(input, width, height, { maxDecodedBytes: 2048 });
            assert.equal(out.length, width * height * 4);
            accepted++;
        }
        catch (error) {
            assert.ok(error instanceof ProtocolError, `Unexpected ${error?.name} at iteration ${i}`);
            rejected++;
        }
    }
    assert.equal(accepted + rejected, 100000);
    assert.ok(accepted > 0 && rejected > 0);
    t.diagnostic(JSON.stringify({ seed: '0x504c4e52', rounds: 100000, accepted, rejected, unexpected: 0 }));
});

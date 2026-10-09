import test from 'node:test';
import assert from 'node:assert/strict';
import { SurfaceCommands } from '../packages/protocol/SurfaceCommands.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
import { concat } from '../packages/binary/Writer.js';
import { surfaceMarker, surfaceBits } from './fixtures/SurfacePeer.js';

test('Surface mutation smoke fuzz crosses valid raw/NSCodec frames with only controlled failures', t => {
    let seed = 0x53555246, accepted = 0, rejected = 0;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const seeds = [surfaceBits(), surfaceBits({ codec: 0, width: 3, height: 2, data: new Uint8Array(24) }),
        concat(surfaceMarker(0, 3), surfaceBits(), surfaceMarker(1, 3))];
    for (let n = 0; n < 10000; n++) {
        let wire = seeds[n % seeds.length].slice();
        for (let j = 0; j < 1 + n % 4; j++) wire[random() % wire.length] ^= 1 << (random() & 7);
        if (n % 7 === 0) wire = wire.subarray(0, random() % wire.length);
        let acknowledgements = 0;
        const decoder = new SurfaceCommands({ desktop: { width: 200, height: 200 },
            profile: { flags: 0x52, nsCodec: true, frameAcks: true, maxColorLoss: 7, allowSubsampling: true },
            emit: event => { for (const r of event.rectangles) { assert.ok(r.data.length <= 64 * 1024 * 1024); r.data.fill(0); } },
            acknowledge: () => acknowledgements++ });
        try { decoder.receive(wire); accepted++; }
        catch (error) { assert.ok(error instanceof ProtocolError, `Unexpected ${error.name} at case ${n}`); rejected++; }
        finally { decoder.close(); }
        assert.equal(acknowledgements, 0);
    }
    assert.ok(accepted > 0 && rejected > 0);
    t.diagnostic(JSON.stringify({ seed: '0x53555246', rounds: 10000, accepted, rejected, unexpected: 0 }));
});

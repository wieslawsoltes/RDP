import { performance } from 'node:perf_hooks';
import { writeFileSync, mkdirSync } from 'node:fs';
import { Reader } from '../packages/binary/Reader.js';
import { Writer } from '../packages/binary/Writer.js';
import { readTlv } from '../packages/binary/Asn1.js';
import { Framer } from '../packages/protocol/Framer.js';
import { FastPath } from '../packages/protocol/FastPath.js';
import { parseBitmapUpdate } from '../packages/protocol/BitmapUpdate.js';
import { decodeInterleaved } from '../packages/codecs/InterleavedRle.js';
import { parseTsRequest } from '../packages/security/TsRequest.js';
import { parseAvPairs } from '../packages/security/NtlmV2.js';
const SEED = 0x52445031;
let state = SEED;
const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
const rounds = Number(process.env.FUZZ_ROUNDS || 100000);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 1000000)
    throw new Error('FUZZ_ROUNDS must be 1..1000000');
const methods = {
    framing: bytes => new Framer(() => { }).push(bytes),
    fastPath: bytes => new FastPath(() => { }, 65536).push(bytes),
    asn1: bytes => readTlv(new Reader(bytes)),
    credSsp: bytes => parseTsRequest(bytes),
    ntlmAv: bytes => parseAvPairs(bytes),
    rle: bytes => decodeInterleaved(bytes, 8, 8, [8, 15, 16, 24][random() & 3]),
    bitmap: bytes => {
        // Restrict dimensions while fuzzing bitmap structures to avoid turning the test into an allocation benchmark.
        const body = new Writer().u16le(1).u16le(random() % 32).u16le(random() % 32).u16le(random() % 64).u16le(random() % 64).u16le(random() % 32 + 1).u16le(random() % 32 + 1).u16le([8, 15, 16, 24, 32][random() % 5]).u16le([0, 1, 0x401][random() % 3]).u16le(bytes.length).put(bytes).finish();
        return parseBitmapUpdate(new Reader(body), { width: 64, height: 64 });
    },
};
const counters = Object.fromEntries(Object.keys(methods).map(name => [name, { accepted: 0, rejected: 0 }]));
const entries = Object.entries(methods), start = performance.now();
let unexpected = 0;
for (let i = 0; i < rounds; i++) {
    const bytes = Uint8Array.from({ length: random() % 192 }, () => random() & 255), [name, method] = entries[i % entries.length];
    try {
        method(bytes);
        counters[name].accepted++;
    }
    catch (error) {
        counters[name].rejected++;
        if (!(error instanceof Error) || (error instanceof TypeError && /undefined|not a function/.test(error.message))) {
            unexpected++;
            console.error(name, Buffer.from(bytes).toString('hex'), error);
        }
    }
}
const report = { seed: `0x${SEED.toString(16)}`, rounds, durationMs: performance.now() - start, unexpected, counters, scope: 'Deterministic bounded malformed-input smoke fuzzing; not exhaustive coverage-guided fuzzing or a security audit.' };
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/fuzz.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (unexpected)
    process.exitCode = 1;

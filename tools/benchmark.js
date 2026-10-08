import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { decodeInterleaved } from '../packages/codecs/InterleavedRle.js';
import { toRgba, rgbaToBgr24 } from '../packages/codecs/Pixels.js';
import { Writer } from '../packages/binary/Writer.js';
import { Framer } from '../packages/protocol/Framer.js';
import { dataPdu } from '../packages/protocol/X224.js';
const results = [];
function measure(name, count, bytes, operation) {
    for (let i = 0; i < 5; i++)
        operation();
    const samples = [];
    for (let pass = 0; pass < 5; pass++) {
        const start = performance.now();
        for (let i = 0; i < count; i++)
            operation();
        samples.push((performance.now() - start) / count);
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[2];
    results.push({ name, iterationsPerPass: count, medianMs, inputMiBPerSecond: bytes / 1048576 / (medianMs / 1000), sampleMs: samples });
}
const width = 1280, height = 800, raw = new Uint8Array(width * height * 3), descriptor = { width, height, bpp: 24, stride: width * 3, bottomUp: true, data: raw }, destination = new Uint8ClampedArray(width * height * 4);
for (let i = 0; i < raw.length; i++)
    raw[i] = (i * 37) & 255;
measure('CPU BGR24→RGBA 1280x800; destination reused', 20, raw.length, () => toRgba(descriptor, undefined, destination));
const rle = new Writer().u8(0xf3).u16le(4096).u8(23).u8(45).u8(67).finish();
measure('Interleaved RLE solid 64x64x24', 100, rle.length, () => decodeInterleaved(rle, 64, 64, 24));
const frame = dataPdu(new Uint8Array(16000));
measure('TPKT framing 16 KiB in 16 chunks', 500, frame.length, () => {
    const f = new Framer(() => { });
    for (let at = 0; at < frame.length; at += 1024)
        f.push(frame.subarray(at, at + 1024));
});
const report = { date: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model, note: 'Local CPU microbenchmarks only. These are not remote desktop throughput, end-to-end latency, or GPU hardware benchmarks.', results };
mkdirSync('test-results', { recursive: true });
writeFileSync('test-results/benchmarks.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

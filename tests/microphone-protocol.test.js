import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioInputChannel } from '../packages/channels/AudioInputChannel.js';
import { PcmCapture } from '../packages/codecs/PcmCapture.js';
import { Writer, concat } from '../packages/binary/Writer.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
const format = (rate = 48000, channels = 2) => ({ tag: 1, channels, sampleRate: rate, bytesPerSecond: rate * channels * 2, blockAlign: channels * 2, bits: 16, extraSize: 0 });
const wireFormat = f => new Writer().u16le(f.tag).u16le(f.channels).u32le(f.sampleRate).u32le(f.bytesPerSecond).u16le(f.blockAlign).u16le(f.bits).u16le(f.extraSize).zeros(f.extraSize).finish();
const numbered = (type, n) => new Writer().u8(type).u32le(n).finish();
const formats = list => concat(new Writer().u8(2).u32le(list.length).u32le(0x80000000).finish(), ...list.map(wireFormat));
const open = (frames = 4, index = 0) => concat(new Writer().u8(3).u32le(frames).u32le(index).finish(), wireFormat(format()));
function fixture() {
    const sent = [], events = []; let allowed = true;
    const mic = new AudioInputChannel(b => sent.push(b.slice()), e => events.push(e), { canSend: () => allowed });
    const init = () => { mic.receive(numbered(1, 2)); mic.receive(formats([format(), format(16000, 1)])); mic.receive(open()); };
    const capture = (samples = [0.5, -0.5, 1, -1], extra = {}) => mic.capture({ requestId: 1, captureId: 1, sampleRate: 48000, planes: [Float32Array.from(samples)], ...extra });
    return { mic, sent, events, init, capture, block: () => allowed = false };
}
test('AUDIN follows published Version/Formats packet layout and ignores reserved server packet size and ExtraData', () => {
    const h = fixture(); h.mic.receive(Uint8Array.of(1, 1, 0, 0, 0));
    assert.deepEqual([...h.sent[0]], [1, 1, 0, 0, 0]);
    const unsupported = { ...format(), tag: 2 };
    h.mic.receive(concat(formats([unsupported, format(), format(16000, 1)]), Uint8Array.of(0xaa, 0xbb)));
    assert.deepEqual([...h.sent[1]], [5]);
    assert.deepEqual(h.sent[2], concat(new Writer().u8(2).u32le(2).u32le(45).finish(), wireFormat(format()), wireFormat(format(16000, 1))));
    assert.equal(h.mic.state, 'open');
});
test('AUDIN remote Open never grants capture or sends a success result without actual device readiness', () => {
    const h = fixture(); h.init(); const count = h.sent.length;
    assert.equal(h.mic.state, 'pending'); assert.equal(h.events.at(-1).kind, 'open');
    assert.equal(h.capture(), false); assert.equal(h.sent.length, count);
    assert.equal(h.mic.ready(999, 1), false); assert.equal(h.mic.state, 'pending');
    assert.equal(h.mic.ready(1, 1), true);
    assert.deepEqual(h.sent.slice(-2).map(v => [...v]), [[7, 0, 0, 0, 0], [4, 0, 0, 0, 0]]);
});
test('AUDIN emits exact frame-count PCM16 with Incoming Data before each packet', () => {
    const h = fixture(); h.init(); h.mic.ready(1, 1); h.capture();
    assert.deepEqual([...h.sent.at(-2)], [5]);
    const data = h.sent.at(-1); assert.equal(data[0], 6); assert.equal(data.length, 17);
    assert.deepEqual([...new Int16Array(data.slice(1).buffer)], [16384, 16384, -16384, -16384, 32767, 32767, -32768, -32768]);
    assert.equal(h.mic.stats().sentBytes, 16); assert.ok(h.mic.encoder.packet.every(v => v === 0));
});
test('AUDIN denies Open on device failure without pretending capture succeeded', () => {
    const h = fixture(); h.init(); assert.equal(h.mic.ready(1, 1, 0x80070005), false);
    assert.deepEqual([...h.sent.at(-1)], [4, 5, 0, 7, 128]); assert.equal(h.capture(), false);
    h.mic.receive(open()); assert.equal(h.events.at(-1).requestId, 2);
    assert.equal(h.mic.ready(1, 2), false);
});
test('AUDIN pause clears partial packets; explicit restart cannot reuse stale capture IDs', () => {
    const h = fixture(); h.init(); h.mic.ready(1, 1); h.capture([0.5, 0.5]);
    const old = h.mic.encoder.packet; h.mic.pause(1, 1);
    assert.ok(old.every(v => v === 0)); assert.equal(h.capture(), false);
    const n = h.sent.length; h.mic.ready(1, 2); assert.equal(h.sent.length, n);
    assert.equal(h.capture(), false); h.capture([1, 1, 1, 1], { captureId: 2 }); assert.equal(h.mic.stats().sentPackets, 1);
});
test('AUDIN format change discards partial old-format data and acknowledges before new samples', () => {
    const h = fixture(); h.init(); h.mic.ready(1, 1); h.capture([1]); const old = h.mic.encoder.packet;
    h.mic.receive(numbered(7, 1)); assert.ok(old.every(v => v === 0)); assert.deepEqual([...h.sent.at(-1)], [7, 1, 0, 0, 0]);
    h.capture([0, 0.25, 0.5, 1], { sampleRate: 16000 }); assert.equal(h.sent.at(-1).length, 9);
    h.mic.receive(numbered(7, 99)); assert.equal(h.mic.index, 1); assert.equal(h.mic.rejected, 1);
});
test('AUDIN drops before packetization when transport is blocked and does not retain microphone bytes', () => {
    const h = fixture(); h.init(); h.mic.ready(1, 1); h.capture([1]); const packet = h.mic.encoder.packet;
    const n = h.sent.length; h.block(); assert.equal(h.capture(), false); assert.equal(h.sent.length, n);
    assert.ok(packet.every(v => v === 0)); assert.equal(h.mic.encoder, null); assert.equal(h.mic.stats().droppedChunks, 1);
});
test('AUDIN close releases all capture state and ignores late device/network callbacks', () => {
    const h = fixture(); h.init(); h.mic.ready(1, 1); h.capture([1]); const encoder = h.mic.encoder;
    h.mic.close(); h.mic.close(); assert.equal(h.mic.encoder, null); assert.ok(encoder.packet.every(v => !v));
    assert.equal(h.events.filter(v => v.kind === 'closed').length, 1); assert.equal(h.capture(), false);
    assert.equal(h.mic.ready(1, 1), false); h.mic.receive(open()); assert.equal(h.mic.state, 'closed');
});
test('AUDIN refuses excessive frame counts explicitly, and preserves state on truncated/unknown packets', () => {
    for (const frames of [0, 8193, 0xffffffff]) {
        const h = fixture(); h.mic.receive(numbered(1, 2)); h.mic.receive(formats([format()])); h.mic.receive(open(frames));
        assert.equal(h.mic.state, 'open'); assert.equal(new DataView(h.sent.at(-1).buffer).getUint32(1, true), 0x80070057);
    }
    for (const packet of [numbered(1, 2), formats([format()]), open()]) {
        for (let cut = 0; cut < packet.length; cut++) {
            const h = fixture();
            if (packet[0] !== 1) h.mic.receive(numbered(1, 2));
            if (packet[0] === 3) h.mic.receive(formats([format()]));
            const state = h.mic.state; h.mic.receive(packet.subarray(0, cut)); assert.equal(h.mic.state, state); assert.equal(h.mic.rejected, 1);
        }
    }
});
test('AUDIN bounded malformed-input smoke coverage never prompts for a microphone', () => {
    let seed = 0x41554449; const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    let unexpectedOpens = 0;
    for (let i = 0; i < 10000; i++) {
        const mic = new AudioInputChannel(() => {}, e => { if (e.kind === 'open') unexpectedOpens++; });
        mic.receive(numbered(1, 2)); mic.receive(Uint8Array.from({ length: random() % 128 }, () => random() & 255)); mic.close();
    }
    assert.equal(unexpectedOpens, 0);
});
function encode(input, inputRate, outputRate, { channels = 1, frames = 16, chunk = 512 } = {}) {
    const packets = [], c = new PcmCapture({ inputRate, format: format(outputRate, channels), framesPerPacket: frames, emit: b => packets.push(b.slice()) });
    for (let i = 0; i < input.length; i += chunk) c.push([input.subarray(i, i + chunk)]);
    c.close(); return new Int16Array(concat(...packets).buffer);
}
test('PCM capture packet boundaries do not depend on input chunk boundaries', () => {
    const source = Float32Array.from({ length: 3000 }, (_, i) => Math.sin(i / 13));
    for (const [ir, or] of [[48000, 16000], [44100, 48000], [48000, 48000], [8000, 96000]])
        assert.deepEqual(encode(source, ir, or, { chunk: 7 }), encode(source, ir, or, { chunk: 512 }));
});
test('PCM capture downsampling suppresses above-Nyquist energy while preserving in-band tone', () => {
    const rms = values => Math.sqrt(values.slice(200).reduce((sum, v) => sum + (v / 32768) ** 2, 0) / (values.length - 200));
    const tone = freq => Float32Array.from({ length: 48000 }, (_, i) => 0.5 * Math.sin(i * 2 * Math.PI * freq / 48000));
    const signal = rms(encode(tone(1000), 48000, 16000)), alias = rms(encode(tone(12000), 48000, 16000));
    assert.ok(signal > 0.34 && signal < 0.36, String(signal)); assert.ok(alias < 0.001, String(alias));
});
test('PCM capture clips floats, sanitizes nonfinite samples and uses the full signed PCM range', () => {
    const input = Float32Array.from([-2, -1, -0.5, 0, 0.5, 1, 2, NaN, Infinity, -Infinity]);
    assert.deepEqual([...encode(input, 48000, 48000, { frames: 1 })], [-32768, -32768, -16384, 0, 16384, 32767, 32767, 0, 0, 0]);
});
test('PCM capture owns bounded state, clears on failure and validates shape/configuration', () => {
    const c = new PcmCapture({ inputRate: 48000, format: format(), framesPerPacket: 1, emit: () => { throw new Error('transport'); } });
    assert.throws(() => c.push([Float32Array.of(1)]), /transport/); assert.ok(c.packet.every(v => !v));
    for (const p of [[], [new Float32Array()], [new Float32Array(4097)], [new Float32Array(1), new Float32Array(2)], [new Uint8Array(1)]])
        assert.throws(() => c.push(p), ProtocolError);
    c.close(); assert.throws(() => c.push([Float32Array.of(1)]), ProtocolError);
    for (const f of [{ ...format(), bits: 8 }, { ...format(), sampleRate: 1 }])
        assert.throws(() => new PcmCapture({ inputRate: 48000, format: f, framesPerPacket: 1, emit() {} }), ProtocolError);
});

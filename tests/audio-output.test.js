import test from 'node:test';
import assert from 'node:assert/strict';
import { Reader } from '../packages/binary/Reader.js';
import { Writer, concat } from '../packages/binary/Writer.js';
import { AudioOutputChannel, soundPdu } from '../packages/channels/AudioOutputChannel.js';
import { decodePcm, supportedPcm } from '../packages/codecs/Pcm.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
import { Session } from '../packages/protocol/Session.js';
import { sanitizeProfile } from '../packages/profiles/Profiles.js';
import { clientInfo } from '../packages/protocol/ClientInfo.js';
const format = (bits = 16, channels = 2, sampleRate = 48000) => ({ tag: 1, channels, sampleRate,
    bytesPerSecond: sampleRate * channels * bits / 8, blockAlign: channels * bits / 8, bits, extraSize: 0 });
const formatBytes = f => new Writer().u16le(f.tag).u16le(f.channels).u32le(f.sampleRate).u32le(f.bytesPerSecond)
    .u16le(f.blockAlign).u16le(f.bits).u16le(f.extraSize).zeros(f.extraSize).finish();
const formatsPdu = (formats = [format()], version = 8) => soundPdu(7, new Writer().zeros(14).u16le(formats.length).u8(0xfe).u16le(version).u8(31)
    .put(concat(...formats.map(formatBytes))).finish());
const wave = (data, { block = 7, timestamp = 65530, index = 0 } = {}) => soundPdu(13,
    new Writer().u16le(timestamp).u16le(index).u8(block).zeros(3).u32le(123456).put(data).finish());
function channel() { const sent = [], events = []; let time = 100;
    const channel = new AudioOutputChannel(b => sent.push(b), e => events.push(e), { now: () => time });
    return { channel, sent, events, advance: n => { time += n; } };
}
function confirm(bytes) { const r = new Reader(bytes); assert.equal(r.u8(), 5); r.u8(); assert.equal(r.u16le(), 4);
    const result = { timestamp: r.u16le(), block: r.u8() }; assert.equal(r.u8(), 0); r.end(); return result; }

for (const bits of [8, 16, 24, 32]) test(`PCM ${bits}-bit signedness, stereo layout and owned subarray input`, () => {
    const f = format(bits), size = bits / 8, max = 2 ** (bits - 1), data = new Uint8Array(size * 6), values = [-max, 0, max - 1, -1, 1, -max / 2];
    for (let i = 0; i < values.length; i++) { let value = bits === 8 ? values[i] + 128 : values[i];
        for (let byte = 0; byte < size; byte++) data[i * size + byte] = value >> (byte * 8); }
    const store = concat(Uint8Array.of(99), data, Uint8Array.of(99));
    const result = decodePcm(store.subarray(1, -1), f); store.fill(0);
    assert.equal(result.frames, 3); assert.equal(result.sampleRate, 48000);
    for (let i = 0; i < values.length; i++) assert.equal(result.planes[i % 2][Math.floor(i / 2)], Math.fround(values[i] / max));
});
test('PCM refuses unsupported formats, truncated frames and excessive allocation', () => {
    for (const f of [{ ...format(), tag: 6 }, { ...format(), bits: 12 }, { ...format(), channels: 3 },
        { ...format(), sampleRate: 100000 }, { ...format(), blockAlign: 1 }, { ...format(), bytesPerSecond: 1 }, { ...format(), extraSize: 1 }]) {
        assert.equal(supportedPcm(f), false); assert.throws(() => decodePcm(new Uint8Array(4), f), ProtocolError);
    }
    for (const data of [new Uint8Array(), new Uint8Array(3), new Uint8Array(65536), []])
        assert.throws(() => decodePcm(data, format()), ProtocolError);
});
test('RDPSND advertises only exact supported server formats and indexes the filtered client list', () => {
    const { channel: c, sent, events } = channel();
    c.receive(formatsPdu([{ ...format(), tag: 6 }, format(8, 1, 8000), format()]));
    assert.equal(sent.length, 2); assert.equal(sent[1][0], 12);
    const r = new Reader(sent[0]); assert.equal(r.u8(), 7); r.skip(3); assert.equal(r.u32le(), 1);
    r.skip(8); assert.equal(r.u16be(), 0); assert.equal(r.u16le(), 2); assert.equal(r.u8(), 254); assert.equal(r.u16le(), 8); r.u8();
    assert.deepEqual(r.take(18), formatBytes(format(8, 1, 8000)));
    assert.deepEqual(r.take(18), formatBytes(format())); r.end();
    c.receive(wave(Uint8Array.of(0, 128, 255, 64)));
    const sample = events.find(e => e.kind === 'samples'); assert.equal(sample.sampleRate, 8000); assert.equal(sample.frames, 4);
    assert.deepEqual([...sample.planes[0]], [-1, 0, 127 / 128, -0.5]);
});
test('RDPSND legacy version skips quality mode and refuses unnegotiated Wave2', () => {
    const { channel: c, sent } = channel(); c.receive(formatsPdu([format()], 5)); assert.equal(sent.length, 1);
    c.receive(wave(new Uint8Array(4))); assert.equal(c.rejected, 1); assert.equal(c.pending.size, 0);
});
test('RDPSND training echoes timestamp and size without confusing padding with data', () => {
    const { channel: c, sent } = channel(); c.receive(formatsPdu());
    const body = new Writer().u16le(123).u16le(12).zeros(4).finish();
    c.receive(soundPdu(6, body)); assert.deepEqual(sent.at(-1), soundPdu(6, body.slice(0, 4)));
    c.receive(soundPdu(6, new Writer().u16le(3).u16le(0).finish()));
    assert.deepEqual(sent.at(-1), soundPdu(6, new Writer().u16le(3).u16le(0).finish()));
});
test('RDPSND defers confirmation until consumption and accounts elapsed time with wraparound', () => {
    const { channel: c, sent, events, advance } = channel(); c.receive(formatsPdu()); sent.length = 0;
    c.receive(wave(new Uint8Array(4))); assert.equal(sent.length, 0); assert.equal(c.queuedBytes, 8);
    advance(20); const id = events.find(e => e.kind === 'samples').id;
    assert.equal(c.consume(id, 'played'), true); assert.deepEqual(confirm(sent[0]), { timestamp: 14, block: 7 });
    assert.equal(c.consume(id, 'played'), false); assert.equal(sent.length, 1); assert.equal(c.queuedBytes, 0); assert.equal(c.played, 1);
});
test('RDPSND reconstructs split waves, clears saved prefixes, and starts timing at complete arrival', () => {
    const { channel: c, sent, events, advance } = channel(); c.receive(formatsPdu()); sent.length = 0;
    const pcm = new Writer().u16le(0x8000).u16le(0x7fff).u16le(1).u16le(2).finish();
    const info = new Writer().u8(2).u8(77).u16le(pcm.length + 8).u16le(100).u16le(0).u8(255).zeros(3).put(pcm.slice(0, 4)).finish();
    c.receive(info); const first = c.wave.first; advance(900);
    c.receive(concat(new Uint8Array(4), pcm.slice(4))); assert.deepEqual([...first], [0, 0, 0, 0]);
    const sample = events.find(e => e.kind === 'samples'); assert.deepEqual([...sample.planes[0]], [-1, 1 / 32768]);
    advance(5); c.consume(sample.id, 'played'); assert.deepEqual(confirm(sent[0]), { timestamp: 105, block: 255 });
});
test('RDPSND block-number rollover never aliases internal outstanding sample identifiers', () => {
    const { channel: c, events } = channel(); c.receive(formatsPdu());
    for (const block of [255, 0, 255]) c.receive(wave(new Uint8Array(4), { block }));
    const samples = events.filter(e => e.kind === 'samples'); assert.equal(new Set(samples.map(s => s.id)).size, 3);
    for (const sample of samples) assert.equal(c.consume(sample.id, 'dropped'), true);
});
test('RDPSND queue and duration budgets drop instead of growing; stream close drains existing audio', () => {
    const { channel: c, sent, events } = channel(); c.receive(formatsPdu([format(8, 1, 8000)])); sent.length = 0;
    for (let i = 0; i < 17; i++) c.receive(wave(new Uint8Array(4), { block: i }));
    assert.equal(c.pending.size, 16); assert.equal(sent.length, 1); assert.equal(confirm(sent[0]).block, 16); assert.equal(c.dropped, 1);
    c.receive(soundPdu(1)); assert.equal(c.pending.size, 16); assert.equal(events.at(-1).kind, 'stream-ended');
    c.receive(wave(new Uint8Array(16001))); assert.equal(c.dropped, 2);
    c.close(); assert.equal(c.queuedBytes, 0); assert.equal(c.pending.size, 0);
});
test('RDPSND renegotiation resets the host without acknowledging unconsumed old samples early', () => {
    const { channel: c, sent, events } = channel(); c.receive(formatsPdu()); c.receive(wave(new Uint8Array(4)));
    const id = events.find(e => e.kind === 'samples').id; sent.length = 0;
    c.receive(formatsPdu([format(8, 1, 8000)])); assert.equal(sent.some(b => b[0] === 5), false);
    assert.equal(c.pending.size, 1); assert.equal(c.consume(id, 'dropped'), true);
});
test('RDPSND ignores malformed and out-of-sequence messages without changing valid formats', () => {
    const { channel: c, sent } = channel(); c.receive(wave(new Uint8Array(4))); assert.equal(c.rejected, 1); assert.equal(sent.length, 0);
    c.receive(formatsPdu()); const valid = c.formats;
    const full = formatsPdu();
    for (let n = 0; n < full.length; n++) c.receive(full.subarray(0, n));
    assert.equal(c.formats, valid);
    c.receive(wave(new Uint8Array(4), { index: 9 })); c.receive(wave(new Uint8Array(3)));
    assert.equal(c.pending.size, 0);
    c.receive(soundPdu(0x77)); assert.equal(c.formats, valid);
});
test('RDPSND deterministic malformed-input smoke fuzz is bounded and permits no unexpected exceptions', () => {
    const { channel: c } = channel(); let seed = 0x52445041;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    for (let n = 0; n < 10000; n++) c.receive(Uint8Array.from({ length: random() % 256 }, () => random() & 255));
    assert.equal(c.pending.size, 0); assert.equal(c.queuedBytes, 0); assert.ok(c.rejected > 0);
});
test('Audio redirection is opt-in in profiles, GCC channels and Client Info', () => {
    assert.equal(sanitizeProfile({}).audio, false); assert.equal(sanitizeProfile({ audio: 'true' }).audio, false);
    assert.equal(sanitizeProfile({ audio: true }).audio, true);
    assert.equal(new Session({ send() {} }).channels.includes('rdpsnd'), false);
    assert.equal(new Session({ send() {}, options: { audio: true } }).channels.includes('rdpsnd'), true);
    for (const audio of [false, true]) {
        const r = new Reader(clientInfo({ audio })); r.skip(8);
        assert.equal(!!(r.u32le() & 0x80000), !audio);
    }
});

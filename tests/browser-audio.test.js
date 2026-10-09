import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAudio } from '../apps/client/BrowserAudio.js';
function harness() {
    const acks = [], status = [], sources = [], buffers = [];
    const context = { state: 'suspended', currentTime: 0, destination: {},
        createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
        resume: async () => { context.state = 'running'; }, close: async () => { context.state = 'closed'; },
        createBuffer: (channels, frames, rate) => {
            const planes = Array.from({ length: channels }, () => new Float32Array(frames));
            const buffer = { duration: frames / rate, numberOfChannels: channels,
                copyToChannel: (p, c) => planes[c].set(p), getChannelData: c => planes[c] };
            buffers.push(buffer); return buffer;
        }, createBufferSource: () => {
            const source = { connect() {}, disconnect() {}, start(time) { this.startTime = time; }, stop() { this.stopped = true; } };
            sources.push(source); return source;
        } };
    let creations = 0;
    const audio = new BrowserAudio({ consume: (id, disposition) => acks.push({ id, disposition }), status: s => status.push(s),
        contextFactory: () => { creations++; return context; } });
    return { audio, acks, sources, buffers, context, status, creations: () => creations };
}
const sample = (id = 1, frames = 480) => ({ id, frames, sampleRate: 48000,
    planes: [new Float32Array(frames).fill(0.5), new Float32Array(frames).fill(-0.5)] });
test('Browser audio never creates a context or starts playback from remote input alone', () => {
    const h = harness(), s = sample(); h.audio.receive(s);
    assert.equal(h.creations(), 0); assert.equal(h.sources.length, 0);
    assert.deepEqual(h.acks, [{ id: 1, disposition: 'dropped' }]); assert.equal(s.planes[0][0], 0);
});
test('Browser audio copies samples, clears worker planes and acknowledges only on ended', async () => {
    const h = harness(); await h.audio.enable(); const s = sample(); h.audio.receive(s);
    assert.equal(h.acks.length, 0); assert.equal(s.planes[0][0], 0); assert.equal(h.buffers[0].getChannelData(0)[0], 0.5);
    assert.equal(h.sources[0].startTime, 0.015); const ended = h.sources[0].onended; ended(); ended();
    assert.deepEqual(h.acks, [{ id: 1, disposition: 'played' }]); assert.equal(h.audio.bytes, 0);
    assert.equal(h.sources[0].buffer, null); assert.equal(h.buffers[0].getChannelData(0)[0], 0);
});
test('Browser audio preserves order with a bounded scheduling horizon and local volume', async () => {
    const h = harness(); await h.audio.enable(); h.audio.setVolume(0.25);
    h.audio.receive(sample(1, 48000)); h.audio.receive(sample(2, 48000));
    assert.equal(h.sources.length, 1); assert.deepEqual(h.acks, [{ id: 2, disposition: 'dropped' }]);
    h.audio.receive(sample(3, 480)); assert.ok(h.sources[1].startTime >= 1.015);
    assert.equal(h.audio.gain.gain.value, 0.25);
    for (const v of [-1, NaN, 2, Infinity]) assert.throws(() => h.audio.setVolume(v));
    h.audio.close();
});
test('Browser audio mute stops and clears scheduled samples exactly once', async () => {
    const h = harness(); await h.audio.enable(); h.audio.receive(sample()); const ended = h.sources[0].onended;
    h.audio.mute(); ended(); assert.equal(h.sources[0].stopped, true);
    assert.deepEqual(h.acks, [{ id: 1, disposition: 'dropped' }]); assert.equal(h.buffers[0].getChannelData(0)[0], 0);
    h.audio.receive(sample(2)); assert.equal(h.acks.at(-1).disposition, 'dropped');
});
test('Browser audio suspension clears queued audio instead of replaying it later', async () => {
    const h = harness(); await h.audio.enable(); h.audio.receive(sample());
    h.context.state = 'suspended'; h.context.onstatechange(); assert.equal(h.audio.pending.size, 0); assert.equal(h.audio.enabled, false);
    assert.equal(h.acks[0].disposition, 'dropped');
});
test('Browser audio late resume after close or mute cannot reactivate playback', async () => {
    for (const action of ['close', 'mute']) {
        const h = harness(); let resume; h.context.resume = () => new Promise(resolve => { resume = resolve; });
        const pending = h.audio.enable(); h.audio[action](); resume();
        assert.equal(await pending, false); assert.equal(h.audio.enabled, false);
    }
});
test('Browser audio rejects invalid buffers, honors queue bounds and clears on close', async () => {
    const h = harness(); await h.audio.enable();
    for (let id = 1; id <= 17; id++) h.audio.receive(sample(id));
    assert.equal(h.audio.pending.size, 16); assert.equal(h.sources.length, 16); assert.equal(h.acks[0].id, 17);
    const bad = sample(18); bad.frames = 1; h.audio.receive(bad); assert.equal(bad.planes[0][0], 0);
    h.audio.close(); h.audio.close(); assert.equal(h.audio.bytes, 0); assert.equal(h.audio.pending.size, 0);
    assert.equal(h.context.state, 'closed'); assert.equal(new Set(h.acks.map(v => v.id)).size, 18);
});
test('Browser audio source start failures drop exactly once and release copied data', async () => {
    const h = harness(); await h.audio.enable(); const make = h.context.createBufferSource;
    h.context.createBufferSource = () => { const source = make(); source.start = () => { throw new Error('device lost'); }; return source; };
    h.audio.receive(sample()); assert.deepEqual(h.acks, [{ id: 1, disposition: 'dropped' }]);
    assert.equal(h.audio.pending.size, 0); assert.equal(h.buffers[0].getChannelData(0)[0], 0);
});

test('Browser audio partial copy and source allocation failures clear all owned samples', async () => {
    for (const step of ['copy', 'source', 'connect']) {
        const h = harness(); await h.audio.enable();
        if (step === 'copy') {
            const make = h.context.createBuffer;
            h.context.createBuffer = (...args) => {
                const b = make(...args), copy = b.copyToChannel;
                b.copyToChannel = (p, c) => { if (c) throw new Error('copy failed'); copy(p, c); }; return b;
            };
        } else {
            const make = h.context.createBufferSource;
            h.context.createBufferSource = () => {
                if (step === 'source') throw new Error('allocation failed');
                const s = make(); s.connect = () => { throw new Error('connect failed'); }; return s;
            };
        }
        const s = sample(); h.audio.receive(s);
        assert.deepEqual(h.acks, [{ id: 1, disposition: 'dropped' }]);
        assert.equal(h.audio.bytes, 0); assert.equal(h.audio.pending.size, 0);
        assert.ok(h.buffers[0].getChannelData(0).every(v => v === 0));
        assert.ok(s.planes.every(p => p.every(v => v === 0)));
    }
});
test('Browser audio failed device initialization closes the context and can be retried', async () => {
    const h = harness(), gain = h.context.createGain;
    h.context.createGain = () => { throw new Error('device unavailable'); };
    await assert.rejects(() => h.audio.enable(), /device unavailable/);
    assert.equal(h.audio.context, null); assert.equal(h.context.state, 'closed');
    h.context.createGain = gain; assert.equal(await h.audio.enable(), true); h.audio.close();
});

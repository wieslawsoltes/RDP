import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserMicrophone } from '../apps/client/BrowserMicrophone.js';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const turns = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture(extra = {}) {
    const messages = [], status = [], contexts = [], streams = [], nodes = [];
    const stream = () => { const track = { readyState: 'live', stop() { this.readyState = 'ended'; this.stopped = true; } };
        const s = { getTracks: () => [track], getAudioTracks: () => [track] }; streams.push(s); return s; };
    const makeNode = () => { const n = { connect() {}, disconnect() { this.disconnected = true; },
        port: { messages: [], postMessage(value) { this.messages.push(value); }, close() { this.closed = true; } } }; nodes.push(n); return n; };
    const makeContext = () => { const c = { state: 'suspended', currentTime: 1, destination: {}, audioWorklet: { addModule: async () => {} },
        async resume() { this.state = 'running'; }, async close() { this.state = 'closed'; }, createMediaStreamSource: makeNode }; contexts.push(c); return c; };
    let requested = 0;
    const mic = new BrowserMicrophone({ send: (value, transfer = []) => { messages.push(structuredClone(value, { transfer })); return true; },
        status: v => status.push(v), mediaDevices: { getUserMedia: async () => { requested++; return stream(); } },
        contextFactory: makeContext, nodeFactory: makeNode, now: () => 1000, ...extra });
    const request = id => mic.receive({ kind: 'open', requestId: id, format: { sampleRate: 48000, channels: 2 }, framesPerPacket: 480 });
    const chunk = (id = 1, changes = {}) => ({ id, captureId: mic.run?.captureId || 1, time: 1, sampleRate: 48000,
        planes: [new Float32Array(512).fill(0.5), new Float32Array(512).fill(-0.5)], ...changes });
    return { mic, messages, status, contexts, streams, nodes, stream, request, chunk, requested: () => requested };
}
test('Remote microphone requests and format changes never acquire a device', async () => {
    const h = fixture(); assert.equal(await h.mic.enable(), false); h.request(1);
    h.mic.receive({ kind: 'format', requestId: 1, format: { sampleRate: 16000, channels: 1 } });
    assert.equal(h.requested(), 0); assert.equal(h.contexts.length, 0); assert.equal(h.messages.length, 0); h.mic.close();
});
test('Explicit capture creates the silent worklet graph, transfers buffers and returns correlated credits', async () => {
    const h = fixture(); h.request(1); assert.equal(await h.mic.enable(), true);
    assert.equal(h.requested(), 1); assert.equal(h.messages[0].type, 'microphone-ready'); assert.equal(h.messages[0].result, 0);
    const c = h.chunk(), node = h.mic.run.node; node.port.onmessage({ data: c });
    assert.equal(c.planes[0].byteLength, 0); assert.equal(h.messages.at(-1).planes[0][0], 0.5); assert.equal(h.mic.run.pending.size, 1);
    h.mic.consumed({ requestId: 1, captureId: 99, id: 1 }); assert.equal(h.mic.run.pending.size, 1);
    h.mic.consumed({ requestId: 1, captureId: 1, id: 1 }); assert.equal(h.mic.run.pending.size, 0);
    const n = node.port.messages.length; h.mic.consumed({ requestId: 1, captureId: 1, id: 1 }); assert.equal(node.port.messages.length, n);
    h.mic.stop(); assert.equal(h.streams[0].getTracks()[0].readyState, 'ended'); assert.equal(h.contexts[0].state, 'closed');
    assert.equal(node.port.closed, true); assert.equal(h.messages.at(-1).type, 'microphone-stop');
});
test('Stopping during an unanswered permission prompt settles promptly and stops a late stream', async () => {
    const pending = deferred(); const h = fixture({ mediaDevices: { getUserMedia: () => pending.promise } }); h.request(1);
    const enabling = h.mic.enable(); h.mic.stop(); assert.equal(await enabling, false); const stream = h.stream();
    pending.resolve(stream); await turns(); assert.equal(stream.getTracks()[0].readyState, 'ended');
    assert.equal(h.contexts[0].state, 'closed'); assert.ok(!h.messages.some(v => v.result === 0));
});
test('Capture setup timeout releases a context even when permission never settles', async () => {
    const h = fixture({ timeoutMs: 20, mediaDevices: { getUserMedia: () => new Promise(() => {}) } }); h.request(1);
    assert.equal(await h.mic.enable(), false); assert.equal(h.contexts[0].state, 'closed'); assert.equal(h.mic.run, null);
    assert.ok(h.status.includes('permission/setup timed out'));
});
test('Device is released while a worklet module or resume is stalled; late completion cannot restart', async () => {
    for (const stalled of ['module', 'resume']) {
        const h = fixture(), wait = deferred(), old = h.mic.contextFactory;
        h.mic.contextFactory = () => { const c = old(); if (stalled === 'module') c.audioWorklet.addModule = () => wait.promise; else c.resume = () => wait.promise; return c; };
        h.request(1); const start = h.mic.enable(); await turns(); h.mic.close(); assert.equal(await start, false);
        assert.equal(h.streams[0].getTracks()[0].readyState, 'ended'); wait.resolve(); await turns();
        assert.equal(h.nodes.length, 0); assert.equal(h.contexts[0].state, 'closed');
    }
});
test('Denied permission and synchronous device failures never report successful Open', async () => {
    for (const getUserMedia of [async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); }, () => { throw new Error('device failure'); }]) {
        const h = fixture({ mediaDevices: { getUserMedia } }); h.request(1); assert.equal(await h.mic.enable(), false);
        assert.ok(h.messages.every(v => v.result !== 0)); assert.equal(h.contexts[0].state, 'closed');
        assert.equal(h.mic.request, null); assert.equal(await h.mic.enable(), false);
        assert.equal(h.contexts.length, 1);
    }
});
test('Track revocation, suspension and processor failure stop capture and require a new user action', async () => {
    for (const stop of [h => h.streams[0].getTracks()[0].onended(), h => h.streams[0].getTracks()[0].onmute(),
        h => { h.contexts[0].state = 'suspended'; h.contexts[0].onstatechange(); }, h => h.mic.run.node.onprocessorerror()]) {
        const h = fixture(); h.request(1); await h.mic.enable(); stop(h); assert.equal(h.mic.run, null);
        assert.equal(h.streams[0].getTracks()[0].readyState, 'ended'); assert.equal(h.contexts[0].state, 'closed');
    }
});
test('Duplicate starts, old channel events and late sample/credit callbacks cannot replace a new capture', async () => {
    const h = fixture(); h.request(1); await h.mic.enable(); assert.equal(await h.mic.enable(), false);
    const old = h.mic.run.node.port.onmessage; h.mic.stop(); await h.mic.enable(); assert.equal(h.mic.run.captureId, 2);
    const c = h.chunk(1, { captureId: 1 }); old({ data: c }); assert.ok(c.planes[0].every(v => !v));
    h.mic.receive({ kind: 'closed', requestId: 999 }); assert.equal(h.mic.run.captureId, 2);
    h.mic.receive({ kind: 'ready-result', accepted: false, requestId: 1, captureId: 1 }); assert.equal(h.mic.run.captureId, 2);
    h.mic.receive({ kind: 'closed', requestId: 1 }); assert.equal(h.mic.run, null); assert.equal(h.mic.request, null);
    h.mic.close(); assert.equal(await h.mic.enable(), false);
});
test('Stale/invalid capture chunks are cleared, and unacknowledged transfers never exceed four', async () => {
    const h = fixture(); h.request(1); await h.mic.enable(); const node = h.mic.run.node;
    const stale = h.chunk(1, { time: 0 }); node.port.onmessage({ data: stale }); assert.ok(stale.planes[0].every(v => !v));
    for (let i = 2; i <= 8; i++) node.port.onmessage({ data: h.chunk(i) });
    assert.equal(h.messages.filter(m => m.type === 'microphone-data').length, 4); assert.equal(h.mic.run.pending.size, 4);
    h.mic.close();
});
test('Capture readiness rejection stops the exact attempt without closing unrelated new requests', async () => {
    const h = fixture(); h.request(1); await h.mic.enable();
    h.mic.receive({ kind: 'ready-result', requestId: 1, captureId: 1, accepted: false });
    assert.equal(h.mic.run, null); assert.equal(h.mic.request, null); assert.equal(h.streams[0].getTracks()[0].readyState, 'ended');
});
test('Worklet waits for explicit start, emits silence, bounds transfers and ignores invented credits', async () => {
    let Processor;
    const globals = { AudioWorkletProcessor: class { constructor() { this.port = { messages: [], postMessage(value, transfer) { this.messages.push(structuredClone(value, { transfer })); } }; } },
        registerProcessor: (_name, p) => Processor = p, sampleRate: 48000, currentTime: 1 };
    runInNewContext(await readFile(new URL('../apps/client/microphone-worklet.js', import.meta.url), 'utf8'), globals);
    const p = new Processor(), input = [[new Float32Array(128).fill(0.5)]], output = [[new Float32Array(128).fill(1)]];
    const process = n => { for (let i = 0; i < n; i++) p.process(input, output); };
    process(10); assert.equal(p.port.messages.length, 0); assert.ok(output[0][0].every(v => v === 0));
    p.port.onmessage({ data: { type: 'start', captureId: 1 } }); process(40); assert.equal(p.port.messages.length, 4);
    assert.equal(p.pending.size, 4); assert.equal(p.at, 0); assert.ok(p.planes[0].every(v => v === 0));
    p.port.onmessage({ data: { type: 'credit', captureId: 2, id: 1 } }); p.port.onmessage({ data: { type: 'credit', captureId: 1, id: 99 } });
    process(4); assert.equal(p.port.messages.length, 4);
    p.port.onmessage({ data: { type: 'credit', captureId: 1, id: 1 } }); p.port.onmessage({ data: { type: 'credit', captureId: 1, id: 1 } });
    process(8); assert.equal(p.port.messages.length, 5); assert.ok(p.port.messages[0].planes.every(v => v.every(s => s === 0.5)));
    p.port.onmessage({ data: { type: 'stop' } }); process(8); assert.equal(p.port.messages.length, 5); assert.equal(p.pending.size, 0);
});

test('Denied resume retains an opened stream but does not send a second Open Reply', async () => {
    const h = fixture(); h.request(1); await h.mic.enable(); h.mic.stop();
    h.mic.mediaDevices.getUserMedia = async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); };
    assert.equal(await h.mic.enable(), false); assert.equal(h.mic.request.requestId, 1);
    assert.equal(h.messages.filter(v => v.type === 'microphone-ready').length, 1);
    assert.equal(h.messages.at(-1).type, 'microphone-stop');
    h.mic.mediaDevices.getUserMedia = async () => h.stream();
    assert.equal(await h.mic.enable(), true); assert.equal(h.mic.run.captureId, 3); h.mic.close();
});

test('Worklet credit failure stops the device without throwing from the event handler', async () => {
    const h = fixture(); h.request(1); await h.mic.enable(); h.mic.chunk(h.mic.run, h.chunk());
    h.mic.run.node.port.postMessage = () => { throw new Error('closed port'); };
    assert.doesNotThrow(() => h.mic.consumed({ requestId: 1, captureId: 1, id: 1 }));
    assert.equal(h.mic.run, null); assert.equal(h.streams[0].getTracks()[0].readyState, 'ended');
});

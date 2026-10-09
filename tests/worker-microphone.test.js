import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

async function harness(t) {
    const worker = new Worker(new URL('./fixtures/WorkerMicrophoneHarness.js', import.meta.url));
    t.after(() => worker.terminate());
    const [ready] = await once(worker, 'message'); assert.equal(ready.ready, true);
    let id = 0;
    const call = async (op, value) => {
        const response = once(worker, 'message'); worker.postMessage({ id: ++id, op, value });
        const [result] = await response; assert.equal(result.id, id); assert.equal(result.error, undefined, result.error);
        assert.equal(result.events.some(v => v.type === 'error' && v.code !== 'TEST_FAILURE'), false, JSON.stringify(result.events));
        return result;
    };
    const start = await call('start');
    assert.ok(start.events.some(v => v.type === 'state' && v.state === 'active'));
    assert.ok(start.events.some(v => v.type === 'microphone' && v.kind === 'open'));
    assert.equal(start.openResult, null); assert.deepEqual(start.packets, []);
    return call;
}
const ready = (requestId = 1, captureId = 1) => ({ type: 'microphone-ready', requestId, captureId, result: 0 });
const chunk = (extra = {}) => ({ type: 'microphone-data', id: 1, requestId: 1, captureId: 1, sampleRate: 48000,
    queuedAt: 1001000, planes: [new Float32Array(512).fill(0.5), new Float32Array(512).fill(-0.5)], ...extra });
const consumed = result => result.events.filter(v => v.type === 'microphone-consumed');

test('Actual worker requires correlated microphone readiness and returns credit after clearing samples', { timeout: 5000 }, async t => {
    const call = await harness(t);
    const premature = await call('message', chunk()); assert.equal(premature.cleared, true); assert.deepEqual(premature.packets, []);
    assert.equal(consumed(premature).length, 1);
    const r = await call('message', ready()); assert.equal(r.openResult, 0);
    assert.ok(r.events.some(v => v.kind === 'ready-result' && v.accepted));
    const data = await call('message', chunk()); assert.equal(data.cleared, true);
    assert.deepEqual(data.packets, [{ index: 0, bytes: 1920, first: 16384 }]);
    assert.deepEqual(consumed(data), [{ type: 'microphone-consumed', id: 1, requestId: 1, captureId: 1 }]);
});
test('Actual worker rejects expired, future and nonfinite microphone timestamps without withholding credits', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('message', ready());
    for (const queuedAt of [1000749, 1001001, NaN, Infinity, undefined]) {
        const result = await call('message', chunk({ queuedAt }));
        assert.equal(result.cleared, true); assert.equal(result.packets.length, 0); assert.equal(consumed(result).length, 1);
    }
    assert.equal((await call('message', chunk({ queuedAt: 1000750 }))).packets.length, 1);
});
test('Actual worker drops captured audio on backpressure and accepts only fresh chunks after recovery', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('message', ready()); await call('block', true);
    const blocked = await call('message', chunk());
    assert.equal(blocked.cleared, true); assert.equal(blocked.packets.length, 0); assert.equal(consumed(blocked).length, 1);
    await call('block', false);
    assert.equal((await call('message', chunk({ id: 2 }))).packets.length, 1);
});
test('Actual worker discards paused/stale capture epochs and handles channel recreation', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('message', ready());
    await call('message', { type: 'microphone-stop', requestId: 1, captureId: 1 });
    assert.equal((await call('message', chunk())).packets.length, 0);
    await call('message', ready(1, 2));
    assert.equal((await call('message', chunk())).packets.length, 0);
    assert.equal((await call('message', chunk({ captureId: 2 }))).packets.length, 1);
    assert.equal((await call('channel-close')).channelClosed, true);
    const opened = await call('channel-reopen');
    assert.ok(opened.events.some(v => v.kind === 'open' && v.requestId === 2));
    assert.equal((await call('message', chunk({ captureId: 2 }))).packets.length, 1);
    await call('message', ready(2, 3));
    assert.equal((await call('message', chunk({ requestId: 2, captureId: 3 }))).packets.length, 2);
});
test('Actual worker changes packet encoding only after server format-change acknowledgement', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('message', ready()); await call('message', chunk());
    await call('format', 1);
    const result = await call('message', chunk({ sampleRate: 16000 }));
    assert.deepEqual(result.packets.at(-1), { index: 1, bytes: 960, first: 0 }); assert.equal(result.cleared, true);
});
for (const op of ['disconnect', 'failure']) {
    test(`Actual worker ${op} closes the microphone owner and clears late transferred data`, { timeout: 5000 }, async t => {
        const call = await harness(t); await call('message', ready()); await call('message', chunk());
        const closed = await call(op); assert.equal(closed.timers, 0); assert.equal(closed.closes, 1);
        const late = await call('message', chunk({ id: 2 })); assert.equal(late.cleared, true);
        assert.equal(late.packets.length, 1); assert.deepEqual(late.events, []);
    });
}
test('Actual worker clears malformed capture data and returns its credit even when packetization throws', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('message', ready());
    const result = await call('message', chunk({ sampleRate: 1 }));
    assert.equal(result.cleared, true); assert.equal(consumed(result).length, 1);
    assert.ok(result.events.some(v => v.type === 'notice')); assert.equal(result.packets.length, 0);
});

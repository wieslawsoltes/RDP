import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { expectedScene } from './fixtures/GdiPeer.js';
async function harness(t) {
    const worker = new Worker(new URL('./fixtures/WorkerGdiHarness.js', import.meta.url)); t.after(() => worker.terminate());
    const [ready] = await once(worker, 'message'); assert.equal(ready.ready, true); let id = 0;
    const call = async (op, value) => {
        const reply = once(worker, 'message'); worker.postMessage({ id: ++id, op, value });
        const [result] = await reply; assert.equal(result.id, id); assert.equal(result.error, undefined, result.error); return result;
    };
    const started = await call('start'); assert.ok(started.events.some(e => e.type === 'state' && e.state === 'active'));
    assert.ok(started.events.some(e => e.type === 'drawing-profile' && e.enabled && e.cacheRevision === 2)); return call;
}
test('Actual session worker transfers GDI pixels without detaching canonical desktop or cache storage', { timeout: 5000 }, async t => {
    const call = await harness(t), drawn = await call('scene'), expected = expectedScene();
    assert.ok(drawn.transfers > 0); assert.equal(drawn.detached, true);
    assert.equal(drawn.events.some(e => e.type === 'error'), false, JSON.stringify(drawn.events));
    for (let y = 0; y < 20; y++) assert.deepEqual(drawn.pixels.slice(y * drawn.width, y * drawn.width + 32), expected.subarray(y * 32, y * 32 + 32));
    const copied = await call('copy'); assert.equal(copied.pixels[20 * copied.width + 40], 0xf012ab);
    const stats = copied.events.find(e => e.type === 'statistics'); assert.equal(stats.gdi.orders, 13);
    const stopped = await call('close'); assert.equal(stopped.closes, 1); assert.equal(stopped.timers, 0);
});
test('Actual worker bounds two in-flight render batches while GDI state stays ordered', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('block', true); await call('scene'); await call('scene');
    const blocked = await call('scene'); assert.equal(blocked.maxInflight, 2);
    const stat = blocked.events.find(e => e.type === 'statistics'); assert.equal(stat.inflight, 2); assert.ok(stat.queuedBytes > 0);
    const unblocked = await call('block', false); assert.equal(unblocked.maxInflight, 2);
    assert.equal(unblocked.events.some(e => e.type === 'error'), false); assert.equal(unblocked.pixels[19 * 200 + 31], 0xf012ab);
    assert.equal(unblocked.events.find(e => e.type === 'statistics').queuedBytes, 0); await call('close');
});
test('Malformed drawing orders stop the actual worker and suppress late render callbacks', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('scene');
    const failed = await call('malformed'); assert.ok(failed.events.some(e => e.type === 'error' && e.code === 'GDI_ORDER'));
    assert.equal(failed.closes, 1); assert.equal(failed.timers, 0);
    const late = await call('scene'); assert.equal(late.frames, failed.frames); assert.equal(late.closes, 1); assert.equal(late.events.length, 0);
});

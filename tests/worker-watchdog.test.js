import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

async function harness(t) {
    const worker = new Worker(new URL('./fixtures/WorkerWatchdogHarness.js', import.meta.url));
    t.after(() => worker.terminate());
    const [ready] = await once(worker, 'message'); assert.equal(ready.ready, true);
    let id = 0;
    return async (op, value) => {
        const reply = once(worker, 'message'); worker.postMessage({ id: ++id, op, value });
        const [result] = await reply; assert.equal(result.id, id); assert.equal(result.error, undefined, result.error);
        return result;
    };
}
const failure = result => result.events.find(v => v.type === 'error');

test('Real browser worker times out unopened sockets, scrubs startup secrets and ignores a late open', { timeout: 5000 }, async t => {
    const call = await harness(t); const start = await call('start'); assert.equal(start.scrubbed.password, true);
    const result = await call('tick', 15000); assert.equal(failure(result).code, 'GATEWAY_OPEN_TIMEOUT');
    assert.deepEqual(result.scrubbed, { token: true, password: true }); assert.equal(result.timers, 0);
    assert.equal(result.handlersReleased, true); assert.equal(result.closes, 1);
    const late = await call('late-open'); assert.deepEqual(late.controls, []); assert.deepEqual(late.events, []);
});
test('Real worker sends at most one unresolved probe and disconnects on its deadline', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('start'); await call('open');
    const warning = await call('tick', 10000);
    assert.equal(warning.events.find(v => v.type === 'connection-health').status, 'unresponsive');
    assert.equal(warning.controls.filter(v => v.type === 'ping').length, 1);
    const result = await call('tick', 20000); assert.equal(failure(result).code, 'GATEWAY_HEARTBEAT_TIMEOUT');
    assert.equal(result.timers, 0); assert.equal(result.handlersReleased, true);
});
test('Worker security deadline persists while correlated pongs and stage messages arrive', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('start'); await call('open');
    for (let time = 0; time < 35000; time += 5000) {
        const tick = await call('tick', time);
        await call('control', { type: 'pong', id: tick.controls.filter(v => v.type === 'ping').at(-1).id });
        await call('control', { type: 'stage', state: 'authenticating' });
    }
    const result = await call('tick', 35000); assert.equal(failure(result).code, 'GATEWAY_SECURITY_TIMEOUT');
});
test('Worker clears credentials on ready and fails an RDP session that never activates', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('start'); await call('open');
    const ready = await call('control', { type: 'ready', selectedProtocol: 2, requestedProtocols: 2 });
    assert.deepEqual(ready.scrubbed, { token: true, password: true });
    for (let time = 0; time < 60000; time += 5000) {
        const tick = await call('tick', time);
        await call('control', { type: 'pong', id: tick.controls.filter(v => v.type === 'ping').at(-1).id });
    }
    const result = await call('tick', 60000); assert.equal(failure(result).code, 'RDP_ACTIVATION_TIMEOUT');
    assert.equal(result.timers, 0);
});
test('Worker ignores unsolicited/stale pongs, measures RTT and creates a fresh probe', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('start'); await call('open'); await call('tick', 125);
    const wrong = await call('control', { type: 'pong', id: 99 }); assert.deepEqual(wrong.events, []);
    const pong = await call('control', { type: 'pong', id: 1 });
    assert.equal(pong.events.find(v => v.type === 'latency').bridgeRttMs, 125);
    const repeat = await call('control', { type: 'pong', id: 1 }); assert.deepEqual(repeat.events, []);
    const next = await call('tick', 5000); assert.equal(next.controls.filter(v => v.type === 'ping').at(-1).id, 2);
});
test('Worker cleanup completes even when send and close both throw', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('start'); await call('break-socket');
    const result = await call('open'); assert.equal(result.timers, 0); assert.equal(result.closes, 1);
    assert.equal(result.handlersReleased, true); assert.deepEqual(result.scrubbed, { token: true, password: true });
    assert.equal(result.events.filter(v => v.type === 'error').length, 1);
});
test('Explicit close cancels pending connection work without re-authentication', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('start'); await call('open');
    const result = await call('close'); assert.equal(result.timers, 0); assert.equal(result.handlersReleased, true);
    assert.deepEqual(result.scrubbed, { token: true, password: true });
    const late = await call('tick', 600000); assert.deepEqual(late.events, []);
    assert.equal(late.controls.filter(v => v.type === 'connect').length, 1);
});
test('Clean gateway close releases the worker and emits the disconnected state', { timeout: 5000 }, async t => {
    const call = await harness(t); await call('start'); await call('open');
    const result = await call('socket-close'); assert.equal(result.timers, 0);
    assert.equal(result.events.find(v => v.type === 'state').state, 'closed'); assert.equal(result.handlersReleased, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionWatchdog } from '../packages/protocol/ConnectionWatchdog.js';

function fixture(options = {}) {
    let time = 0;
    const probes = [], failures = [], health = [];
    const watchdog = new ConnectionWatchdog({ ping: id => probes.push(id), fail: e => failures.push(e),
        health: e => health.push(e), now: () => time, ...options });
    return { watchdog, probes, failures, health, set: value => { time = value; },
        tick: value => { time = value; watchdog.tick(); } };
}
function active(f) { f.watchdog.opened(); f.watchdog.secured(); f.watchdog.activated(); }

test('Connection watchdog bounds an unopened WebSocket and fails only once', () => {
    const f = fixture(); f.tick(14999); assert.equal(f.failures.length, 0);
    f.tick(15000); f.tick(999999); assert.equal(f.failures.length, 1);
    assert.equal(f.failures[0].code, 'GATEWAY_OPEN_TIMEOUT'); assert.deepEqual(f.probes, []);
    assert.equal(f.watchdog.opened(), false);
});
test('Gateway authentication deadline cannot be extended by valid pongs', () => {
    const f = fixture(); f.watchdog.opened();
    for (let time = 0; time < 35000; time += 5000) { f.tick(time); f.watchdog.pong(f.probes.at(-1)); }
    f.tick(35000); assert.equal(f.failures[0].code, 'GATEWAY_SECURITY_TIMEOUT');
});
test('RDP activation has a separate deadline even with a responsive gateway', () => {
    const f = fixture(); f.watchdog.opened(); f.watchdog.secured();
    for (let time = 0; time < 60000; time += 5000) { f.tick(time); f.watchdog.pong(f.probes.at(-1)); }
    f.tick(60000); assert.equal(f.failures[0].code, 'RDP_ACTIVATION_TIMEOUT');
});
test('Active sessions can be idle indefinitely when the gateway responds', () => {
    const f = fixture(); active(f);
    for (let time = 0; time < 1000000; time += 5000) { f.tick(time); f.watchdog.pong(f.probes.at(-1)); }
    assert.equal(f.failures.length, 0); assert.equal(f.watchdog.phase, 'active');
});
test('Lost pongs use one bounded probe and transition warning to terminal failure', () => {
    const f = fixture(); active(f);
    f.tick(9999); assert.equal(f.health.length, 0);
    f.tick(10000); f.tick(19999); assert.equal(f.health.length, 1); assert.equal(f.health[0].status, 'unresponsive');
    f.tick(20000); assert.equal(f.failures[0].code, 'GATEWAY_HEARTBEAT_TIMEOUT');
    assert.deepEqual(f.probes, [1]); assert.equal(f.watchdog.pending, null);
    assert.equal(f.health.at(-1).status, 'disconnected');
});
test('Matched pongs recover health and compute monotonic gateway RTT', () => {
    const f = fixture(); active(f); f.tick(11000); f.set(12000);
    assert.equal(f.watchdog.pong(1), true); assert.equal(f.watchdog.rttMs, 12000);
    assert.equal(f.health.at(-1).status, 'responsive'); f.tick(12001);
    assert.deepEqual(f.probes, [1, 2]); f.set(12004); f.watchdog.pong(2); assert.equal(f.watchdog.rttMs, 3);
});
test('Duplicate, forged, stale and malformed pongs do not satisfy the current probe', () => {
    const f = fixture(); active(f); f.set(1); f.watchdog.pong(1); f.tick(5000);
    for (const id of [1, 0, 3, '2', null, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])
        assert.equal(f.watchdog.pong(id), false);
    f.tick(25000); assert.equal(f.failures[0].code, 'GATEWAY_HEARTBEAT_TIMEOUT');
});
test('A pong at the deadline cannot revive a timed-out connection', () => {
    const f = fixture(); active(f); f.set(20000);
    assert.equal(f.watchdog.pong(1), false); assert.equal(f.failures.length, 1);
    f.set(20001); assert.equal(f.watchdog.pong(1), false);
});
test('Phase completion after its deadline is rejected without extending the limit', () => {
    const f = fixture(); f.set(16000); assert.equal(f.watchdog.opened(), false);
    const g = fixture({ timeoutMs: 100000 }); g.watchdog.opened(); g.set(35000);
    assert.equal(g.watchdog.secured(), false); assert.equal(g.failures[0].code, 'GATEWAY_SECURITY_TIMEOUT');
    const h = fixture({ timeoutMs: 100000 }); h.watchdog.opened(); h.watchdog.secured(); h.set(60000);
    assert.equal(h.watchdog.activated(), false); assert.equal(h.failures[0].code, 'RDP_ACTIVATION_TIMEOUT');
});
test('Repeated reactivation notifications cannot postpone an activation timeout', () => {
    const f = fixture(); active(f); f.watchdog.pong(1); f.set(100); f.watchdog.reactivating();
    for (let time = 5000; time <= 60000; time += 5000) {
        f.tick(time); f.watchdog.pong(f.probes.at(-1)); f.watchdog.reactivating();
    }
    f.tick(60100); assert.equal(f.failures[0].code, 'RDP_ACTIVATION_TIMEOUT');
});
test('Watchdog closure cancels every phase and outstanding probe without callbacks', () => {
    for (const phase of ['connecting', 'securing', 'activating', 'active']) {
        const f = fixture(); if (phase !== 'connecting') f.watchdog.opened();
        if (['activating', 'active'].includes(phase)) f.watchdog.secured();
        if (phase === 'active') f.watchdog.activated();
        f.watchdog.close(); f.tick(1000000); assert.equal(f.watchdog.pong(1), false);
        assert.equal(f.failures.length, 0); assert.equal(f.watchdog.pending, null);
        assert.equal(f.watchdog.secured(), false); assert.equal(f.watchdog.activated(), false);
    }
});
test('A failed socket send becomes one controlled failure without leaking its error text', () => {
    const f = fixture({ ping: () => { throw new Error('private transport data'); } }); f.watchdog.opened(); f.tick(5000);
    assert.equal(f.failures.length, 1); assert.equal(f.failures[0].code, 'GATEWAY_PROBE_FAILED');
    assert.doesNotMatch(f.failures[0].message, /private/);
});
test('Monotonic clock rollback cannot make RTT negative or delay expiration', () => {
    const f = fixture(); f.set(100); active(f); f.set(99); f.watchdog.pong(1);
    assert.equal(f.watchdog.rttMs, 0); f.tick(5100); f.tick(4000); f.tick(25100);
    assert.equal(f.failures[0].code, 'GATEWAY_HEARTBEAT_TIMEOUT');
});
test('Watchdog rejects unsafe resource limits and invalid lifecycle transitions', () => {
    for (const options of [{ ping: null }, { fail: null }, { connectMs: 0 }, { activateMs: Infinity },
        { secureMs: 300001 }, { intervalMs: 1.5 }, { warningMs: 20000 }, { intervalMs: 15000 }])
        assert.throws(() => fixture(options));
    const f = fixture(); assert.throws(() => f.watchdog.secured()); assert.throws(() => f.watchdog.activated());
    f.watchdog.opened(); assert.throws(() => f.watchdog.opened());
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { GatewayLicensing } from '../packages/licensing/GatewayLicensing.js';
import { MemoryLicenseStore } from '../apps/gateway/LicenseStore.js';
import { Session } from '../packages/protocol/Session.js';
import { LoopbackServer } from '../packages/lab/LoopbackServer.js';
import { sendData } from '../packages/protocol/Mcs.js';
import { Writer } from '../packages/binary/Writer.js';
import { configureLicensingPeer } from './fixtures/LicensingPeer.js';
import * as F from './fixtures/Licensing.js';
const namespace = 'a'.repeat(64), key = F.proprietaryKey();
async function until(predicate) {
    for (let i = 0; i < 100; i++) { if (predicate()) return; await sleep(2); }
    throw new Error('Fixture did not reach the expected state');
}
function pair(t, { store = new MemoryLicenseStore(), fragment = false, ...peerOptions } = {}) {
    let gate, session, peer, failure;
    const events = [], forwarded = [], statuses = [];
    const deliver = bytes => {
        if (fragment) for (let i = 0; i < bytes.length; i++) gate.server(bytes.subarray(i, i + 1));
        else gate.server(bytes);
    };
    gate = new GatewayLicensing({ requestedProtocols: 1, store, namespace, username: 'User',
        write: bytes => { peer.receive(bytes); return Promise.resolve(); },
        forward: bytes => { forwarded.push(bytes.slice()); session.receive(bytes); },
        notify: message => { statuses.push(message); session.licensingResult(message); },
        pause: () => {}, resume: () => {}, fail: error => { failure = error; session.fail(error); } });
    peer = new LoopbackServer({ requestedProtocols: 1, send: deliver });
    const peerState = configureLicensingPeer(peer, { key, ...peerOptions });
    session = new Session({ options: { selectedProtocol: 1, requestedProtocols: 1, licensing: 'gateway-v1' },
        send: bytes => {
            if (fragment) for (let i = 0; i < bytes.length; i++) for (const frame of gate.client(bytes.subarray(i, i + 1))) peer.receive(frame);
            else for (const frame of gate.client(bytes)) peer.receive(frame);
        }, emit: event => events.push(event) });
    t.after(async () => { gate.close(); session.close(); peer.close(); await store.close(); });
    session.start();
    return { gate, peer, session, store, statuses, events, forwarded, peerState, get failure() { return failure; } };
}

test('Gateway licensing learns server MCS IDs and releases coalesced activation only after persistence', async t => {
    let commit;
    const store = new MemoryLicenseStore(undefined, () => new Promise(resolve => { commit = resolve; }));
    const p = pair(t, { store });
    await until(() => commit !== undefined);
    assert.equal(p.session.state, 'licensing'); assert.equal(p.gate.complete, false); assert.equal(store.records.size, 0);
    assert.ok(p.gate.busy && p.gate.queuedBytes > 0);
    commit(); await until(() => p.session.state === 'active');
    assert.equal(store.records.size, 1);
    assert.deepEqual(p.peerState.requests, [0x13, 0x15]);
    assert.deepEqual(p.statuses.map(v => v.status), ['requesting-license', 'challenge-verified', 'license-issued']);
    assert.equal(p.gate.engine, null);
    assert.ok(p.forwarded.every(packet => !Buffer.from(packet).includes(Buffer.from(key.certificate))));
});
test('Gateway licensing reassembles one-byte TCP and browser fragments including the coalesced tail', async t => {
    const p = pair(t, { fragment: true }); await until(() => p.session.state === 'active');
    assert.equal(p.gate.closed, false); assert.equal(p.gate.queuedBytes, 0); assert.equal(p.gate.serverFramer.queue.length, 0);
    assert.equal(p.store.records.size, 1); assert.equal(p.failure, undefined);
});
for (const mode of ['cached', 'upgrade']) test(`Gateway licensing ${mode} authenticates the cached HWID and opaque CAL`, async t => {
    const store = new MemoryLicenseStore();
    await store.save(namespace, { ...F.product, data: Uint8Array.of(31, 41, 59, 26) });
    const p = pair(t, { store, mode }); await until(() => p.session.state === 'active');
    assert.equal(p.peerState.requests[0], 0x12);
    assert.deepEqual(p.peerState.hwid, store.hardwareId());
    assert.equal(p.statuses.at(-1).status, mode === 'cached' ? 'valid-client' : 'license-upgraded');
});
for (const [mode, code] of [['bad-challenge', 'LICENSE_MAC'], ['bad-license', 'LICENSE_MAC'], ['deny', 'LICENSE_DENIED'], ['premature', 'LICENSE_INCOMPLETE']]) {
    test(`Gateway licensing rejects ${mode} without completing or storing a CAL`, async t => {
        const p = pair(t, { mode }); await until(() => p.failure);
        assert.equal(p.failure.code, code); assert.equal(p.session.state, 'failed'); assert.equal(p.store.records.size, 0);
        assert.ok(!p.statuses.some(v => v.complete)); assert.equal(p.gate.closed, true);
    });
}
test('Gateway licensing store failure prevents success and coalesced desktop activation', async t => {
    const store = new MemoryLicenseStore(undefined, async () => { throw new Error('disk unavailable'); });
    const p = pair(t, { store }); await until(() => p.failure);
    assert.match(p.failure.message, /disk unavailable/); assert.equal(p.session.state, 'failed'); assert.equal(store.records.size, 0);
});
test('Gateway close during a stalled save releases its result, queue and completion notification', async t => {
    let commit;
    const p = pair(t, { store: new MemoryLicenseStore(undefined, () => new Promise(resolve => { commit = resolve; })) });
    await until(() => commit !== undefined);
    p.gate.close(); await until(() => !p.gate.busy);
    assert.equal(p.gate.queuedBytes, 0); assert.ok(!p.statuses.some(v => v.complete));
    commit(); await sleep(2); assert.ok(!p.statuses.some(v => v.complete));
});
test('Gateway rejects browser-originated licensing packets even after activation', async t => {
    const p = pair(t); await until(() => p.session.state === 'active');
    const packet = sendData(p.peer.userId, p.peer.ioChannel, new Writer().u32le(0x80).put(F.status()).finish());
    assert.throws(() => p.gate.client(packet), { code: 'LICENSE_CLIENT_INJECTION' });
});
test('Gateway has an independent deadline and clears partial credential frames on close', async t => {
    const failures = [], gate = new GatewayLicensing({ requestedProtocols: 1, timeoutMs: 10,
        store: new MemoryLicenseStore(), namespace, username: 'User', write: () => {}, forward: () => {}, notify: () => {},
        pause: () => {}, resume: () => {}, fail: error => failures.push(error) });
    const store = gate.store; t.after(() => store.close());
    gate.client(Uint8Array.of(3, 0, 1)); const owned = gate.clientFramer.queue.chunks[0];
    await until(() => failures.length > 0);
    assert.equal(failures[0].code, 'LICENSE_TIMEOUT'); assert.equal(gate.closed, true); assert.ok(owned.every(v => v === 0));
    await sleep(15); assert.equal(failures.length, 1);
});
test('Direct and gateway sessions reject premature, duplicate and wrong-plane completion', () => {
    const direct = new Session({ send: () => {} }); direct.state = 'licensing';
    assert.throws(() => direct.share(1, 1002, new Uint8Array()), { code: 'LICENSE_INCOMPLETE' });
    assert.throws(() => direct.licensingResult({ complete: true, status: 'valid-client' }), { code: 'LICENSE_STATE' });
    direct.license(F.status()); assert.equal(direct.licensingComplete, true);
    assert.throws(() => direct.license(F.status()), { code: 'LICENSE_STATE' }); direct.close();
    const gateway = new Session({ send: () => {}, options: { licensing: 'gateway-v1' } });
    assert.throws(() => gateway.licensingResult({ complete: true, status: 'valid-client' }), { code: 'LICENSE_STATE' });
    gateway.state = 'licensing';
    assert.throws(() => gateway.license(F.status()), { code: 'LICENSE_STATE' });
    assert.throws(() => gateway.licensingResult({ complete: true, status: 'requesting-license' }), { code: 'LICENSE_RESULT' });
    assert.throws(() => gateway.licensingResult({ complete: 1, status: 'valid-client' }), { code: 'LICENSE_RESULT' });
    gateway.close();
});

test('Rejected licensing frames are wiped even when inspection or enqueueing throws', async t => {
    const p = pair(t); await until(() => p.session.state === 'active');
    const client = Uint8Array.of(0, 2);
    assert.throws(() => p.gate.clientFramer.onFrame(client, 'fastpath'), { code: 'LICENSE_CLIENT_FRAME' });
    assert.ok(client.every(value => value === 0));
    const inspect = p.gate.inspectClient;
    let observed;
    p.gate.inspectClient = packet => { observed = packet; throw new Error('injected inspection failure'); };
    const packet = sendData(p.peer.userId, p.peer.ioChannel, new Writer().u32le(0x80).put(F.status()).finish());
    assert.throws(() => p.gate.client(packet), /injected inspection failure/);
    assert.ok(observed.every(value => value === 0)); assert.ok(packet.some(value => value !== 0));
    p.gate.inspectClient = inspect;
    const server = Uint8Array.of(3, 0, 0, 7, 2, 0xf0, 0x80);
    p.gate.queuedBytes = 1024 * 1024;
    assert.throws(() => p.gate.serverFramer.onFrame(server, 'tpkt'), { code: 'LICENSE_QUEUE' });
    assert.ok(server.every(value => value === 0));
});
test('Failed licensing drains close before any transport resume', async t => {
    const p = pair(t, { mode: 'bad-license' });
    const phases = [];
    p.gate.resume = () => phases.push(p.gate.phase);
    await until(() => p.failure);
    const resumeCount = phases.length;
    await sleep(5);
    assert.equal(p.gate.closed, true); assert.equal(p.gate.busy, false);
    assert.equal(phases.length, resumeCount);
    assert.ok(!phases.includes('closed'));
});

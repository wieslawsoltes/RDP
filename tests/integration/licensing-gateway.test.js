import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBridge } from '../../apps/bridge/server.js';
import { MemoryLicenseStore, openLicenseStore, licenseNamespace, MAX_CACHED_LICENSE } from '../../apps/gateway/LicenseStore.js';
import { Session } from '../../packages/protocol/Session.js';
import { WireSendQueue } from '../../packages/protocol/WireSendQueue.js';
import { configureLicensingPeer } from '../fixtures/LicensingPeer.js';
import { makeCertificate, serveRdp } from '../fixtures/NetworkServer.js';
import { websocketClient } from '../fixtures/WebSocketClient.js';
import { product } from '../fixtures/Licensing.js';

const token = 'licensing-gateway-fixture-0123456789abcdef', origin = 'https://wieslawsoltes.github.io';
const credentials = { username: 'User', domain: 'LAB', password: 'Password' };
async function fixture(t, options = {}) {
    const cert = await makeCertificate();
    const states = [];
    const remote = await serveRdp(cert, { nla: options.nla ?? true, configurePeer: peer => {
        states.push(configureLicensingPeer(peer, { ...options, mode: states.length ? (options.secondMode || options.mode) : options.mode }));
    } });
    const target = { id: 'fixture', name: 'Licensing fixture', host: '127.0.0.1', port: remote.port,
        serverName: 'localhost', ca: cert.cert, allowTlsOnly: true };
    const bridges = [], clients = [];
    t.after(async () => {
        for (const client of clients) client.close();
        await Promise.all(bridges.map(bridge => bridge.close()));
        await remote.close(); await cert.close();
    });
    const create = async store => {
        const bridge = await createBridge({ port: 0, token, allowedOrigins: [origin],
            licenseStore: store, targets: new Map([['fixture', target]]) });
        bridges.push(bridge); return bridge;
    };
    async function connect(bridge, { split = false } = {}) {
        const ws = await websocketClient(bridge.origin, origin);
        let session, queue;
        const events = [], controls = [], wire = [], errors = [];
        const client = { close() { queue?.close(); session?.close(); ws.socket.destroy(); } }; clients.push(client);
        ws.send({ type: 'connect', token, targetId: 'fixture', inputFlowControl: true,
            security: options.nla === false ? 'tls' : 'nla', ...credentials });
        let ready;
        do { ready = await ws.receive(); assert.notEqual(ready.type, 'error', ready.message); } while (ready.type !== 'ready');
        assert.equal(ready.licensing, 'gateway-v1');
        queue = new WireSendQueue({ send: b => {
            if (split) for (let offset = 0; offset < b.length; offset += 7) ws.send(b.subarray(offset, offset + 7));
            else ws.send(b);
        }, bufferedAmount: () => ws.socket.writableLength, window: ready.inputWindow, onError: error => errors.push(error) });
        session = new Session({ options: { ...ready }, send: b => queue.enqueue(b), emit: e => events.push(e) });
        session.start();
        return Object.assign(client, { ws, session, events, controls, wire, async untilTerminal() {
            while (!['active', 'failed', 'closed'].includes(session.state)) {
                const value = await ws.receive();
                if (value instanceof Uint8Array) {
                    wire.push(value.slice()); session.receive(value); ws.send({ type: 'ack', bytes: value.length });
                } else {
                    controls.push(value);
                    if (value.type === 'licensing') session.licensingResult(value);
                    else if (value.type === 'input-ack') queue.acknowledge(value.bytes);
                    else if (value.type === 'error') return value;
                }
                assert.equal(errors.length, 0);
            }
            return null;
        } });
    }
    return { target, states, remote, create, connect };
}

for (const nla of [false, true]) {
    test(`Actual ${nla ? 'CredSSP/NTLMv2' : 'TLS-only'} gateway issues then reuses a CAL across encrypted-store reopen`, { timeout: 15000 }, async t => {
        const directory = await mkdtemp(join(tmpdir(), 'rdp-network-cal-'));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const data = Uint8Array.from({ length: MAX_CACHED_LICENSE }, (_, i) => (i * 17 + 53) & 255);
        const f = await fixture(t, { nla, data, mode: 'issue', secondMode: 'cached' });
        let store = await openLicenseStore(directory); t.after(() => store.close());
        const identity = store.hardwareId(), bridge = await f.create(store), first = await f.connect(bridge, { split: true });
        assert.equal(await first.untilTerminal(), null); assert.equal(first.session.state, 'active');
        assert.deepEqual(first.controls.filter(c => c.type === 'licensing').map(c => c.status),
            ['requesting-license', 'challenge-verified', 'license-issued']);
        assert.deepEqual(f.states[0].requests, [0x13, 0x15]);
        assert.equal(store.records.size, 1);
        assert.ok(first.controls.filter(c => c.type === 'licensing').every(c => Object.keys(c).sort().join() === 'complete,status,type'));
        const browserWire = Buffer.concat(first.wire), onDisk = await readFile(join(directory, 'licenses.bin'));
        assert.equal(browserWire.includes(data.subarray(0, 128)), false);
        assert.equal(onDisk.includes(data.subarray(0, 128)), false);
        first.close(); await bridge.close(); await store.close();
        store = await openLicenseStore(directory);
        assert.deepEqual(store.hardwareId(), identity);
        const again = await f.connect(await f.create(store));
        assert.equal(await again.untilTerminal(), null); assert.equal(again.session.state, 'active');
        assert.deepEqual(f.states[1].requests, [0x12]);
        assert.deepEqual(again.controls.filter(c => c.type === 'licensing').map(c => c.status), ['cached-license', 'valid-client']);
        assert.deepEqual(f.states[1].hwid, identity);
        assert.equal(f.remote.errors.length, 0);
        if (nla) assert.equal(f.remote.credentialRecords.filter(c => c.passwordVerified).length, 2);
    });
}

test('Actual authenticated gateway accepts an upgraded opaque license, never forwarding license PDUs to the browser', { timeout: 15000 }, async t => {
    const f = await fixture(t, { mode: 'issue', secondMode: 'upgrade' });
    const store = new MemoryLicenseStore(); t.after(() => store.close());
    const bridge = await f.create(store);
    const first = await f.connect(bridge); assert.equal(await first.untilTerminal(), null); first.close();
    const second = await f.connect(bridge); assert.equal(await second.untilTerminal(), null);
    assert.deepEqual(second.controls.filter(c => c.type === 'licensing').map(c => c.status),
        ['cached-license', 'challenge-verified', 'license-upgraded']);
    assert.equal(store.records.size, 1); assert.equal(second.session.state, 'active');
    assert.equal(f.remote.errors.length, 0);
});

for (const [mode, code] of [['bad-challenge', 'LICENSE_MAC'], ['bad-license', 'LICENSE_MAC'], ['deny', 'LICENSE_DENIED'], ['premature', 'LICENSE_INCOMPLETE']]) {
    test(`Actual TLS/NLA gateway rejects ${mode} before browser activation or cache mutation`, { timeout: 15000 }, async t => {
        const f = await fixture(t, { mode });
        const store = new MemoryLicenseStore(); t.after(() => store.close());
        const client = await f.connect(await f.create(store));
        const error = await client.untilTerminal(); assert.equal(error?.type, 'error'); assert.equal(error.code, code);
        assert.equal(client.session.state, 'licensing'); assert.equal(store.records.size, 0);
        assert.equal(client.controls.some(c => c.type === 'licensing' && c.complete), false);
        assert.equal(client.events.some(e => e.type === 'state' && e.state === 'active'), false);
        assert.equal(f.remote.errors.length, 0);
    });
}

test('Actual TLS/NLA gateway propagates cache persistence failure, not success', { timeout: 15000 }, async t => {
    const f = await fixture(t);
    const store = new MemoryLicenseStore(undefined, async () => { throw new Error('fixture cache unavailable'); }); t.after(() => store.close());
    const client = await f.connect(await f.create(store));
    const error = await client.untilTerminal(); assert.match(error.message, /cache unavailable/);
    assert.equal(client.session.state, 'licensing'); assert.equal(store.records.size, 0);
    assert.equal(client.controls.some(c => c.type === 'licensing' && c.complete), false);
});

test('Actual WebSocket gateway rejects browser-injected licensing completion controls', { timeout: 15000 }, async t => {
    const f = await fixture(t);
    const store = new MemoryLicenseStore(); t.after(() => store.close());
    const client = await f.connect(await f.create(store)); assert.equal(await client.untilTerminal(), null);
    client.ws.send({ type: 'licensing', status: 'valid-client', complete: true, publicKey: 'browser-key' });
    let control;
    do { control = await client.ws.receive(); } while (control.type !== 'error');
    assert.match(control.message, /Unknown bridge control/);
});

test('Actual TLS/NLA licensing ignores cache records for another user or destination', { timeout: 15000 }, async t => {
    const f = await fixture(t), store = new MemoryLicenseStore(); t.after(() => store.close());
    await store.save(licenseNamespace(f.target, { ...credentials, username: 'Other' }), { ...product, data: Uint8Array.of(2, 7, 1, 8) });
    await store.save(licenseNamespace({ ...f.target, port: f.target.port + 1 }, credentials), { ...product, data: Uint8Array.of(2, 7, 1, 8) });
    const client = await f.connect(await f.create(store)); assert.equal(await client.untilTerminal(), null);
    assert.deepEqual(f.states[0].requests, [0x13, 0x15]); assert.equal(store.records.size, 3);
});

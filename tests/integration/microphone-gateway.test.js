import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../../apps/bridge/server.js';
import { Session } from '../../packages/protocol/Session.js';
import { WireSendQueue } from '../../packages/protocol/WireSendQueue.js';
import { LoopbackServer } from '../../packages/lab/LoopbackServer.js';
import { configureMicrophonePeer } from '../fixtures/MicrophonePeer.js';
import { makeCertificate, serveRdp } from '../fixtures/NetworkServer.js';
import { websocketClient } from '../fixtures/WebSocketClient.js';
import { Writer } from '../../packages/binary/Writer.js';
const turns = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };
const captured = (id, captureId, rate = 48000, frames = 480) => ({ requestId: id, captureId, sampleRate: rate,
    planes: [new Float32Array(frames).fill(0.5), new Float32Array(frames).fill(-0.5)] });

test('Microphone is off by default; AUDIO_INPUT is explicitly offered even without resize', async () => {
    for (const microphone of [false, true]) {
        let session; const events = [];
        const peer = new LoopbackServer({ send: b => queueMicrotask(() => session.receive(b)) });
        const state = configureMicrophonePeer(peer);
        session = new Session({ options: { selectedProtocol: 1, requestedProtocols: 1, resize: false, microphone },
            send: b => queueMicrotask(() => peer.receive(b)), emit: e => events.push(e) });
        session.start(); await turns(); assert.equal(session.state, 'active');
        assert.equal(peer.channels.includes('drdynvc'), microphone); assert.equal(state.requested, microphone);
        assert.equal(state.openResult, null); assert.equal(state.packets.length, 0);
        if (microphone) {
            session.microphoneReady(1, 1, 0); session.microphoneData(captured(1, 1)); await turns();
            assert.equal(state.packets.length, 1); assert.ok(state.fragments > 0);
            const samples = new Int16Array(state.packets[0].data.buffer);
            assert.equal(samples[0], 16384); assert.equal(samples[1], -16384);
            session.microphoneStop(1, 1); assert.equal(session.microphoneData(captured(1, 1)), false);
            peer.closeMicrophone(); await turns(); assert.equal(session.microphone.state, 'closed');
            peer.reopenMicrophone(); await turns(); assert.equal(session.microphone.requestId, 2);
            session.microphoneReady(1, 1, 0); assert.equal(session.microphone.state, 'pending');
        }
        session.close(); peer.close();
    }
});
test('DVC rejects duplicate microphone service instances without replacing the capture owner', async () => {
    let session; const events = [];
    const peer = new LoopbackServer({ send: b => queueMicrotask(() => session.receive(b)) });
    const state = configureMicrophonePeer(peer);
    session = new Session({ options: { selectedProtocol: 1, requestedProtocols: 1, microphone: true, resize: false },
        send: b => queueMicrotask(() => peer.receive(b)), emit: e => events.push(e) });
    session.start(); await turns(); const owner = session.microphone;
    // Intercept the second CREATE reply; existing peer intentionally accepts only its own channel ID.
    const original = peer.dynamicReceive; let rejected = false;
    peer.dynamicReceive = b => { if ((b[0] >>> 4) === 1 && b[1] === 8) { rejected = new DataView(b.buffer, b.byteOffset).getUint32(2, true) !== 0; } else original(b); };
    peer.static.transmit(peer.dynamicId, new Writer().u8(0x10).u8(8).ascii('AUDIO_INPUT').u8(0).finish());
    await turns(); assert.equal(rejected, true); assert.equal(session.microphone, owner); assert.equal(session.state, 'active');
    session.close(); peer.close(); assert.equal(state.packets.length, 0);
});
test('Microphone traverses WS/TCP/TLS/NLA, DVC fragmentation, format change and server channel recreation', { timeout: 15000 }, async t => {
    const cert = await makeCertificate(); t.after(() => cert.close());
    let peer, state;
    const remote = await serveRdp(cert, { nla: true, configurePeer: p => { peer = p; state = configureMicrophonePeer(p); } }); t.after(() => remote.close());
    const token = 'microphone-gateway-test-0123456789abcdef', origin = 'https://wieslawsoltes.github.io';
    const bridge = await createBridge({ port: 0, token, allowedOrigins: [origin], targets: new Map([['fixture', {
        id: 'fixture', name: 'Microphone fixture', host: '127.0.0.1', port: remote.port, serverName: 'localhost', ca: cert.cert,
    }]]) }); t.after(() => bridge.close());
    const ws = await websocketClient(bridge.origin, origin); t.after(() => ws.socket.destroy());
    ws.send({ type: 'connect', inputFlowControl: true, token, targetId: 'fixture', security: 'nla', username: 'User', domain: 'LAB', password: 'Password' });
    let ready; do { ready = await ws.receive(); assert.notEqual(ready.type, 'error', ready.message); } while (ready.type !== 'ready');
    const events = [], errors = [];
    const queue = new WireSendQueue({ send: b => ws.send(b), bufferedAmount: () => ws.socket.writableLength,
        window: ready.inputWindow, onError: e => errors.push(e) }); t.after(() => queue.close());
    const session = new Session({ options: { ...ready, microphone: true, resize: false }, send: b => queue.enqueue(b), emit: e => events.push(e) }); t.after(() => session.close());
    async function until(predicate) {
        while (!predicate()) {
            const value = await ws.receive();
            if (value.type === 'licensing') { session.licensingResult(value); continue; }
            if (value instanceof Uint8Array) { session.receive(value); ws.send({ type: 'ack', bytes: value.length }); }
            else if (value.type === 'input-ack') queue.acknowledge(value.bytes);
            else assert.notEqual(value.type, 'error', value.message);
            assert.notEqual(session.state, 'failed', JSON.stringify(events.filter(e => e.type === 'error'))); assert.equal(errors.length, 0);
        }
    }
    session.start(); await until(() => session.microphone?.state === 'pending');
    assert.equal(state.openResult, null); assert.equal(state.packets.length, 0);
    session.microphoneReady(1, 1, 0); session.microphoneData(captured(1, 1)); await until(() => state.packets.length === 1);
    assert.equal(state.openResult, 0); assert.equal(state.packets[0].data.length, 1920);
    peer.changeMicrophoneFormat(1); await until(() => session.microphone.index === 1);
    session.microphoneData(captured(1, 1, 16000)); await until(() => state.packets.length === 2);
    assert.equal(state.packets[1].index, 1); assert.equal(state.packets[1].data.length, 960);
    assert.ok(state.packets[1].data.every(v => v === 0)); // Stereo average = 0.
    const encoder = session.microphone.encoder;
    peer.closeMicrophone(); await until(() => session.microphone.state === 'closed');
    assert.ok(encoder.packet.every(v => !v)); assert.equal(session.microphoneData(captured(1, 1)), false);
    await until(() => state.closed); peer.reopenMicrophone(); await until(() => session.microphone?.requestId === 2);
    assert.equal(session.microphoneData(captured(1, 1)), false); session.microphoneReady(2, 2, 0); session.microphoneData(captured(2, 2));
    await until(() => state.packets.length === 3); assert.equal(session.state, 'active');
    assert.equal(remote.errors.length, 0); assert.equal(remote.credentialRecords[0].passwordVerified, true);
});

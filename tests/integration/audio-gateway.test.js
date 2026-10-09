import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../../apps/bridge/server.js';
import { Session } from '../../packages/protocol/Session.js';
import { WireSendQueue } from '../../packages/protocol/WireSendQueue.js';
import { LoopbackServer } from '../../packages/lab/LoopbackServer.js';
import { configureAudioPeer } from '../fixtures/AudioPeer.js';
import { makeCertificate, serveRdp } from '../fixtures/NetworkServer.js';
import { websocketClient } from '../fixtures/WebSocketClient.js';

const turns = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
function checkSamples(events) {
    const samples = events.filter(e => e.type === 'audio' && e.kind === 'samples');
    assert.equal(samples.length, 2);
    for (const s of samples) {
        assert.equal(s.frames, 4800); assert.equal(s.sampleRate, 48000); assert.equal(s.planes.length, 2);
        assert.ok(s.planes[0].every(v => v === 0.5)); assert.ok(s.planes[1].every(v => v === -0.5));
    }
    assert.notEqual(samples[0].id, samples[1].id); return samples;
}
test('PCM opt-in negotiates through MCS; split and Wave2 samples remain unconfirmed until consumed', async t => {
    for (const audio of [false, true]) {
        let session; const events = [];
        const peer = new LoopbackServer({ send: b => queueMicrotask(() => session.receive(b)) });
        const state = configureAudioPeer(peer);
        session = new Session({ options: { selectedProtocol: 1, requestedProtocols: 1, audio },
            send: b => queueMicrotask(() => peer.receive(b)), emit: e => events.push(e) });
        session.start(); await turns(); assert.equal(session.state, 'active');
        assert.equal(peer.channels.includes('rdpsnd'), audio);
        assert.equal(state.ready, audio);
        if (audio) {
            peer.sendAudio(); await turns(); const samples = checkSamples(events);
            assert.equal(state.confirmations.length, 0);
            session.consumeAudio(samples[0].id, 'played'); session.consumeAudio(samples[1].id, 'dropped'); await turns();
            assert.deepEqual(state.confirmations.map(v => v.block), [255, 0]);
            assert.equal(session.audio.stats().played, 1); assert.equal(session.audio.stats().dropped, 1);
            assert.equal(session.audio.stats().queuedBytes, 0);
        }
        session.close(); peer.close();
    }
});
test('PCM sound survives browser WebSocket gateway, TCP TLS NLA and channel fragmentation', { timeout: 15000 }, async t => {
    const cert = await makeCertificate(); t.after(() => cert.close());
    let peer, state;
    const remote = await serveRdp(cert, { nla: true, configurePeer: p => { peer = p; state = configureAudioPeer(p); } });
    t.after(() => remote.close());
    const token = 'audio-gateway-test-0123456789abcdef', origin = 'https://wieslawsoltes.github.io';
    const bridge = await createBridge({ port: 0, token, allowedOrigins: [origin], targets: new Map([['fixture', {
        id: 'fixture', name: 'Audio fixture', host: '127.0.0.1', port: remote.port, serverName: 'localhost', ca: cert.cert,
    }]]) }); t.after(() => bridge.close());
    const ws = await websocketClient(bridge.origin, origin); t.after(() => ws.socket.destroy());
    ws.send({ type: 'connect', inputFlowControl: true, token, targetId: 'fixture', security: 'nla', username: 'User', domain: 'LAB', password: 'Password' });
    let ready; do { ready = await ws.receive(); assert.notEqual(ready.type, 'error', ready.message); } while (ready.type !== 'ready');
    const events = [], errors = [];
    const queue = new WireSendQueue({ send: b => ws.send(b), bufferedAmount: () => ws.socket.writableLength,
        window: ready.inputWindow, onError: e => errors.push(e) }); t.after(() => queue.close());
    const session = new Session({ options: { ...ready, audio: true }, send: b => queue.enqueue(b), emit: e => events.push(e) });
    t.after(() => session.close());
    async function until(predicate) {
        while (!predicate()) {
            const value = await ws.receive();
            if (value instanceof Uint8Array) { session.receive(value); ws.send({ type: 'ack', bytes: value.length }); }
            else if (value.type === 'input-ack') queue.acknowledge(value.bytes);
            else assert.notEqual(value.type, 'error', value.message);
            assert.notEqual(session.state, 'failed', JSON.stringify(events.filter(e => e.type === 'error')));
            assert.equal(errors.length, 0);
        }
    }
    session.start(); await until(() => state?.ready);
    peer.sendAudio(); await until(() => events.filter(e => e.type === 'audio' && e.kind === 'samples').length === 2);
    const samples = checkSamples(events); assert.equal(state.confirmations.length, 0);
    session.consumeAudio(samples[0].id, 'played'); session.consumeAudio(samples[1].id, 'dropped');
    await until(() => state.confirmations.length === 2);
    assert.deepEqual(state.confirmations.map(v => v.block), [255, 0]);
    assert.equal(session.audio.stats().pending, 0); assert.equal(session.state, 'active');
    assert.equal(remote.errors.length, 0); assert.equal(remote.credentialRecords[0].passwordVerified, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../../apps/bridge/server.js';
import { Session } from '../../packages/protocol/Session.js';
import { WireSendQueue } from '../../packages/protocol/WireSendQueue.js';
import { makeCertificate, serveRdp } from '../fixtures/NetworkServer.js';
import { configureRichClipboard } from '../fixtures/RichClipboardPeer.js';
import { websocketClient } from '../fixtures/WebSocketClient.js';
import { png } from '../fixtures/Clipboard.js';

test('Credit-controlled gateway exchanges >2 MiB HTML and images through real TCP TLS NLA', { timeout: 15000 }, async t => {
    const cert = await makeCertificate(); t.after(() => cert.close());
    const remote = await serveRdp(cert, { nla: true, configurePeer: configureRichClipboard }); t.after(() => remote.close());
    const token = 'rich-gateway-test-0123456789abcdef', origin = 'https://wieslawsoltes.github.io';
    const bridge = await createBridge({ port: 0, token, allowedOrigins: [origin], targets: new Map([['fixture', {
        id: 'fixture', name: 'Fixture', host: '127.0.0.1', port: remote.port, serverName: 'localhost', ca: cert.cert,
    }]]) }); t.after(() => bridge.close());
    const ws = await websocketClient(bridge.origin, origin); t.after(() => ws.socket.destroy());
    ws.send({ type: 'connect', inputFlowControl: true, token, targetId: 'fixture', security: 'nla', username: 'User', domain: 'LAB', password: 'Password' });
    let ready;
    do { ready = await ws.receive(); assert.notEqual(ready.type, 'error', ready.message); } while (ready.type !== 'ready');
    assert.equal(ready.inputWindow, 262144);
    const events = [], errors = []; let acknowledgements = 0;
    const queue = new WireSendQueue({ send: b => ws.send(b), bufferedAmount: () => ws.socket.writableLength, window: ready.inputWindow, onError: e => errors.push(e) });
    t.after(() => queue.close());
    const session = new Session({ options: { ...ready, richClipboard: true }, send: b => queue.enqueue(b), emit: e => events.push(e) });
    t.after(() => session.close());
    async function until(predicate) {
        while (!predicate()) {
            const value = await ws.receive();
            if (value.type === 'licensing') { session.licensingResult(value); continue; }
            if (value instanceof Uint8Array) { session.receive(value); ws.send({ type: 'ack', bytes: value.length }); }
            else if (value.type === 'input-ack') { queue.acknowledge(value.bytes); acknowledgements++; }
            else assert.notEqual(value.type, 'error', value.message);
            assert.notEqual(session.state, 'failed', JSON.stringify(events.filter(e => e.type === 'error')));
            assert.equal(errors.length, 0, String(errors[0]));
        }
    }
    session.start(); await until(() => events.some(e => e.kind === 'text'));
    const html = '<em>Zażółć 🙂</em>'.repeat(110000);
    session.setClipboardContent({ text: 'large', html });
    await until(() => events.some(e => e.kind === 'text' && e.text === 'large'));
    session.requestClipboardFormat('html'); await until(() => events.some(e => e.kind === 'html'));
    assert.equal(events.find(e => e.kind === 'html').html, html);
    const image = { width: 1, height: 1, rgba: Uint8Array.of(255, 0, 0, 255) };
    session.setClipboardContent({ text: 'image', png: png(), image });
    await until(() => events.some(e => e.kind === 'text' && e.text === 'image'));
    session.requestClipboardFormat('image'); await until(() => events.some(e => e.kind === 'image'));
    assert.deepEqual(events.find(e => e.kind === 'image').bytes, png());
    assert.ok(acknowledgements > 16); assert.equal(session.state, 'active');
    assert.equal(remote.errors.length, 0); assert.equal(remote.credentialRecords[0].passwordVerified, true);
});

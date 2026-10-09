import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../../apps/bridge/server.js';
import { Session } from '../../packages/protocol/Session.js';
import { WireSendQueue } from '../../packages/protocol/WireSendQueue.js';
import { configureGdiPeer, expectedScene } from '../fixtures/GdiPeer.js';
import { makeCertificate, serveRdp } from '../fixtures/NetworkServer.js';
import { websocketClient } from '../fixtures/WebSocketClient.js';

test('GDI order/cache scene crosses actual WebSocket/TCP/TLS/CredSSP and matches every expected pixel', { timeout: 15000 }, async t => {
    const cert = await makeCertificate(); t.after(() => cert.close());
    let peer;
    const remote = await serveRdp(cert, { nla: true, configurePeer: p => { peer = p; configureGdiPeer(p, { revision: 2, paintOnActive: true }); } }); t.after(() => remote.close());
    const token = 'gdi-gateway-test-0123456789abcdef', origin = 'https://wieslawsoltes.github.io';
    const bridge = await createBridge({ port: 0, token, allowedOrigins: [origin], targets: new Map([['fixture', {
        id: 'fixture', name: 'GDI fixture', host: '127.0.0.1', port: remote.port, serverName: 'localhost', ca: cert.cert,
    }]]) }); t.after(() => bridge.close());
    const ws = await websocketClient(bridge.origin, origin); t.after(() => ws.socket.destroy());
    ws.send({ type: 'connect', inputFlowControl: true, token, targetId: 'fixture', security: 'nla', username: 'User', domain: 'LAB', password: 'Password' });
    let ready; do { ready = await ws.receive(); assert.notEqual(ready.type, 'error', ready.message); } while (ready.type !== 'ready');
    const events = [], errors = [], drawn = new Uint32Array(200 * 200);
    const queue = new WireSendQueue({ send: b => ws.send(b), bufferedAmount: () => ws.socket.writableLength,
        window: ready.inputWindow, onError: e => errors.push(e) }); t.after(() => queue.close());
    const session = new Session({ options: { ...ready, width: 200, height: 200, orders: true, resize: false, clipboard: false }, send: b => queue.enqueue(b), emit: e => {
        events.push(e);
        if (e.type === 'bitmaps') for (const b of e.rectangles) {
            // Independent consumption of the shared renderer descriptor ABI.
            assert.ok([24,32].includes(b.bpp)); const step = b.bpp / 8;
            for (let y = 0; y < b.drawHeight; y++) for (let x = 0; x < b.drawWidth; x++) {
                const o = (b.bottomUp ? b.height - 1 - y : y) * b.stride + x * step;
                drawn[(b.y + y) * 200 + b.x + x] = b.data[o+2] << 16 | b.data[o+1] << 8 | b.data[o];
            }
            // Exercise transfer ownership while the server still has later orders queued.
            structuredClone(b, { transfer: [b.data.buffer] });
        }
    } }); t.after(() => session.close());
    session.start();
    while (drawn[19 * 200 + 31] !== 0xf012ab) {
        const value = await ws.receive();
        if (value.type === 'licensing') session.licensingResult(value);
        else if (value instanceof Uint8Array) { session.receive(value); ws.send({ type: 'ack', bytes: value.length }); }
        else if (value.type === 'input-ack') queue.acknowledge(value.bytes);
        else assert.notEqual(value.type, 'error', value.message);
        assert.notEqual(session.state, 'failed', JSON.stringify(events.filter(e => e.type === 'error'))); assert.equal(errors.length, 0);
    }
    assert.equal(session.state, 'active'); assert.equal(session.gdi.revision, 2);
    const expected = expectedScene();
    for (let y = 0; y < 20; y++) assert.deepEqual(drawn.slice(y * 200, y * 200 + 32), expected.subarray(y * 32, y * 32 + 32));
    assert.equal(remote.errors.length, 0); assert.equal(remote.credentialRecords[0].passwordVerified, true);
    assert.equal(peer.state, 'active');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge } from '../../apps/bridge/server.js';
import { Session } from '../../packages/protocol/Session.js';
import { makeCertificate, serveRdp } from '../fixtures/NetworkServer.js';
import { websocketClient } from '../fixtures/WebSocketClient.js';
const token = 'gateway-test-token-0123456789abcdef', origin = 'https://wieslawsoltes.github.io';

test('Gateway CORS is exact, token-protected and handles explicit local-network preflight', async t => {
    const bridge = await createBridge({ port: 0, token, allowedOrigins: [origin] });
    t.after(() => bridge.close());
    const url = bridge.origin + '/api/targets';
    let res = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization', 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
    res = await fetch(url, { headers: { Origin: origin } });
    assert.equal(res.status, 401);
    res = await fetch(url, { headers: { Origin: origin, Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    for (const denied of ['null', origin + '.evil.test', 'https://other.github.io']) {
        res = await fetch(url, { headers: { Origin: denied, Authorization: `Bearer ${token}` } });
        assert.equal(res.status, 403);
        assert.equal(res.headers.get('access-control-allow-origin'), null);
    }
    res = await fetch(url, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
    assert.equal(res.status, 403);
    const status = await new Promise((resolve, reject) => {
        http.get(url, { headers: { Host: 'rebinding.invalid', Authorization: `Bearer ${token}` } }, response => {
            response.resume(); resolve(response.statusCode);
        }).on('error', reject);
    });
    assert.equal(status, 403);
    const health = await (await fetch(bridge.origin + '/api/health', { headers: { Origin: origin } })).json();
    assert.equal(health.gatewayProtocol, 1);
    assert.ok(!JSON.stringify(health).includes(token));
});

for (const nla of [false, true]) test(`Pages-origin WebSocket → gateway → TCP/TLS${nla ? '/NLA' : ''} → RDP activation`, { timeout: 15000 }, async t => {
    const cert = await makeCertificate(); t.after(() => cert.close());
    const remote = await serveRdp(cert, { nla }); t.after(() => remote.close());
    const targets = new Map([['desktop', { id: 'desktop', name: 'Desktop', host: '127.0.0.1', port: remote.port, serverName: 'localhost', ca: cert.cert, allowTlsOnly: true }]]);
    const bridge = await createBridge({ port: 0, token, targets, allowedOrigins: [origin] }); t.after(() => bridge.close());
    const ws = await websocketClient(bridge.origin, origin); t.after(() => ws.socket.destroy());
    assert.match(ws.headers, /101 Switching/);
    ws.send({ type: 'connect', token, targetId: 'desktop', security: nla ? 'nla' : 'tls', username: 'User', domain: 'LAB', password: 'Password' });
    let ready;
    do { ready = await ws.receive(); assert.notEqual(ready.type, 'error', ready.message); } while (ready.type !== 'ready');
    const session = new Session({ options: { ...ready, username: 'User', domain: 'LAB', password: nla ? '' : 'Password' }, send: b => ws.send(b), emit: () => {} });
    t.after(() => session.close());
    session.start();
    while (session.state !== 'active') {
        const value = await ws.receive();
        assert.ok(value instanceof Uint8Array, JSON.stringify(value));
        session.receive(value);
        ws.send({ type: 'ack', bytes: value.length });
    }
    assert.equal(session.state, 'active');
    assert.equal(remote.errors.length, 0);
    if (nla) assert.equal(remote.credentialRecords[0].passwordVerified, true);
    ws.send({ type: 'ping', id: 13 });
    let pong;
    do { pong = await ws.receive(); if (pong instanceof Uint8Array) { session.receive(pong); ws.send({ type: 'ack', bytes: pong.length }); } } while (pong.type !== 'pong');
    assert.equal(pong.id, 13);
    ws.send({ type: 'disconnect' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createBridge } from '../../apps/bridge/server.js';
import { SocketReader } from '../../packages/transport/SocketReader.js';
import { Writer, concat } from '../../packages/binary/Writer.js';
const token = 'integration-token-0123456789abcdef';
async function websocket(origin, sentOrigin = origin) {
    const url = new URL(origin), socket = net.connect({ host: url.hostname, port: url.port });
    socket.on('error', () => { });
    await once(socket, 'connect');
    const reader = new SocketReader(socket);
    socket.write(`GET /bridge HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${sentOrigin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    let headers = '';
    while (!headers.endsWith('\r\n\r\n') && headers.length < 8192)
        headers += String.fromCharCode((await reader.read(1))[0]);
    return { socket, reader, headers, send(value) {
            const bytes = new TextEncoder().encode(JSON.stringify(value)), key = [1, 2, 3, 4], w = new Writer().u8(0x81);
            if (bytes.length < 126)
                w.u8(bytes.length | 128);
            else
                w.u8(254).u16be(bytes.length);
            socket.write(concat(w.put(Uint8Array.from(key)).finish(), bytes.map((b, i) => b ^ key[i & 3])));
        }, async message() {
            const header = await reader.read(2);
            let length = header[1] & 127;
            if (length === 126) {
                const size = await reader.read(2);
                length = size[0] * 256 + size[1];
            }
            return JSON.parse(new TextDecoder().decode(await reader.read(length)));
        } };
}
test('Bridge serves GUI with CSP; target inventory needs token and private files stay private', async (t) => {
    const bridge = await createBridge({ port: 0, token, targets: new Map([['test', { id: 'test', name: 'Test host', host: 'private.internal', port: 3389, allowTlsOnly: false, ca: 'DO_NOT_EXPOSE' }]]) });
    t.after(() => bridge.close());
    const home = await fetch(bridge.origin);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-security-policy'), /script-src 'self'/);
    assert.match(await home.text(), /Remote workspace/);
    assert.equal((await fetch(`${bridge.origin}/api/targets`)).status, 401);
    const targets = await (await fetch(`${bridge.origin}/api/targets`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(targets.targets[0].id, 'test');
    assert.ok(!JSON.stringify(targets).includes('DO_NOT_EXPOSE'));
    assert.ok(!JSON.stringify(targets).includes('private.internal'));
    for (const path of ['/targets.json', '/.git/config', '/apps/bridge/server.js', '/packages/../targets.json', '/packages/%2e%2e%2f/targets.json'])
        assert.equal((await fetch(bridge.origin + path)).status, 404);
});
test('Bridge rejects WebSocket cross-origin requests and invalid access tokens', { timeout: 10000 }, async (t) => {
    const bridge = await createBridge({ port: 0, token });
    t.after(() => bridge.close());
    const denied = await websocket(bridge.origin, 'https://attacker.invalid');
    assert.match(denied.headers, /403 Forbidden/);
    denied.socket.destroy();
    const accepted = await websocket(bridge.origin);
    t.after(() => accepted.socket.destroy());
    assert.match(accepted.headers, /101 Switching/);
    accepted.send({ type: 'connect', token: 'bad-token-0123456789abcdef', targetId: 'test', security: 'nla', username: '', domain: '', password: '' });
    assert.equal((await accepted.message()).code, 'AUTHENTICATION');
});
test('Bridge denies arbitrary hosts absent from its target allowlist', { timeout: 10000 }, async (t) => {
    const bridge = await createBridge({ port: 0, token });
    t.after(() => bridge.close());
    const ws = await websocket(bridge.origin);
    t.after(() => ws.socket.destroy());
    ws.send({ type: 'connect', token, targetId: '169.254.169.254', security: 'nla', username: 'test', domain: '', password: 'test' });
    assert.equal((await ws.message()).code, 'TARGET_DENIED');
});
test('Non-loopback HTTP and HTTPS without explicit origin are prohibited', async () => {
    await assert.rejects(createBridge({ host: '0.0.0.0' }), /HTTPS/);
    await assert.rejects(createBridge({ tlsOptions: {} }), /PUBLIC_ORIGIN/);
});

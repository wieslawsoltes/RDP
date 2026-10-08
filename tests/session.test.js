import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../packages/protocol/Session.js';
import { LoopbackServer } from '../packages/lab/LoopbackServer.js';
const tick = async () => {
    for (let i = 0; i < 20; i++)
        await new Promise(resolve => setImmediate(resolve));
};
function pair() {
    const events = [], inputs = [];
    let client;
    let clipboard;
    const server = new LoopbackServer({ send: bytes => queueMicrotask(() => client.receive(bytes)), onInput: data => inputs.push(...data), onClipboard: text => { clipboard = text; } });
    client = new Session({ options: { selectedProtocol: 1, requestedProtocols: 1, width: 640, height: 400 }, send: bytes => queueMicrotask(() => server.receive(bytes)), emit: event => events.push(event) });
    return { client, server, events, inputs, get clipboard() { return clipboard; } };
}
test('Loopback: MCS, joins, licensing, activation, keyboard and pointer input', async () => {
    const p = pair();
    p.client.start();
    await tick();
    assert.equal(p.client.state, 'active', JSON.stringify(p.events.filter(e => e.type === 'error')));
    assert.deepEqual(p.client.desktop, { width: 640, height: 400 });
    p.client.input([{ type: 'key', code: 0x1e, down: true }, { type: 'mouse', flags: 0x800, x: 120, y: 80 }]);
    p.client.text('Zażółć 😀');
    await tick();
    assert.ok(p.inputs.some(e => e.type === 4 && e.a === 0x1e));
    assert.ok(p.inputs.some(e => e.type === 0x8001 && e.a === 120 && e.b === 80));
    assert.ok(p.inputs.some(e => e.type === 5 && e.a === 0x17c));
    p.client.close();
    p.server.close();
});
test('Loopback: actual CLIPRDR channel exchanges Unicode in both directions', async () => {
    const p = pair();
    p.client.start();
    await tick();
    assert.equal(p.client.state, 'active');
    assert.ok(p.events.some(e => e.type === 'clipboard' && e.kind === 'text' && e.text.includes('protocol lab')));
    p.client.setClipboard('Clipboard → RDP\nZażółć');
    await tick();
    assert.equal(p.clipboard, 'Clipboard → RDP\nZażółć');
    p.client.close();
    p.server.close();
});
test('Loopback: display-control resize triggers deactivation and reactivation', async () => {
    const p = pair();
    p.client.start();
    await tick();
    assert.ok(p.events.some(e => e.type === 'display' && e.kind === 'ready'));
    p.client.resize(800, 600, 125);
    await tick();
    assert.equal(p.client.state, 'active', JSON.stringify(p.events.filter(e => e.type === 'error')));
    assert.deepEqual(p.client.desktop, { width: 800, height: 600 });
    assert.ok(p.events.some(e => e.type === 'state' && e.state === 'reactivating'));
    p.client.close();
    p.server.close();
});
test('Loopback: bitmap pixels pass through wire framing and decoding', async () => {
    const p = pair();
    p.client.start();
    await tick();
    const rgba = new Uint8Array(4 * 3 * 4);
    for (let i = 0; i < rgba.length; i += 4)
        rgba.set([12, 34, 56, 255], i);
    p.server.bitmap(12, 10, 4, 3, rgba);
    await tick();
    const event = p.events.find(e => e.type === 'bitmaps');
    assert.ok(event);
    const rect = event.rectangles[0];
    assert.equal(rect.x, 12);
    assert.deepEqual([...rect.data.slice(0, 3)], [56, 34, 12]);
    p.client.close();
    p.server.close();
});

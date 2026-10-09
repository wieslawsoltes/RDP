import test from 'node:test';
import assert from 'node:assert/strict';
import { WireSendQueue } from '../packages/protocol/WireSendQueue.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';

test('Outbound queue owns packets and obeys gateway credits in order', t => {
    const sent = [], queue = new WireSendQueue({ send: b => sent.push(b.slice()), window: 65536, onError: e => assert.fail(e.message) });
    t.after(() => queue.close());
    const b = new Uint8Array(32768).fill(1);
    queue.enqueue(b); b.fill(2); queue.enqueue(b); b.fill(3); queue.enqueue(b); b.fill(0);
    assert.equal(sent.length, 2); assert.equal(queue.bytes, 32768); assert.equal(queue.outstanding, 65536);
    queue.acknowledge(32768); assert.equal(sent.length, 3);
    assert.deepEqual(sent.map(b => b[0]), [1, 2, 3]); assert.equal(queue.bytes, 0);
    queue.acknowledge(65536); assert.equal(queue.outstanding, 0);
});
test('Outbound queue bounds native WebSocket backlog and legacy gateway bursts', async t => {
    let backlog = 262144; const sent = [];
    const queue = new WireSendQueue({ send: b => sent.push(b.slice()), bufferedAmount: () => backlog });
    t.after(() => queue.close());
    for (let i = 0; i < 20; i++) queue.enqueue(new Uint8Array(65536).fill(i));
    assert.equal(sent.length, 0);
    backlog = 0; queue.flush(); assert.equal(sent.length, 4);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(sent.length, 20); assert.deepEqual(sent.map(b => b[0]), Array.from({ length: 20 }, (_, i) => i));
});
test('Outbound queue validates acknowledgements, packet lengths and allocation budgets', t => {
    const queue = new WireSendQueue({ send: () => {}, window: 65536, limit: 65536 }); t.after(() => queue.close());
    for (const n of [0, -1, 1, NaN, Infinity]) assert.throws(() => queue.acknowledge(n), ProtocolError);
    for (const b of [[], new Uint8Array(), new Uint8Array(65537)]) assert.throws(() => queue.enqueue(b), ProtocolError);
    queue.enqueue(new Uint8Array(65536)); queue.enqueue(new Uint8Array(65536));
    assert.throws(() => queue.enqueue(Uint8Array.of(1)), ProtocolError);
    assert.throws(() => queue.acknowledge(65537), ProtocolError);
});
test('Outbound queue stops and clears packets on send failure or stalled credit', async t => {
    const errors = [];
    const queue = new WireSendQueue({ send: () => { throw new Error('socket failed'); }, onError: e => errors.push(e.message) });
    queue.enqueue(Uint8Array.of(1)); assert.equal(queue.closed, true); assert.deepEqual(errors, ['socket failed']);
    const stalled = new WireSendQueue({ send: () => {}, window: 65536, timeoutMs: 5, onError: e => errors.push(e.code) });
    t.after(() => stalled.close()); stalled.enqueue(Uint8Array.of(1));
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(stalled.closed, true); assert.equal(errors.at(-1), 'WIRE_TIMEOUT');
});
test('Outbound close zeroes untransmitted packets and prevents future writes', () => {
    const queue = new WireSendQueue({ send: () => {}, bufferedAmount: () => 262144 });
    queue.enqueue(Uint8Array.of(1, 2, 3)); const held = queue.queue[0]; queue.close();
    assert.deepEqual([...held], [0, 0, 0]); assert.equal(queue.bytes, 0);
    assert.throws(() => queue.enqueue(Uint8Array.of(1)), ProtocolError);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocketPeer } from '../packages/transport/WebSocketPeer.js';
import { Writer, concat } from '../packages/binary/Writer.js';
class Socket extends EventEmitter {
    constructor() { super(); this.output = []; this.writableLength = 0; this.destroyed = false; }
    setNoDelay() { }
    write(bytes) { this.output.push(bytes); return true; }
    end() { this.emit('close'); }
    destroy() { this.destroyed = true; this.emit('close'); }
}
function mask(opcode, value, fin = true) {
    const data = typeof value === 'string' ? new TextEncoder().encode(value) : value, key = [1, 2, 3, 4];
    const header = new Writer().u8(opcode | (fin ? 128 : 0));
    if (data.length < 126)
        header.u8(128 | data.length);
    else
        header.u8(128 | 126).u16be(data.length);
    return concat(header.put(Uint8Array.from(key)).finish(), data.map((byte, i) => byte ^ key[i & 3]));
}
test('RFC6455: masked fragmentation, text, binary and interleaved ping', () => {
    const socket = new Socket(), peer = new WebSocketPeer(socket), messages = [];
    peer.on('message', (message, binary) => messages.push({ message, binary }));
    const frames = concat(mask(1, 'hello', false), mask(9, '?'), mask(0, ' world'), mask(2, Uint8Array.of(1, 2, 3)));
    for (const byte of frames)
        peer.receive(Uint8Array.of(byte));
    assert.equal(messages[0].message, 'hello world');
    assert.equal(messages[1].binary, true);
    assert.deepEqual(messages[1].message, Uint8Array.of(1, 2, 3));
    assert.equal(socket.output[0][0], 0x8a);
    peer.close();
});
for (const [name, bytes] of [
    ['unmasked client frame', Uint8Array.of(0x81, 1, 97)], ['reserved bits', Uint8Array.of(0xc1, 0x80, 1, 2, 3, 4)],
    ['orphan continuation', mask(0, 'x')], ['fragmented ping', mask(9, 'x', false)],
    ['non-canonical length', Uint8Array.of(0x81, 0xfe, 0, 1)], ['invalid UTF-8', mask(1, Uint8Array.of(0xff))],
    ['close code 1006', mask(8, Uint8Array.of(3, 238))],
])
    test(`RFC6455 rejects ${name}`, () => { const socket = new Socket(), peer = new WebSocketPeer(socket); peer.receive(bytes); assert.equal(peer.closed, true); });
test('RFC6455 limits payloads and queued socket writes', () => {
    const socket = new Socket(), peer = new WebSocketPeer(socket, { maxMessage: 16, maxBuffered: 16 });
    peer.receive(mask(2, new Uint8Array(17)));
    assert.equal(peer.closed, true);
    const second = new Socket(), bounded = new WebSocketPeer(second, { maxBuffered: 10 });
    second.writableLength = 9;
    bounded.sendBinary(new Uint8Array(2));
    assert.equal(second.destroyed, true);
});

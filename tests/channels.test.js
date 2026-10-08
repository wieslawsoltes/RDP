import test from 'node:test';
import assert from 'node:assert/strict';
import { Writer, utf16 } from '../packages/binary/Writer.js';
import { Reader } from '../packages/binary/Reader.js';
import { ClipboardChannel, clipboardPdu } from '../packages/channels/ClipboardChannel.js';
import { StaticChannels } from '../packages/channels/StaticChannels.js';
import { DynamicChannels } from '../packages/channels/DynamicChannels.js';
import { FastPath } from '../packages/protocol/FastPath.js';
test('Static channel fragmentation roundtrips across 1600-byte boundaries', () => {
    let actual;
    const receiver = new StaticChannels(() => { });
    receiver.register(1004, { receive: data => { actual = data; } });
    const sender = new StaticChannels((id, data) => receiver.receive(id, data));
    sender.register(1004, {});
    for (const size of [0, 1, 1599, 1600, 1601, 8192]) {
        const data = Uint8Array.from({ length: size }, (_, i) => i & 255);
        sender.transmit(1004, data);
        assert.deepEqual(actual, data);
    }
});
test('Static channel rejects overlapping, truncated and compressed sequences', () => {
    const receiver = new StaticChannels(() => { });
    receiver.register(1, { receive() { } });
    const fragment = (total, flags, data = []) => new Writer().u32le(total).u32le(flags).put(Uint8Array.from(data)).finish();
    assert.throws(() => receiver.receive(1, fragment(4, 2, [1, 2])));
    assert.throws(() => receiver.receive(1, fragment(1, 0x200003, [1])));
    receiver.receive(1, fragment(4, 1, [1, 2]));
    assert.throws(() => receiver.receive(1, fragment(4, 1, [1, 2])));
});
test('Clipboard generation changes discard stale text before the next response', () => {
    const outgoing = [], events = [], channel = new ClipboardChannel(bytes => outgoing.push(bytes), (kind, data) => events.push({ kind, ...data }));
    channel.receive(clipboardPdu(7, 0, new Writer().u16le(1).u16le(0).u16le(1).u16le(12).u32le(2).u32le(2).finish()));
    channel.receive(clipboardPdu(1));
    const formats = clipboardPdu(2, 0, new Writer().u32le(13).u16le(0).finish());
    channel.receive(formats);
    channel.receive(formats);
    channel.receive(clipboardPdu(5, 1, utf16('stale', true)));
    assert.equal(events.some(event => event.kind === 'text'), false);
    channel.receive(clipboardPdu(5, 1, utf16('new\r\nline', true)));
    assert.equal(events.find(event => event.kind === 'text').text, 'new\nline');
    channel.close();
});
test('Clipboard checks expanded CRLF size and rejects NUL/unsolicited responses', () => {
    const channel = new ClipboardChannel(() => { }, () => { }, { limit: 10 });
    assert.throws(() => channel.setText('\n\n\n'));
    assert.throws(() => channel.setText('a\0b'));
    assert.throws(() => channel.receive(clipboardPdu(5, 1, utf16('x', true))));
    channel.close();
});
test('Dynamic channels reject unregistered services and reassemble reliable payloads', () => {
    const sent = [], received = [], dvc = new DynamicChannels(bytes => sent.push(bytes), new Map([['test', () => ({ receive: bytes => received.push(bytes) })]]));
    dvc.receive(new Writer().u8(0x50).u8(0).u16le(2).zeros(8).finish());
    dvc.receive(new Writer().u8(0x10).u8(5).ascii('test').u8(0).finish());
    dvc.receive(new Writer().u8(0x20).u8(5).u8(4).put(Uint8Array.of(1, 2)).finish());
    dvc.receive(Uint8Array.of(0x30, 5, 3, 4));
    assert.deepEqual(received[0], Uint8Array.of(1, 2, 3, 4));
    dvc.receive(new Writer().u8(0x10).u8(9).ascii('unsupported').u8(0).finish());
    const rejected = new Reader(sent.at(-1));
    rejected.skip(2);
    assert.notEqual(rejected.u32le(), 0);
    dvc.close();
});
test('Fast-path fragmentation preserves type and rejects interleaved update streams', () => {
    const updates = [], fast = new FastPath((code, data) => updates.push({ code, data }));
    const frame = (header, data) => new Writer().u8(0).u8(data.length + 5).u8(header).u16le(data.length).put(Uint8Array.from(data)).finish();
    fast.push(frame(0x21, [1, 2]));
    fast.push(frame(0x31, [3]));
    fast.push(frame(0x11, [4]));
    assert.deepEqual(updates[0], { code: 1, data: Uint8Array.of(1, 2, 3, 4) });
    fast.push(frame(0x21, [1]));
    assert.throws(() => fast.push(frame(0x12, [2])));
    fast.clear();
});

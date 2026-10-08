import test from 'node:test';
import assert from 'node:assert/strict';
import { Reader } from '../packages/binary/Reader.js';
import { Writer, concat } from '../packages/binary/Writer.js';
import { ByteQueue } from '../packages/binary/ByteQueue.js';
import { sequence, integer, readTlv, readInteger } from '../packages/binary/Asn1.js';
import { Framer } from '../packages/protocol/Framer.js';
import { dataPdu, unwrapData, connectionRequest, parseConnectionConfirm, tpkt } from '../packages/protocol/X224.js';
import { tokenMatches } from '../apps/bridge/BridgeSession.js';
test('Reader scopes DataView to a subarray and rejects overreads', () => {
    const r = new Reader(Uint8Array.of(99, 0x34, 0x12, 88).subarray(1, 3));
    assert.equal(r.u16le(), 0x1234);
    assert.throws(() => r.u8());
    assert.throws(() => new Reader(Uint8Array.of(1)).take(-1));
    assert.throws(() => new Reader(Uint8Array.of(1)).take(1.1));
});
test('Writer roundtrips endian integers, FILETIME and UTF-16', () => {
    const bytes = new Writer(1).u8(11).u16le(65535).u16be(258).u32le(0xfedcba98).u32be(0x12345678).i32le(-2026).u64le(0xfedcba9876543210n).utf16('Zażółć 😀').finish();
    const r = new Reader(bytes);
    assert.equal(r.u8(), 11);
    assert.equal(r.u16le(), 65535);
    assert.equal(r.u16be(), 258);
    assert.equal(r.u32le(), 0xfedcba98);
    assert.equal(r.u32be(), 0x12345678);
    assert.equal(r.i32le(), -2026);
    assert.equal(r.u64le(), 0xfedcba9876543210n);
    assert.equal(r.utf16(r.remaining), 'Zażółć 😀');
    r.end();
});
for (const size of [0, 1, 127, 128, 32767])
    test(`PER length boundary ${size}`, () => { const r = new Reader(new Writer().perLength(size).finish()); assert.equal(r.perLength(), size); r.end(); });
test('PER refuses out-of-range determinants', () => { assert.throws(() => new Writer().perLength(32768)); assert.throws(() => new Reader(Uint8Array.of(128)).perLength()); });
test('Chunk queue handles every split without aliasing unread bytes', () => {
    const data = Uint8Array.from({ length: 257 }, (_, i) => i & 255);
    for (let split = 0; split <= data.length; split++) {
        const q = new ByteQueue(300);
        q.push(data.subarray(0, split));
        q.push(data.subarray(split));
        assert.equal(q.peek(256), 0);
        assert.deepEqual(q.read(257), data);
        assert.equal(q.length, 0);
    }
    const q = new ByteQueue(2);
    q.push(Uint8Array.of(1));
    assert.throws(() => q.push(Uint8Array.of(2, 3)));
});
test('Framer accepts fragmented and coalesced TPKT plus fast-path PDUs', () => {
    const a = dataPdu(Uint8Array.of(1, 2, 3)), b = Uint8Array.of(0, 4, 3, 0), bytes = concat(a, b, a);
    for (let split = 0; split <= bytes.length; split++) {
        const frames = [];
        const f = new Framer((packet, kind) => frames.push({ packet, kind }));
        f.push(bytes.subarray(0, split));
        f.push(bytes.subarray(split));
        assert.equal(frames.length, 3);
        assert.equal(frames[1].kind, 'fastpath');
        assert.deepEqual(unwrapData(frames[0].packet), Uint8Array.of(1, 2, 3));
    }
});
test('Framer rejects illegal TPKT lengths and legacy encryption action', () => {
    for (const bytes of [[3, 1, 0, 7], [3, 0, 0, 2], [1, 2], [0, 1]])
        assert.throws(() => new Framer(() => { }).push(Uint8Array.from(bytes)));
});
test('DER roundtrips positive unsigned integers and rejects indefinite lengths', () => {
    for (const value of [0, 127, 128, 65535, 0x80000000, 0xffffffff]) {
        const r = new Reader(sequence(integer(value)));
        const body = readTlv(r, 0x30).reader;
        assert.equal(readInteger(body), value);
        body.end();
        r.end();
    }
    assert.throws(() => readTlv(new Reader(Uint8Array.of(0x30, 0x80, 0, 0))));
});
test('Negotiation never accepts an unrequested or legacy security protocol', () => {
    const response = protocol => tpkt(new Writer().u8(14).u8(0xd0).zeros(5).u8(2).u8(0).u16le(8).u32le(protocol).finish());
    assert.equal(parseConnectionConfirm(response(2), 2).selectedProtocol, 2);
    assert.throws(() => parseConnectionConfirm(response(1), 2));
    assert.throws(() => parseConnectionConfirm(response(0), 2));
    assert.throws(() => connectionRequest(0));
});
test('Bridge token comparison is type/length checked and exact', () => { const token = 'test-token-0123456789abcdef'; assert.equal(tokenMatches(token, token), true); assert.equal(tokenMatches(`${token}x`, token), false); assert.equal(tokenMatches(null, token), false); assert.equal(tokenMatches('short', token), false); });

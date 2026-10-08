import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { requireThat, ProtocolError } from '../binary/ProtocolError.js';
export function tpkt(payload) {
    requireThat(payload.length + 4 <= 65535, 'TPKT_LIMIT', 'TPKT exceeds 65535 bytes');
    return new Writer(payload.length + 4).u8(3).u8(0).u16be(payload.length + 4).put(payload).finish();
}
export function dataPdu(payload) { return tpkt(new Writer(payload.length + 3).u8(2).u8(0xf0).u8(0x80).put(payload).finish()); }
export function unwrapData(bytes) {
    const r = new Reader(bytes);
    r.expect(3).expect(0);
    requireThat(r.u16be() === bytes.length, 'TPKT_LENGTH', 'TPKT length mismatch');
    r.expect(2).expect(0xf0).expect(0x80);
    return r.take(r.remaining);
}
export function connectionRequest(protocols = 2) {
    requireThat([1, 2, 10].includes(protocols), 'SECURITY', 'Only explicit TLS or NLA modes are supported');
    // No user name in the unencrypted routing cookie.
    return tpkt(new Writer().u8(14).u8(0xe0).u16be(0).u16be(0).u8(0)
        .u8(1).u8(0).u16le(8).u32le(protocols).finish());
}
export function parseConnectionConfirm(bytes, requestedProtocols) {
    const r = new Reader(bytes);
    r.expect(3).expect(0);
    requireThat(r.u16be() === bytes.length, 'TPKT_LENGTH', 'Connection confirm length mismatch');
    const li = r.u8();
    requireThat(li + 5 === bytes.length, 'X224_LENGTH', 'Invalid X.224 length');
    r.expect(0xd0);
    r.skip(5);
    requireThat(r.remaining === 8, 'SECURITY_DOWNGRADE', 'Server did not negotiate enhanced RDP security');
    const type = r.u8(), flags = r.u8();
    requireThat(r.u16le() === 8, 'NEGOTIATION', 'Invalid negotiation response');
    const value = r.u32le();
    if (type === 3) {
        const errors = { 1: 'Server requires TLS', 2: 'Server does not support TLS', 3: 'Server has no TLS certificate',
            4: 'Inconsistent negotiation flags', 5: 'Server requires NLA', 6: 'Server requires TLS with user authentication' };
        throw new ProtocolError('NEGOTIATION_REJECTED', errors[value] ?? `RDP negotiation rejected (${value})`);
    }
    requireThat(type === 2 && [1, 2, 8].includes(value) && (requestedProtocols & value) === value, 'SECURITY_DOWNGRADE', 'Server selected an unrequested security protocol');
    return { selectedProtocol: value, flags, requestedProtocols };
}

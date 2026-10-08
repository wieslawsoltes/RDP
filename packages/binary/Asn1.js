import { Reader } from './Reader.js';
import { Writer, concat } from './Writer.js';
import { checkedSize, requireThat } from './ProtocolError.js';
/** Definite-length BER/DER only. No indefinite lengths, recursive auto-decoding or unbounded allocation. */
export function lengthBytes(n) {
    checkedSize(n, 0x1ffffff);
    if (n < 128)
        return Uint8Array.of(n);
    const octets = [];
    for (let v = n; v; v >>>= 8)
        octets.unshift(v & 255);
    return Uint8Array.of(0x80 | octets.length, ...octets);
}
export function tlv(tag, data) {
    const tags = tag > 255 ? Uint8Array.of(tag >>> 8, tag & 255) : Uint8Array.of(tag);
    return concat(tags, lengthBytes(data.length), data);
}
export const sequence = (...parts) => tlv(0x30, concat(...parts));
export const octet = bytes => tlv(4, bytes);
export const explicit = (tag, bytes) => tlv(0xa0 | tag, bytes);
export function integer(n, tag = 2) {
    checkedSize(n, 0xffffffff);
    const arr = [];
    do {
        arr.unshift(n & 255);
        n = Math.floor(n / 256);
    } while (n);
    if (arr[0] & 0x80)
        arr.unshift(0);
    return tlv(tag, Uint8Array.from(arr));
}
export function readTlv(r, expectedTag) {
    let tag = r.u8();
    if ((tag & 31) === 31) {
        const next = r.u8();
        requireThat(!(next & 0x80), 'ASN1_TAG', 'ASN.1 tag exceeds supported width');
        tag = (tag << 8) | next;
    }
    if (expectedTag !== undefined)
        requireThat(tag === expectedTag, 'ASN1_TAG', `Unexpected ASN.1 tag ${tag.toString(16)}`);
    let n = r.u8();
    if (n & 128) {
        const count = n & 127;
        requireThat(count > 0 && count <= 4, 'ASN1_LENGTH', 'Invalid ASN.1 length');
        n = 0;
        for (let i = 0; i < count; i++)
            n = n * 256 + r.u8();
    }
    checkedSize(n, 32 * 1024 * 1024, 'ASN.1 length');
    return { tag, reader: r.sub(n) };
}
export function readInteger(r, tag = 2) {
    const v = readTlv(r, tag).reader;
    requireThat(v.remaining > 0 && v.remaining <= 5, 'ASN1_INTEGER', 'Invalid ASN.1 integer');
    requireThat(!(v.bytes[0] & 128), 'ASN1_INTEGER', 'Negative ASN.1 integer is not permitted');
    let n = 0;
    while (v.remaining)
        n = n * 256 + v.u8();
    return checkedSize(n, 0xffffffff);
}
export function fields(bytes) {
    const outer = new Reader(bytes), seq = readTlv(outer, 0x30).reader;
    outer.end();
    const map = new Map();
    while (seq.remaining) {
        const { tag, reader } = readTlv(seq);
        requireThat(!map.has(tag), 'ASN1_DUPLICATE', 'Duplicate ASN.1 field');
        map.set(tag, reader);
    }
    return map;
}

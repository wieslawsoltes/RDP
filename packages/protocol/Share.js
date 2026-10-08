import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { requireThat } from '../binary/ProtocolError.js';
export function shareControl(type, source, body) {
    requireThat(body.length + 6 <= 65535, 'SHARE_LIMIT', 'Share PDU too large');
    return new Writer(body.length + 6).u16le(body.length + 6).u16le(0x10 | type).u16le(source).put(body).finish();
}
export function shareData(shareId, source, type, body) {
    return shareControl(7, source, new Writer().u32le(shareId).u8(0).u8(1).u16le(body.length + 18)
        .u8(type).u8(0).u16le(0).put(body).finish());
}
export function parseShare(bytes, onPdu) {
    const r = new Reader(bytes);
    while (r.remaining) {
        const total = r.u16le();
        requireThat(total >= 6 && total !== 0x8000, 'SHARE_LENGTH', 'Invalid or unsupported Share Control length');
        const p = r.sub(total - 2), type = p.u16le(), source = p.u16le();
        requireThat((type & 0xfff0) === 0x10, 'SHARE_VERSION', 'Unsupported Share Control version');
        onPdu(type & 15, source, p.take(p.remaining));
    }
}
/** A single connection-wide decoder must be supplied for all bulk streams. */
export function parseShareData(bytes, bulk = null) {
    const r = new Reader(bytes), shareId = r.u32le();
    r.u8();
    const streamId = r.u8(), uncompressedLength = r.u16le(), type = r.u8(), compression = r.u8(), compressedLength = r.u16le();
    requireThat([1, 2, 4].includes(streamId) || streamId === 0 && type === 31, 'SHARE_STREAM', 'Invalid Share Data stream');
    let data = r.take(r.remaining);
    if (compression) {
        requireThat(bulk, 'UNSUPPORTED_BULK', 'Server sent unnegotiated bulk data');
        if (compression & 0x20) {
            requireThat(compressedLength === bytes.length + 6 && uncompressedLength >= 18, 'DATA_LENGTH', 'Invalid compressed Share Data lengths');
            data = bulk.decode(data, compression, uncompressedLength - 18);
            requireThat(data.length === uncompressedLength - 18, 'DATA_LENGTH', 'Bulk output does not match Share Data length');
        } else {
            requireThat(compressedLength === 0, 'DATA_LENGTH', 'Unexpected compressed length');
            data = bulk.decode(data, compression, 65535);
        }
    } else requireThat(compressedLength === 0, 'DATA_LENGTH', 'Unexpected compressed length');
    // Raw framing is authoritative. Accept full-PDU and Share-Data-only
    // length conventions, but emit the full-PDU length.
    if (!(compression & 0x20)) requireThat(uncompressedLength === bytes.length || uncompressedLength === bytes.length + 6, 'SHARE_DATA_LENGTH', 'Invalid raw Share Data length');
    return { shareId, streamId, type, uncompressedLength, data };
}

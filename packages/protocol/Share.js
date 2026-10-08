import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { requireThat } from '../binary/ProtocolError.js';
export function shareControl(type, source, body) {
    requireThat(body.length + 6 <= 65535, 'SHARE_LIMIT', 'Share PDU too large');
    return new Writer(body.length + 6).u16le(body.length + 6).u16le(0x10 | type).u16le(source).put(body).finish();
}
export function shareData(shareId, source, type, body) {
    return shareControl(7, source, new Writer().u32le(shareId).u8(0).u8(1).u16le(body.length + 12)
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
export function parseShareData(bytes) {
    const r = new Reader(bytes), shareId = r.u32le();
    r.u8();
    const streamId = r.u8(), uncompressedLength = r.u16le(), type = r.u8(), compression = r.u8(), compressedLength = r.u16le();
    requireThat(compression === 0, 'BULK_COMPRESSION', 'Server used bulk compression although it was not negotiated');
    requireThat(uncompressedLength === bytes.length, 'SHARE_DATA_LENGTH', 'Invalid Share Data uncompressed length');
    requireThat(compressedLength === 0, 'SHARE_DATA_LENGTH', 'Unexpected compressed length');
    return { shareId, streamId, type, data: r.take(r.remaining) };
}

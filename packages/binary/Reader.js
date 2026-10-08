import { requireThat, checkedSize } from './ProtocolError.js';
/** Bounds-checked, zero-copy view. Subreaders cannot escape their declared PDU. */
export class Reader {
    constructor(bytes) {
        requireThat(bytes instanceof Uint8Array, 'TYPE', 'Reader requires a Uint8Array');
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.offset = 0;
    }
    get remaining() { return this.bytes.length - this.offset; }
    need(size) {
        checkedSize(size, this.bytes.length, 'Read length');
        requireThat(size <= this.remaining, 'TRUNCATED', 'Truncated protocol structure', this.offset);
    }
    u8() { this.need(1); return this.bytes[this.offset++]; }
    u16le() { this.need(2); const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
    u16be() { this.need(2); const v = this.view.getUint16(this.offset, false); this.offset += 2; return v; }
    u32le() { this.need(4); const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
    u32be() { this.need(4); const v = this.view.getUint32(this.offset, false); this.offset += 4; return v; }
    i32le() { this.need(4); const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
    u64le() { this.need(8); const v = this.view.getBigUint64(this.offset, true); this.offset += 8; return v; }
    take(size) { this.need(size); const v = this.bytes.subarray(this.offset, this.offset + size); this.offset += size; return v; }
    skip(size) { this.need(size); this.offset += size; return this; }
    sub(size) { return new Reader(this.take(size)); }
    expect(value) { requireThat(this.u8() === value, 'INVALID', 'Unexpected protocol tag', this.offset - 1); return this; }
    end() { requireThat(this.remaining === 0, 'TRAILING', 'Unexpected trailing protocol bytes', this.offset); }
    ascii(size) { return String.fromCharCode(...this.take(size)); }
    utf16(size) { requireThat(size % 2 === 0, 'UNICODE', 'Odd UTF-16 length'); return new TextDecoder('utf-16le', { fatal: true }).decode(this.take(size)); }
    zUtf16(maxBytes = this.remaining) {
        checkedSize(maxBytes, this.remaining);
        const start = this.offset;
        while (this.offset - start + 2 <= maxBytes) {
            if (this.u16le() === 0)
                return new TextDecoder('utf-16le', { fatal: true }).decode(this.bytes.subarray(start, this.offset - 2));
        }
        throw new Error('Unterminated UTF-16 string');
    }
    perLength() {
        const b = this.u8();
        return b & 0x80 ? ((b & 0x7f) << 8) | this.u8() : b;
    }
}

import { checkedSize, requireThat } from './ProtocolError.js';
/** Amortized-linear writer, portable between browsers and Node. */
export class Writer {
    constructor(capacity = 256, limit = 32 * 1024 * 1024) {
        this.limit = limit;
        this.bytes = new Uint8Array(Math.max(16, checkedSize(capacity, limit)));
        this.view = new DataView(this.bytes.buffer);
        this.offset = 0;
    }
    reserve(size) {
        checkedSize(size, this.limit);
        const required = checkedSize(this.offset + size, this.limit, 'Encoded PDU length');
        if (required > this.bytes.length) {
            const next = new Uint8Array(Math.min(this.limit, Math.max(required, this.bytes.length * 2)));
            next.set(this.bytes);
            this.bytes = next;
            this.view = new DataView(next.buffer);
        }
        return this;
    }
    u8(v) { this.reserve(1); this.view.setUint8(this.offset++, v); return this; }
    u16le(v) { this.reserve(2); this.view.setUint16(this.offset, v, true); this.offset += 2; return this; }
    u16be(v) { this.reserve(2); this.view.setUint16(this.offset, v, false); this.offset += 2; return this; }
    u32le(v) { this.reserve(4); this.view.setUint32(this.offset, v, true); this.offset += 4; return this; }
    u32be(v) { this.reserve(4); this.view.setUint32(this.offset, v, false); this.offset += 4; return this; }
    i32le(v) { this.reserve(4); this.view.setInt32(this.offset, v, true); this.offset += 4; return this; }
    u64le(v) { this.reserve(8); this.view.setBigUint64(this.offset, BigInt(v), true); this.offset += 8; return this; }
    put(bytes) { this.reserve(bytes.length); this.bytes.set(bytes, this.offset); this.offset += bytes.length; return this; }
    zeros(size) { this.reserve(size); this.bytes.fill(0, this.offset, this.offset + size); this.offset += size; return this; }
    ascii(s) {
        for (let i = 0; i < s.length; i++)
            this.u8(s.charCodeAt(i));
        return this;
    }
    utf16(s, terminate = false) {
        for (let i = 0; i < s.length; i++)
            this.u16le(s.charCodeAt(i));
        if (terminate)
            this.u16le(0);
        return this;
    }
    fixedUtf16(s, bytes) {
        requireThat(bytes % 2 === 0, 'UNICODE', 'Odd UTF-16 field length');
        const start = this.offset;
        this.utf16(s.slice(0, bytes / 2 - 1), true);
        return this.zeros(bytes - (this.offset - start));
    }
    perLength(n) { checkedSize(n, 0x7fff, 'PER length'); return n < 128 ? this.u8(n) : this.u16be(n | 0x8000); }
    patch16le(at, v) { requireThat(at >= 0 && at + 2 <= this.offset, 'RANGE', 'Invalid patch'); this.view.setUint16(at, v, true); return this; }
    patch16be(at, v) { requireThat(at >= 0 && at + 2 <= this.offset, 'RANGE', 'Invalid patch'); this.view.setUint16(at, v, false); return this; }
    patch32le(at, v) { requireThat(at >= 0 && at + 4 <= this.offset, 'RANGE', 'Invalid patch'); this.view.setUint32(at, v, true); return this; }
    finish() { return this.bytes.slice(0, this.offset); }
}
export function concat(...parts) {
    const length = parts.reduce((n, p) => n + p.length, 0);
    checkedSize(length, 64 * 1024 * 1024);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
export function utf16(s, terminate = false) { return new Writer(s.length * 2 + 2).utf16(s, terminate).finish(); }

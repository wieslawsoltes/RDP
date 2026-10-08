import { requireThat } from '../binary/ProtocolError.js';

/** MS-RDPBCGR 3.1.8: one receive history shared by all RDP bulk-compressed traffic.
 * Only RDP 4 (8 KiB) and RDP 5 (64 KiB) are negotiated. The initial/cleared
 * history is entirely valid, including zero-filled bytes not previously written.
 */
export class MppcDecoder {
    constructor() { this.history = new Uint8Array(65536); this.type = null; this.offset = 0; this.failed = false; }
    decode(bytes, flags, maximum = 65535) {
        requireThat(bytes instanceof Uint8Array && bytes.length <= 131072, 'MPPC_INPUT', 'Invalid bulk input');
        requireThat(Number.isInteger(flags) && flags >= 0 && flags <= 255 && !(flags & 0x10), 'MPPC_FLAGS', 'Invalid bulk flags');
        requireThat(Number.isSafeInteger(maximum) && maximum >= 0 && maximum <= 16777216, 'MPPC_LIMIT', 'Invalid decompression limit');
        const compressed = !!(flags & 0x20), flushed = !!(flags & 0x80), type = flags & 15;
        requireThat(type <= 1, 'BULK_CODEC', 'Unnegotiated RDP bulk compression type');
        requireThat(!this.failed || flushed, 'MPPC_HISTORY', 'Corrupt history requires a flush');
        if (flushed) this.reset();
        if (flags & 0x40) this.offset = 0;
        // Raw packets are NOT inserted into history. Flush/at-front still apply.
        if (!compressed) {
            requireThat(bytes.length <= maximum, 'MPPC_LIMIT', 'Raw bulk output exceeds limit');
            return bytes.slice();
        }
        requireThat(this.type === null || this.type === type, 'MPPC_HISTORY', 'Compression type changed without flushing');
        this.type = type;
        const size = type ? 65536 : 8192, mask = size - 1, start = this.offset;
        const end = Math.min(size, start + maximum, start + size - 1);
        const bits = new MsbBits(bytes);
        try {
            while (bits.remaining >= 8) {
                if (bits.read(1) === 0) {
                    requireThat(this.offset < end, 'MPPC_LIMIT', 'Bulk history overflow');
                    this.history[this.offset++] = bits.read(7);
                } else if (bits.read(1) === 0) {
                    requireThat(this.offset < end, 'MPPC_LIMIT', 'Bulk history overflow');
                    this.history[this.offset++] = bits.read(7) + 128;
                } else {
                    let distance;
                    if (!type) {
                        distance = !bits.read(1) ? bits.read(13) + 320
                            : !bits.read(1) ? bits.read(8) + 64 : bits.read(6);
                    } else {
                        distance = !bits.read(1) ? bits.read(16) + 2368
                            : !bits.read(1) ? bits.read(11) + 320
                                : !bits.read(1) ? bits.read(8) + 64 : bits.read(6);
                    }
                    requireThat(distance < size, 'MPPC_OFFSET', 'Bulk copy offset exceeds history');
                    let ones = 0;
                    while (bits.read(1)) {
                        ones++;
                        requireThat(ones <= (type ? 14 : 11), 'MPPC_MATCH', 'Bulk match prefix is too long');
                    }
                    const width = ones + 1, length = ones ? (2 ** width) + bits.read(width) : 3;
                    requireThat(length <= end - this.offset, 'MPPC_LIMIT', 'Bulk match exceeds output/history limit');
                    // Replicating copy, NOT memcpy/copyWithin: the source can overlap
                    // bytes being produced, and may wrap at the history boundary.
                    let source = (this.offset - distance) & mask;
                    for (let i = 0; i < length; i++) {
                        this.history[this.offset++] = this.history[source];
                        source = (source + 1) & mask;
                    }
                }
            }
            requireThat(!bits.remaining || bits.read(bits.remaining) === 0, 'MPPC_PADDING', 'Nonzero bulk padding');
            // Owned output: queued frames must survive subsequent history writes.
            return this.history.slice(start, this.offset);
        } catch (error) {
            this.history.fill(0); this.offset = 0; this.failed = true;
            throw error;
        }
    }
    reset() { this.history.fill(0); this.offset = 0; this.type = null; this.failed = false; }
}

class MsbBits {
    constructor(bytes) { this.bytes = bytes; this.position = 0; }
    get remaining() { return this.bytes.length * 8 - this.position; }
    read(count) {
        requireThat(count <= this.remaining, 'MPPC_TRUNCATED', 'Truncated bulk token');
        let result = 0;
        while (count) {
            const bit = this.position & 7, take = Math.min(count, 8 - bit);
            result = result * (2 ** take) + ((this.bytes[this.position >>> 3] >>> (8 - bit - take)) & ((1 << take) - 1));
            this.position += take; count -= take;
        }
        return result;
    }
}

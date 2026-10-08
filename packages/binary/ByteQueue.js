import { checkedSize, requireThat } from './ProtocolError.js';
/** Chunk queue: no quadratic concatenation on fragmented TCP streams. */
export class ByteQueue {
    constructor(limit = 4 * 1024 * 1024) { this.limit = limit; this.chunks = []; this.head = 0; this.skip = 0; this.length = 0; }
    push(bytes) {
        requireThat(bytes instanceof Uint8Array, 'TYPE', 'Queue requires byte arrays');
        checkedSize(this.length + bytes.length, this.limit, 'Receive queue');
        if (bytes.length) {
            requireThat(this.chunks.length - this.head < 4096, 'FRAGMENT_LIMIT', 'Receive queue has too many fragments');
            this.chunks.push(bytes);
            this.length += bytes.length;
        }
    }
    peek(offset = 0) {
        requireThat(Number.isSafeInteger(offset) && offset >= 0 && offset < this.length, 'TRUNCATED', 'Queue peek out of bounds');
        let i = this.head, at = this.skip + offset;
        while (at >= this.chunks[i].length) {
            at -= this.chunks[i++].length;
        }
        return this.chunks[i][at];
    }
    read(size) {
        checkedSize(size, this.length);
        if (!size)
            return new Uint8Array();
        let out;
        const first = this.chunks[this.head];
        if (first.length - this.skip >= size) {
            out = first.subarray(this.skip, this.skip + size);
            this.skip += size;
            if (this.skip === first.length) {
                this.head++;
                this.skip = 0;
            }
        }
        else {
            out = new Uint8Array(size);
            let at = 0;
            while (at < size) {
                const current = this.chunks[this.head], n = Math.min(size - at, current.length - this.skip);
                out.set(current.subarray(this.skip, this.skip + n), at);
                at += n;
                this.skip += n;
                if (this.skip === current.length) {
                    this.head++;
                    this.skip = 0;
                }
            }
        }
        this.length -= size;
        if (this.head > 64 && this.head * 2 > this.chunks.length) {
            this.chunks = this.chunks.slice(this.head);
            this.head = 0;
        }
        if (this.length === 0)
            this.clear();
        return out;
    }
    clear() { this.chunks = []; this.head = 0; this.skip = 0; this.length = 0; }
}

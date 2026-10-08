import { Reader } from '../binary/Reader.js';
import { ByteQueue } from '../binary/ByteQueue.js';
import { requireThat } from '../binary/ProtocolError.js';
export class FastPath {
    constructor(onUpdate, limit = 16 * 1024 * 1024, bulk = null) { this.bulk = bulk; this.limit = limit; this.onUpdate = onUpdate; this.fragments = new ByteQueue(limit); this.fragmentType = null; }
    push(bytes) {
        const r = new Reader(bytes), flags = r.u8();
        requireThat((flags & 0xc3) === 0, 'FASTPATH_SECURITY', 'Unexpected fast-path encryption or action under TLS');
        requireThat(r.perLength() === bytes.length, 'FASTPATH_LENGTH', 'Fast-path length mismatch');
        while (r.remaining) {
            const header = r.u8(), code = header & 15, fragment = header >>> 4 & 3, compression = header >>> 6;
            requireThat(compression === 0 || compression === 2, 'FASTPATH_FLAGS', 'Invalid fast-path compression flags');
            const compressionFlags = compression === 2 ? r.u8() : 0;
            let data = r.take(r.u16le());
            if (compression === 2) {
                requireThat(this.bulk, 'UNSUPPORTED_BULK', 'Bulk fast-path output was not negotiated');
                data = this.bulk.decode(data, compressionFlags, this.limit);
            }
            if (fragment === 0) {
                requireThat(this.fragmentType === null, 'FASTPATH_FRAGMENT', 'Unfinished fast-path fragment');
                this.onUpdate(code, data);
            }
            else if (fragment === 2) {
                requireThat(this.fragmentType === null, 'FASTPATH_FRAGMENT', 'Overlapping fast-path fragments');
                this.fragmentType = code;
                this.fragments.push(data.slice());
            }
            else {
                requireThat(this.fragmentType === code, 'FASTPATH_FRAGMENT', 'Mismatched fast-path fragment');
                this.fragments.push(data.slice());
                if (fragment === 1) {
                    const complete = this.fragments.read(this.fragments.length);
                    this.fragmentType = null;
                    this.onUpdate(code, complete);
                }
            }
        }
    }
    clear() { this.fragments.clear(); this.fragmentType = null; }
}

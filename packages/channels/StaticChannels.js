import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { ByteQueue } from '../binary/ByteQueue.js';
import { requireThat } from '../binary/ProtocolError.js';
export class StaticChannels {
    constructor(send, limit = 16 * 1024 * 1024) { this.send = send; this.limit = limit; this.channels = new Map(); }
    register(id, handler) { requireThat(!this.channels.has(id), 'CHANNEL_DUPLICATE', 'Duplicate channel registration'); this.channels.set(id, { handler, queue: new ByteQueue(this.limit), expected: null }); }
    receive(id, bytes) {
        const state = this.channels.get(id);
        requireThat(state, 'CHANNEL_UNKNOWN', 'Packet on unknown static channel');
        const r = new Reader(bytes), total = r.u32le(), flags = r.u32le();
        requireThat(total <= this.limit && !(flags & 0x00ff0000), 'CHANNEL_COMPRESSION', 'Oversized or unnegotiated compressed channel message');
        if (flags & 1) {
            requireThat(state.expected === null, 'CHANNEL_FRAGMENT', 'Overlapping virtual channel messages');
            state.expected = total;
        }
        requireThat(state.expected === total, 'CHANNEL_FRAGMENT', 'Missing first fragment or changed virtual channel length');
        state.queue.push(r.take(r.remaining).slice());
        requireThat(state.queue.length <= total, 'CHANNEL_LENGTH', 'Virtual channel message exceeds declared length');
        if (flags & 2) {
            requireThat(state.queue.length === total, 'CHANNEL_LENGTH', 'Incomplete virtual channel message');
            const data = state.queue.read(total);
            state.expected = null;
            state.handler.receive(data);
        }
    }
    transmit(id, bytes) {
        requireThat(bytes.length <= this.limit && this.channels.has(id), 'CHANNEL_LIMIT', 'Invalid outgoing channel message');
        for (let at = 0; at < bytes.length || at === 0; at += 1600) {
            const chunk = bytes.subarray(at, at + 1600), flags = (at === 0 ? 1 : 0) | (at + chunk.length === bytes.length ? 2 : 0);
            this.send(id, new Writer(chunk.length + 8).u32le(bytes.length).u32le(flags).put(chunk).finish());
        }
    }
    close() {
        for (const c of this.channels.values()) {
            c.queue.clear();
            c.handler.close?.();
        }
        this.channels.clear();
    }
}

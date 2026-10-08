import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { ByteQueue } from '../binary/ByteQueue.js';
import { requireThat } from '../binary/ProtocolError.js';
export class StaticChannels {
    constructor(send, limit = 16 * 1024 * 1024, bulk = null) { this.bulk = bulk; this.send = send; this.limit = limit; this.channels = new Map(); this.suspended = false; this.pending = []; this.pendingBytes = 0; }
    register(id, handler) { requireThat(!this.channels.has(id), 'CHANNEL_DUPLICATE', 'Duplicate channel registration'); this.channels.set(id, { handler, queue: new ByteQueue(this.limit), expected: null }); }
    receive(id, bytes) {
        const state = this.channels.get(id);
        requireThat(state, 'CHANNEL_UNKNOWN', 'Packet on unknown static channel');
        const r = new Reader(bytes), total = r.u32le(), flags = r.u32le();
        requireThat(total <= this.limit && !(flags & ~0x00ef00f3), 'CHANNEL_FLAGS', 'Invalid static channel length or flags');
        if (flags & 0x60) {
            requireThat(flags === 0x20 || flags === 0x40, 'CHANNEL_FLOW', 'Mixed channel flow-control flags');
            requireThat(total === 0 && r.remaining === 0, 'CHANNEL_FLOW', 'Data attached to channel flow control');
            this.suspended = flags === 0x20;
            if (!this.suspended) {
                const pending = this.pending; this.pending = []; this.pendingBytes = 0;
                for (const message of pending) { this.transmit(message.id, message.bytes); message.bytes.fill(0); }
            }
            return;
        }
        let data = r.take(r.remaining);
        if (flags & 0x00ff0000) {
            requireThat(this.bulk, 'UNSUPPORTED_BULK', 'Compressed virtual channel data was not negotiated');
            data = this.bulk.decode(data, (flags >>> 16) & 255, this.limit);
        }
        if (flags & 1) {
            requireThat(state.expected === null, 'CHANNEL_FRAGMENT', 'Overlapping virtual channel messages');
            state.expected = total;
        }
        requireThat(state.expected === total, 'CHANNEL_FRAGMENT', 'Missing first fragment or changed virtual channel length');
        state.queue.push(data.slice());
        requireThat(state.queue.length <= total, 'CHANNEL_LENGTH', 'Virtual channel message exceeds declared length');
        if (flags & 2) {
            requireThat(state.queue.length === total, 'CHANNEL_LENGTH', 'Incomplete virtual channel message');
            const complete = state.queue.read(total);
            state.expected = null;
            state.handler.receive(complete);
        }
    }
    transmit(id, bytes) {
        requireThat(bytes.length <= this.limit && this.channels.has(id), 'CHANNEL_LIMIT', 'Invalid outgoing channel message');
        if (this.suspended) {
            requireThat(this.pendingBytes + bytes.length <= this.limit && this.pending.length < 1024, 'CHANNEL_LIMIT', 'Suspended virtual-channel queue is full');
            this.pending.push({ id, bytes: bytes.slice() }); this.pendingBytes += bytes.length;
            return;
        }
        for (let at = 0; at < bytes.length || at === 0; at += 1600) {
            const chunk = bytes.subarray(at, at + 1600), flags = (at === 0 ? 1 : 0) | (at + chunk.length === bytes.length ? 2 : 0);
            this.send(id, new Writer(chunk.length + 8).u32le(bytes.length).u32le(flags).put(chunk).finish());
        }
    }
    close() {
        for (const message of this.pending) message.bytes.fill(0);
        this.pending = []; this.pendingBytes = 0; this.suspended = false;
        for (const c of this.channels.values()) {
            c.queue.clear();
            c.handler.close?.();
        }
        this.channels.clear();
    }
}

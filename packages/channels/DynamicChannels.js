import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { ByteQueue } from '../binary/ByteQueue.js';
import { requireThat } from '../binary/ProtocolError.js';
const readInt = (r, kind) => { requireThat(kind < 3, 'DVC_INTEGER', 'Reserved dynamic-channel integer encoding'); return kind === 0 ? r.u8() : kind === 1 ? r.u16le() : r.u32le(); };
const width = value => value <= 255 ? 0 : value <= 65535 ? 1 : 2;
const writeInt = (w, value, kind) => kind === 0 ? w.u8(value) : kind === 1 ? w.u16le(value) : w.u32le(value);
/** MS-RDPEDYC v1/v2, reliable channel transport. Unsupported services are rejected. */
export class DynamicChannels {
    constructor(send, factories, emit = () => { }) { this.send = send; this.factories = factories; this.emit = emit; this.channels = new Map(); this.version = 0; }
    receive(bytes) {
        const r = new Reader(bytes), h = r.u8(), command = h >>> 4, cb = h & 3, sp = (h >>> 2) & 3;
        if (command === 5) {
            requireThat(!this.version && cb === 0 && sp === 0, 'DVC_CAPS', 'Invalid dynamic-channel capability sequence');
            r.u8();
            const offered = r.u16le();
            requireThat(offered >= 1, 'DVC_VERSION', 'Invalid dynamic-channel version');
            if (offered >= 2) {
                requireThat(r.remaining === 8, 'DVC_CAPS', 'Missing dynamic-channel priority charges');
                r.skip(8);
            }
            r.end();
            this.version = Math.min(offered, 2);
            this.send(new Writer().u8(0x50).u8(0).u16le(this.version).finish());
            this.emit({ type: 'ready', version: this.version });
            return;
        }
        requireThat(this.version, 'DVC_STATE', 'Dynamic channel used before capabilities');
        const id = readInt(r, cb);
        if (command === 1) {
            requireThat(sp === 0 && !this.channels.has(id) && this.channels.size < 32 && r.remaining <= 512, 'DVC_CREATE', 'Invalid channel creation');
            const nameBytes = r.take(r.remaining);
            requireThat(nameBytes.length > 1 && nameBytes.at(-1) === 0 && !nameBytes.subarray(0, -1).includes(0), 'DVC_NAME', 'Invalid dynamic-channel name');
            requireThat(nameBytes.every(v => v < 128), 'DVC_NAME', 'Non-ASCII dynamic-channel name');
            const name = new TextDecoder().decode(nameBytes.subarray(0, -1)), factory = this.factories.get(name);
            const response = writeInt(new Writer().u8(0x10 | cb), id, cb).u32le(factory ? 0 : 0xc0000001).finish();
            if (factory) {
                const channel = { handler: factory(data => this.transmit(id, data)), queue: new ByteQueue(8 * 1024 * 1024), expected: null };
                this.channels.set(id, channel);
                this.send(response);
                this.emit({ type: 'opened', id, name });
            }
            else {
                this.send(response);
                this.emit({ type: 'rejected', id, name });
            }
            return;
        }
        const channel = this.channels.get(id);
        requireThat(channel, 'DVC_UNKNOWN', 'Unknown dynamic channel');
        if (command === 4) {
            r.end();
            channel.handler.close?.();
            this.channels.delete(id);
            this.send(writeInt(new Writer().u8(0x40 | cb), id, cb).finish());
            return;
        }
        requireThat(command === 2 || command === 3, 'DVC_COMMAND', 'Unsupported dynamic-channel command');
        if (command === 2) {
            requireThat(channel.expected === null, 'DVC_FRAGMENT', 'Overlapping dynamic-channel messages');
            channel.expected = readInt(r, sp);
            requireThat(channel.expected > 0 && channel.expected <= channel.queue.limit, 'DVC_LIMIT', 'Dynamic-channel message exceeds limit');
        }
        else
            requireThat(sp === 0, 'DVC_RESERVED', 'Reserved dynamic-channel bits are set');
        const data = r.take(r.remaining);
        if (channel.expected === null) {
            channel.handler.receive(data);
            return;
        }
        channel.queue.push(data.slice());
        requireThat(channel.queue.length <= channel.expected, 'DVC_LENGTH', 'Dynamic-channel message exceeds declared length');
        if (channel.queue.length === channel.expected) {
            const message = channel.queue.read(channel.expected);
            channel.expected = null;
            channel.handler.receive(message);
        }
    }
    transmit(id, data) {
        requireThat(this.channels.has(id) && data.length <= 8 * 1024 * 1024, 'DVC_SEND', 'Invalid outgoing dynamic-channel message');
        const cb = width(id), chunk = 1500;
        for (let offset = 0; offset < data.length || offset === 0; offset += chunk) {
            const first = offset === 0 && data.length > chunk, sp = first ? width(data.length) : 0;
            const w = writeInt(new Writer().u8((first ? 0x20 : 0x30) | sp << 2 | cb), id, cb);
            if (first)
                writeInt(w, data.length, sp);
            this.send(w.put(data.subarray(offset, offset + chunk)).finish());
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

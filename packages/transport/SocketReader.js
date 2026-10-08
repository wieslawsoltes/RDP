import { ByteQueue } from '../binary/ByteQueue.js';
import { concat } from '../binary/Writer.js';
import { requireThat } from '../binary/ProtocolError.js';
/** Single-consumer, bounded asynchronous handshake reader. */
export class SocketReader {
    constructor(socket, limit = 1024 * 1024) {
        this.socket = socket;
        this.queue = new ByteQueue(limit);
        this.pending = null;
        this.error = null;
        this.onData = bytes => {
            try {
                this.queue.push(new Uint8Array(bytes));
                this.flush();
            }
            catch (error) {
                this.fail(error);
                socket.destroy();
            }
        };
        this.onError = error => this.fail(error);
        this.onEnd = () => this.fail(new Error('Server closed during negotiation'));
        socket.on('data', this.onData);
        socket.on('error', this.onError);
        socket.on('end', this.onEnd);
        socket.on('close', this.onEnd);
        socket.resume();
    }
    fail(error) {
        this.error ||= error;
        if (this.pending) {
            this.pending.reject(error);
            this.pending = null;
        }
    }
    flush() {
        if (this.pending && this.queue.length >= this.pending.size) {
            const p = this.pending;
            this.pending = null;
            p.resolve(this.queue.read(p.size));
        }
    }
    read(size) {
        requireThat(Number.isSafeInteger(size) && size >= 0 && size <= this.queue.limit && !this.pending, 'SOCKET_READ', 'Invalid or concurrent handshake read');
        if (this.error)
            return Promise.reject(this.error);
        if (this.queue.length >= size)
            return Promise.resolve(this.queue.read(size));
        return new Promise((resolve, reject) => { this.pending = { size, resolve, reject }; });
    }
    async tpkt() {
        const header = await this.read(4);
        requireThat(header[0] === 3 && header[1] === 0, 'TPKT', 'Invalid X.224 framing');
        const length = header[2] * 256 + header[3];
        requireThat(length >= 7, 'TPKT_LENGTH', 'Invalid TPKT length');
        return concat(header, await this.read(length - 4));
    }
    async der() {
        const header = await this.read(2);
        requireThat(header[0] === 0x30, 'CREDSSP_DER', 'Expected CredSSP ASN.1 sequence');
        let length = header[1], extra = new Uint8Array();
        if (length & 128) {
            const n = length & 127;
            requireThat(n > 0 && n <= 3, 'CREDSSP_LENGTH', 'Invalid CredSSP length');
            extra = await this.read(n);
            length = 0;
            for (const b of extra)
                length = length * 256 + b;
        }
        requireThat(length <= this.queue.limit - 8, 'CREDSSP_LENGTH', 'CredSSP message exceeds limit');
        return concat(header, extra, await this.read(length));
    }
    detach() {
        requireThat(!this.pending, 'SOCKET_STATE', 'Cannot detach an active handshake read');
        this.socket.pause();
        this.socket.off('data', this.onData);
        this.socket.off('error', this.onError);
        this.socket.off('end', this.onEnd);
        this.socket.off('close', this.onEnd);
        return this.queue.read(this.queue.length);
    }
}
export function writeSocket(socket, bytes) {
    return new Promise((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve()));
}

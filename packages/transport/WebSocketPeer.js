import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { Reader } from '../binary/Reader.js';
import { Writer, concat } from '../binary/Writer.js';
import { ByteQueue } from '../binary/ByteQueue.js';
import { requireThat } from '../binary/ProtocolError.js';
const utf8 = new TextDecoder('utf-8', { fatal: true });
const isCloseCode = code => [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014].includes(code) || (code >= 3000 && code <= 4999);
/** Minimal RFC 6455 server peer: no compression/extensions, bounded, masked client frames. */
export class WebSocketPeer extends EventEmitter {
    constructor(socket, { maxMessage = 2 * 1024 * 1024, maxBuffered = 4 * 1024 * 1024 } = {}) {
        super();
        this.socket = socket;
        this.maxMessage = maxMessage;
        this.maxBuffered = maxBuffered;
        this.queue = new ByteQueue(maxMessage + 65536);
        this.fragments = new ByteQueue(maxMessage);
        this.fragmentOpcode = 0;
        this.closed = false;
        this.lastSeen = Date.now();
        socket.setNoDelay(true);
        socket.on('data', data => this.receive(data));
        socket.on('error', error => this.emit('socket-error', error));
        socket.once('close', () => { this.closed = true; this.queue.clear(); this.fragments.clear(); this.emit('closed'); });
    }
    receive(data) {
        if (this.closed)
            return;
        try {
            this.queue.push(data);
            for (;;) {
                if (this.queue.length < 2)
                    return;
                const a = this.queue.peek(), b = this.queue.peek(1), fin = !!(a & 128), opcode = a & 15;
                requireThat(!(a & 0x70) && (b & 128) && [0, 1, 2, 8, 9, 10].includes(opcode), 'WS_HEADER', 'Invalid WebSocket frame header');
                let length = b & 127, headerLength = 2;
                if (length === 126) {
                    if (this.queue.length < 4)
                        return;
                    length = this.queue.peek(2) * 256 + this.queue.peek(3);
                    headerLength = 4;
                    requireThat(length >= 126, 'WS_LENGTH', 'Non-canonical WebSocket length');
                }
                else if (length === 127) {
                    if (this.queue.length < 10)
                        return;
                    length = 0;
                    for (let i = 2; i < 10; i++) {
                        length = length * 256 + this.queue.peek(i);
                        requireThat(Number.isSafeInteger(length) && length <= this.maxMessage, 'WS_LIMIT', 'WebSocket frame exceeds limit');
                    }
                    headerLength = 10;
                    requireThat(length >= 65536, 'WS_LENGTH', 'Non-canonical WebSocket length');
                }
                requireThat(length <= this.maxMessage && (opcode < 8 || (fin && length <= 125)), 'WS_LIMIT', 'Oversized or fragmented control frame');
                if (this.queue.length < headerLength + 4 + length)
                    return;
                this.queue.read(headerLength);
                const mask = this.queue.read(4), bytes = this.queue.read(length).slice();
                for (let i = 0; i < length; i++)
                    bytes[i] ^= mask[i & 3];
                this.lastSeen = Date.now();
                if (opcode === 8) {
                    requireThat(length !== 1, 'WS_CLOSE', 'Invalid close payload');
                    if (length >= 2) {
                        const code = bytes[0] * 256 + bytes[1];
                        requireThat(isCloseCode(code), 'WS_CLOSE', 'Invalid close code');
                        utf8.decode(bytes.subarray(2));
                    }
                    this.frame(8, bytes);
                    this.closed = true;
                    this.socket.end();
                    return;
                }
                if (opcode === 9) {
                    this.frame(10, bytes);
                    continue;
                }
                if (opcode === 10) {
                    this.emit('pong', bytes);
                    continue;
                }
                if (opcode === 0) {
                    requireThat(this.fragmentOpcode, 'WS_FRAGMENT', 'Unexpected continuation frame');
                    this.fragments.push(bytes);
                    if (fin) {
                        const complete = this.fragments.read(this.fragments.length), type = this.fragmentOpcode;
                        this.fragmentOpcode = 0;
                        this.message(type, complete);
                    }
                }
                else {
                    requireThat(!this.fragmentOpcode, 'WS_FRAGMENT', 'Overlapping fragmented messages');
                    if (fin)
                        this.message(opcode, bytes);
                    else {
                        this.fragmentOpcode = opcode;
                        this.fragments.push(bytes);
                    }
                }
                if (this.closed)
                    return;
            }
        }
        catch {
            this.close(1002, 'Invalid or oversized WebSocket message');
        }
    }
    message(opcode, bytes) { this.emit('message', opcode === 1 ? utf8.decode(bytes) : bytes, opcode === 2); }
    frame(opcode, bytes) {
        if (this.closed || this.socket.destroyed)
            return false;
        if (bytes.length > this.maxMessage || this.socket.writableLength + bytes.length > this.maxBuffered) {
            this.closed = true;
            this.socket.destroy();
            return false;
        }
        const w = new Writer(10).u8(0x80 | opcode);
        if (bytes.length < 126)
            w.u8(bytes.length);
        else if (bytes.length <= 65535)
            w.u8(126).u16be(bytes.length);
        else
            w.u8(127).u32be(0).u32be(bytes.length);
        // A single write keeps the header and payload atomic relative to other frames.
        return this.socket.write(concat(w.finish(), bytes));
    }
    sendJSON(value) { return this.frame(1, new TextEncoder().encode(JSON.stringify(value))); }
    sendBinary(bytes) { return this.frame(2, bytes); }
    ping() { this.frame(9, new Uint8Array()); }
    close(code = 1000, reason = '') {
        if (this.closed)
            return;
        const text = new TextEncoder().encode(reason);
        this.frame(8, new Writer().u16be(code).put(text.subarray(0, 123)).finish());
        this.closed = true;
        this.socket.end();
        const timer = setTimeout(() => this.socket.destroy(), 1000);
        timer.unref?.();
    }
    static accept(request, socket) {
        const key = request.headers['sec-websocket-key'];
        requireThat(request.method === 'GET' && request.headers.upgrade?.toLowerCase() === 'websocket' && request.headers.connection?.toLowerCase().split(',').map(s => s.trim()).includes('upgrade') && request.headers['sec-websocket-version'] === '13' && typeof key === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(key) && Buffer.from(key, 'base64').length === 16, 'WS_UPGRADE', 'Invalid WebSocket upgrade');
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        return new WebSocketPeer(socket);
    }
}

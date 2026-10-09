import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { SocketReader } from '../../packages/transport/SocketReader.js';
import { Writer, concat } from '../../packages/binary/Writer.js';

export async function websocketClient(origin, clientOrigin, ca) {
    const url = new URL(origin), options = { host: url.hostname, port: Number(url.port) };
    const socket = url.protocol === 'https:' ? tls.connect({ ...options, ca, servername: 'localhost' }) : net.connect(options);
    socket.on('error', () => {});
    await once(socket, url.protocol === 'https:' ? 'secureConnect' : 'connect');
    const reader = new SocketReader(socket);
    socket.write(`GET /bridge HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${clientOrigin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    let headers = '';
    while (!headers.endsWith('\r\n\r\n') && headers.length < 8192) headers += String.fromCharCode((await reader.read(1))[0]);
    return { socket, headers,
        send(value) {
            const binary = value instanceof Uint8Array;
            const data = binary ? value : new TextEncoder().encode(JSON.stringify(value));
            const key = randomBytes(4), w = new Writer().u8(binary ? 0x82 : 0x81);
            if (data.length < 126) w.u8(data.length | 128);
            else w.u8(254).u16be(data.length);
            socket.write(concat(w.put(key).finish(), data.map((v, i) => v ^ key[i & 3])));
        },
        async receive() {
            const h = await reader.read(2);
            let length = h[1] & 127;
            if (length === 126) { const b = await reader.read(2); length = b[0] * 256 + b[1]; }
            else if (length === 127) { const b = await reader.read(8); length = Number(new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0)); }
            if (length > 2 * 1024 * 1024) throw new Error('Fixture frame too large');
            const bytes = new Uint8Array(await reader.read(length));
            if ((h[0] & 15) === 2) return bytes;
            if ((h[0] & 15) !== 1) throw new Error(`Unexpected fixture opcode: ${h[0] & 15}`);
            return JSON.parse(new TextDecoder().decode(bytes));
        },
    };
}

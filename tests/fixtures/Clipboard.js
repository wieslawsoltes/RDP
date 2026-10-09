import { deflateSync } from 'node:zlib';
import { concat } from '../../packages/binary/Writer.js';
export function chunk(type, data) {
    const b = Buffer.alloc(data.length + 12);
    b.writeUInt32BE(data.length); b.write(type, 4); b.set(data, 8);
    let crc = 0xffffffff;
    for (let i = 4; i < b.length - 4; i++) {
        crc ^= b[i];
        for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    b.writeUInt32BE((crc ^ 0xffffffff) >>> 0, b.length - 4);
    return b;
}
export function png(width = 1, height = 1) {
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
    return concat(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), chunk('IHDR', header), chunk('IDAT', deflateSync(Uint8Array.of(0, 255, 0, 0, 255))), chunk('IEND', new Uint8Array()));
}

import { requireThat } from '../binary/ProtocolError.js';
/** RFC 1320 MD4, used ONLY for NTLMv2 interoperability, never as a general hash. */
export function md4(input) {
    requireThat(input instanceof Uint8Array && input.length <= 1024 * 1024, 'MD4_INPUT', 'Invalid MD4 input');
    const size = (input.length + 9 + 63) & ~63, bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
    bytes.set(input);
    bytes[input.length] = 0x80;
    view.setBigUint64(size - 8, BigInt(input.length) * 8n, true);
    let a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
    const x = new Uint32Array(16), rol = (v, n) => (v << n | v >>> (32 - n)) >>> 0;
    const f = (x, y, z) => (x & y) | (~x & z), g = (x, y, z) => (x & y) | (x & z) | (y & z), h = (x, y, z) => x ^ y ^ z;
    for (let offset = 0; offset < size; offset += 64) {
        for (let i = 0; i < 16; i++)
            x[i] = view.getUint32(offset + i * 4, true);
        const aa = a, bb = b, cc = c, dd = d;
        for (let i = 0; i < 16; i += 4) {
            a = rol(a + f(b, c, d) + x[i], 3);
            d = rol(d + f(a, b, c) + x[i + 1], 7);
            c = rol(c + f(d, a, b) + x[i + 2], 11);
            b = rol(b + f(c, d, a) + x[i + 3], 19);
        }
        for (let i = 0; i < 4; i++) {
            a = rol(a + g(b, c, d) + x[i] + 0x5a827999, 3);
            d = rol(d + g(a, b, c) + x[i + 4] + 0x5a827999, 5);
            c = rol(c + g(d, a, b) + x[i + 8] + 0x5a827999, 9);
            b = rol(b + g(c, d, a) + x[i + 12] + 0x5a827999, 13);
        }
        for (const i of [0, 2, 1, 3]) {
            a = rol(a + h(b, c, d) + x[i] + 0x6ed9eba1, 3);
            d = rol(d + h(a, b, c) + x[i + 8] + 0x6ed9eba1, 9);
            c = rol(c + h(d, a, b) + x[i + 4] + 0x6ed9eba1, 11);
            b = rol(b + h(c, d, a) + x[i + 12] + 0x6ed9eba1, 15);
        }
        a = (a + aa) >>> 0;
        b = (b + bb) >>> 0;
        c = (c + cc) >>> 0;
        d = (d + dd) >>> 0;
    }
    bytes.fill(0);
    x.fill(0);
    const result = new Uint8Array(16), out = new DataView(result.buffer);
    [a, b, c, d].forEach((v, i) => out.setUint32(i * 4, v, true));
    return result;
}

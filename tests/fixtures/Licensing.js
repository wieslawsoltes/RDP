import { createHash, generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { Writer, concat, utf16 } from '../../packages/binary/Writer.js';
import { Reader } from '../../packages/binary/Reader.js';
import { Rc4 } from '../../packages/security/Rc4.js';
import assert from 'node:assert/strict';
// Independent fixture encoders and key schedule, deliberately not LicenseClient helpers.
const digest = (name, ...chunks) => createHash(name).update(Buffer.concat(chunks.map(b => Buffer.from(b)))).digest();
const little = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const mac = (key, data) => digest('md5', key, Buffer.alloc(48, 0x5c), digest('sha1', key, Buffer.alloc(40, 0x36), little(data.length), data));
export const crypt = (key, data) => { const cipher = new Rc4(key); try { return cipher.transform(data); } finally { cipher.destroy(); } };
export function referenceKeys(premaster, client, server) {
    const expand = (secret, a, b) => Buffer.concat(['A', 'BB', 'CCC'].map(i => digest('md5', secret, digest('sha1', Buffer.from(i), secret, a, b))));
    const master = expand(premaster, client, server), session = expand(master, server, client);
    return { mac: session.subarray(0, 16), encryption: digest('md5', session.subarray(16, 32), client, server) };
}
export const packet = (type, body = new Uint8Array(), version = 3) => new Writer().u8(type).u8(version | 0x80).u16le(body.length + 4).put(body).finish();
export const blob = (type, bytes) => new Writer().u16le(type).u16le(bytes.length).put(bytes).finish();
export const counted = bytes => new Writer().u32le(bytes.length).put(bytes).finish();
export const product = { version: 0x00060000, company: 'Microsoft Corporation', product: 'A02', scope: 'microsoft.com' };
export const ansi = value => new TextEncoder().encode(value + '\0');
export function proprietaryKey(bits = 2048) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits, publicExponent: 65537 });
    const { n } = publicKey.export({ format: 'jwk' }), modulus = Buffer.from(n, 'base64url').reverse();
    const pub = new Writer().ascii('RSA1').u32le(modulus.length + 8).u32le(bits).u32le(modulus.length - 1).u32le(65537).put(modulus).zeros(8).finish();
    const certificate = new Writer().u32le(1).u32le(1).u32le(1).put(blob(6, pub)).put(blob(8, new Uint8Array(72))).finish();
    return { certificate, publicKey, privateKey };
}
export function x509Chain(...certificates) {
    const w = new Writer().u32le(2).u32le(certificates.length);
    for (const cert of certificates) w.put(counted(cert));
    return w.zeros(8 + 4 * certificates.length).finish();
}
export function request(certificate, serverRandom = Uint8Array.from({ length: 32 }, (_, i) => 32 + i), info = product) {
    return packet(1, new Writer().put(serverRandom).u32le(info.version).put(counted(utf16(info.company, true)))
        .put(counted(utf16(info.product, true))).put(blob(13, little(1))).put(blob(3, certificate))
        .u32le(1).put(blob(14, ansi(info.scope))).finish());
}
export function responseKeys(response, privateKey, server = Uint8Array.from({ length: 32 }, (_, i) => 32 + i)) {
    const r = new Reader(response); r.skip(4); assert.equal(r.u32le(), 1); r.u32le(); const client = r.take(32);
    assert.equal(r.u16le(), 2); const length = r.u16le(), encrypted = r.take(length);
    assert.ok(encrypted.subarray(-8).every(v => v === 0));
    const block = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, encrypted.slice(0, -8).reverse());
    const premaster = new Uint8Array(block).reverse(); assert.ok(premaster.subarray(48).every(v => v === 0));
    const keys = referenceKeys(premaster.subarray(0, 48), client, server); premaster.fill(0); block.fill(0);
    return { keys, reader: r };
}
export function challenge(keys, data = utf16('TEST', true), blobType = 9) {
    return packet(2, new Writer().u32le(0).put(blob(blobType, crypt(keys.encryption, data))).put(mac(keys.mac, data)).finish());
}
export function issue(keys, { type = 3, data = Uint8Array.of(1, 2, 3, 4), info = product } = {}) {
    const plain = new Writer().u32le(info.version).put(counted(ansi(info.scope))).put(counted(utf16(info.company, true)))
        .put(counted(utf16(info.product, true))).put(counted(data)).finish();
    return packet(type, concat(blob(9, crypt(keys.encryption, plain)), mac(keys.mac, plain)));
}
export const status = (code = 7, transition = 2) => packet(0xff, new Writer().u32le(code).u32le(transition).put(blob(4, new Uint8Array())).finish());

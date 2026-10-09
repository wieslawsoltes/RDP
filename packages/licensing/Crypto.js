import { createHash, createPublicKey, publicEncrypt, constants, timingSafeEqual, X509Certificate } from 'node:crypto';
import { Reader } from '../binary/Reader.js';
import { Writer, concat } from '../binary/Writer.js';
import { requireThat, ProtocolError } from '../binary/ProtocolError.js';
import { Rc4 } from '../security/Rc4.js';

const hash = (name, ...parts) => {
    const h = createHash(name);
    for (const part of parts) h.update(part);
    return new Uint8Array(h.digest());
};
const pad1 = new Uint8Array(40).fill(0x36), pad2 = new Uint8Array(48).fill(0x5c);
const label = ['A', 'BB', 'CCC'].map(v => new TextEncoder().encode(v));
/** MS-RDPELE 5.1.2, not TLS session-key derivation. Server/client order reverses in phase two. */
export function deriveLicenseKeys(premaster, client, server) {
    requireThat(premaster?.length === 48 && client?.length === 32 && server?.length === 32, 'LICENSE_RANDOM', 'Invalid licensing random sizes');
    const expand = (secret, a, b) => {
        const chunks = label.map(i => {
            const sha = hash('sha1', i, secret, a, b);
            try { return hash('md5', secret, sha); } finally { sha.fill(0); }
        });
        try { return concat(...chunks); } finally { for (const c of chunks) c.fill(0); }
    };
    const master = expand(premaster, client, server);
    let blob;
    try {
        blob = expand(master, server, client);
        return { mac: blob.slice(0, 16), encryption: hash('md5', blob.subarray(16, 32), client, server) };
    } finally { master.fill(0); blob?.fill(0); }
}
/** Legacy licensing MAC (full 128 bits), always transported inside verified TLS. */
export function licenseMac(key, ...parts) {
    const length = parts.reduce((n, p) => n + p.length, 0);
    requireThat(key?.length === 16 && length <= 65535, 'LICENSE_MAC', 'Invalid licensing MAC input');
    const size = new Writer().u32le(length).finish();
    const sha = hash('sha1', key, pad1, size, ...parts);
    try { return hash('md5', key, pad2, sha); } finally { sha.fill(0); }
}
export function verifyLicenseMac(key, data, expected) {
    const actual = licenseMac(key, data);
    try { requireThat(expected.length === 16 && timingSafeEqual(actual, expected), 'LICENSE_MAC', 'Licensing message integrity verification failed'); }
    finally { actual.fill(0); }
}
/** Each independently encrypted blob starts with a fresh RC4 context. */
export function licenseCrypt(key, bytes) {
    requireThat(key?.length === 16 && bytes instanceof Uint8Array && bytes.length <= 65535, 'LICENSE_CIPHER', 'Invalid licensing cipher input');
    const cipher = new Rc4(key);
    try { return cipher.transform(bytes); } finally { cipher.destroy(); }
}
function boundedRsa(key) {
    requireThat(key.asymmetricKeyType === 'rsa', 'LICENSE_RSA', 'Licensing requires an RSA public key');
    const jwk = key.export({ format: 'jwk' });
    const modulus = Buffer.from(jwk.n, 'base64url'), exponent = Buffer.from(jwk.e, 'base64url');
    let e = 0;
    for (const b of exponent) e = e * 256 + b;
    requireThat(modulus.length >= 64 && modulus.length <= 1024 && exponent.length <= 4 && e >= 3 && e % 2 === 1,
        'LICENSE_RSA', 'Licensing RSA key exceeds supported 512–8192-bit public-key bounds');
    return { key, bytes: modulus.length };
}
/**
 * Extract a licensing key received INSIDE an authenticated TLS channel.
 * This is not a new PKI trust decision; the gateway's independently verified
 * RDP endpoint authenticates the certificate bytes. No global trust is added.
 */
export function licensePublicKey(bytes, fallback) {
    if (!bytes.length) {
        requireThat(fallback, 'LICENSE_CERTIFICATE_MISSING', 'Server omitted its licensing certificate and no authenticated Server Security Data certificate is available');
        return licensePublicKey(fallback);
    }
    requireThat(bytes.length <= 65535, 'LICENSE_CERTIFICATE', 'Licensing certificate chain is too large');
    try {
        const r = new Reader(bytes), version = r.u32le() & 0x7fffffff;
        if (version === 1) {
            requireThat(r.u32le() === 1 && r.u32le() === 1 && r.u16le() === 6, 'LICENSE_CERTIFICATE', 'Invalid proprietary RSA certificate');
            const publicBlob = r.sub(r.u16le());
            requireThat(publicBlob.u32le() === 0x31415352, 'LICENSE_RSA', 'Invalid RSA1 public-key magic');
            const length = publicBlob.u32le(), bits = publicBlob.u32le(), dataLength = publicBlob.u32le(), exponent = publicBlob.u32le();
            requireThat(length >= 72 && length <= 1032 && bits === (length - 8) * 8 && dataLength === length - 9,
                'LICENSE_RSA', 'Inconsistent RSA1 public-key lengths');
            const modulus = new Uint8Array(publicBlob.take(length - 8)).reverse();
            requireThat(publicBlob.take(8).every(v => v === 0), 'LICENSE_RSA', 'Invalid RSA1 padding'); publicBlob.end();
            requireThat(r.u16le() === 8, 'LICENSE_CERTIFICATE', 'Invalid proprietary signature blob');
            const signature = r.take(r.u16le());
            requireThat(signature.length === 72 && signature.subarray(-8).every(v => v === 0), 'LICENSE_CERTIFICATE', 'Invalid proprietary signature length'); r.end();
            const exp = new Writer().u32be(exponent).finish();
            return boundedRsa(createPublicKey({ key: { kty: 'RSA', n: Buffer.from(modulus).toString('base64url'), e: Buffer.from(exp).toString('base64url') }, format: 'jwk' }));
        }
        requireThat(version === 2, 'LICENSE_CERTIFICATE', 'Unsupported licensing certificate version');
        const count = r.u32le();
        requireThat(count >= 2 && count <= 200, 'LICENSE_CERTIFICATE', 'Invalid licensing certificate count');
        let certificate;
        for (let i = 0; i < count; i++) {
            const size = r.u32le();
            requireThat(size > 0 && size <= 32768, 'LICENSE_CERTIFICATE', 'Invalid X.509 certificate size');
            const encoded = r.take(size);
            certificate = new X509Certificate(encoded);
            requireThat(certificate.raw.length === encoded.length, 'LICENSE_CERTIFICATE', 'Trailing X.509 data');
        }
        r.skip(8 + 4 * count); r.end();
        return boundedRsa(certificate.publicKey);
    } catch (error) {
        if (error instanceof ProtocolError) throw error;
        throw new ProtocolError('LICENSE_CERTIFICATE', 'Invalid licensing X.509 or RSA key');
    }
}
/** MS-RDPBCGR RSA wire convention: little-endian integer, zero padding, then eight zero bytes. */
export function encryptPremaster(premaster, publicKey) {
    requireThat(premaster instanceof Uint8Array && premaster.length === 48, 'LICENSE_RANDOM', 'Premaster must have 48 bytes');
    const { key, bytes } = publicKey;
    const padded = Buffer.alloc(bytes);
    for (let i = 0; i < premaster.length; i++) padded[bytes - 1 - i] = premaster[i];
    try { return concat(new Uint8Array(publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, padded)).reverse(), new Uint8Array(8)); }
    finally { padded.fill(0); }
}

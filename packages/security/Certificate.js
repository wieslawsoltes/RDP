import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto';
import { Reader } from '../binary/Reader.js';
import { readTlv } from '../binary/Asn1.js';
import { Writer } from '../binary/Writer.js';
import { requireThat } from '../binary/ProtocolError.js';
const digest = (algorithm, bytes) => new Uint8Array(createHash(algorithm).update(bytes).digest());
const hex = b => Buffer.from(b).toString('hex');
export function subjectPublicKey(certificate) {
    const r = new Reader(new Uint8Array(certificate.publicKey.export({ format: 'der', type: 'spki' }))), spki = readTlv(r, 0x30).reader;
    r.end();
    readTlv(spki, 0x30);
    const bits = readTlv(spki, 3).reader;
    spki.end();
    requireThat(bits.u8() === 0, 'CERT_KEY', 'Non-byte-aligned certificate public key');
    return bits.take(bits.remaining).slice();
}
/** RFC 5929 tls-server-end-point hash; fail closed for unknown signature schemes. */
export function certificateDigestAlgorithm(raw) {
    const r = new Reader(raw), cert = readTlv(r, 0x30).reader;
    r.end();
    readTlv(cert, 0x30);
    const algorithm = readTlv(cert, 0x30).reader;
    const oid = hex(readTlv(algorithm, 6).reader.bytes);
    const algorithms = new Map([
        ['2a864886f70d010104', 'sha256'], ['2a864886f70d010105', 'sha256'], // MD5 / SHA-1 upgraded by RFC 5929.
        ['2a864886f70d01010b', 'sha256'], ['2a864886f70d01010c', 'sha384'], ['2a864886f70d01010d', 'sha512'], ['2a864886f70d01010e', 'sha224'],
        ['2a8648ce3d0401', 'sha256'], ['2a8648ce3d040301', 'sha224'], ['2a8648ce3d040302', 'sha256'], ['2a8648ce3d040303', 'sha384'], ['2a8648ce3d040304', 'sha512']
    ]);
    if (algorithms.has(oid))
        return algorithms.get(oid);
    if (oid === '2a864886f70d01010a') { // RSASSA-PSS; hashAlgorithm defaults to SHA-1.
        if (!algorithm.remaining)
            return 'sha256';
        const params = readTlv(algorithm, 0x30).reader;
        while (params.remaining) {
            const field = readTlv(params);
            if (field.tag !== 0xa0)
                continue;
            const hashAlgorithm = readTlv(field.reader, 0x30).reader, hashOid = hex(readTlv(hashAlgorithm, 6).reader.bytes);
            const known = new Map([['2b0e03021a', 'sha256'], ['608648016503040201', 'sha256'], ['608648016503040202', 'sha384'], ['608648016503040203', 'sha512'], ['608648016503040204', 'sha224']]);
            requireThat(known.has(hashOid), 'CERT_HASH', 'Unsupported RSA-PSS certificate hash');
            return known.get(hashOid);
        }
        return 'sha256';
    }
    throw new Error('Unsupported certificate signature algorithm for NTLM TLS channel binding');
}
export function tlsChannelBinding(certificate) {
    const certHash = digest(certificateDigestAlgorithm(certificate.raw), certificate.raw), prefix = new TextEncoder().encode('tls-server-end-point:');
    // GSS channel bindings: address types/lengths, then application-data length/data.
    const bindings = new Writer().zeros(16).u32le(prefix.length + certHash.length).put(prefix).put(certHash).finish();
    return digest('md5', bindings);
}
export function validatePeerCertificate(socket, target, now = Date.now()) {
    const peer = socket.getPeerCertificate(), raw = peer?.raw;
    requireThat(raw?.length > 0 && raw.length <= 1024 * 1024, 'CERT_MISSING', 'Server did not provide a certificate');
    const certificate = new X509Certificate(raw), fingerprint = digest('sha256', raw);
    requireThat(now >= Date.parse(certificate.validFrom) && now <= Date.parse(certificate.validTo), 'CERT_VALIDITY', 'Server certificate is expired or not yet valid');
    if (target.certSha256) {
        const expected = Buffer.from(target.certSha256.replaceAll(':', ''), 'hex');
        requireThat(expected.length === 32 && timingSafeEqual(expected, fingerprint), 'CERT_PIN', 'Server certificate does not match the configured SHA-256 pin');
    }
    else
        requireThat(socket.authorized, 'CERT_TRUST', `Server certificate verification failed: ${socket.authorizationError || 'untrusted certificate'}`);
    return { certificate, metadata: { sha256: hex(fingerprint), subject: certificate.subject, issuer: certificate.issuer, validTo: certificate.validTo, trust: target.certSha256 ? 'pinned certificate' : 'certificate authority', tls: socket.getProtocol() } };
}

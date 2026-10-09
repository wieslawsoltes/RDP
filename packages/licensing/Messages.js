import { Reader } from '../binary/Reader.js';
import { Writer, utf16 } from '../binary/Writer.js';
import { ProtocolError, requireThat } from '../binary/ProtocolError.js';

export const LicenseType = Object.freeze({ REQUEST: 1, CHALLENGE: 2, NEW: 3, UPGRADE: 4, INFO: 0x12, NEW_REQUEST: 0x13, RESPONSE: 0x15, ERROR: 0xff });
export const MAX_LICENSE_PDU = 65535;
export const MAX_LICENSE_DATA = 60000;
const utf16Decoder = new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true });
// Node builds with different ICU data can decode 0x80..0x9f as Latin-1.
// Pin Windows-1252 instead of making protocol metadata depend on the host ICU.
const c1 = [0x20ac,0x81,0x201a,0x192,0x201e,0x2026,0x2020,0x2021,
    0x2c6,0x2030,0x160,0x2039,0x152,0x8d,0x17d,0x8f,
    0x90,0x2018,0x2019,0x201c,0x201d,0x2022,0x2013,0x2014,
    0x2dc,0x2122,0x161,0x203a,0x153,0x9d,0x17e,0x178];
const ansiChars = Array.from({ length: 256 }, (_, i) => String.fromCodePoint(i >= 128 && i < 160 ? c1[i - 128] : i));
const ansiMap = new Map(ansiChars.map((char, i) => [char, i]));

/** Protocol strings are counted in BYTES, including their terminator. */
export function licenseString(bytes, unicode = false) {
    requireThat(bytes.length >= (unicode ? 2 : 1) && bytes.length <= 4096 && (!unicode || bytes.length % 2 === 0),
        'LICENSE_STRING', 'Invalid licensing string length');
    requireThat(bytes[bytes.length - 1] === 0 && (!unicode || bytes[bytes.length - 2] === 0),
        'LICENSE_STRING', 'Licensing string lacks its terminator');
    let value;
    try { value = unicode ? utf16Decoder.decode(bytes.subarray(0, bytes.length - 2)) : Array.from(bytes.subarray(0, -1), b => ansiChars[b]).join(''); }
    catch { throw new ProtocolError('LICENSE_STRING', 'Invalid licensing string encoding'); }
    requireThat(!value.includes('\0'), 'LICENSE_STRING', 'Embedded licensing string terminator');
    return value;
}
export function encodeLicenseString(value, unicode = false) {
    requireThat(typeof value === 'string' && value.length <= 2047 && !value.includes('\0'), 'LICENSE_STRING', 'Invalid licensing string');
    if (unicode) {
        requireThat(value.isWellFormed(), 'LICENSE_STRING', 'Invalid UTF-16 licensing string');
        return utf16(value + '\0');
    }
    const out = [];
    for (const char of value) {
        requireThat(ansiMap.has(char), 'LICENSE_ANSI', 'Licensing metadata requires Windows-1252 characters; configure a licensing user alias');
        out.push(ansiMap.get(char));
    }
    return Uint8Array.from([...out, 0]);
}
export function readBlob(r, expected, max = MAX_LICENSE_PDU) {
    const type = r.u16le(), length = r.u16le();
    requireThat((expected === undefined || type === expected) && length <= max, 'LICENSE_BLOB', 'Invalid licensing blob type or size');
    return r.take(length);
}
export function putBlob(w, type, bytes) {
    requireThat(bytes instanceof Uint8Array && bytes.length <= 65535, 'LICENSE_BLOB', 'Licensing blob exceeds its length field');
    return w.u16le(type).u16le(bytes.length).put(bytes);
}
export function readCounted(r, max) {
    const size = r.u32le();
    requireThat(size <= max, 'LICENSE_LENGTH', 'Licensing field exceeds its resource limit');
    return r.take(size);
}
export function putCounted(w, bytes) { return w.u32le(bytes.length).put(bytes); }
export function parseLicenseHeader(bytes) {
    requireThat(bytes instanceof Uint8Array && bytes.length >= 4 && bytes.length <= MAX_LICENSE_PDU, 'LICENSE_LENGTH', 'Invalid licensing PDU length');
    const r = new Reader(bytes), type = r.u8(), flags = r.u8(), size = r.u16le(), version = flags & 15;
    requireThat(size === bytes.length && [2, 3].includes(version) && !(flags & 0x70), 'LICENSE_HEADER', 'Invalid licensing preamble');
    return { type, version, extendedError: !!(flags & 0x80), reader: r };
}
export function licensePdu(type, body, version = 3) {
    requireThat(body instanceof Uint8Array && body.length <= MAX_LICENSE_PDU - 4 && [2, 3].includes(version), 'LICENSE_LENGTH', 'Licensing PDU exceeds its length field');
    return new Writer().u8(type).u8(version | 0x80).u16le(body.length + 4).put(body).finish();
}
export function parseLicenseRequest(r) {
    const serverRandom = r.take(32).slice(), version = r.u32le();
    const company = licenseString(readCounted(r, 4096), true), product = licenseString(readCounted(r, 4096), true);
    const algorithms = new Reader(readBlob(r, 13, 256));
    requireThat(algorithms.remaining > 0 && algorithms.remaining % 4 === 0, 'LICENSE_ALGORITHM', 'Invalid licensing key exchange list');
    let rsa = false;
    while (algorithms.remaining) rsa = algorithms.u32le() === 1 || rsa;
    requireThat(rsa, 'LICENSE_ALGORITHM', 'Server does not offer RSA licensing exchange');
    const certificate = readBlob(r, 3).slice(), count = r.u32le(), scopes = [];
    requireThat(count > 0 && count <= 64, 'LICENSE_SCOPES', 'Invalid licensing scope count');
    for (let i = 0; i < count; i++) scopes.push(licenseString(readBlob(r, 14, 4096)));
    r.end();
    return { serverRandom, version, company, product, certificate, scopes };
}
export function parseNewLicense(bytes) {
    const r = new Reader(bytes), version = r.u32le(), scope = licenseString(readCounted(r, 4096));
    const company = licenseString(readCounted(r, 4096), true), product = licenseString(readCounted(r, 4096), true);
    const data = readCounted(r, MAX_LICENSE_DATA).slice();
    requireThat(data.length > 0, 'LICENSE_DATA', 'Server sent an empty client license');
    r.end();
    return { version, scope, company, product, data };
}
export function parseLicenseError(r) {
    const code = r.u32le(), transition = r.u32le(), detailBytes = readBlob(r, 4).length;
    r.end();
    requireThat(transition >= 1 && transition <= 4, 'LICENSE_TRANSITION', 'Invalid licensing state transition');
    return { code, transition, detailBytes };
}

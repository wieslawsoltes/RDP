import { Reader } from '../binary/Reader.js';
import { sequence, integer, octet, explicit, readTlv, readInteger } from '../binary/Asn1.js';
import { requireThat } from '../binary/ProtocolError.js';
export function tsRequest({ version = 6, token, authInfo, pubKeyAuth, errorCode, nonce }) {
    const parts = [explicit(0, integer(version))];
    if (token)
        parts.push(explicit(1, sequence(sequence(explicit(0, octet(token))))));
    if (authInfo)
        parts.push(explicit(2, octet(authInfo)));
    if (pubKeyAuth)
        parts.push(explicit(3, octet(pubKeyAuth)));
    if (errorCode !== undefined)
        parts.push(explicit(4, integer(errorCode)));
    if (nonce)
        parts.push(explicit(5, octet(nonce)));
    return sequence(...parts);
}
export function parseTsRequest(bytes) {
    const r = new Reader(bytes), body = readTlv(r, 0x30).reader;
    r.end();
    const result = {}, seen = new Set();
    while (body.remaining) {
        const f = readTlv(body), tag = f.tag;
        requireThat(tag >= 0xa0 && tag <= 0xa5 && !seen.has(tag), 'CREDSSP_FIELD', 'Invalid CredSSP field');
        seen.add(tag);
        const value = f.reader;
        if (tag === 0xa0)
            result.version = readInteger(value);
        if (tag === 0xa1) {
            const list = readTlv(value, 0x30).reader, item = readTlv(list, 0x30).reader;
            list.end();
            const token = readTlv(item, 0xa0).reader;
            item.end();
            result.token = readTlv(token, 4).reader.bytes;
            token.end();
        }
        if ([0xa2, 0xa3, 0xa5].includes(tag))
            result[tag === 0xa2 ? 'authInfo' : tag === 0xa3 ? 'pubKeyAuth' : 'nonce'] = readTlv(value, 4).reader.bytes;
        if (tag === 0xa4)
            result.errorCode = readInteger(value);
        value.end();
    }
    requireThat(result.version >= 5 && result.version <= 6, 'CREDSSP_VERSION', 'CredSSP versions below 5 are disabled; no insecure downgrade');
    requireThat(result.errorCode === undefined || result.errorCode === 0, 'NLA_REJECTED', `NLA authentication rejected (0x${(result.errorCode ?? 0).toString(16).padStart(8, '0')})`);
    return result;
}
export function passwordCredentials(domain, username, password) {
    // Credentials use UTF-16LE, not UTF-8.
    const u16 = text => {
        const b = new Uint8Array(text.length * 2), v = new DataView(b.buffer);
        for (let i = 0; i < text.length; i++)
            v.setUint16(i * 2, text.charCodeAt(i), true);
        return b;
    };
    const fields = [domain, username, password].map(u16), passwordCreds = sequence(...fields.map((b, i) => explicit(i, octet(b))));
    const result = sequence(explicit(0, integer(1)), explicit(1, octet(passwordCreds)));
    fields.forEach(b => b.fill(0));
    passwordCreds.fill(0);
    return result;
}

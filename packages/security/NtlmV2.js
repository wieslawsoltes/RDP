import { createHmac, randomBytes } from 'node:crypto';
import { Reader } from '../binary/Reader.js';
import { Writer, concat, utf16 } from '../binary/Writer.js';
import { requireThat } from '../binary/ProtocolError.js';
import { md4 } from './Md4.js';
import { Rc4 } from './Rc4.js';
import { NtlmSeal } from './NtlmSeal.js';
const SIGNATURE = new TextEncoder().encode('NTLMSSP\0');
const VERSION = Uint8Array.of(10, 0, 0, 0, 0, 0, 0, 15);
export const NTLM_FLAGS = 0xe2888235;
export const hmacMd5 = (key, ...parts) => {
    const h = createHmac('md5', key);
    for (const part of parts)
        h.update(part);
    return new Uint8Array(h.digest());
};
function securityBuffer(r, bytes, minimum) {
    const length = r.u16le(), maximum = r.u16le(), offset = r.u32le();
    requireThat(maximum >= length && offset <= bytes.length && length <= bytes.length - offset && (length === 0 || offset >= minimum), 'NTLM_BUFFER', 'Invalid NTLM security buffer');
    return bytes.subarray(offset, offset + length);
}
export function parseAvPairs(bytes) {
    const r = new Reader(bytes), pairs = new Map();
    while (r.remaining) {
        const type = r.u16le(), length = r.u16le();
        if (type === 0) {
            requireThat(length === 0, 'NTLM_AV', 'Invalid NTLM AV terminator');
            r.end();
            return pairs;
        }
        requireThat(pairs.size < 64 && !pairs.has(type), 'NTLM_AV', 'Duplicate or excessive NTLM AV pairs');
        const value = r.take(length).slice();
        requireThat((type !== 6 || length === 4) && (type !== 7 || length === 8) && (type !== 10 || length === 16), 'NTLM_AV_LENGTH', 'Invalid NTLM AV pair length');
        pairs.set(type, value);
    }
    throw new Error('NTLM target information lacks a terminator');
}
export function encodeAvPairs(pairs) {
    const w = new Writer();
    for (const [type, value] of pairs)
        w.u16le(type).u16le(value.length).put(value);
    return w.u16le(0).u16le(0).finish();
}
export function ntlmV2Response({ password, username, domain, serverChallenge, clientChallenge, timestamp, targetInfo }) {
    requireThat(serverChallenge.length === 8 && clientChallenge.length === 8 && timestamp.length === 8, 'NTLM_CHALLENGE', 'Invalid NTLM nonce or time');
    const passwordBytes = utf16(password), ntHash = md4(passwordBytes);
    passwordBytes.fill(0);
    const responseKey = hmacMd5(ntHash, utf16(username.toUpperCase() + domain));
    ntHash.fill(0);
    const blob = new Writer().u8(1).u8(1).zeros(6).put(timestamp).put(clientChallenge).zeros(4).put(targetInfo).zeros(4).finish();
    const proof = hmacMd5(responseKey, serverChallenge, blob), response = concat(proof, blob);
    const lmResponse = concat(hmacMd5(responseKey, serverChallenge, clientChallenge), clientChallenge), sessionBaseKey = hmacMd5(responseKey, proof);
    responseKey.fill(0);
    return { response, lmResponse, sessionBaseKey };
}
export class NtlmV2 {
    constructor({ username, domain = '', password, serviceName, channelBinding }) {
        for (const value of [username, domain, password, serviceName])
            requireThat(typeof value === 'string' && value.length <= 1024 && !value.includes('\0'), 'NTLM_CREDENTIAL', 'Invalid NTLM credential field');
        requireThat(username.length > 0 && channelBinding instanceof Uint8Array && channelBinding.length === 16, 'NTLM_CREDENTIAL', 'NLA needs a user name and TLS channel binding');
        this.username = username;
        this.domain = domain;
        this.password = password;
        this.serviceName = serviceName;
        this.channelBinding = channelBinding;
        this.state = 'new';
    }
    negotiate() {
        requireThat(this.state === 'new', 'NTLM_STATE', 'NTLM negotiation already started');
        this.state = 'challenge';
        this.type1 = new Writer().put(SIGNATURE).u32le(1).u32le(NTLM_FLAGS).zeros(16).put(VERSION).finish();
        return this.type1;
    }
    authenticate(challenge) {
        requireThat(this.state === 'challenge' && challenge.length <= 65536, 'NTLM_STATE', 'Unexpected NTLM challenge');
        const r = new Reader(challenge);
        requireThat(r.ascii(8) === 'NTLMSSP\0' && r.u32le() === 2, 'NTLM_TYPE', 'Expected NTLM challenge');
        const target = securityBuffer(r, challenge, 48), flags = r.u32le(), nonce = r.take(8);
        r.skip(8);
        const info = securityBuffer(r, challenge, flags & 0x02000000 ? 56 : 48);
        const required = 1 | 0x10 | 0x20 | 0x200 | 0x80000 | 0x800000 | 0x20000000;
        requireThat((flags & required) === required && (target.length & 1) === 0, 'NTLM_POLICY', 'Server must support NTLMv2 Unicode, signing, sealing, target info, and 128-bit extended session security');
        if (flags & 0x02000000)
            r.skip(8);
        const pairs = parseAvPairs(info), serverTime = pairs.get(7);
        const timestamp = serverTime || new Writer().u64le((BigInt(Date.now()) + 11644473600000n) * 10000n).finish();
        const avFlags = pairs.has(6) ? new Reader(pairs.get(6)).u32le() : 0;
        pairs.set(6, new Writer().u32le(avFlags | 2).finish()); // MIC present; bind negotiation against tampering.
        pairs.set(9, utf16(this.serviceName));
        pairs.set(10, this.channelBinding.slice());
        const result = ntlmV2Response({ password: this.password, username: this.username, domain: this.domain, serverChallenge: nonce, clientChallenge: randomBytes(8), timestamp, targetInfo: encodeAvPairs(pairs) });
        this.password = '';
        const selected = (flags & NTLM_FLAGS) >>> 0, exchange = !!(selected & 0x40000000);
        const exportedKey = exchange ? new Uint8Array(randomBytes(16)) : result.sessionBaseKey.slice();
        const rc4 = new Rc4(result.sessionBaseKey), encryptedKey = exchange ? rc4.transform(exportedKey) : new Uint8Array();
        rc4.destroy();
        result.sessionBaseKey.fill(0);
        const payloads = [serverTime ? new Uint8Array(24) : result.lmResponse, result.response, utf16(this.domain), utf16(this.username), utf16('LRDP-WEB'), encryptedKey];
        const hasVersion = !!(selected & 0x02000000), micOffset = 64 + (hasVersion ? 8 : 0), headerSize = micOffset + 16;
        const w = new Writer().put(SIGNATURE).u32le(3);
        let offset = headerSize;
        for (const payload of payloads) {
            w.u16le(payload.length).u16le(payload.length).u32le(offset);
            offset += payload.length;
        }
        w.u32le(selected);
        if (hasVersion)
            w.put(VERSION);
        w.zeros(16);
        for (const payload of payloads)
            w.put(payload);
        const authenticate = w.finish();
        authenticate.set(hmacMd5(exportedKey, this.type1, challenge, authenticate), micOffset);
        this.outgoing = new NtlmSeal(exportedKey, 'client-to-server', exchange);
        this.incoming = new NtlmSeal(exportedKey, 'server-to-client', exchange);
        exportedKey.fill(0);
        result.response.fill(0);
        result.lmResponse.fill(0);
        encryptedKey.fill(0);
        this.type1.fill(0);
        this.type1 = null;
        this.state = 'authenticated';
        return authenticate;
    }
    destroy() { this.password = ''; this.type1?.fill(0); this.type1 = null; this.outgoing?.destroy(); this.incoming?.destroy(); this.state = 'closed'; }
}

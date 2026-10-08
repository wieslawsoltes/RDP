import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Writer, concat } from '../binary/Writer.js';
import { Reader } from '../binary/Reader.js';
import { requireThat } from '../binary/ProtocolError.js';
import { Rc4 } from './Rc4.js';
const hash = (...parts) => {
    const h = createHash('md5');
    for (const p of parts)
        h.update(p);
    return h.digest();
};
const mac = (key, ...parts) => {
    const h = createHmac('md5', key);
    for (const p of parts)
        h.update(p);
    return h.digest();
};
export class NtlmSeal {
    constructor(exportedKey, direction, keyExchange = true) {
        requireThat(exportedKey.length === 16 && ['client-to-server', 'server-to-client'].includes(direction), 'NTLM_SEAL', 'Invalid NTLM sealing configuration');
        this.signingKey = hash(exportedKey, `session key to ${direction} signing key magic constant\0`);
        const key = hash(exportedKey, `session key to ${direction} sealing key magic constant\0`);
        this.cipher = new Rc4(key);
        key.fill(0);
        this.sequence = 0;
        this.keyExchange = keyExchange;
        this.closed = false;
    }
    seal(plain) {
        requireThat(!this.closed && this.sequence < 0xffffffff && plain.length <= 1048576, 'NTLM_SEQUENCE', 'NTLM sealing limit');
        const sequence = new Writer().u32le(this.sequence++).finish();
        let checksum = mac(this.signingKey, sequence, plain).subarray(0, 8);
        const encrypted = this.cipher.transform(plain);
        if (this.keyExchange)
            checksum = this.cipher.transform(checksum);
        return new Writer().u32le(1).put(checksum).put(sequence).put(encrypted).finish();
    }
    unseal(message) {
        requireThat(!this.closed && this.sequence < 0xffffffff && message.length <= 1048592, 'NTLM_SEQUENCE', 'NTLM unsealing limit');
        const r = new Reader(message);
        requireThat(r.u32le() === 1, 'NTLM_SIGNATURE', 'Unsupported NTLM signature version');
        const signature = r.take(8);
        requireThat(r.u32le() === this.sequence, 'NTLM_SEQUENCE', 'NTLM sequence number mismatch');
        const plain = this.cipher.transform(r.take(r.remaining)), sequence = new Writer().u32le(this.sequence).finish();
        let expected = mac(this.signingKey, sequence, plain).subarray(0, 8);
        if (this.keyExchange)
            expected = this.cipher.transform(expected);
        if (!timingSafeEqual(expected, signature)) {
            plain.fill(0);
            this.destroy();
            throw new Error('NTLM message signature verification failed');
        }
        this.sequence++;
        return plain;
    }
    destroy() { this.signingKey.fill(0); this.cipher.destroy(); this.closed = true; }
}

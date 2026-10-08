import { requireThat } from '../binary/ProtocolError.js';
/** Stateful RC4 ONLY for the NTLM session-security wire format inside TLS. */
export class Rc4 {
    constructor(key) {
        requireThat(key instanceof Uint8Array && key.length >= 1 && key.length <= 256, 'RC4_KEY', 'Invalid RC4 key');
        this.s = Uint8Array.from({ length: 256 }, (_, i) => i);
        this.i = 0;
        this.j = 0;
        this.closed = false;
        for (let i = 0, j = 0; i < 256; i++) {
            j = (j + this.s[i] + key[i % key.length]) & 255;
            [this.s[i], this.s[j]] = [this.s[j], this.s[i]];
        }
    }
    transform(bytes) {
        requireThat(!this.closed, 'RC4_CLOSED', 'Cipher has been disposed');
        const out = new Uint8Array(bytes.length), s = this.s;
        for (let k = 0; k < bytes.length; k++) {
            this.i = (this.i + 1) & 255;
            this.j = (this.j + s[this.i]) & 255;
            [s[this.i], s[this.j]] = [s[this.j], s[this.i]];
            out[k] = bytes[k] ^ s[(s[this.i] + s[this.j]) & 255];
        }
        return out;
    }
    destroy() { this.s.fill(0); this.i = this.j = 0; this.closed = true; }
}

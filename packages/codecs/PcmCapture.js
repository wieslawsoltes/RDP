import { requireThat } from '../binary/ProtocolError.js';

export const MAX_CAPTURE_FRAMES = 8192;
export function supportedCaptureFormat(f) {
    return f?.tag === 1 && f.bits === 16 && f.extraSize === 0 &&
        [1, 2].includes(f.channels) && Number.isInteger(f.sampleRate) &&
        f.sampleRate >= 8000 && f.sampleRate <= 96000 &&
        f.blockAlign === f.channels * 2 && f.bytesPerSecond === f.sampleRate * f.blockAlign;
}
const TAPS = 48, HALF = TAPS / 2, PHASES = 256, MASK = 127;
const clean = value => Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
const sample = value => { value = clean(value); return Math.round(value < 0 ? value * 32768 : value * 32767); };

/** Windowed-sinc low-pass table. A direct path preserves matching-rate PCM.
 * Tables and bounded histories are per stream; no captured samples are cached.
 */
function coefficients(inputRate, outputRate) {
    const cutoff = Math.min(1, outputRate / inputRate) * 0.9;
    const table = new Float64Array(TAPS * PHASES);
    for (let p = 0; p < PHASES; p++) {
        let sum = 0;
        for (let k = 0; k < TAPS; k++) {
            const t = k - HALF + 1 - p / PHASES, x = Math.PI * t * cutoff;
            const window = Math.abs(t) >= HALF ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * t / HALF) + 0.08 * Math.cos(2 * Math.PI * t / HALF);
            const value = cutoff * (Math.abs(x) < 1e-12 ? 1 : Math.sin(x) / x) * window;
            table[p * TAPS + k] = value; sum += value;
        }
        for (let k = 0; k < TAPS; k++) table[p * TAPS + k] /= sum;
    }
    return table;
}

/** Streaming Float32 mono/stereo -> interleaved PCM16LE in exact server packet
 * sizes. Resampling uses rational phase accumulation and a 48-tap polyphase
 * low-pass FIR (24-source-frame lookahead); no growing input/output queues.
 * emit borrows each completed packet only during the callback. Copy to retain.
 */
export class PcmCapture {
    constructor({ inputRate, format, framesPerPacket, emit }) {
        requireThat(Number.isInteger(inputRate) && inputRate >= 8000 && inputRate <= 192000 &&
            supportedCaptureFormat(format) && Number.isInteger(framesPerPacket) &&
            framesPerPacket >= 1 && framesPerPacket <= MAX_CAPTURE_FRAMES && typeof emit === 'function',
            'MIC_FORMAT', 'Unsupported PCM capture configuration');
        this.inputRate = inputRate; this.format = { ...format }; this.framesPerPacket = framesPerPacket; this.emit = emit;
        this.table = inputRate === format.sampleRate ? null : coefficients(inputRate, format.sampleRate);
        this.history = [new Float32Array(MASK + 1), new Float32Array(MASK + 1)];
        this.packet = new Uint8Array(framesPerPacket * format.blockAlign);
        this.view = new DataView(this.packet.buffer); this.closed = false; this.reset();
    }
    push(planes) {
        requireThat(!this.closed && Array.isArray(planes) && planes.length >= 1 && planes.length <= 2 &&
            planes[0] instanceof Float32Array && planes[0].length > 0 && planes[0].length <= 4096 &&
            planes.every(p => p instanceof Float32Array && p.length === planes[0].length),
            'MIC_SAMPLES', 'Invalid bounded capture chunk');
        for (let i = 0; i < planes[0].length; i++) {
            const left = clean(planes[0][i]), right = clean((planes[1] || planes[0])[i]);
            if (!this.table) { this.output(left, right); continue; }
            const slot = this.received++ & MASK;
            this.history[0][slot] = left; this.history[1][slot] = right;
            while (this.center + HALF < this.received) {
                const phase = Math.floor(this.fraction * PHASES / this.format.sampleRate) * TAPS;
                let l = 0, r = 0;
                for (let k = 0; k < TAPS; k++) {
                    const at = this.center - HALF + 1 + k;
                    if (at < 0) continue;
                    const weight = this.table[phase + k];
                    l += this.history[0][at & MASK] * weight; r += this.history[1][at & MASK] * weight;
                }
                this.output(l, r);
                this.fraction += this.inputRate;
                this.center += Math.floor(this.fraction / this.format.sampleRate);
                this.fraction %= this.format.sampleRate;
            }
        }
    }
    output(left, right) {
        if (this.format.channels === 1) this.view.setInt16(this.at, sample((left + right) * 0.5), true);
        else {
            this.view.setInt16(this.at, sample(left), true);
            this.view.setInt16(this.at + 2, sample(right), true);
        }
        this.at += this.format.blockAlign;
        if (this.at === this.packet.length) {
            this.at = 0;
            try { this.emit(this.packet); } finally { this.packet.fill(0); }
        }
    }
    reset() {
        this.received = this.center = this.fraction = this.at = 0;
        for (const h of this.history) h.fill(0);
        this.packet.fill(0);
    }
    close() { this.reset(); this.closed = true; this.emit = () => {}; }
}

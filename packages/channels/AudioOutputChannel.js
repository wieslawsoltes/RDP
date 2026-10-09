import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { ProtocolError, requireThat } from '../binary/ProtocolError.js';
import { supportedPcm, decodePcm } from '../codecs/Pcm.js';

const VERSION = 8, MAX_PENDING = 16, MAX_DECODED = 2 * 1024 * 1024;
export function soundPdu(type, body = new Uint8Array()) {
    requireThat(body instanceof Uint8Array && body.length <= 65535, 'AUDIO_LENGTH', 'Audio PDU exceeds 16-bit length');
    return new Writer().u8(type).u8(0).u16le(body.length).put(body).finish();
}

/** MS-RDPEA static-channel PCM client. No UDP, compressed codecs or input capture. */
export class AudioOutputChannel {
    constructor(send, emit = () => {}, { now = () => performance.now() } = {}) {
        this.send = send; this.emit = emit; this.now = now;
        this.formats = []; this.version = 0; this.wave = null; this.closed = false;
        this.pending = new Map(); this.nextId = 1; this.queuedBytes = 0;
        this.received = 0; this.played = 0; this.dropped = 0; this.rejected = 0;
    }
    receive(bytes) {
        if (this.closed) return;
        try { this.packet(bytes); }
        catch (error) {
            if (!(error instanceof ProtocolError)) throw error;
            this.wave?.first.fill(0); this.wave = null;
            this.rejected++;
            // MS-RDPEA 3.1.5: malformed/unknown/out-of-sequence PDUs are ignored.
            // Rate-limit diagnostics without pretending the audio was consumed.
            if ((this.rejected & (this.rejected - 1)) === 0)
                this.emit({ kind: 'rejected', code: error.code, rejected: this.rejected });
        }
    }
    packet(bytes) {
        requireThat(bytes instanceof Uint8Array && bytes.length <= 65539, 'AUDIO_LENGTH', 'Excessive audio message');
        const r = new Reader(bytes);
        if (this.wave) {
            const wave = this.wave; this.wave = null;
            try {
                requireThat(bytes.length === wave.length && r.u32le() === 0, 'AUDIO_WAVE', 'Invalid split Wave PDU');
                const data = new Uint8Array(wave.length);
                data.set(wave.first); data.set(r.take(r.remaining), 4);
                try { this.deliver(wave, data); } finally { data.fill(0); }
            } finally { wave.first.fill(0); }
            return;
        }
        const type = r.u8(); r.u8(); const size = r.u16le();
        if (type === 2) {
            requireThat(r.remaining === 12 && size >= 12, 'AUDIO_WAVE', 'Invalid WaveInfo size');
            const wave = this.waveHeader(r);
            const length = size - 8;
            this.checkWave(wave.format, length);
            this.wave = { ...wave, length, first: r.take(4).slice() };
            return;
        }
        requireThat(size === r.remaining, 'AUDIO_LENGTH', 'Audio body size mismatch');
        if (type === 7) { this.negotiate(r); return; }
        requireThat(this.version !== 0, 'AUDIO_STATE', 'Audio data before formats');
        if (type === 6) {
            const timestamp = r.u16le(), packetSize = r.u16le();
            requireThat(packetSize === (r.remaining ? bytes.length : 0), 'AUDIO_TRAINING', 'Training size mismatch');
            r.skip(r.remaining);
            this.send(soundPdu(6, new Writer().u16le(timestamp).u16le(packetSize).finish()));
        } else if (type === 13) {
            requireThat(this.version >= 8, 'AUDIO_VERSION', 'Wave2 requires version 8');
            const wave = this.waveHeader(r); wave.audioTimestamp = r.u32le();
            this.deliver(wave, r.take(r.remaining));
        } else if (type === 1) {
            r.end(); this.emit({ kind: 'stream-ended' });
            // Already queued audio drains normally and still receives confirmation.
        }
        // Volume/pitch and UDP/crypt PDUs are not negotiated; ignore unknown PDUs.
    }
    waveHeader(r) {
        const timestamp = r.u16le(), format = r.u16le(), block = r.u8();
        r.skip(3);
        return { timestamp, format, block };
    }
    checkWave(index, bytes) {
        const format = this.formats[index];
        requireThat(this.version !== 0 && format && bytes <= 65535 && bytes % format.blockAlign === 0,
            'AUDIO_FORMAT', 'Audio data references an unnegotiated format or partial sample');
        return format;
    }
    negotiate(r) {
        r.skip(14); const count = r.u16le(), lastBlock = r.u8(), serverVersion = r.u16le(); r.u8();
        requireThat(count <= 128 && serverVersion >= 2, 'AUDIO_FORMATS', 'Unsupported format list or version');
        const selected = [], wire = [];
        for (let i = 0; i < count; i++) {
            const start = r.offset;
            const format = { tag: r.u16le(), channels: r.u16le(), sampleRate: r.u32le(), bytesPerSecond: r.u32le(),
                blockAlign: r.u16le(), bits: r.u16le(), extraSize: r.u16le() };
            r.skip(format.extraSize);
            if (supportedPcm(format) && selected.length < 64) {
                selected.push(Object.freeze(format)); wire.push(r.bytes.subarray(start, r.offset));
            }
        }
        r.end();
        this.emit({ kind: 'reset' }); // Host drops previous-epoch samples before accepting new ones.
        this.formats = selected; this.version = Math.min(serverVersion, VERSION);
        const reply = new Writer().u32le(1).u32le(0xffffffff).u32le(0x10000).u16be(0)
            .u16le(selected.length).u8(lastBlock).u16le(VERSION).u8(0);
        for (const format of wire) reply.put(format);
        this.send(soundPdu(7, reply.finish()));
        if (this.version >= 6) this.send(soundPdu(12, new Writer().u16le(2).u16le(0).finish()));
        this.emit({ kind: 'formats', version: this.version, formats: selected.map(format => ({ ...format })) });
    }
    deliver(wave, data) {
        const format = this.checkWave(wave.format, data.length), frames = data.length / format.blockAlign;
        const bytes = frames * format.channels * 4, receivedAt = this.now();
        this.received++;
        if (!frames || frames / format.sampleRate > 2 || this.pending.size >= MAX_PENDING || this.queuedBytes + bytes > MAX_DECODED) {
            this.dropped++; this.confirm({ ...wave, receivedAt }); return;
        }
        const samples = decodePcm(data, format), id = this.nextId++;
        this.pending.set(id, { ...wave, receivedAt, bytes }); this.queuedBytes += bytes;
        this.emit({ kind: 'samples', id, ...samples });
    }
    consume(id, disposition = 'dropped') {
        if (this.closed) return false;
        const wave = this.pending.get(id);
        if (!wave || !['played', 'dropped'].includes(disposition)) return false;
        this.pending.delete(id); this.queuedBytes -= wave.bytes;
        this[disposition]++;
        this.confirm(wave); return true;
    }
    confirm(wave) {
        const elapsed = Math.max(0, Math.min(0x7fffffff, Math.floor(this.now() - wave.receivedAt)));
        this.send(soundPdu(5, new Writer().u16le((wave.timestamp + elapsed) & 0xffff).u8(wave.block).u8(0).finish()));
    }
    stats() { return { received: this.received, played: this.played, dropped: this.dropped,
        rejected: this.rejected, pending: this.pending.size, queuedBytes: this.queuedBytes }; }
    close() {
        if (this.closed) return;
        this.closed = true; this.wave?.first.fill(0); this.wave = null;
        this.pending.clear(); this.queuedBytes = 0; this.formats = [];
        this.emit({ kind: 'closed' });
    }
}

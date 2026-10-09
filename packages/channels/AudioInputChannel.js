import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { ProtocolError, requireThat } from '../binary/ProtocolError.js';
import { PcmCapture, supportedCaptureFormat, MAX_CAPTURE_FRAMES } from '../codecs/PcmCapture.js';

export const AUDIO_INPUT_CHANNEL = 'AUDIO_INPUT';
const pdu = (type, n) => new Writer().u8(type).u32le(n).finish();
function readFormat(r) {
    const f = { tag: r.u16le(), channels: r.u16le(), sampleRate: r.u32le(), bytesPerSecond: r.u32le(),
        blockAlign: r.u16le(), bits: r.u16le(), extraSize: r.u16le() };
    requireThat(f.extraSize <= 4096, 'MIC_FORMAT', 'Excessive capture format extension');
    r.skip(f.extraSize); return f;
}

/** MS-RDPEAI v1/v2 reliable DVC client. Offering a channel is NOT capture consent.
 * A host must confirm real device readiness for this exact request/capture ID.
 * Malformed and out-of-sequence server PDUs are ignored per section 3.1.5.
 */
export class AudioInputChannel {
    constructor(send, emit = () => {}, { nextRequest = (() => { let id = 0; return () => ++id; })(), canSend = () => true } = {}) {
        this.send = send; this.emit = emit; this.nextRequest = nextRequest; this.canSend = canSend;
        this.state = 'version'; this.formats = []; this.requestId = this.captureId = 0;
        this.rejected = this.sentPackets = this.sentBytes = this.droppedChunks = 0;
        this.encoder = null;
    }
    receive(bytes) {
        if (this.state === 'closed') return;
        try { this.packet(bytes); }
        catch (error) {
            if (!(error instanceof ProtocolError)) throw error;
            this.rejected++;
            if ((this.rejected & (this.rejected - 1)) === 0)
                this.emit({ kind: 'rejected', code: error.code, rejected: this.rejected });
        }
    }
    packet(bytes) {
        requireThat(bytes instanceof Uint8Array && bytes.length <= 256 * 1024, 'MIC_LENGTH', 'Excessive capture PDU');
        const r = new Reader(bytes), type = r.u8();
        if (type === 1) {
            requireThat(this.state === 'version', 'MIC_STATE', 'Unexpected capture version');
            const offered = r.u32le(); r.end();
            requireThat(offered >= 1, 'MIC_VERSION', 'Invalid capture version');
            this.state = 'formats'; this.send(pdu(1, Math.min(offered, 2))); return;
        }
        if (type === 2) {
            requireThat(this.state === 'formats', 'MIC_STATE', 'Unexpected capture formats');
            const count = r.u32le(); r.u32le(); // Server's cbSizeFormatsPacket is reserved, NOT a length.
            requireThat(count <= 128, 'MIC_FORMAT', 'Too many capture formats');
            const formats = [], wire = [];
            for (let i = 0; i < count; i++) {
                const start = r.offset, f = readFormat(r);
                if (supportedCaptureFormat(f) && formats.length < 64) {
                    formats.push(Object.freeze(f)); wire.push(r.bytes.subarray(start, r.offset));
                }
            }
            r.skip(r.remaining); // Optional arbitrary ExtraData must be ignored.
            const size = 9 + wire.reduce((n, v) => n + v.length, 0);
            const reply = new Writer().u8(2).u32le(formats.length).u32le(size);
            for (const f of wire) reply.put(f);
            this.formats = formats; this.state = 'open';
            this.send(Uint8Array.of(5)); this.send(reply.finish());
            this.emit({ kind: 'formats', count: formats.length }); return;
        }
        if (type === 3) {
            requireThat(this.state === 'open', 'MIC_STATE', 'Unexpected capture Open PDU');
            const frames = r.u32le(), index = r.u32le(); readFormat(r); r.end();
            requireThat(this.formats[index], 'MIC_FORMAT', 'Unnegotiated capture format');
            if (frames < 1 || frames > MAX_CAPTURE_FRAMES) {
                this.send(pdu(7, index)); this.send(pdu(4, 0x80070057));
                this.emit({ kind: 'unavailable', reason: 'Server packet size exceeds the 8192-frame capture limit' }); return;
            }
            this.index = index; this.frames = frames; this.requestId = this.nextRequest(); this.state = 'pending';
            this.emit({ kind: 'open', requestId: this.requestId, format: { ...this.formats[index] }, framesPerPacket: frames }); return;
        }
        if (type === 7) {
            requireThat(this.state === 'streaming', 'MIC_STATE', 'Capture format change before Open Reply');
            const index = r.u32le(); r.end();
            requireThat(this.formats[index], 'MIC_FORMAT', 'Unnegotiated capture format change');
            this.encoder?.close(); this.encoder = null; this.index = index;
            this.send(pdu(7, index));
            this.emit({ kind: 'format', requestId: this.requestId, format: { ...this.formats[index] } }); return;
        }
        throw new ProtocolError('MIC_MESSAGE', 'Unknown capture PDU');
    }
    ready(requestId, captureId, result = 0) {
        if (requestId !== this.requestId || !['pending', 'streaming'].includes(this.state)) return false;
        requireThat(Number.isSafeInteger(captureId) && captureId > 0 && Number.isInteger(result) &&
            (result === 0 || result >= 0x80000000 && result <= 0xffffffff), 'MIC_CAPTURE', 'Invalid capture readiness result');
        if (this.state === 'pending') {
            this.send(pdu(7, this.index)); this.send(pdu(4, result));
            this.state = result === 0 ? 'streaming' : 'open';
        }
        this.encoder?.close(); this.encoder = null;
        this.captureId = result === 0 ? captureId : 0;
        return result === 0;
    }
    pause(requestId, captureId) {
        if (requestId !== this.requestId || captureId !== this.captureId) return false;
        this.captureId = 0; this.encoder?.close(); this.encoder = null; return true;
    }
    capture({ requestId, captureId, sampleRate, planes }) {
        if (this.state !== 'streaming' || !this.captureId || requestId !== this.requestId || captureId !== this.captureId) return false;
        if (!this.canSend(this.frames * this.formats[this.index].blockAlign + 2048)) {
            this.droppedChunks++; this.encoder?.close(); this.encoder = null; return false;
        }
        if (this.encoder?.inputRate !== sampleRate) {
            this.encoder?.close();
            this.encoder = new PcmCapture({ inputRate: sampleRate, format: this.formats[this.index], framesPerPacket: this.frames,
                emit: data => {
                    if (!this.canSend(data.length + 2048)) { this.droppedChunks++; return; }
                    const packet = new Writer().u8(6).put(data).finish();
                    try { this.send(Uint8Array.of(5)); this.send(packet); this.sentPackets++; this.sentBytes += data.length; }
                    finally { packet.fill(0); }
                } });
        }
        this.encoder.push(planes); return true;
    }
    stats() { return { state: this.state, sentPackets: this.sentPackets, sentBytes: this.sentBytes, droppedChunks: this.droppedChunks, rejected: this.rejected }; }
    close() {
        if (this.state === 'closed') return;
        this.state = 'closed'; this.captureId = 0; this.encoder?.close(); this.encoder = null; this.formats = [];
        this.emit({ kind: 'closed', requestId: this.requestId });
    }
}

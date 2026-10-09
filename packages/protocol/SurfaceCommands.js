import { Reader } from '../binary/Reader.js';
import { requireThat } from '../binary/ProtocolError.js';
import { decodeNsCodec } from '../codecs/NsCodec.js';
import { MAX_SURFACE_UPDATE } from './SurfaceCapabilities.js';

const MAX_FRAME_BYTES = 64 * 1024 * 1024, MAX_RECTANGLES = 4096, MAX_ACKS = 64;
const clear = rectangles => { for (const r of rectangles) if (r.data.byteLength) r.data.fill(0); };

/** Fast-path Set/Stream Surface Bits and frame markers, NOT RDPGFX.
 * A marked frame is held until END and emitted as one indivisible render item.
 * Wire frame IDs never act as renderer receipts: local monotonic tokens avoid
 * ID wrap/reuse, forged receipt and reactivation confusion. No ACK is sent
 * until the host reports presentation of the exact emitted item.
 */
export class SurfaceCommands {
    constructor({ desktop, profile, emit, acknowledge = () => {}, nextToken = (() => { let n = 0; return () => ++n; })(),
        now = () => performance.now(), frameTimeoutMs = 15000 }) {
        requireThat(desktop && Number.isInteger(desktop.width) && desktop.width > 0 && desktop.width <= 8192 &&
            Number.isInteger(desktop.height) && desktop.height > 0 && desktop.height <= 8192 && desktop.width * desktop.height <= 16777216,
            'SURFACE_SIZE', 'Invalid primary surface');
        requireThat(Number.isInteger(frameTimeoutMs) && frameTimeoutMs >= 1 && frameTimeoutMs <= 60000,
            'SURFACE_TIMEOUT', 'Invalid surface frame timeout');
        this.desktop = { ...desktop }; this.profile = { ...profile }; this.emit = emit; this.acknowledge = acknowledge;
        this.nextToken = nextToken; this.now = now; this.frameTimeoutMs = frameTimeoutMs;
        this.current = null; this.pending = new Map(); this.closed = false;
        this.frames = this.decodedBytes = this.acknowledged = 0;
    }
    checkDeadline() {
        requireThat(!this.current || this.now() - this.current.started < this.frameTimeoutMs,
            'SURFACE_FRAME_TIMEOUT', 'Server did not finish its surface frame');
    }
    receive(bytes) {
        requireThat(!this.closed, 'SURFACE_CLOSED', 'Surface decoder is closed');
        try {
            this.checkDeadline();
            requireThat(bytes instanceof Uint8Array && bytes.length <= MAX_SURFACE_UPDATE,
                'SURFACE_LENGTH', 'Surface update exceeds negotiated bounds');
            const r = new Reader(bytes); let commands = 0, updateBytes = 0;
            while (r.remaining) {
                requireThat(++commands <= 8192, 'SURFACE_COMMANDS', 'Excessive surface commands');
                const type = r.u16le();
                if (type === 4) {
                    requireThat(this.profile.flags & 0x10, 'SURFACE_UNNEGOTIATED', 'Unnegotiated frame markers');
                    const action = r.u16le(), id = r.u32le();
                    requireThat((action === 0 || action === 1) && (!this.profile.frameAcks || id !== 0xffffffff), 'SURFACE_MARKER', 'Invalid surface frame action');
                    if (action === 0) {
                        requireThat(!this.current, 'SURFACE_MARKER', 'Nested surface frame');
                        this.current = { id, rectangles: [], bytes: 0, started: this.now() };
                    } else {
                        requireThat(!this.current || this.current.id === id, 'SURFACE_MARKER', 'Mismatched surface frame end');
                        const rectangles = this.current?.rectangles || []; this.current = null;
                        // END-only markers acknowledge preceding unmarked updates.
                        this.deliver(rectangles, id);
                    }
                    continue;
                }
                requireThat((type === 1 && (this.profile.flags & 2)) || (type === 6 && (this.profile.flags & 0x40)),
                    'SURFACE_UNNEGOTIATED', 'Unknown or unnegotiated surface command');
                const x = r.u16le(), y = r.u16le(), right = r.u16le(), bottom = r.u16le();
                const bpp = r.u8(), flags = r.u8(), reserved = r.u8(), codec = r.u8();
                const width = r.u16le(), height = r.u16le(), length = r.u32le();
                requireThat([24,32].includes(bpp) && !(flags & ~1) && reserved === 0, 'SURFACE_BITMAP', 'Unsupported surface bitmap format');
                requireThat(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16777216,
                    'SURFACE_SIZE', 'Surface bitmap exceeds dimension limits');
                // SET ignores its non-authoritative right/bottom per MS-RDPBCGR.
                const drawWidth = type === 1 ? width : right - x, drawHeight = type === 1 ? height : bottom - y;
                requireThat(drawWidth > 0 && drawHeight > 0 && drawWidth <= width && drawHeight <= height &&
                    x + drawWidth <= this.desktop.width && y + drawHeight <= this.desktop.height,
                    'SURFACE_BOUNDS', 'Surface bitmap lies outside the desktop');
                requireThat(length <= MAX_SURFACE_UPDATE, 'SURFACE_LENGTH', 'Surface payload exceeds negotiated bounds');
                if (flags & 1) r.skip(24); // Nonessential ID and two 64-bit timestamps, outside bitmapDataLength.
                const encoded = r.take(length); let bitmap;
                requireThat(updateBytes + width * height * 4 <= MAX_FRAME_BYTES,
                    'SURFACE_BUDGET', 'Surface update exceeds decoded pixel budget');
                if (codec === 0) {
                    const pixelBytes = bpp / 8, tight = width * pixelBytes, padded = (tight + 3) & ~3;
                    const stride = length === tight * height ? tight : padded;
                    requireThat(length === stride * height, 'SURFACE_LENGTH', 'Invalid uncompressed surface bitmap size');
                    bitmap = { width, height, bpp, stride, bottomUp: true, data: encoded.slice() };
                } else {
                    requireThat(codec === 1 && this.profile.nsCodec, 'SURFACE_CODEC', 'Unknown or unnegotiated surface codec');
                    bitmap = decodeNsCodec(encoded, width, height, { sourceBpp: bpp,
                        maxColorLoss: this.profile.maxColorLoss, allowSubsampling: this.profile.allowSubsampling });
                }
                updateBytes += Math.max(bitmap.data.length, width * height * 4);
                try {
                    requireThat(updateBytes <= MAX_FRAME_BYTES, 'SURFACE_BUDGET', 'Surface update exceeds decode budget');
                    this.addBitmap({ ...bitmap, x, y, drawWidth, drawHeight });
                } catch (error) { bitmap.data.fill(0); throw error; }
            }
        } catch (error) { this.close(); throw error; }
    }
    addBitmap(bitmap) {
        requireThat(!this.closed, 'SURFACE_CLOSED', 'Surface decoder is closed');
        this.decodedBytes += bitmap.data.length;
        if (this.current) {
            const size = Math.max(bitmap.data.length, bitmap.width * bitmap.height * 4);
            requireThat(this.current.rectangles.length < MAX_RECTANGLES && this.current.bytes + size <= MAX_FRAME_BYTES,
                'SURFACE_BUDGET', 'Marked surface frame exceeds its memory/rectangle budget');
            this.current.rectangles.push(bitmap); this.current.bytes += size;
        } else this.deliver([bitmap]);
    }
    deliver(rectangles, frameId = null) {
        let token = null;
        try {
            if (frameId !== null && this.profile.frameAcks) {
                requireThat(this.pending.size < MAX_ACKS, 'SURFACE_ACK_WINDOW', 'Server exceeded the outstanding surface frame limit');
                token = this.nextToken();
                requireThat(Number.isSafeInteger(token) && token > 0 && !this.pending.has(token), 'SURFACE_TOKEN', 'Invalid renderer receipt token');
                this.pending.set(token, frameId);
            }
            this.frames++; this.emit({ type: 'surface-frame', rectangles, token });
        } catch (error) { if (token !== null) this.pending.delete(token); clear(rectangles); throw error; }
    }
    presented(token) {
        if (this.closed || !this.pending.has(token)) return false;
        const id = this.pending.get(token); this.pending.delete(token);
        this.acknowledge(id); this.acknowledged++; return true;
    }
    stats() { return { frames: this.frames, decodedBytes: this.decodedBytes, awaitingPresentation: this.pending.size,
        bufferedFrameBytes: this.current?.bytes || 0, acknowledged: this.acknowledged }; }
    close() {
        this.closed = true; if (this.current) clear(this.current.rectangles);
        this.current = null; this.pending.clear();
    }
}

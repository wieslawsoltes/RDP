import { ProtocolError, requireThat } from '../binary/ProtocolError.js';

/** Bounded client -> gateway flow. Credits are returned after TCP write callbacks,
 * not after RDP application processing. Legacy gateways use bounded WS bursts.
 * Own every queued packet: protocol callers can immediately clear credentials.
 */
export class WireSendQueue {
    constructor({ send, bufferedAmount = () => 0, onError, window = 0, limit = 32 * 1024 * 1024, timeoutMs = 30000 }) {
        requireThat(Number.isSafeInteger(window) && (window === 0 || (window >= 65536 && window <= 1024 * 1024)) &&
            Number.isSafeInteger(limit) && limit >= 65536 && limit <= 32 * 1024 * 1024 &&
            Number.isSafeInteger(timeoutMs) && timeoutMs > 0, 'WIRE_OPTIONS', 'Invalid send-window configuration');
        this.send = send; this.bufferedAmount = bufferedAmount; this.onError = onError;
        this.window = window; this.limit = limit; this.timeoutMs = timeoutMs;
        this.queue = []; this.head = 0; this.bytes = this.outstanding = 0;
        this.closed = this.flushing = false; this.progress = Date.now();
    }
    enqueue(packet) {
        requireThat(!this.closed && packet instanceof Uint8Array && packet.length > 0 && packet.length <= 65536,
            'WIRE_PACKET', 'Invalid outbound RDP packet');
        requireThat(this.bytes + packet.length <= this.limit && this.queue.length - this.head < 32768,
            'WIRE_LIMIT', 'Outbound RDP queue exceeded its memory budget');
        if (this.head === this.queue.length && !this.outstanding) this.progress = Date.now();
        this.queue.push(packet.slice()); this.bytes += packet.length;
        this.flush();
    }
    acknowledge(bytes) {
        requireThat(!this.closed && this.window && Number.isSafeInteger(bytes) && bytes > 0 && bytes <= this.outstanding,
            'WIRE_CREDIT', 'Invalid gateway input acknowledgement');
        this.outstanding -= bytes; this.progress = Date.now(); this.flush();
    }
    flush() {
        if (this.closed || this.flushing) return;
        this.flushing = true;
        try {
            let burst = 0;
            while (this.head < this.queue.length) {
                const packet = this.queue[this.head];
                if (burst >= 256 * 1024 || this.bufferedAmount() + packet.length > 256 * 1024 ||
                    (this.window && this.outstanding + packet.length > this.window)) break;
                this.head++; this.bytes -= packet.length;
                if (this.window) this.outstanding += packet.length;
                try { this.send(packet); } finally { packet.fill(0); }
                burst += packet.length;
                this.progress = Date.now();
            }
            if (this.head === this.queue.length || this.head >= 1024) { this.queue = this.queue.slice(this.head); this.head = 0; }
            if (this.bytes || this.outstanding) {
                requireThat(Date.now() - this.progress < this.timeoutMs, 'WIRE_TIMEOUT', 'The gateway stopped accepting outbound RDP traffic');
                if (!this.timer) {
                    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 4);
                    this.timer.unref?.();
                }
            } else { clearTimeout(this.timer); this.timer = null; }
        } catch (error) {
            this.close(); this.onError?.(error instanceof Error ? error : new ProtocolError('WIRE_SEND', 'Outbound transport failed'));
        } finally { this.flushing = false; }
    }
    close() {
        this.closed = true; clearTimeout(this.timer); this.timer = null;
        for (let i = this.head; i < this.queue.length; i++) this.queue[i].fill(0);
        this.queue = []; this.head = this.bytes = this.outstanding = 0;
    }
}

/** Bounded ordered render receipts. A receipt follows renderer completion and
 * the next animation-frame opportunity, never just successful packet parsing.
 * This does not certify physical scanout. Cancellation/timeout sends no receipt.
 */
export class PresentationQueue {
    constructor({ acknowledge, fail, requestFrame = callback => requestAnimationFrame(callback),
        cancelFrame = id => cancelAnimationFrame(id), timeoutMs = 15000 }) {
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid presentation timeout');
        this.acknowledge = acknowledge; this.fail = fail; this.requestFrame = requestFrame; this.cancelFrame = cancelFrame;
        this.timeoutMs = timeoutMs; this.pending = new Map(); this.closed = false;
    }
    submit(id, renderer) {
        if (this.closed) return;
        if (!Number.isSafeInteger(id) || id < 1 || this.pending.has(id) || this.pending.size >= 2)
            throw new Error('Invalid or excessive presentation receipt');
        const entry = { abort: new AbortController(), ready: false, frame: null };
        this.pending.set(id, entry);
        const error = reason => {
            if (this.closed || this.pending.get(id) !== entry) return;
            this.close(); this.fail(reason);
        };
        entry.timer = setTimeout(() => error(new Error('Renderer did not complete a surface frame within its deadline')), this.timeoutMs);
        try {
            // Fence now, not in a later continuation that might include new work.
            Promise.resolve(renderer.whenComplete(entry.abort.signal)).then(() => {
                if (this.closed || this.pending.get(id) !== entry) return;
                entry.frame = this.requestFrame(() => {
                    entry.frame = null; entry.ready = true;
                    try { this.drain(); } catch (reason) { if (!this.closed) { this.close(); this.fail(reason); } }
                });
            }, error).catch(error);
        } catch (reason) { error(reason); }
    }
    drain() {
        for (const [id, entry] of this.pending) {
            if (!entry.ready || this.closed) break;
            this.pending.delete(id); clearTimeout(entry.timer); this.acknowledge(id);
        }
    }
    close() {
        if (this.closed) return; this.closed = true;
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer); if (entry.frame !== null) this.cancelFrame(entry.frame);
            entry.abort.abort(new Error('Presentation cancelled'));
        }
        this.pending.clear(); this.acknowledge = () => {};
    }
}

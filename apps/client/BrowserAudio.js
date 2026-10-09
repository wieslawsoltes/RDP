/** Bounded user-activated Web Audio playback. No microphone/device capture. */
export class BrowserAudio {
    constructor({ consume, status = () => {}, contextFactory = () => new AudioContext({ latencyHint: 'interactive' }) }) {
        this.consume = consume; this.status = status; this.contextFactory = contextFactory;
        this.context = null; this.gain = null; this.pending = new Map(); this.bytes = 0;
        this.enabled = false; this.closed = false; this.nextStart = 0; this.volume = 1; this.epoch = 0;
    }
    async enable() {
        if (this.closed) throw new Error('Audio session is closed');
        const epoch = this.epoch;
        if (!this.context) {
            const context = this.contextFactory();
            try {
                this.gain = context.createGain(); this.gain.connect(context.destination);
                this.context = context;
            } catch (error) {
                this.gain?.disconnect(); this.gain = null;
                context.close().catch(() => {}); throw error;
            }
            this.context.onstatechange = () => {
                if (this.context?.state !== 'running') { this.enabled = false; this.reset(); }
                this.status(this.context?.state || 'closed');
            };
        }
        // Called directly from an explicit button click, never from remote data.
        await this.context.resume();
        if (this.closed || epoch !== this.epoch) return false;
        this.enabled = this.context.state === 'running';
        this.setVolume(this.volume); this.status(this.enabled ? 'playing' : 'blocked');
        return this.enabled;
    }
    setVolume(value) {
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Volume must be between zero and one');
        this.volume = value;
        if (this.gain) this.gain.gain.value = value;
    }
    mute() { this.epoch++; this.enabled = false; this.reset(); this.status('muted'); }
    receive(sample) {
        const { id, sampleRate, frames, planes } = sample;
        const clear = () => { if (Array.isArray(planes)) for (const plane of planes) if (plane instanceof Float32Array) plane.fill(0); };
        let queued = false, buffer = null, source = null;
        try {
            if (!Number.isSafeInteger(id) || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000 ||
                !Number.isInteger(frames) || frames < 1 || frames / sampleRate > 2 ||
                !Array.isArray(planes) || planes.length < 1 || planes.length > 2 ||
                !planes.every(p => p instanceof Float32Array && p.length === frames)) throw new Error('Invalid audio sample');
            const bytes = frames * planes.length * 4;
            if (this.closed || !this.enabled || this.context?.state !== 'running' ||
                this.pending.size >= 16 || this.bytes + bytes > 2 * 1024 * 1024 ||
                this.nextStart + frames / sampleRate - this.context.currentTime > 2) return;
            if (this.pending.has(id)) throw new Error('Duplicate audio sample identifier');
            buffer = this.context.createBuffer(planes.length, frames, sampleRate);
            for (let channel = 0; channel < planes.length; channel++) buffer.copyToChannel(planes[channel], channel);
            source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
            const start = Math.max(this.context.currentTime + 0.015, this.nextStart);
            const item = { source, buffer, bytes, done: false };
            this.pending.set(id, item); this.bytes += bytes; queued = true;
            source.onended = () => this.finish(id, 'played');
            try { source.start(start); this.nextStart = start + buffer.duration; }
            catch (error) { this.finish(id, 'dropped'); throw error; }
        } catch (error) { this.status(error.message); }
        finally {
            clear();
            if (!queued) {
                if (source) { source.disconnect(); source.buffer = null; }
                if (buffer) for (let channel = 0; channel < buffer.numberOfChannels; channel++) buffer.getChannelData(channel).fill(0);
                if (Number.isSafeInteger(id) && !this.pending.has(id)) this.consume(id, 'dropped');
            }
        }
    }
    finish(id, disposition) {
        const item = this.pending.get(id);
        if (!item || item.done) return;
        item.done = true; this.pending.delete(id); this.bytes -= item.bytes;
        item.source.onended = null;
        if (disposition !== 'played') try { item.source.stop(); } catch { /* Already ended. */ }
        item.source.disconnect(); item.source.buffer = null;
        for (let channel = 0; channel < item.buffer.numberOfChannels; channel++) item.buffer.getChannelData(channel).fill(0);
        this.consume(id, disposition);
    }
    reset() { for (const id of [...this.pending.keys()]) this.finish(id, 'dropped'); this.nextStart = 0; }
    close() {
        if (this.closed) return;
        this.closed = true; this.epoch++; this.enabled = false; this.reset();
        if (this.context) { this.context.onstatechange = null; this.context.close().catch(() => {}); }
        this.gain?.disconnect(); this.gain = this.context = null;
    }
}

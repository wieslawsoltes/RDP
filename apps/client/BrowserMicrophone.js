const clear = planes => { if (Array.isArray(planes)) for (const p of planes) if (p instanceof Float32Array && p.byteLength) p.fill(0); };
const stopTracks = stream => { for (const track of stream?.getTracks?.() || []) { track.onended = track.onmute = null; try { track.stop(); } catch { /* Stop other tracks too. */ } } };
function abortable(promise, signal) {
    return new Promise((resolve, reject) => {
        const aborted = () => reject(signal.reason);
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
        Promise.resolve(promise).then(v => { signal.removeEventListener('abort', aborted); resolve(v); },
            e => { signal.removeEventListener('abort', aborted); reject(e); });
    });
}

/** Explicit user-consent owner. Remote requests only update metadata, never
 * call getUserMedia, create AudioContexts, or resume a previous permission.
 * Capture credits cover AudioWorklet -> UI -> worker, at most four 512-frame
 * chunks. Permission/module/resume waits cancel promptly even if the browser
 * API never settles; a late acquired stream is immediately stopped.
 */
export class BrowserMicrophone {
    constructor({ send, status = () => {}, mediaDevices = globalThis.navigator?.mediaDevices,
        contextFactory = () => new AudioContext({ latencyHint: 'interactive' }),
        nodeFactory = context => new AudioWorkletNode(context, 'rdp-microphone', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }),
        now = () => performance.timeOrigin + performance.now(), timeoutMs = 60000 } = {}) {
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid capture deadline');
        this.send = send; this.status = status; this.mediaDevices = mediaDevices;
        this.contextFactory = contextFactory; this.nodeFactory = nodeFactory; this.now = now; this.timeoutMs = timeoutMs;
        this.request = null; this.run = null; this.sequence = 0; this.closed = false;
    }
    receive(event) {
        if (this.closed) return;
        if (event.kind === 'open') {
            this.stop(); this.request = { ...event }; this.status('start requested');
        } else if (event.kind === 'format' && event.requestId === this.request?.requestId) {
            this.request.format = event.format; this.status(this.run?.announced ? 'recording' : 'off');
        } else if ((event.kind === 'closed' && event.requestId === this.request?.requestId) || event.kind === 'unavailable') {
            this.stop(); this.request = null; this.status(event.reason || 'channel closed');
        } else if (event.kind === 'ready-result' && !event.accepted && event.requestId === this.run?.requestId && event.captureId === this.run?.captureId) {
            this.stop('server must reopen the microphone'); this.request = null; this.status('server must reopen the microphone');
        } else if (event.kind === 'formats' && !event.count) this.status('no supported PCM format');
    }
    async enable() {
        if (this.closed || !this.request || this.run) return false;
        const run = { requestId: this.request.requestId, captureId: ++this.sequence, abort: new AbortController(), pending: new Set(), announced: false, initialOpen: !this.request.opened };
        this.run = run; this.status('requesting permission');
        run.timer = setTimeout(() => this.run === run && this.stop('permission/setup timed out'), this.timeoutMs);
        try {
            if (!this.mediaDevices?.getUserMedia) throw new Error('Microphone capture needs a secure context and browser permission');
            run.context = this.contextFactory();
            if (!run.context.audioWorklet?.addModule) throw new Error('AudioWorklet is unavailable');
            // Both calls originate directly from the user's Start microphone click.
            const resume = Promise.resolve(run.context.resume()); resume.catch(() => {});
            const acquired = Promise.resolve(this.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 2 },
                echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false })).then(stream => {
                if (run.abort.signal.aborted || this.run !== run) stopTracks(stream);
                else run.stream = stream;
                return stream;
            });
            acquired.catch(() => {});
            const loaded = run.context.audioWorklet.addModule(new URL('./microphone-worklet.js', import.meta.url));
            await abortable(Promise.all([resume, acquired, loaded]), run.abort.signal);
            if (this.run !== run || this.closed) return false;
            if (run.context.state !== 'running' || !run.stream?.getAudioTracks().some(t => t.readyState === 'live'))
                throw new Error('Microphone or audio context is not running');
            run.source = run.context.createMediaStreamSource(run.stream); run.node = this.nodeFactory(run.context);
            run.node.port.onmessage = ({ data }) => this.chunk(run, data);
            run.node.onprocessorerror = () => this.run === run && this.stop('audio processor failed');
            run.context.onstatechange = () => { if (this.run === run && run.context.state !== 'running') this.stop('audio context suspended'); };
            for (const track of run.stream.getAudioTracks()) track.onended = track.onmute = () => this.run === run && this.stop('microphone disconnected or revoked');
            run.node.connect(run.context.destination); run.source.connect(run.node);
            if (this.send({ type: 'microphone-ready', requestId: run.requestId, captureId: run.captureId, result: 0 }) === false)
                throw new Error('RDP session is unavailable');
            run.announced = true; this.request.opened = true;
            run.node.port.postMessage({ type: 'start', captureId: run.captureId });
            clearTimeout(run.timer); this.status('recording'); return true;
        } catch (error) {
            if (this.run === run) this.stop(error?.name === 'NotAllowedError' ? 'permission denied' : String(error.message || error).slice(0, 160));
            return false;
        }
    }
    chunk(run, data) {
        if (this.run !== run || this.closed || !run.announced) { clear(data?.planes); return; }
        let forwarded = false;
        try {
            if (data?.captureId !== run.captureId || !Number.isSafeInteger(data.id) || data.id <= (run.lastId || 0) ||
                !Array.isArray(data.planes) || data.planes.length !== 2 || !data.planes.every(p => p instanceof Float32Array && p.length === 512) ||
                !Number.isInteger(data.sampleRate) || data.sampleRate < 8000 || data.sampleRate > 192000 || !Number.isFinite(data.time)) return;
            run.lastId = data.id;
            if (run.pending.size >= 4 || run.context.currentTime - data.time > 0.25 || data.time > run.context.currentTime + 0.1) return;
            run.pending.add(data.id);
            forwarded = this.send({ ...data, type: 'microphone-data', requestId: run.requestId, queuedAt: this.now() }, data.planes.map(p => p.buffer)) !== false;
            if (!forwarded) run.pending.delete(data.id);
        } catch { this.stop('capture transport failed'); }
        finally {
            if (!forwarded) {
                clear(data?.planes);
                if (this.run === run && Number.isSafeInteger(data?.id) && !run.pending.has(data.id))
                    this.credit(run, data.id);
            }
        }
    }
    consumed(value) {
        const run = this.run;
        if (run && value.requestId === run.requestId && value.captureId === run.captureId && run.pending.delete(value.id))
            this.credit(run, value.id);
    }
    credit(run, id) {
        try { run.node.port.postMessage({ type: 'credit', captureId: run.captureId, id }); }
        catch { if (this.run === run) this.stop('capture credit transport failed'); }
    }
    stop(reason = 'off') {
        const run = this.run; this.run = null;
        if (run) {
            clearTimeout(run.timer); run.abort.abort(new Error('Capture stopped'));
            stopTracks(run.stream);
            if (run.context) run.context.onstatechange = null;
            if (run.node) {
                run.node.onprocessorerror = null; run.node.port.onmessage = null;
                try { run.node.port.postMessage({ type: 'stop' }); run.node.port.close(); } catch { /* Keep releasing owners. */ }
            }
            for (const node of [run.source, run.node]) try { node?.disconnect(); } catch { /* Keep releasing owners. */ }
            try { Promise.resolve(run.context?.close()).catch(() => {}); } catch { /* Context already closed. */ }
            run.pending.clear();
            const failedOpen = run.initialOpen && !run.announced;
            // A failed initial Open has been answered with failure. Do not
            // reacquire hardware without a new server Open. A paused, already
            // opened stream may retry only after another explicit user click.
            if (failedOpen && this.request?.requestId === run.requestId) this.request = null;
            try { this.send({ type: failedOpen ? 'microphone-ready' : 'microphone-stop', requestId: run.requestId,
                captureId: run.captureId, result: 0x80070005 }); } catch { /* Session already failed. */ }
        }
        this.status(reason);
    }
    close() { if (this.closed) return; this.closed = true; this.stop(); this.request = null; }
}

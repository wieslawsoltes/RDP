/* Audio rendering thread: bounded Float32 transfer, never a network or device
 * owner. Output is always silence (no local microphone feedback). */
class MicrophoneProcessor extends AudioWorkletProcessor {
    constructor() {
        super(); this.active = false; this.at = 0; this.next = 0; this.pending = new Set();
        this.planes = [new Float32Array(512), new Float32Array(512)];
        this.port.onmessage = ({ data }) => {
            if (data?.type === 'start' && !this.active && Number.isSafeInteger(data.captureId) && data.captureId > 0) {
                this.captureId = data.captureId; this.active = true;
            } else if (data?.type === 'credit' && data.captureId === this.captureId) this.pending.delete(data.id);
            else if (data?.type === 'stop') this.clear();
        };
    }
    clear() { this.active = false; this.at = 0; this.pending.clear(); for (const p of this.planes) p.fill(0); }
    process(inputs, outputs) {
        for (const output of outputs) for (const channel of output) channel.fill(0);
        const input = inputs[0];
        if (!this.active || !input?.length || !input[0]?.length) return true;
        if (this.pending.size >= 4) { this.at = 0; for (const p of this.planes) p.fill(0); return true; }
        for (let i = 0; i < input[0].length; i++) {
            this.planes[0][this.at] = input[0][i];
            this.planes[1][this.at++] = (input[1] || input[0])[i];
            if (this.at === 512) {
                const id = ++this.next, planes = this.planes;
                this.pending.add(id); this.at = 0;
                this.port.postMessage({ id, captureId: this.captureId, sampleRate, time: currentTime, planes }, planes.map(p => p.buffer));
                this.planes = [new Float32Array(512), new Float32Array(512)];
                if (this.pending.size >= 4) break;
            }
        }
        return true;
    }
}
registerProcessor('rdp-microphone', MicrophoneProcessor);

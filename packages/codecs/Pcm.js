import { requireThat } from '../binary/ProtocolError.js';

export function supportedPcm(format) {
    return !!format && format.tag === 1 && [1, 2].includes(format.channels) &&
        Number.isInteger(format.sampleRate) && format.sampleRate >= 8000 && format.sampleRate <= 96000 &&
        [8, 16, 24, 32].includes(format.bits) && format.extraSize === 0 &&
        format.blockAlign === format.channels * (format.bits / 8) &&
        format.bytesPerSecond === format.sampleRate * format.blockAlign;
}

/** WAVE_FORMAT_PCM little-endian interleaved bytes -> owned Float32 channel planes. */
export function decodePcm(bytes, format) {
    requireThat(bytes instanceof Uint8Array && bytes.length <= 65535 && supportedPcm(format),
        'PCM_FORMAT', 'Unsupported PCM format or excessive packet');
    requireThat(bytes.length > 0 && bytes.length % format.blockAlign === 0,
        'PCM_ALIGNMENT', 'PCM data must contain complete sample frames');
    const frames = bytes.length / format.blockAlign, step = format.bits / 8;
    const planes = Array.from({ length: format.channels }, () => new Float32Array(frames));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let frame = 0, offset = 0; frame < frames; frame++) {
        for (let channel = 0; channel < format.channels; channel++, offset += step) {
            let sample;
            if (step === 1) sample = (bytes[offset] - 128) / 128;
            else if (step === 2) sample = view.getInt16(offset, true) / 32768;
            else if (step === 3) sample = ((bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16) << 8 >> 8) / 8388608;
            else sample = view.getInt32(offset, true) / 2147483648;
            planes[channel][frame] = sample;
        }
    }
    return { sampleRate: format.sampleRate, frames, planes };
}

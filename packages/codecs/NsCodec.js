import { Reader } from '../binary/Reader.js';
import { requireThat, checkedSize } from '../binary/ProtocolError.js';

const MAX_BYTES = 64 * 1024 * 1024;
/** Geometry of the concatenated Y/Co/Cg/A planes, including NSCodec's padding.
 * Unlike RDP6 planar, subsampled luma rows round UP to eight pixels; alpha
 * never has row padding. Plane row order is retained, not silently flipped.
 */
export function nsCodecLayout(width, height, subsampled, alpha) {
    requireThat(Number.isInteger(width) && width > 0 && width <= 8192 &&
        Number.isInteger(height) && height > 0 && height <= 8192 &&
        typeof subsampled === 'boolean' && typeof alpha === 'boolean', 'NSC_SIZE', 'Invalid NSCodec geometry');
    const pixels = checkedSize(width * height, 16777216, 'NSCodec pixels');
    const stride = subsampled ? Math.ceil(width / 8) * 8 : width;
    const chromaStride = subsampled ? stride / 2 : width;
    const chromaHeight = subsampled ? Math.ceil(height / 2) : height;
    const ySize = stride * height, cSize = chromaStride * chromaHeight;
    const alphaOffset = ySize + 2 * cSize;
    const bytes = checkedSize(alphaOffset + (alpha ? pixels : 0), MAX_BYTES, 'NSCodec planes');
    return { stride, chromaStride, ySize, cSize, alphaOffset, bytes };
}

/** Decode an individual NSCodec plane into caller-owned storage. EndData is
 * always four literal bytes, even when adjacent to an equal run/literal.
 * Equal encoded/raw lengths mean raw, regardless of their byte patterns.
 */
export function decodeNsPlane(encoded, out) {
    requireThat(encoded instanceof Uint8Array && out instanceof Uint8Array &&
        out.length > 0 && out.length <= MAX_BYTES && encoded.length > 0 && encoded.length <= out.length,
        'NSC_PLANE', 'Invalid NSCodec plane lengths');
    requireThat(encoded.buffer !== out.buffer, 'NSC_ALIAS', 'NSCodec plane input must not alias output');
    if (encoded.length === out.length) { out.set(encoded); return; }
    requireThat(out.length > 4 && encoded.length > 4, 'NSC_RLE', 'Truncated NSCodec EndData');
    const r = new Reader(encoded.subarray(0, -4)), end = out.length - 4;
    let at = 0;
    try {
        while (r.remaining) {
            const value = r.u8();
            let count = 1;
            if (r.remaining && r.bytes[r.offset] === value) {
                r.u8();
                const factor = r.u8(); count = factor === 255 ? r.u32le() : factor + 2;
                requireThat(count >= 2, 'NSC_RUN', 'Invalid NSCodec extended run');
            }
            requireThat(count <= end - at, 'NSC_RUN', 'NSCodec run exceeds its plane or EndData boundary');
            out.fill(value, at, at + count); at += count;
        }
        requireThat(at === end, 'NSC_PLANE', 'NSCodec plane ended before its decoded size');
        out.set(encoded.subarray(-4), end);
    } catch (error) { out.fill(0); throw error; }
}

/** Independent MS-RDPNSC decoder. CPU performs RLE only. The owned plane
 * descriptor is transferable as ONE buffer; color conversion and chroma
 * expansion can be fused with the WebGPU dirty-rectangle write. Consumers
 * without GPU support use nsCodecToRgba. There is no persistent codec history.
 */
export function decodeNsCodec(bytes, width, height, { sourceBpp = 32, bottomUp = true,
    maxColorLoss = 7, allowSubsampling = true, maxDecodedBytes = MAX_BYTES } = {}) {
    requireThat(bytes instanceof Uint8Array && bytes.length >= 20 && bytes.length <= MAX_BYTES + 20,
        'NSC_LENGTH', 'Invalid NSCodec stream size');
    requireThat([24, 32].includes(sourceBpp) && typeof bottomUp === 'boolean' &&
        Number.isInteger(maxColorLoss) && maxColorLoss >= 1 && maxColorLoss <= 7 && typeof allowSubsampling === 'boolean',
        'NSC_OPTIONS', 'Invalid NSCodec decoder options');
    checkedSize(maxDecodedBytes, MAX_BYTES, 'NSCodec decode budget');
    const r = new Reader(bytes), lengths = [r.u32le(), r.u32le(), r.u32le(), r.u32le()];
    const colorLossLevel = r.u8(), sampling = r.u8(); r.u16le(); // Reserved, not semantic data.
    requireThat(colorLossLevel >= 1 && colorLossLevel <= maxColorLoss && sampling <= 1 &&
        (!sampling || allowSubsampling), 'NSC_HEADER', 'Invalid or unnegotiated NSCodec quality');
    const alpha = lengths[3] !== 0, subsampled = sampling === 1;
    const layout = nsCodecLayout(width, height, subsampled, alpha);
    requireThat(layout.bytes <= maxDecodedBytes && lengths.reduce((a, b) => a + b, 0) === r.remaining,
        'NSC_LENGTH', 'NSCodec plane total or memory budget mismatch');
    const expected = [layout.ySize, layout.cSize, layout.cSize, alpha ? width * height : 0];
    for (let i = 0; i < 4; i++)
        requireThat(lengths[i] <= expected[i] && (expected[i] === 0 || lengths[i] > 0), 'NSC_PLANE', 'Invalid NSCodec plane size');
    const data = new Uint8Array(layout.bytes);
    try {
        let at = 0;
        for (let i = 0; i < 4; i++) {
            if (expected[i]) decodeNsPlane(r.take(lengths[i]), data.subarray(at, at + expected[i]));
            at += expected[i];
        }
        r.end();
        return { encoding: 'nscodec', bpp: 32, width, height, stride: layout.stride,
            colorLossLevel, subsampled, alpha, sourceBpp, bottomUp, data };
    } catch (error) { data.fill(0); throw error; }
}

export function validateNsBitmap(bitmap) {
    const layout = nsCodecLayout(bitmap.width, bitmap.height, bitmap.subsampled, bitmap.alpha);
    requireThat(bitmap.encoding === 'nscodec' && bitmap.bpp === 32 && [24, 32].includes(bitmap.sourceBpp) &&
        Number.isInteger(bitmap.colorLossLevel) && bitmap.colorLossLevel >= 1 && bitmap.colorLossLevel <= 7 &&
        typeof bitmap.bottomUp === 'boolean' && bitmap.stride === layout.stride &&
        bitmap.data instanceof Uint8Array && bitmap.data.length === layout.bytes,
        'NSC_DESCRIPTOR', 'Invalid NSCodec plane descriptor');
    return layout;
}

/** CPU color-conversion oracle and Canvas/WebGL fallback. Alpha is preserved
 * only on explicit request: the primary remote desktop remains opaque.
 * sourceBpp=24 applies the documented Microsoft YCoCg red/blue correction.
 */
export function nsCodecToRgba(bitmap, destination, preserveAlpha = false) {
    const layout = validateNsBitmap(bitmap), { width, height, data, colorLossLevel, subsampled, bottomUp, sourceBpp, alpha } = bitmap;
    const out = destination ?? new Uint8ClampedArray(width * height * 4);
    requireThat((out instanceof Uint8Array || out instanceof Uint8ClampedArray) &&
        out.length >= width * height * 4 && out.buffer !== data.buffer, 'NSC_OUTPUT', 'Invalid or aliased NSCodec output');
    const clamp = value => Math.max(0, Math.min(255, value)), shift = colorLossLevel - 1;
    for (let y = 0, o = 0; y < height; y++) {
        const sy = bottomUp ? height - 1 - y : y;
        const cRow = (subsampled ? sy >>> 1 : sy) * layout.chromaStride;
        for (let x = 0; x < width; x++, o += 4) {
            const i = cRow + (subsampled ? x >>> 1 : x);
            const co = (data[layout.ySize + i] << (shift + 24)) >> 24;
            const cg = (data[layout.ySize + layout.cSize + i] << (shift + 24)) >> 24;
            const luma = data[sy * layout.stride + x];
            const red = clamp(luma + co - cg), blue = clamp(luma - co - cg);
            out[o] = sourceBpp === 24 ? blue : red; out[o + 1] = clamp(luma + cg);
            out[o + 2] = sourceBpp === 24 ? red : blue;
            out[o + 3] = preserveAlpha && alpha ? data[layout.alphaOffset + sy * width + x] : 255;
        }
    }
    return out;
}

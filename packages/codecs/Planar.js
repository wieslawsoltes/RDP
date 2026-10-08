import { Reader } from '../binary/Reader.js';
import { requireThat, checkedSize } from '../binary/ProtocolError.js';

const MAX_PIXELS = 16777216;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BYTES = 128 * 1024 * 1024;

/** Read one RDP6 plane. Rows remain in wire order (bottom row first).
 * Run-only subsegments reuse the previous RAW value in the same scanline.
 * For subsequent rows that value is a delta, not the reconstructed pixel.
 */
function readPlane(reader, width, height, compressed) {
    const count = width * height;
    if (!compressed)
        return reader.take(count);
    const plane = new Uint8Array(count);
    let position = 0;
    for (let y = 0; y < height; y++) {
        const end = position + width;
        let previous = 0;
        while (position < end) {
            const control = reader.u8();
            let raw = control >>> 4, run = control & 15;
            requireThat(control !== 0, 'PLANAR_CONTROL', 'Empty RDP6 RLE segment');
            if (run === 1 || run === 2) {
                run = raw + (run === 1 ? 16 : 32);
                raw = 0;
            }
            requireThat(raw + run <= end - position, 'PLANAR_RUN', 'RDP6 RLE segment crosses a scanline');
            const literals = reader.take(raw);
            for (const encoded of literals) {
                previous = y === 0 ? encoded : (encoded & 1 ? -((encoded >>> 1) + 1) : encoded >>> 1);
                plane[position] = y === 0 ? previous : plane[position - width] + previous;
                position++;
            }
            if (y === 0) {
                plane.fill(previous, position, position + run);
                position += run;
            }
            else {
                for (let i = 0; i < run; i++, position++)
                    plane[position] = plane[position - width] + previous;
            }
        }
    }
    return plane;
}

const clamp = value => Math.max(0, Math.min(255, value));
const signedByte = value => (value << 24) >> 24;

/**
 * Independently implemented MS-RDPEGDI RDP6_BITMAP_STREAM decoder.
 * Returns owned, tightly packed BGRA bytes in the source scanline order.
 * The desktop compositor treats desktop pixels as opaque; alpha is preserved
 * here for consumers that need it. This is not the NSCodec or RDPGFX codec.
 *
 * @param {Uint8Array} bytes One complete RDP6 bitmap stream.
 * @param {number} width Bitmap width, 1..8192.
 * @param {number} height Bitmap height, 1..8192.
 * @param {{maxDecodedBytes?: number, sourceBpp?: 24|32}} [options]
 * sourceBpp=24 applies the Microsoft 24-bit YCoCg R/B correction described
 * in MS-RDPEGDI 3.1.9.1.2. Do not infer source depth solely from omitted alpha.
 * maxDecodedBytes bounds output plus worst-case owned plane storage.
 * @returns {Uint8Array}
 */
export function decodePlanar(bytes, width, height, options = {}) {
    requireThat(bytes instanceof Uint8Array, 'PLANAR_TYPE', 'RDP6 input must be a Uint8Array');
    checkedSize(bytes.length, MAX_INPUT_BYTES, 'RDP6 encoded bytes');
    requireThat(Number.isSafeInteger(width) && width > 0 && width <= 8192 &&
        Number.isSafeInteger(height) && height > 0 && height <= 8192,
        'PLANAR_SIZE', 'Invalid RDP6 bitmap dimensions');
    const count = checkedSize(width * height, MAX_PIXELS, 'RDP6 bitmap pixels');
    requireThat(options !== null && typeof options === 'object', 'PLANAR_OPTIONS', 'Invalid RDP6 decoder options');
    const maxDecodedBytes = options.maxDecodedBytes ?? MAX_DECODED_BYTES;
    checkedSize(maxDecodedBytes, MAX_DECODED_BYTES, 'RDP6 decode budget');
    const sourceBpp = options.sourceBpp ?? 32;
    requireThat(sourceBpp === 24 || sourceBpp === 32, 'PLANAR_BPP', 'Invalid RDP6 source color depth');
    const reader = new Reader(bytes), header = reader.u8();
    const loss = header & 7, subsampled = !!(header & 8);
    const compressed = !!(header & 16), noAlpha = !!(header & 32);
    requireThat((header & 0xc0) === 0 && (!subsampled || loss !== 0),
        'PLANAR_HEADER', 'Invalid RDP6 bitmap format header');
    const chromaWidth = subsampled ? Math.ceil(width / 2) : width;
    const chromaHeight = subsampled ? Math.ceil(height / 2) : height;
    const planeBytes = count * (noAlpha ? 1 : 2) + 2 * chromaWidth * chromaHeight;
    requireThat(count * 4 + planeBytes <= maxDecodedBytes,
        'PLANAR_BUDGET', 'RDP6 bitmap exceeds the decode memory budget');
    // Reject undersized raw streams before allocating the output buffer.
    if (!compressed)
        requireThat(reader.remaining === planeBytes || reader.remaining === planeBytes + 1,
            'PLANAR_LENGTH', 'Invalid raw RDP6 plane lengths');
    const alpha = noAlpha ? null : readPlane(reader, width, height, compressed);
    const first = readPlane(reader, width, height, compressed);
    const second = readPlane(reader, chromaWidth, chromaHeight, compressed);
    const third = readPlane(reader, chromaWidth, chromaHeight, compressed);
    if (!compressed && reader.remaining === 1)
        reader.u8(); // Optional padding has no defined value.
    reader.end();
    const out = new Uint8Array(count * 4);
    if (loss === 0) {
        for (let i = 0, o = 0; i < count; i++, o += 4) {
            out[o] = third[i];
            out[o + 1] = second[i];
            out[o + 2] = first[i];
            out[o + 3] = alpha ? alpha[i] : 255;
        }
    }
    else {
        // Recover the signed 9-bit chroma value before the inverse transform.
        // Combining its << loss recovery and /2 factor yields an 8-bit
        // signed value: sign extension must happen AFTER the shift.
        const shift = loss - 1, swap = sourceBpp === 24;
        for (let y = 0, i = 0; y < height; y++) {
            const row = (subsampled ? y >>> 1 : y) * chromaWidth;
            for (let x = 0; x < width; x++, i++) {
                const c = row + (subsampled ? x >>> 1 : x);
                const co = signedByte(second[c] << shift);
                const cg = signedByte(third[c] << shift);
                const red = clamp(first[i] + co - cg);
                const blue = clamp(first[i] - co - cg);
                const o = i * 4;
                out[o] = swap ? red : blue;
                out[o + 1] = clamp(first[i] + cg);
                out[o + 2] = swap ? blue : red;
                out[o + 3] = alpha ? alpha[i] : 255;
            }
        }
    }
    return out;
}

import { validateNsBitmap, nsCodecToRgba } from './NsCodec.js';
import { requireThat, checkedSize } from '../binary/ProtocolError.js';
export function validateBitmap(b) {
    if (b.encoding === 'nscodec') { validateNsBitmap(b); return 4; }
    requireThat(b.encoding === undefined, 'BITMAP_ENCODING', 'Unknown bitmap encoding');
    requireThat(Number.isInteger(b.width) && Number.isInteger(b.height) && b.width > 0 && b.height > 0 && b.width <= 8192 && b.height <= 8192, 'BITMAP_SIZE', 'Invalid bitmap dimensions');
    checkedSize(b.width * b.height, 16777216, 'Bitmap pixels');
    requireThat([8, 15, 16, 24, 32].includes(b.bpp), 'BITMAP_BPP', 'Unsupported bitmap color depth');
    const pixelBytes = (b.bpp + 7) >> 3;
    requireThat(Number.isInteger(b.stride) && b.stride >= b.width * pixelBytes && b.stride <= b.width * pixelBytes + 4, 'BITMAP_STRIDE', 'Invalid bitmap row stride');
    requireThat(b.data instanceof Uint8Array && b.data.length === b.stride * b.height, 'BITMAP_LENGTH', 'Bitmap payload length mismatch');
    return pixelBytes;
}
/** CPU oracle and fallback. GPU conversion uses the same descriptor semantics. */
export function toRgba(bitmap, palette, destination) {
    if (bitmap.encoding === 'nscodec') return nsCodecToRgba(bitmap, destination);
    const bytesPerPixel = validateBitmap(bitmap), { width, height, stride, data, bpp, bottomUp = true } = bitmap;
    const out = destination ?? new Uint8ClampedArray(width * height * 4);
    requireThat(out.length >= width * height * 4, 'PIXEL_BUFFER', 'Pixel output buffer is too small');
    for (let y = 0; y < height; y++) {
        let source = (bottomUp ? height - 1 - y : y) * stride, target = y * width * 4;
        for (let x = 0; x < width; x++, source += bytesPerPixel, target += 4) {
            if (bpp === 8) {
                const index = data[source] * 4;
                out[target] = palette?.[index] ?? data[source];
                out[target + 1] = palette?.[index + 1] ?? data[source];
                out[target + 2] = palette?.[index + 2] ?? data[source];
            }
            else if (bpp === 15 || bpp === 16) {
                const v = data[source] | (data[source + 1] << 8), red = v >>> (bpp === 16 ? 11 : 10), green = (v >>> 5) & (bpp === 16 ? 63 : 31), blue = v & 31;
                out[target] = ((red & 31) << 3) | ((red & 31) >>> 2);
                out[target + 1] = bpp === 16 ? (green << 2) | (green >>> 4) : (green << 3) | (green >>> 2);
                out[target + 2] = (blue << 3) | (blue >>> 2);
            }
            else {
                out[target] = data[source + 2];
                out[target + 1] = data[source + 1];
                out[target + 2] = data[source];
            }
            out[target + 3] = 255;
        }
    }
    return out;
}
export function defaultPalette() {
    const p = new Uint8Array(1024);
    for (let i = 0; i < 256; i++)
        p.set([i, i, i, 255], i * 4);
    return p;
}
export function rgbaToBgr24(data, width, height) {
    requireThat(data.length === width * height * 4, 'BITMAP_LENGTH', 'RGBA length mismatch');
    const stride = (width * 3 + 3) & ~3, out = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const src = (y * width + x) * 4, dst = (height - 1 - y) * stride + x * 3;
            out[dst] = data[src + 2];
            out[dst + 1] = data[src + 1];
            out[dst + 2] = data[src];
        }
    return out;
}

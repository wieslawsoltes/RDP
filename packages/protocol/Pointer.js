import { Reader } from '../binary/Reader.js';
import { requireThat } from '../binary/ProtocolError.js';
/** Cursor pixels retain AND/XOR semantics, including destination inversion. */
export function parsePointerShape(bytes, newPointer = false) {
    return parseShape(bytes, newPointer, false);
}

/** TS_FP_LARGEPOINTERATTRIBUTE after fast-path decompression/reassembly. */
export function parseLargePointerShape(bytes) {
    return parseShape(bytes, true, true);
}

function parseShape(bytes, newPointer, large) {
    requireThat(bytes instanceof Uint8Array && bytes.length <= 608277, 'POINTER_INPUT', 'Pointer payload exceeds the maximum encoded shape');
    const r = new Reader(bytes), bpp = newPointer ? r.u16le() : 24;
    requireThat([1, 4, 8, 15, 16, 24, 32].includes(bpp), 'POINTER_BPP', 'Invalid pointer color depth');
    requireThat(![4, 8].includes(bpp), 'POINTER_PALETTE', 'Paletted pointers are not supported by this profile');
    const cacheIndex = r.u16le(), hotX = r.u16le(), hotY = r.u16le(), width = r.u16le(), height = r.u16le();
    const andLength = large ? r.u32le() : r.u16le(), xorLength = large ? r.u32le() : r.u16le();
    const maximum = large ? 384 : 96;
    requireThat(cacheIndex < 32 && width > 0 && height > 0 && width <= maximum && height <= maximum && hotX < width && hotY < height, 'POINTER_SIZE', 'Invalid pointer dimensions or cache index');
    const xorStride = (Math.ceil(width * bpp / 8) + 1) & ~1, andStride = (Math.ceil(width / 8) + 1) & ~1;
    requireThat(xorLength === xorStride * height && (andLength === andStride * height || (bpp === 32 && andLength === 0)), 'POINTER_LENGTH', 'Invalid pointer mask lengths');
    const xor = r.take(xorLength), and = r.take(andLength);
    if (r.remaining === 1)
        r.u8();
    r.end();
    const pixels = new Uint8Array(width * height * 4), bytesPerPixel = (bpp + 7) >> 3;
    for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
            const row = height - 1 - y, src = row * xorStride + (bpp === 1 ? x >>> 3 : x * bytesPerPixel), dst = (y * width + x) * 4;
            if (bpp === 1)
                pixels.fill((xor[src] >>> (7 - (x & 7))) & 1 ? 255 : 0, dst, dst + 3);
            else if (bpp === 15 || bpp === 16) {
                const p = xor[src] | xor[src + 1] << 8, rr = (p >>> (bpp === 16 ? 11 : 10)) & 31, g = (p >>> 5) & (bpp === 16 ? 63 : 31), b = p & 31;
                pixels[dst] = rr << 3 | rr >>> 2;
                pixels[dst + 1] = bpp === 16 ? g << 2 | g >>> 4 : g << 3 | g >>> 2;
                pixels[dst + 2] = b << 3 | b >>> 2;
            }
            else {
                pixels[dst] = xor[src + 2];
                pixels[dst + 1] = xor[src + 1];
                pixels[dst + 2] = xor[src];
            }
            pixels[dst + 3] = bpp === 32 ? xor[src + 3] : (((and[row * andStride + (x >>> 3)] >>> (7 - (x & 7))) & 1) ? 255 : 0);
        }
    return { cacheIndex, width, height, hotX, hotY, pixels, mode: bpp === 32 ? 2 : 1 };
}
export class PointerCache {
    constructor(emit) { this.emit = emit; this.cache = new Map(); }
    store(shape) { this.cache.set(shape.cacheIndex, shape); this.emit({ type: 'shape', shape }); }
    shape(bytes, isNew) { this.store(parsePointerShape(bytes, isNew)); }
    large(bytes) { this.store(parseLargePointerShape(bytes)); }
    cached(bytes) { const r = new Reader(bytes), id = r.u16le(); r.end(); requireThat(this.cache.has(id), 'POINTER_CACHE', 'Pointer cache miss'); this.emit({ type: 'shape', shape: this.cache.get(id) }); }
    position(bytes) { const r = new Reader(bytes), x = r.u16le(), y = r.u16le(); r.end(); this.emit({ type: 'position', x, y }); }
    system(bytes) { const r = new Reader(bytes), value = r.u32le(); r.end(); requireThat(value === 0 || value === 0x7f00, 'POINTER_SYSTEM', 'Invalid system pointer'); this.emit({ type: value === 0 ? 'hidden' : 'default' }); }
    clear() { this.cache.clear(); }
}

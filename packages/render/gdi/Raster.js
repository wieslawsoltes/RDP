import { requireThat } from '../../binary/ProtocolError.js';
import { nsCodecToXrgb } from '../../codecs/NsCodec.js';
import { validateBitmap } from '../../codecs/Pixels.js';

const MASK = 0xffffff;
/** Every bit is a truth-table lookup indexed by (pattern, source, destination). */
export function rop3(code, d, s = 0, p = 0) {
    switch (code) {
        case 0: return 0;
        case 0xff: return MASK;
        case 0xcc: return s & MASK;
        case 0xaa: return d & MASK;
        case 0xf0: return p & MASK;
        case 0x55: return ~d & MASK;
        case 0x66: return (s ^ d) & MASK;
        case 0x88: return (s & d) & MASK;
        case 0xee: return (s | d) & MASK;
        case 0x5a: return (p ^ d) & MASK;
    }
    // Shannon expansion: evaluate each source/pattern quadrant in parallel
    // across the 24 pixel bits. No eval, generated code or per-bit loop.
    const a = ((code & 1 ? ~d : 0) | (code & 2 ? d : 0));
    const b = ((code & 4 ? ~d : 0) | (code & 8 ? d : 0));
    const c = ((code & 16 ? ~d : 0) | (code & 32 ? d : 0));
    const e = ((code & 64 ? ~d : 0) | (code & 128 ? d : 0));
    return (((a & ~s | b & s) & ~p) | ((c & ~s | e & s) & p)) & MASK;
}
export function dependsOn(code, input) {
    for (let i = 0; i < 8; i++) if (((code >>> i) & 1) !== ((code >>> (i ^ input)) & 1)) return true;
    return false;
}
export function createSurface(width, height, maxPixels = 16777216) {
    requireThat(Number.isInteger(width) && width > 0 && width <= 8192 && Number.isInteger(height) &&
        height > 0 && height <= 8192 && width * height <= maxPixels, 'GDI_SIZE', 'Drawing surface exceeds its pixel budget');
    return { width, height, pixels: new Uint32Array(width * height) };
}
/** Top-down canonical 0x00RRGGBB pixels, independent of host endianness. */
export function bitmapPixels(bitmap, palette) {
    if (bitmap.encoding === 'nscodec') return { width: bitmap.width, height: bitmap.height, pixels: nsCodecToXrgb(bitmap) };
    const step = validateBitmap(bitmap), { width, height, stride, data, bpp, bottomUp = true } = bitmap;
    if (bpp === 8) requireThat(palette instanceof Uint32Array && palette.length === 256, 'GDI_PALETTE', 'Missing bitmap color table');
    const pixels = new Uint32Array(width * height);
    for (let y = 0, i = 0; y < height; y++) {
        let at = (bottomUp ? height - y - 1 : y) * stride;
        for (let x = 0; x < width; x++, i++, at += step) {
            if (bpp === 8) pixels[i] = palette[data[at]];
            else if (bpp === 15 || bpp === 16) {
                const v = data[at] | data[at + 1] << 8, r = v >>> (bpp === 16 ? 11 : 10) & 31;
                const g = v >>> 5 & (bpp === 16 ? 63 : 31), b = v & 31;
                pixels[i] = ((r << 3 | r >>> 2) << 16) | ((bpp === 16 ? g << 2 | g >>> 4 : g << 3 | g >>> 2) << 8) | (b << 3 | b >>> 2);
            } else pixels[i] = data[at] | data[at + 1] << 8 | data[at + 2] << 16;
        }
    }
    return { width, height, pixels };
}
export function clipRect(surface, rect, bounds) {
    const x = Math.max(0, rect.x, bounds?.left ?? 0), y = Math.max(0, rect.y, bounds?.top ?? 0);
    const right = Math.min(surface.width, rect.x + rect.width, bounds ? bounds.right + 1 : surface.width);
    const bottom = Math.min(surface.height, rect.y + rect.height, bounds ? bounds.bottom + 1 : surface.height);
    return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}
/** Tiled damage is bounded by desktop area, not the number of orders. */
export class DirtyTiles {
    constructor(width, height) {
        this.width = width; this.height = height;
        this.columns = Math.ceil(width / 64); this.rows = Math.ceil(height / 64);
        this.bits = new Uint8Array(this.columns * this.rows);
        this.left = new Uint8Array(this.bits.length); this.top = new Uint8Array(this.bits.length);
        this.right = new Uint8Array(this.bits.length); this.bottom = new Uint8Array(this.bits.length);
    }
    mark({ x, y, width, height }) {
        if (!width || !height) return;
        const left = x >>> 6, right = (x + width - 1) >>> 6, bottom = (y + height - 1) >>> 6;
        for (let row = y >>> 6; row <= bottom; row++) for (let col = left; col <= right; col++) {
            const i = row * this.columns + col;
            const l = Math.max(0, x - col * 64), t = Math.max(0, y - row * 64);
            const r = Math.min(64, x + width - col * 64), b = Math.min(64, y + height - row * 64);
            if (!this.bits[i]) { this.left[i] = l; this.top[i] = t; this.right[i] = r; this.bottom[i] = b; this.bits[i] = 1; }
            else { this.left[i] = Math.min(this.left[i], l); this.top[i] = Math.min(this.top[i], t);
                this.right[i] = Math.max(this.right[i], r); this.bottom[i] = Math.max(this.bottom[i], b); }
        }
    }
    take(surface) {
        const rectangles = [];
        for (let row = 0; row < this.rows; row++) for (let col = 0; col < this.columns;) {
            if (!this.bits[row * this.columns + col]) { col++; continue; }
            const start = col;
            while (col < this.columns && this.bits[row * this.columns + col]) col++;
            let endRow = row + 1;
            outer: for (; endRow < this.rows; endRow++) {
                for (let c = start; c < col; c++) if (!this.bits[endRow * this.columns + c]) break outer;
            }
            let x = surface.width, y = surface.height, right = 0, bottom = 0;
            for (let ry = row; ry < endRow; ry++) for (let cx = start; cx < col; cx++) {
                const i = ry * this.columns + cx; this.bits[i] = 0;
                x = Math.min(x, cx * 64 + this.left[i]); y = Math.min(y, ry * 64 + this.top[i]);
                right = Math.max(right, cx * 64 + this.right[i]); bottom = Math.max(bottom, ry * 64 + this.bottom[i]);
                this.left[i] = this.top[i] = this.right[i] = this.bottom[i] = 0;
            }
            const width = right - x, height = bottom - y, data = new Uint8Array(width * height * 4);
            for (let py = 0, o = 0; py < height; py++) for (let px = 0; px < width; px++, o += 4) {
                const value = surface.pixels[(y + py) * surface.width + x + px];
                data[o] = value; data[o + 1] = value >>> 8; data[o + 2] = value >>> 16; data[o + 3] = 255;
            }
            rectangles.push({ x, y, width, height, drawWidth: width, drawHeight: height, bpp: 32, stride: width * 4, bottomUp: false, data });
        }
        return rectangles;
    }
    clear() { for (const values of [this.bits, this.left, this.top, this.right, this.bottom]) values.fill(0); }
}
/** Bounded scanline blitter. Copies use memmove direction, including arbitrary
 * ROPs and same-surface source overlap. No GPU readback or full-frame temporary. */
export function blit(target, rect, { source = null, sx = 0, sy = 0, pattern = null, orgX = 0, orgY = 0, code = 0xcc, bounds = null } = {}) {
    requireThat(Number.isInteger(code) && code >= 0 && code <= 255, 'GDI_ROP', 'Invalid ROP3');
    for (const key of ['x', 'y', 'width', 'height']) requireThat(Number.isInteger(rect[key]), 'GDI_RECT', 'Invalid drawing rectangle');
    requireThat(rect.width >= 0 && rect.height >= 0, 'GDI_RECT', 'Negative drawing extent');
    const area = clipRect(target, rect, bounds);
    if (!area.width || !area.height || code === 0xaa) return null;
    if (dependsOn(code, 4)) requireThat(pattern instanceof Uint32Array && pattern.length === 64, 'GDI_BRUSH', 'Missing brush pattern');
    const solid = code === 0xf0 && pattern.every(value => value === pattern[0]);
    const readsSource = dependsOn(code, 2);
    sx += area.x - rect.x; sy += area.y - rect.y;
    if (readsSource) requireThat(source && Number.isInteger(sx) && Number.isInteger(sy) && sx >= 0 && sy >= 0 &&
        sx + area.width <= source.width && sy + area.height <= source.height, 'GDI_SOURCE', 'Blit source lies outside its surface');
    const pixels = target.pixels, reverseY = readsSource && source.pixels === pixels && area.y > sy;
    const reverseX = readsSource && source.pixels === pixels && area.y === sy && area.x > sx;
    for (let row = 0; row < area.height; row++) {
        const yy = reverseY ? area.height - row - 1 : row, y = area.y + yy;
        const dst = y * target.width + area.x, src = readsSource ? (sy + yy) * source.width + sx : 0;
        if (code === 0 || code === 0xff || solid) { pixels.fill(solid ? pattern[0] & MASK : code ? MASK : 0, dst, dst + area.width); continue; }
        if (code === 0xcc) {
            if (source.pixels === pixels) pixels.copyWithin(dst, src, src + area.width);
            else pixels.set(source.pixels.subarray(src, src + area.width), dst);
            continue;
        }
        const patternRow = ((y - orgY) & 7) * 8;
        for (let column = 0; column < area.width; column++) {
            const xx = reverseX ? area.width - column - 1 : column;
            pixels[dst + xx] = rop3(code, pixels[dst + xx], readsSource ? source.pixels[src + xx] : 0,
                pattern ? pattern[patternRow + ((area.x + xx - orgX) & 7)] : 0);
        }
    }
    return area;
}

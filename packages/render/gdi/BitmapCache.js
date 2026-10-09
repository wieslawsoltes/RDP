import { requireThat } from '../../binary/ProtocolError.js';
import { decodeInterleaved } from '../../codecs/InterleavedRle.js';
import { decodePlanar } from '../../codecs/Planar.js';
import { bitmapPixels } from './Raster.js';

export const CACHE_ENTRIES = Object.freeze([120, 120, 337]);
export const CACHE_PIXELS = Object.freeze([256, 1024, 4096]);
export const WAITING_LIST_INDEX = 32767;
const clearEntry = entry => { entry?.pixels?.fill(0); entry?.indices?.fill(0); };
export function compact15(reader) {
    const b = reader.u8(); return b & 0x80 ? (b & 0x7f) * 256 + reader.u8() : b;
}
export function compact30(reader) {
    const b = reader.u8(); let value = b & 63;
    for (let i = 0; i < b >>> 6; i++) value = value * 256 + reader.u8();
    return value;
}

/** Connection-local, nonpersistent Revision 1/2 bitmap and color-table caches.
 * The advertised cell limits are checked BEFORE decompression. Replacements
 * wipe old storage. Palettized entries retain indices, so later color tables
 * cannot leave a stale preconverted RGB cache behind. All returned surfaces
 * are borrowed synchronously; only the order engine may access them.
 */
export class BitmapCache {
    constructor({ bpp = 24, revision = 1 } = {}) {
        requireThat([24, 32].includes(bpp) && [1, 2].includes(revision), 'GDI_CACHE_CONFIG', 'Unsupported cache profile');
        this.bpp = bpp; this.revision = revision; this.closed = false;
        this.cells = CACHE_ENTRIES.map(count => Array(count).fill(null));
        this.palettes = Array(6).fill(null); this.bytes = 0;
        // An 8-bit tile occupying a 32-bit advertised cell expands by 4x.
        // This worst-case bound is still below 24 MiB for the fixed inventory.
        this.maxBytes = CACHE_ENTRIES.reduce((n, count, i) => n + count * CACHE_PIXELS[i] * 16, 0);
    }
    receive(type, extra, r, charge = () => {}) {
        requireThat(!this.closed, 'GDI_CLOSED', 'Bitmap cache is closed');
        if (type === 1) {
            const index = r.u8(), count = r.u16le();
            requireThat(index < 6 && count === 256, 'GDI_PALETTE', 'Invalid cached color table');
            r.need(1024); const palette = new Uint32Array(256);
            for (let i = 0; i < 256; i++) {
                const blue = r.u8(), green = r.u8(), red = r.u8(); r.u8();
                palette[i] = red << 16 | green << 8 | blue;
            }
            r.end(); this.palettes[index]?.fill(0); this.palettes[index] = palette; return;
        }
        requireThat([0, 2, 4, 5].includes(type), 'GDI_SECONDARY', 'Unnegotiated secondary drawing order');
        let id, width, height, bpp, length, index, noHeader;
        const compressed = type === 2 || type === 5;
        if (type === 0 || type === 2) {
            requireThat(this.revision === 1 && !(extra & ~0x400), 'GDI_CACHE_REVISION', 'Unnegotiated Revision 1 cache or flags');
            id = r.u8(); r.u8(); width = r.u8(); height = r.u8(); bpp = r.u8(); length = r.u16le(); index = r.u16le();
            noHeader = !!(extra & 0x400);
        } else {
            const flags = extra >>> 7;
            requireThat(this.revision === 2 && !(flags & ~0x19), 'GDI_CACHE_REVISION', 'Unnegotiated cache revision, persistence or flags');
            id = extra & 7; bpp = ({ 3: 8, 4: 16, 5: 24, 6: 32 })[(extra >>> 3) & 15];
            width = compact15(r); height = flags & 1 ? width : compact15(r); length = compact30(r); index = compact15(r);
            noHeader = !!(flags & 8);
            if (flags & 16) index = WAITING_LIST_INDEX; // Incoming index is ignored by specification.
            else requireThat(index !== WAITING_LIST_INDEX, 'GDI_CACHE_INDEX', 'Waiting slot needs DO_NOT_CACHE');
        }
        requireThat(id < this.cells.length && [8, 16, 24, 32].includes(bpp) && width > 0 && height > 0 &&
            width <= 8192 && height <= 8192, 'GDI_CACHE_SIZE', 'Invalid cached bitmap geometry or depth');
        const bytesPerPixel = bpp >>> 3, cellBytes = CACHE_PIXELS[id] * (this.bpp >>> 3);
        const stride = compressed ? width * bytesPerPixel : (width * bytesPerPixel + 3) & ~3;
        requireThat(stride * height <= cellBytes, 'GDI_CACHE_SIZE', 'Cached bitmap exceeds its advertised cell size');
        if (index === WAITING_LIST_INDEX) {
            requireThat(this.revision === 2, 'GDI_CACHE_INDEX', 'Unnegotiated waiting-list slot');
            index = this.cells[id].length - 1;
        }
        requireThat(index < this.cells[id].length, 'GDI_CACHE_INDEX', 'Cached bitmap index exceeds its advertised inventory');
        requireThat(length === r.remaining, 'GDI_CACHE_LENGTH', 'Cached bitmap length does not match the order');
        charge(width * height);
        if (compressed && !noHeader) {
            const first = r.u16le(), body = r.u16le(), scan = r.u16le(), size = r.u16le();
            requireThat(first === 0 && body === r.remaining && scan > 0 && size === width * height * bytesPerPixel,
                'GDI_CACHE_HEADER', 'Invalid cached bitmap compression header');
        }
        let data = r.take(r.remaining), owned = false, entry;
        try {
            if (compressed) {
                data = bpp === 32 ? decodePlanar(data, width, height) : decodeInterleaved(data, width, height, bpp); owned = true;
            } else requireThat(data.length === stride * height, 'GDI_CACHE_LENGTH', 'Invalid padded raw bitmap length');
            if (bpp === 8) {
                const indices = new Uint8Array(width * height);
                for (let y = 0; y < height; y++) indices.set(data.subarray((height - 1 - y) * stride, (height - 1 - y) * stride + width), y * width);
                entry = { width, height, indices, bytes: indices.length };
            } else {
                entry = bitmapPixels({ width, height, bpp, stride, bottomUp: true, data }); entry.bytes = entry.pixels.byteLength;
            }
            const old = this.cells[id][index], nextBytes = this.bytes - (old?.bytes || 0) + entry.bytes;
            requireThat(nextBytes <= this.maxBytes, 'GDI_CACHE_BUDGET', 'Bitmap cache allocation budget exceeded');
            this.cells[id][index] = entry; this.bytes = nextBytes; clearEntry(old);
        } catch (error) { clearEntry(entry); throw error; }
        finally { if (owned) data.fill(0); }
    }
    get(cacheId, index, charge = () => {}) {
        const id = cacheId & 255, colorIndex = cacheId >>> 8;
        requireThat(!this.closed && id < this.cells.length && colorIndex < 6, 'GDI_CACHE_ID', 'Unnegotiated bitmap/color cache');
        if (index === WAITING_LIST_INDEX) {
            requireThat(this.revision === 2, 'GDI_CACHE_INDEX', 'Unnegotiated waiting list'); index = this.cells[id].length - 1;
        }
        requireThat(Number.isInteger(index) && index >= 0 && index < this.cells[id].length, 'GDI_CACHE_INDEX', 'Invalid cached bitmap index');
        const entry = this.cells[id][index]; requireThat(entry, 'GDI_CACHE_MISS', 'Bitmap cache entry has not been populated');
        if (!entry.indices) return { surface: entry, release() {} };
        const palette = this.palettes[colorIndex]; requireThat(palette, 'GDI_PALETTE', 'Cached color table has not been populated');
        charge(entry.indices.length); // Palette expansion is work even for a tiny clipped blit.
        const pixels = Uint32Array.from(entry.indices, value => palette[value]);
        return { surface: { width: entry.width, height: entry.height, pixels }, release: () => pixels.fill(0) };
    }
    close() {
        if (this.closed) return;
        this.closed = true;
        for (const cells of this.cells) { for (const entry of cells) clearEntry(entry); cells.fill(null); }
        for (const palette of this.palettes) palette?.fill(0);
        this.palettes.fill(null); this.bytes = 0;
    }
}

import { surfaceCapabilityBodies } from './SurfaceCapabilities.js';
import { CACHE_ENTRIES, CACHE_PIXELS } from '../render/gdi/BitmapCache.js';
import { OFFSCREEN_ENTRIES, OFFSCREEN_KIB } from '../render/gdi/Orders.js';
import { Reader } from '../binary/Reader.js';
import { Writer, concat } from '../binary/Writer.js';
import { requireThat } from '../binary/ProtocolError.js';
export const capability = (type, body) => new Writer(body.length + 4).u16le(type).u16le(body.length + 4).put(body).finish();
export function clientCapabilities({ width, height, bpp = 24, keyboardLayout = 0x409, compression = true, surfaceProfile, orders = false, orderCacheRevision = 1 }) {
    const general = new Writer().u16le(4).u16le(0).u16le(0x200).u16le(0).u16le(0)
        .u16le(0x405).u16le(0).u16le(0).u16le(0).u8(1).u8(1).finish();
    const bitmap = new Writer().u16le(bpp).u16le(1).u16le(1).u16le(1).u16le(width).u16le(height)
        .u16le(0).u16le(1).u16le(1).u8(0).u8(bpp === 32 ? 8 : 0).u16le(1).u16le(0).finish();
    const gdi = orders === true && [24, 32].includes(bpp);
    const support = new Uint8Array(32);
    if (gdi) { support.fill(1, 0, 5); support.fill(1, 15, 19); }
    const order = new Writer().zeros(16).u32le(0).u16le(1).u16le(20).u16le(0).u16le(1).u16le(0).u16le(gdi ? 0x4a : 0x0a)
        .put(support).u16le(0).u16le(0).u32le(0).u32le(0).u16le(0).u16le(0).u16le(0).u16le(0).finish();
    const input = new Writer().u16le(0x15).u16le(0).u32le(keyboardLayout).u32le(4).u32le(0).u32le(12).zeros(64).finish();
    const capabilities = [capability(1, general), capability(2, bitmap), capability(3, order),
        capability(5, new Writer().u16le(0).u16le(0).u16le(2).u16le(2).finish()),
        capability(7, new Uint8Array(8)),
        capability(8, new Writer().u16le(1).u16le(32).u16le(32).finish()),
        capability(9, new Uint8Array(4)),
        capability(10, new Writer().u16le(6).u16le(0).finish()),
        capability(13, input), capability(14, new Writer().u16le(1).u16le(0).finish()),
        capability(12, new Writer().u16le(1).u16le(0).finish()),
        capability(20, new Writer().u32le(compression ? 1 : 0).u32le(1600).finish()),
        capability(26, new Writer().u32le(16 * 1024 * 1024).finish()),
        capability(27, new Writer().u16le(3).finish())];
    if (gdi) {
        requireThat([1, 2].includes(orderCacheRevision), 'GDI_CACHE_CONFIG', 'Invalid negotiated cache revision');
        if (orderCacheRevision === 2) {
            const w = new Writer().u16le(2).u8(0).u8(3);
            for (let i = 0; i < 5; i++) w.u32le(CACHE_ENTRIES[i] || 0);
            capabilities.push(capability(19, w.zeros(12).finish()));
        } else {
            const w = new Writer().zeros(24);
            CACHE_ENTRIES.forEach((count, i) => w.u16le(count).u16le(CACHE_PIXELS[i] * (bpp >>> 3)));
            capabilities.push(capability(4, w.finish()));
        }
        capabilities.push(capability(17, new Writer().u32le(1).u16le(OFFSCREEN_KIB * bpp / 32).u16le(OFFSCREEN_ENTRIES).finish()));
        capabilities.push(capability(16, new Uint8Array(48))); // No glyph cache or text orders.
    }
    capabilities.push(...surfaceCapabilityBodies(surfaceProfile).map(([type, body]) => capability(type, body)));
    return capabilities;
}
export function parseDemandActive(body) {
    const r = new Reader(body), shareId = r.u32le(), sourceLength = r.u16le(), capsLength = r.u16le();
    r.skip(sourceLength);
    requireThat(capsLength >= 4, 'CAP_LENGTH', 'Invalid capabilities length');
    const caps = r.sub(capsLength), count = caps.u16le();
    caps.u16le();
    requireThat(count <= 64, 'CAP_LIMIT', 'Too many capability sets');
    const map = new Map();
    for (let i = 0; i < count; i++) {
        const type = caps.u16le(), size = caps.u16le();
        requireThat(size >= 4 && !map.has(type), 'CAP_DUPLICATE', 'Invalid or duplicate capability set');
        map.set(type, caps.take(size - 4));
    }
    caps.end();
    if (r.remaining === 4)
        r.u32le();
    r.end();
    requireThat(map.has(1) && map.has(2), 'CAP_REQUIRED', 'Server omitted general or bitmap capabilities');
    const bitmap = new Reader(map.get(2)), bpp = bitmap.u16le();
    bitmap.skip(6);
    const width = bitmap.u16le(), height = bitmap.u16le();
    requireThat([8, 15, 16, 24, 32].includes(bpp) && width >= 200 && height >= 200 && width <= 8192 && height <= 8192 && width * height <= 16777216, 'DESKTOP_LIMIT', 'Server desktop exceeds client resource limits');
    const input = map.has(13) ? new Reader(map.get(13)).u16le() : 1;
    return { shareId, map, width, height, bpp, inputFlags: input };
}
export function confirmActiveBody(shareId, userId, options) {
    const source = new TextEncoder().encode('LRDP\0'), caps = clientCapabilities(options), all = concat(...caps);
    return new Writer().u32le(shareId).u16le(1002).u16le(source.length).u16le(all.length + 4).put(source)
        .u16le(caps.length).u16le(0).put(all).finish();
}

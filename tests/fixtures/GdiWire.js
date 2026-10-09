import { Writer, concat } from '../../packages/binary/Writer.js';

export const coord = (w, ...values) => { for (const v of values) w.u16le(v & 65535); return w; };
export const rgb = (w, value) => w.u8(value >>> 16 & 255).u8(value >>> 8 & 255).u8(value & 255);
export const opaque = (x, y, width, height, color) => rgb(coord(new Writer().u8(9).u8(10).u8(0x7f), x, y, width, height), color).finish();
export const dst = (x, y, width, height, rop) => coord(new Writer().u8(9).u8(0).u8(0x1f), x, y, width, height).u8(rop).finish();
export const scr = (x, y, width, height, rop, sx, sy) => coord(coord(new Writer().u8(9).u8(2).u8(0x7f), x, y, width, height).u8(rop), sx, sy).finish();
export const pattern = (x, y, width, height, { code = 0xf0, back = 0, fore = 0xffffff, orgX = 0, orgY = 0, style = 0, hatch = 0, extra = new Uint8Array(7) } = {}) => {
    const w = coord(new Writer().u8(9).u8(1).u16le(style === 3 ? 0xfff : 0x7ff), x, y, width, height).u8(code);
    rgb(rgb(w, back), fore).u8(orgX & 255).u8(orgY & 255).u8(style).u8(hatch); if (style === 3) w.put(extra); return w.finish();
};
export const mem = (x, y, width, height, { code = 0xcc, cacheId = 0, index = 0, sx = 0, sy = 0, brush = null } = {}) => {
    const w = new Writer().u8(9).u8(brush ? 14 : 13).u16le(brush ? 0xbfff : 0x1ff);
    if (brush) w.u8(0); // Mem3Blt has three field flag bytes.
    coord(w.u16le(cacheId), x, y, width, height).u8(code); coord(w, sx, sy);
    if (brush) rgb(rgb(w, brush.back || 0), brush.fore || 0).u8(0).u8(0).u8(0).u8(0);
    return w.u16le(index).finish();
};
export const secondary = (type, flags, body) => new Writer().u8(3).u16le((body.length - 7) & 65535).u16le(flags).u8(type).put(body).finish();
export const cache1 = (id, index, width, height, bpp, data, compressed = false, header = false) => {
    const h = compressed && header ? new Writer().u16le(0).u16le(data.length).u16le((width + 3) & ~3).u16le(width * height * (bpp >>> 3)).finish() : new Uint8Array();
    return secondary(compressed ? 2 : 0, compressed && !header ? 0x400 : 0,
        new Writer().u8(id).u8(0).u8(width).u8(height).u8(bpp).u16le(h.length + data.length).u16le(index).put(h).put(data).finish());
};
export const u15 = n => n < 128 ? Uint8Array.of(n) : Uint8Array.of(0x80 | n >>> 8, n & 255);
export const u30 = n => {
    const size = n < 64 ? 0 : n < 16384 ? 1 : n < 4194304 ? 2 : 3;
    const w = new Writer().u8(size * 64 | n >>> (size * 8));
    for (let i = size - 1; i >= 0; i--) w.u8(n >>> (i * 8) & 255);
    return w.finish();
};
export const cache2 = (id, index, width, height, bpp, data, flags = 0, compressed = false) => {
    const body = new Writer().put(u15(width)); if (!(flags & 1)) body.put(u15(height));
    return secondary(compressed ? 5 : 4, id | ({ 8: 3, 16: 4, 24: 5, 32: 6 })[bpp] << 3 | flags << 7,
        body.put(u30(data.length)).put(u15(index)).put(data).finish());
};
export const palette = (id, colors) => {
    const w = new Writer().u8(id).u16le(256);
    for (let i = 0; i < 256; i++) { const c = colors[i] || 0; w.u8(c & 255).u8(c >>> 8 & 255).u8(c >>> 16 & 255).u8(0); }
    return secondary(1, 0, w.finish());
};
export const switchSurface = id => new Writer().u8(2).u16le(id).finish();
export const createOffscreen = (id, width, height, removed) => {
    const w = new Writer().u8(6).u16le(id | (removed ? 0x8000 : 0)).u16le(width).u16le(height);
    if (removed) { w.u16le(removed.length); for (const n of removed) w.u16le(n); } return w.finish();
};
export const slowOrders = (...orders) => new Writer().u16le(0).u16le(0).u16le(orders.length).u16le(0).put(concat(...orders)).finish();
export const fastOrders = (...orders) => new Writer().u16le(orders.length).put(concat(...orders)).finish();

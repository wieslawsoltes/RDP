import assert from 'node:assert/strict';
import { Writer, concat } from '../../packages/binary/Writer.js';
import { coord, rgb } from './GdiWire.js';

// Test-only encoder, separate from the production decoder. Emit the shortest
// signed representation and explicitly set each omitted component's zero bit.
export function signedDelta(value) {
    assert.ok(Number.isInteger(value) && value >= -16384 && value <= 16383);
    return value >= -64 && value <= 63 ? Uint8Array.of(value & 127) : Uint8Array.of(128 | (value >> 8 & 127), value & 255);
}
export function deltaList(rectangles) {
    const flags = new Uint8Array(Math.ceil(rectangles.length / 2)), values = [];
    let previous = [0, 0, 0, 0];
    for (let i = 0; i < rectangles.length; i++) {
        const rect = rectangles[i], current = [rect.x, rect.y, rect.width, rect.height];
        for (let k = 0; k < 4; k++) {
            if (current[k] === previous[k]) flags[i >> 1] |= 1 << (7 - (i % 2) * 4 - k);
            else values.push(signedDelta(k < 2 ? current[k] - previous[k] : current[k]));
        }
        previous = current;
    }
    return concat(flags, ...values);
}
export function multi(type, base, rectangles, options = {}) {
    const counts = {15: 7, 16: 14, 17: 9, 18: 9}, w = new Writer().u8(options.bounds ? 13 : 9).u8(type);
    let flags = (1 << counts[type]) - 1;
    if (type === 16 && options.style !== 3) flags &= ~(1 << 11);
    if (type === 15) w.u8(flags); else w.u16le(flags);
    if (options.bounds) coord(w.u8(15), ...options.bounds);
    coord(w, base.x, base.y, base.width, base.height);
    if (type === 18) rgb(w, options.color ?? 0x123456);
    else {
        w.u8(options.code ?? (type === 15 ? 0xff : type === 16 ? 0xf0 : 0xcc));
        if (type === 16) {
            rgb(rgb(w, options.back ?? 0), options.fore ?? 0x123456);
            w.u8((options.orgX ?? 0) & 255).u8((options.orgY ?? 0) & 255).u8(options.style ?? 0).u8(options.hatch ?? 0);
            if (options.style === 3) w.put(options.extra ?? new Uint8Array(7));
        } else if (type === 17) coord(w, options.sx ?? 0, options.sy ?? 0);
    }
    const list = deltaList(rectangles);
    return w.u8(rectangles.length).u16le(list.length).put(list).finish();
}

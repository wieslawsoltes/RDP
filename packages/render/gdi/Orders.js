import { requireThat } from '../../binary/ProtocolError.js';
import { bitmapPixels, blit, clipRect, createSurface, dependsOn, DirtyTiles } from './Raster.js';
import { BitmapCache } from './BitmapCache.js';

export const MAX_ORDER_COUNT = 4096;
export const MAX_ORDER_WORK = 64 * 1024 * 1024;
export const OFFSCREEN_ENTRIES = 100;
export const OFFSCREEN_KIB = 16384;
const i8 = r => (r.u8() << 24) >> 24, i16 = r => (r.u16le() << 16) >> 16;
const color = r => r.u8() << 16 | r.u8() << 8 | r.u8();
const rectangle = [['x','coord'], ['y','coord'], ['width','coord'], ['height','coord']];
const brush = [['back','color'], ['fore','color'], ['orgX','i8'], ['orgY','i8'], ['style','u8'], ['hatch','u8'], ['extra','bytes7']];
const source = [['sx','coord'], ['sy','coord']];
// Field numbering is wire order, not negotiation order numbering.
const schemas = new Map([
    [0, [...rectangle, ['code','u8']]],
    [1, [...rectangle, ['code','u8'], ...brush]],
    [2, [...rectangle, ['code','u8'], ...source]],
    [10, [...rectangle, ['red','u8'], ['green','u8'], ['blue','u8']]],
    [13, [['cacheId','u16'], ...rectangle, ['code','u8'], ...source, ['index','u16']]],
    [14, [['cacheId','u16'], ...rectangle, ['code','u8'], ...source, ...brush, ['index','u16']]],
]);
const coordinate = value => {
    requireThat(value >= -32768 && value <= 32767, 'GDI_COORDINATE', 'Order coordinate exceeds signed 16-bit range'); return value;
};

/** Stateful MS-RDPEGDI blit profile. Network packets and bitmap updates are
 * processed in the same worker. The shadow desktop avoids synchronous GPU
 * readback for screen copies/ROPs. Only owned dirty BGRA rectangles leave it.
 * A malformed update poisons and clears the engine: history-dependent orders
 * cannot safely be skipped and silently resumed after a parser failure.
 */
export class GdiOrders {
    constructor({ width, height, bpp = 24, revision = 1, offscreen = true, maxWork = MAX_ORDER_WORK }) {
        requireThat(Number.isInteger(maxWork) && maxWork > 0 && maxWork <= MAX_ORDER_WORK, 'GDI_WORK', 'Invalid order work budget');
        this.screen = createSurface(width, height); this.dirty = new DirtyTiles(width, height);
        this.cache = new BitmapCache({ bpp, revision }); this.bpp = bpp; this.revision = revision;
        this.maxWork = maxWork; this.offscreenEnabled = offscreen; this.offscreen = new Map(); this.offscreenBytes = 0;
        this.surfaceId = 0xffff; this.lastType = 1; this.fields = new Map();
        this.bounds = { left: 0, top: 0, right: 0, bottom: 0 };
        this.palette = Uint32Array.from({ length: 256 }, (_, i) => i * 0x010101);
        this.pattern = new Uint32Array(64); this.closed = false;
        this.orders = this.primaryOrders = this.secondaryOrders = this.work = this.damageBytes = 0;
    }
    charge(pixels) {
        requireThat(Number.isInteger(pixels) && pixels >= 0 && this.work + pixels <= this.maxWork,
            'GDI_WORK', 'Drawing update exceeds its raster/decompression work budget');
        this.work += pixels;
    }
    resize(width, height) {
        requireThat(!this.closed, 'GDI_CLOSED', 'Drawing engine is closed');
        // Drawing-order field/cached-bitmap history is connection-local. A
        // reactivation replaces only the primary surface, just like renderers.
        const next = createSurface(width, height); this.screen.pixels.fill(0); this.screen = next;
        this.dirty = new DirtyTiles(width, height); this.surfaceId = 0xffff;
    }
    setPalette(rgba) {
        requireThat(!this.closed && rgba instanceof Uint8Array && rgba.length === 1024, 'GDI_PALETTE', 'Invalid desktop palette');
        for (let i = 0; i < 256; i++) this.palette[i] = rgba[i * 4] << 16 | rgba[i * 4 + 1] << 8 | rgba[i * 4 + 2];
    }
    bitmap(rectangles) {
        requireThat(!this.closed, 'GDI_CLOSED', 'Drawing engine is closed');
        // Observe BEFORE the session worker transfers/detaches bitmap buffers.
        // These pixels were already emitted through the ordinary bitmap path;
        // do not mark them dirty a second time.
        for (const bitmap of rectangles) {
            const source = bitmapPixels(bitmap, this.palette);
            try { blit(this.screen, { x: bitmap.x, y: bitmap.y, width: bitmap.drawWidth, height: bitmap.drawHeight }, { source }); }
            finally { source.pixels.fill(0); }
        }
    }
    receive(r, count) {
        try {
            requireThat(!this.closed && Number.isInteger(count) && count >= 0 && count <= MAX_ORDER_COUNT,
                'GDI_COUNT', 'Invalid drawing update count or closed engine');
            this.work = 0;
            for (let i = 0; i < count; i++) {
                const control = r.u8();
                if (!(control & 1)) this.alternate(control, r);
                else if (control & 2) {
                    const length = i16(r) + 7, flags = r.u16le(), type = r.u8();
                    requireThat(length >= 0, 'GDI_ORDER_LENGTH', 'Invalid secondary order length');
                    const body = r.sub(length);
                    this.cache.receive(type, flags, body, pixels => this.charge(pixels)); body.end(); this.secondaryOrders++;
                } else { this.primary(control, r); this.primaryOrders++; }
                this.orders++;
            }
            r.end();
            const rectangles = this.dirty.take(this.screen);
            this.damageBytes += rectangles.reduce((n, v) => n + v.data.length, 0);
            return rectangles;
        } catch (error) { this.close(); throw error; }
    }
    primary(control, r) {
        if (control & 8) this.lastType = r.u8();
        const schema = schemas.get(this.lastType);
        requireThat(schema, 'GDI_ORDER', `Unnegotiated primary drawing order ${this.lastType}`);
        const fieldBytes = Math.ceil((schema.length + 1) / 8), omitted = control >>> 6;
        requireThat(omitted <= fieldBytes, 'GDI_FIELDS', 'Invalid omitted field-flag byte count');
        let mask = 0;
        for (let i = 0; i < fieldBytes - omitted; i++) mask |= r.u8() << (i * 8);
        requireThat((mask >>> schema.length) === 0, 'GDI_FIELDS', 'Unexpected primary field flags');
        if ((control & 4) && !(control & 32)) {
            const flags = r.u8();
            for (const [i, name] of ['left', 'top', 'right', 'bottom'].entries()) {
                // If both are set the delta takes precedence (MS-RDPEGDI).
                if (flags & (16 << i)) this.bounds[name] = coordinate(this.bounds[name] + i8(r));
                else if (flags & (1 << i)) this.bounds[name] = i16(r);
            }
        }
        const bounds = control & 4 ? this.bounds : null;
        if (bounds) requireThat(bounds.left <= bounds.right && bounds.top <= bounds.bottom, 'GDI_BOUNDS', 'Inverted drawing bounds');
        let state = this.fields.get(this.lastType);
        if (!state) { state = Object.fromEntries(schema.map(([name, type]) => [name, type === 'bytes7' ? new Uint8Array(7) : 0])); this.fields.set(this.lastType, state); }
        for (let i = 0; i < schema.length; i++) if (mask & (1 << i)) {
            const [name, type] = schema[i];
            if (type === 'coord') state[name] = control & 16 ? coordinate(state[name] + i8(r)) : i16(r);
            else if (type === 'u8') state[name] = r.u8();
            else if (type === 'u16') state[name] = r.u16le();
            else if (type === 'i8') state[name] = i8(r);
            else if (type === 'color') state[name] = color(r);
            else { requireThat(state.style === 3, 'GDI_BRUSH', 'Inline brush data requires BS_PATTERN'); state[name].set(r.take(7)); }
        }
        this.draw(this.lastType, state, bounds);
    }
    draw(type, s, bounds) {
        const target = this.surfaceId === 0xffff ? this.screen : this.offscreen.get(this.surfaceId);
        requireThat(target && s.width >= 0 && s.height >= 0, 'GDI_RECT', 'Invalid target or negative drawing extent');
        const area = clipRect(target, s, bounds);
        this.charge(area.width * area.height);
        if (!area.width || !area.height) return;
        const code = type === 10 ? 0xf0 : s.code;
        requireThat(![0, 1].includes(type) || !dependsOn(code, 2), 'GDI_ROP', 'Destination/pattern order cannot read source');
        requireThat(![0, 2, 13].includes(type) || !dependsOn(code, 4), 'GDI_ROP', 'Unnegotiated pattern dependency');
        let pattern = null, borrowed = null, source = null, sy = s.sy;
        try {
            if (dependsOn(code, 4)) {
                pattern = this.pattern;
                if (type === 10) pattern.fill(s.red << 16 | s.green << 8 | s.blue);
                else {
                    requireThat([0, 1, 3].includes(s.style), 'GDI_BRUSH', 'Only negotiated solid, null and inline pattern brushes are supported');
                    if (s.style === 1) return;
                    if (s.style === 0) pattern.fill(s.fore);
                    else for (let y = 0; y < 8; y++) {
                        const row = y === 7 ? s.hatch : s.extra[6 - y];
                        for (let x = 0; x < 8; x++) pattern[y * 8 + x] = row & (128 >>> x) ? s.back : s.fore;
                    }
                }
            }
            if (dependsOn(code, 2)) {
                if (type === 2) source = this.screen;
                else {
                    if ((s.cacheId & 255) === 255) {
                        requireThat(this.offscreenEnabled && (s.cacheId >>> 8) < 6, 'GDI_OFFSCREEN', 'Unnegotiated offscreen source');
                        source = this.offscreen.get(s.index);
                        requireThat(source, 'GDI_OFFSCREEN_MISS', 'Offscreen source does not exist');
                    } else { borrowed = this.cache.get(s.cacheId, s.index, pixels => this.charge(pixels)); source = borrowed.surface; }
                    sy = source.height - s.height - s.sy;
                }
            }
            const changed = blit(target, s, { source, sx: s.sx, sy, pattern, orgX: s.orgX, orgY: s.orgY, code, bounds });
            if (changed && this.surfaceId === 0xffff) this.dirty.mark(changed);
        } finally { borrowed?.release(); }
    }
    alternate(control, r) {
        requireThat((control & 3) === 2 && this.offscreenEnabled, 'GDI_ALTERNATE', 'Unnegotiated alternate secondary order');
        const type = control >>> 2;
        if (type === 0) {
            const id = r.u16le();
            requireThat(id === 0xffff || this.offscreen.has(id), 'GDI_OFFSCREEN_MISS', 'Offscreen target does not exist');
            this.surfaceId = id; return;
        }
        requireThat(type === 1, 'GDI_ALTERNATE', 'Unnegotiated alternate secondary order type');
        const flags = r.u16le(), id = flags & 0x7fff, width = r.u16le(), height = r.u16le(), removed = new Set([id]);
        requireThat(id < OFFSCREEN_ENTRIES, 'GDI_OFFSCREEN_ID', 'Offscreen ID exceeds advertised entries');
        if (flags & 0x8000) {
            const count = r.u16le(); requireThat(count <= OFFSCREEN_ENTRIES, 'GDI_OFFSCREEN_COUNT', 'Excessive offscreen delete list');
            for (let i = 0; i < count; i++) {
                const deleted = r.u16le(); requireThat(deleted < OFFSCREEN_ENTRIES, 'GDI_OFFSCREEN_ID', 'Invalid deleted offscreen ID'); removed.add(deleted);
            }
        }
        requireThat(this.surfaceId === 0xffff || this.surfaceId === id || !removed.has(this.surfaceId),
            'GDI_OFFSCREEN_ACTIVE', 'Cannot delete the active offscreen target without switching surfaces');
        let size = this.offscreenBytes;
        for (const key of removed) size -= this.offscreen.get(key)?.pixels.byteLength || 0;
        requireThat(size + width * height * 4 <= OFFSCREEN_KIB * 1024, 'GDI_OFFSCREEN_BUDGET', 'Offscreen allocation exceeds advertised budget');
        this.charge(width * height);
        const created = createSurface(width, height, OFFSCREEN_KIB * 256);
        for (const key of removed) { this.offscreen.get(key)?.pixels.fill(0); this.offscreen.delete(key); }
        this.offscreen.set(id, created); this.offscreenBytes = size + created.pixels.byteLength;
    }
    stats() { return { orders: this.orders, primaryOrders: this.primaryOrders, secondaryOrders: this.secondaryOrders,
        shadowBytes: this.screen.pixels.byteLength, cacheBytes: this.cache.bytes, offscreenBytes: this.offscreenBytes, damageBytes: this.damageBytes }; }
    close() {
        if (this.closed) return;
        this.closed = true; this.screen.pixels.fill(0); this.screen.pixels = new Uint32Array(); this.dirty.clear(); this.cache.close();
        for (const surface of this.offscreen.values()) surface.pixels.fill(0);
        this.offscreen.clear(); this.offscreenBytes = 0; this.palette.fill(0); this.pattern.fill(0);
        for (const state of this.fields.values()) state.extra?.fill(0);
        this.fields.clear(); this.bounds = { left: 0, top: 0, right: 0, bottom: 0 };
    }
}

import { Reader } from '../../binary/Reader.js';
import { requireThat } from '../../binary/ProtocolError.js';
import { clipRect } from './Raster.js';

export const MAX_DELTA_RECTANGLES = 45;
export const MAX_DELTA_RECTANGLE_BYTES = 383; // ceil(45 / 2) + 45 * 4 * 2.

/** MS-RDPEGDI packed signed 7/15-bit value, not the sign/magnitude
 * TWO_BYTE_SIGNED_ENCODING used by secondary glyph-cache orders. */
export function rectangleDelta(reader) {
    const first = reader.u8();
    if (!(first & 0x80)) return (first << 25) >> 25;
    return (((first & 0x7f) << 8 | reader.u8()) << 17) >> 17;
}

/** DELTA_RECTS_FIELD. Left/top accumulate from the implicit zero rectangle;
 * encoded widths/heights replace, while omitted widths/heights repeat.
 * Decode before modifying retained state; returned rectangles own their data.
 */
export function decodeDeltaRectangles(bytes, count) {
    requireThat(bytes instanceof Uint8Array && bytes.length <= MAX_DELTA_RECTANGLE_BYTES &&
        Number.isInteger(count) && count >= 0 && count <= MAX_DELTA_RECTANGLES,
        'GDI_DELTA_RECTS', 'Invalid delta-rectangle count or encoded length');
    const reader = new Reader(bytes), zeros = reader.take(Math.ceil(count / 2)), result = [];
    let x = 0, y = 0, width = 0, height = 0;
    for (let i = 0; i < count; i++) {
        const flags = (zeros[i >>> 1] >>> (i & 1 ? 0 : 4)) & 15;
        if (!(flags & 8)) x += rectangleDelta(reader);
        if (!(flags & 4)) y += rectangleDelta(reader);
        if (!(flags & 2)) width = rectangleDelta(reader);
        if (!(flags & 1)) height = rectangleDelta(reader);
        requireThat(x >= -32768 && x <= 32767 && y >= -32768 && y <= 32767 && width >= 0 && height >= 0,
            'GDI_DELTA_RECTS', 'Delta rectangles exceed coordinate or extent bounds');
        result.push({ x, y, width, height });
    }
    reader.end();
    return result;
}

/** Intersect one drawing operation with the UNION of its clipping rectangles.
 * Produces disjoint, top-to-bottom scan bands. A destination pixel is touched
 * once even when bounding rectangles overlap (important for XOR operations).
 * At most 45 rectangles imply at most 89 bands and 45 intervals per band.
 */
export function multiClip(surface, base, rectangles, count, bounds) {
    requireThat(Number.isInteger(count) && count >= 0 && count <= MAX_DELTA_RECTANGLES && count <= rectangles.length,
        'GDI_DELTA_HISTORY', 'Multi-order refers to unavailable rectangle history');
    const area = clipRect(surface, base, bounds);
    if (!area.width || !area.height || !count) return [];
    const limit = { left: area.x, top: area.y, right: area.x + area.width - 1, bottom: area.y + area.height - 1 };
    const clipped = rectangles.slice(0, count).map(rect => clipRect(surface, rect, limit)).filter(r => r.width && r.height);
    const edges = [...new Set(clipped.flatMap(r => [r.y, r.y + r.height]))].sort((a, b) => a - b);
    const result = [];
    for (let i = 1; i < edges.length; i++) {
        const y = edges[i - 1], height = edges[i] - y;
        const spans = clipped.filter(r => r.y <= y && r.y + r.height >= edges[i])
            .map(r => [r.x, r.x + r.width]).sort((a, b) => a[0] - b[0]);
        let left = -1, right = -1;
        const append = () => { if (right > left) result.push({ x: left, y, width: right - left, height }); };
        for (const span of spans) {
            if (span[0] > right) { append(); [left, right] = span; }
            else right = Math.max(right, span[1]);
        }
        append();
    }
    return result;
}

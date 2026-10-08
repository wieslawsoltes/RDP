export function cursorState() { return { x: 0, y: 0, width: 1, height: 1, hotX: 0, hotY: 0, mode: 0, pixels: new Uint8Array(4), system: 'default' }; }
export function updateCursor(cursor, event) {
    const kind = event.kind || event.type;
    if (kind === 'position') {
        cursor.x = event.x;
        cursor.y = event.y;
    }
    if (kind === 'shape') {
        Object.assign(cursor, event.shape);
        cursor.system = 'custom';
    }
    if (kind === 'hidden' || kind === 'default') {
        cursor.mode = 0;
        cursor.system = kind;
    }
    return kind === 'shape';
}
/** Exact classic AND/XOR cursor; alpha cursor compositing is intentionally separate. */
export function compositeCursorPixel(base, offset, pixel, cursorOffset, mode) {
    const mask = pixel[cursorOffset + 3];
    for (let c = 0; c < 3; c++)
        base[offset + c] = mode === 1 ? (base[offset + c] & mask) ^ pixel[cursorOffset + c] : Math.round(base[offset + c] * (1 - mask / 255) + pixel[cursorOffset + c] * mask / 255);
    base[offset + 3] = 255;
}
export function cursorCss(canvas, cursor) { canvas.style.cursor = cursor.system === 'default' ? 'default' : 'none'; }

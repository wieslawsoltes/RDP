import { validateBitmap } from '../codecs/Pixels.js';
import { requireThat } from '../binary/ProtocolError.js';
const intersects = (a, b) => a.x < b.x + b.drawWidth && b.x < a.x + a.drawWidth && a.y < b.y + b.drawHeight && b.y < a.y + a.drawHeight;
/** Consecutive non-overlapping rectangles may run in parallel. Overlaps impose a pass boundary. */
export function planBatches(rectangles, width, height) {
    requireThat(rectangles.length <= 4096, 'RENDER_LIMIT', 'Too many rectangles per render batch');
    const batches = [];
    let active = [], first = 0, dataSize = 0, pixels = 0, groupX = 0, groupY = 0;
    const finish = () => {
        if (active.length)
            batches.push({ first, count: active.length, groupX, groupY });
        first += active.length;
        active = [];
        groupX = groupY = 0;
    };
    for (const rect of rectangles) {
        validateBitmap(rect);
        requireThat(Number.isInteger(rect.x) && Number.isInteger(rect.y) && Number.isInteger(rect.drawWidth) && Number.isInteger(rect.drawHeight) && rect.x >= 0 && rect.y >= 0 && rect.drawWidth > 0 && rect.drawHeight > 0 && rect.drawWidth <= rect.width && rect.drawHeight <= rect.height && rect.x + rect.drawWidth <= width && rect.y + rect.drawHeight <= height, 'RENDER_BOUNDS', 'Bitmap outside desktop');
        if (active.some(other => intersects(rect, other)))
            finish();
        active.push(rect);
        groupX = Math.max(groupX, Math.ceil(rect.drawWidth / 8));
        groupY = Math.max(groupY, Math.ceil(rect.drawHeight / 8));
        dataSize = (dataSize + rect.data.length + 3) & ~3;
        pixels += rect.drawWidth * rect.drawHeight;
        requireThat(dataSize <= 68 * 1024 * 1024, 'RENDER_LIMIT', 'Render upload exceeds limit');
    }
    finish();
    return { batches, dataSize, pixels };
}

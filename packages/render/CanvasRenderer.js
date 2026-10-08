import { toRgba, defaultPalette } from '../codecs/Pixels.js';
import { cursorState, updateCursor, cursorCss, compositeCursorPixel } from './Cursor.js';
import { planBatches } from './BatchPlanner.js';
import { requireThat } from '../binary/ProtocolError.js';
export class CanvasRenderer {
    static async create(canvas) { return new CanvasRenderer(canvas); }
    constructor(canvas) {
        this.canvas = canvas;
        this.context = canvas.getContext('2d', { alpha: false, desynchronized: true });
        requireThat(this.context, 'CANVAS_CONTEXT', 'Canvas 2D is unavailable');
        this.back = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(640, 400) : document.createElement('canvas');
        this.backContext = this.back.getContext('2d', { alpha: false, willReadFrequently: true });
        this.palette = defaultPalette();
        this.cursor = cursorState();
        this.stats = { backend: 'Canvas 2D', frames: 0, rectangles: 0, pixels: 0, uploadedBytes: 0, submitMs: 0, gpuMs: null };
        this.resize(640, 400);
    }
    resize(width, height) { requireThat(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16777216, 'CANVAS_LIMIT', 'Desktop exceeds Canvas limits'); this.width = this.canvas.width = this.back.width = width; this.height = this.canvas.height = this.back.height = height; this.present(); }
    setPalette(palette) { requireThat(palette.length === 1024, 'PALETTE_SIZE', 'Invalid palette'); this.palette = palette.slice(); }
    setPointer(event) { updateCursor(this.cursor, event); cursorCss(this.canvas, this.cursor); }
    apply(rectangles) {
        const start = performance.now(), plan = planBatches(rectangles, this.width, this.height);
        for (const rect of rectangles)
            this.backContext.putImageData(new ImageData(toRgba(rect, this.palette), rect.width, rect.height), rect.x, rect.y, 0, 0, rect.drawWidth, rect.drawHeight);
        this.present();
        this.stats.rectangles += rectangles.length;
        this.stats.pixels += plan.pixels;
        this.stats.uploadedBytes += plan.dataSize;
        this.stats.submitMs = performance.now() - start;
    }
    present() {
        this.context.drawImage(this.back, 0, 0);
        const c = this.cursor;
        if (c.mode) {
            const left = c.x - c.hotX, top = c.y - c.hotY, x = Math.max(0, left), y = Math.max(0, top), right = Math.min(this.width, left + c.width), bottom = Math.min(this.height, top + c.height);
            if (right > x && bottom > y) {
                const image = this.backContext.getImageData(x, y, right - x, bottom - y);
                for (let py = y; py < bottom; py++)
                    for (let px = x; px < right; px++)
                        compositeCursorPixel(image.data, ((py - y) * image.width + px - x) * 4, c.pixels, ((py - top) * c.width + px - left) * 4, c.mode);
                this.context.putImageData(image, x, y);
            }
        }
        this.stats.frames++;
    }
    async readSurface() { return new Uint8Array(this.backContext.getImageData(0, 0, this.width, this.height).data); }
    destroy() { this.back.width = this.back.height = this.canvas.width = this.canvas.height = 1; }
}

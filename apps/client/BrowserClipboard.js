import { CLIPBOARD_LIMIT, CLIPBOARD_PIXELS, inspectClipboardPng } from '../../packages/codecs/ClipboardFormats.js';

const check = (condition, message) => { if (!condition) throw new Error(message); };
function imageCanvas(image) {
    const { width, height, rgba } = image;
    check(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
        width <= 8192 && height <= 8192 && width * height <= CLIPBOARD_PIXELS &&
        rgba instanceof Uint8Array && rgba.length === width * height * 4, 'Invalid clipboard image');
    const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    check(context, 'Clipboard image conversion is unavailable');
    context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    return canvas;
}
async function imageBlob(image) {
    const canvas = imageCanvas(image);
    try {
        const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) :
            await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        check(blob && blob.size <= CLIPBOARD_LIMIT, 'Encoded clipboard image exceeds 8 MiB');
        return blob;
    } finally { canvas.width = canvas.height = 1; }
}

/** Explicit user action only. No polling, hidden reads or external image URLs. */
export async function readBrowserClipboard() {
    check(globalThis.isSecureContext && navigator.clipboard, 'Clipboard access requires a secure context and browser permission');
    if (!navigator.clipboard.read) {
        const text = await navigator.clipboard.readText();
        check(text.length <= CLIPBOARD_LIMIT / 2, 'Clipboard text exceeds its size limit');
        return { text };
    }
    const items = await navigator.clipboard.read();
    check(items.length > 0, 'The clipboard is empty');
    const content = {};
    try {
        // One OS clipboard item can expose several representations of the same data.
        const item = items[0];
        for (const [mime, key] of [['text/plain', 'text'], ['text/html', 'html'], ['image/png', 'png']]) {
            if (!item.types.includes(mime)) continue;
            const blob = await item.getType(mime);
            check(blob.size <= CLIPBOARD_LIMIT, 'Clipboard format exceeds 8 MiB');
            if (key !== 'png') content[key] = await blob.text();
            else {
                content.png = new Uint8Array(await blob.arrayBuffer());
                const { width, height } = inspectClipboardPng(content.png);
                check(typeof createImageBitmap === 'function', 'Browser image decoding is unavailable');
                const bitmap = await createImageBitmap(new Blob([content.png], { type: 'image/png' }));
                let canvas;
                try {
                    check(bitmap.width === width && bitmap.height === height, 'Clipboard image dimensions changed during decode');
                    canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
                    canvas.width = width; canvas.height = height;
                    const context = canvas.getContext('2d', { willReadFrequently: true });
                    check(context, 'Clipboard image conversion is unavailable');
                    context.drawImage(bitmap, 0, 0);
                    content.image = { width, height, rgba: new Uint8Array(context.getImageData(0, 0, width, height).data.buffer) };
                } finally { bitmap.close(); if (canvas) canvas.width = canvas.height = 1; }
            }
        }
        check(Object.keys(content).length > 0, 'Clipboard contains no supported text, HTML or PNG format');
        return content;
    } catch (error) { releaseClipboardContent(content); throw error; }
}

/** Invoke directly from a click. Promise-valued PNG conversion preserves activation. */
export function writeBrowserClipboard(content) {
    check(globalThis.isSecureContext && navigator.clipboard, 'Clipboard access requires a secure context and browser permission');
    const data = {};
    try {
        for (const [key, mime] of [['text', 'text/plain'], ['html', 'text/html']]) {
            if (content[key] == null) continue;
            check(typeof content[key] === 'string' && content[key].length <= CLIPBOARD_LIMIT, 'Invalid clipboard text');
            const blob = new Blob([content[key]], { type: mime });
            check(blob.size <= CLIPBOARD_LIMIT, 'Clipboard text exceeds 8 MiB');
            data[mime] = blob;
        }
        if (content.png) {
            inspectClipboardPng(content.png);
            data['image/png'] = new Blob([content.png], { type: 'image/png' });
        } else if (content.image) data['image/png'] = imageBlob(content.image);
        check(Object.keys(data).length > 0, 'Fetch a remote format before copying it');
        if (typeof ClipboardItem === 'undefined' || !navigator.clipboard.write) {
            // Never silently drop requested rich formats and claim a successful copy.
            check(Object.keys(data).length === 1 && typeof content.text === 'string', 'This browser does not support rich clipboard writes');
            return navigator.clipboard.writeText(content.text);
        }
        for (const mime of Object.keys(data)) check(!ClipboardItem.supports || ClipboardItem.supports(mime), `Browser does not support ${mime}`);
        return navigator.clipboard.write([new ClipboardItem(data)]);
    } catch (error) {
        // A conversion promise may outlive a synchronous capability rejection.
        for (const value of Object.values(data)) value?.catch?.(() => {});
        throw error;
    }
}

export function releaseClipboardContent(content) {
    if (content?.png?.byteLength) content.png.fill(0);
    if (content?.image?.rgba?.byteLength) content.image.rgba.fill(0);
}

/** Main-thread owned snapshot, never shared with worker cache or inserted as HTML. */
export class ClipboardSnapshot {
    constructor() { this.generation = 0; this.epoch = 0; this.value = {}; this.formats = []; }
    clear() {
        releaseClipboardContent(this.value);
        this.value = {}; this.formats = []; this.epoch++;
    }
    apply(event) {
        if (event.kind === 'formats') {
            if (event.generation < this.generation) return false;
            this.clear(); this.generation = event.generation; this.formats = [...event.formats];
            return true;
        }
        if (event.generation !== this.generation) return false;
        if (event.kind === 'text') this.value.text = event.text;
        else if (event.kind === 'html') this.value.html = event.html;
        else if (event.kind === 'image') {
            releaseClipboardContent(this.value);
            delete this.value.png; delete this.value.image;
            if (event.encoding === 'png') this.value.png = event.bytes;
            else this.value.image = { width: event.width, height: event.height, rgba: event.rgba };
        } else return false;
        return true;
    }
}

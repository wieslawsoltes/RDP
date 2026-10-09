import { ProtocolError, requireThat } from '../binary/ProtocolError.js';
import { concat } from '../binary/Writer.js';

export const CLIPBOARD_LIMIT = 8 * 1024 * 1024;
export const CLIPBOARD_PIXELS = 2 * 1024 * 1024;
const utf8 = new TextEncoder();
const text = bytes => {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new ProtocolError('CLIPBOARD_UTF8', 'Clipboard HTML is not valid UTF-8'); }
};
const bounded = bytes => requireThat(bytes instanceof Uint8Array && bytes.length <= CLIPBOARD_LIMIT,
    'CLIPBOARD_LIMIT', 'Clipboard payload exceeds 8 MiB');
function dimensions(width, height) {
    requireThat(Number.isSafeInteger(width) && width > 0 && width <= 8192 &&
        Number.isSafeInteger(height) && height > 0 && height <= 8192 && width * height <= CLIPBOARD_PIXELS,
        'CLIPBOARD_IMAGE_SIZE', 'Clipboard image exceeds 8192 pixels per axis or 2 megapixels');
}

/** CF_HTML offsets are UTF-8 BYTE offsets, not JavaScript UTF-16 indices. */
export function encodeClipboardHtml(fragment) {
    requireThat(typeof fragment === 'string' && fragment.length <= CLIPBOARD_LIMIT && !fragment.includes('\0'),
        'CLIPBOARD_HTML', 'Invalid clipboard HTML');
    const prefix = utf8.encode('<html><body><!--StartFragment-->');
    const suffix = utf8.encode('<!--EndFragment--></body></html>');
    const body = utf8.encode(fragment);
    const header = offsets => 'Version:1.0\r\n' + ['StartHTML', 'EndHTML', 'StartFragment', 'EndFragment']
        .map((name, i) => `${name}:${String(offsets[i]).padStart(10, '0')}\r\n`).join('');
    const start = header([0, 0, 0, 0]).length;
    const end = start + prefix.length + body.length + suffix.length;
    requireThat(end + 1 <= CLIPBOARD_LIMIT, 'CLIPBOARD_LIMIT', 'Clipboard HTML exceeds 8 MiB');
    return concat(utf8.encode(header([start, end, start + prefix.length, start + prefix.length + body.length])),
        prefix, body, suffix, Uint8Array.of(0));
}

/** Returns inert markup. Callers MUST NOT insert this into the application's DOM. */
export function decodeClipboardHtml(bytes) {
    bounded(bytes);
    // Scan only ASCII header lines. Stop before context, even if the fragment
    // itself contains strings such as StartHTML: or Version:.
    const values = new Map();
    let p = 0;
    while (p < bytes.length && p < 8192) {
        const start = p;
        while (p < bytes.length && p < 8192 && bytes[p] !== 10 && bytes[p] !== 13 && bytes[p] !== 60) p++;
        if (bytes[p] === 60 || p === bytes.length || p === 8192) { p = start; break; }
        const line = text(bytes.subarray(start, p));
        if (bytes[p++] === 13 && bytes[p] === 10) p++;
        const match = /^([A-Za-z]+):\s*([^\r\n]*)$/.exec(line);
        requireThat(match, 'CLIPBOARD_HTML_HEADER', 'Malformed CF_HTML header');
        const [, name, value] = match;
        requireThat(!values.has(name), 'CLIPBOARD_HTML_HEADER', 'Duplicate CF_HTML field');
        values.set(name, value);
        const declared = values.get('StartHTML');
        if (declared !== undefined && Number(declared) >= 0 && p >= Number(declared)) break;
        if (Number(declared) === -1 && values.has('EndFragment') && p >= Number(values.get('StartFragment'))) break;
    }
    requireThat(/^(?:0\.9|1\.0)$/.test(values.get('Version') || ''), 'CLIPBOARD_HTML_HEADER', 'Unsupported CF_HTML version');
    const offset = name => {
        const value = values.get(name);
        requireThat(typeof value === 'string' && /^(?:-1|\d{1,16})$/.test(value) && Number.isSafeInteger(Number(value)),
            'CLIPBOARD_HTML_OFFSET', `Invalid ${name} offset`);
        return Number(value);
    };
    const start = offset('StartHTML'), end = offset('EndHTML'), first = offset('StartFragment'), last = offset('EndFragment');
    requireThat(first >= p && first <= last && last <= bytes.length &&
        ((start === -1 && end === -1) || (start >= p && start <= first && last <= end && end <= bytes.length)),
        'CLIPBOARD_HTML_OFFSET', 'CF_HTML offsets are outside the payload');
    const fragment = text(bytes.subarray(first, last));
    requireThat(!fragment.includes('\0'), 'CLIPBOARD_HTML', 'Clipboard HTML contains NUL');
    return fragment;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
});
const crc = bytes => {
    let value = 0xffffffff;
    for (const b of bytes) value = crcTable[(value ^ b) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
};

/** Validate PNG structure and dimensions BEFORE a browser decoder allocates pixels. */
export function inspectClipboardPng(bytes) {
    bounded(bytes);
    requireThat(bytes.length >= 45 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b),
        'CLIPBOARD_PNG', 'Invalid PNG signature');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 8, width = 0, height = 0, image = false, ended = false, chunks = 0, palette = false, color;
    let imageEnded = false;
    while (p < bytes.length) {
        requireThat(p + 12 <= bytes.length && ++chunks <= 4096, 'CLIPBOARD_PNG', 'Truncated or excessive PNG chunks');
        const length = view.getUint32(p), type = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
        requireThat(length <= bytes.length - p - 12 && /^[A-Za-z]{4}$/.test(type), 'CLIPBOARD_PNG', 'Invalid PNG chunk');
        requireThat(crc(bytes.subarray(p + 4, p + 8 + length)) === view.getUint32(p + 8 + length),
            'CLIPBOARD_PNG_CRC', 'PNG chunk checksum mismatch');
        requireThat(chunks !== 1 || type === 'IHDR', 'CLIPBOARD_PNG', 'PNG must begin with IHDR');
        if (type === 'IHDR') {
            requireThat(chunks === 1 && length === 13, 'CLIPBOARD_PNG', 'Invalid PNG image header');
            width = view.getUint32(p + 8); height = view.getUint32(p + 12); dimensions(width, height);
            const depth = bytes[p + 16]; color = bytes[p + 17];
            const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
            requireThat(depths[color]?.includes(depth) && bytes[p + 18] === 0 && bytes[p + 19] === 0 && bytes[p + 20] <= 1,
                'CLIPBOARD_PNG', 'Invalid PNG pixel format');
        } else if (type === 'PLTE') {
            requireThat(!palette && !image && length >= 3 && length <= 768 && length % 3 === 0 && ![0, 4].includes(color),
                'CLIPBOARD_PNG', 'Invalid PNG palette');
            palette = true;
        } else if (type === 'IDAT') {
            requireThat(!imageEnded && (color !== 3 || palette), 'CLIPBOARD_PNG', 'Invalid PNG image data order');
            image = true;
        } else if (type === 'IEND') {
            requireThat(length === 0 && image && p + 12 === bytes.length, 'CLIPBOARD_PNG', 'Invalid PNG ending');
            ended = true;
        } else {
            requireThat(type[0] === type[0].toLowerCase() && !['acTL', 'fcTL', 'fdAT'].includes(type),
                'CLIPBOARD_PNG', 'Unsupported critical or animated PNG chunk');
            if (image) imageEnded = true;
        }
        p += length + 12;
    }
    requireThat(ended, 'CLIPBOARD_PNG', 'PNG has no IEND chunk');
    return { width, height };
}

function maskChannel(mask, bits) {
    requireThat(Number.isInteger(mask) && mask >= 0 && mask < 2 ** bits, 'CLIPBOARD_DIB_MASK', 'Invalid pixel mask');
    if (!mask) return null;
    let shift = 0;
    while (((mask >>> shift) & 1) === 0) shift++;
    const maximum = mask >>> shift;
    requireThat((maximum & (maximum + 1)) === 0, 'CLIPBOARD_DIB_MASK', 'Pixel mask is not contiguous');
    return { mask, shift, maximum };
}

/** Packed Windows DIB (no BITMAPFILEHEADER): RGB and bitfields, palettes 1/4/8 bpp. */
export function decodeClipboardDib(bytes) {
    bounded(bytes);
    requireThat(bytes.length >= 40, 'CLIPBOARD_DIB', 'Truncated DIB header');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), header = v.getUint32(0, true);
    requireThat([40, 52, 56, 108, 124].includes(header) && bytes.length >= header,
        'CLIPBOARD_DIB', 'Unsupported DIB header');
    const width = v.getInt32(4, true), signedHeight = v.getInt32(8, true), height = Math.abs(signedHeight);
    dimensions(width, height);
    const bpp = v.getUint16(14, true), compression = v.getUint32(16, true), colors = v.getUint32(32, true);
    requireThat(v.getUint16(12, true) === 1 && [1, 4, 8, 16, 24, 32].includes(bpp) &&
        (compression === 0 || ([3, 6].includes(compression) && [16, 32].includes(bpp))),
        'CLIPBOARD_DIB_FORMAT', 'Only uncompressed RGB and bitfield DIBs are supported');
    let offset = header;
    let masks = bpp === 16 ? [0x7c00, 0x3e0, 0x1f, 0] : [0xff0000, 0xff00, 0xff, 0];
    if (compression !== 0) {
        const count = compression === 6 ? 4 : 3;
        if (header === 40) {
            requireThat(bytes.length >= offset + count * 4, 'CLIPBOARD_DIB_MASK', 'Truncated DIB masks');
            masks = Array.from({ length: count }, (_, i) => v.getUint32(offset + i * 4, true));
            if (count === 3) masks.push(0);
            offset += count * 4;
        } else {
            requireThat(compression !== 6 || header >= 56, 'CLIPBOARD_DIB_MASK', 'Alpha mask missing');
            masks = [v.getUint32(40, true), v.getUint32(44, true), v.getUint32(48, true), header >= 56 ? v.getUint32(52, true) : 0];
        }
        requireThat(masks.slice(0, 3).every(Boolean) && (compression !== 6 || masks[3]), 'CLIPBOARD_DIB_MASK', 'Empty DIB color mask');
        for (let i = 0; i < 4; i++) for (let j = 0; j < i; j++)
            requireThat((masks[i] & masks[j]) === 0, 'CLIPBOARD_DIB_MASK', 'Overlapping DIB masks');
    }
    if (header >= 108) {
        const space = v.getUint32(56, true);
        requireThat([0, 0x73524742, 0x57696e20].includes(space), 'CLIPBOARD_DIB_PROFILE', 'Embedded or linked color profiles are not supported');
        if (space === 0) requireThat(bytes.subarray(60, 108).every(b => b === 0), 'CLIPBOARD_DIB_PROFILE', 'Calibrated DIB color conversion is not supported');
    }
    if (header === 124) requireThat(v.getUint32(112, true) === 0 && v.getUint32(116, true) === 0,
        'CLIPBOARD_DIB_PROFILE', 'DIB external profile data is not supported');
    const paletteCount = bpp <= 8 ? colors || 2 ** bpp : colors;
    requireThat(paletteCount <= (bpp <= 8 ? 2 ** bpp : 256), 'CLIPBOARD_DIB_PALETTE', 'Excessive DIB palette');
    const palette = offset;
    offset += paletteCount * 4;
    const stride = Math.ceil(width * bpp / 32) * 4, size = stride * height;
    const declared = v.getUint32(20, true);
    requireThat(offset <= bytes.length && size <= bytes.length - offset && (declared === 0 || declared === size),
        'CLIPBOARD_DIB_LENGTH', 'DIB pixel data is truncated or has an invalid length');
    const channels = bpp >= 16 ? masks.map(m => maskChannel(m, bpp === 24 ? 32 : bpp)) : [];
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const row = offset + (signedHeight < 0 ? y : height - 1 - y) * stride;
        for (let x = 0; x < width; x++) {
            const o = (y * width + x) * 4;
            if (bpp <= 8) {
                const value = bytes[row + Math.floor(x * bpp / 8)];
                const index = (value >>> (8 - bpp - ((x * bpp) % 8))) & (2 ** bpp - 1);
                requireThat(index < paletteCount, 'CLIPBOARD_DIB_PALETTE', 'DIB pixel references a missing palette color');
                rgba.set([bytes[palette + index * 4 + 2], bytes[palette + index * 4 + 1], bytes[palette + index * 4], 255], o);
            } else {
                const p = row + x * bpp / 8;
                const value = bpp === 16 ? v.getUint16(p, true) : bpp === 32 ? v.getUint32(p, true) : bytes[p] | bytes[p + 1] << 8 | bytes[p + 2] << 16;
                for (let c = 0; c < 4; c++) {
                    const channel = channels[c];
                    rgba[o + c] = channel ? Math.round(((value & channel.mask) >>> channel.shift) * 255 / channel.maximum) : (c === 3 ? 255 : 0);
                }
            }
        }
    }
    return { width, height, rgba };
}

/** Emit sRGB DIBV5 with explicit alpha or a flattened 24-bit CF_DIB fallback. */
export function encodeClipboardDib({ width, height, rgba }, version5 = true) {
    dimensions(width, height);
    requireThat(rgba instanceof Uint8Array && rgba.length === width * height * 4, 'CLIPBOARD_DIB_PIXELS', 'Invalid RGBA clipboard image');
    const header = version5 ? 124 : 40, bpp = version5 ? 32 : 24, stride = Math.ceil(width * bpp / 32) * 4;
    const size = header + stride * height;
    requireThat(size <= CLIPBOARD_LIMIT, 'CLIPBOARD_LIMIT', 'Encoded DIB exceeds 8 MiB');
    const out = new Uint8Array(size), v = new DataView(out.buffer);
    v.setUint32(0, header, true); v.setInt32(4, width, true); v.setInt32(8, height, true);
    v.setUint16(12, 1, true); v.setUint16(14, bpp, true); v.setUint32(16, version5 ? 3 : 0, true);
    v.setUint32(20, stride * height, true);
    if (version5) {
        [0xff0000, 0xff00, 0xff, 0xff000000].forEach((m, i) => v.setUint32(40 + i * 4, m, true));
        v.setUint32(56, 0x73524742, true); v.setUint32(108, 4, true);
    }
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4, p = header + (height - 1 - y) * stride + x * bpp / 8;
        for (let c = 0; c < 3; c++) out[p + c] = version5 ? rgba[i + 2 - c] : Math.round((rgba[i + 2 - c] * rgba[i + 3] + 255 * (255 - rgba[i + 3])) / 255);
        if (version5) out[p + 3] = rgba[i + 3];
    }
    return out;
}

import { Reader } from '../binary/Reader.js';
import { requireThat, ProtocolError } from '../binary/ProtocolError.js';
import { decodeInterleaved } from '../codecs/InterleavedRle.js';
export function parseBitmapUpdate(reader, desktop) {
    const count = reader.u16le();
    requireThat(count <= 4096, 'BITMAP_COUNT', 'Too many bitmap rectangles');
    const bitmaps = [];
    let decodedBytes = 0;
    for (let i = 0; i < count; i++) {
        const x = reader.u16le(), y = reader.u16le(), right = reader.u16le(), bottom = reader.u16le();
        const width = reader.u16le(), height = reader.u16le(), bpp = reader.u16le(), flags = reader.u16le(), length = reader.u16le();
        requireThat(width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16777216, 'BITMAP_SIZE', 'Bitmap exceeds resource limits');
        requireThat(x <= right && y <= bottom && right < desktop.width && bottom < desktop.height && right - x + 1 <= width && bottom - y + 1 <= height, 'BITMAP_BOUNDS', 'Bitmap destination lies outside the remote desktop');
        requireThat([8, 15, 16, 24, 32].includes(bpp) && !(flags & ~0x401), 'BITMAP_FLAGS', 'Invalid bitmap format or flags');
        const bytesPerPixel = (bpp + 7) >> 3;
        decodedBytes += width * height * bytesPerPixel;
        requireThat(decodedBytes <= 64 * 1024 * 1024, 'FRAME_LIMIT', 'Decoded update exceeds 64 MiB');
        let source = reader.sub(length), data, stride;
        if (flags & 1) {
            if (!(flags & 0x400)) {
                const firstRow = source.u16le(), mainBody = source.u16le(), scanWidth = source.u16le(), uncompressed = source.u16le();
                requireThat(firstRow === 0 && mainBody === source.remaining && scanWidth > 0 && uncompressed > 0, 'BITMAP_COMPRESSION_HEADER', 'Invalid bitmap compression header');
            }
            if (bpp === 32)
                throw new ProtocolError('CODEC_NOT_NEGOTIATED', '32-bit planar bitmap compression was not negotiated');
            data = decodeInterleaved(source.take(source.remaining), width, height, bpp);
            stride = width * bytesPerPixel;
        }
        else {
            stride = (width * bytesPerPixel + 3) & ~3;
            requireThat(source.remaining === stride * height, 'BITMAP_LENGTH', 'Uncompressed bitmap length mismatch');
            data = source.take(source.remaining).slice();
        }
        bitmaps.push({ x, y, width, height, drawWidth: right - x + 1, drawHeight: bottom - y + 1, bpp, stride, bottomUp: true, data });
    }
    reader.end();
    return bitmaps;
}
export function parsePalette(reader) {
    reader.u16le();
    const count = reader.u32le();
    requireThat(count === 256, 'PALETTE', 'RDP palette must have 256 entries');
    const palette = new Uint8Array(1024);
    for (let i = 0; i < count; i++) {
        palette[i * 4] = reader.u8();
        palette[i * 4 + 1] = reader.u8();
        palette[i * 4 + 2] = reader.u8();
        palette[i * 4 + 3] = 255;
    }
    reader.end();
    return palette;
}

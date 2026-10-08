import { Reader } from '../binary/Reader.js';
import { requireThat, checkedSize, ProtocolError } from '../binary/ProtocolError.js';
/** MS-RDPBCGR 2.2.9.1.1.3.1.2.4. Original decoder; no external RDP code. */
export function decodeInterleaved(bytes, width, height, bpp) {
    requireThat([8, 15, 16, 24].includes(bpp), 'RLE_BPP', 'Interleaved RLE supports 8/15/16/24 bpp');
    requireThat(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0, 'RLE_SIZE', 'Invalid bitmap dimensions');
    const count = checkedSize(width * height, 16777216, 'Decoded bitmap pixels');
    const r = new Reader(bytes), pixels = new Uint32Array(count), pixelBytes = (bpp + 7) >> 3;
    const white = pixelBytes === 1 ? 255 : pixelBytes === 2 ? 65535 : 0xffffff;
    let position = 0, foreground = white, previousBackground = false, firstLine = true;
    const readPixel = () => {
        let pixel = 0;
        for (let n = 0; n < pixelBytes; n++)
            pixel |= r.u8() << (8 * n);
        return pixel;
    };
    const background = () => position < width ? 0 : pixels[position - width];
    const write = pixel => { requireThat(position < count, 'RLE_OVERFLOW', 'RLE writes beyond bitmap'); pixels[position++] = pixel; };
    while (r.remaining && position < count) {
        if (firstLine && position >= width) {
            firstLine = false;
            previousBackground = false;
        }
        const header = r.u8();
        let code, run;
        if (header < 0xc0) {
            code = header >>> 5;
            run = header & 31;
            run = code === 2 ? (run ? run * 8 : r.u8() + 1) : (run || r.u8() + 32);
        }
        else if (header < 0xf0) {
            code = header >>> 4;
            run = header & 15;
            run = code === 13 ? (run ? run * 8 : r.u8() + 1) : (run || r.u8() + 16);
        }
        else {
            code = header;
            if ([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf6, 0xf7, 0xf8].includes(code))
                run = r.u16le();
            else if (code === 0xf9 || code === 0xfa)
                run = 8;
            else if (code === 0xfd || code === 0xfe)
                run = 1;
            else
                throw new ProtocolError('RLE_OPCODE', `Unsupported RLE opcode 0x${code.toString(16)}`);
        }
        requireThat(run > 0, 'RLE_RUN', 'Zero-length RLE run');
        const isDither = code === 14 || code === 0xf8;
        requireThat(run * (isDither ? 2 : 1) <= count - position, 'RLE_OVERFLOW', 'RLE run exceeds bitmap');
        const isBackground = code === 0 || code === 0xf0;
        if (isBackground) {
            if (previousBackground) {
                write(background() ^ foreground);
                run--;
            }
            for (let i = 0; i < run; i++)
                write(background());
        }
        else if ([1, 12, 0xf1, 0xf6].includes(code)) {
            if (code === 12 || code === 0xf6)
                foreground = readPixel();
            for (let i = 0; i < run; i++)
                write(background() ^ foreground);
        }
        else if ([2, 13, 0xf2, 0xf7, 0xf9, 0xfa].includes(code)) {
            if (code === 13 || code === 0xf7)
                foreground = readPixel();
            let mask = 0;
            for (let i = 0; i < run; i++) {
                if ((i & 7) === 0)
                    mask = code === 0xf9 ? 3 : code === 0xfa ? 5 : r.u8();
                write(background() ^ ((mask >>> (i & 7)) & 1 ? foreground : 0));
            }
        }
        else if (code === 3 || code === 0xf3) {
            const color = readPixel();
            pixels.fill(color, position, position + run);
            position += run;
        }
        else if (code === 4 || code === 0xf4) {
            r.need(run * pixelBytes);
            for (let i = 0; i < run; i++)
                write(readPixel());
        }
        else if (isDither) {
            const a = readPixel(), b = readPixel();
            for (let i = 0; i < run; i++) {
                write(a);
                write(b);
            }
        }
        else if (code === 0xfd)
            write(white);
        else if (code === 0xfe)
            write(0);
        else
            throw new ProtocolError('RLE_OPCODE', 'Invalid RLE opcode');
        previousBackground = isBackground;
    }
    requireThat(position === count && r.remaining === 0, 'RLE_LENGTH', 'Compressed bitmap has incomplete or excess pixels');
    const result = new Uint8Array(count * pixelBytes);
    for (let i = 0, out = 0; i < count; i++)
        for (let n = 0; n < pixelBytes; n++)
            result[out++] = pixels[i] >>> (8 * n);
    return result;
}

import { Reader } from '../binary/Reader.js';
import { Writer, utf16 } from '../binary/Writer.js';
import { requireThat } from '../binary/ProtocolError.js';
export const clipboardPdu = (type, flags = 0, body = new Uint8Array()) => new Writer(body.length + 8).u16le(type).u16le(flags).u32le(body.length).put(body).finish();
/** Unicode text only. No file names, HTML, image payloads or implicit system clipboard writes. */
export class ClipboardChannel {
    constructor(send, emit, { limit = 4 * 1024 * 1024 } = {}) {
        this.send = send;
        this.emit = emit;
        this.limit = limit;
        this.ready = false;
        this.longNames = false;
        this.localText = null;
        this.generation = 0;
        this.pending = null;
        this.nextRequest = null;
    }
    receive(bytes) {
        const r = new Reader(bytes), type = r.u16le(), flags = r.u16le(), n = r.u32le();
        requireThat(n === r.remaining && n <= this.limit, 'CLIPBOARD_LENGTH', 'Invalid clipboard PDU length');
        const body = r.sub(n);
        switch (type) {
            case 7: {
                const count = body.u16le();
                body.u16le();
                requireThat(count <= 16, 'CLIPBOARD_CAPS', 'Too many clipboard capabilities');
                for (let i = 0; i < count; i++) {
                    const id = body.u16le(), size = body.u16le();
                    requireThat(size >= 4, 'CLIPBOARD_CAPS', 'Invalid clipboard capability');
                    const cap = body.sub(size - 4);
                    if (id === 1) {
                        const version = cap.u32le(), generalFlags = cap.u32le();
                        this.longNames = version >= 2 && !!(generalFlags & 2);
                    }
                }
                body.end();
                break;
            }
            case 1:
                body.end();
                this.ready = true;
                this.send(clipboardPdu(7, 0, new Writer().u16le(1).u16le(0).u16le(1).u16le(12).u32le(2).u32le(2).finish()));
                this.announce();
                this.emit('ready', { formats: ['Unicode text'], longNames: this.longNames });
                break;
            case 2: {
                const formats = [];
                while (body.remaining) {
                    requireThat(formats.length < 256, 'CLIPBOARD_FORMATS', 'Too many clipboard formats');
                    const id = body.u32le();
                    const name = this.longNames ? body.zUtf16() : (flags & 4 ? body.ascii(32).split('\0')[0] : body.utf16(32).split('\0')[0]);
                    formats.push({ id, name });
                }
                this.generation++;
                this.send(clipboardPdu(3, 1));
                const format = formats.find(f => f.id === 13)?.id;
                this.nextRequest = format ? { id: format, generation: this.generation } : null;
                if (!this.pending)
                    this.requestNext();
                break;
            }
            case 3:
                body.end();
                this.emit('acknowledged', { accepted: !!(flags & 1) });
                break;
            case 4: {
                const format = body.u32le();
                body.end();
                if (format !== 13 || this.localText === null)
                    this.send(clipboardPdu(5, 2));
                else
                    this.send(clipboardPdu(5, 1, utf16(this.localText.replace(/\r?\n/g, '\r\n'), true)));
                break;
            }
            case 5: {
                requireThat(this.pending !== null, 'CLIPBOARD_RESPONSE', 'Unsolicited clipboard data response');
                const request = this.pending;
                this.pending = null;
                clearTimeout(this.timer);
                if ((flags & 1) && request.generation === this.generation) {
                    requireThat(body.remaining >= 2 && body.remaining % 2 === 0, 'CLIPBOARD_UNICODE', 'Invalid Unicode clipboard payload');
                    const text = body.utf16(body.remaining);
                    requireThat(text.endsWith('\0'), 'CLIPBOARD_UNICODE', 'Clipboard text lacks a terminator');
                    this.emit('text', { text: text.split('\0')[0].replace(/\r\n/g, '\n') });
                }
                this.requestNext();
                break;
            }
            default:
                this.emit('unsupported', { type });
                break;
        }
    }
    requestNext() {
        if (!this.nextRequest)
            return;
        this.pending = this.nextRequest;
        this.nextRequest = null;
        this.send(clipboardPdu(4, 0, new Writer().u32le(this.pending.id).finish()));
        this.timer = setTimeout(() => {
            // Do not issue a second request after timeout: responses have no request ID.
            this.emit('timeout', { message: 'Remote clipboard request timed out; reconnect to resynchronize.' });
        }, 10000);
        this.timer.unref?.();
    }
    setText(text) {
        requireThat(typeof text === 'string' && (text.replace(/\r?\n/g, '\r\n').length + 1) * 2 <= this.limit && !text.includes('\0'), 'CLIPBOARD_LIMIT', 'Clipboard text is too large or contains NUL');
        this.localText = text;
        if (this.ready)
            this.announce();
    }
    announce() {
        const body = new Writer();
        if (this.localText !== null) {
            body.u32le(13);
            if (this.longNames)
                body.u16le(0);
            else
                body.zeros(32);
        }
        this.send(clipboardPdu(2, 0, body.finish()));
    }
    close() { clearTimeout(this.timer); this.localText = null; this.pending = null; this.nextRequest = null; }
}

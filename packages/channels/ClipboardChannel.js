import { Reader } from '../binary/Reader.js';
import { Writer, utf16 } from '../binary/Writer.js';
import { requireThat, ProtocolError } from '../binary/ProtocolError.js';
import { CLIPBOARD_LIMIT, encodeClipboardHtml, decodeClipboardHtml, inspectClipboardPng,
    encodeClipboardDib, decodeClipboardDib } from '../codecs/ClipboardFormats.js';
export const clipboardPdu = (type, flags = 0, body = new Uint8Array()) => new Writer(body.length + 8).u16le(type).u16le(flags).u32le(body.length).put(body).finish();
const HTML = 0xc001, PNG = 0xc002;
const names = new Map([[13, ''], [8, ''], [17, ''], [HTML, 'HTML Format'], [PNG, 'PNG']]);

/** Clipboard protocol only. No DOM, filesystem, or implicit OS clipboard writes.
 * Registered formats are mapped by NAME, never by a guessed remote ID.
 * Format-data responses have no request ID: precisely one request is in flight.
 */
export class ClipboardChannel {
    constructor(send, emit, { limit = CLIPBOARD_LIMIT, rich = false, timeoutMs = 10000 } = {}) {
        requireThat(Number.isSafeInteger(limit) && limit >= 1 && limit <= CLIPBOARD_LIMIT &&
            Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000,
            'CLIPBOARD_OPTIONS', 'Invalid clipboard limits');
        this.send = send;
        this.emit = emit;
        this.limit = limit;
        this.rich = rich === true;
        this.timeoutMs = timeoutMs;
        this.ready = this.longNames = this.closed = false;
        this.localText = null;
        this.local = new Map();
        this.advertised = new Map();
        this.remote = new Map();
        this.generation = 0;
        this.pending = null;
        this.requests = [];
        this.announcementPending = this.announceAgain = this.denied = false;
    }
    receive(bytes) {
        requireThat(!this.closed, 'CLIPBOARD_CLOSED', 'Clipboard channel is closed');
        const r = new Reader(bytes), type = r.u16le(), flags = r.u16le(), n = r.u32le();
        requireThat(n === r.remaining && n <= this.limit, 'CLIPBOARD_LENGTH', 'Invalid clipboard PDU length');
        if ([3, 5].includes(type)) requireThat(flags === 1 || flags === 2, 'CLIPBOARD_FLAGS', 'Invalid clipboard response flags');
        if ([1, 4, 7].includes(type)) requireThat(flags === 0, 'CLIPBOARD_FLAGS', 'Invalid clipboard request flags');
        if (type === 2) requireThat(flags === 0 || flags === 4, 'CLIPBOARD_FLAGS', 'Invalid clipboard format-list flags');
        const body = r.sub(n);
        switch (type) {
            case 7: {
                const count = body.u16le(); body.u16le();
                requireThat(count <= 16, 'CLIPBOARD_CAPS', 'Too many clipboard capabilities');
                let seen = false;
                this.longNames = false;
                for (let i = 0; i < count; i++) {
                    const id = body.u16le(), size = body.u16le();
                    requireThat(size >= 4, 'CLIPBOARD_CAPS', 'Invalid clipboard capability');
                    const cap = body.sub(size - 4);
                    if (id === 1) {
                        requireThat(!seen, 'CLIPBOARD_CAPS', 'Duplicate clipboard general capability');
                        seen = true;
                        cap.u32le(); // Version is informational; feature decisions use flags.
                        this.longNames = !!(cap.u32le() & 2);
                    }
                }
                body.end();
                break;
            }
            case 1:
                body.end();
                requireThat(!this.ready, 'CLIPBOARD_READY', 'Repeated clipboard initialization');
                this.ready = true;
                this.send(clipboardPdu(7, 0, new Writer().u16le(1).u16le(0).u16le(1).u16le(12).u32le(2).u32le(2).finish()));
                this.announce();
                this.emit('ready', { formats: this.rich ? ['Unicode text', 'HTML', 'PNG', 'DIB'] : ['Unicode text'], longNames: this.longNames });
                break;
            case 2: {
                const formats = new Map(), remote = new Map(), seenNames = new Set();
                while (body.remaining) {
                    requireThat(formats.size < 256, 'CLIPBOARD_FORMATS', 'Too many clipboard formats');
                    const id = body.u32le();
                    let name;
                    try { name = this.longNames ? body.zUtf16(Math.min(512, body.remaining)) : (flags & 4 ? body.ascii(32).split('\0')[0] : body.utf16(32).split('\0')[0]); }
                    catch { throw new ProtocolError('CLIPBOARD_FORMATS', 'Malformed or overlong clipboard format name'); }
                    requireThat(id !== 0 && !formats.has(id) && (!name || !seenNames.has(name)), 'CLIPBOARD_FORMATS', 'Duplicate or invalid clipboard format');
                    formats.set(id, name); if (name) seenNames.add(name);
                    if (id === 13) remote.set('text', { id, kind: 'text', encoding: 'unicode' });
                    if (this.rich) {
                        if (name === 'HTML Format' && id >= 0xc000) remote.set('html', { id, kind: 'html', encoding: 'html' });
                        if (name === 'PNG' && id >= 0xc000) remote.set('png', { id, kind: 'image', encoding: 'png' });
                        if (id === 17) remote.set('dibv5', { id, kind: 'image', encoding: 'dib' });
                        if (id === 8) remote.set('dib', { id, kind: 'image', encoding: 'dib' });
                    }
                }
                this.generation++;
                this.remote = remote;
                this.requests = [];
                this.send(clipboardPdu(3, 1));
                this.emit('formats', { generation: this.generation, formats: [...new Set([...remote.values()].map(f => f.kind))] });
                // Preserve text behavior; richer data is fetched only on explicit request.
                this.requestFormat('text');
                break;
            }
            case 3:
                body.end();
                this.denied = flags === 2;
                this.announcementPending = false;
                this.emit('acknowledged', { accepted: !this.denied });
                if (this.announceAgain) { this.announceAgain = false; this.announce(); }
                break;
            case 4: {
                const format = body.u32le(); body.end();
                const payload = !this.denied && this.advertised.get(format);
                this.send(payload ? clipboardPdu(5, 1, payload) : clipboardPdu(5, 2));
                break;
            }
            case 5: {
                requireThat(this.pending !== null, 'CLIPBOARD_RESPONSE', 'Unsolicited clipboard data response');
                const request = this.pending;
                this.pending = null;
                clearTimeout(this.timer);
                if (request.generation === this.generation) {
                    try {
                        if (flags === 2) this.emit('rejected', { format: request.kind, generation: request.generation, message: 'The remote clipboard refused this format.' });
                        else this.decodeResponse(request, body);
                    } catch (error) {
                        if (!(error instanceof ProtocolError)) throw error;
                        this.emit('rejected', { format: request.kind, generation: request.generation, message: String(error.message).slice(0, 256) });
                    }
                }
                this.requestNext();
                break;
            }
            default:
                this.emit('unsupported', { type });
                break;
        }
    }
    decodeResponse(request, body) {
        const generation = request.generation;
        if (request.encoding === 'unicode') {
            requireThat(body.remaining >= 2 && body.remaining % 2 === 0, 'CLIPBOARD_UNICODE', 'Invalid Unicode clipboard payload');
            let text;
            try { text = body.utf16(body.remaining); }
            catch { throw new ProtocolError('CLIPBOARD_UNICODE', 'Invalid UTF-16 clipboard text'); }
            requireThat(text.endsWith('\0'), 'CLIPBOARD_UNICODE', 'Clipboard text lacks a terminator');
            this.emit('text', { text: text.split('\0')[0].replace(/\r\n/g, '\n'), generation });
        } else {
            const bytes = body.take(body.remaining);
            if (request.encoding === 'html') this.emit('html', { html: decodeClipboardHtml(bytes), generation });
            if (request.encoding === 'png') {
                const size = inspectClipboardPng(bytes);
                this.emit('image', { encoding: 'png', ...size, bytes: bytes.slice(), generation });
            }
            if (request.encoding === 'dib') this.emit('image', { encoding: 'rgba', ...decodeClipboardDib(bytes), generation });
        }
    }
    requestFormat(kind) {
        requireThat(!this.closed && ['text', 'html', 'image'].includes(kind), 'CLIPBOARD_REQUEST', 'Invalid clipboard format request');
        const format = kind === 'image' ? this.remote.get('png') || this.remote.get('dibv5') || this.remote.get('dib') : this.remote.get(kind);
        if (!format) return false;
        if (this.pending?.id === format.id && this.pending.generation === this.generation ||
            this.requests.some(r => r.id === format.id && r.generation === this.generation)) return true;
        requireThat(this.requests.length < 3, 'CLIPBOARD_QUEUE', 'Clipboard request queue is full');
        this.requests.push({ ...format, generation: this.generation });
        this.requestNext();
        return true;
    }
    requestNext() {
        if (this.pending || this.closed || !this.requests.length) return;
        const request = this.pending = this.requests.shift();
        // Install timer first: a synchronous test peer can respond in send().
        this.timer = setTimeout(() => {
            if (this.pending === request) this.emit('timeout', { generation: request.generation,
                message: 'Remote clipboard request timed out; reconnect to resynchronize.' });
            // Keep pending. Sending another request would misidentify a late response.
        }, this.timeoutMs);
        this.timer.unref?.();
        this.send(clipboardPdu(4, 0, new Writer().u32le(request.id).finish()));
    }
    setText(text) { this.setContent({ text }); }
    setContent(content) {
        requireThat(!this.closed && content && typeof content === 'object', 'CLIPBOARD_CONTENT', 'Invalid clipboard snapshot');
        requireThat(this.rich || !['html', 'png', 'image'].some(k => content[k] != null), 'CLIPBOARD_DISABLED', 'Rich clipboard is disabled');
        const local = new Map();
        let total = 0;
        const add = (id, bytes) => {
            total += bytes.length;
            requireThat(bytes.length <= this.limit && total <= this.limit * 2, 'CLIPBOARD_LIMIT', 'Clipboard snapshot exceeds its memory budget');
            local.set(id, bytes);
        };
        if (content.text != null) {
            const text = content.text;
            requireThat(typeof text === 'string' && text.length <= this.limit && !text.includes('\0') &&
                (text.replace(/\r?\n/g, '\r\n').length + 1) * 2 <= this.limit, 'CLIPBOARD_LIMIT', 'Clipboard text is too large or contains NUL');
            add(13, utf16(text.replace(/\r?\n/g, '\r\n'), true));
        }
        if (content.html != null) add(HTML, encodeClipboardHtml(content.html));
        if (content.png != null) { inspectClipboardPng(content.png); add(PNG, content.png.slice()); }
        if (content.image != null) {
            add(17, encodeClipboardDib(content.image, true));
            add(8, encodeClipboardDib(content.image, false));
        }
        this.local = local;
        this.localText = content.text ?? null;
        // A local copy takes ownership; do not allow an old in-flight remote
        // response to replace it in the UI. Consume that response, then continue.
        this.generation++;
        this.requests = [];
        this.remote.clear();
        this.emit('formats', { generation: this.generation, formats: [] });
        if (this.ready) this.announce();
    }
    announce() {
        if (this.closed) return;
        if (this.announcementPending) { this.announceAgain = true; return; }
        this.advertised = this.local;
        this.denied = false;
        this.announcementPending = true;
        const body = new Writer();
        for (const id of this.advertised.keys()) {
            body.u32le(id);
            if (this.longNames) body.put(utf16(names.get(id), true));
            else body.fixedUtf16(names.get(id), 32);
        }
        this.send(clipboardPdu(2, 0, body.finish()));
    }
    close() {
        if (this.closed) return;
        this.closed = true; this.ready = false;
        clearTimeout(this.timer);
        for (const map of [this.local, this.advertised]) { for (const data of map.values()) data.fill(0); map.clear(); }
        this.localText = null; this.pending = null; this.requests = [];
        this.remote.clear();
    }
}

import assert from 'node:assert/strict';
import { Reader } from '../../packages/binary/Reader.js';
import { Writer, utf16 } from '../../packages/binary/Writer.js';
import { encodeClipboardHtml, decodeClipboardHtml, encodeClipboardDib, decodeClipboardDib, inspectClipboardPng } from '../../packages/codecs/ClipboardFormats.js';

/** Wire fixture only, intentionally not an independent interoperability oracle. */
export function configureRichClipboard(peer) {
    let formats = new Map([
        [13, { name: '', bytes: utf16('Remote rich clipboard fixture', true) }],
        [0xd321, { name: 'HTML Format', bytes: encodeClipboardHtml('<b>Remote Zażółć 🙂</b><script>globalThis.clipboardExecuted=true</script><img src="https://clipboard.invalid/x">') }],
        [17, { name: '', bytes: encodeClipboardDib({ width: 2, height: 1, rgba: Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255) }) }],
    ]);
    let queue = [], current = null, incoming = new Map();
    peer.advertiseClipboard = () => {
        const body = new Writer();
        for (const [id, value] of formats) body.u32le(id).put(utf16(value.name, true));
        peer.clip(2, 0, body.finish());
    };
    const next = () => {
        current = queue.shift() || null;
        if (current) peer.clip(4, 0, new Writer().u32le(current.id).finish());
        else if (incoming.size) { formats = incoming; incoming = new Map(); peer.advertiseClipboard(); }
    };
    peer.clipboardReceive = bytes => {
        const r = new Reader(bytes), type = r.u16le(), flags = r.u16le(), size = r.u32le();
        assert.equal(size, r.remaining);
        if (type === 2) {
            assert.equal(current, null);
            queue = []; incoming = new Map();
            while (r.remaining) queue.push({ id: r.u32le(), name: r.zUtf16() });
            peer.clip(3, 1); next();
        } else if (type === 4) {
            const id = r.u32le(); r.end();
            const value = formats.get(id); peer.clip(5, value ? 1 : 2, value?.bytes);
        } else if (type === 5) {
            assert.ok(current); assert.equal(flags, 1);
            const bytes = r.take(r.remaining).slice();
            if (current.name === 'HTML Format') decodeClipboardHtml(bytes);
            if (current.name === 'PNG') inspectClipboardPng(bytes);
            if ([8, 17].includes(current.id)) decodeClipboardDib(bytes);
            incoming.set(current.id, { name: current.name, bytes });
            current = null; next();
        }
    };
}

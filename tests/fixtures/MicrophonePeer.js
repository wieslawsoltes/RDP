import assert from 'node:assert/strict';
import { Reader } from '../../packages/binary/Reader.js';
import { Writer, concat } from '../../packages/binary/Writer.js';
const format = (rate, channels, tag = 1) => new Writer().u16le(tag).u16le(channels).u32le(rate).u32le(rate * channels * 2).u16le(channels * 2).u16le(16).u16le(0).finish();
const formats = [format(48000, 2), format(16000, 1)];
const number = (type, value) => new Writer().u8(type).u32le(value).finish();
const readInt = (r, size) => { assert.ok(size < 3); return size === 0 ? r.u8() : size === 1 ? r.u16le() : r.u32le(); };

/** Test-only server side, with independent AUDIN and DVC field parsing.
 * Synthetic samples/peers are not Windows interoperability evidence. */
export function configureMicrophonePeer(peer, { onOpen = () => {}, onPacket = () => {}, onClosed = () => {}, frames = 480 } = {}) {
    const input = peer.onInput;
    const state = { id: 7, requested: false, rejected: false, openResult: null, packets: [], index: 0, closed: false, fragments: 0 };
    let incoming = false, expected = null, chunks = [], size = 0;
    function send(data) {
        for (let at = 0; at < data.length; at += 193) {
            const first = at === 0 && data.length > 193;
            const w = new Writer().u8(first ? 0x28 : 0x30).u8(state.id);
            if (first) w.u32le(data.length);
            peer.static.transmit(peer.dynamicId, w.put(data.subarray(at, at + 193)).finish());
        }
    }
    function openChannel() {
        state.closed = false; state.requested = false; state.openResult = null;
        peer.static.transmit(peer.dynamicId, new Writer().u8(0x10).u8(state.id).ascii('AUDIO_INPUT').u8(0).finish());
    }
    function audio(bytes) {
        const r = new Reader(bytes), type = r.u8();
        if (type === 1) {
            assert.ok([1, 2].includes(r.u32le())); r.end();
            // Server's size field is arbitrary, and trailing ExtraData is legal.
            send(concat(new Writer().u8(2).u32le(3).u32le(0x80000000).finish(), format(8000, 1, 6), ...formats, new Uint8Array(2000))); return;
        }
        if (type === 5) { r.end(); assert.equal(incoming, false); incoming = true; return; }
        if (type === 2) {
            assert.equal(incoming, true); incoming = false; assert.equal(r.u32le(), 2); assert.equal(r.u32le(), bytes.length);
            for (const f of formats) assert.deepEqual(r.take(f.length), f); r.end();
            state.requested = true;
            send(concat(new Writer().u8(3).u32le(frames).u32le(0).finish(), format(44100, 1))); return;
        }
        if (type === 7) {
            const index = r.u32le(); r.end(); assert.ok(index < 2); state.index = index;
            peer.advertiseClipboard(); return;
        }
        if (type === 4) {
            state.openResult = r.u32le(); r.end(); onOpen(state.openResult); peer.advertiseClipboard(); return;
        }
        if (type === 6) {
            assert.equal(state.openResult, 0); assert.equal(incoming, true); incoming = false;
            const data = r.take(r.remaining).slice();
            assert.equal(data.length, frames * (state.index === 0 ? 4 : 2));
            state.packets.push({ index: state.index, data });
            if (state.packets.length > 256) state.packets.shift();
            onPacket(state.packets.at(-1)); peer.advertiseClipboard(); return;
        }
        assert.fail(`Unexpected AUDIN client PDU ${type}`);
    }
    peer.dynamicReceive = bytes => {
        const r = new Reader(bytes), h = r.u8(), cmd = h >>> 4;
        if (cmd === 5) { r.u8(); assert.equal(r.u16le(), 2); r.end(); openChannel(); return; }
        assert.equal(readInt(r, h & 3), state.id);
        if (cmd === 1) {
            const result = r.u32le(); r.end(); state.rejected = result !== 0;
            if (!result) send(number(1, 2)); return;
        }
        if (cmd === 4) { r.end(); state.closed = true; onClosed(); peer.advertiseClipboard(); return; }
        assert.ok(cmd === 2 || cmd === 3);
        if (cmd === 2) { assert.equal(expected, null); expected = readInt(r, (h >>> 2) & 3); assert.ok(expected <= 65536); }
        const fragment = r.take(r.remaining);
        if (expected === null) { audio(fragment); return; }
        state.fragments++; chunks.push(fragment.slice()); size += fragment.length; assert.ok(size <= expected);
        if (size === expected) { const all = concat(...chunks); chunks = []; size = 0; expected = null; audio(all); }
    };
    peer.changeMicrophoneFormat = index => send(number(7, index));
    peer.closeMicrophone = () => peer.static.transmit(peer.dynamicId, Uint8Array.of(0x40, state.id));
    peer.reopenMicrophone = () => { assert.equal(state.closed, true); state.id++; openChannel(); };
    peer.onInput = events => {
        input(events);
        for (const e of events) if (e.type === 4 && !(e.flags & 0x8000)) {
            if (e.a === 0x21) peer.changeMicrophoneFormat(1); // f
            if (e.a === 0x2d) peer.closeMicrophone(); // x
            if (e.a === 0x31) peer.reopenMicrophone(); // n
        }
    };
    return state;
}

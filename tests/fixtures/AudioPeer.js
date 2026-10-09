import assert from 'node:assert/strict';
import { Reader } from '../../packages/binary/Reader.js';
import { Writer, concat } from '../../packages/binary/Writer.js';

const packet = (type, body = new Uint8Array()) => new Writer().u8(type).u8(0).u16le(body.length).put(body).finish();
/** Test-only peer. Public message layouts, not a Windows interoperability oracle. */
export function configureAudioPeer(peer, { onReady = () => {}, onConfirm = () => {} } = {}) {
    const register = peer.registerChannels.bind(peer), start = peer.startChannels.bind(peer), input = peer.onInput;
    const state = peer.audioFixture = { ready: false, stage: 'formats', confirmations: [], sequence: 0 };
    const send = bytes => peer.static.transmit(state.id, bytes);
    peer.registerChannels = () => {
        register(); const index = peer.channels.indexOf('rdpsnd');
        if (index < 0) return;
        state.id = 1004 + index;
        peer.static.register(state.id, { receive(bytes) {
            const r = new Reader(bytes), type = r.u8(); r.u8(); assert.equal(r.u16le(), r.remaining);
            if (type === 7) {
                assert.equal(state.stage, 'formats'); assert.equal(r.u32le(), 1); r.skip(8);
                assert.equal(r.u16be(), 0); assert.equal(r.u16le(), 1); r.u8(); assert.equal(r.u16le(), 8); r.u8();
                assert.equal(r.u16le(), 1); assert.equal(r.u16le(), 2); assert.equal(r.u32le(), 48000);
                assert.equal(r.u32le(), 192000); assert.equal(r.u16le(), 4); assert.equal(r.u16le(), 16); assert.equal(r.u16le(), 0); r.end();
                state.stage = 'quality';
            } else if (type === 12) {
                assert.equal(state.stage, 'quality'); assert.equal(r.u16le(), 2); assert.equal(r.u16le(), 0); r.end();
                state.stage = 'training'; send(packet(6, new Writer().u16le(0x3456).u16le(0).finish()));
            } else if (type === 6) {
                assert.equal(state.stage, 'training'); assert.equal(r.u16le(), 0x3456); assert.equal(r.u16le(), 0); r.end();
                state.stage = 'stream'; state.ready = true; onReady(state);
                // Produce a harmless clipboard message as a wire-visible completion marker.
                peer.advertiseClipboard();
            } else if (type === 5) {
                assert.equal(state.ready, true);
                const confirmation = { timestamp: r.u16le(), block: r.u8() }; r.u8(); r.end();
                state.confirmations.push(confirmation); onConfirm(confirmation);
                // Allows socket tests to observe completion without racing a hung read.
                peer.advertiseClipboard();
            } else assert.fail(`Unexpected client sound PDU ${type}`);
        } });
    };
    peer.startChannels = () => {
        start(); if (state.id == null) return;
        const format = (tag, rate, align, bits, channels) => new Writer().u16le(tag).u16le(channels)
            .u32le(rate).u32le(rate * align).u16le(align).u16le(bits).u16le(0).finish();
        const body = new Writer().u32le(1).u32le(0xffffffff).u32le(0x10000).u16be(0)
            .u16le(2).u8(0).u16le(8).u8(0)
            .put(format(6, 8000, 1, 8, 1)) // A-law must not be selected.
            .put(format(1, 48000, 4, 16, 2)).finish();
        send(packet(7, body));
    };
    peer.sendAudio = () => {
        assert.equal(state.ready, true);
        const samples = new Uint8Array(4800 * 4), view = new DataView(samples.buffer);
        for (let i = 0; i < 4800; i++) { view.setInt16(i * 4, 16384, true); view.setInt16(i * 4 + 2, -16384, true); }
        const base = state.sequence++ * 2;
        // First sample: legacy split WaveInfo/Wave; second: Wave2. Both fragment on the static channel.
        const header = (block, timestamp) => new Writer().u16le(timestamp).u16le(0).u8(block).zeros(3);
        send(new Writer().u8(2).u8(0).u16le(samples.length + 8)
            .put(header((base + 255) & 255, 0xfff0).finish()).put(samples.subarray(0, 4)).finish());
        send(concat(new Uint8Array(4), samples.subarray(4)));
        send(packet(13, header(base & 255, 0x0100).u32le(100).put(samples).finish()));
    };
    peer.onInput = events => {
        input(events);
        if (state.ready && events.some(e => e.type === 4 && !(e.flags & 0x8000) && e.a === 0x1e)) peer.sendAudio();
    };
    return state;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { Writer } from '../packages/binary/Writer.js';
import { shareControl } from '../packages/protocol/Share.js';
import { mppcFixture } from './helpers/MppcFixture.js';
import { Session } from '../packages/protocol/Session.js';
import { LoopbackServer } from '../packages/lab/LoopbackServer.js';
import { clientCapabilities } from '../packages/protocol/Capabilities.js';
import { sanitizeProfile } from '../packages/profiles/Profiles.js';
import { configureGdiPeer, expectedScene, fastPacket } from './fixtures/GdiPeer.js';
import * as W from './fixtures/GdiWire.js';
const turns = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
function fixture(options = {}, server = {}) {
    const events = []; let session;
    const peer = new LoopbackServer({ send: b => queueMicrotask(() => session.receive(b)) });
    const state = configureGdiPeer(peer, server);
    session = new Session({ options: { width: 200, height: 200, selectedProtocol: 1, requestedProtocols: 1, clipboard: false, resize: false, ...options },
        send: b => queueMicrotask(() => peer.receive(b)), emit: e => events.push(e) });
    return { session, peer, state, events };
}
const capMap = options => new Map(clientCapabilities({ width: 200, height: 200, ...options }).map(c =>
    [new DataView(c.buffer).getUint16(0, true), c.subarray(4)]));
test('GDI profile is opt-in and only advertised at matching 24/32-bit depth', async () => {
    for (const bpp of [8, 15, 16, 24, 32]) for (const orders of [false, true]) {
        const caps = capMap({ bpp, orders }), active = orders && bpp >= 24;
        assert.deepEqual([...caps.get(3).subarray(32, 64)], [...new Uint8Array(32).fill(1, 0, active ? 5 : 0)]);
        assert.equal(caps.has(4), active); assert.equal(caps.has(17), active); assert.equal(caps.has(16), active);
        if (active) { assert.equal(new DataView(caps.get(17).buffer, caps.get(17).byteOffset).getUint16(4, true), 16384 * bpp / 32); assert.ok(caps.get(16).every(v => v === 0)); }
    }
    for (const [client, offered, enabled] of [[24,24,true],[32,32,true],[32,24,true],[16,24,false]]) {
        const h = fixture({ bpp: client, orders: true }, { bpp: offered }); h.session.start(); await turns();
        assert.equal(h.session.state, 'active'); assert.equal(!!h.session.gdi, enabled);
        h.session.close(); h.peer.close();
    }
    assert.equal(sanitizeProfile({}).orders, false); assert.equal(sanitizeProfile({orders: 'true'}).orders, false);
    assert.equal(sanitizeProfile({ orders: true }).orders, true);
});
test('GDI cache revision follows Server Bitmap Cache Host Support, without persistent keys or glyphs', async () => {
    for (const revision of [1, 2]) {
        const h = fixture({ orders: true }, { revision }); h.session.start(); await turns();
        assert.equal(h.session.gdi.revision, revision); assert.equal(h.state.caps.has(revision === 1 ? 4 : 19), true);
        assert.equal(h.state.caps.has(revision === 1 ? 19 : 4), false);
        if (revision === 2) { const cap = h.state.caps.get(19); assert.equal(cap[0], 2); assert.equal(cap[3], 3); for (let i = 7; i < 24; i += 4) assert.equal(cap[i] & 128, 0); }
        h.session.close(); h.peer.close();
    }
});
test('GDI slow path, fragmented fast path, bitmap interleave, offscreen and caches produce exact pixels', async () => {
    for (const revision of [1, 2]) for (const bpp of [24, 32]) {
        const h = fixture({ orders: true, bpp }, { revision, bpp }); h.session.start(); await turns();
        h.peer.drawGdiScene(); await turns(); assert.equal(h.session.state, 'active', JSON.stringify(h.events.filter(e => e.type === 'error')));
        const expected = expectedScene(), screen = h.session.gdi.screen;
        for (let y = 0; y < 20; y++) assert.deepEqual(screen.pixels.slice(y * screen.width, y * screen.width + 32), expected.subarray(y * 32, y * 32 + 32));
        assert.equal(h.session.stats().gdi.orders, 12); assert.ok(h.session.stats().gdi.cacheBytes > 0);
        const engine = h.session.gdi, pixels = engine.screen.pixels;
        h.session.close(); h.peer.close(); assert.ok(pixels.every(v => v === 0)); assert.equal(engine.closed, true);
    }
});
test('GDI renderer-bound packets are owned and cannot corrupt future screen copies', async () => {
    const h = fixture({ orders: true }); h.session.start(); await turns(); h.peer.drawGdiScene(); await turns();
    const frames = h.events.filter(e => e.type === 'bitmaps');
    for (const event of frames) for (const rect of event.rectangles) structuredClone(rect, { transfer: [rect.data.buffer] });
    h.peer.data(2, W.slowOrders(W.scr(40, 20, 1, 1, 0xcc, 31, 19))); await turns();
    assert.equal(h.session.state, 'active'); assert.equal(h.session.gdi.screen.pixels[20 * 200 + 40], 0xf012ab);
    h.session.close(); h.peer.close();
});
test('Unnegotiated or malformed order traffic fails the session and clears cached pixels', async () => {
    for (const enabled of [false, true]) {
        const h = fixture({ orders: enabled }); h.session.start(); await turns(); const engine = h.session.gdi;
        h.peer.send(fastPacket(W.fastOrders(enabled ? Uint8Array.of(9, 27) : W.opaque(0, 0, 1, 1, 0xff00ff)))); await turns();
        assert.equal(h.session.state, 'failed'); assert.equal(h.session.gdi, null);
        if (engine) assert.equal(engine.closed, true); h.session.close(); h.peer.close();
    }
});


test('Compressed drawing orders use the same MPPC history across slow and fast output paths', async () => {
    const h=fixture({orders:true});h.session.start();await turns();
    const first=W.slowOrders(W.opaque(1,1,1,1,0x123456)), second=W.fastOrders(W.scr(2,1,1,1,0xcc,1,1));
    const packed=mppcFixture([...first],1);
    h.peer.indication(h.peer.ioChannel,shareControl(7,h.peer.serverId,new Writer().u32le(h.peer.shareId).u8(0).u8(1).u16le(first.length+18)
        .u8(2).u8(0xa1).u16le(packed.length+18).put(packed).finish()));
    await turns();
    assert.equal(h.session.gdi.screen.pixels[201],0x123456);
    const before=h.session.bulk.offset;
    h.peer.send(fastPacket(mppcFixture([...second],1),0,0x21));await turns();
    assert.equal(h.session.state,'active');assert.equal(h.session.gdi.screen.pixels[202],0x123456);
    assert.equal(h.session.bulk.offset,before+second.length);h.session.close();h.peer.close();
});

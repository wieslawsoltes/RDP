import assert from 'node:assert/strict';
import { Reader } from '../../packages/binary/Reader.js';
import { Writer, concat } from '../../packages/binary/Writer.js';
import { clientCapabilities, capability } from '../../packages/protocol/Capabilities.js';
import { parseSendData } from '../../packages/protocol/Mcs.js';
import { parseShare, shareControl } from '../../packages/protocol/Share.js';
import * as W from './GdiWire.js';
import { multi } from './MultiGdiWire.js';
const rect = (x,y,width,height) => ({x,y,width,height});

export function readConfirmation(body) {
    const r = new Reader(body); r.u32le(); r.u16le();
    const sourceSize = r.u16le(), capsSize = r.u16le(); r.skip(sourceSize);
    const caps = r.sub(capsSize), count = caps.u16le(), result = new Map(); caps.u16le();
    for (let i = 0; i < count; i++) { const id = caps.u16le(), length = caps.u16le(); result.set(id, caps.take(length - 4).slice()); }
    caps.end(); r.end(); return result;
}
export function fastPacket(body, fragment = 0, compressed = null) {
    const w = new Writer().u8(fragment * 16 | (compressed === null ? 0 : 0x80));
    if (compressed !== null) w.u8(compressed);
    w.u16le(body.length).put(body); const update = w.finish(), n = update.length + 2;
    return n < 128 ? concat(Uint8Array.of(0, n), update) : concat(Uint8Array.of(0, 0x80 | (n + 1) >>> 8, (n + 1) & 255), update);
}
export const SCENE_WIDTH = 32, SCENE_HEIGHT = 20;
/** Expected pixels are built without production rasterizer/ROP/codec helpers. */
export function expectedScene() {
    const pixels = new Uint32Array(SCENE_WIDTH * SCENE_HEIGHT).fill(0x112233);
    const set = (x, y, c) => pixels[y * SCENE_WIDTH + x] = c;
    const tile = (x, y) => (x * 50 + 5) << 16 | (y * 50 + 10) << 8 | (x + y + 30);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) set(x + 2, y + 2, tile(x, y));
    const old = pixels.slice();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) set(x + 3, y + 3, old[(y + 2) * SCENE_WIDTH + x + 2] ^ old[(y + 3) * SCENE_WIDTH + x + 3]);
    const rows = [0xaa, 0x55, 0x81, 0x42, 0x24, 0x18, 0xff, 0x00];
    for (let y = 2; y < 10; y++) for (let x = 10; x < 18; x++) set(x, y, rows[y % 8] & (128 >>> (x % 8)) ? 0x123456 : 0xfedcba);
    for (let y = 2; y < 6; y++) for (let x = 22; x < 26; x++) set(x, y, 0xfedcba);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) {
        const c = (220 - x * 10) << 16 | (80 + y * 20) << 8 | 90;
        set(x + 1, y + 12, c); set(x + 8, y + 12, c);
    }
    // A separate per-pixel region oracle, independent of production clipping.
    const apply = (base, rectangles, transform) => {
        const before = pixels.slice();
        for (let y=0;y<20;y++) for(let x=0;x<32;x++) {
            const inside = r => x>=r.x && y>=r.y && x<r.x+r.width && y<r.y+r.height;
            if (inside(base) && rectangles.some(inside)) set(x,y,transform(x,y,before));
        }
    };
    apply(rect(0,14,14,6), [rect(1,15,5,3),rect(5,16,4,2)], () => 0x224466);
    apply(rect(10,10,12,8), [rect(12,11,5,4),rect(16,13,5,3)], (x,y,b) =>
        b[y*32+x] ^ (((x+2)&7)===((y-1)&7) ? 0x010203 : 0xa0b0c0));
    apply(rect(20,10,12,10), [rect(22,12,4,3),rect(25,14,4,3)], (x,y,b) => b[y*32+x]^0xffffff);
    apply(rect(3,2,20,9), [rect(9,4,8,3),rect(4,3,6,4)], (x,y,b) => b[y*32+x-1]);
    set(31, 19, 0xf012ab); return pixels;
}
/** Co-developed server fixture, not independent Windows interoperability. */
export function configureGdiPeer(peer, { revision = 1, bpp = 24, paintOnActive = false } = {}) {
    const state = { caps: null, scenes: 0 };
    const packet = peer.packet.bind(peer), active = peer.onActive;
    peer.packet = bytes => {
        if (bytes[0] === 0x64) {
            const { channelId, data } = parseSendData(bytes, false);
            if (channelId === peer.ioChannel && data.length >= 6 && (data[2] & 15) === 3) {
                parseShare(data, (type, _source, body) => { if (type === 3) state.caps = readConfirmation(body); });
            }
        }
        return packet(bytes);
    };
    peer.demandActive = () => {
        const caps = clientCapabilities({ width: peer.width, height: peer.height, bpp });
        if (revision === 2) caps.push(capability(18, Uint8Array.of(1, 0, 0, 0)));
        const all = concat(...caps), source = new TextEncoder().encode('GDIFIXTURE\0');
        const body = new Writer().u32le(peer.shareId).u16le(source.length).u16le(all.length + 4).put(source)
            .u16le(caps.length).u16le(0).put(all).u32le(0).finish();
        peer.indication(peer.ioChannel, shareControl(1, peer.serverId, body));
    };
    peer.drawGdiScene = () => {
        assert.ok(state.caps?.get(3)?.subarray(32, 37).every(v => v === 1), 'Client did not negotiate blit profile');
        assert.ok(state.caps?.get(3)?.subarray(47, 51).every(v => v === 1), 'Client did not negotiate multi orders');
        assert.ok(state.caps.has(revision === 1 ? 4 : 19), 'Wrong cache revision');
        const tile = [];
        for (let y = 3; y >= 0; y--) for (let x = 0; x < 4; x++) tile.push(x + y + 30, y * 50 + 10, x * 50 + 5);
        const cached = revision === 1 ? W.cache1(0, 0, 4, 4, 24, Uint8Array.from(tile)) : W.cache2(0, 0, 4, 4, 24, Uint8Array.from(tile));
        peer.data(2, W.slowOrders(W.opaque(0, 0, 32, 20, 0x112233), cached, W.mem(2, 2, 4, 4)));
        const next = W.fastOrders(W.scr(3, 3, 4, 4, 0x66, 2, 2), W.pattern(10, 2, 8, 8,
            { style: 3, back: 0x123456, fore: 0xfedcba, hatch: 0, extra: Uint8Array.of(0xff, 0x18, 0x24, 0x42, 0x81, 0x55, 0xaa) }));
        peer.send(fastPacket(next.subarray(0, 7), 2)); peer.send(fastPacket(next.subarray(7, 21), 3)); peer.send(fastPacket(next.subarray(21), 1));
        peer.data(2, W.slowOrders(W.createOffscreen(1, 4, 4), W.switchSurface(1), W.opaque(0, 0, 4, 4, 0xfedcba), W.switchSurface(65535), W.mem(22, 2, 4, 4, { cacheId: 255, index: 1 })));
        const bitmap = [];
        for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) bitmap.push(220 - x * 10, 80 + y * 20, 90, 255);
        peer.bitmap(1, 12, 3, 2, Uint8Array.from(bitmap));
        peer.data(2, W.slowOrders(W.scr(8, 12, 3, 2, 0xcc, 1, 12),
            multi(18,rect(0,14,14,6),[rect(1,15,5,3),rect(5,16,4,2)],{color:0x224466}),
            multi(16,rect(10,10,12,8),[rect(12,11,5,4),rect(16,13,5,3)],
                {code:0x5a,style:3,orgX:-2,orgY:1,back:0x010203,fore:0xa0b0c0,hatch:1,extra:Uint8Array.of(2,4,8,16,32,64,128)})));
        const regions = W.fastOrders(
            multi(15,rect(20,10,12,10),[rect(22,12,4,3),rect(25,14,4,3)],{code:0x55}),
            multi(17,rect(3,2,20,9),[rect(9,4,8,3),rect(4,3,6,4)],{sx:2,sy:2}));
        peer.send(fastPacket(regions.subarray(0,13),2)); peer.send(fastPacket(regions.subarray(13),1));
        peer.data(2,W.slowOrders(W.opaque(31,19,1,1,0xf012ab)));
        state.scenes++;
    };
    peer.onActive = (...args) => { active(...args); if (paintOnActive) peer.drawGdiScene(); };
    return state;
}

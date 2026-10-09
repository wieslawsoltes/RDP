import test from 'node:test';
import assert from 'node:assert/strict';
import { GdiOrders } from '../packages/render/gdi/Orders.js';
import { Reader } from '../packages/binary/Reader.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
import { Writer, concat } from '../packages/binary/Writer.js';
import { opaque, dst, scr, pattern, mem, cache1, cache2, palette, createOffscreen, switchSurface, coord, u15, u30 } from './fixtures/GdiWire.js';
import { compact15, compact30 } from '../packages/render/gdi/BitmapCache.js';
const engine = options => new GdiOrders({ width: 16, height: 16, ...options });
const run = (g, ...records) => g.receive(new Reader(concat(...records)), records.length);
const pixel = (g, x, y) => g.screen.pixels[y * g.screen.width + x];
const oracle = (code, d, s, p) => { let out = 0; for (let b = 0; b < 24; b++) out |= ((code >>> (((p >>> b & 1) * 4) + ((s >>> b & 1) * 2) + (d >>> b & 1))) & 1) << b; return out; };

test('GDI published OpaqueRect wire color components and retained fields', () => {
    const g = engine();
    // type change, field flags, x/y/w/h, RedOrPaletteIndex, Green, Blue.
    run(g, Uint8Array.of(9,10,127,1,0,2,0,2,0,1,0,0x12,0x34,0x56));
    assert.equal(pixel(g,1,2), 0x123456); assert.equal(pixel(g,2,2), 0x123456);
    // Next order changes only x and red. Green/blue/rectangle are retained.
    run(g, Uint8Array.of(1,17,4,0,0x78)); assert.equal(pixel(g,4,2), 0x783456); g.close();
});
test('GDI initial type is PatBlt and omitted flag bytes are trailing bytes', () => {
    const g = engine();
    run(g, Uint8Array.of(0x41,0x5f,0,0,0,0,2,0,2,0,0xf0,0x12,0x34,0x56));
    assert.equal(pixel(g,0,0),0x123456);
    run(g, Uint8Array.of(0x81)); assert.equal(pixel(g,1,1),0x123456); g.close();
});
test('GDI shared inclusive bounds, zero-bounds reuse and delta precedence', () => {
    const g = engine();
    const bounded = coord(new Writer().u8(0x0d).u8(10).u8(127).u8(15), 2,3,4,5);
    coord(bounded, 0,0,10,10).put(Uint8Array.of(255,0,0)); run(g,bounded.finish());
    assert.equal(pixel(g,2,3),0xff0000); assert.equal(pixel(g,4,5),0xff0000); assert.equal(pixel(g,5,5),0);
    // Delta bounds override their corresponding absolute bits; consume 4 signed bytes, not 8.
    run(g, Uint8Array.of(5,0x20,255,1,1,1,1,255)); // change green and move bounds +1
    assert.equal(pixel(g,5,6),0xffff00); assert.equal(pixel(g,2,3),0xff0000);
    run(g, Uint8Array.of(0x25,0x40,255)); assert.equal(pixel(g,5,6),0xffffff); g.close();
});
test('GDI signed deltas and primary type histories are independent', () => {
    const g = engine(); run(g,opaque(3,3,2,2,0x112233),dst(9,9,1,1,255));
    run(g,Uint8Array.of(0x19,10,3,255,254));
    assert.equal(pixel(g,2,1),0x112233); assert.equal(pixel(g,9,9),0xffffff); g.close();
});
test('GDI inline monochrome brush follows bottom-row hatch and reverse extra rows', () => {
    const g = engine();
    run(g,pattern(0,0,8,8,{ fore:0xff0000,back:0x0000ff,style:3,hatch:1,extra:Uint8Array.of(2,4,8,16,32,64,128) }));
    for (let y=0;y<8;y++) for(let x=0;x<8;x++) assert.equal(pixel(g,x,y),x===y?0x0000ff:0xff0000);
    run(g,pattern(0,0,8,8,{ style:1 })); assert.equal(pixel(g,0,0),0x0000ff); g.close();
});
test('GDI bitmap updates become sources for overlap-safe ScrBlt orders', () => {
    const g = engine(); const data = Uint8Array.of(3,2,1,0,6,5,4,0,9,8,7,0);
    g.bitmap([{x:0,y:0,width:3,height:1,drawWidth:3,drawHeight:1,bpp:32,stride:12,bottomUp:false,data}]);
    data.fill(0); assert.equal(g.stats().damageBytes,0);
    run(g,scr(1,0,3,1,0xcc,0,0)); assert.deepEqual([...g.screen.pixels.slice(0,4)],[0x010203,0x010203,0x040506,0x070809]); g.close();
});
test('GDI Revision 1 padded raw cache and inverted MemBlt Y source', () => {
    const g=engine(); const data=Uint8Array.of(255,0,0,0,0,0,255,0); // bottom blue, top red
    run(g,cache1(0,0,1,2,24,data),mem(2,3,1,1,{sy:0}));
    assert.equal(pixel(g,2,3),0x0000ff);
    run(g,mem(3,3,1,1,{sy:1})); assert.equal(pixel(g,3,3),0xff0000); g.close();
});
test('GDI Mem3Blt supports all 256 ROP3 truth tables against per-bit oracle', () => {
    const g=engine(); const s=0x9abced,d=0x156789,p=0x654321;
    run(g,cache1(0,0,1,1,24,Uint8Array.of(s&255,s>>>8&255,s>>>16,0)));
    for(let code=0;code<256;code++) {
        run(g,opaque(0,0,1,1,d),mem(0,0,1,1,{code,brush:{fore:p}}));
        assert.equal(pixel(g,0,0),oracle(code,d,s,p),String(code));
    } g.close();
});
test('GDI cache replacement releases previous storage without aliasing incoming or outgoing buffers', () => {
    const g=engine(); const input=cache1(0,0,1,1,24,Uint8Array.of(3,2,1,0)); run(g,input);
    const old=g.cache.cells[0][0].pixels; input.fill(0);
    const rectangles=run(g,mem(0,0,1,1)); rectangles[0].data.fill(0); assert.equal(pixel(g,0,0),0x010203);
    run(g,cache1(0,0,1,1,24,Uint8Array.of(0,0,0,0))); assert.ok(old.every(v=>v===0)); g.close();
});
test('GDI Revision 1 interleaved RLE and planar compressed cache entries', () => {
    for(const header of [false,true]) {
        const g=engine({bpp:32});
        run(g,cache1(0,0,1,1,24,Uint8Array.of(0x81,3,2,1),true,header),mem(0,0,1,1));
        assert.equal(pixel(g,0,0),0x010203);
        run(g,cache1(0,0,1,1,32,Uint8Array.of(0x20,4,5,6),true,header),mem(1,0,1,1));
        assert.equal(pixel(g,1,0),0x040506); g.close();
    }
});
test('GDI Revision 2 compact fields, equal height and waiting-list index', () => {
    const g=engine({revision:2});
    run(g,cache2(2,0,1,1,24,Uint8Array.of(1,2,3,0),17),mem(0,0,1,1,{cacheId:2,index:32767}));
    assert.equal(pixel(g,0,0),0x030201);
    run(g,cache2(2,130,1,1,32,Uint8Array.of(0x20,0x11,0x22,0x33),9,true),mem(1,0,1,1,{cacheId:2,index:130}));
    assert.equal(pixel(g,1,0),0x112233); g.close();
});
test('GDI compact integer boundaries use big-endian continuation bytes', () => {
    for(const n of [0,1,127,128,255,256,32767]) assert.equal(compact15(new Reader(u15(n))),n);
    for(const n of [0,1,63,64,255,16383,16384,4194303,4194304,1073741823]) assert.equal(compact30(new Reader(u30(n))),n);
});
test('GDI cached palettes apply at MemBlt time and remain independent of the desktop palette', () => {
    const g=engine(); run(g,palette(2,{7:0x123456}),cache1(0,0,1,1,8,Uint8Array.of(7,0,0,0)),mem(0,0,1,1,{cacheId:512}));
    assert.equal(pixel(g,0,0),0x123456);
    g.setPalette(new Uint8Array(1024));
    run(g,palette(2,{7:0x654321}),mem(1,0,1,1,{cacheId:512}));
    assert.equal(pixel(g,1,0),0x654321); assert.equal(pixel(g,0,0),0x123456); g.close();
});
test('GDI offscreen drawing does not publish until copied to primary, and ScrBlt always reads primary', () => {
    const g=engine(); run(g,opaque(0,0,2,2,0x123456));
    assert.equal(run(g,createOffscreen(3,2,2),switchSurface(3),scr(0,0,2,2,0xcc,0,0)).length,0);
    run(g,switchSurface(65535),mem(4,4,2,2,{cacheId:255,index:3})); assert.equal(pixel(g,4,4),0x123456);
    const old=g.offscreen.get(3).pixels;
    run(g,createOffscreen(4,2,2,[3])); assert.ok(old.every(v=>!v)); assert.equal(g.offscreen.has(3),false); g.close();
});
test('GDI resize clears primary but retains connection-local field and cache history', () => {
    const g=engine(); run(g,opaque(0,0,1,1,0x123456),cache1(0,0,1,1,24,Uint8Array.of(1,2,3,0)));
    const old=g.screen.pixels; g.resize(20,20); assert.ok(old.every(v=>!v)); assert.equal(pixel(g,0,0),0);
    run(g,Uint8Array.of(0x41),mem(1,0,1,1)); assert.equal(pixel(g,0,0),0x123456); assert.equal(pixel(g,1,0),0x030201); g.close();
});
test('GDI rejects malformed orders, flags, missing caches, invalid ROP dependencies and unsupported brushes', () => {
    const invalid=[Uint8Array.of(9,9),Uint8Array.of(0xc1),Uint8Array.of(9,10,128),Uint8Array.of(0),
        mem(0,0,1,1),dst(0,0,1,1,0xcc),scr(0,0,1,1,0xf0,0,0),pattern(0,0,1,1,{style:2}),
        opaque(0,0,-1,1,1),switchSurface(2),cache1(3,0,1,1,24,new Uint8Array(4)),cache1(0,120,1,1,24,new Uint8Array(4)),
        cache1(0,0,65,65,24,new Uint8Array(4)),cache2(0,0,1,1,24,new Uint8Array(4)),
        createOffscreen(100,1,1),createOffscreen(0,8192,8192)];
    for(const record of invalid) { const g=engine(); assert.throws(()=>run(g,record),ProtocolError); assert.equal(g.closed,true); assert.equal(g.screen.pixels.length,0); }
});
test('GDI failure mid-update emits no partial damage and wipes retained state', () => {
    const g=engine(); const old=g.screen.pixels;
    assert.throws(()=>run(g,opaque(0,0,1,1,0xffffff),Uint8Array.of(9,9)),ProtocolError);
    assert.ok(old.every(v=>!v)); assert.equal(g.fields.size,0); assert.equal(g.cache.bytes,0);
});
test('GDI counts and raster/decompression work are bounded per update', () => {
    const g=engine({maxWork:4}); assert.throws(()=>run(g,opaque(0,0,3,2,1)),/work budget/);
    const h=engine(); assert.throws(()=>h.receive(new Reader(new Uint8Array()),4097),ProtocolError);
    const c=engine({maxWork:1}); assert.throws(()=>run(c,cache1(0,0,2,1,24,new Uint8Array(8))),/work budget/);
});
test('GDI parser rejects every truncated prefix of nonempty representative orders', () => {
    for(const record of [opaque(0,0,2,2,1),pattern(0,0,2,2),scr(0,0,1,1,0xcc,0,0),cache1(0,0,1,1,24,new Uint8Array(4)),createOffscreen(0,1,1)]) {
        for(let cut=0;cut<record.length;cut++) { const g=engine(); assert.throws(()=>run(g,record.subarray(0,cut)),ProtocolError); }
    }
});

test('GDI palette conversion is charged even when the destination rectangle is only one pixel', () => {
    const g=engine({maxWork:10}); run(g,palette(0,{7:0x123456}),cache1(0,0,3,3,8,Uint8Array.of(7,7,7,0,7,7,7,0,7,7,7,0)));
    assert.throws(()=>run(g,mem(0,0,1,1),mem(1,0,1,1)),/work budget/);
    assert.equal(g.closed,true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { GdiOrders } from '../packages/render/gdi/Orders.js';
import { decodeDeltaRectangles, rectangleDelta, multiClip } from '../packages/render/gdi/DeltaRectangles.js';
import { Reader } from '../packages/binary/Reader.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
import { Writer, concat } from '../packages/binary/Writer.js';
import { multi, deltaList, signedDelta } from './fixtures/MultiGdiWire.js';
import { opaque, createOffscreen, switchSurface, mem } from './fixtures/GdiWire.js';
const rect = (x, y, width, height) => ({ x, y, width, height });
const engine = options => new GdiOrders({ width: 32, height: 32, ...options });
const run = (g, ...orders) => g.receive(new Reader(concat(...orders)), orders.length);
const pixel = (g, x, y) => g.screen.pixels[y * g.screen.width + x];
const inRect = (r, x, y) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
const published = Uint8Array.from(Buffer.from('0910df31e400b7000e02c5015affff00aeb2041900084080e480b7820e1b1b810732813980d532fec732820e8178','hex'));
const publishedRects = [rect(228,183,526,27),rect(228,210,263,50),rect(541,210,213,50),rect(228,260,526,376)];

test('GDI delta rectangles decode all 32768 packed signed values, including negative sign extension', () => {
    for (let n = -16384; n <= 16383; n++) {
        const r = new Reader(signedDelta(n)); assert.equal(rectangleDelta(r), n); r.end();
    }
    for (let n = -64; n <= 63; n++) assert.equal(rectangleDelta(new Reader(Uint8Array.of(0x80 | (n >> 8 & 127), n & 255))), n);
});
test('GDI delta rectangles match Microsoft MultiPatBlt example byte for byte', () => {
    assert.deepEqual(decodeDeltaRectangles(published.subarray(21), 4), publishedRects);
    assert.deepEqual(decodeDeltaRectangles(deltaList(publishedRects), 4), publishedRects); // Our encoder can omit repeated extents.
});
test('GDI Microsoft full MultiPatBlt example renders its region rather than its bounding box', () => {
    const g = engine({ width: 800, height: 700 }); run(g, published);
    let painted = 0;
    for (let y = 0; y < 700; y++) for (let x = 0; x < 800; x++) {
        const expected = publishedRects.some(r => inRect(r,x,y));
        assert.equal(pixel(g,x,y), expected ? 0xffff00 : 0); painted += expected;
    }
    assert.equal(painted, 526 * 453 - 50 * 50); g.close();
});
test('GDI delta zero bits repeat extents but only left/top accumulate', () => {
    const rs = [rect(10,20,3,4),rect(15,20,3,4),rect(15,18,7,2),rect(0,0,7,2)];
    assert.deepEqual(decodeDeltaRectangles(deltaList(rs),4),rs);
    assert.deepEqual(decodeDeltaRectangles(Uint8Array.of(255),1),[rect(0,0,0,0)]); // unused nibble is ignored
    assert.deepEqual(decodeDeltaRectangles(new Uint8Array(),0),[]);
});
test('GDI multi orders enforce all inclusive bounds, base extents and destination clipping', () => {
    const base=rect(-4,-3,15,13), clips=[rect(-10,-10,20,20),rect(4,4,20,20)], bounds=[1,2,6,7];
    for(const type of [15,16,18]) {
        const g=engine(); run(g,multi(type,base,clips,{bounds}));
        for(let y=0;y<32;y++) for(let x=0;x<32;x++)
            assert.equal(pixel(g,x,y), x>=1&&x<=6&&y>=2&&y<=7 ? type===15?0xffffff:0x123456 : 0);
        g.close();
    }
});
test('GDI multi clipping normalizes overlapping and duplicated rectangles, applying XOR once', () => {
    const g=engine(); const rs=[rect(1,1,6,6),rect(3,3,6,6),rect(1,1,6,6)];
    run(g,multi(15,rect(0,0,10,10),rs,{code:0x55}));
    for(let y=0;y<10;y++) for(let x=0;x<10;x++) assert.equal(pixel(g,x,y),rs.some(r=>inRect(r,x,y))?0xffffff:0);
    run(g,multi(16,rect(0,0,10,10),rs,{code:0x5a,fore:0xffffff})); assert.ok(g.screen.pixels.every(v=>v===0)); g.close();
});
test('GDI multi pattern origins remain absolute across separated bands', () => {
    const g=engine(); const base=rect(0,0,16,16), rs=[rect(1,1,5,3),rect(8,8,5,3)];
    run(g,multi(16,base,rs,{style:3,orgX:-1,orgY:2,back:0xff0000,fore:0xff,hatch:1,extra:Uint8Array.of(2,4,8,16,32,64,128)}));
    for(let y=0;y<16;y++) for(let x=0;x<16;x++) assert.equal(pixel(g,x,y), !rs.some(r=>inRect(r,x,y))?0:((x+1)&7)===((y-2)&7)?0xff0000:0xff);
    g.close();
});
test('GDI MultiScrBlt snapshots across clipping pieces regardless of enumeration or copy direction', () => {
    for(const [dx,dy] of [[3,0],[-3,0],[0,3],[0,-3],[2,2],[-2,-2]]) {
        const g=engine(); for(let i=0;i<g.screen.pixels.length;i++) g.screen.pixels[i]=i+1;
        const original=g.screen.pixels.slice(), base=rect(8+dx,8+dy,12,12);
        const rs=[rect(base.x+4,base.y,8,12),rect(base.x,base.y,4,12)].reverse();
        run(g,multi(17,base,rs,{sx:8,sy:8}));
        for(let y=0;y<32;y++) for(let x=0;x<32;x++)
            assert.equal(pixel(g,x,y),inRect(base,x,y)?original[(y-dy)*32+x-dx]:original[y*32+x]);
        g.close();
    }
});
test('GDI multi screen-copy operands are mapped after base and common clipping', () => {
    const g=engine(); for(let i=0;i<g.screen.pixels.length;i++) g.screen.pixels[i]=i+1;
    const original=g.screen.pixels.slice();
    run(g,multi(17,rect(-2,-1,10,10),[rect(0,0,9,9)],{sx:3,sy:4,bounds:[1,2,4,5],code:0x66}));
    for(let y=0;y<32;y++) for(let x=0;x<32;x++) assert.equal(pixel(g,x,y),
        x>=1&&x<=4&&y>=2&&y<=5? original[y*32+x]^original[(y+5)*32+x+5]:original[y*32+x]); g.close();
});
test('GDI multi region source-independent ROPs never require in-range source positions', () => {
    const g=engine(); run(g,multi(17,rect(0,0,2,2),[rect(0,0,2,2)],{code:255,sx:-99,sy:-99}));
    assert.equal(pixel(g,1,1),0xffffff); g.close();
});
test('GDI multi rectangle history is independent per order type and from base delta coordinates', () => {
    const g=engine(), base=rect(1,1,5,5), rs=[rect(1,1,2,2),rect(4,4,2,2)];
    run(g,multi(18,base,rs),multi(15,rect(20,20,1,1),[rect(20,20,1,1)]));
    // Explicit type 18, x-only delta +1. Keep absolute rectangle region.
    run(g,Uint8Array.of(0x59,18,1,1));
    assert.equal(g.fields.get(18).x,2); assert.deepEqual(g.fields.get(18).rectangles,rs);
    // Retain the decoded list but use its first rectangle; omitted flags byte 1.
    run(g,Uint8Array.of(0x41,0x80,1)); assert.equal(g.fields.get(18).count,1);
    run(g,Uint8Array.of(0x41,0x80,2)); assert.equal(g.fields.get(18).count,2);
    const old=g.fields.get(18).rectangles;
    run(g,multi(18,base,[rect(1,1,1,1)])); assert.ok(old.every(r=>Object.values(r).every(v=>v===0)));
    g.close();
});
test('GDI multi retained field and rectangle state survives same-size reactivation', () => {
    const g=engine(); run(g,multi(18,rect(0,0,5,5),[rect(1,1,1,1)]));
    g.resize(32,32); run(g,Uint8Array.of(0x81)); assert.equal(pixel(g,1,1),0x123456); g.close();
});
test('GDI multi region draws to offscreen without publishing damage, copying reads primary', () => {
    const g=engine(); run(g,opaque(0,0,5,5,0x123456));
    assert.equal(run(g,createOffscreen(0,5,5),switchSurface(0),multi(17,rect(0,0,5,5),[rect(1,1,2,2)])).length,0);
    run(g,switchSurface(65535),mem(10,10,5,5,{cacheId:255,index:0})); assert.equal(pixel(g,11,11),0x123456); assert.equal(pixel(g,10,10),0); g.close();
});
test('GDI multi zero-count/empty/null brush regions are no-ops', () => {
    const g=engine(); for(const order of [multi(18,rect(0,0,5,5),[]),multi(16,rect(0,0,5,5),[rect(0,0,5,5)],{style:1}),multi(15,rect(0,0,0,5),[rect(0,0,5,5)])])
        assert.equal(run(g,order).length,0); assert.ok(g.screen.pixels.every(v=>!v)); g.close();
});
test('GDI multi sparse damage exports only changed pixels, not base bounding area', () => {
    const g=engine({width:512,height:512}); const out=run(g,multi(18,rect(0,0,512,512),[rect(0,0,1,1),rect(500,500,1,1)]));
    assert.equal(out.reduce((n,r)=>n+r.data.length,0),8); g.close();
});
test('GDI multi supports 45 delta rectangles, rejecting 46, undersized and trailing lists', () => {
    const rs=Array.from({length:45},(_,i)=>rect(i,1,1,1)); assert.deepEqual(decodeDeltaRectangles(deltaList(rs),45),rs);
    for(const [data,count] of [[new Uint8Array(384),0],[new Uint8Array(),46],[Uint8Array.of(255),0],[Uint8Array.of(0,1,2,127,1),1]])
        assert.throws(()=>decodeDeltaRectangles(data,count),ProtocolError);
    const record=multi(18,rect(0,0,32,32),rs); const g=engine(); run(g,record); assert.equal(pixel(g,31,1),0x123456);g.close();
});
test('GDI multi refuses negative extents and cumulative coordinate overflow', () => {
    for(const data of [Uint8Array.of(0,0,0,127,1),concat(Uint8Array.of(0,0,0),...Array(3).fill([signedDelta(16383),signedDelta(0),signedDelta(1),signedDelta(1)]).flat())])
        assert.throws(()=>decodeDeltaRectangles(data,data[0]===0&&data.length>10?3:1),ProtocolError);
});
test('GDI multi parser rejects every truncated prefix and poisons retained raster state', () => {
    for(const type of [15,16,17,18]) {
        const order=multi(type,rect(0,0,8,8),[rect(1,1,2,2),rect(4,4,2,2)]);
        for(let n=0;n<order.length;n++) { const g=engine(); const pixels=g.screen.pixels; pixels.fill(7);
            assert.throws(()=>run(g,order.subarray(0,n)),ProtocolError); assert.equal(g.closed,true); assert.ok(pixels.every(v=>!v)); }
    }
});
test('GDI multi invalid ROP/history/length/source fail closed before returning damage', () => {
    const base=rect(0,0,2,2), rs=[base];
    for(const order of [multi(15,base,rs,{code:0xcc}),multi(16,base,rs,{code:0xcc}),multi(17,base,rs,{code:0xf0}),
        multi(17,base,rs,{sx:31}),Uint8Array.of(9,15,0x20,1),Uint8Array.of(9,15,0x40,0x80,1)]) {
        const g=engine(); assert.throws(()=>run(g,order),ProtocolError); assert.equal(g.closed,true);
    }
});
test('GDI multi work bounds include source snapshots but exclude invisible source extents', () => {
    const g=engine({maxWork:7}); assert.throws(()=>run(g,multi(17,rect(0,0,2,2),[rect(0,0,2,2)])),/work budget/);
    const h=engine({maxWork:2}); run(h,multi(17,rect(0,0,30000,30000),[rect(1,1,1,1)],{sx:0,sy:0})); h.close();
});
test('GDI multi clipping union matches a per-pixel oracle for 1000 deterministic rectangle sets', () => {
    let seed=0x72656374; const random=()=>{ seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0; };
    for(let n=0;n<1000;n++) {
        const rs=Array.from({length:1+random()%45},()=>rect(random()%40-5,random()%40-5,random()%25,random()%25));
        const parts=multiClip({width:32,height:32},rect(3,4,25,22),rs,rs.length,{left:4,top:5,right:26,bottom:24});
        const counts=new Uint8Array(1024); for(const a of parts) for(let y=a.y;y<a.y+a.height;y++)for(let x=a.x;x<a.x+a.width;x++)counts[y*32+x]++;
        for(let y=0;y<32;y++)for(let x=0;x<32;x++)assert.equal(counts[y*32+x],Number(x>=4&&x<=26&&y>=5&&y<=24&&rs.some(r=>inRect(r,x,y))));
    }
});

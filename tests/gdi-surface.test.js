import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../packages/protocol/Session.js';
import { LoopbackServer } from '../packages/lab/LoopbackServer.js';
import { decodeNsCodec, nsCodecToXrgb } from '../packages/codecs/NsCodec.js';
import { toRgba } from '../packages/codecs/Pixels.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
import { concat } from '../packages/binary/Writer.js';
import { configureSurfacePeer,surfaceBits,surfaceMarker,sampleNsc,expectedNsPixel } from './fixtures/SurfacePeer.js';
import { slowOrders,scr,opaque } from './fixtures/GdiWire.js';
const turns=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));};
async function fixture(t){
    let session;const events=[];
    const peer=new LoopbackServer({send:b=>queueMicrotask(()=>session.receive(b))});
    const state=configureSurfacePeer(peer);
    session=new Session({options:{bpp:32,orders:true,surfaceGraphics:true,surfaceQuality:'balanced',selectedProtocol:1,requestedProtocols:1},
        send:b=>queueMicrotask(()=>peer.receive(b)),emit:e=>events.push(e)});
    t.after(()=>{session.close();peer.close();});session.start();await turns();
    assert.equal(session.state,'active');assert.ok(session.gdi&&session.surface);events.length=0;
    return {session,peer,state,events};
}
const color=rgba=>rgba[0]<<16|rgba[1]<<8|rgba[2];
test('NSCodec directly reconstructs canonical XRGB with no endianness dependency or intermediate RGBA allocation',()=>{
    for(const width of [1,7,17])for(const height of [1,5])for(const subsampled of [false,true])for(const sourceBpp of [24,32])for(let loss=1;loss<=7;loss++){
        const settings={width,height,subsampled,loss,sourceBpp};
        const b=decodeNsCodec(sampleNsc(settings),width,height,{sourceBpp});
        const out=nsCodecToXrgb(b);
        for(let y=0;y<height;y++)for(let x=0;x<width;x++)assert.equal(out[y*width+x],color(expectedNsPixel(x,y,settings)));
        const copy=out.slice();b.data.fill(0);assert.deepEqual(out,copy);
    }
});
test('NSCodec XRGB output validates destination bounds and rejects aliasing',()=>{
    const b=decodeNsCodec(sampleNsc(),7,5);
    for(const output of [new Uint32Array(34),new Uint8Array(140),new Uint32Array(b.data.buffer,0,1)])
        assert.throws(()=>nsCodecToXrgb(b,output),ProtocolError);
    const out=new Uint32Array(40).fill(0xdeadbeef);assert.equal(nsCodecToXrgb(b,out),out);
    assert.ok(out.subarray(35).every(p=>p===0xdeadbeef));
});
test('Unmarked NSCodec and raw surface updates precede subsequent source-dependent GDI blits',async t=>{
    const h=await fixture(t);
    h.peer.surface(surfaceBits({x:4,y:5}));await turns();
    h.peer.data(2,slowOrders(scr(30,10,7,5,0xcc,4,5)));await turns();
    const screen=h.session.gdi.screen;
    for(let y=0;y<5;y++)for(let x=0;x<7;x++)assert.equal(screen.pixels[(y+10)*screen.width+x+30],color(expectedNsPixel(x,y)));
    h.peer.surface(surfaceBits({codec:0,x:4,y:5,width:1,height:1,data:Uint8Array.of(3,2,1,0)}));
    h.peer.data(2,slowOrders(scr(30,10,1,1,0xcc,4,5)));await turns();
    assert.equal(screen.pixels[10*screen.width+30],0x010203);
});
test('Marked frames retain NSCodec, GDI and ordinary bitmap order without early rendering or ACK',async t=>{
    const h=await fixture(t);
    h.peer.surface(concat(surfaceMarker(0,73),surfaceBits({x:4,y:5})));
    h.peer.data(2,slowOrders(scr(30,10,7,5,0xcc,4,5),opaque(32,12,1,1,0xabcdef)));
    h.peer.bitmap(36,14,1,1,Uint8Array.of(50,60,70,255));await turns();
    assert.equal(h.session.state,'active',JSON.stringify(h.events));assert.equal(h.events.some(e=>e.type==='bitmaps'||e.type==='surface-frame'),false);
    assert.deepEqual(h.state.acks,[]);
    h.peer.surface(surfaceMarker(1,73));await turns();
    const f=h.events.find(e=>e.type==='surface-frame');assert.ok(f);assert.equal(f.rectangles.length,3);
    const displayed=new Uint32Array(h.session.desktop.width*h.session.desktop.height);
    for(const r of f.rectangles){const rgba=toRgba(r);for(let y=0;y<r.drawHeight;y++)for(let x=0;x<r.drawWidth;x++)
        displayed[(y+r.y)*h.session.desktop.width+x+r.x]=color(rgba.subarray((y*r.width+x)*4));}
    for(let y=0;y<5;y++)for(let x=0;x<7;x++){
        let expected=color(expectedNsPixel(x,y));if(x===2&&y===2)expected=0xabcdef;if(x===6&&y===4)expected=0x323c46;
        assert.equal(displayed[(y+10)*h.session.desktop.width+x+30],expected);
        assert.equal(h.session.gdi.screen.pixels[(y+10)*h.session.desktop.width+x+30],expected);
    }
    assert.deepEqual(h.state.acks,[]);h.session.presentSurface(f.token);await turns();assert.deepEqual(h.state.acks,[73]);
});
test('A malformed order within a marked surface frame releases the shadow and withholds all frame pixels',async t=>{
    const h=await fixture(t);h.peer.surface(concat(surfaceMarker(0,1),surfaceBits()));await turns();
    const shadow=h.session.gdi.screen.pixels,held=h.session.surface.current.rectangles[0].data;
    h.peer.data(2,slowOrders(Uint8Array.of(9,255)));await turns();
    assert.equal(h.session.state,'failed');assert.ok(shadow.every(v=>v===0));assert.ok(held.every(v=>v===0));
    assert.equal(h.events.some(e=>e.type==='surface-frame'||e.type==='bitmaps'),false);assert.deepEqual(h.state.acks,[]);
});
test('GDI primary pixels reset at desktop reactivation while stale marked-frame receipts are invalidated',async t=>{
    const h=await fixture(t);h.peer.surface(concat(surfaceMarker(0,1),surfaceBits(),surfaceMarker(1,1)));await turns();
    const old=h.events.find(e=>e.type==='surface-frame'),shadow=h.session.gdi.screen.pixels;
    h.peer.reactivateSurface();await turns();assert.equal(h.session.state,'active');assert.ok(shadow.every(v=>v===0));
    assert.ok(h.session.gdi.screen.pixels.every(v=>v===0));assert.equal(h.session.presentSurface(old.token),false);
    h.peer.data(2,slowOrders(scr(30,10,7,5,0xcc,0,0)));await turns();
    assert.equal(h.session.gdi.screen.pixels[10*h.session.desktop.width+30],0);
});

test('Marked NSCodec frames keep multi-order clipping and source snapshots atomic until presentation',async t=>{
    const {multi}=await import('./fixtures/MultiGdiWire.js');const h=await fixture(t);
    h.peer.surface(concat(surfaceMarker(0,123),surfaceBits({x:4,y:5})));
    h.peer.data(2,slowOrders(multi(17,{x:5,y:5,width:6,height:5},[{x:8,y:5,width:3,height:5},{x:5,y:5,width:4,height:5}],{sx:4,sy:5})));
    await turns();assert.equal(h.session.state,'active');assert.equal(h.events.some(e=>e.type==='bitmaps'||e.type==='surface-frame'),false);
    h.peer.surface(surfaceMarker(1,123));await turns();
    const frame=h.events.find(e=>e.type==='surface-frame');assert.ok(frame);assert.deepEqual(h.state.acks,[]);
    for(let y=0;y<5;y++)for(let x=0;x<6;x++)assert.equal(h.session.gdi.screen.pixels[(y+5)*h.session.desktop.width+x+5],color(expectedNsPixel(x,y)));
    assert.equal(h.session.presentSurface(frame.token),true);await turns();assert.deepEqual(h.state.acks,[123]);
});

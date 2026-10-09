import test from 'node:test';
import assert from 'node:assert/strict';
import { SurfaceCommands } from '../packages/protocol/SurfaceCommands.js';
import { NSCODEC_GUID, negotiateSurfaceGraphics, surfaceCapabilityBodies } from '../packages/protocol/SurfaceCapabilities.js';
import { Writer, concat } from '../packages/binary/Writer.js';
import { Reader } from '../packages/binary/Reader.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
import { toRgba } from '../packages/codecs/Pixels.js';
import { planBatches } from '../packages/render/BatchPlanner.js';
import { clientCapabilities } from '../packages/protocol/Capabilities.js';

const u32 = n => new Writer().u32le(n).finish();
const offer = (props = [1, 1, 5], id = 42) => new Writer().u8(1).put(Uint8Array.from(NSCODEC_GUID)).u8(id).u16le(props.length).put(Uint8Array.from(props)).finish();
const caps = () => new Map([[28, concat(u32(0x52),u32(0))],[29,offer()],[30,u32(0)],[26,u32(16*1024*1024)]]);
const options = { bpp: 32, surfaceGraphics: true };
const marker = (action, id) => new Writer().u16le(4).u16le(action).u32le(id).finish();
function bitmap({ type = 1, x = 0, y = 0, width = 2, height = 2, right = x+width, bottom = y+height,
    bpp = 32, flags = 0, reserved = 0, codec = 0, data = new Uint8Array(width*height*bpp/8), extra = new Uint8Array(24) } = {}) {
    return new Writer().u16le(type).u16le(x).u16le(y).u16le(right).u16le(bottom).u8(bpp).u8(flags).u8(reserved).u8(codec)
        .u16le(width).u16le(height).u32le(data.length).put(flags & 1 ? extra : new Uint8Array()).put(data).finish();
}
function fixture(overrides = {}) {
    const events=[],acks=[]; let time=0;
    const decoder = new SurfaceCommands({ desktop:{width:200,height:200}, profile:negotiateSurfaceGraphics(caps(),options),
        emit:e=>events.push(e), acknowledge:id=>acks.push(id),now:()=>time,...overrides });
    return {decoder,events,acks,tick:n=>time=n};
}
const nsc = new Writer().u32le(4).u32le(4).u32le(4).u32le(0).u8(1).u8(0).u16le(0)
    .put(Uint8Array.from([50,60,70,80,10,10,10,10,5,5,5,5])).finish();

test('Surface capabilities are opt-in, 32-bit, bounded and intersect the server offer',()=>{
    for (const opt of [{},{...options,bpp:24},{...options,surfaceGraphics:false}]) assert.equal(negotiateSurfaceGraphics(caps(),opt).flags,0);
    assert.equal(negotiateSurfaceGraphics(new Map(),options).flags,0);
    const m=caps();m.set(26,u32(16*1024*1024+1));assert.equal(negotiateSurfaceGraphics(m,options).flags,0);
    m.set(26,u32(4096));m.set(28,concat(u32(0x80000012),u32(0)));
    assert.equal(negotiateSurfaceGraphics(m,options).flags,0x12);
    m.set(28,concat(u32(0x10),u32(0)));assert.equal(negotiateSurfaceGraphics(m,options).flags,0);
});
test('NSCodec client codec ID is exactly one; quality defaults to sharp without chroma subsampling',()=>{
    const profile=negotiateSurfaceGraphics(caps(),options), bodies=new Map(surfaceCapabilityBodies(profile));
    assert.deepEqual(profile,{flags:0x52,nsCodec:true,frameAcks:true,maxColorLoss:1,allowSubsampling:false});
    const r=new Reader(bodies.get(29));assert.equal(r.u8(),1);assert.deepEqual([...r.take(16)],NSCODEC_GUID);
    assert.equal(r.u8(),1);assert.equal(r.u16le(),3);assert.deepEqual([...r.take(3)],[0,0,1]);r.end();
    assert.equal(new Reader(bodies.get(30)).u32le(),2);
    const balanced=negotiateSurfaceGraphics(caps(),{...options,surfaceQuality:'balanced'});
    assert.equal(balanced.maxColorLoss,3);assert.equal(balanced.allowSubsampling,true);
    const wire=clientCapabilities({width:200,height:200,bpp:32,surfaceProfile:profile});
    assert.deepEqual(wire.slice(-3).map(b=>new Reader(b).u16le()),[28,29,30]);
});
test('Unknown codec records are bounded/skipped, malformed and duplicate NSCodec capabilities fail',()=>{
    const m=caps();m.delete(30);m.set(29,new Writer().u8(1).zeros(16).u8(5).u16le(4).zeros(4).finish());
    const p=negotiateSurfaceGraphics(m,options);assert.equal(p.nsCodec,false);assert.equal(p.frameAcks,false);
    for (const props of [[],[0,0],[2,0,1],[0,2,1],[0,0,0],[0,0,8],[0,0,1,0]]) {
        m.set(29,offer(props));assert.throws(()=>negotiateSurfaceGraphics(m,options),ProtocolError);
    }
    m.set(29,concat(Uint8Array.of(2),offer().subarray(1),offer().subarray(1)));
    assert.throws(()=>negotiateSurfaceGraphics(m,options),ProtocolError);
    for (const type of [26,28,29,30]) { const c=caps();c.set(type,new Uint8Array());assert.throws(()=>negotiateSurfaceGraphics(c,options),ProtocolError); }
});
test('Set Surface Bits ignores non-authoritative bounds; Stream Surface Bits crops exclusive bounds',()=>{
    const h=fixture();h.decoder.receive(bitmap({x:10,y:12,right:0,bottom:0}));
    assert.equal(h.events[0].rectangles[0].drawWidth,2);assert.equal(h.events[0].rectangles[0].x,10);
    h.decoder.receive(bitmap({type:6,x:10,y:12,right:11,bottom:13}));
    assert.equal(h.events[1].rectangles[0].drawWidth,1);assert.equal(h.events[1].rectangles[0].drawHeight,1);
    assert.equal(h.events[0].token,null);assert.deepEqual(h.acks,[]);
});
test('Surface raw 24/32-bit tight and padded rows remain compatible with ordinary render descriptors',()=>{
    for(const bpp of [24,32]) for(const padded of [false,true]) {
        const stride=padded?4:bpp/8,data=new Uint8Array(stride*2);data.set([30,20,10],0);data.set([60,50,40],stride);
        const h=fixture();h.decoder.receive(bitmap({bpp,width:1,height:2,data}));const rect=h.events[0].rectangles[0];
        assert.deepEqual([...toRgba(rect)],[40,50,60,255,10,20,30,255]);
        assert.equal(planBatches([rect],200,200).pixels,2);
    }
});
test('Optional 24-byte extended surface header lies outside bitmapDataLength',()=>{
    const h=fixture();h.decoder.receive(concat(bitmap({flags:1,extra:new Uint8Array(24).fill(0xff)}),bitmap()));
    assert.equal(h.events.length,2);assert.equal(h.events[0].rectangles[0].data.length,16);
});
test('NSCodec stays packed through the surface parser and renderer planner',()=>{
    const h=fixture();h.decoder.receive(bitmap({codec:1,data:nsc}));const rect=h.events[0].rectangles[0];
    assert.equal(rect.encoding,'nscodec');assert.equal(rect.data.length,12);assert.equal(rect.stride,2);
    assert.deepEqual([...toRgba(rect)],[75,75,55,255,85,85,65,255,55,55,35,255,65,65,45,255]);
    assert.equal(planBatches([rect],200,200).dataSize,12);
});
test('Surface path enforces codec negotiation and negotiated loss/subsampling policy',()=>{
    const h=fixture({profile:{flags:2}});assert.throws(()=>h.decoder.receive(bitmap({codec:1,data:nsc})),ProtocolError);
    const changed=nsc.slice();changed[16]=2;
    assert.throws(()=>fixture().decoder.receive(bitmap({codec:1,data:changed})),ProtocolError);
    for(const codec of [2,255]) assert.throws(()=>fixture().decoder.receive(bitmap({codec})),ProtocolError);
    assert.throws(()=>fixture({profile:{flags:2}}).decoder.receive(marker(1,1)),ProtocolError);
});
test('Marked frame spans updates; nothing is delivered before END or acknowledged before presentation',()=>{
    const h=fixture();h.decoder.receive(concat(marker(0,7),bitmap()));
    const held=h.decoder.current.rectangles[0].data;assert.equal(h.events.length,0);assert.equal(h.acks.length,0);
    h.decoder.receive(bitmap({codec:1,data:nsc}));assert.equal(h.events.length,0);
    h.decoder.receive(marker(1,7));assert.equal(h.events.length,1);assert.equal(h.events[0].rectangles.length,2);
    assert.equal(h.events[0].rectangles[0].data,held);assert.equal(h.acks.length,0);
    assert.equal(h.decoder.presented(7),false); // server ID is NOT a receipt
    assert.equal(h.decoder.presented(h.events[0].token),true);assert.deepEqual(h.acks,[7]);
    assert.equal(h.decoder.presented(h.events[0].token),false);
});
test('END-only/empty frames and wrapped or reused wire identifiers get distinct local receipts',()=>{
    const h=fixture();for(const id of [0xfffffffe,0,1,1]) h.decoder.receive(marker(1,id));
    assert.equal(new Set(h.events.map(e=>e.token)).size,4);
    for(const e of h.events) { assert.deepEqual(e.rectangles,[]);h.decoder.presented(e.token); }
    assert.deepEqual(h.acks,[0xfffffffe,0,1,1]);
});
test('Reactivation epoch cannot satisfy a new frame using an old render token',()=>{
    let next=0;const a=fixture({nextToken:()=>++next}),b=fixture({nextToken:()=>++next});
    a.decoder.receive(marker(1,9));a.decoder.close();b.decoder.receive(marker(1,9));
    assert.equal(a.decoder.presented(a.events[0].token),false);
    assert.equal(b.decoder.presented(a.events[0].token),false);assert.equal(b.acks.length,0);
    b.decoder.presented(b.events[0].token);assert.deepEqual(b.acks,[9]);
});
test('Nested/mismatched markers and incomplete-frame deadline clear private buffered pixels',()=>{
    for(const invalid of [marker(0,2),marker(1,2),marker(2,1)]) {
        const h=fixture();h.decoder.receive(concat(marker(0,1),bitmap({data:new Uint8Array(16).fill(100)})));
        const held=h.decoder.current.rectangles[0].data;
        assert.throws(()=>h.decoder.receive(invalid),ProtocolError);assert.ok(held.every(v=>v===0));assert.equal(h.decoder.closed,true);
    }
    const h=fixture();h.decoder.receive(marker(0,1));h.tick(14999);h.decoder.checkDeadline();h.tick(15000);
    assert.throws(()=>h.decoder.checkDeadline(),/finish/);h.decoder.close();assert.equal(h.decoder.current,null);
});
test('Surface memory, command and acknowledgement windows are bounded independently',()=>{
    const h=fixture();h.decoder.receive(marker(0,1));
    for(let i=0;i<4096;i++) h.decoder.receive(bitmap({width:1,height:1}));
    assert.throws(()=>h.decoder.receive(bitmap({width:1,height:1})),/budget/);assert.equal(h.events.length,0);
    const a=fixture();for(let i=0;i<64;i++)a.decoder.receive(marker(1,i));
    assert.throws(()=>a.decoder.receive(marker(1,64)),/limit/);assert.equal(a.decoder.pending.size,0);
});
test('Failed render delivery clears transferred ownership and never acknowledges a frame',()=>{
    let held;const h=fixture({emit:e=>{held=e.rectangles[0].data;throw new Error('host');}});
    assert.throws(()=>h.decoder.receive(concat(marker(0,1),bitmap({data:new Uint8Array(16).fill(1)}),marker(1,1))),/host/);
    assert.ok(held.every(v=>v===0));assert.equal(h.decoder.pending.size,0);assert.deepEqual(h.acks,[]);
});
test('Surface malformed flags, bounds, sizes, unknown commands and every truncated prefix fail safely',()=>{
    for(const changes of [{type:2},{bpp:16},{flags:2},{x:199},{type:6,right:0},{type:6,right:3},{codec:255},{width:0},{data:new Uint8Array(15)}])
        assert.throws(()=>fixture().decoder.receive(bitmap(changes)),ProtocolError);
    for(const input of [bitmap(),bitmap({flags:1}),bitmap({codec:1,data:nsc}),marker(1,9)])
        for(let n=1;n<input.length;n++) assert.throws(()=>fixture().decoder.receive(input.subarray(0,n)),ProtocolError);
});
test('Surface decoder does not emit an all-in-flight acknowledgement and rejects nonzero reserved bytes',()=>{
    assert.throws(()=>fixture().decoder.receive(marker(1,0xffffffff)),ProtocolError);
    assert.throws(()=>fixture().decoder.receive(bitmap({reserved:1})),ProtocolError);
});

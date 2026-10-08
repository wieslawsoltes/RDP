import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMonitorLayout, encodeServerMonitorLayout, parseServerMonitorLayout } from '../packages/protocol/MonitorLayout.js';
import { DisplayControl, encodeDisplayLayout, parseDisplayLayout } from '../packages/channels/DisplayControl.js';
import { conferenceRequest } from '../packages/protocol/Gcc.js';
import { Session } from '../packages/protocol/Session.js';
import { LoopbackServer } from '../packages/lab/LoopbackServer.js';
import { Reader } from '../packages/binary/Reader.js';
import { Writer } from '../packages/binary/Writer.js';
const primary = { primary: true, left: 0, top: 0, width: 1280, height: 800 };
const dual = [primary, { left: -1280, top: -200, width: 1280, height: 1024 }];
const turns = async (n=24) => { for(let i=0;i<n;i++) await new Promise(resolve=>setImmediate(resolve)); };
test('Monitor normalization owns immutable records and handles negative origins',()=>{
    const source = structuredClone(dual), layout = normalizeMonitorLayout(source);
    assert.equal(layout.left,-1280); assert.equal(layout.top,-200);
    assert.equal(layout.width,2560); assert.equal(layout.height,1024);
    source[0].width=200;
    assert.equal(layout.monitors[0].width,1280);
    assert.ok(Object.isFrozen(layout.monitors[0]));
});
test('Monitor validation rejects overlap, wrong primary, invalid fields and allocation amplification',()=>{
    const reject = (monitors,code) => assert.throws(()=>normalizeMonitorLayout(monitors),{code});
    reject([], 'MONITOR_COUNT');
    reject(Array(17).fill(primary),'MONITOR_COUNT');
    reject([{...primary,primary:false}],'MONITOR_PRIMARY');
    reject([{...primary,left:10}],'MONITOR_PRIMARY');
    reject([primary,{...primary,left:0,primary:false}],'MONITOR_OVERLAP');
    reject([{...primary,width:NaN}],'MONITOR_FIELD');
    reject([{...primary,width:1281}],'MONITOR_WIDTH');
    reject([{...primary,deviceScaleFactor:125}],'MONITOR_SCALE');
    reject([{...primary,orientation:45}],'MONITOR_ORIENTATION');
    reject([primary,{left:10000,top:0,width:200,height:200}],'MONITOR_BUDGET');
    reject([{...primary,width:8192,height:8192}],'MONITOR_BUDGET');
    assert.throws(()=>normalizeMonitorLayout(dual,{maxMonitors:1}),{code:'MONITOR_COUNT'});
});
test('Server monitor definitions use inclusive endpoints with exact byte consumption',()=>{
    const bytes=encodeServerMonitorLayout(dual), view=new DataView(bytes.buffer);
    assert.equal(bytes.length,44); assert.equal(view.getInt32(12,true),1279);
    assert.equal(view.getInt32(24,true),-1280); assert.equal(view.getInt32(32,true),-1);
    const layout=parseServerMonitorLayout(bytes); assert.equal(layout.left,-1280); assert.equal(layout.width,2560);
    for(let length=0;length<bytes.length;length++) assert.throws(()=>parseServerMonitorLayout(bytes.subarray(0,length)));
    assert.throws(()=>parseServerMonitorLayout(new Uint8Array([...bytes,0])),{code:'MONITOR_LENGTH'});
    const invalid=bytes.slice(); new DataView(invalid.buffer).setUint32(20,3,true);
    assert.throws(()=>parseServerMonitorLayout(invalid),{code:'MONITOR_FLAGS'});
});
test('Display-control layout preserves scaling, physical dimensions and orientation',()=>{
    const layout=normalizeMonitorLayout([primary,{...dual[1],orientation:90,desktopScaleFactor:150,deviceScaleFactor:140,physicalWidth:400,physicalHeight:300}]);
    const bytes=encodeDisplayLayout(layout); assert.equal(bytes.length,96);
    assert.deepEqual(parseDisplayLayout(bytes),layout);
    const bad=bytes.slice();bad[8]=39;
    assert.throws(()=>parseDisplayLayout(bad),{code:'DISPLAY_LAYOUT'});
});
test('Display capabilities multiply all three factors without integer precision loss',()=>{
    const sent=[],events=[],d=new DisplayControl(b=>sent.push(b),e=>events.push(e));
    assert.throws(()=>d.layout(dual),{code:'DISPLAY_STATE'});
    d.receive(new Writer().u32le(5).u32le(20).u32le(2).u32le(1280).u32le(1024).finish());
    d.layout(dual);assert.equal(sent.length,1);assert.equal(d.caps.maxArea,2621440n);
    assert.throws(()=>d.layout([primary,{left:1280,top:0,width:1920,height:1080}]),{code:'MONITOR_AREA'});
    d.receive(new Writer().u32le(5).u32le(20).u32le(0xffffffff).u32le(0xffffffff).u32le(0xffffffff).finish());
    assert.equal(d.caps.maxArea,4294967295n**3n);d.layout(dual);
    d.close(); assert.throws(()=>d.resize(800,600),{code:'DISPLAY_STATE'});
});
function gccBlocks(bytes) {
    const r=new Reader(bytes);r.skip(7);const inner=r.sub(r.perLength());inner.skip(12);
    const blocks=inner.sub(inner.perLength()), result=new Map();
    while(blocks.remaining){const type=blocks.u16le(),size=blocks.u16le();result.set(type,blocks.take(size-4));}
    return result;
}
test('Initial monitor GCC data is gated on the actual X.224 extended-data flag',()=>{
    assert.throws(()=>conferenceRequest({monitors:dual,selectedProtocol:1},[]),{code:'MONITOR_NEGOTIATION'});
    const blocks=gccBlocks(conferenceRequest({monitors:dual,flags:1,selectedProtocol:1},[]));
    assert.equal(blocks.get(0xc005).length,48);assert.equal(blocks.get(0xc008).length,52);
    assert.equal(new DataView(blocks.get(0xc001).buffer,blocks.get(0xc001).byteOffset).getUint16(4,true),2560);
    const monitors=parseServerMonitorLayout(blocks.get(0xc005).subarray(4));assert.equal(monitors.left,-1280);
    assert.ok(!gccBlocks(conferenceRequest({},[])).has(0xc005));
});
test('Activated session processes multi-monitor dynamic resize through MCS and reactivation',async()=>{
    const events=[];let client;
    const server=new LoopbackServer({send:b=>queueMicrotask(()=>client.receive(b))});
    client=new Session({options:{selectedProtocol:1,requestedProtocols:1,width:640,height:400},send:b=>queueMicrotask(()=>server.receive(b)),emit:e=>events.push(e)});
    client.start();await turns();assert.equal(client.state,'active');assert.ok(client.display.caps);
    client.setMonitors(dual);await turns();
    assert.equal(client.state,'active');assert.deepEqual(client.desktop,{width:2560,height:1024});
    assert.equal(events.find(e=>e.type==='monitor-layout').left,-1280);
    assert.equal(client.monitorLayout.monitors.length,2);
    assert.throws(()=>client.setMonitors([{...primary,width:1281}]),{code:'MONITOR_WIDTH'});
    assert.equal(client.state,'active');client.close();server.close();
});
test('Initial negotiated monitor data reaches session peer and server monitor response',async()=>{
    let client;const events=[];
    const server=new LoopbackServer({send:b=>queueMicrotask(()=>client.receive(b))});
    client=new Session({options:{selectedProtocol:1,requestedProtocols:1,flags:1,monitors:dual},send:b=>queueMicrotask(()=>server.receive(b)),emit:e=>events.push(e)});
    client.start();await turns();assert.equal(client.state,'active');assert.equal(client.desktop.width,2560);
    assert.equal(events.find(e=>e.type==='monitor-layout').monitors.length,2);client.close();server.close();
});

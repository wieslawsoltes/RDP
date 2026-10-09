import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../../apps/bridge/server.js';
import { Session } from '../../packages/protocol/Session.js';
import { WireSendQueue } from '../../packages/protocol/WireSendQueue.js';
import { LoopbackServer } from '../../packages/lab/LoopbackServer.js';
import { configureSurfacePeer,surfaceBits,surfaceMarker,sampleNsc,expectedNsPixel } from '../fixtures/SurfacePeer.js';
import { makeCertificate,serveRdp } from '../fixtures/NetworkServer.js';
import { websocketClient } from '../fixtures/WebSocketClient.js';
import { Writer, concat } from '../../packages/binary/Writer.js';
import { toRgba } from '../../packages/codecs/Pixels.js';
const turns=async()=>{for(let i=0;i<20;i++)await new Promise(r=>setImmediate(r));};
const settings={surfaceGraphics:true,surfaceQuality:'balanced',bpp:32,resize:false};
test('Surface negotiation is optional; fragmented surface bits group atomically and ACK after explicit render receipt',async()=>{
    for(const enabled of [false,true]) {
        let session;const events=[];
        const peer=new LoopbackServer({send:b=>queueMicrotask(()=>session.receive(b))});const state=configureSurfacePeer(peer);
        session=new Session({options:{...settings,surfaceGraphics:enabled,selectedProtocol:1,requestedProtocols:1},send:b=>queueMicrotask(()=>peer.receive(b)),emit:e=>events.push(e)});
        session.start();await turns();assert.equal(session.state,'active');assert.equal(!!state.profile,enabled);
        if(enabled){
            peer.surface(concat(surfaceMarker(0,55),surfaceBits({width:71,height:15,data:sampleNsc({width:71,height:15})})));
            await turns();assert.equal(events.filter(e=>e.type==='surface-frame').length,0);
            peer.surface(surfaceMarker(1,55));await turns();const e=events.find(e=>e.type==='surface-frame');
            assert.equal(e.rectangles.length,1);assert.deepEqual(state.acks,[]);assert.equal(session.presentSurface(55),false);
            session.presentSurface(e.token);await turns();assert.deepEqual(state.acks,[55]);
            peer.reactivateSurface();await turns();assert.equal(session.state,'active');assert.equal(session.presentSurface(e.token),false);
        }else{peer.surface(surfaceMarker(1,55));await turns();assert.equal(session.state,'failed');assert.deepEqual(state.acks,[]);}
        session.close();peer.close();
    }
});
test('Surface marked frame supports ordinary bitmap interleaving without an early pixel event',async()=>{
    let session;const events=[];const peer=new LoopbackServer({send:b=>queueMicrotask(()=>session.receive(b))});configureSurfacePeer(peer);
    session=new Session({options:{...settings,selectedProtocol:1,requestedProtocols:1},send:b=>queueMicrotask(()=>peer.receive(b)),emit:e=>events.push(e)});
    session.start();await turns();peer.surface(surfaceMarker(0,1));peer.bitmap(0,0,2,2,new Uint8Array(16).fill(50));await turns();
    assert.equal(events.filter(e=>e.type==='bitmaps').length,0);peer.surface(surfaceMarker(1,1));await turns();
    assert.equal(events.find(e=>e.type==='surface-frame').rectangles.length,1);session.close();peer.close();
});
test('NSCodec frames and exact ACKs traverse the actual WS/TCP/TLS/CredSSP gateway', {timeout:20000}, async t=>{
    const cert=await makeCertificate();t.after(()=>cert.close());let peer,state;
    const remote=await serveRdp(cert,{nla:true,configurePeer:p=>{peer=p;state=configureSurfacePeer(p);}});t.after(()=>remote.close());
    const token='surface-gateway-token-0123456789abcdef',origin='https://wieslawsoltes.github.io';
    const bridge=await createBridge({port:0,token,allowedOrigins:[origin],targets:new Map([['fixture',{
        id:'fixture',name:'Surface fixture',host:'127.0.0.1',port:remote.port,serverName:'localhost',ca:cert.cert,
    }]])});t.after(()=>bridge.close());
    const ws=await websocketClient(bridge.origin,origin);t.after(()=>ws.socket.destroy());
    ws.send({type:'connect',inputFlowControl:true,token,targetId:'fixture',security:'nla',username:'User',domain:'LAB',password:'Password'});
    let ready;do{ready=await ws.receive();assert.notEqual(ready.type,'error',ready.message);}while(ready.type!=='ready');
    const events=[],errors=[];const queue=new WireSendQueue({send:b=>ws.send(b),bufferedAmount:()=>ws.socket.writableLength,window:ready.inputWindow,onError:e=>errors.push(e)});t.after(()=>queue.close());
    const session=new Session({options:{...settings,...ready},send:b=>queue.enqueue(b),emit:e=>events.push(e)});t.after(()=>session.close());
    const until=async predicate=>{while(!predicate()){
        const v=await ws.receive();
        if(v instanceof Uint8Array){session.receive(v);ws.send({type:'ack',bytes:v.length});}
        else if(v.type==='licensing')session.licensingResult(v);else if(v.type==='input-ack')queue.acknowledge(v.bytes);else assert.notEqual(v.type,'error',v.message);
        assert.notEqual(session.state,'failed',JSON.stringify(events.filter(e=>e.type==='error')));assert.equal(errors.length,0);
    }};
    session.start();await until(()=>session.state==='active');assert.deepEqual(state.profile,{fidelity:1,sampling:1,loss:3});
    peer.surface(concat(surfaceMarker(0,71),surfaceBits()));peer.advertiseClipboard();
    await until(()=>session.surface.current?.rectangles.length===1);assert.deepEqual(state.acks,[]);assert.equal(events.some(e=>e.type==='surface-frame'),false);
    peer.surface(surfaceMarker(1,71));await until(()=>events.some(e=>e.type==='surface-frame'));
    const frame=events.find(e=>e.type==='surface-frame'),rgba=toRgba(frame.rectangles[0]);
    for(let y=0;y<5;y++)for(let x=0;x<7;x++)assert.deepEqual([...rgba.subarray((y*7+x)*4,(y*7+x+1)*4)],expectedNsPixel(x,y));
    assert.deepEqual(state.acks,[]);session.presentSurface(frame.token);await until(()=>state.acks.length===1);assert.deepEqual(state.acks,[71]);
    // Cross the actual TLS/NLA gateway again rather than treating an in-process
    // reactivation as sufficient. A old render token must not ACK a new epoch.
    peer.surface(concat(surfaceMarker(0,72),surfaceBits(),surfaceMarker(1,72)));
    await until(()=>events.filter(e=>e.type==='surface-frame').length===2);
    const stale=events.filter(e=>e.type==='surface-frame')[1].token;
    const previousEvents=events.length;
    peer.reactivateSurface();
    await until(()=>events.slice(previousEvents).some(e=>e.type==='state'&&e.state==='active'));
    assert.equal(state.confirms,2);
    assert.ok(events.slice(previousEvents).some(e=>e.type==='state'&&e.state==='reactivating'));
    assert.equal(session.presentSurface(stale),false);
    let receivedInput=false;
    const previousInput=peer.onInput;
    peer.onInput=list=>{previousInput(list);if(list.some(e=>e.type===4&&e.a===0x30))receivedInput=true;peer.advertiseClipboard();};
    session.input([{type:'key',code:0x30}]);
    await until(()=>receivedInput);
    peer.surface(concat(surfaceMarker(0,73),surfaceBits(),surfaceMarker(1,73)));
    await until(()=>events.filter(e=>e.type==='surface-frame').length===3);
    const resumed=events.filter(e=>e.type==='surface-frame')[2];
    assert.notEqual(resumed.token,stale);session.presentSurface(resumed.token);
    await until(()=>state.acks.length===2);assert.deepEqual(state.acks,[71,73]);
    assert.equal(remote.errors.length,0);assert.equal(remote.credentialRecords[0].passwordVerified,true);
});

// Never silently recolor earlier indexed bitmaps by applying a palette out of
// order while their enclosing 32-bit surface frame is still being assembled.
test('Palette changes inside a marked surface frame fail without an acknowledgement', async () => {
    let session; const events = [];
    const peer = new LoopbackServer({ send: b => queueMicrotask(() => session.receive(b)) });
    const state = configureSurfacePeer(peer);
    session = new Session({ options: { selectedProtocol: 1, requestedProtocols: 1, bpp: 32, surfaceGraphics: true },
        send: b => queueMicrotask(() => peer.receive(b)), emit: e => events.push(e) });
    session.start(); await turns();
    peer.surface(surfaceMarker(0, 7)); await turns();
    const palette = new Writer().u16le(2).u16le(0).u32le(256).zeros(768).finish();
    peer.data(2, palette); await turns();
    assert.equal(session.state, 'failed'); assert.equal(state.acks.length, 0);
    assert.ok(events.some(e => e.code === 'SURFACE_PALETTE'));
    session.close(); peer.close();
});

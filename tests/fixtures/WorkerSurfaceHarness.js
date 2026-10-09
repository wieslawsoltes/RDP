import { parentPort } from 'node:worker_threads';
import { LoopbackServer } from '../../packages/lab/LoopbackServer.js';
import { configureSurfacePeer,surfaceBits,surfaceMarker,sampleNsc } from './SurfacePeer.js';
import { scr,slowOrders } from './GdiWire.js';
import { toRgba } from '../../packages/codecs/Pixels.js';
import { concat } from '../../packages/binary/Writer.js';
let socket,peer,state,time=1000,timerId=0,autoReceipt=true,lastFrame=0,transferred=0;
const events=[],receipts=[],wireAcks=[],timers=new Map();
globalThis.onmessage=null;
Object.defineProperty(globalThis,'performance',{value:{timeOrigin:1000000,now:()=>time},configurable:true});
globalThis.setInterval=cb=>{const id=++timerId;timers.set(id,cb);return id;};globalThis.clearInterval=id=>timers.delete(id);
const dispatch=data=>globalThis.onmessage({data});
globalThis.postMessage=(value,transfer=[])=>{
    const copy=structuredClone(value,{transfer});
    if(copy.type==='frame'){
        lastFrame=copy.id;
        for(const c of value.commands)for(const r of c.rectangles||[]){if(r.data.byteLength!==0)throw new Error('Pixel buffer was not transferred');transferred++;}
        events.push({type:'render',id:copy.id,commands:copy.commands.map(c=>({type:c.type,token:c.token,rectangles:c.rectangles?.length,encoding:c.rectangles?.[0]?.encoding,firstPixel:c.rectangles?.length?[...toRgba(c.rectangles[0]).subarray(0,4)]:null}))});
        if(autoReceipt)queueMicrotask(()=>dispatch({type:'frame-ack',id:copy.id}));
        else receipts.push(copy.id);
    }else events.push(copy);
};
globalThis.WebSocket=class{
    constructor(){socket=this;this.readyState=0;this.bufferedAmount=0;this.closes=0;
        peer=new LoopbackServer({requestedProtocols:1,send:b=>{const owned=b.slice();queueMicrotask(()=>this.onmessage?.({data:owned.buffer}));}});state=configureSurfacePeer(peer);
        queueMicrotask(()=>{this.readyState=1;this.onopen?.();});
    }
    control(v){queueMicrotask(()=>this.onmessage?.({data:JSON.stringify(v)}));}
    send(v){if(typeof v==='string'){
        const m=JSON.parse(v);if(m.type==='connect')this.control({type:'ready',selectedProtocol:1,requestedProtocols:1,inputWindow:65536});
        else if(m.type==='ping')this.control({type:'pong',id:m.id});else if(m.type==='ack')wireAcks.push(m.bytes);
    }else{const b=v.slice();queueMicrotask(()=>{peer.receive(b);this.control({type:'input-ack',bytes:b.length});});}}
    close(){this.closes++;this.readyState=3;}
};
await import('../../apps/client/session-worker.js');
const drain=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setTimeout(r,1));};
let serial=Promise.resolve();
parentPort.on('message',command=>{serial=serial.then(async()=>{
    const {id,op,value}=command;
    try{
        if(op==='start')dispatch({type:'start',mode:'remote',url:'ws://127.0.0.1:8787/bridge',token:'test-token-0123456789abcdef',password:'test',
            options:{surfaceGraphics:true,surfaceQuality:'balanced',bpp:32,resize:false,security:'tls',orders:value===true}});
        else if(op==='begin')peer.surface(concat(surfaceMarker(0,value),surfaceBits()));
        else if(op==='end')peer.surface(surfaceMarker(1,value));
        else if(op==='frame')peer.surface(concat(surfaceMarker(0,value),surfaceBits({width:71,height:15,data:sampleNsc({width:71,height:15})}),surfaceMarker(1,value)));
        else if(op==='copy')peer.data(2,slowOrders(scr(100,100,7,5,0xcc,0,0)));
        else if(op==='hold')autoReceipt=!value;
        else if(op==='receipt')dispatch({type:'frame-ack',id:value});
        else if(op==='reactivate')peer.reactivateSurface();
        else if(op==='tick'){time=value;for(const cb of [...timers.values()])cb();}
        else if(op==='close')dispatch({type:'close'});
        else if(op!=='inspect')throw new Error('Unknown surface harness command');
        await drain();parentPort.postMessage({id,events:events.splice(0),acks:[...state.acks],wireAcks:[...wireAcks],receipts:[...receipts],
            lastFrame,transferred,timers:timers.size,closes:socket.closes});
    }catch(error){parentPort.postMessage({id,error:error.stack});}
});});
parentPort.postMessage({ready:true});

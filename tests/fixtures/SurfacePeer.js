import assert from 'node:assert/strict';
import { Reader } from '../../packages/binary/Reader.js';
import { Writer, concat } from '../../packages/binary/Writer.js';
import { parseSendData } from '../../packages/protocol/Mcs.js';
import { parseShare, parseShareData, shareControl } from '../../packages/protocol/Share.js';
import { clientCapabilities, capability } from '../../packages/protocol/Capabilities.js';

export const surfaceMarker = (action,id) => new Writer().u16le(4).u16le(action).u32le(id).finish();
export function surfaceBits({ type=1, x=0,y=0,width=7,height=5,bpp=32,codec=1,data=sampleNsc(),extra=false,
    drawWidth=width,drawHeight=height }={}) {
    return new Writer().u16le(type).u16le(x).u16le(y).u16le(x+drawWidth).u16le(y+drawHeight)
        .u8(bpp).u8(+extra).u8(0).u8(codec).u16le(width).u16le(height).u32le(data.length)
        .put(extra?new Uint8Array(24):new Uint8Array()).put(data).finish();
}
// Forward encoder is test-only and deliberately separate from the decoder.
export function encodeNsTestPlane(plain) {
    if(plain.length<=4)return plain.slice();
    const w=new Writer();const end=plain.length-4;
    for(let at=0;at<end;) {
        let count=1;while(at+count<end&&plain[at+count]===plain[at])count++;
        if(count>=2) {
            w.u8(plain[at]).u8(plain[at]);
            if(count<257)w.u8(count-2);else w.u8(255).u32le(count);
        } else w.u8(plain[at]);
        at+=count;
    }
    w.put(plain.subarray(end));const encoded=w.finish();return encoded.length<plain.length?encoded:plain.slice();
}
export function sampleNsc({width=7,height=5,subsampled=true,alpha=true,loss=3,rle=true}={}) {
    const stride=subsampled?Math.ceil(width/8)*8:width;
    const chromaStride=subsampled?stride/2:width,chromaHeight=subsampled?Math.ceil(height/2):height;
    const planes=[new Uint8Array(stride*height),new Uint8Array(chromaStride*chromaHeight),new Uint8Array(chromaStride*chromaHeight),new Uint8Array(alpha?width*height:0)];
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) planes[0][y*stride+x]=50+(x*3+y*9)%140;
    for(let i=0;i<planes[1].length;i++){planes[1][i]=(i%9)-4;planes[2][i]=(i%5)-2;}
    planes[3].fill(17); // Desktop output is opaque, not transparent.
    const encoded=planes.map(p=>rle?encodeNsTestPlane(p):p),w=new Writer();
    for(const p of encoded)w.u32le(p.length);w.u8(loss).u8(+subsampled).u16le(0);for(const p of encoded)w.put(p);
    return w.finish();
}
export function expectedNsPixel(x,y,{height=5,subsampled=true,width=7,loss=3,sourceBpp=32}={}) {
    const row=height-1-y,cs=subsampled?Math.ceil(width/8)*4:width;
    const at=(subsampled?row>>>1:row)*cs+(subsampled?x>>>1:x);
    const signed=v=>{const n=(((v+256)%256)*2**loss)%512;return (n>=256?n-512:n)/2;};
    const co=signed(at%9-4),cg=signed(at%5-2),luma=50+(x*3+row*9)%140;
    const clip=v=>Math.min(255,Math.max(0,v));
    const r=clip(luma+co-cg),b=clip(luma-co-cg);
    return [sourceBpp===24?b:r,clip(luma+cg),sourceBpp===24?r:b,255];
}
/** Co-developed independent field writer, not a Windows conformance oracle. */
export function configureSurfacePeer(peer,{onAck=()=>{},onConfirm=()=>{}}={}) {
    const state={acks:[],confirms:0,profile:null};
    peer.demandActive=()=>{
        const caps=clientCapabilities({width:peer.width,height:peer.height,bpp:32});
        caps.push(capability(28,new Writer().u32le(0x52).u32le(0).finish()),
            capability(29,new Writer().u8(1).put(Uint8Array.of(0xb9,0x1b,0x8d,0xca,15,0,0x4f,0x15,0x58,0x9f,0xae,0x2d,0x1a,0x87,0xe2,0xd6))
                .u8(42).u16le(3).u8(1).u8(1).u8(7).finish()),capability(30,new Uint8Array(4)));
        const all=concat(...caps),source=Uint8Array.of(76,65,66,0);
        peer.indication(peer.ioChannel,shareControl(1,peer.serverId,new Writer().u32le(peer.shareId).u16le(source.length)
            .u16le(all.length+4).put(source).u16le(caps.length).u16le(0).put(all).u32le(0).finish()));
    };
    const packet=peer.packet.bind(peer);
    peer.packet=bytes=>{
        let handled=false;
        if(bytes[0]===0x64) {
            const {channelId,data}=parseSendData(bytes,false);
            if(channelId===peer.ioChannel&&!(data[0]===0x40&&data[1]===0&&data[2]===0&&data[3]===0)) {
                parseShare(data,(type,_source,body)=>{
                    if(type===3) {
                        const r=new Reader(body);r.u32le();r.u16le();const n=r.u16le(),length=r.u16le();r.skip(n);
                        const c=r.sub(length),count=c.u16le();c.u16le();const map=new Map();
                        for(let i=0;i<count;i++){const t=c.u16le(),l=c.u16le();map.set(t,c.take(l-4));}c.end();r.end();
                        state.confirms++;state.profile=null;
                        if(map.has(28)) {
                            assert.equal(new Reader(map.get(28)).u32le(),0x52);assert.equal(new Reader(map.get(30)).u32le(),2);
                            const nsc=new Reader(map.get(29));assert.equal(nsc.u8(),1);nsc.skip(16);assert.equal(nsc.u8(),1);assert.equal(nsc.u16le(),3);
                            state.profile={fidelity:nsc.u8(),sampling:nsc.u8(),loss:nsc.u8()};nsc.end();
                        }
                        onConfirm(state.profile);
                    }
                    if(type===7){const p=parseShareData(body);if(p.type===56){const r=new Reader(p.data),id=r.u32le();r.end();
                        state.acks.push(id);onAck(id);handled=true;peer.advertiseClipboard();}}
                });
            }
        }
        if(!handled)packet(bytes);
    };
    peer.surface=bytes=>{
        // Split the surface UPDATE across fast-path fragments, independently of
        // TCP/WebSocket chunking. A command may itself cross these boundaries.
        for(let at=0;at<bytes.length;at+=997) {
            const size=Math.min(997,bytes.length-at),fragment=bytes.length<=997?0:at===0?2:at+size===bytes.length?1:3;
            const data=new Writer().u8(4|(fragment<<4)).u16le(size).put(bytes.subarray(at,at+size)).finish();
            const length=data.length+3;
            peer.send(new Writer().u8(0).u8(0x80|(length>>>8)).u8(length&255).put(data).finish());
        }
    };
    peer.reactivateSurface=()=>{
        peer.state='activating';peer.indication(peer.ioChannel,shareControl(6,peer.serverId,new Writer().u32le(peer.shareId).u16le(0).finish()));peer.demandActive();
    };
    return state;
}

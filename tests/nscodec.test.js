import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeNsPlane, decodeNsCodec, nsCodecLayout, nsCodecToRgba, validateNsBitmap } from '../packages/codecs/NsCodec.js';
import { Writer } from '../packages/binary/Writer.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';

const bytes = (...v) => Uint8Array.from(v);
const stream = (planes, loss = 1, sampling = 0) => {
    const w = new Writer(); for (const p of planes) w.u32le(p.length);
    w.u8(loss).u8(sampling).u16le(0); for (const p of planes) w.put(Uint8Array.from(p)); return w.finish();
};
const plane = (encoded, size) => { const out = new Uint8Array(size); decodeNsPlane(Uint8Array.from(encoded), out); return out; };
// Test-only independent forward RLE encoder. Never used in the client.
function encodePlane(raw) {
    if (raw.length < 5) return raw;
    const end = raw.length - 4, result = [];
    for (let at = 0; at < end;) {
        const start = at++, value = raw[start]; while (at < end && raw[at] === value) at++;
        const count = at - start;
        if (count === 1) result.push(value);
        else if (count <= 256) result.push(value, value, count - 2);
        else result.push(value, value, 255, count & 255, (count >>> 8) & 255, (count >>> 16) & 255, count >>> 24);
    }
    result.push(...raw.slice(-4)); return result.length < raw.length ? result : raw;
}

test('NSCodec RLE matches the published 27-character plane example', () => {
    const encoded = [65,66,67,68,68,1,84,84,2,71,70,82,82,9,65,66,67,68];
    assert.equal(new TextDecoder().decode(plane(encoded, 27)), 'ABCDDDTTTTGFRRRRRRRRRRRABCD');
});
test('NSCodec equal-length planes are raw, even when bytes resemble run controls', () => {
    assert.deepEqual([...plane([9,9,255,0,0,0,0], 7)], [9,9,255,0,0,0,0]);
    for (let n = 1; n <= 4; n++) assert.deepEqual(plane(Array(n).fill(8), n), new Uint8Array(n).fill(8));
});
test('NSCodec run factors, 256-byte boundary and 32-bit lengths retain EndData', () => {
    for (let count = 4; count <= 256; count++) {
        const out = plane([12,12,count-2,12,12,12,12], count + 4); assert.ok(out.every(v => v === 12));
    }
    for (const count of [257, 65536]) {
        const wire = [23,23,255,count & 255,(count >>> 8) & 255,(count >>> 16) & 255,count >>> 24,1,2,3,4];
        const out = plane(wire, count + 4); assert.ok(out.subarray(0, count).every(v => v === 23));
        assert.deepEqual([...out.slice(-4)], [1,2,3,4]);
    }
});
test('NSCodec final literals are distinct from the four untouched tail bytes', () => {
    assert.deepEqual([...plane([1,1,5,2,2,2,2,2], 12)], [1,1,1,1,1,1,1,2,2,2,2,2]);
});
test('NSCodec rejects run overflow, missing tails, underflow and aliased output', () => {
    for (const [encoded, size] of [[[1,1,255,255,255,255,255,1,2,3,4],32], [[1,1,255,0,0,0,0,1,2,3,4],32],
        [[1,1,9,1,2,3,4], 12], [[1,1,0,1,2,3,4],12], [[1,1,255,1,2,3,4],32], [[1,2,3,4],12], [[],12]]) {
        const out = new Uint8Array(size); assert.throws(() => decodeNsPlane(bytes(...encoded), out), ProtocolError);
        assert.ok(out.every(v => !v));
    }
    const shared = new Uint8Array(8); assert.throws(() => decodeNsPlane(shared, shared), ProtocolError);
});
test('NSCodec padded geometry rounds luma to eight, chroma height to two, but never alpha', () => {
    assert.deepEqual(nsCodecLayout(3,3,true,true), { stride:8, chromaStride:4, ySize:24, cSize:8, alphaOffset:40, bytes:49 });
    assert.equal(nsCodecLayout(3,3,false,true).bytes, 36);
});
test('NSCodec odd subsampling ignores padding and preserves selected alpha/orientation', () => {
    const y = [10,20,30,255,255,255,255,255,40,50,60,255,255,255,255,255,70,80,90,255,255,255,255,255];
    const b = decodeNsCodec(stream([y,[2,4,99,99,6,8,99,99],[0,0,99,99,0,0,99,99],[1,2,3,4,5,6,7,8,9]],1,1),3,3);
    const top = nsCodecToRgba(b, undefined, true);
    assert.deepEqual([...top.slice(0,12)], [76,70,64,7,86,80,74,8,98,90,82,9]);
    assert.deepEqual([...top.slice(-12)], [12,10,8,1,22,20,18,2,34,30,26,3]);
    assert.ok([...nsCodecToRgba(b)].filter((_,i) => i%4 === 3).every(v => v === 255));
});
test('NSCodec nine-bit chroma conversion matches independent arithmetic for all bytes/loss levels', () => {
    const clamp = v => Math.min(255,Math.max(0,v));
    const signed9 = (v,loss) => { const n = v * 2 ** loss % 512; return n >= 256 ? n - 512 : n; };
    for (let loss = 1; loss <= 7; loss++) for (let co = 0; co <= 255; co++) {
        const cg = (co * 73 + 19) % 256, luma = 120;
        const a = signed9(co,loss)/2, b = signed9(cg,loss)/2;
        const bitmap = decodeNsCodec(stream([[luma],[co],[cg],[]],loss),1,1);
        assert.deepEqual([...nsCodecToRgba(bitmap)], [clamp(luma+a-b),clamp(luma+b),clamp(luma-a-b),255]);
    }
});
test('NSCodec raw and RLE forms match across all small dimension/padding/alpha combinations', () => {
    for (const width of [1,2,3,7,8,9,15,16,17,31]) for (const height of [1,2,3,9]) for (const sub of [false,true]) for (const alpha of [false,true]) {
        const l = nsCodecLayout(width,height,sub,alpha);
        const planes = [l.ySize,l.cSize,l.cSize,alpha ? width*height : 0].map((n,c) => Array.from({length:n},(_,i) => (c*31+Math.floor(i/17)*3)%256));
        assert.deepEqual(decodeNsCodec(stream(planes,2,+sub),width,height), decodeNsCodec(stream(planes.map(encodePlane),2,+sub),width,height));
    }
});
test('NSCodec sourceBpp=24 corrects red/blue without using alpha omission as a depth hint', () => {
    const input = stream([[100],[10],[5],[]]);
    assert.deepEqual([...nsCodecToRgba(decodeNsCodec(input,1,1))], [105,105,85,255]);
    assert.deepEqual([...nsCodecToRgba(decodeNsCodec(input,1,1,{sourceBpp:24}))], [85,105,105,255]);
});
test('NSCodec owns one transferable buffer, rejects forged descriptors and clears failed decode', () => {
    const input = stream([[100],[10],[5],[]]), bitmap = decodeNsCodec(input,1,1);
    input.fill(0); assert.deepEqual([...bitmap.data], [100,10,5]);
    for (const change of [{stride:2},{data:bytes(1,2)},{alpha:true},{colorLossLevel:0},{sourceBpp:8},{bottomUp:'yes'},{subsampled:1}])
        assert.throws(() => validateNsBitmap({...bitmap,...change}), ProtocolError);
    assert.throws(() => nsCodecToRgba(bitmap,new Uint8Array(3)), ProtocolError);
    const copy = structuredClone(bitmap,{transfer:[bitmap.data.buffer]}); assert.equal(bitmap.data.length,0); assert.equal(copy.data.length,3);
});
test('NSCodec rejects every truncated prefix, oversized/zero plane and unnegotiated loss/subsampling', () => {
    const input = stream([Array(16).fill(9),Array(16).fill(0),Array(16).fill(0),[]]);
    for (let n=0;n<input.length;n++) assert.throws(() => decodeNsCodec(input.subarray(0,n),4,4), ProtocolError);
    for (const loss of [0,8,255]) assert.throws(() => decodeNsCodec(stream([[1],[2],[3],[]],loss),1,1), ProtocolError);
    assert.throws(() => decodeNsCodec(stream([[1],[2],[3],[]],2),1,1,{maxColorLoss:1}), ProtocolError);
    assert.throws(() => decodeNsCodec(stream([Array(8).fill(1),Array(4).fill(2),Array(4).fill(3),[]],1,1),1,1,{allowSubsampling:false}), ProtocolError);
    for (const size of [0,-1,0.5,8193,Infinity,NaN]) assert.throws(() => decodeNsCodec(input,size,1), ProtocolError);
    assert.throws(() => decodeNsCodec(input,8192,8192), ProtocolError);
    assert.throws(() => decodeNsCodec(input,4,4,{maxDecodedBytes:47}), ProtocolError);
    assert.throws(() => decodeNsCodec(stream([[],[1],[2],[]]),1,1), ProtocolError);
});
test('NSCodec 100000 deterministic malformed inputs yield only controlled parser errors', t => {
    let seed=0x4e534330, accepted=0, rejected=0;
    const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
    for(let i=0;i<100000;i++) {
        const w=1+random()%16,h=1+random()%16,n=random()%512;
        const input=Uint8Array.from({length:n},()=>random()&255);
        if(n>=20 && i%4===0) {
            const d=new DataView(input.buffer);for(let k=0;k<4;k++)d.setUint32(k*4,random()%65,true);
            input[16]=1+random()%7;input[17]=random()%2;
        }
        try { const b=decodeNsCodec(input,w,h); assert.equal(nsCodecToRgba(b).length,w*h*4);accepted++; }
        catch(e){assert.ok(e instanceof ProtocolError,`${i}: ${e.stack}`);rejected++;}
    }
    t.diagnostic(JSON.stringify({rounds:100000,accepted,rejected,unexpected:0}));
});

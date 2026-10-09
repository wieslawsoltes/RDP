import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Reader } from '../packages/binary/Reader.js';
import { Writer } from '../packages/binary/Writer.js';
import { createSurface, blit } from '../packages/render/gdi/Raster.js';
import { GdiOrders } from '../packages/render/gdi/Orders.js';
const results = [];
function measure(name, count, pixels, operation) {
    for (let i=0; i<5; i++) operation();
    const samples=[];
    for (let pass=0; pass<5; pass++) {
        const start=performance.now();
        for(let i=0;i<count;i++) operation();
        samples.push((performance.now()-start)/count);
    }
    samples.sort((a,b)=>a-b);
    results.push({name,iterationsPerPass:count,medianMs:samples[2],megaPixelsPerSecond:pixels/1000/samples[2],samplesMs:samples});
}
const width=1920,height=1080,surface=createSurface(width,height),pattern=new Uint32Array(64).fill(0x123456);
measure('1920x1080 solid fill, reusable raster storage',100,width*height,()=>blit(surface,{x:0,y:0,width,height},{code:0xf0,pattern}));
measure('1920x1079 overlap-safe same-surface copy',100,width*(height-1),()=>blit(surface,{x:0,y:1,width,height:height-1},{source:surface,code:0xcc,sx:0,sy:0}));
pattern.set(Uint32Array.from({length:64},(_,i)=>i*238717));
measure('512x512 patterned destination XOR',30,512*512,()=>blit(surface,{x:0,y:0,width:512,height:512},{code:0x5a,pattern}));
const gdi=new GdiOrders({width,height});
const encoded=(w,h)=>new Writer().u8(9).u8(10).u8(127).u16le(0).u16le(0).u16le(w).u16le(h).u8(18).u8(52).u8(86).finish();
const full=encoded(width,height),sparse=encoded(1,1);
measure('1920x1080 OpaqueRect decode, rasterize, damage extraction; output allocated',10,width*height,()=>gdi.receive(new Reader(full),1));
measure('1x1 OpaqueRect decode and tight damage extraction on 1080p desktop',1000,1,()=>gdi.receive(new Reader(sparse),1));
const dirty=gdi.receive(new Reader(sparse),1); const sparseBytes=dirty.reduce((n,r)=>n+r.data.byteLength,0);
gdi.close();surface.pixels.fill(0);
const report={date:new Date().toISOString(),node:process.version,platform:`${os.platform()} ${os.arch()}`,cpu:os.cpus()[0]?.model,
    scope:'Local CPU microbenchmarks only. No remote throughput, Windows interoperability, GPU or interactive frame-rate claim.',sparseUploadBytes:sparseBytes,results};
mkdirSync('test-results',{recursive:true});writeFileSync('test-results/gdi-benchmarks.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));

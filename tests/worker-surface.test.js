import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
async function harness(t){
    const worker=new Worker(new URL('./fixtures/WorkerSurfaceHarness.js',import.meta.url));t.after(()=>worker.terminate());
    assert.equal((await once(worker,'message'))[0].ready,true);let next=0;
    const call=async(op,value)=>{const promise=once(worker,'message'),id=++next;worker.postMessage({id,op,value});
        const [r]=await promise;assert.equal(r.id,id);assert.equal(r.error,undefined,r.error);return r;};
    const first=await call('start');assert.ok(first.events.some(e=>e.type==='state'&&e.state==='active'));return call;
}
test('Actual worker transfers packed NSCodec once and sends RDP frame ACK only on a matching UI receipt',{timeout:5000},async t=>{
    const call=await harness(t);await call('hold',true);const r=await call('frame',700);
    assert.deepEqual(r.acks,[]);const frame=r.events.find(e=>e.type==='render'&&e.commands.some(c=>c.type==='surface-frame'));
    assert.ok(frame);assert.equal(frame.commands[0].encoding,'nscodec');assert.equal(r.transferred,1);
    assert.deepEqual((await call('receipt',700)).acks,[]);
    assert.deepEqual((await call('receipt',frame.id)).acks,[700]);assert.deepEqual((await call('receipt',frame.id)).acks,[700]);
});
test('Gateway wire credits keep flowing while an incomplete surface frame is held',{timeout:5000},async t=>{
    const call=await harness(t),before=await call('inspect');const r=await call('begin',20);
    assert.deepEqual(r.acks,[]);assert.equal(r.events.some(e=>e.type==='render'&&e.commands.some(c=>c.type==='surface-frame')),false);
    assert.ok(r.wireAcks.length>before.wireAcks.length);assert.equal(r.transferred,0);
    const end=await call('end',20);assert.deepEqual(end.acks,[20]);assert.equal(end.transferred,1);
});
test('Actual worker keeps two render batches in flight and drains queued frames after receipts',{timeout:5000},async t=>{
    const call=await harness(t);await call('hold',true);const a=await call('frame',10),b=await call('frame',11),c=await call('frame',12);
    assert.equal(c.receipts.length,2);assert.deepEqual(c.acks,[]);assert.equal(c.transferred,2);
    const next=await call('receipt',a.receipts[0]);assert.equal(next.transferred,3);assert.deepEqual(next.acks,[10]);
    await call('receipt',b.receipts[1]);const done=await call('receipt',next.receipts[2]);assert.deepEqual(done.acks,[10,11,12]);
});
test('Actual worker reactivation discards old surface receipt tokens',{timeout:5000},async t=>{
    const call=await harness(t);await call('hold',true);const old=await call('frame',88);await call('reactivate');
    assert.deepEqual((await call('receipt',old.lastFrame)).acks,[]);await call('hold',false);
    const r=await call('inspect');for(const id of r.receipts)await call('receipt',id);
    const next=await call('frame',88);assert.deepEqual(next.acks,[88]);
});
test('Actual worker unfinished surface deadline closes transport and invalidates late receipts',{timeout:5000},async t=>{
    const call=await harness(t);await call('begin',19);const expired=await call('tick',16000);
    assert.ok(expired.events.some(e=>e.type==='error'&&e.code==='SURFACE_FRAME_TIMEOUT'));
    assert.equal(expired.timers,0);assert.equal(expired.closes,1);assert.deepEqual(expired.acks,[]);
    assert.deepEqual((await call('receipt',19)).acks,[]);
});

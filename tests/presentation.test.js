import test from 'node:test';
import assert from 'node:assert/strict';
import { PresentationQueue } from '../packages/render/PresentationQueue.js';
const deferred=()=>{let resolve,reject;return {promise:new Promise((a,b)=>{resolve=a;reject=b;}),get resolve(){return resolve;},get reject(){return reject;}};};
const turns=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setImmediate(r));};
function fixture(extra={}) {
    const acks=[],errors=[],frames=new Map(),signals=[];let next=0;
    const q=new PresentationQueue({acknowledge:id=>acks.push(id),fail:e=>errors.push(e),
        requestFrame:cb=>{frames.set(++next,cb);return next;},cancelFrame:id=>frames.delete(id),...extra});
    const fence=()=>{const d=deferred();return {...d,whenComplete:signal=>{signals.push(signal);return d.promise;}};};
    const paint=()=>{const callbacks=[...frames.values()];frames.clear();for(const cb of callbacks)cb();};
    return {q,acks,errors,frames,signals,fence,paint};
}
test('Presentation receipt waits for GPU completion AND following animation-frame opportunity',async()=>{
    const h=fixture(),r=h.fence();h.q.submit(1,r);assert.equal(h.signals.length,1);h.paint();assert.deepEqual(h.acks,[]);
    r.resolve();await turns();assert.deepEqual(h.acks,[]);h.paint();assert.deepEqual(h.acks,[1]);h.q.close();
});
test('Out-of-order fences cannot overtake earlier presentation receipts',async()=>{
    const h=fixture(),a=h.fence(),b=h.fence();h.q.submit(1,a);h.q.submit(2,b);
    b.resolve();await turns();h.paint();assert.deepEqual(h.acks,[]);
    a.resolve();await turns();h.paint();assert.deepEqual(h.acks,[1,2]);h.q.close();
});
test('Surface presentation receipts reject duplicate IDs and bound outstanding owners to two',()=>{
    const h=fixture();h.q.submit(1,h.fence());assert.throws(()=>h.q.submit(1,h.fence()));h.q.submit(2,h.fence());
    assert.throws(()=>h.q.submit(3,h.fence()));assert.throws(()=>h.q.submit(0,h.fence()));h.q.close();assert.equal(h.q.pending.size,0);
});
test('Close cancels fences/animation requests; late completion cannot acknowledge',async()=>{
    for(const resolved of [false,true]) {
        const h=fixture(),r=h.fence();h.q.submit(1,r);if(resolved){r.resolve();await turns();}
        h.q.close();h.q.close();r.resolve();await turns();h.paint();assert.deepEqual(h.acks,[]);assert.deepEqual(h.errors,[]);
        assert.equal(h.frames.size,0);assert.equal(h.signals[0].aborted,true);
    }
});
test('Rejected and synchronously failing GPU fences close every pending receipt without false ACK',async()=>{
    for(const sync of [false,true]) {
        const h=fixture(),a=h.fence();h.q.submit(1,a);
        if(sync)h.q.submit(2,{whenComplete(){throw new Error('device lost');}});
        else {const b=h.fence();h.q.submit(2,b);b.reject(new Error('device lost'));}
        await turns();a.resolve();await turns();h.paint();assert.deepEqual(h.acks,[]);assert.equal(h.errors.length,1);assert.equal(h.q.closed,true);
    }
});
test('Renderer deadline fails closed even when its completion promise never settles',async()=>{
    const h=fixture({timeoutMs:10});h.q.submit(1,h.fence());await new Promise(r=>setTimeout(r,30));
    assert.equal(h.errors.length,1);assert.equal(h.q.pending.size,0);assert.deepEqual(h.acks,[]);
});
test('Acknowledgement callback failures cancel all remaining receipts',async()=>{
    const h=fixture({acknowledge(){throw new Error('worker gone');}}),a=h.fence(),b=h.fence();h.q.submit(1,a);h.q.submit(2,b);
    a.resolve();b.resolve();await turns();h.paint();assert.equal(h.errors.length,1);assert.equal(h.q.closed,true);assert.equal(h.q.pending.size,0);
});

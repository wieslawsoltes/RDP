import test from 'node:test';
import assert from 'node:assert/strict';
import { MppcDecoder } from '../packages/codecs/Mppc.js';
import { mppcFixture } from './helpers/MppcFixture.js';
const text = bytes => new TextDecoder().decode(bytes);
for (const type of [0,1]) {
    const flags = 0xa0 | type;
    test(`MPPC ${type}: all 256 literals and owned output`, () => {
        const d = new MppcDecoder(), expected = Uint8Array.from({length:256},(_,i)=>i);
        const actual = d.decode(mppcFixture([...expected],type),flags);
        assert.deepEqual(actual,expected);
        d.decode(mppcFixture(['overwritten'],type),flags);
        assert.deepEqual(actual,expected);
    });
    test(`MPPC ${type}: published text and replicating-copy examples`, () => {
        const d = new MppcDecoder();
        assert.equal(text(d.decode(mppcFixture(['for.whom.the.bell.tolls,',[16,15],'.',[40,4],[19,3],'e!'],type),flags)),
            'for.whom.the.bell.tolls,.the.bell.tolls.for.thee!');
        assert.equal(text(d.decode(mppcFixture(['Xcd',[2,4],'YZ'],type),flags)), 'XcdcdcdYZ');
    });
    test(`MPPC ${type}: history, raw packets, front and flush`, () => {
        const d = new MppcDecoder();
        d.decode(mppcFixture(['abc'],type),flags);
        assert.equal(text(d.decode(Uint8Array.of(88),type)),'X');
        assert.equal(text(d.decode(mppcFixture([[3,6]],type),0x20|type)),'abcabc');
        const size = type ? 65536 : 8192;
        assert.equal(text(d.decode(mppcFixture([[size-3,3]],type),0x60|type)), 'abc');
        assert.deepEqual(d.decode(mppcFixture([[0,3]],type),flags),new Uint8Array(3));
        assert.deepEqual(d.decode(mppcFixture([[3,3]],type),flags),new Uint8Array(3));
    });
    test(`MPPC ${type}: every offset boundary`, () => {
        const size=type?65536:8192;
        for(const offset of [0,1,63,64,319,320,...(type?[2367,2368,65535]:[8191])]){
            const d=new MppcDecoder(); d.type=type; d.offset=size-4;
            for(let i=0;i<size;i++) d.history[i]=(i*31+7)&255;
            const expected=[]; const model=d.history.slice();
            for(let i=0;i<3;i++){const p=size-4+i;model[p]=model[(p-offset)&(size-1)];expected.push(model[p]);}
            assert.deepEqual([...d.decode(mppcFixture([[offset,3]],type),0x20|type)],expected,`offset ${offset}`);
        }
    });
    test(`MPPC ${type}: every match-length code range`, () => {
        const max=type?15:12;
        for(const n of Array.from({length:max-1},(_,i)=>i+2)) for(const length of [2**n,2**(n+1)-1]) {
            const d=new MppcDecoder(), result=d.decode(mppcFixture([[0,length]],type),flags);
            assert.equal(result.length,length); assert.ok(result.every(x=>x===0));
        }
    });
    test(`MPPC ${type}: output budget, corrupt token, padding and recovery`, () => {
        const d=new MppcDecoder();
        assert.throws(()=>d.decode(mppcFixture(['a',[1,6]],type),flags,5),{code:'MPPC_LIMIT'});
        assert.throws(()=>d.decode(mppcFixture(['ok'],type),0x20|type),{code:'MPPC_HISTORY'});
        assert.equal(text(d.decode(mppcFixture(['ok'],type),flags)),'ok');
        assert.throws(()=>d.decode(Uint8Array.of(0xff),flags),{code:'MPPC_TRUNCATED'});
        const bytes=mppcFixture([128],type); bytes[bytes.length-1]|=1;
        assert.throws(()=>d.decode(bytes,flags),{code:'MPPC_PADDING'});
        d.reset();assert.ok(d.history.every(x=>!x));
    });
}
test('MPPC rejects unadvertised codecs, reserved flags and unsafe limits',()=>{
    const d=new MppcDecoder();
    for(const flags of [0x22,0x23,0x30,256,-1,NaN]) assert.throws(()=>d.decode(new Uint8Array(),flags));
    for(const limit of [-1,NaN,Infinity,1.5]) assert.throws(()=>d.decode(new Uint8Array(),0,limit));
    d.decode(mppcFixture(['a'],0),0xa0);
    assert.throws(()=>d.decode(mppcFixture(['b'],1),0x21),{code:'MPPC_HISTORY'});
    assert.equal(text(d.decode(mppcFixture(['b'],1),0xa1)),'b');
});

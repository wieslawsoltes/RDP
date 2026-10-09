import test from 'node:test';
import assert from 'node:assert/strict';
import { rop3, dependsOn, createSurface, DirtyTiles, blit, bitmapPixels } from '../packages/render/gdi/Raster.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
const oracle = (rop, d, s, p) => {
    let v = 0;
    for (let bit = 0; bit < 24; bit++) v |= ((rop >>> ((((p >>> bit) & 1) << 2) | (((s >>> bit) & 1) << 1) | ((d >>> bit) & 1))) & 1) << bit;
    return v;
};
test('All 256 ROP3 tables match an independent per-bit oracle', () => {
    for (let r = 0; r < 256; r++) for (const [d, s, p] of [[0xaaaaaa, 0xcccccc, 0xf0f0f0], [0x73a923, 0x2bb74f, 0xe062f1]])
        assert.equal(rop3(r, d, s, p), oracle(r, d, s, p), `rop=${r}`);
    assert.equal(dependsOn(0xcc, 4), false); assert.equal(dependsOn(0xcc, 2), true);
});
test('Screen overlaps preserve original source for every source/destination ROP in every direction', () => {
    for (let r = 0; r < 256; r++) if (!dependsOn(r, 4)) {
        for (const [x, y, sx, sy] of [[1, 0, 0, 0], [0, 0, 1, 0], [0, 1, 0, 0], [0, 0, 0, 1], [1, 1, 0, 0]]) {
            const surface = createSurface(5, 5); surface.pixels.set(Array.from({ length: 25 }, (_, i) => i * 33171));
            const original = surface.pixels.slice(), expected = original.slice();
            for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 4; xx++) expected[(y + yy) * 5 + x + xx] = oracle(r, original[(y + yy) * 5 + x + xx], original[(sy + yy) * 5 + sx + xx], 0);
            blit(surface, { x, y, width: 4, height: 4 }, { source: surface, sx, sy, code: r });
            assert.deepEqual(surface.pixels, expected, `rop=${r} x=${x} y=${y}`);
        }
    }
});
test('Bounds clip inclusively and adjust the source from the original destination', () => {
    const dst = createSurface(5, 5), source = createSurface(5, 5); source.pixels.set(Array.from({ length: 25 }, (_, i) => i + 1));
    assert.deepEqual(blit(dst, { x: -1, y: -1, width: 5, height: 5 }, { source, bounds: { left: 1, top: 1, right: 2, bottom: 2 } }), { x: 1, y: 1, width: 2, height: 2 });
    assert.equal(dst.pixels[6], 13); assert.equal(dst.pixels[12], 19); assert.equal(dst.pixels[0], 0);
});
test('Pattern origin is anchored to surface, not to the clipped rectangle', () => {
    const s = createSurface(10, 10), p = Uint32Array.from({ length: 64 }, (_, i) => i + 1);
    blit(s, { x: 2, y: 2, width: 4, height: 4 }, { code: 0xf0, pattern: p, orgX: -1, orgY: 1, bounds: { left: 3, top: 3, right: 3, bottom: 3 } });
    assert.equal(s.pixels[33], p[20]);
});
test('Dirty tile output is nonoverlapping, bounded, top down and owned', () => {
    const s = createSurface(130, 70), d = new DirtyTiles(130, 70); s.pixels.fill(0x123456);
    d.mark({ x: 1, y: 1, width: 100, height: 68 }); d.mark({ x: 100, y: 1, width: 30, height: 69 });
    const out = d.take(s); assert.equal(out.length, 1); assert.equal(out[0].data.length, 129 * 69 * 4);
    assert.deepEqual([...out[0].data.slice(0, 4)], [0x56, 0x34, 0x12, 255]); assert.equal(out[0].bottomUp, false);
    s.pixels.fill(0); assert.equal(out[0].data[0], 0x56); assert.equal(d.take(s).length, 0);
});
test('Raster validation rejects unbounded surfaces and invalid source reads', () => {
    assert.throws(() => createSurface(8192, 8192), ProtocolError);
    const s = createSurface(4, 4);
    assert.throws(() => blit(s, { x: 0, y: 0, width: 2, height: 2 }, { source: s, sx: 3 }), ProtocolError);
    assert.throws(() => blit(s, { x: 0, y: 0, width: -1, height: 1 }), ProtocolError);
});
test('Bitmap conversion handles native depth, padding and bottom-up source rows', () => {
    const s = bitmapPixels({ width: 1, height: 2, bpp: 16, stride: 4, data: Uint8Array.of(0, 0xf8, 0, 0, 0xe0, 7, 0, 0) });
    assert.deepEqual([...s.pixels], [0x00ff00, 0xff0000]);
    const p = new Uint32Array(256); p[3] = 0x123456;
    assert.equal(bitmapPixels({ width: 1, height: 1, bpp: 8, stride: 1, data: Uint8Array.of(3) }, p).pixels[0], 0x123456);
});


test('Sparse damage bounds preserve a one-pixel update instead of uploading a full tile', () => {
    const surface = createSurface(200, 200), damage = new DirtyTiles(200, 200);
    damage.mark({ x: 70, y: 90, width: 1, height: 1 });
    const [rect] = damage.take(surface);
    assert.deepEqual([rect.x,rect.y,rect.width,rect.height,rect.data.length], [70,90,1,1,4]);
    damage.mark({ x: 1, y: 1, width: 1, height: 1 }); damage.clear();
    damage.mark({ x: 70, y: 90, width: 1, height: 1 }); assert.equal(damage.take(surface)[0].data.length,4);
});

test('Dirty coalescing covers random bounded marks exactly once without overlapping rectangles', () => {
    const width=257,height=131,surface=createSurface(width,height),damage=new DirtyTiles(width,height),marked=new Uint8Array(width*height);
    let seed=0x3b821; const random=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
    for(let i=0;i<100;i++) {
        const x=random()%width,y=random()%height,w=1+random()%Math.min(12,width-x),h=1+random()%Math.min(9,height-y);
        damage.mark({x,y,width:w,height:h});
        for(let yy=y;yy<y+h;yy++) marked.fill(1,yy*width+x,yy*width+x+w);
    }
    const seen=new Uint8Array(marked.length);
    for(const rect of damage.take(surface)) for(let y=rect.y;y<rect.y+rect.height;y++) for(let x=rect.x;x<rect.x+rect.width;x++) seen[y*width+x]++;
    for(let i=0;i<marked.length;i++) {assert.ok(seen[i]<=1);if(marked[i])assert.equal(seen[i],1);}
});

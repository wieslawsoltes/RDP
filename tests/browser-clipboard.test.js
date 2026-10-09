import test from 'node:test';
import assert from 'node:assert/strict';
import { ClipboardSnapshot, writeBrowserClipboard, readBrowserClipboard } from '../apps/client/BrowserClipboard.js';
import { sanitizeProfile, importRdp } from '../packages/profiles/Profiles.js';

test('Rich clipboard profiles require explicit boolean consent and text-channel enablement', () => {
    for (const richClipboard of [undefined, null, false, 'true', 1, {}]) assert.equal(sanitizeProfile({ richClipboard }).richClipboard, false);
    assert.equal(sanitizeProfile({ richClipboard: true }).richClipboard, true);
    assert.equal(sanitizeProfile({ richClipboard: true, clipboard: false }).richClipboard, false);
    assert.equal(importRdp('redirectclipboard:i:1\nrichClipboard:i:1').profile.richClipboard, false);
});
test('Main-thread clipboard state drops old generations and never evaluates HTML', () => {
    const state = new ClipboardSnapshot();
    state.apply({ kind: 'formats', generation: 2, formats: ['text', 'html', 'image'] });
    assert.equal(state.apply({ kind: 'html', generation: 1, html: 'stale' }), false);
    const html = '<script>throw new Error("must not run")</script>';
    state.apply({ kind: 'html', generation: 2, html }); assert.equal(state.value.html, html);
    state.apply({ kind: 'text', generation: 2, text: 'hello' }); assert.equal(state.value.text, 'hello');
    state.apply({ kind: 'formats', generation: 1, formats: [] }); assert.equal(state.value.text, 'hello');
    state.apply({ kind: 'formats', generation: 3, formats: ['image'] }); assert.deepEqual(state.value, {});
});
test('Main-thread clipboard releases images on replacement, generation change and close', () => {
    const state = new ClipboardSnapshot(), png = Uint8Array.of(1, 2), rgba = Uint8Array.of(3, 4, 5, 6);
    state.apply({ kind: 'formats', generation: 1, formats: ['image'] });
    state.apply({ kind: 'image', generation: 1, encoding: 'png', bytes: png });
    state.apply({ kind: 'image', generation: 1, encoding: 'rgba', width: 1, height: 1, rgba });
    assert.deepEqual([...png], [0, 0]); assert.equal(state.value.png, undefined);
    const before = state.epoch; state.clear();
    assert.ok(rgba.every(v => v === 0)); assert.deepEqual(state.value, {}); assert.deepEqual(state.formats, []); assert.ok(state.epoch > before);
});
test('Browser clipboard adapter refuses to access OS clipboard outside a secure context', async () => {
    assert.throws(() => writeBrowserClipboard({ text: 'test' }), /secure context/);
    await assert.rejects(() => readBrowserClipboard(), /secure context/);
});

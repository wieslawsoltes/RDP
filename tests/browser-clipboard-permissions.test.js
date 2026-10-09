import test from 'node:test';
import assert from 'node:assert/strict';
import { readBrowserClipboard, writeBrowserClipboard } from '../apps/client/BrowserClipboard.js';
import { CLIPBOARD_LIMIT } from '../packages/codecs/ClipboardFormats.js';

function browser(t, clipboard, extra = {}) {
    for (const [key, value] of Object.entries({ isSecureContext: true, navigator: { clipboard }, ...extra })) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
        t.after(() => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]);
    }
}

class Item {
    static supports(type) { return ['text/plain', 'text/html', 'image/png'].includes(type); }
    constructor(data) { this.data = data; }
}

test('Clipboard permission denial is reported without fallback reads or automatic writes', async t => {
    let fallback = 0, writes = 0;
    const denied = new DOMException('Denied by the user', 'NotAllowedError');
    browser(t, { read: async () => { throw denied; }, readText: () => { fallback++; }, write: () => { writes++; } });
    await assert.rejects(readBrowserClipboard(), e => e === denied);
    assert.equal(fallback, 0); assert.equal(writes, 0);
});

test('Clipboard text-only fallback is explicit and bounded', async t => {
    let reads = 0;
    browser(t, { readText: async () => { reads++; return 'Zażółć 🙂'; } });
    assert.deepEqual(await readBrowserClipboard(), { text: 'Zażółć 🙂' });
    assert.equal(reads, 1);
    navigator.clipboard.readText = async () => 'x'.repeat(CLIPBOARD_LIMIT / 2 + 1);
    await assert.rejects(readBrowserClipboard(), /limit/);
});

test('Clipboard read only requests supported MIME types from the first OS item', async t => {
    const requested = [];
    const item = { types: ['text/plain', 'text/html', 'application/secret'], getType: async mime => {
        requested.push(mime); return new Blob([mime === 'text/plain' ? 'hello' : '<b>hello</b>'], { type: mime });
    } };
    browser(t, { read: async () => [item, { get types() { throw new Error('Additional items must not be read'); } }] });
    assert.deepEqual(await readBrowserClipboard(), { text: 'hello', html: '<b>hello</b>' });
    assert.deepEqual(requested, ['text/plain', 'text/html']);
});

test('Clipboard read rejects unsupported, empty and oversized formats before decoding', async t => {
    browser(t, { read: async () => [] });
    await assert.rejects(readBrowserClipboard(), /empty/);
    navigator.clipboard.read = async () => [{ types: ['application/unknown'] }];
    await assert.rejects(readBrowserClipboard(), /no supported/);
    navigator.clipboard.read = async () => [{ types: ['text/html'], getType: async () => ({
        size: CLIPBOARD_LIMIT + 1, text() { throw new Error('Oversized payload must not be decoded'); }
    }) }];
    await assert.rejects(readBrowserClipboard(), /8 MiB/);
});

test('Clipboard write is invoked synchronously, groups formats and preserves inert markup', async t => {
    const calls = [];
    browser(t, { write: items => { calls.push(items); return Promise.resolve(); } }, { ClipboardItem: Item });
    const html = '<img src="https://clipboard.invalid/image"><script>globalThis.executed = true</script>';
    const promise = writeBrowserClipboard({ text: 'hello', html });
    assert.equal(calls.length, 1, 'the browser write must start in the click activation task');
    const data = calls[0][0].data;
    assert.deepEqual(Object.keys(data), ['text/plain', 'text/html']);
    assert.equal(await data['text/html'].text(), html);
    assert.equal(globalThis.executed, undefined);
    await promise;
});

test('Clipboard write never silently drops rich formats when only text writes are available', async t => {
    const calls = [];
    browser(t, { writeText: text => { calls.push(text); return Promise.resolve(); } }, { ClipboardItem: undefined });
    await writeBrowserClipboard({ text: 'plain' });
    assert.throws(() => writeBrowserClipboard({ text: 'plain', html: '<b>rich</b>' }), /does not support rich/);
    assert.deepEqual(calls, ['plain']);
});

test('Clipboard write preserves permission errors and rejects unsupported types before OS write', async t => {
    let writes = 0;
    const denied = new DOMException('Denied', 'NotAllowedError');
    browser(t, { write: () => { writes++; return Promise.reject(denied); } }, { ClipboardItem: Item });
    await assert.rejects(writeBrowserClipboard({ text: 'plain' }), e => e === denied);
    globalThis.ClipboardItem = class extends Item { static supports() { return false; } };
    assert.throws(() => writeBrowserClipboard({ html: '<b>rich</b>' }), /does not support/);
    assert.equal(writes, 1);
});

test('Clipboard write bounds UTF-8 bytes rather than just JavaScript string length', t => {
    browser(t, { write() { throw new Error('Oversized clipboard must not be written'); } }, { ClipboardItem: Item });
    assert.throws(() => writeBrowserClipboard({ html: '🙂'.repeat(CLIPBOARD_LIMIT / 4 + 1) }), /8 MiB/);
    assert.throws(() => writeBrowserClipboard({}), /Fetch a remote format/);
});

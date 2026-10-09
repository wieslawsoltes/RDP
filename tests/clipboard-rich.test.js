import test from 'node:test';
import assert from 'node:assert/strict';
import { ClipboardChannel, clipboardPdu as pdu } from '../packages/channels/ClipboardChannel.js';
import { Reader } from '../packages/binary/Reader.js';
import { Writer, utf16 } from '../packages/binary/Writer.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
import { decodeClipboardHtml, encodeClipboardHtml, encodeClipboardDib, decodeClipboardDib } from '../packages/codecs/ClipboardFormats.js';
import { png } from './fixtures/Clipboard.js';
import { Session } from '../packages/protocol/Session.js';
import { LoopbackServer } from '../packages/lab/LoopbackServer.js';
const image = { width: 1, height: 1, rgba: Uint8Array.of(10, 20, 30, 128) };
const caps = (version = 2, flags = 2) => pdu(7, 0, new Writer().u16le(1).u16le(0).u16le(1).u16le(12).u32le(version).u32le(flags).finish());
function list(entries, long = true, ascii = false) {
    const w = new Writer();
    for (const [id, name = ''] of entries) {
        w.u32le(id);
        if (long) w.put(utf16(name, true));
        else if (ascii) w.ascii(name).zeros(32 - name.length);
        else w.fixedUtf16(name, 32);
    }
    return pdu(2, ascii ? 4 : 0, w.finish());
}
function unpack(bytes) {
    const r = new Reader(bytes), type = r.u16le(), flags = r.u16le(), n = r.u32le();
    return { type, flags, body: r.take(n) };
}
function setup(t, options = {}) {
    const sent = [], events = [];
    const channel = new ClipboardChannel(bytes => sent.push(unpack(bytes)), (kind, value) => events.push({ kind, ...value }), { rich: true, ...options });
    t.after(() => channel.close());
    channel.receive(caps()); channel.receive(pdu(1)); channel.receive(pdu(3, 1));
    return { channel, sent, events, requests: () => sent.filter(p => p.type === 4).map(p => new Reader(p.body).u32le()) };
}
test('Rich CLIPRDR maps names to remote IDs and serializes text, HTML and PNG requests', t => {
    const { channel: c, events, requests } = setup(t);
    c.receive(list([[13], [0xd123, 'HTML Format'], [0xd987, 'PNG']]));
    c.requestFormat('html'); c.requestFormat('image'); c.requestFormat('html');
    assert.deepEqual(requests(), [13]);
    c.receive(pdu(5, 1, utf16('text\r\n🙂', true)));
    assert.deepEqual(requests(), [13, 0xd123]);
    c.receive(pdu(5, 1, encodeClipboardHtml('<b>Zażółć 🙂</b>')));
    assert.deepEqual(requests(), [13, 0xd123, 0xd987]);
    const input = png(); c.receive(pdu(5, 1, input)); input.fill(0);
    assert.equal(events.find(e => e.kind === 'text').text, 'text\n🙂');
    assert.equal(events.find(e => e.kind === 'html').html, '<b>Zażółć 🙂</b>');
    assert.deepEqual(events.find(e => e.kind === 'image').bytes, png());
    assert.equal(c.pending, null); assert.equal(c.requests.length, 0);
});
test('Clipboard version is informational; flags select long names, including version 1', t => {
    for (const [version, flags, ascii] of [[1, 2, false], [999, 2, false], [2, 0, true], [2, 0, false]]) {
        const { channel: c, requests } = setup(t);
        c.receive(caps(version, flags)); c.receive(list([[0xffff, 'HTML Format']], flags === 2, ascii));
        c.requestFormat('html'); assert.deepEqual(requests(), [0xffff]);
        c.receive(pdu(5, 2));
    }
});
test('Rich clipboard remains off by default and never fetches unsupported remote formats', t => {
    const c = new ClipboardChannel(() => {}, () => {}); t.after(() => c.close());
    c.receive(caps()); c.receive(pdu(1)); c.receive(list([[0xc001, 'HTML Format'], [0xc002, 'PNG'], [17], [8]]));
    assert.equal(c.requestFormat('html'), false); assert.equal(c.requestFormat('image'), false);
    assert.throws(() => c.setContent({ html: '<b>x</b>' }), ProtocolError);
    c.setText('still works');
});
test('New clipboard generation consumes obsolete response before making the next request', t => {
    const { channel: c, events, requests } = setup(t);
    c.receive(list([[0xc123, 'HTML Format']])); c.requestFormat('html');
    c.receive(list([[0xc456, 'HTML Format']])); c.requestFormat('html');
    assert.deepEqual(requests(), [0xc123]);
    c.receive(pdu(5, 1, encodeClipboardHtml('stale')));
    assert.equal(events.some(e => e.kind === 'html'), false);
    assert.deepEqual(requests(), [0xc123, 0xc456]);
    c.receive(pdu(5, 1, encodeClipboardHtml('fresh')));
    assert.equal(events.filter(e => e.kind === 'html').length, 1);
    assert.equal(events.at(-1).html, 'fresh');
});
test('Local copy eclipses an outstanding remote response and clears queued requests', t => {
    const { channel: c, events, requests } = setup(t);
    c.receive(list([[13], [0xc123, 'HTML Format']])); c.requestFormat('html');
    c.setContent({ text: 'local', html: '<b>local</b>' });
    c.receive(pdu(5, 1, utf16('obsolete', true)));
    assert.equal(events.some(e => e.kind === 'text'), false);
    assert.deepEqual(requests(), [13]); assert.equal(c.requestFormat('html'), false);
});
test('Outgoing rich snapshots are owned and announcements preserve earlier data until ACK', t => {
    const { channel: c, sent } = setup(t);
    const input = png(); c.setContent({ text: 'old', html: '<b>old</b>', png: input, image }); input.fill(0);
    const previous = c.advertised;
    c.setContent({ text: 'new' });
    for (const id of [13, 0xc001, 0xc002, 17, 8]) {
        c.receive(pdu(4, 0, new Writer().u32le(id).finish()));
        assert.equal(sent.at(-1).flags, 1);
        assert.deepEqual(sent.at(-1).body, previous.get(id));
    }
    assert.equal(decodeClipboardHtml(previous.get(0xc001)), '<b>old</b>');
    assert.deepEqual(previous.get(0xc002), png()); assert.deepEqual(decodeClipboardDib(previous.get(17)), image);
    c.receive(pdu(3, 1)); // Releases the serialized latest announcement.
    c.receive(pdu(4, 0, new Writer().u32le(13).finish()));
    assert.deepEqual(sent.at(-1).body, utf16('new', true));
    c.receive(pdu(4, 0, new Writer().u32le(0xc001).finish())); assert.equal(sent.at(-1).flags, 2);
});
test('Rejected local format list denies subsequent data requests until a new announcement', t => {
    const { channel: c, sent } = setup(t);
    c.setText('secret'); c.receive(pdu(3, 2));
    c.receive(pdu(4, 0, new Writer().u32le(13).finish())); assert.equal(sent.at(-1).flags, 2);
    c.setText('new'); c.receive(pdu(3, 1));
    c.receive(pdu(4, 0, new Writer().u32le(13).finish())); assert.equal(sent.at(-1).flags, 1);
});
test('Remote DIBV5 and CF_DIB become owned RGBA images with preferred format selection', t => {
    for (const version5 of [false, true]) {
        const { channel: c, events, requests } = setup(t);
        c.receive(list(version5 ? [[8], [17]] : [[8]])); c.requestFormat('image');
        assert.deepEqual(requests(), [version5 ? 17 : 8]);
        const dib = encodeClipboardDib(image, version5), expected = decodeClipboardDib(dib);
        c.receive(pdu(5, 1, dib)); dib.fill(0);
        const actual = events.find(e => e.kind === 'image');
        assert.equal(actual.encoding, 'rgba'); assert.deepEqual(actual.rgba, expected.rgba);
    }
});
test('Malformed rich data rejects only its transfer; subsequent clipboard requests stay aligned', t => {
    const { channel: c, events, requests } = setup(t);
    c.receive(list([[13], [0xc001, 'HTML Format'], [0xc002, 'PNG']])); c.requestFormat('html'); c.requestFormat('image');
    c.receive(pdu(5, 1, Uint8Array.of(0, 0xd8, 0, 0))); // Unpaired surrogate.
    c.receive(pdu(5, 1, new TextEncoder().encode('bad HTML')));
    c.receive(pdu(5, 1, Uint8Array.of(1, 2, 3)));
    assert.equal(events.filter(e => e.kind === 'rejected').length, 3);
    assert.deepEqual(requests(), [13, 0xc001, 0xc002]);
    c.requestFormat('html'); c.receive(pdu(5, 1, encodeClipboardHtml('recovered')));
    assert.equal(events.at(-1).html, 'recovered');
});
test('Malformed format lists and headers fail with controlled errors', t => {
    const { channel: c } = setup(t);
    for (const invalid of [list([[13], [13]]), list([[0]]), list([[0xc123, 'PNG'], [0xc124, 'PNG']]),
        pdu(2, 0, new Writer().u32le(13).u16le(0xd800).u16le(0).finish()),
        pdu(2, 0, new Writer().u32le(13).put(utf16('unterminated')).finish()),
        pdu(3, 0), pdu(5, 1), pdu(4, 4, new Uint8Array(4))])
        assert.throws(() => c.receive(invalid), ProtocolError);
    assert.throws(() => c.requestFormat('files'), ProtocolError);
    assert.throws(() => c.receive(pdu(1)), ProtocolError);
});
test('Timed-out request remains in flight to avoid misidentifying a late response', async t => {
    const { channel: c, events, requests } = setup(t, { timeoutMs: 5 });
    c.receive(list([[0xc001, 'HTML Format'], [0xc002, 'PNG']])); c.requestFormat('html'); c.requestFormat('image');
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.ok(events.some(e => e.kind === 'timeout')); assert.deepEqual(requests(), [0xc001]);
    c.receive(pdu(5, 2)); assert.deepEqual(requests(), [0xc001, 0xc002]);
});
test('Clipboard close erases held binary snapshots and cancels requests', t => {
    const { channel: c } = setup(t);
    c.setContent({ text: 'one', html: 'one', image }); const before = [...c.advertised.values()];
    c.setText('two'); before.push(...c.local.values()); c.close(); c.close();
    assert.ok(before.every(b => b.every(v => v === 0)));
    assert.equal(c.remote.size, 0); assert.equal(c.localText, null);
    assert.throws(() => c.setText('three'), ProtocolError); assert.throws(() => c.receive(pdu(1)), ProtocolError);
});
test('Clipboard budgets are atomic and do not replace a valid snapshot after invalid input', t => {
    const { channel: c } = setup(t, { limit: 200 });
    c.setText('keep'); const before = c.local;
    for (const input of [{ text: 'x'.repeat(101) }, { text: 'x\0y' }, { html: 'x'.repeat(201) }, { png: Uint8Array.of(1) }])
        assert.throws(() => c.setContent(input), ProtocolError);
    assert.equal(c.local, before); assert.equal(c.localText, 'keep');
});
const tick = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
test('Rich clipboard traverses active Session, MCS and fragmented static channel both directions', async t => {
    const events = [], received = [];
    let client;
    const server = new LoopbackServer({ send: b => queueMicrotask(() => client.receive(b)) });
    client = new Session({ options: { selectedProtocol: 1, requestedProtocols: 1, width: 640, height: 400, richClipboard: true },
        send: b => queueMicrotask(() => server.receive(b)), emit: e => events.push(e) });
    t.after(() => { client.close(); server.close(); });
    client.start(); await tick(); assert.equal(client.state, 'active');
    const html = '<b>Zażółć 🙂</b>'.repeat(1024), encoded = encodeClipboardHtml(html);
    // Replace only the lab clipboard handler; retain real MCS/framing/channel code.
    server.clipboardReceive = bytes => {
        const packet = unpack(bytes); received.push(packet);
        if (packet.type === 2) server.clip(3, 1);
        if (packet.type === 4) server.clip(5, 1, encoded);
    };
    server.static.transmit(server.clipboardId, list([[0xda11, 'HTML Format']])); await tick();
    assert.equal(client.requestClipboardFormat('html'), true); await tick();
    assert.equal(events.find(e => e.kind === 'html').html, html);
    client.setClipboardContent({ html }); await tick();
    server.clip(4, 0, new Writer().u32le(0xc001).finish()); await tick();
    assert.equal(decodeClipboardHtml(received.find(p => p.type === 5).body), html);
    assert.equal(client.state, 'active');
});


test('Replacing clipboard snapshots clears superseded data but retains the advertised generation until its ACK', t => {
    const { channel: c, sent } = setup(t);
    c.setText('first');
    const first = c.local.get(13);
    c.setText('second');
    const second = c.local.get(13);
    assert.ok(first.some(b => b !== 0), 'advertised bytes are still available to the peer');
    c.setText('third');
    const third = c.local.get(13);
    assert.ok(second.every(b => b === 0), 'unadvertised superseded copy is cleared');
    c.receive(pdu(4, 0, new Writer().u32le(13).finish()));
    assert.equal(new Reader(sent.at(-1).body).utf16(sent.at(-1).body.length), 'first\0');
    c.receive(pdu(3, 1));
    assert.ok(first.every(b => b === 0), 'previous advertised copy clears only after its ACK');
    c.receive(pdu(4, 0, new Writer().u32le(13).finish()));
    assert.equal(new Reader(sent.at(-1).body).utf16(sent.at(-1).body.length), 'third\0');
    c.close();
    assert.ok(third.every(b => b === 0), 'disconnect clears the final copy');
});

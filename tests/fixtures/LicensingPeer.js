import assert from 'node:assert/strict';
import { Reader } from '../../packages/binary/Reader.js';
import { Writer, concat, utf16 } from '../../packages/binary/Writer.js';
import { parseSendData } from '../../packages/protocol/Mcs.js';
import * as F from './Licensing.js';

/** Synthetic CALs are test-only bytes, not valid RDS licenses or a Windows oracle. */
export function configureLicensingPeer(peer, { key = F.proprietaryKey(), data = Uint8Array.of(31, 41, 59, 26),
    mode = 'issue', coalesce = true, onEvent = () => {} } = {}) {
    const original = peer.packet.bind(peer), close = peer.close.bind(peer);
    let keys, stage = 'start', cached = false;
    const state = { requests: [], completed: false, hwid: null };
    const send = message => peer.indication(peer.ioChannel, new Writer().u32le(0x280).put(message).finish());
    const complete = message => {
        stage = 'complete'; state.completed = true; peer.state = 'activating';
        onEvent('complete');
        if (coalesce) {
            const output = [], originalSend = peer.send;
            peer.send = packet => output.push(packet);
            try { send(message); peer.demandActive(); } finally { peer.send = originalSend; }
            originalSend(concat(...output));
        } else { send(message); peer.demandActive(); }
        keys?.mac.fill(0); keys?.encryption.fill(0); keys = null;
    };
    peer.packet = bytes => {
        if (bytes[0] !== 0x64) return original(bytes);
        const { channelId, data: payload } = parseSendData(bytes, false);
        if (channelId !== peer.ioChannel) return original(bytes);
        const flags = payload.length >= 4 && payload[2] === 0 && payload[3] === 0 ? payload[0] | payload[1] << 8 : 0;
        if (flags === 0x40) {
            assert.equal(stage, 'start'); peer.registerChannels(); peer.state = 'licensing'; stage = 'request';
            if (mode === 'premature') { peer.demandActive(); return; }
            if (mode === 'deny') { send(F.status(1, 1)); return; }
            onEvent('request'); send(F.request(key.certificate)); return;
        }
        if (!(flags & 0x80)) return original(bytes);
        const message = payload.subarray(4), type = message[0]; state.requests.push(type); onEvent(type);
        if (stage === 'request') {
            assert.ok(type === 0x12 || type === 0x13);
            const result = F.responseKeys(message, key.privateKey); keys = result.keys;
            const r = result.reader, blob = () => { const type = r.u16le(), bytes = r.take(r.u16le()); return { type, bytes }; };
            cached = type === 0x12;
            if (cached) {
                const license = blob(); assert.equal(license.type, 1); assert.deepEqual(license.bytes, data);
                const encrypted = blob(); assert.equal(encrypted.type, 9);
                state.hwid = F.crypt(keys.encryption, encrypted.bytes);
                assert.deepEqual(Buffer.from(r.take(16)), F.mac(keys.mac, state.hwid)); r.end();
                if (mode === 'cached') { complete(F.status()); return; }
            } else {
                const user = blob(), machine = blob();
                assert.equal(user.type, 15); assert.equal(machine.type, 16); r.end();
                assert.ok(machine.bytes.length > 1 && machine.bytes.at(-1) === 0);
            }
            stage = 'response';
            const challenge = F.challenge(keys);
            if (mode === 'bad-challenge') challenge[challenge.length - 1] ^= 1;
            send(challenge); return;
        }
        assert.equal(stage, 'response'); assert.equal(type, 0x15);
        const r = new Reader(message); r.skip(4); assert.equal(r.u16le(), 9);
        const answer = F.crypt(keys.encryption, r.take(r.u16le()));
        assert.equal(r.u16le(), 9); const hwid = F.crypt(keys.encryption, r.take(r.u16le()));
        const mac = r.take(16); r.end();
        assert.deepEqual(Buffer.from(mac), F.mac(keys.mac, concat(answer, hwid)));
        const body = new Reader(answer);
        assert.equal(body.u16le(), 0x100); assert.equal(body.u16le(), 0xff00); assert.equal(body.u16le(), 3);
        assert.deepEqual(body.take(body.u16le()), utf16('TEST', true)); body.end();
        assert.equal(hwid.length, 20); assert.equal(new Reader(hwid).u32le(), 0); state.hwid = hwid.slice();
        answer.fill(0); hwid.fill(0);
        const issued = F.issue(keys, { data, type: cached ? 4 : 3 });
        if (mode === 'bad-license') issued[issued.length - 1] ^= 1;
        complete(issued);
    };
    peer.close = () => { keys?.mac.fill(0); keys?.encryption.fill(0); state.hwid?.fill(0); close(); };
    return state;
}

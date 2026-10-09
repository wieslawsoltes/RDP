import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { LicenseClient } from '../packages/licensing/LicenseClient.js';
import { deriveLicenseKeys, licenseMac, licensePublicKey, licenseCrypt } from '../packages/licensing/Crypto.js';
import { parseLicenseHeader, licenseString, encodeLicenseString, parseLicenseRequest, parseNewLicense, licensePdu } from '../packages/licensing/Messages.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
import { Reader } from '../packages/binary/Reader.js';
import { Writer, utf16, concat } from '../packages/binary/Writer.js';
import { makeCertificate } from './fixtures/NetworkServer.js';
import * as F from './fixtures/Licensing.js';

const rsa = F.proprietaryKey();
const hardwareId = Uint8Array.from({ length: 20 }, (_, i) => i < 4 ? 0 : i);
const client = (options = {}) => new LicenseClient({ secureTransport: true, hardwareId, username: 'User', machineName: 'LRDP-1234567890', ...options });
const begin = c => { const response = c.receive(F.request(rsa.certificate)); return { result: response, ...F.responseKeys(response.response, rsa.privateKey) }; };
const hex = bytes => Buffer.from(bytes).toString('hex');
const readBlob = r => { const type = r.u16le(); return { type, data: r.take(r.u16le()) }; };

test('Licensing key schedule and MAC match independent Python hashlib known answers', () => {
    const p = Uint8Array.from({ length: 48 }, (_, i) => i), c = p.slice(0, 32), s = Uint8Array.from({ length: 32 }, (_, i) => i + 32);
    const keys = deriveLicenseKeys(p, c, s);
    assert.deepEqual(Buffer.from(keys.mac), F.referenceKeys(p, c, s).mac);
    assert.deepEqual(Buffer.from(keys.encryption), F.referenceKeys(p, c, s).encryption);
    assert.equal(hex(keys.mac), 'f0f802b3405df47717f9b208b684524d');
    assert.equal(hex(keys.encryption), '7a266e6aca52fc5c5f852b8a60b35b77');
    assert.equal(hex(licenseMac(keys.mac, new TextEncoder().encode('license known answer'))), '00464ddb042ee4cc2bf5bd04b864d45a');
});
test('Licensing refuses unprotected transport and invalid hardware identity', () => {
    for (const opt of [{ secureTransport: false }, { secureTransport: undefined }, { hardwareId: new Uint8Array(19) }])
        assert.throws(() => client(opt), ProtocolError);
});
test('Licensing strings enforce terminators, byte lengths, Unicode validity and ANSI losslessness', () => {
    assert.equal(licenseString(encodeLicenseString('A€Ł', true), true), 'A€Ł');
    assert.equal(licenseString(encodeLicenseString('A€Ÿ')), 'A€Ÿ');
    for (const bytes of [new Uint8Array(), Uint8Array.of(1), Uint8Array.of(0, 1, 0)]) assert.throws(() => licenseString(bytes), ProtocolError);
    assert.throws(() => licenseString(Uint8Array.of(0, 0xd8, 0, 0), true), ProtocolError);
    assert.throws(() => encodeLicenseString('Ł'), ProtocolError);
    assert.throws(() => encodeLicenseString('nul\0x'), ProtocolError);
});
for (const bits of [512, 1024, 2048]) test(`Licensing ${bits}-bit RSA premaster is independently decrypted with native RSA`, () => {
    const pair = bits === 2048 ? rsa : F.proprietaryKey(bits), c = client();
    const result = c.receive(F.request(pair.certificate)), { keys, reader } = F.responseKeys(result.response, pair.privateKey);
    assert.equal(result.response[0], 0x13); assert.equal(result.status, 'requesting-license');
    assert.equal(licenseString(readBlob(reader).data), 'User'); assert.equal(licenseString(readBlob(reader).data), 'LRDP-1234567890'); reader.end();
    assert.deepEqual(Buffer.from(c.keys.encryption), keys.encryption); c.close();
});
test('Licensing X.509 root-first chain selects the leaf RSA key and exact DER boundaries', async t => {
    const cert = await makeCertificate(); t.after(() => cert.close());
    const chain = F.x509Chain(cert.certificate.raw, cert.certificate.raw), c = client();
    const response = c.receive(F.request(chain)); F.responseKeys(response.response, cert.key); c.close();
    assert.throws(() => licensePublicKey(F.x509Chain(cert.certificate.raw)), ProtocolError);
    assert.throws(() => licensePublicKey(F.x509Chain(concat(cert.certificate.raw, Uint8Array.of(0)), cert.certificate.raw)), ProtocolError);
    assert.throws(() => licensePublicKey(chain.subarray(0, chain.length - 1)), ProtocolError);
    assert.throws(() => licensePublicKey(new Uint8Array()), /omitted/);
    assert.equal(licensePublicKey(new Uint8Array(), chain).bytes, 256);
});
test('Licensing cryptographic entropy differs between independent exchanges', () => {
    const a = client(), b = client(); const ar = begin(a), br = begin(b);
    assert.notDeepEqual(ar.result.response, br.result.response); assert.notDeepEqual(ar.keys.encryption, br.keys.encryption);
    a.close(); b.close();
});
test('Licensing authenticates challenge and constructs independent encrypted response and HWID', () => {
    const c = client(), { keys } = begin(c), text = utf16('TEST', true);
    const result = c.receive(F.challenge(keys, text, 0)); // Undefined server BLOB type is documented for Windows.
    assert.equal(result.response[0], 0x15); assert.equal(result.complete, false);
    const r = parseLicenseHeader(result.response).reader, answer = readBlob(r), hw = readBlob(r), digest = r.take(16); r.end();
    assert.equal(answer.type, 9); assert.equal(hw.type, 9);
    const decrypted = F.crypt(keys.encryption, answer.data), h = F.crypt(keys.encryption, hw.data), parsed = new Reader(decrypted);
    assert.equal(parsed.u16le(), 0x100); assert.equal(parsed.u16le(), 0xff00); assert.equal(parsed.u16le(), 3);
    assert.deepEqual(parsed.take(parsed.u16le()), text); parsed.end(); assert.deepEqual(h, hardwareId);
    assert.deepEqual(Buffer.from(digest), F.mac(keys.mac, concat(decrypted, h))); c.close();
});
test('Licensing verifies issuance before exposing an owned, opaque CAL and clears exchange keys', () => {
    const c = client(), { keys } = begin(c); c.receive(F.challenge(keys));
    const encoded = F.issue(keys), secret = c.keys.encryption;
    const result = c.receive(encoded); encoded.fill(0);
    assert.equal(result.complete, true); assert.equal(result.status, 'license-issued'); assert.equal(result.response, null);
    assert.deepEqual(result.license, { ...F.product, data: Uint8Array.of(1, 2, 3, 4) });
    assert.ok(secret.every(v => v === 0)); assert.equal(c.keys, null); assert.equal(c.last, null); c.close();
});
test('Licensing cached license presentation has an encrypted HWID and its MAC; renewals replace opaque data', () => {
    const data = Uint8Array.of(5, 6, 7), c = client({ findLicense: req => { assert.equal(req.product, 'A02'); return { data }; } });
    const { result, keys, reader: r } = begin(c); assert.equal(result.response[0], 0x12);
    const cal = readBlob(r), hw = readBlob(r); assert.equal(cal.type, 1); assert.deepEqual(cal.data, data);
    assert.deepEqual(F.crypt(keys.encryption, hw.data), hardwareId); assert.deepEqual(Buffer.from(r.take(16)), F.mac(keys.mac, hardwareId)); r.end();
    c.receive(F.challenge(keys)); const issued = c.receive(F.issue(keys, { type: 4 })); assert.equal(issued.status, 'license-upgraded'); c.close();
});
test('Licensing supports valid-client alerts with and without a preceding request', () => {
    for (const cached of [false, true]) {
        const c = client(); if (cached) begin(c);
        assert.deepEqual(c.receive(F.status()), { response: null, complete: true, status: 'valid-client' }); c.close();
    }
});
test('Licensing malformed or unauthenticated messages fail permanently without exposing a CAL', () => {
    for (const stage of ['challenge', 'issue', 'index']) {
        const c = client(), { keys } = begin(c); let data;
        if (stage === 'challenge') data = F.challenge(keys);
        else { c.receive(F.challenge(keys)); data = F.issue(keys, stage === 'index' ? { info: { ...F.product, scope: 'attacker' } } : {}); }
        if (stage !== 'index') data[data.length - 1] ^= 1;
        const secret = c.keys.encryption;
        assert.throws(() => c.receive(data), e => e.code === (stage === 'index' ? 'LICENSE_INDEX' : 'LICENSE_MAC'));
        assert.equal(c.state, 'failed'); assert.ok(secret.every(v => v === 0)); c.close();
    }
});
test('Licensing rejects server denial, invalid transitions, unsolicited issuance and repeated requests', () => {
    for (const pdu of [F.status(6, 1), F.status(3, 2), F.status(7, 3), F.status(1, 0), F.packet(3), F.packet(0x13)]) {
        const c = client(); assert.throws(() => c.receive(pdu), ProtocolError); assert.equal(c.state, 'failed'); c.close();
    }
    const c = client(); begin(c); assert.throws(() => c.receive(F.request(rsa.certificate)), ProtocolError); c.close();
});
test('Licensing reset discards keys, and resends are exact and bounded rather than regenerated', () => {
    const c = client(), { result } = begin(c), key = c.keys.encryption;
    for (let i = 0; i < 3; i++) assert.deepEqual(c.receive(F.status(12, 4)).response, result.response);
    assert.throws(() => c.receive(F.status(12, 4)), /retry limit/); c.close();
    const reset = client(); const first = begin(reset), k = reset.keys.mac;
    assert.equal(reset.receive(F.status(12, 3)).status, 'reset'); assert.equal(reset.keys, null); assert.ok(k.every(v => v === 0));
    assert.notDeepEqual(begin(reset).result.response, first.result.response);
    for (let i = 0; i < 2; i++) { reset.receive(F.status(12, 3)); begin(reset); }
    assert.throws(() => reset.receive(F.status(12, 3)), /reset limit/); reset.close(); assert.ok(key.every(v => v === 0));
});
test('Licensing state and key ownership survive scoped input and explicit close', () => {
    const c = client(), wire = F.request(rsa.certificate), scoped = concat(Uint8Array.of(1), wire, Uint8Array.of(2));
    c.receive(scoped.subarray(1, -1)); scoped.fill(0); const key = c.keys.mac, identity = c.hardwareId;
    c.close(); assert.ok(key.every(v => v === 0)); assert.ok(identity.every(v => v === 0)); assert.notEqual(hardwareId[4], 0);
    assert.throws(() => c.receive(F.status()), ProtocolError);
});
test('Licensing every truncated request fails with a controlled protocol error', () => {
    const valid = F.request(rsa.certificate);
    for (let i = 0; i < valid.length; i++) {
        const prefix = valid.slice(0, i); if (i >= 4) new DataView(prefix.buffer).setUint16(2, i, true);
        assert.throws(() => parseLicenseRequest(parseLicenseHeader(prefix).reader), ProtocolError);
    }
    for (const flags of [0, 1, 4, 0x13, 0x73]) { const pdu = F.status(); pdu[1] = flags; assert.throws(() => parseLicenseHeader(pdu), ProtocolError); }
});
test('Licensing bounded parser smoke fuzz classifies only controlled protocol failures', t => {
    let state = 0x4c49434e, rejected = 0;
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    for (let i = 0; i < 10000; i++) {
        const body = Uint8Array.from({ length: random() % 512 }, () => random() & 255);
        try { if (i & 1) parseNewLicense(body); else parseLicenseRequest(parseLicenseHeader(licensePdu(1, body)).reader); }
        catch (e) { assert.ok(e instanceof ProtocolError, e.stack); rejected++; }
    }
    assert.ok(rejected > 0); t.diagnostic(JSON.stringify({ rounds: 10000, rejected, unexpected: 0 }));
});

test('Licensing Windows-1252 codec has stable roundtrip independent of host ICU', () => {
    for (let i = 1; i < 256; i++) {
        const wire = Uint8Array.of(i, 0);
        assert.deepEqual(encodeLicenseString(licenseString(wire)), wire);
    }
    assert.throws(() => encodeLicenseString('\ud800', true), ProtocolError);
});
test('Licensing valid-client and cached paths do not require an ANSI user name', () => {
    const c = client({ username: 'Łukasz' });
    assert.equal(c.receive(F.status()).complete, true); c.close();
    const fresh = client({ username: 'Łukasz' });
    assert.throws(() => begin(fresh), e => e.code === 'LICENSE_ANSI'); fresh.close();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { md4 } from '../packages/security/Md4.js';
import { Rc4 } from '../packages/security/Rc4.js';
import { ntlmV2Response, hmacMd5, NtlmV2, NTLM_FLAGS } from '../packages/security/NtlmV2.js';
import { NtlmSeal } from '../packages/security/NtlmSeal.js';
import { tsRequest, parseTsRequest, passwordCredentials } from '../packages/security/TsRequest.js';
import { Writer, concat, utf16 } from '../packages/binary/Writer.js';
const hex = b => Buffer.from(b).toString('hex'), fromHex = s => new Uint8Array(Buffer.from(s, 'hex'));
const enc = text => new TextEncoder().encode(text);
test('MD4: all RFC 1320 known-answer vectors', () => {
    for (const [text, expected] of [
        ['', '31d6cfe0d16ae931b73c59d7e0c089c0'], ['a', 'bde52cb31de33e46245e05fbdbd6fb24'],
        ['abc', 'a448017aaf21d8525fc10ae87aa6729d'], ['message digest', 'd9130a8164549fe818874806e1c7014b'],
        ['abcdefghijklmnopqrstuvwxyz', 'd79e1c308aa5bbcdeea8ed63df412da9'],
        ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', '043f8582f241db351ce627e153e7f0e4'],
        ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', 'e33b4ddc9c38f2199c3e7b164fcc0536']
    ])
        assert.equal(hex(md4(enc(text))), expected);
});
test('RC4: known-answer and stateful streaming', () => {
    const c = new Rc4(enc('Key'));
    assert.equal(hex(c.transform(enc('Plaintext'))), 'bbf316e8d940af0ad3');
    c.destroy();
    assert.throws(() => c.transform(enc('x')));
    const a = new Rc4(enc('Wiki')), b = new Rc4(enc('Wiki'));
    assert.equal(hex(a.transform(enc('pedia'))), '1021bf0420');
    assert.equal(hex(concat(b.transform(enc('pe')), b.transform(enc('dia')))), '1021bf0420');
});
test('NTLMv2 one-way key published vector (User / Domain / Password)', () => {
    assert.equal(hex(md4(utf16('Password'))), 'a4f49c406510bdcab6824ee7c30fd852');
    assert.equal(hex(hmacMd5(md4(utf16('Password')), utf16('USERDomain'))), '0c868a403bfd7a93a3001ef22ef02e3f');
});
test('NTLMv2 LM response published nonce vector', () => {
    const result = ntlmV2Response({ password: 'Password', username: 'User', domain: 'Domain', serverChallenge: fromHex('0123456789abcdef'), clientChallenge: fromHex('aaaaaaaaaaaaaaaa'), timestamp: new Uint8Array(8), targetInfo: fromHex('00000000') });
    assert.equal(hex(result.lmResponse), '86c35097ac9cec102554764a57cccc19' + 'aaaaaaaaaaaaaaaa');
});
test('NTLM sealing directions, streaming sequence and tamper rejection', () => {
    const key = fromHex('55555555555555555555555555555555'), out = new NtlmSeal(key, 'client-to-server'), input = new NtlmSeal(key, 'client-to-server');
    for (const text of ['binding', 'credentials', ''])
        assert.deepEqual(input.unseal(out.seal(enc(text))), enc(text));
    const corrupt = out.seal(enc('corrupt'));
    corrupt[16] ^= 1;
    assert.throws(() => input.unseal(corrupt), /signature/);
    const replayReceiver = new NtlmSeal(key, 'client-to-server');
    assert.throws(() => replayReceiver.unseal(out.seal(enc('next'))), /sequence/);
});
test('CredSSP DER roundtrip and downgrade rejection', () => {
    const packet = tsRequest({ version: 6, token: enc('NTLMSSP\0'), pubKeyAuth: enc('binding'), nonce: new Uint8Array(32) });
    const parsed = parseTsRequest(packet);
    assert.equal(parsed.version, 6);
    assert.deepEqual(parsed.token, enc('NTLMSSP\0'));
    assert.deepEqual(parsed.pubKeyAuth, enc('binding'));
    assert.throws(() => parseTsRequest(tsRequest({ version: 4 })), /below 5/);
    assert.throws(() => parseTsRequest(tsRequest({ errorCode: 0xc000006d })), /rejected/);
    assert.ok(passwordCredentials('domain', 'user', '🔐').length > 20);
});

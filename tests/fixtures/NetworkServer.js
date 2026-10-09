import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { SocketReader, writeSocket } from '../../packages/transport/SocketReader.js';
import { tpkt } from '../../packages/protocol/X224.js';
import { Reader } from '../../packages/binary/Reader.js';
import { Writer, utf16 } from '../../packages/binary/Writer.js';
import { readTlv, readInteger } from '../../packages/binary/Asn1.js';
import { NTLM_FLAGS, encodeAvPairs, parseAvPairs } from '../../packages/security/NtlmV2.js';
import { md4 } from '../../packages/security/Md4.js';
import { Rc4 } from '../../packages/security/Rc4.js';
import { NtlmSeal } from '../../packages/security/NtlmSeal.js';
import { parseTsRequest, tsRequest } from '../../packages/security/TsRequest.js';
import { subjectPublicKey, tlsChannelBinding } from '../../packages/security/Certificate.js';
import { LoopbackServer } from '../../packages/lab/LoopbackServer.js';
import assert from 'node:assert/strict';
const mac = (key, ...values) => {
    const h = createHmac('md5', key);
    for (const value of values)
        h.update(value);
    return new Uint8Array(h.digest());
};
const sha = (...values) => {
    const h = createHash('sha256');
    for (const value of values)
        h.update(value);
    return new Uint8Array(h.digest());
};
export async function makeCertificate() {
    const directory = await mkdtemp(join(tmpdir(), 'lrdp-test-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-noenc', '-sha256', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
    const key = await readFile(join(directory, 'key.pem')), cert = await readFile(join(directory, 'cert.pem')), certificate = new X509Certificate(cert);
    return { key, cert, certificate, pin: createHash('sha256').update(certificate.raw).digest('hex'), close: () => rm(directory, { recursive: true, force: true }) };
}
/** Co-developed test server. It is deliberately not an independent conformance oracle. */
export async function serveRdp(cert, { nla = false, badBinding = false, onActive = () => { }, onInput = () => { }, configurePeer = () => {} } = {}) {
    const connections = new Set(), errors = [], credentialRecords = [], context = tls.createSecureContext(cert);
    const server = net.createServer(raw => {
        connections.add(raw);
        raw.on('error', () => { });
        raw.on('close', () => connections.delete(raw));
        (async () => {
            const plain = new SocketReader(raw), request = await plain.tpkt();
            assert.equal(new Reader(request.subarray(request.length - 4)).u32le(), nla ? 2 : 1);
            await writeSocket(raw, tpkt(new Writer().u8(14).u8(0xd0).zeros(5).u8(2).u8(0).u16le(8).u32le(nla ? 2 : 1).finish()));
            assert.equal(plain.detach().length, 0);
            const socket = new tls.TLSSocket(raw, { isServer: true, secureContext: context });
            socket.on('error', () => { });
            connections.add(socket);
            socket.on('close', () => connections.delete(socket));
            const reader = new SocketReader(socket);
            if (nla) {
                const type1 = parseTsRequest(await reader.der()).token.slice();
                const challenge = Uint8Array.of(1, 35, 69, 103, 137, 171, 205, 239);
                const info = encodeAvPairs(new Map([[2, utf16('LAB')], [1, utf16('LOCALHOST')], [7, new Writer().u64le((BigInt(Date.now()) + 11644473600000n) * 10000n).finish()]]));
                const target = utf16('LAB'), type2 = new Writer().ascii('NTLMSSP\0').u32le(2).u16le(target.length).u16le(target.length).u32le(56).u32le(NTLM_FLAGS).put(challenge).zeros(8).u16le(info.length).u16le(info.length).u32le(56 + target.length).put(Uint8Array.of(10, 0, 0, 0, 0, 0, 0, 15)).put(target).put(info).finish();
                await writeSocket(socket, tsRequest({ version: 6, token: type2 }));
                const request3 = parseTsRequest(await reader.der()), type3 = request3.token, r = new Reader(type3);
                assert.equal(r.ascii(8), 'NTLMSSP\0');
                assert.equal(r.u32le(), 3);
                const fields = [];
                for (let i = 0; i < 6; i++) {
                    const length = r.u16le();
                    r.u16le();
                    const offset = r.u32le();
                    fields.push(type3.slice(offset, offset + length));
                }
                const [lm, response, domain, username, workstation, encryptedKey] = fields;
                assert.equal(new Reader(domain).utf16(domain.length), 'LAB');
                assert.equal(new Reader(username).utf16(username.length), 'User');
                const responseKey = mac(md4(utf16('Password')), utf16('USERLAB')), proof = response.subarray(0, 16), blob = response.subarray(16);
                assert.deepEqual(proof, mac(responseKey, challenge, blob));
                const exportedKey = new Rc4(mac(responseKey, proof)).transform(encryptedKey);
                const mic = type3.slice(72, 88), unmic = type3.slice();
                unmic.fill(0, 72, 88);
                assert.deepEqual(mic, mac(exportedKey, type1, type2, unmic));
                const av = parseAvPairs(blob.subarray(28, blob.length - 4));
                assert.deepEqual(av.get(10), tlsChannelBinding(cert.certificate));
                assert.equal(new Reader(av.get(9)).utf16(av.get(9).length), 'TERMSRV/localhost');
                const inbound = new NtlmSeal(exportedKey, 'client-to-server'), outbound = new NtlmSeal(exportedKey, 'server-to-client');
                assert.deepEqual(inbound.unseal(request3.pubKeyAuth), sha('CredSSP Client-To-Server Binding Hash\0', request3.nonce, subjectPublicKey(cert.certificate)));
                const responseHash = sha('CredSSP Server-To-Client Binding Hash\0', request3.nonce, subjectPublicKey(cert.certificate));
                if (badBinding)
                    responseHash[0] ^= 1;
                await writeSocket(socket, tsRequest({ version: 6, pubKeyAuth: outbound.seal(responseHash) }));
                const delegated = parseTsRequest(await reader.der());
                const credentials = inbound.unseal(delegated.authInfo), outer = readTlv(new Reader(credentials), 0x30).reader;
                assert.equal(readInteger(readTlv(outer, 0xa0).reader), 1);
                const payload = readTlv(readTlv(outer, 0xa1).reader, 4).reader;
                const passwords = readTlv(payload, 0x30).reader, values = [];
                for (let i = 0; i < 3; i++) {
                    const value = readTlv(readTlv(passwords, 0xa0 + i).reader, 4).reader;
                    values.push(value.utf16(value.remaining));
                }
                assert.deepEqual(values, ['LAB', 'User', 'Password']);
                credentialRecords.push({ username: values[1], domain: values[0], passwordVerified: true });
                credentials.fill(0);
                exportedKey.fill(0);
                inbound.destroy();
                outbound.destroy();
            }
            const pending = reader.detach();
            const peer = new LoopbackServer({ requestedProtocols: nla ? 2 : 1, send: bytes => socket.write(bytes), onInput, onActive });
            configurePeer(peer);
            socket.on('data', bytes => {
                try {
                    peer.receive(new Uint8Array(bytes));
                }
                catch (error) {
                    errors.push(error);
                    socket.destroy();
                }
            });
            socket.on('close', () => peer.close());
            if (pending.length)
                peer.receive(pending);
            socket.resume();
        })().catch(error => { errors.push(error); raw.destroy(); });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { port: server.address().port, errors, credentialRecords, close: async () => {
            for (const socket of connections)
                socket.destroy();
            await new Promise(resolve => server.close(resolve));
        } };
}

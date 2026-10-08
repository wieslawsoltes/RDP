import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openRdpConnection } from '../../packages/transport/RdpConnection.js';
import { Session } from '../../packages/protocol/Session.js';
import { makeCertificate, serveRdp } from '../fixtures/NetworkServer.js';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const nla of [false, true])
    test(`Real loopback TCP → X.224 → TLS${nla ? ' → CredSSP/NTLMv2' : ''} → RDP activation`, { timeout: 15000 }, async (t) => {
        const cert = await makeCertificate();
        t.after(() => cert.close());
        const remote = await serveRdp(cert, { nla });
        t.after(() => remote.close());
        const result = await openRdpConnection({ host: '127.0.0.1', serverName: 'localhost', port: remote.port, ca: cert.cert, allowTlsOnly: true }, { username: 'User', domain: 'LAB', password: 'Password' }, { security: nla ? 'nla' : 'tls', signal: AbortSignal.timeout(5000) });
        t.after(() => result.socket.destroy());
        assert.equal(result.negotiation.selectedProtocol, nla ? 2 : 1);
        assert.equal(result.certificate.trust, 'certificate authority');
        let resolveActive;
        const active = new Promise(resolve => { resolveActive = resolve; }), events = [];
        const session = new Session({ options: { ...result.negotiation, username: 'User', domain: 'LAB', password: nla ? '' : 'Password' }, send: bytes => result.socket.write(bytes), emit: event => {
                events.push(event);
                if (event.type === 'state' && event.state === 'active')
                    resolveActive();
            } });
        result.socket.on('data', bytes => session.receive(new Uint8Array(bytes)));
        if (result.pending.length)
            session.receive(result.pending);
        session.start();
        result.socket.resume();
        await Promise.race([active, delay(5000).then(() => { throw new Error(`Activation timeout: ${JSON.stringify(events)}`); })]);
        assert.equal(session.state, 'active');
        if (nla)
            assert.equal(remote.credentialRecords[0].passwordVerified, true);
        assert.equal(remote.errors.length, 0, remote.errors.map(e => e.message).join('; '));
        session.close();
    });
test('Certificate policy accepts configured pin and rejects wrong pin / untrusted certificate', { timeout: 15000 }, async (t) => {
    const cert = await makeCertificate();
    t.after(() => cert.close());
    const remote = await serveRdp(cert);
    t.after(() => remote.close());
    const target = { host: '127.0.0.1', serverName: 'localhost', port: remote.port, allowTlsOnly: true }, credentials = { username: 'User', domain: 'LAB', password: 'Password' };
    const good = await openRdpConnection({ ...target, certSha256: cert.pin }, credentials, { security: 'tls', signal: AbortSignal.timeout(4000) });
    assert.equal(good.certificate.trust, 'pinned certificate');
    good.socket.destroy();
    await assert.rejects(openRdpConnection({ ...target, certSha256: '00'.repeat(32) }, credentials, { security: 'tls', signal: AbortSignal.timeout(4000) }), /pin/i);
    await assert.rejects(openRdpConnection(target, credentials, { security: 'tls', signal: AbortSignal.timeout(4000) }), /self.signed/i);
});
test('NLA rejects bad server binding before password delegation', { timeout: 15000 }, async (t) => {
    const cert = await makeCertificate();
    t.after(() => cert.close());
    const remote = await serveRdp(cert, { nla: true, badBinding: true });
    t.after(() => remote.close());
    await assert.rejects(openRdpConnection({ host: '127.0.0.1', serverName: 'localhost', port: remote.port, ca: cert.cert }, { username: 'User', domain: 'LAB', password: 'Password' }, { security: 'nla', signal: AbortSignal.timeout(5000) }), /binding verification/i);
    assert.equal(remote.credentialRecords.length, 0);
});

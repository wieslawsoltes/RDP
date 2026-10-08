import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { requireThat } from '../binary/ProtocolError.js';
import { NtlmV2 } from './NtlmV2.js';
import { tsRequest, parseTsRequest, passwordCredentials } from './TsRequest.js';
import { subjectPublicKey, tlsChannelBinding } from './Certificate.js';
import { writeSocket } from '../transport/SocketReader.js';
const bindingHash = (direction, nonce, key) => new Uint8Array(createHash('sha256').update(`CredSSP ${direction} Binding Hash\0`).update(nonce).update(key).digest());
/** CredSSP 5/6 + NTLMv2. Kerberos and versions 2–4 are deliberately not claimed. */
export async function authenticateCredSsp(socket, reader, certificate, credentials, serviceName) {
    const ntlm = new NtlmV2({ ...credentials, serviceName, channelBinding: tlsChannelBinding(certificate) });
    let plainCredentials, wireCredentials, authenticate;
    try {
        await writeSocket(socket, tsRequest({ token: ntlm.negotiate() }));
        const challenge = parseTsRequest(await reader.der());
        requireThat(challenge.token && !challenge.authInfo && !challenge.pubKeyAuth, 'NLA_STATE', 'Expected an NTLM challenge in CredSSP');
        const version = challenge.version, nonce = new Uint8Array(randomBytes(32)), key = subjectPublicKey(certificate);
        authenticate = ntlm.authenticate(challenge.token);
        const hash = bindingHash('Client-To-Server', nonce, key), pubKeyAuth = ntlm.outgoing.seal(hash);
        hash.fill(0);
        const request = tsRequest({ version, token: authenticate, pubKeyAuth, nonce });
        await writeSocket(socket, request);
        request.fill(0);
        authenticate.fill(0);
        const response = parseTsRequest(await reader.der());
        requireThat(response.version === version && response.pubKeyAuth && !response.authInfo, 'NLA_STATE', 'Missing CredSSP public-key binding');
        const actual = ntlm.incoming.unseal(response.pubKeyAuth), expected = bindingHash('Server-To-Client', nonce, key);
        requireThat(actual.length === expected.length && timingSafeEqual(actual, expected), 'NLA_BINDING', 'CredSSP TLS public-key binding verification failed');
        actual.fill(0);
        expected.fill(0);
        plainCredentials = passwordCredentials(credentials.domain || '', credentials.username, credentials.password);
        wireCredentials = tsRequest({ version, authInfo: ntlm.outgoing.seal(plainCredentials) });
        plainCredentials.fill(0);
        await writeSocket(socket, wireCredentials);
        wireCredentials.fill(0);
        return { protocol: 'CredSSP', version, authentication: 'NTLMv2', binding: 'SHA-256 + TLS endpoint binding' };
    }
    finally {
        plainCredentials?.fill(0);
        wireCredentials?.fill(0);
        authenticate?.fill(0);
        ntlm.destroy();
    }
}

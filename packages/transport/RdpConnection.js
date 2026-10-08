import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { requireThat } from '../binary/ProtocolError.js';
import { connectionRequest, parseConnectionConfirm } from '../protocol/X224.js';
import { SocketReader, writeSocket } from './SocketReader.js';
import { validatePeerCertificate } from '../security/Certificate.js';
import { authenticateCredSsp } from '../security/CredSsp.js';
/** Owns TCP/TLS and NLA only. The browser owns all post-authentication RDP state. */
export async function openRdpConnection(target, credentials, { security = 'nla', signal, onStage = () => { } } = {}) {
    requireThat(security === 'nla' || (security === 'tls' && target.allowTlsOnly), 'SECURITY_POLICY', 'TLS-only logon is disabled for this target; use NLA');
    const requestedProtocols = security === 'nla' ? 2 : 1;
    let socket = net.connect({ host: target.host, port: target.port || 3389 }), reader;
    const abort = () => socket.destroy(signal?.reason instanceof Error ? signal.reason : new Error('Connection cancelled'));
    const silence = () => { };
    socket.on('error', silence);
    if (signal?.aborted) {
        abort();
        throw signal.reason;
    }
    signal?.addEventListener('abort', abort, { once: true });
    try {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 30000);
        onStage('tcp');
        await once(socket, 'connect', { signal });
        reader = new SocketReader(socket);
        onStage('negotiating');
        await writeSocket(socket, connectionRequest(requestedProtocols));
        const negotiation = parseConnectionConfirm(await reader.tpkt(), requestedProtocols);
        requireThat(reader.detach().length === 0, 'SECURITY_BOUNDARY', 'Unexpected plaintext bytes after RDP security negotiation');
        onStage('tls');
        socket = tls.connect({ socket, servername: net.isIP(target.serverName || target.host) ? undefined : target.serverName || target.host,
            minVersion: 'TLSv1.2', rejectUnauthorized: !target.certSha256, ...(target.ca ? { ca: target.ca } : {}) });
        socket.on('error', silence);
        await once(socket, 'secureConnect', { signal });
        // When connecting to an IP, Node does not set SNI, but hostname verification still uses the peer host.
        if (!target.certSha256 && net.isIP(target.serverName || target.host)) {
            const error = tls.checkServerIdentity(target.serverName || target.host, socket.getPeerCertificate());
            if (error)
                throw error;
        }
        const { certificate, metadata } = validatePeerCertificate(socket, target);
        reader = new SocketReader(socket);
        let auth = { protocol: 'TLS', authentication: 'server logon', version: null };
        if (negotiation.selectedProtocol !== 1) {
            onStage('authenticating');
            auth = await authenticateCredSsp(socket, reader, certificate, credentials, `TERMSRV/${target.serverName || target.host}`);
        }
        if (negotiation.selectedProtocol === 8) {
            const status = await reader.read(4);
            requireThat(status.every(v => v === 0), 'NLA_AUTHORIZATION', 'Server rejected early user authorization');
        }
        const pending = reader.detach();
        onStage('secured');
        signal?.removeEventListener('abort', abort);
        return { socket, pending, negotiation, certificate: metadata, authentication: auth };
    }
    catch (error) {
        socket.destroy();
        throw error;
    }
    finally {
        signal?.removeEventListener('abort', abort);
    }
}

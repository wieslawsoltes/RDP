import { createHash, timingSafeEqual } from 'node:crypto';
import { requireThat } from '../../packages/binary/ProtocolError.js';
import { GatewayLicensing, GATEWAY_LICENSING } from '../../packages/licensing/GatewayLicensing.js';
import { licenseNamespace } from '../gateway/LicenseStore.js';
import { writeSocket } from '../../packages/transport/SocketReader.js';
import { openRdpConnection } from '../../packages/transport/RdpConnection.js';
const digest = value => createHash('sha256').update(value).digest();
export const tokenMatches = (input, token) => typeof input === 'string' && input.length >= 24 && input.length <= 512 && timingSafeEqual(digest(input), digest(token));
export class BridgeSession {
    constructor(peer, { token, targets, licenseStore, onClose = () => { } }) {
        this.peer = peer;
        this.token = token;
        this.targets = targets;
        this.licenseStore = licenseStore;
        this.state = 'authentication';
        this.outstanding = 0;
        this.inputOutstanding = this.inputAck = 0;
        this.inputWindow = 256 * 1024;
        this.window = 512 * 1024;
        this.closed = false;
        this.abort = new AbortController();
        this.authTimer = setTimeout(() => this.fail('AUTH_TIMEOUT', 'Bridge authentication timed out'), 5000);
        this.pingTimer = setInterval(() => {
            if (Date.now() - peer.lastSeen > 45000)
                this.fail('HEARTBEAT', 'Client heartbeat timed out');
            else
                peer.ping();
        }, 15000);
        peer.on('message', (value, binary) => {
            try {
                this.message(value, binary);
            }
            catch (error) {
                this.fail(error.code || 'BRIDGE_MESSAGE', error.message);
            }
        });
        peer.on('closed', () => { this.close(); onClose(); });
        peer.on('socket-error', () => this.close());
    }
    message(value, binary) {
        if (this.closed)
            return;
        if (binary) {
            requireThat(this.state === 'streaming' && value.length > 0 && value.length <= 65536, 'BRIDGE_STATE', 'Binary RDP traffic before security negotiation or packet too large');
            let packets = [];
            try {
                packets = this.licensing.client(value);
                const total = packets.reduce((sum, packet) => sum + packet.length, 0);
                requireThat(this.remote.writableLength + total <= 1024 * 1024, 'BACKPRESSURE', 'Server is not accepting client input');
                if (this.inputFlowControl) {
                    requireThat(this.inputOutstanding + value.length <= this.inputWindow, 'FLOW_CONTROL', 'Gateway input credit exceeded');
                    this.inputOutstanding += value.length;
                }
                const acceptedBytes = value.length;
                let remaining = packets.length;
                const acknowledge = error => {
                    if (this.closed) return;
                    if (error) { this.fail('REMOTE_IO', error.message); return; }
                    if (this.inputFlowControl) {
                        this.inputOutstanding -= acceptedBytes;
                        this.inputAck += acceptedBytes;
                        if (this.inputAck >= 64 * 1024) this.flushInputAck();
                        else if (!this.inputAckTimer) this.inputAckTimer = setTimeout(() => this.flushInputAck(), 2);
                    }
                };
                if (!remaining) acknowledge(); // Partial input is owned by a bounded framing queue.
                for (const packet of packets) this.remote.write(packet, error => {
                    packet.fill(0);
                    if (error) acknowledge(error);
                    else if (--remaining === 0) acknowledge();
                });
            } catch (error) {
                // Closing the socket cancels outstanding writes before cleanup.
                this.remote.destroy(); for (const packet of packets) packet.fill(0); throw error;
            } finally { value.fill(0); }
            return;
        }
        requireThat(value.length <= 16384, 'CONTROL_LIMIT', 'Bridge control message exceeds limit');
        const control = JSON.parse(value);
        requireThat(control && !Array.isArray(control) && typeof control.type === 'string', 'CONTROL', 'Invalid bridge control message');
        if (this.state === 'authentication') {
            requireThat(control.type === 'connect' && tokenMatches(control.token, this.token), 'AUTHENTICATION', 'Bridge authentication failed');
            this.token = null;
            clearTimeout(this.authTimer);
            const target = this.targets.get(control.targetId);
            requireThat(target, 'TARGET_DENIED', 'Target ID is not in the bridge allowlist');
            requireThat(control.security === 'nla' || control.security === 'tls', 'SECURITY', 'Select NLA or explicitly enabled TLS-only');
            for (const key of ['username', 'password', 'domain'])
                requireThat(typeof control[key] === 'string' && control[key].length <= 1024 && !control[key].includes('\0'), 'CREDENTIALS', 'Invalid credential field');
            const credentials = { username: control.username, password: control.password, domain: control.domain };
            control.token = control.password = '';
            this.inputFlowControl = control.inputFlowControl === true;
            this.state = 'negotiating';
            this.negotiate(target, credentials, control.security);
            return;
        }
        if (control.type === 'disconnect') {
            this.peer.close();
            this.close();
            return;
        }
        if (control.type === 'ack') {
            requireThat(this.state === 'streaming' && Number.isSafeInteger(control.bytes) && control.bytes > 0 && control.bytes <= this.outstanding, 'FLOW_CONTROL', 'Invalid receive-credit acknowledgement');
            this.outstanding -= control.bytes;
            if (this.outstanding < this.window / 2) this.resumeRemote();
            return;
        }
        if (control.type === 'ping') {
            this.peer.sendJSON({ type: 'pong', id: Number.isSafeInteger(control.id) ? control.id : 0 });
            return;
        }
        throw new Error('Unknown bridge control message');
    }
    async negotiate(target, credentials, security) {
        const timeout = setTimeout(() => this.abort.abort(new Error('RDP negotiation timed out')), 30000);
        try {
            const connection = await openRdpConnection(target, credentials, { security, signal: this.abort.signal, onStage: state => this.peer.sendJSON({ type: 'stage', state }) });
            if (this.closed) {
                connection.socket.destroy();
                return;
            }
            this.remote = connection.socket;
            this.state = 'streaming';
            this.licensing = new GatewayLicensing({ requestedProtocols: connection.negotiation.requestedProtocols,
                store: this.licenseStore, namespace: licenseNamespace(target, credentials),
                username: target.licenseUsername ?? credentials.username,
                write: bytes => {
                    requireThat(!this.closed && this.remote.writableLength + bytes.length <= 1024 * 1024, 'BACKPRESSURE', 'Server is not accepting licensing data');
                    return writeSocket(this.remote, bytes);
                },
                forward: bytes => this.forward(bytes), notify: message => this.peer.sendJSON(message),
                pause: () => this.remote.pause(), resume: () => this.resumeRemote(),
                fail: error => this.fail(error.code || 'LICENSING_FAILED', error.message) });
            this.peer.sendJSON({ type: 'ready', licensing: GATEWAY_LICENSING, inputWindow: this.inputFlowControl ? this.inputWindow : 0, ...connection.negotiation, certificate: connection.certificate, authentication: connection.authentication });
            const receive = bytes => {
                if (this.closed) return;
                try { this.licensing.server(bytes); }
                catch (error) { this.fail(error.code || 'LICENSING_FAILED', error.message); }
            };
            this.remote.on('data', receive);
            this.remote.once('error', error => this.fail('REMOTE_IO', error.message));
            this.remote.once('end', () => this.fail('REMOTE_CLOSED', 'Remote RDP server closed the connection'));
            if (connection.pending.length)
                receive(connection.pending);
            this.resumeRemote();
        }
        catch (error) {
            this.fail(error.code || 'CONNECTION_FAILED', error.message);
        }
        finally {
            credentials.password = '';
            clearTimeout(timeout);
        }
    }
    resumeRemote() {
        if (!this.closed && this.outstanding < this.window && !this.licensing?.busy) this.remote?.resume();
    }
    forward(bytes) {
        if (this.closed) return;
        this.outstanding += bytes.length;
        requireThat(this.outstanding <= this.window + 1024 * 1024, 'FLOW_CONTROL', 'Receive credit exceeded');
        this.peer.sendBinary(bytes);
        if (this.outstanding >= this.window) this.remote.pause();
    }
    flushInputAck() {
        clearTimeout(this.inputAckTimer); this.inputAckTimer = null;
        if (!this.closed && this.inputAck) {
            const bytes = this.inputAck; this.inputAck = 0;
            this.peer.sendJSON({ type: 'input-ack', bytes });
        }
    }
    fail(code, message) {
        if (this.closed) return;
        try {
            this.peer.sendJSON({ type: 'error', code, message: String(message).slice(0, 512) });
            this.peer.close(1008, String(code).slice(0, 80));
        } catch { /* The transport may already have failed. */ }
        finally { this.close(); }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.state = 'closed';
        this.token = null;
        this.licensing?.close(); this.licenseStore = null;
        clearTimeout(this.authTimer);
        clearTimeout(this.inputAckTimer);
        this.inputAck = this.inputOutstanding = 0;
        clearInterval(this.pingTimer);
        this.abort.abort(new Error('Client disconnected'));
        this.remote?.destroy();
    }
}

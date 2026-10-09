import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { ProtocolError, requireThat } from '../binary/ProtocolError.js';
import { Framer } from '../protocol/Framer.js';
import { unwrapData } from '../protocol/X224.js';
import * as Mcs from '../protocol/Mcs.js';
import { LicenseClient } from './LicenseClient.js';

export const GATEWAY_LICENSING = 'gateway-v1';
const MAX_BUFFERED = 1024 * 1024;
async function abortable(operation, signal) {
    let cancel;
    const aborted = new Promise((_, reject) => { cancel = () => reject(signal.reason); signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel(); });
    try { return await Promise.race([operation, aborted]); }
    finally { signal.removeEventListener('abort', cancel); }
}
const securityFlags = data => data.length >= 4 && data[2] === 0 && data[3] === 0 ? data[0] | data[1] << 8 : 0;
function clearFramer(framer) {
    // The framer owns copies: clearing must also release partial credential PDUs.
    for (const bytes of framer.queue.chunks) bytes.fill(0);
    framer.clear();
}

/**
 * Post-TLS licensing filter, owned exclusively by the trusted gateway.
 * Server identity, MCS IDs and licensing public keys come from the authenticated
 * server stream, never a browser control message. Pause while persisting a CAL;
 * no Demand Active is forwarded before that transaction commits.
 *
 * This profile uses unsegmented MCS (<=32767 bytes). Graphics become a direct
 * pass-through after licensing and draining any already-framed transport tail.
 */
export class GatewayLicensing {
    constructor({ requestedProtocols, store, namespace, username, write, forward, notify, pause, resume, fail, timeoutMs = 60000 }) {
        requireThat([1, 2, 8].includes(requestedProtocols), 'LICENSE_TRANSPORT', 'Invalid authenticated transport profile');
        requireThat(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'LICENSE_TIMEOUT', 'Invalid licensing deadline');
        this.abort = new AbortController();
        this.timer = setTimeout(() => this.terminate(new ProtocolError('LICENSE_TIMEOUT', 'RDP licensing handshake timed out')), timeoutMs);
        this.requestedProtocols = requestedProtocols;
        this.store = store; this.namespace = namespace; this.username = username;
        this.write = write; this.forward = forward; this.notify = notify;
        this.pause = pause; this.resume = resume; this.fail = fail;
        this.phase = 'connect'; this.initialSent = false; this.joined = new Set(); this.joining = null;
        this.complete = false; this.closed = false; this.busy = false;
        this.queue = []; this.queuedBytes = 0; this.clientFrames = null; this.engine = null;
        this.serverFramer = new Framer((packet, kind) => {
            requireThat(this.queue.length < 4096 && this.queuedBytes + packet.length <= MAX_BUFFERED,
                'LICENSE_QUEUE', 'Too much data queued during licensing');
            this.queue.push({ packet: packet.slice(), kind }); this.queuedBytes += packet.length; packet.fill(0);
        }, MAX_BUFFERED);
        this.clientFramer = new Framer((packet, kind) => {
            requireThat(kind === 'tpkt', 'LICENSE_CLIENT_FRAME', 'This gateway profile expects slow-path client input');
            this.inspectClient(packet);
            this.clientFrames.push(packet.slice()); packet.fill(0);
        }, MAX_BUFFERED);
    }
    client(bytes) {
        requireThat(!this.closed && bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= 65536,
            'LICENSE_CLIENT_FRAME', 'Invalid client transport chunk');
        this.clientFrames = [];
        try { this.clientFramer.push(new Uint8Array(bytes)); return this.clientFrames; }
        catch (error) { for (const frame of this.clientFrames) frame.fill(0); throw error; }
        finally { this.clientFrames = null; }
    }
    inspectClient(packet) {
        const bytes = unwrapData(packet);
        if (bytes[0] === 0x7f && bytes[1] === 0x65) {
            requireThat(this.phase === 'connect' && !this.initialSent, 'LICENSE_MCS', 'Repeated MCS connection request');
            this.initialSent = true; return;
        }
        if (bytes[0] === 4 || bytes[0] === 0x28) {
            requireThat(this.phase === 'attach', 'LICENSE_MCS', 'Unexpected MCS domain or attach request'); return;
        }
        if (bytes[0] === 0x38) {
            const r = new Reader(bytes); r.u8(); const user = r.u16be() + 1001, channel = r.u16be(); r.end();
            requireThat(this.phase === 'joins' && this.joining === null && user === this.userId &&
                this.allowed.has(channel) && !this.joined.has(channel), 'LICENSE_MCS', 'Invalid MCS join request');
            this.joining = channel; return;
        }
        const { initiator, channelId, data } = Mcs.parseSendData(bytes, false);
        requireThat(initiator === this.userId && this.joined.has(channelId), 'LICENSE_MCS', 'Client data on an unjoined MCS channel');
        const flags = channelId === this.ioChannel ? securityFlags(data) : 0;
        requireThat(!(flags & 0x80), 'LICENSE_CLIENT_INJECTION', 'Browser-originated licensing packets are not accepted');
        if (flags & 0x40) {
            requireThat(this.phase === 'joins' && this.joining === null && this.joined.has(this.userId) &&
                flags === 0x40, 'LICENSE_CLIENT_INFO', 'Invalid or repeated Client Info');
            this.phase = 'licensing'; return;
        }
        requireThat(this.complete, 'LICENSE_INCOMPLETE', 'Client application traffic before licensing completed');
    }
    server(bytes) {
        if (this.closed) return;
        requireThat(bytes instanceof Uint8Array && bytes.length <= MAX_BUFFERED, 'LICENSE_QUEUE', 'Oversized server transport chunk');
        if (this.complete && !this.busy && !this.serverFramer.queue.length) { this.forward(bytes); return; }
        this.pause();
        requireThat(this.queuedBytes + this.serverFramer.queue.length + bytes.length <= MAX_BUFFERED,
            'LICENSE_QUEUE', 'Server exceeded the licensing receive budget');
        this.serverFramer.push(new Uint8Array(bytes));
        if (!this.busy) {
            this.busy = true;
            // Every rejection is owned here; socket event listeners never return
            // an unobserved promise, and coalesced frames stay in wire order.
            this.drain().catch(error => this.terminate(error));
        }
    }
    async drain() {
        try {
            while (!this.closed && this.queue.length) {
                const { packet, kind } = this.queue.shift(); this.queuedBytes -= packet.length;
                try {
                    if (this.complete) this.forward(packet);
                    else await this.inspectServer(packet, kind);
                } finally { packet.fill(0); }
            }
        } finally {
            this.busy = false;
            if (!this.closed) this.resume();
        }
    }
    async inspectServer(packet, kind) {
        requireThat(kind === 'tpkt', 'LICENSE_INCOMPLETE', 'Fast-path graphics before licensing completed');
        const bytes = unwrapData(packet);
        if (this.phase === 'connect') {
            requireThat(this.initialSent, 'LICENSE_MCS', 'Unsolicited MCS connection response');
            const result = Mcs.parseConnectResponse(bytes, { requestedProtocols: this.requestedProtocols });
            this.ioChannel = result.ioChannel; this.allowed = new Set([result.ioChannel, ...result.channels]);
            this.phase = 'attach'; this.forward(packet); return;
        }
        if (this.phase === 'attach') {
            this.userId = Mcs.parseAttachConfirm(bytes); this.allowed.add(this.userId);
            this.phase = 'joins'; this.forward(packet); return;
        }
        if (this.phase === 'joins' && bytes[0] === 0x3e) {
            requireThat(this.joining !== null, 'LICENSE_MCS', 'Unsolicited MCS channel join confirmation');
            Mcs.parseJoinConfirm(bytes, this.userId, this.joining);
            this.joined.add(this.joining); this.joining = null; this.forward(packet); return;
        }
        if ((bytes[0] & 0xfc) === 0x20) throw new ProtocolError('SERVER_DISCONNECT', 'Server disconnected during licensing');
        requireThat(this.phase === 'licensing', 'LICENSE_STATE', 'Licensing traffic before Client Info');
        const { channelId, data } = Mcs.parseSendData(bytes);
        requireThat(channelId === this.ioChannel, 'LICENSE_CHANNEL', 'Server application data before licensing completed');
        const flags = securityFlags(data);
        requireThat((flags & 0x80) !== 0 && (flags & ~0x2b0) === 0, 'LICENSE_INCOMPLETE',
            'Server activation or unsupported security flags before licensing completed');
        if (!this.engine) {
            const hardwareId = this.store.hardwareId();
            try {
                this.engine = new LicenseClient({ secureTransport: true, hardwareId,
                    username: this.username, machineName: this.store.machineName(),
                    findLicense: request => {
                        this.cached?.data.fill(0);
                        this.cached = this.store.find(this.namespace, request);
                        return this.cached;
                    } });
            } finally { hardwareId.fill(0); }
        }
        let result;
        try { result = this.engine.receive(data.subarray(4)); }
        finally { this.cached?.data.fill(0); this.cached = null; }
        try {
            if (result.response) {
                const response = Mcs.sendData(this.userId, this.ioChannel, new Writer().u32le(0x80).put(result.response).finish());
                try { await abortable(this.write(response), this.abort.signal); } finally { response.fill(0); }
            }
            if (this.closed) return;
            if (result.license) await abortable(this.store.save(this.namespace, result.license), this.abort.signal);
            if (this.closed) return;
            if (result.complete) {
                clearTimeout(this.timer);
                this.complete = true; this.phase = 'complete'; this.username = '';
                this.engine.close(); this.engine = null;
            }
            this.notify({ type: 'licensing', status: result.status, complete: result.complete });
        } finally { result.response?.fill(0); result.license?.data.fill(0); }
    }
    terminate(error) {
        if (this.closed) return;
        this.close();
        this.fail(error);
    }
    close() {
        if (this.closed) return;
        this.closed = true; this.phase = 'closed'; this.username = '';
        clearTimeout(this.timer); this.abort.abort(new ProtocolError('LICENSE_CLOSED', 'Licensing session closed'));
        this.engine?.close(); this.engine = null; this.cached?.data.fill(0); this.cached = null;
        clearFramer(this.serverFramer); clearFramer(this.clientFramer);
        for (const { packet } of this.queue) packet.fill(0);
        this.queue = []; this.queuedBytes = 0;
        this.joined.clear(); this.allowed?.clear(); this.store = null;
    }
}

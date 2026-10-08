import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { ProtocolError, requireThat } from '../binary/ProtocolError.js';
import { Framer } from './Framer.js';
import { unwrapData } from './X224.js';
import * as Mcs from './Mcs.js';
import { clientInfo } from './ClientInfo.js';
import { parseDemandActive, confirmActiveBody } from './Capabilities.js';
import { shareControl, shareData, parseShare, parseShareData } from './Share.js';
import { FastPath } from './FastPath.js';
import { PointerCache } from './Pointer.js';
import { parseBitmapUpdate, parsePalette } from './BitmapUpdate.js';
import { encodeInput, unicodeEvents } from './InputEncoder.js';
import { StaticChannels } from '../channels/StaticChannels.js';
import { ClipboardChannel } from '../channels/ClipboardChannel.js';
import { DynamicChannels } from '../channels/DynamicChannels.js';
import { DisplayControl, DISPLAY_CHANNEL } from '../channels/DisplayControl.js';
/** Post-TLS client. No transport, DOM, graphics, or platform dependencies. */
export class Session {
    constructor({ send, emit = () => { }, options = {} }) {
        this.send = send;
        this.emit = emit;
        this.options = { width: 1280, height: 800, bpp: 24, clipboard: true, resize: true, selectedProtocol: 2, requestedProtocols: 2, ...options };
        this.state = 'new';
        this.channels = [...(this.options.clipboard ? ['cliprdr'] : []), ...(this.options.resize ? ['drdynvc'] : [])];
        this.framer = new Framer((packet, kind) => this.packet(packet, kind));
        this.fastPath = new FastPath((code, bytes) => this.fastUpdate(code, bytes));
        this.pointer = new PointerCache(value => this.emit({ ...value, kind: value.type, type: 'pointer' }));
        this.staticChannels = new StaticChannels((id, bytes) => this.channelSend(id, bytes));
        this.receivedBytes = 0;
        this.receivedPackets = 0;
        this.bitmapBytes = 0;
        this.desktop = null;
    }
    transition(state) { this.state = state; this.emit({ type: 'state', state }); }
    start() {
        requireThat(this.state === 'new', 'SESSION_STATE', 'Session already started');
        requireThat([1, 2, 8].includes(this.options.selectedProtocol), 'SESSION_SECURITY', 'Verified TLS is required');
        this.transition('mcs-connect');
        this.send(Mcs.connectInitial(this.options, this.channels));
    }
    receive(bytes) {
        if (this.state === 'closed' || this.state === 'failed')
            return;
        try {
            this.receivedBytes += bytes.length;
            this.framer.push(bytes);
        }
        catch (error) {
            this.fail(error);
        }
    }
    packet(packet, kind) {
        this.receivedPackets++;
        if (kind === 'fastpath') {
            requireThat(this.desktop && ['activating', 'active'].includes(this.state), 'SESSION_STATE', 'Graphics before activation');
            this.fastPath.push(packet);
            return;
        }
        const bytes = unwrapData(packet);
        if (this.state === 'mcs-connect') {
            const result = Mcs.parseConnectResponse(bytes, { requestedProtocols: this.options.requestedProtocols, expectedChannels: this.channels.length });
            this.ioChannel = result.ioChannel;
            this.channelIds = result.channels;
            this.transition('mcs-attach');
            this.send(Mcs.erectDomainRequest());
            this.send(Mcs.attachUserRequest());
            return;
        }
        if (this.state === 'mcs-attach') {
            this.userId = Mcs.parseAttachConfirm(bytes);
            this.pendingJoins = [...new Set([this.userId, this.ioChannel, ...this.channelIds])];
            this.transition('mcs-join');
            this.joinNext();
            return;
        }
        if (this.state === 'mcs-join') {
            Mcs.parseJoinConfirm(bytes, this.userId, this.joining);
            this.joinNext();
            return;
        }
        if ((bytes[0] & 0xfc) === 0x20) {
            throw new ProtocolError('SERVER_DISCONNECT', 'The server disconnected the MCS session');
        }
        const { channelId, data } = Mcs.parseSendData(bytes);
        if (channelId !== this.ioChannel) {
            this.staticChannels.receive(channelId, data);
            return;
        }
        // Enhanced RDP security retains a Basic Security Header on licensing packets only.
        if (data.length >= 4 && (data[0] | data[1] << 8) === 0x80 && data[2] === 0 && data[3] === 0) {
            this.license(data.subarray(4));
            return;
        }
        parseShare(data, (type, source, body) => this.share(type, source, body));
    }
    joinNext() {
        if (this.pendingJoins.length) {
            this.joining = this.pendingJoins.shift();
            this.send(Mcs.joinRequest(this.userId, this.joining));
            return;
        }
        this.channels.forEach((name, index) => {
            const id = this.channelIds[index], send = data => this.staticChannels.transmit(id, data);
            if (name === 'cliprdr') {
                this.clipboard = new ClipboardChannel(send, (kind, value) => this.emit({ ...value, type: 'clipboard', kind }));
                this.staticChannels.register(id, this.clipboard);
            }
            if (name === 'drdynvc') {
                const factories = new Map([[DISPLAY_CHANNEL, sendDisplay => {
                            this.display = new DisplayControl(sendDisplay, value => this.emit({ ...value, kind: value.type, type: 'display' }));
                            return this.display;
                        }]]);
                this.dynamic = new DynamicChannels(send, factories, value => this.emit({ ...value, kind: value.type, type: 'dynamic' }));
                this.staticChannels.register(id, this.dynamic);
            }
        });
        this.transition('licensing');
        const info = clientInfo({ ...this.options, nla: this.options.selectedProtocol !== 1 });
        this.channelSend(this.ioChannel, info);
        info.fill(0);
        this.options.password = '';
    }
    license(bytes) {
        const r = new Reader(bytes), type = r.u8(), version = r.u8(), size = r.u16le();
        requireThat(size === bytes.length && (version & 15) >= 2 && (version & 15) <= 3, 'LICENSE_HEADER', 'Invalid licensing header');
        if (type !== 0xff)
            throw new ProtocolError('LICENSE_PROFILE', 'This build handles valid-client licensing only; new RDS CAL issuance and license storage are not implemented');
        const code = r.u32le(), transition = r.u32le(), blobType = r.u16le(), blob = r.take(r.u16le());
        r.end();
        requireThat(code === 7 && transition === 2 && blobType === 4, 'LICENSE_ERROR', `Server licensing error ${code}, transition ${transition}`);
        this.emit({ type: 'licensing', status: 'valid-client', blobBytes: blob.length });
    }
    share(type, source, body) {
        if (type === 1) {
            requireThat(['licensing', 'active', 'reactivating'].includes(this.state), 'ACTIVATION_STATE', 'Unexpected Demand Active');
            const demand = parseDemandActive(body);
            this.shareId = demand.shareId;
            this.serverId = source;
            this.inputFlags = demand.inputFlags;
            this.desktop = { width: demand.width, height: demand.height };
            this.options.width = demand.width;
            this.options.height = demand.height;
            // Advertise exactly the implemented bitmap profile, even if the server initially offers 32bpp.
            this.emit({ type: 'desktop', ...this.desktop, bpp: this.options.bpp });
            this.transition('activating');
            this.channelSend(this.ioChannel, shareControl(3, this.userId, confirmActiveBody(this.shareId, this.userId, this.options)));
            this.dataSend(31, new Writer().u16le(1).u16le(this.serverId).finish());
            this.dataSend(20, new Writer().u16le(4).u16le(0).u32le(0).finish());
            this.dataSend(20, new Writer().u16le(1).u16le(0).u32le(0).finish());
            this.dataSend(39, new Writer().u16le(0).u16le(0).u16le(3).u16le(50).finish());
            return;
        }
        if (type === 6) {
            requireThat(this.desktop, 'DEACTIVATION_STATE', 'Deactivation before activation');
            this.fastPath.clear();
            this.pointer.clear();
            this.transition('reactivating');
            return;
        }
        requireThat(type === 7, 'SHARE_TYPE', `Unsupported Share Control PDU ${type}`);
        const p = parseShareData(body);
        if (this.shareId !== undefined)
            requireThat(p.shareId === this.shareId, 'SHARE_ID', 'Mismatched desktop share');
        switch (p.type) {
            case 2:
                this.update(p.data);
                break;
            case 20: {
                const r = new Reader(p.data), action = r.u16le();
                r.u16le();
                r.u32le();
                r.end();
                this.emit({ type: 'control', action });
                break;
            }
            case 27:
                this.slowPointer(p.data);
                break;
            case 31: {
                const r = new Reader(p.data);
                requireThat(r.u16le() === 1, 'SYNCHRONIZE', 'Invalid synchronization message');
                r.u16le();
                r.end();
                break;
            }
            case 40: {
                requireThat(this.state === 'activating', 'FONT_MAP_STATE', 'Unexpected font map');
                const r = new Reader(p.data);
                r.u16le();
                r.u16le();
                r.u16le();
                r.u16le();
                r.end();
                this.transition('active');
                this.input([{ type: 'sync', toggles: 0 }]);
                break;
            }
            case 38:
                this.emit({ type: 'logon-info', bytes: p.data.length });
                break; // Never log cookies / account data.
            case 47: {
                const r = new Reader(p.data), code = r.u32le();
                r.end();
                if (code)
                    throw new ProtocolError('SERVER_ERROR', `Server error-info 0x${code.toString(16).padStart(8, '0')}`);
                break;
            }
            case 55:
                this.emit({ type: 'server-status', bytes: p.data.length });
                break;
            case 36:
                this.emit({ type: 'bell' });
                break;
            default: throw new ProtocolError('DATA_PDU', `Unimplemented Share Data PDU ${p.type}`);
        }
    }
    update(bytes) {
        requireThat(this.desktop, 'GRAPHICS_STATE', 'Graphics before a desktop was negotiated');
        const r = new Reader(bytes), type = r.u16le();
        if (type === 1) {
            const rectangles = parseBitmapUpdate(r, this.desktop);
            for (const rect of rectangles)
                this.bitmapBytes += rect.data.length;
            this.emit({ type: 'bitmaps', rectangles });
        }
        else if (type === 2)
            this.emit({ type: 'palette', palette: parsePalette(r) });
        else if (type === 3) {
            r.u16le();
            r.end();
        }
        else if (type === 0) {
            r.u16le();
            const count = r.u16le();
            r.u16le();
            requireThat(count === 0, 'UNNEGOTIATED_ORDERS', 'Server sent GDI orders that were not advertised');
            r.end();
        }
        else
            throw new ProtocolError('UPDATE_TYPE', `Unsupported update ${type}`);
    }
    fastUpdate(code, bytes) {
        if (code === 1 || code === 2) {
            const r = new Reader(bytes);
            requireThat(r.u16le() === code, 'UPDATE_CODE', 'Fast-path update type mismatch');
            this.update(bytes);
        }
        else if (code === 3) {
            requireThat(bytes.length === 0, 'FASTPATH_SYNC', 'Invalid fast-path synchronization');
        }
        else if (code === 5 || code === 6) {
            requireThat(bytes.length === 0, 'POINTER_SYSTEM', 'Invalid system pointer');
            this.emit({ type: 'pointer', kind: code === 5 ? 'hidden' : 'default' });
        }
        else if (code === 8)
            this.pointer.position(bytes);
        else if (code === 9)
            this.pointer.shape(bytes, false);
        else if (code === 10)
            this.pointer.cached(bytes);
        else if (code === 11)
            this.pointer.shape(bytes, true);
        else
            throw new ProtocolError('FASTPATH_UPDATE', `Unnegotiated fast-path update ${code}`);
    }
    slowPointer(bytes) {
        const r = new Reader(bytes), type = r.u16le();
        r.u16le();
        const data = r.take(r.remaining);
        if (type === 1)
            this.pointer.system(data);
        else if (type === 3)
            this.pointer.position(data);
        else if (type === 6)
            this.pointer.shape(data, false);
        else if (type === 7)
            this.pointer.cached(data);
        else if (type === 8)
            this.pointer.shape(data, true);
        else
            throw new ProtocolError('POINTER_TYPE', `Unsupported pointer ${type}`);
    }
    channelSend(id, data) { this.send(Mcs.sendData(this.userId, id, data)); }
    dataSend(type, bytes) { this.channelSend(this.ioChannel, shareData(this.shareId, this.userId, type, bytes)); }
    input(events) {
        if (this.state !== 'active' || !events.length)
            return;
        this.dataSend(28, encodeInput(events));
    }
    text(text) {
        requireThat(this.inputFlags & 0x10, 'UNICODE_INPUT', 'Server did not advertise Unicode keyboard input');
        const events = unicodeEvents(text);
        for (let i = 0; i < events.length; i += 128)
            this.input(events.slice(i, i + 128));
    }
    setClipboard(text) { requireThat(this.clipboard, 'CLIPBOARD_DISABLED', 'Clipboard was not enabled'); this.clipboard.setText(text); }
    resize(width, height, scale) { requireThat(this.display, 'DISPLAY_DISABLED', 'Server did not open display control'); this.display.resize(width, height, scale); }
    refresh() {
        if (this.state === 'active')
            this.dataSend(33, new Writer().u8(1).zeros(3).u16le(0).u16le(0).u16le(this.desktop.width - 1).u16le(this.desktop.height - 1).finish());
    }
    stats() { return { receivedBytes: this.receivedBytes, packets: this.receivedPackets, bitmapBytes: this.bitmapBytes, state: this.state }; }
    fail(error) {
        if (this.state === 'failed' || this.state === 'closed')
            return;
        this.transition('failed');
        this.dispose();
        this.emit({ type: 'error', code: error.code || 'PROTOCOL_ERROR', message: error.message });
    }
    dispose() { this.options.password = ''; this.staticChannels.close(); this.fastPath.clear(); this.framer.clear(); this.pointer.clear(); }
    close() {
        if (this.state === 'closed')
            return;
        this.transition('closed');
        this.dispose();
    }
}

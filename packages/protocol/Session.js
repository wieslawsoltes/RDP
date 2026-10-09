import { GdiOrders } from '../render/gdi/Orders.js';
import { parseServerMonitorLayout } from './MonitorLayout.js';
import { MppcDecoder } from '../codecs/Mppc.js';
import { SurfaceCommands } from './SurfaceCommands.js';
import { negotiateSurfaceGraphics } from './SurfaceCapabilities.js';
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
import { AudioInputChannel, AUDIO_INPUT_CHANNEL } from '../channels/AudioInputChannel.js';
import { AudioOutputChannel } from '../channels/AudioOutputChannel.js';
import { ClipboardChannel } from '../channels/ClipboardChannel.js';
import { DynamicChannels } from '../channels/DynamicChannels.js';
import { DisplayControl, DISPLAY_CHANNEL } from '../channels/DisplayControl.js';
/** Post-TLS client. No transport, DOM, graphics, or platform dependencies. */
export class Session {
    constructor({ send, emit = () => { }, options = {}, canSendAudioInput = () => true }) {
        this.send = send;
        this.emit = emit;
        this.options = { width: 1280, height: 800, bpp: 24, clipboard: true, resize: true, selectedProtocol: 2, requestedProtocols: 2, ...options };
        this.options.audio = this.options.audio === true;
        this.options.orders = this.options.orders === true;
        this.gdi = null;
        this.options.microphone = this.options.microphone === true;
        this.canSendAudioInput = canSendAudioInput; this.nextMicrophoneRequest = 0;
        this.state = 'new'; this.nextSurfaceToken = 0;
        this.licensingComplete = false;
        this.gatewayLicensing = this.options.licensing === 'gateway-v1';
        this.channels = [...(this.options.clipboard ? ['cliprdr'] : []), ...(this.options.resize || this.options.microphone ? ['drdynvc'] : []), ...(this.options.audio ? ['rdpsnd'] : [])];
        this.framer = new Framer((packet, kind) => this.packet(packet, kind));
        this.bulk = this.options.compression === false ? null : new MppcDecoder();
        this.fastPath = new FastPath((code, bytes) => this.fastUpdate(code, bytes), 16 * 1024 * 1024, this.bulk);
        this.pointer = new PointerCache(value => this.emit({ ...value, kind: value.type, type: 'pointer' }));
        this.staticChannels = new StaticChannels((id, bytes) => this.channelSend(id, bytes), 16 * 1024 * 1024, this.bulk);
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
            requireThat(this.licensingComplete, 'LICENSE_INCOMPLETE', 'Channel data before licensing completed');
            this.staticChannels.receive(channelId, data);
            return;
        }
        // Enhanced RDP security retains a Basic Security Header on licensing packets only.
        if (data.length >= 4 && ((data[0] | data[1] << 8) & 0x80) && data[2] === 0 && data[3] === 0) {
            requireThat(((data[0] | data[1] << 8) & ~0x2b0) === 0, 'LICENSE_SECURITY', 'Unsupported licensing security flags');
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
                this.clipboard = new ClipboardChannel(send, (kind, value) => this.emit({ ...value, type: 'clipboard', kind }), { rich: this.options.richClipboard === true });
                this.staticChannels.register(id, this.clipboard);
            }
            if (name === 'rdpsnd') {
                this.audio = new AudioOutputChannel(send, value => this.emit({ ...value, type: 'audio' }));
                this.staticChannels.register(id, this.audio);
            }
            if (name === 'drdynvc') {
                const factories = new Map(this.options.resize ? [[DISPLAY_CHANNEL, sendDisplay => {
                            this.display = new DisplayControl(sendDisplay, value => this.emit({ ...value, kind: value.type, type: 'display' }));
                            return this.display;
                        }]] : []);
                if (this.options.microphone) factories.set(AUDIO_INPUT_CHANNEL, sendInput => {
                    if (this.microphone && this.microphone.state !== 'closed') return null;
                    this.microphone = new AudioInputChannel(sendInput, value => this.emit({ ...value, type: 'microphone' }), {
                        nextRequest: () => ++this.nextMicrophoneRequest,
                        canSend: bytes => !this.staticChannels.suspended && this.canSendAudioInput(bytes),
                    });
                    return this.microphone;
                });
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
    licensingResult(control) {
        requireThat(this.gatewayLicensing && this.state === 'licensing' && !this.licensingComplete, 'LICENSE_STATE', 'Unexpected gateway licensing result');
        const complete = ['valid-client', 'license-issued', 'license-upgraded'];
        const pending = ['requesting-license', 'cached-license', 'challenge-verified', 'reset', 'resent'];
        requireThat(control && typeof control.complete === 'boolean' &&
            (control.complete ? complete : pending).includes(control.status), 'LICENSE_RESULT', 'Invalid gateway licensing result');
        this.licensingComplete = control.complete;
        this.emit({ type: 'licensing', status: control.status, complete: control.complete });
    }
    license(bytes) {
        requireThat(!this.gatewayLicensing && this.state === 'licensing' && !this.licensingComplete, 'LICENSE_STATE', 'Unexpected direct licensing PDU');
        const r = new Reader(bytes), type = r.u8(), version = r.u8(), size = r.u16le();
        requireThat(size === bytes.length && (version & 15) >= 2 && (version & 15) <= 3, 'LICENSE_HEADER', 'Invalid licensing header');
        if (type !== 0xff)
            throw new ProtocolError('LICENSE_PROFILE', 'This direct transport handles valid-client alerts only; use the current local gateway for CAL issuance and persistence');
        const code = r.u32le(), transition = r.u32le(), blobType = r.u16le(), blob = r.take(r.u16le());
        r.end();
        requireThat(code === 7 && transition === 2 && blobType === 4, 'LICENSE_ERROR', `Server licensing error ${code}, transition ${transition}`);
        this.licensingComplete = true;
        this.emit({ type: 'licensing', status: 'valid-client', complete: true, blobBytes: blob.length });
    }
    share(type, source, body) {
        if (type === 1) {
            requireThat(this.licensingComplete, 'LICENSE_INCOMPLETE', 'Server sent Demand Active before licensing completed');
            requireThat(['licensing', 'active', 'reactivating'].includes(this.state), 'ACTIVATION_STATE', 'Unexpected Demand Active');
            const demand = parseDemandActive(body);
            this.shareId = demand.shareId;
            this.serverId = source;
            this.inputFlags = demand.inputFlags;
            this.monitorLayout = null;
            this.desktop = { width: demand.width, height: demand.height };
            this.options.width = demand.width;
            this.options.height = demand.height;
            // A server that cannot offer 32 bpp selects the negotiated fallback.
            if (this.options.bpp === 32 && demand.bpp !== 32) this.options.bpp = demand.bpp;
            const hostCache = demand.map.get(18);
            if (hostCache && this.options.orders) requireThat(hostCache.length === 4 && hostCache[0] === 1, 'GDI_CACHE_HOST', 'Invalid bitmap-cache host capability');
            this.options.orderCacheRevision = hostCache ? 2 : 1;
            const gdiEnabled = this.options.orders && [24, 32].includes(this.options.bpp) && this.options.bpp === demand.bpp;
            if (this.gdi && (!gdiEnabled || this.gdi.bpp !== this.options.bpp || this.gdi.revision !== this.options.orderCacheRevision)) {
                this.gdi.close(); this.gdi = null;
            }
            if (gdiEnabled) {
                if (this.gdi) this.gdi.resize(demand.width, demand.height);
                else this.gdi = new GdiOrders({ ...this.desktop, bpp: this.options.bpp, revision: this.options.orderCacheRevision });
            }
            this.emit({ type: 'drawing-profile', enabled: !!this.gdi, cacheRevision: this.gdi?.revision || null });
            this.surface?.close();
            this.surfaceProfile = negotiateSurfaceGraphics(demand.map, { ...this.options, bpp: this.options.bpp });
            this.surface = this.surfaceProfile.flags ? new SurfaceCommands({ desktop: this.desktop, profile: this.surfaceProfile,
                observe: bitmap => this.gdi?.bitmap([bitmap]),
                emit: value => this.emit(value), nextToken: () => ++this.nextSurfaceToken,
                acknowledge: id => this.dataSend(56, new Writer().u32le(id).finish()) }) : null;
            this.emit({ type: 'graphics', ...this.surfaceProfile });
            this.emit({ type: 'desktop', ...this.desktop, bpp: this.options.bpp });
            this.transition('activating');
            this.channelSend(this.ioChannel, shareControl(3, this.userId, confirmActiveBody(this.shareId, this.userId, { ...this.options, surfaceProfile: this.surfaceProfile, orders: !!this.gdi })));
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
            this.surface?.close(); this.surface = null;
            this.transition('reactivating');
            return;
        }
        requireThat(type === 7, 'SHARE_TYPE', `Unsupported Share Control PDU ${type}`);
        const p = parseShareData(body, this.bulk);
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
            case 55: {
                const layout = parseServerMonitorLayout(p.data);
                requireThat(this.desktop && layout.width === this.desktop.width && layout.height === this.desktop.height,
                    'MONITOR_DESKTOP', 'Server monitor bounds differ from the negotiated desktop');
                this.monitorLayout = layout;
                this.emit({ type: 'monitor-layout', ...layout });
                break;
            }
            case 34: {
                const r = new Reader(p.data), duration = r.u32le(), frequency = r.u32le(); r.end();
                this.emit({ type: 'bell', duration, frequency }); break;
            }
            case 54: {
                const r = new Reader(p.data), status = r.u32le(); r.end();
                this.emit({ type: 'status', status }); break;
            }
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
            if (this.surface?.current) {
                try { for (const rect of rectangles) this.surface.addBitmap(rect); }
                catch (error) { for (const rect of rectangles) if (rect.data.byteLength) rect.data.fill(0); throw error; }
            } else { this.gdi?.bitmap(rectangles); this.emit({ type: 'bitmaps', rectangles }); }
        }
        else if (type === 2) {
            requireThat(!this.surface?.current, 'SURFACE_PALETTE', 'Palette changes inside marked surface frames are unsupported');
            const palette = parsePalette(r); this.gdi?.setPalette(palette);
            this.emit({ type: 'palette', palette });
        }
        else if (type === 3) {
            r.u16le();
            r.end();
        }
        else if (type === 0) {
            r.u16le();
            const count = r.u16le();
            r.u16le();
            this.orderUpdate(r, count);
        }
        else
            throw new ProtocolError('UPDATE_TYPE', `Unsupported update ${type}`);
    }
    orderUpdate(r, count) {
        requireThat(this.desktop && ['active', 'activating'].includes(this.state), 'GRAPHICS_STATE', 'Orders outside an activated desktop');
        if (!this.gdi) { requireThat(count === 0, 'UNNEGOTIATED_ORDERS', 'Server sent GDI orders that were not advertised'); r.end(); return; }
        const rectangles = this.gdi.receive(r, count);
        if (this.surface?.current) {
            try { for (const rect of rectangles) this.surface.addBitmap(rect, false); }
            catch (error) { for (const rect of rectangles) if (rect.data.byteLength) rect.data.fill(0); throw error; }
        } else if (rectangles.length) this.emit({ type: 'bitmaps', rectangles, source: 'gdi' });
    }
    fastUpdate(code, bytes) {
        if (code === 0) { const r = new Reader(bytes), count = r.u16le(); this.orderUpdate(r, count); }
        else if (code === 1 || code === 2) {
            const r = new Reader(bytes);
            requireThat(r.u16le() === code, 'UPDATE_CODE', 'Fast-path update type mismatch');
            this.update(bytes);
        }
        else if (code === 4) {
            requireThat(this.surface, 'SURFACE_UNNEGOTIATED', 'Server sent unnegotiated surface updates');
            this.surface.receive(bytes);
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
        else if (code === 12)
            this.pointer.large(bytes);
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
    presentSurface(token) { return this.surface?.presented(token) || false; }
    checkGraphicsDeadline() { this.surface?.checkDeadline(); }
    microphoneReady(requestId, captureId, result) {
        const accepted = this.microphone?.ready(requestId, captureId, result) === true;
        this.emit({ type: 'microphone', kind: 'ready-result', requestId, captureId, accepted });
    }
    microphoneData(value) { return this.state === 'active' && !!this.microphone?.capture(value); }
    microphoneStop(requestId, captureId) { return this.microphone?.pause(requestId, captureId); }
    consumeAudio(id, disposition) { return this.audio?.consume(id, disposition) || false; }
    setClipboard(text) { requireThat(this.clipboard, 'CLIPBOARD_DISABLED', 'Clipboard was not enabled'); this.clipboard.setText(text); }
    setClipboardContent(content) { requireThat(this.state === 'active' && this.clipboard, 'CLIPBOARD_DISABLED', 'An active clipboard channel is required'); this.clipboard.setContent(content); }
    requestClipboardFormat(kind) { requireThat(this.state === 'active' && this.clipboard, 'CLIPBOARD_DISABLED', 'An active clipboard channel is required'); return this.clipboard.requestFormat(kind); }
    setMonitors(monitors) { requireThat(this.state === 'active' && this.display, 'DISPLAY_DISABLED', 'Active display control is required'); return this.display.layout(monitors); }
    resize(width, height, scale) { requireThat(this.display, 'DISPLAY_DISABLED', 'Server did not open display control'); this.display.resize(width, height, scale); }
    refresh() {
        if (this.state === 'active')
            this.dataSend(33, new Writer().u8(1).zeros(3).u16le(0).u16le(0).u16le(this.desktop.width - 1).u16le(this.desktop.height - 1).finish());
    }
    stats() { return { receivedBytes: this.receivedBytes, packets: this.receivedPackets, bitmapBytes: this.bitmapBytes, state: this.state, graphics: this.surface?.stats() || null, gdi: this.gdi?.stats() || null, audio: this.audio?.stats() || null, microphone: this.microphone?.stats() || null }; }
    fail(error) {
        if (this.state === 'failed' || this.state === 'closed')
            return;
        this.transition('failed');
        this.dispose();
        this.emit({ type: 'error', code: error.code || 'PROTOCOL_ERROR', message: error.message });
    }
    dispose() { this.gdi?.close(); this.gdi = null; this.surface?.close(); this.surface = null; this.options.password = ''; this.staticChannels.close(); this.bulk?.reset(); this.fastPath.clear(); this.framer.clear(); this.pointer.clear(); }
    close() {
        if (this.state === 'closed')
            return;
        this.transition('closed');
        this.dispose();
    }
}

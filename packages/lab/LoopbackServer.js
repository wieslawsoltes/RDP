import { Reader } from '../binary/Reader.js';
import { Writer, concat, utf16 } from '../binary/Writer.js';
import { sequence, integer, octet, tlv, readTlv } from '../binary/Asn1.js';
import { requireThat } from '../binary/ProtocolError.js';
import { Framer } from '../protocol/Framer.js';
import { dataPdu, unwrapData } from '../protocol/X224.js';
import { parseSendData } from '../protocol/Mcs.js';
import { parseShare, parseShareData, shareControl, shareData } from '../protocol/Share.js';
import { clientCapabilities } from '../protocol/Capabilities.js';
import { userDataBlock } from '../protocol/Gcc.js';
import { StaticChannels } from '../channels/StaticChannels.js';
import { clipboardPdu } from '../channels/ClipboardChannel.js';
import { DISPLAY_CHANNEL, parseDisplayLayout } from '../channels/DisplayControl.js';
import { encodeServerMonitorLayout, parseServerMonitorLayout } from '../protocol/MonitorLayout.js';
import { rgbaToBgr24 } from '../codecs/Pixels.js';
/** Deterministic protocol test peer, NOT an RDP server implementation or a remote OS. */
export class LoopbackServer {
    constructor({ send, width = 1280, height = 800, requestedProtocols = 1, onActive = () => { }, onInput = () => { }, onClipboard = () => { } }) {
        this.send = send;
        this.width = width;
        this.height = height;
        this.requestedProtocols = requestedProtocols;
        this.onActive = onActive;
        this.onInput = onInput;
        this.onClipboard = onClipboard;
        this.userId = 1007;
        this.serverId = 1002;
        this.ioChannel = 1003;
        this.shareId = 0x103ea;
        this.state = 'connect';
        this.channels = [];
        this.framer = new Framer(bytes => this.packet(unwrapData(bytes)));
        this.static = new StaticChannels((id, bytes) => this.indication(id, bytes));
        this.clipboardText = 'Hello from the local RDP protocol lab.\nThis text crossed the CLIPRDR channel.';
    }
    receive(bytes) { this.framer.push(bytes); }
    packet(bytes) {
        if (this.state === 'connect') {
            this.parseInitial(bytes);
            this.state = 'attach';
            const network = new Writer().u16le(this.ioChannel).u16le(this.channels.length);
            this.channels.forEach((_, i) => network.u16le(1004 + i));
            if (this.channels.length & 1)
                network.u16le(0);
            const blocks = concat(userDataBlock(0xc01, new Writer().u32le(0x80004).u32le(this.requestedProtocols).finish()), userDataBlock(0xc02, new Uint8Array(8)), userDataBlock(0xc03, network.finish()));
            const gcc = new Writer().put(Uint8Array.of(0, 5, 0, 0x14, 0x7c, 0, 1, 0x2a, 0x14, 0x76, 0x0a, 1, 1, 0, 1, 0xc0, 0)).ascii('McDn').perLength(blocks.length).put(blocks).finish();
            this.send(dataPdu(tlv(0x7f66, concat(integer(0, 10), integer(0), sequence(...[34, 2, 0, 1, 0, 1, 65535, 2].map(n => integer(n))), octet(gcc)))));
            return;
        }
        if (bytes[0] === 4) {
            requireThat(bytes.length === 5, 'LAB_ERECT', 'Invalid Erect Domain Request');
            return;
        }
        if (bytes[0] === 0x28) {
            this.state = 'join';
            this.send(dataPdu(new Writer().u8(0x2e).u8(0).u16be(this.userId - 1001).finish()));
            return;
        }
        if (bytes[0] === 0x38) {
            const r = new Reader(bytes);
            r.u8();
            const initiator = r.u16be(), id = r.u16be();
            r.end();
            requireThat(initiator + 1001 === this.userId, 'LAB_JOIN', 'Invalid join initiator');
            this.send(dataPdu(new Writer().u8(0x3e).u8(0).u16be(initiator).u16be(id).u16be(id).finish()));
            return;
        }
        const { channelId, data } = parseSendData(bytes, false);
        if (channelId !== this.ioChannel) {
            this.static.receive(channelId, data);
            return;
        }
        if ((data[0] | data[1] << 8) === 0x40 && data[2] === 0 && data[3] === 0) {
            this.registerChannels();
            this.state = 'activating';
            this.indication(this.ioChannel, new Writer().u16le(0x80).u16le(0).u8(0xff).u8(3).u16le(16).u32le(7).u32le(2).u16le(4).u16le(0).finish());
            this.demandActive();
            return;
        }
        parseShare(data, (type, source, body) => {
            requireThat(source === this.userId, 'LAB_SOURCE', 'Invalid client share source');
            if (type === 3) {
                const r = new Reader(body);
                requireThat(r.u32le() === this.shareId && r.u16le() === 1002, 'LAB_CONFIRM', 'Invalid Confirm Active share or originator');
                return;
            }
            requireThat(type === 7, 'LAB_SHARE', 'Unexpected client Share PDU');
            const p = parseShareData(body);
            if (p.type === 31)
                this.data(31, new Writer().u16le(1).u16le(this.userId).finish());
            else if (p.type === 20) {
                const r = new Reader(p.data), action = r.u16le();
                r.u16le();
                r.u32le();
                r.end();
                this.data(20, new Writer().u16le(action === 1 ? 2 : 4).u16le(action === 1 ? this.userId : 0).u32le(action === 1 ? this.serverId : 0).finish());
            }
            else if (p.type === 39) {
                if (this.monitorLayout) this.data(55, encodeServerMonitorLayout(this.monitorLayout.monitors));
                this.data(40, new Writer().u16le(0).u16le(0).u16le(3).u16le(4).finish());
                this.state = 'active';
                this.onActive(this.width, this.height);
                if (!this.channelsStarted) {
                    this.channelsStarted = true;
                    this.startChannels();
                }
            }
            else if (p.type === 28)
                this.input(p.data);
            else if (p.type === 33)
                this.onActive(this.width, this.height);
            else
                throw new Error(`Unexpected lab client PDU ${p.type}`);
        });
    }
    parseInitial(bytes) {
        const r = new Reader(bytes), initial = readTlv(r, 0x7f65).reader;
        r.end();
        readTlv(initial, 4);
        readTlv(initial, 4);
        readTlv(initial, 1);
        for (let i = 0; i < 3; i++)
            readTlv(initial, 0x30);
        const gcc = readTlv(initial, 4).reader;
        initial.end();
        gcc.skip(7);
        const inner = gcc.sub(gcc.perLength());
        gcc.end();
        inner.skip(8);
        requireThat(inner.ascii(4) === 'Duca', 'LAB_GCC', 'Invalid client GCC H.221 key');
        const blocks = inner.sub(inner.perLength());
        inner.end();
        while (blocks.remaining) {
            const type = blocks.u16le(), length = blocks.u16le(), body = blocks.sub(length - 4);
            if (type === 0xc001) {
                body.u32le();
                this.width = body.u16le();
                this.height = body.u16le();
            }
            if (type === 0xc005) {
                requireThat(body.u32le() === 0, 'LAB_MONITOR', 'Reserved monitor flags');
                this.monitorLayout = parseServerMonitorLayout(body.take(body.remaining));
            }
            if (type === 0xc003) {
                const count = body.u32le();
                requireThat(count <= 16, 'LAB_CHANNELS', 'Too many client channels');
                for (let i = 0; i < count; i++) {
                    this.channels.push(body.ascii(8).replace(/\0.*$/, ''));
                    body.u32le();
                }
                body.end();
            }
        }
    }
    indication(channel, bytes) { this.send(dataPdu(new Writer().u8(0x68).u16be(this.serverId - 1001).u16be(channel).u8(0x70).perLength(bytes.length).put(bytes).finish())); }
    data(type, bytes) { this.indication(this.ioChannel, shareData(this.shareId, this.serverId, type, bytes)); }
    demandActive() {
        const caps = clientCapabilities({ width: this.width, height: this.height, bpp: 24 }), all = concat(...caps), source = new TextEncoder().encode('LAB\0');
        const body = new Writer().u32le(this.shareId).u16le(source.length).u16le(all.length + 4).put(source).u16le(caps.length).u16le(0).put(all).u32le(0).finish();
        this.indication(this.ioChannel, shareControl(1, this.serverId, body));
    }
    registerChannels() {
        this.channels.forEach((name, index) => {
            const id = 1004 + index;
            if (name === 'cliprdr') {
                this.clipboardId = id;
                this.static.register(id, { receive: bytes => this.clipboardReceive(bytes) });
            }
            else if (name === 'drdynvc') {
                this.dynamicId = id;
                this.static.register(id, { receive: bytes => this.dynamicReceive(bytes) });
            }
        });
    }
    startChannels() {
        if (this.clipboardId) {
            this.clip(7, 0, new Writer().u16le(1).u16le(0).u16le(1).u16le(12).u32le(2).u32le(2).finish());
            this.clip(1, 0);
            this.advertiseClipboard();
        }
        if (this.dynamicId)
            this.static.transmit(this.dynamicId, new Writer().u8(0x50).u8(0).u16le(2).zeros(8).finish());
    }
    clip(type, flags = 0, body = new Uint8Array()) { this.static.transmit(this.clipboardId, clipboardPdu(type, flags, body)); }
    advertiseClipboard() {
        if (this.clipboardId)
            this.clip(2, 0, new Writer().u32le(13).u16le(0).finish());
    }
    clipboardReceive(bytes) {
        const r = new Reader(bytes), type = r.u16le(), flags = r.u16le(), size = r.u32le();
        requireThat(size === r.remaining, 'LAB_CLIP', 'Invalid clipboard length');
        if (type === 2) {
            this.clip(3, 1);
            if (r.remaining >= 4 && r.u32le() === 13)
                this.clip(4, 0, new Writer().u32le(13).finish());
        }
        else if (type === 4) {
            const format = r.u32le();
            r.end();
            this.clip(5, format === 13 ? 1 : 2, format === 13 ? utf16(this.clipboardText.replace(/\r?\n/g, '\r\n'), true) : new Uint8Array());
        }
        else if (type === 5 && flags === 1) {
            this.clipboardText = r.utf16(r.remaining).replace(/\0$/, '').replace(/\r\n/g, '\n');
            this.onClipboard(this.clipboardText);
        }
    }
    dynamicReceive(bytes) {
        const r = new Reader(bytes), header = r.u8(), command = header >>> 4;
        if (command === 5) {
            r.u8();
            requireThat(r.u16le() === 2, 'LAB_DVC', 'Invalid DVC version');
            r.end();
            this.static.transmit(this.dynamicId, new Writer().u8(0x10).u8(1).ascii(DISPLAY_CHANNEL).u8(0).finish());
        }
        else if (command === 1) {
            requireThat(r.u8() === 1 && r.u32le() === 0, 'LAB_DVC', 'Display channel was rejected');
            r.end();
            this.static.transmit(this.dynamicId, new Writer().u8(0x30).u8(1).u32le(5).u32le(20).u32le(16).u32le(8192).u32le(8192).finish());
        }
        else if (command === 3) {
            requireThat(r.u8() === 1, 'LAB_DISPLAY', 'Unknown display channel');
            const layout = parseDisplayLayout(r.take(r.remaining));
            this.monitorLayout = layout;
            this.width = layout.width;
            this.height = layout.height;
            this.state = 'activating';
            this.indication(this.ioChannel, shareControl(6, this.serverId, new Writer().u32le(this.shareId).u16le(0).finish()));
            this.demandActive();
        }
    }
    input(bytes) {
        const r = new Reader(bytes), count = r.u16le();
        r.u16le();
        requireThat(count <= 128, 'LAB_INPUT', 'Invalid input batch');
        const events = [];
        for (let i = 0; i < count; i++) {
            const time = r.u32le(), type = r.u16le(), flags = r.u16le(), a = r.u16le(), b = r.u16le();
            events.push({ time, type, flags, a, b });
        }
        r.end();
        this.onInput(events);
    }
    bitmap(x, y, width, height, rgba) {
        requireThat(this.state === 'active', 'LAB_STATE', 'Lab desktop not active');
        for (let top = 0; top < height; top += 64)
            for (let left = 0; left < width; left += 128) {
                const w = Math.min(128, width - left), h = Math.min(64, height - top), tile = new Uint8Array(w * h * 4);
                for (let row = 0; row < h; row++)
                    tile.set(rgba.subarray(((top + row) * width + left) * 4, ((top + row) * width + left + w) * 4), row * w * 4);
                const packed = rgbaToBgr24(tile, w, h);
                const update = new Writer().u16le(1).u16le(1).u16le(x + left).u16le(y + top).u16le(x + left + w - 1).u16le(y + top + h - 1).u16le(w).u16le(h).u16le(24).u16le(0).u16le(packed.length).put(packed).finish();
                this.data(2, update);
            }
    }
    close() { this.state = 'closed'; this.static.close(); this.framer.clear(); }
}

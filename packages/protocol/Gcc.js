import { Writer, concat } from '../binary/Writer.js';
import { Reader } from '../binary/Reader.js';
import { normalizeMonitorLayout, writeMonitorDefinitions } from './MonitorLayout.js';
import { requireThat } from '../binary/ProtocolError.js';
export const GccType = Object.freeze({ CORE: 0xc001, SECURITY: 0xc002, NETWORK: 0xc003 });
export function userDataBlock(type, body) { return new Writer(body.length + 4).u16le(type).u16le(body.length + 4).put(body).finish(); }
export function clientCore({ width = 1280, height = 800, bpp = 24, keyboardLayout = 0x409, selectedProtocol = 2 } = {}) {
    requireThat(Number.isInteger(width) && Number.isInteger(height) && width >= 200 && height >= 200 && width <= 8192 && height <= 8192 && width * height <= 16777216, 'DESKTOP_LIMIT', 'Desktop must fit 200–8192 pixels per axis and 16 megapixels');
    requireThat([15, 16, 24, 32].includes(bpp), 'BPP', 'This connection profile negotiates 15, 16, 24 or 32 bpp');
    const w = new Writer(216).u32le(0x80004).u16le(width).u16le(height).u16le(0xca01).u16le(0xaa03)
        .u32le(keyboardLayout).u32le(1).fixedUtf16('LRDP-WEB', 32)
        .u32le(4).u32le(0).u32le(12).zeros(64)
        .u16le(0xca01).u16le(1).u32le(0).u16le(Math.min(24, bpp)).u16le(15)
        .u16le(0x61 | (bpp === 32 ? 2 : 0)).zeros(64).u8(6).u8(0).u32le(selectedProtocol);
    return userDataBlock(GccType.CORE, w.finish());
}
export function conferenceRequest(options, channels) {
    requireThat(channels.length <= 16, 'CHANNEL_LIMIT', 'Too many static channels');
    const net = new Writer().u32le(channels.length);
    for (const channel of channels) {
        requireThat(/^[a-z0-9]{1,7}$/.test(channel), 'CHANNEL_NAME', 'Invalid static channel name');
        // Server-to-client virtual channels share the negotiated RDP bulk history.
        net.ascii(channel).zeros(8 - channel.length).u32le(options.compression === false ? 0x88000000 : 0x88800000);
    }
    let monitorData = new Uint8Array(), coreOptions = options;
    if (options.monitors) {
        requireThat((options.flags & 1) !== 0, 'MONITOR_NEGOTIATION', 'Server did not advertise extended client data');
        const layout = normalizeMonitorLayout(options.monitors);
        coreOptions = { ...options, width: layout.width, height: layout.height };
        const definitions = writeMonitorDefinitions(new Writer().u32le(0).u32le(layout.monitors.length), layout);
        const attributes = new Writer().u32le(0).u32le(20).u32le(layout.monitors.length);
        for (const m of layout.monitors)
            attributes.u32le(m.physicalWidth).u32le(m.physicalHeight).u32le(m.orientation)
                .u32le(m.desktopScaleFactor).u32le(m.deviceScaleFactor);
        monitorData = concat(userDataBlock(0xc005, definitions.finish()), userDataBlock(0xc008, attributes.finish()));
    }
    const blocks = concat(clientCore(coreOptions), userDataBlock(GccType.SECURITY, new Uint8Array(8)), userDataBlock(GccType.NETWORK, net.finish()), monitorData);
    const inner = new Writer().put(Uint8Array.of(0, 8, 0, 16, 0, 1, 0xc0, 0)).ascii('Duca').perLength(blocks.length).put(blocks).finish();
    return new Writer().put(Uint8Array.of(0, 5, 0, 0x14, 0x7c, 0, 1)).perLength(inner.length).put(inner).finish();
}
export function parseConferenceResponse(bytes, { requestedProtocols, expectedChannels }) {
    const r = new Reader(bytes);
    for (const b of [0, 5, 0, 0x14, 0x7c, 0, 1])
        r.expect(b);
    r.perLength(); // The GCC connectPDU length is explicitly ignored by RDP clients.
    r.expect(0x14);
    r.u16be();
    const tagLength = r.u8();
    requireThat(tagLength >= 1 && tagLength <= 4, 'GCC_TAG', 'Invalid GCC tag');
    r.skip(tagLength);
    r.expect(0).expect(1).expect(0xc0).expect(0);
    requireThat(r.ascii(4) === 'McDn', 'GCC_KEY', 'Invalid server H.221 key');
    const blocks = r.sub(r.perLength());
    r.end();
    const result = { channels: [], ioChannel: 0, version: 0 };
    const seen = new Set();
    while (blocks.remaining) {
        const type = blocks.u16le(), size = blocks.u16le();
        requireThat(size >= 4 && !seen.has(type), 'GCC_BLOCK', 'Invalid or duplicate GCC block');
        seen.add(type);
        const body = blocks.sub(size - 4);
        if (type === 0x0c01) {
            result.version = body.u32le();
            requireThat(body.remaining >= 4, 'SECURITY_REPLAY', 'Server omitted the security negotiation replay');
            requireThat(body.u32le() === requestedProtocols, 'SECURITY_REPLAY', 'Security negotiation replay mismatch');
        }
        else if (type === 0x0c02) {
            requireThat(body.u32le() === 0 && body.u32le() === 0, 'SECURITY', 'Unexpected standard RDP encryption under TLS');
            body.end();
        }
        else if (type === 0x0c03) {
            result.ioChannel = body.u16le();
            const count = body.u16le();
            requireThat(count === expectedChannels, 'CHANNEL_COUNT', 'Server static channel count differs from the request');
            for (let i = 0; i < count; i++)
                result.channels.push(body.u16le());
            if (count % 2)
                body.u16le();
            body.end();
        }
    }
    requireThat(seen.has(0xc01) && seen.has(0xc02) && seen.has(0xc03), 'GCC_REQUIRED', 'Server omitted a required GCC block');
    requireThat(result.ioChannel >= 1001 && new Set([result.ioChannel, ...result.channels]).size === result.channels.length + 1 && result.channels.every(id => id >= 1001), 'CHANNEL_ID', 'Invalid or duplicate server channel IDs');
    return result;
}

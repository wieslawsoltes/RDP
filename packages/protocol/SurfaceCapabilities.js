import { Reader } from '../binary/Reader.js';
import { Writer } from '../binary/Writer.js';
import { requireThat } from '../binary/ProtocolError.js';

// GUID fields Data1/Data2/Data3 are little-endian on the RDP wire.
export const NSCODEC_GUID = Object.freeze([0xb9,0x1b,0x8d,0xca,0x0f,0x00,0x4f,0x15,0x58,0x9f,0xae,0x2d,0x1a,0x87,0xe2,0xd6]);
export const SURFACE_COMMAND_FLAGS = 0x52;
export const SURFACE_FRAME_WINDOW = 2;
export const MAX_SURFACE_UPDATE = 16 * 1024 * 1024;

/** Only advertise the intersection of enabled client code and server support.
 * NSCodec MUST use client codec ID 1; server-assigned codec IDs are ignored.
 */
export function negotiateSurfaceGraphics(map, options) {
    const profile = { flags: 0, nsCodec: false, frameAcks: false, maxColorLoss: 1, allowSubsampling: false };
    if (options.surfaceGraphics !== true || options.bpp !== 32 || !map.has(28)) return profile;
    const surface = new Reader(map.get(28)); profile.flags = surface.u32le() & SURFACE_COMMAND_FLAGS; surface.u32le(); surface.end();
    if (!(profile.flags & 0x42)) { profile.flags = 0; return profile; }
    if (map.has(26)) {
        const mf = new Reader(map.get(26)), requested = mf.u32le(); mf.end();
        // Do not claim capacity for the server's larger multi-fragment profile.
        if (requested > MAX_SURFACE_UPDATE) { profile.flags = 0; return profile; }
    }
    if (map.has(30) && (profile.flags & 0x10)) {
        const ack = new Reader(map.get(30)); ack.u32le(); ack.end(); profile.frameAcks = true;
    }
    if (map.has(29)) {
        const codecs = new Reader(map.get(29)), count = codecs.u8();
        requireThat(count <= 64, 'SURFACE_CODECS', 'Excessive bitmap codec capability count');
        for (let i = 0; i < count; i++) {
            const guid = codecs.take(16); codecs.u8(); const properties = codecs.sub(codecs.u16le());
            if (guid.every((v, k) => v === NSCODEC_GUID[k])) {
                requireThat(!profile.nsCodec, 'SURFACE_CODECS', 'Duplicate NSCodec capability');
                const fidelity = properties.u8(), sampling = properties.u8(), loss = properties.u8(); properties.end();
                requireThat(fidelity <= 1 && sampling <= 1 && loss >= 1 && loss <= 7, 'SURFACE_CODECS', 'Invalid NSCodec properties');
                profile.nsCodec = true;
                if (options.surfaceQuality === 'balanced') {
                    profile.maxColorLoss = fidelity ? Math.min(loss, 3) : 1;
                    profile.allowSubsampling = sampling === 1;
                }
            }
        }
        codecs.end();
    }
    return profile;
}
export function surfaceCapabilityBodies(profile) {
    if (!profile?.flags) return [];
    const result = [[28, new Writer().u32le(profile.flags).u32le(0).finish()]];
    if (profile.nsCodec) result.push([29, new Writer().u8(1).put(Uint8Array.from(NSCODEC_GUID))
        .u8(1).u16le(3).u8(profile.maxColorLoss > 1 ? 1 : 0).u8(+profile.allowSubsampling).u8(profile.maxColorLoss).finish()]);
    if (profile.frameAcks) result.push([30, new Writer().u32le(SURFACE_FRAME_WINDOW).finish()]);
    return result;
}

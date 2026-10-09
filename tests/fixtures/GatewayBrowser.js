import { configureSurfacePeer, surfaceBits, surfaceMarker } from './SurfacePeer.js';
import { concat } from '../../packages/binary/Writer.js';
import * as GdiWire from './GdiWire.js';
import { configureGdiPeer } from './GdiPeer.js';
import { configureMicrophonePeer } from './MicrophonePeer.js';
import { configureAudioPeer } from './AudioPeer.js';
import { configureRichClipboard } from './RichClipboardPeer.js';
import { makeCertificate, serveRdp } from './NetworkServer.js';
import { createBridge } from '../../apps/bridge/server.js';
const cert = await makeCertificate();
const remote = await serveRdp(cert, { nla: true, configurePeer: peer => {
    if (process.env.RDP_SURFACE_FIXTURE === '1') {
        const state = configureSurfacePeer(peer, {
            onAck: id => console.log('SURFACE_ACK', id),
            onConfirm: profile => console.log('SURFACE_PROFILE', JSON.stringify(profile)),
        });
        const raw = (width, height, color) => {
            const data = new Uint8Array(width * height * 4);
            for (let i = 0; i < data.length; i += 4) data.set(color, i);
            return surfaceBits({ width, height, codec: 0, data });
        };
        peer.onActive = () => {
            peer.surface(raw(16, 16, [1, 2, 3, 255]));
            peer.surface(concat(surfaceMarker(0, state.confirms * 100 + 1), surfaceBits({x: 4, y: 5})));
        };
        const input = peer.onInput;
        peer.onInput = events => {
            input(events);
            for (const e of events) if (e.type === 4 && !(e.flags & 0x8000)) {
                const base = state.confirms * 100;
                if (e.a === 0x12) peer.surface(surfaceMarker(1, base + 1)); // e: finish held frame
                if (e.a === 0x21) peer.surface(concat(surfaceMarker(0, base + 2), surfaceBits({x:4,y:5,bpp:24}),
                    surfaceBits({type:6,x:6,y:7,width:2,height:2,drawWidth:1,drawHeight:1,codec:0,
                        data:Uint8Array.from([90,80,70,0,90,80,70,0,90,80,70,0,90,80,70,0]),extra:true}), surfaceMarker(1, base + 2)));
                if (e.a === 0x26) peer.surface(concat(surfaceMarker(0, base + 3), raw(400,400,[40,50,60,255]), surfaceMarker(1, base + 3)));
                if (e.a === 0x22) { // g: NSCodec, GDI and ordinary bitmap in one marked frame
                    peer.surface(concat(surfaceMarker(0, base + 4), surfaceBits({x:4,y:5})));
                    peer.data(2, GdiWire.slowOrders(GdiWire.scr(30,10,7,5,0xcc,4,5), GdiWire.opaque(32,12,1,1,0xabcdef)));
                    peer.bitmap(36,14,1,1,Uint8Array.of(50,60,70,255));
                    peer.surface(surfaceMarker(1, base + 4));
                }
                if (e.a === 0x13) peer.reactivateSurface(); // r
                if (e.a === 0x2d) peer.surface(surfaceBits({codec:99})); // x: unnegotiated codec
                if (e.a === 0x30) console.log('SURFACE_BARRIER', JSON.stringify({acks:state.acks,confirms:state.confirms}));
            }
        };
    }
    if (process.env.RDP_GDI_FIXTURE === '1') configureGdiPeer(peer, { revision: 2, paintOnActive: true });
    if (process.env.RDP_MICROPHONE_FIXTURE === '1') {
        let total = 0, openReplies = 0, nonzero = 0;
        const counts = [0, 0], rms = [0, 0];
        const mic = configureMicrophonePeer(peer, {
            onOpen: result => { openReplies++; console.log('MIC_OPEN', result); },
            onPacket: packet => {
                total++; counts[packet.index]++;
                const view = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.length);
                let power = 0;
                for (let i = 0; i < view.byteLength; i += 2) power += (view.getInt16(i, true) / 32768) ** 2;
                rms[packet.index] = Math.sqrt(power / (view.byteLength / 2));
                if (rms[packet.index] > 0.05) nonzero++;
                if (counts[packet.index] === 1) console.log('MIC_DATA', packet.index, packet.data.length);
            },
            onClosed: () => console.log('MIC_CLOSED'),
        });
        const input = peer.onInput;
        peer.onInput = events => {
            input(events);
            if (events.some(e => e.type === 4 && !(e.flags & 0x8000) && e.a === 0x30))
                console.log('MIC_BARRIER', JSON.stringify({ total, counts, rms, nonzero, openReplies, closed: mic.closed }));
        };
    }
    if (process.env.RDP_RICH_CLIPBOARD_FIXTURE === '1') configureRichClipboard(peer);
    if (process.env.RDP_AUDIO_FIXTURE === '1') configureAudioPeer(peer, {
        onReady: () => console.log('AUDIO_READY'),
        onConfirm: value => console.log('AUDIO_CONFIRM', JSON.stringify(value)),
    });
} });
const bridge = await createBridge({ port: 8798, token: 'browser-fixture-token-0123456789abcdef', allowedOrigins: ['http://127.0.0.1:8799'], targets: new Map([['fixture', { id: 'fixture', name: 'Protocol fixture', host: '127.0.0.1', port: remote.port, serverName: 'localhost', ca: cert.cert, allowTlsOnly: false }]]) });
console.log('Browser gateway fixture ready');
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async()=> { await bridge.close(); await remote.close(); await cert.close(); });

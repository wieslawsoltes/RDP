import { configureMicrophonePeer } from './MicrophonePeer.js';
import { configureAudioPeer } from './AudioPeer.js';
import { configureRichClipboard } from './RichClipboardPeer.js';
import { makeCertificate, serveRdp } from './NetworkServer.js';
import { createBridge } from '../../apps/bridge/server.js';
const cert = await makeCertificate();
const remote = await serveRdp(cert, { nla: true, configurePeer: peer => {
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

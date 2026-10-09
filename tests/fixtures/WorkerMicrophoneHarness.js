// Drive the actual browser worker module with deterministic clock/WS owners.
// The protocol peer is synthetic; socket authentication is covered separately.
import { parentPort } from 'node:worker_threads';
import { LoopbackServer } from '../../packages/lab/LoopbackServer.js';
import { configureMicrophonePeer } from './MicrophonePeer.js';
let socket, peer, capture, time = 1000, timerId = 0;
const events = [], timers = new Map();
globalThis.onmessage = null;
Object.defineProperty(globalThis, 'performance', { value: { timeOrigin: 1000000, now: () => time }, configurable: true });
globalThis.setInterval = callback => { const id = ++timerId; timers.set(id, callback); return id; };
globalThis.clearInterval = id => timers.delete(id);
const dispatch = data => globalThis.onmessage({ data });
globalThis.postMessage = (value, transfer = []) => {
    const copy = structuredClone(value, { transfer });
    if (copy.type === 'frame') queueMicrotask(() => dispatch({ type: 'consumed', id: copy.id }));
    else events.push(copy);
};
globalThis.WebSocket = class {
    constructor() {
        socket = this; this.readyState = 0; this.bufferedAmount = 0; this.closes = 0;
        peer = new LoopbackServer({ requestedProtocols: 1, send: b => {
            const owned = b.slice(); queueMicrotask(() => this.onmessage?.({ data: owned.buffer }));
        } });
        capture = configureMicrophonePeer(peer);
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    control(value) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(value) })); }
    send(value) {
        if (typeof value === 'string') {
            const message = JSON.parse(value);
            if (message.type === 'connect') this.control({ type: 'ready', selectedProtocol: 1, requestedProtocols: 1, inputWindow: 65536 });
            else if (message.type === 'ping') this.control({ type: 'pong', id: message.id });
        } else {
            const owned = new Uint8Array(value);
            queueMicrotask(() => { peer.receive(owned); this.control({ type: 'input-ack', bytes: owned.length }); });
        }
    }
    close() { this.closes++; this.readyState = 3; }
};
await import('../../apps/client/session-worker.js');
const drain = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setTimeout(resolve, 1)); };
let serialized = Promise.resolve();
parentPort.on('message', command => {
    serialized = serialized.then(async () => {
        const { id, op, value } = command;
        try {
            let cleared;
            if (op === 'start') dispatch({ type: 'start', mode: 'remote', url: 'ws://127.0.0.1:8787/bridge',
                token: 'test-only-token-0123456789abcdef', password: 'test-only-password',
                options: { microphone: true, resize: false, security: 'tls', ...value } });
            else if (op === 'message') {
                dispatch(value);
                if (value.type === 'microphone-data') cleared = value.planes.every(p => p.every(v => v === 0));
            } else if (op === 'block') socket.bufferedAmount = value ? 65536 : 0;
            else if (op === 'format') peer.changeMicrophoneFormat(value);
            else if (op === 'channel-close') peer.closeMicrophone();
            else if (op === 'channel-reopen') peer.reopenMicrophone();
            else if (op === 'disconnect') { socket.readyState = 3; socket.onclose?.(); }
            else if (op === 'failure') socket.control({ type: 'error', code: 'TEST_FAILURE', message: 'injected connection failure' });
            else if (op === 'tick') { time = value; for (const cb of [...timers.values()]) cb(); }
            else if (op !== 'inspect') throw new Error('Unknown harness command');
            await drain();
            parentPort.postMessage({ id, events: events.splice(0), cleared, timers: timers.size, closes: socket?.closes,
                packets: capture?.packets.map(p => ({ index: p.index, bytes: p.data.length, first: new DataView(p.data.buffer).getInt16(0, true) })),
                openResult: capture?.openResult, channelClosed: capture?.closed });
        } catch (error) { parentPort.postMessage({ id, error: error.stack }); }
    });
});
parentPort.postMessage({ ready: true });

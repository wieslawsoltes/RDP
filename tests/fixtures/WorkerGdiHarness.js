// Runs the real browser session worker with deterministic browser transport
// owners. Real TCP/TLS/NLA transport is tested separately in gdi-gateway.test.
import { parentPort } from 'node:worker_threads';
import { LoopbackServer } from '../../packages/lab/LoopbackServer.js';
import { configureGdiPeer } from './GdiPeer.js';
import * as W from './GdiWire.js';
let socket, peer, autoCredit = true, nextTimer = 0, width = 0, pixels = new Uint32Array();
const timers = new Map(), events = [], frameIds = new Set();
let transfers = 0, detached = true, frames = 0, maxInflight = 0;
globalThis.onmessage = null;
Object.defineProperty(globalThis, 'performance', { value: { timeOrigin: 1000000, now: () => 1000 }, configurable: true });
globalThis.setInterval = callback => { const id = ++nextTimer; timers.set(id, callback); return id; };
globalThis.clearInterval = id => timers.delete(id);
const dispatch = data => globalThis.onmessage({ data });
const credit = id => { frameIds.delete(id); dispatch({ type: 'frame-ack', id }); };
globalThis.postMessage = (value, transfer = []) => {
    const copy = structuredClone(value, { transfer }); transfers += transfer.length;
    detached &&= transfer.every(buffer => buffer.byteLength === 0);
    if (copy.type !== 'frame') { events.push(copy); return; }
    frames++; frameIds.add(copy.id); maxInflight = Math.max(maxInflight, frameIds.size);
    for (const event of copy.commands) {
        if (event.type === 'desktop') { width = event.width; pixels = new Uint32Array(event.width * event.height); }
        if (event.type === 'bitmaps') for (const b of event.rectangles) {
            for (let y = 0; y < b.drawHeight; y++) for (let x = 0; x < b.drawWidth; x++) {
                const offset = (b.bottomUp ? b.height - 1 - y : y) * b.stride + x * (b.bpp / 8);
                pixels[(b.y + y) * width + b.x + x] = b.data[offset+2] << 16 | b.data[offset+1] << 8 | b.data[offset];
            }
            b.data.fill(0); // The renderer may release its copy at any time.
        }
    }
    if (autoCredit) queueMicrotask(() => credit(copy.id));
};
globalThis.WebSocket = class {
    constructor() {
        socket = this; this.readyState = 0; this.bufferedAmount = 0; this.closes = 0;
        peer = new LoopbackServer({ requestedProtocols: 1, send: b => {
            const owned = b.slice(); queueMicrotask(() => this.onmessage?.({ data: owned.buffer }));
        } }); configureGdiPeer(peer, { revision: 2 });
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    control(value) { queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(value) })); }
    send(value) {
        if (typeof value === 'string') {
            const m = JSON.parse(value);
            if (m.type === 'connect') this.control({ type: 'ready', selectedProtocol: 1, requestedProtocols: 1, inputWindow: 65536 });
            else if (m.type === 'ping') this.control({ type: 'pong', id: m.id });
        } else {
            const owned = new Uint8Array(value).slice();
            queueMicrotask(() => { peer.receive(owned); this.control({ type: 'input-ack', bytes: owned.length }); });
        }
    }
    close() { this.closes++; this.readyState = 3; }
};
await import('../../apps/client/session-worker.js');
const drain = async () => { for (let i = 0; i < 15; i++) await new Promise(r => setTimeout(r, 1)); };
let serial = Promise.resolve();
parentPort.on('message', command => {
    serial = serial.then(async () => {
        const { id, op, value } = command;
        try {
            if (op === 'start') dispatch({ type: 'start', mode: 'remote', url: 'ws://127.0.0.1:8787/bridge',
                token: 'test-only-token-0123456789abcdef', password: 'test-only-password',
                options: { width: 200, height: 200, orders: true, resize: false, clipboard: false, security: 'tls' } });
            else if (op === 'scene') peer.drawGdiScene();
            else if (op === 'copy') peer.data(2, W.slowOrders(W.scr(40, 20, 1, 1, 0xcc, 31, 19)));
            else if (op === 'block') { autoCredit = !value; if (autoCredit) for (const id of [...frameIds]) credit(id); }
            else if (op === 'malformed') peer.data(2, W.slowOrders(Uint8Array.of(9, 27)));
            else if (op === 'close') dispatch({ type: 'close' });
            else if (op !== 'inspect') throw new Error('Unknown harness command');
            await drain();
            for (const callback of [...timers.values()]) callback();
            await drain();
            parentPort.postMessage({ id, events: events.splice(0), frames, maxInflight, transfers, detached,
                timers: timers.size, closes: socket?.closes, pixels: pixels.slice(), width });
        } catch (error) { parentPort.postMessage({ id, error: error.stack }); }
    });
});
parentPort.postMessage({ ready: true });

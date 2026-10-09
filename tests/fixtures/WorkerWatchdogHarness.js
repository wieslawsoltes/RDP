// Deterministic unit harness for the REAL browser worker module, not a second
// implementation of its state transitions. No network or user credentials.
import { parentPort } from 'node:worker_threads';
let time = 0, nextTimer = 1, current, startup, lateOpen;
const intervals = new Map(), events = [];
globalThis.onmessage = null;
globalThis.postMessage = value => events.push(value);
Object.defineProperty(globalThis, 'performance', { value: { now: () => time }, configurable: true });
globalThis.setInterval = callback => { const id = nextTimer++; intervals.set(id, callback); return id; };
globalThis.clearInterval = id => intervals.delete(id);
globalThis.WebSocket = class {
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.wire = []; this.closes = 0; current = this; }
    send(value) { if (this.throwSend) throw new Error('test send failure'); this.wire.push(value); }
    close() { this.closes++; this.readyState = 3; if (this.throwClose) throw new Error('test close failure'); }
};
await import('../../apps/client/session-worker.js');
parentPort.on('message', ({ id, op, value }) => {
    try {
        if (op === 'start') {
            startup = { type: 'start', mode: 'remote', url: 'ws://127.0.0.1:8787/bridge',
                token: 'test-only-token-0123456789abcdef', password: 'test-only-password',
                options: { username: 'Test', domain: 'Test', targetId: 'test', security: 'nla' } };
            globalThis.onmessage({ data: startup }); lateOpen = current.onopen;
        } else if (op === 'open') { current.readyState = 1; current.onopen?.(); }
        else if (op === 'tick') { time = value; for (const [key, callback] of [...intervals]) if (intervals.has(key)) callback(); }
        else if (op === 'control') current.onmessage?.({ data: JSON.stringify(value) });
        else if (op === 'close') globalThis.onmessage({ data: { type: 'close' } });
        else if (op === 'socket-close') { current.readyState = 3; current.onclose?.(); }
        else if (op === 'late-open') lateOpen?.();
        else if (op === 'break-socket') current.throwSend = current.throwClose = true;
        else throw new Error('Unknown test command');
        parentPort.postMessage({ id, events: events.splice(0), timers: intervals.size, closes: current.closes,
            scrubbed: { token: startup.token === '', password: startup.password === '' },
            controls: current.wire.filter(v => typeof v === 'string').map(v => JSON.parse(v)),
            handlersReleased: ['onopen', 'onmessage', 'onerror', 'onclose'].every(k => current[k] === null) });
    } catch (error) { parentPort.postMessage({ id, error: error.stack }); }
});
parentPort.postMessage({ ready: true });

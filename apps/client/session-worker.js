import { Session } from '../../packages/protocol/Session.js';
import { LoopbackServer } from '../../packages/lab/LoopbackServer.js';
import { LabDesktop } from '../../packages/lab/LabDesktop.js';
let session, socket, lab, peer, credentials, flushTimer, statsTimer, pingTimer;
let stopped = false, queue = [], queuedBytes = 0, wireCredit = 0, nextFrame = 1;
const inflight = new Map(), pingTimes = new Map();
const send = value => postMessage(value);
function fail(error) {
    if (stopped)
        return;
    send({ type: 'error', code: error.code || 'CLIENT_ERROR', message: String(error.message || error).slice(0, 512) });
    stop();
}
function stop() {
    if (stopped)
        return;
    stopped = true;
    clearTimeout(flushTimer);
    clearInterval(statsTimer);
    clearInterval(pingTimer);
    session?.close();
    lab?.close();
    if (socket?.readyState === 1)
        socket.send(JSON.stringify({ type: 'disconnect' }));
    socket?.close();
    queue = [];
    queuedBytes = wireCredit = 0;
    inflight.clear();
    pingTimes.clear();
    credentials = null;
}
function enqueue(event) {
    let size = 0;
    if (event.type === 'bitmaps')
        for (const rectangle of event.rectangles)
            size += rectangle.data.byteLength;
    else if (event.type === 'palette')
        size = event.palette.byteLength;
    else if (event.type === 'pointer' && event.shape) {
        event = { ...event, shape: { ...event.shape, pixels: event.shape.pixels.slice() } };
        size = event.shape.pixels.byteLength;
    }
    if (queuedBytes + size > 64 * 1024 * 1024 || queue.length >= 8192)
        throw new Error('Decoded render queue exceeded its memory budget');
    queue.push({ event, size });
    queuedBytes += size;
    scheduleFlush();
}
function event(value) {
    if (['desktop', 'bitmaps', 'palette', 'pointer'].includes(value.type))
        enqueue(value);
    else {
        send(value);
        if (value.type === 'error')
            stop();
    }
}
function scheduleFlush() {
    if (!flushTimer)
        flushTimer = setTimeout(() => {
            flushTimer = null;
            try {
                flush();
            }
            catch (error) {
                fail(error);
            }
        }, 0);
}
function flush() {
    if (stopped || inflight.size >= 2 || (!queue.length && !wireCredit))
        return;
    const commands = [], transfer = [], buffers = new Set();
    let size = 0;
    while (queue.length && (size < 4 * 1024 * 1024 || !commands.length)) {
        const item = queue.shift();
        size += item.size;
        queuedBytes -= item.size;
        commands.push(item.event);
        const views = item.event.type === 'bitmaps' ? item.event.rectangles.map(rectangle => rectangle.data) : item.event.type === 'palette' ? [item.event.palette] : item.event.shape ? [item.event.shape.pixels] : [];
        for (const view of views)
            if (!buffers.has(view.buffer)) {
                buffers.add(view.buffer);
                transfer.push(view.buffer);
            }
    }
    // Credit is attached only after every previously decoded command has been transferred.
    const credit = queue.length ? 0 : wireCredit;
    if (credit)
        wireCredit = 0;
    const id = nextFrame++;
    inflight.set(id, credit);
    postMessage({ type: 'frame', id, commands }, transfer);
    if (queue.length)
        scheduleFlush();
}
function openSession(options, negotiation) {
    session = new Session({ options: { ...options, ...negotiation }, emit: event, send: bytes => {
            if (peer)
                queueMicrotask(() => {
                    if (!stopped) {
                        try {
                            peer.receive(bytes);
                        }
                        catch (error) {
                            fail(error);
                        }
                    }
                });
            else {
                if (socket.readyState !== 1 || socket.bufferedAmount > 1024 * 1024)
                    throw new Error('Transport input backpressure limit exceeded');
                socket.send(bytes);
            }
        } });
    session.start();
    statsTimer = setInterval(() => send({ type: 'statistics', ...session.stats(), queuedBytes, inflight: inflight.size }), 1000);
}
function start(message) {
    const options = message.options;
    if (message.mode === 'lab') {
        if (typeof OffscreenCanvas === 'undefined')
            throw new Error('This browser cannot run the worker-based local fixture (OffscreenCanvas unavailable)');
        peer = new LoopbackServer({ requestedProtocols: 1, send: bytes => queueMicrotask(() => {
                if (!stopped) {
                    session.receive(bytes);
                    scheduleFlush();
                }
            }) });
        lab = new LabDesktop(peer, () => queuedBytes < 4 * 1024 * 1024 && inflight.size < 2);
        send({ type: 'security', mode: 'local-fixture', authentication: { protocol: 'No network authentication — local test peer' } });
        openSession({ ...options, password: '', bpp: 24 }, { selectedProtocol: 1, requestedProtocols: 1 });
        return;
    }
    credentials = { username: options.username || '', domain: options.domain || '', password: message.password || '' };
    socket = new WebSocket(message.url);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'connect', targetId: options.targetId, security: options.security, token: message.token, ...credentials }));
        message.token = message.password = '';
        pingTimer = setInterval(() => {
            if (socket.readyState !== 1 || pingTimes.size > 3)
                return;
            const id = Date.now();
            pingTimes.set(id, performance.now());
            socket.send(JSON.stringify({ type: 'ping', id }));
        }, 5000);
    };
    socket.onmessage = received => {
        if (stopped)
            return;
        try {
            if (typeof received.data === 'string') {
                const control = JSON.parse(received.data);
                if (control.type === 'ready') {
                    send({ ...control, type: 'security' });
                    openSession({ ...options, password: options.security === 'tls' ? credentials.password : '' }, control);
                    credentials.password = '';
                    credentials = null;
                }
                else if (control.type === 'error')
                    fail(control);
                else if (control.type === 'pong') {
                    const start = pingTimes.get(control.id);
                    if (start !== undefined) {
                        send({ type: 'latency', bridgeRttMs: performance.now() - start });
                        pingTimes.delete(control.id);
                    }
                }
                else
                    send(control);
            }
            else {
                if (!session)
                    throw new Error('RDP data arrived before verified security negotiation');
                wireCredit += received.data.byteLength;
                session.receive(new Uint8Array(received.data));
                scheduleFlush();
            }
        }
        catch (error) {
            fail(error);
        }
    };
    socket.onerror = () => fail(new Error('Bridge WebSocket failed. Verify its address, certificate, and origin.'));
    socket.onclose = () => {
        if (!stopped) {
            send({ type: 'state', state: 'closed' });
            stop();
        }
    };
}
onmessage = received => {
    const message = received.data;
    try {
        if (message.type === 'start') {
            if (session || socket || stopped)
                throw new Error('Worker cannot be reused');
            start(message);
        }
        else if (message.type === 'frame-ack') {
            if (!inflight.has(message.id))
                return;
            const credit = inflight.get(message.id);
            inflight.delete(message.id);
            if (credit && socket?.readyState === 1)
                socket.send(JSON.stringify({ type: 'ack', bytes: credit }));
            scheduleFlush();
        }
        else if (message.type === 'input')
            session?.input(message.events);
        else if (message.type === 'text')
            session?.text(message.text);
        else if (message.type === 'clipboard')
            session?.setClipboard(message.text);
        else if (message.type === 'resize')
            session?.resize(message.width, message.height, message.scale || 100);
        else if (message.type === 'refresh')
            session?.refresh();
        else if (message.type === 'close')
            stop();
    }
    catch (error) {
        if (['input', 'text', 'clipboard', 'resize'].includes(message.type))
            send({ type: 'notice', message: error.message });
        else
            fail(error);
    }
};

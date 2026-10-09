import http from 'node:http';
import https from 'node:https';
import { readFile, stat, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketPeer } from '../../packages/transport/WebSocketPeer.js';
import { requireThat } from '../../packages/binary/ProtocolError.js';
import { normalizeOrigin, applyCors } from '../gateway/OriginPolicy.js';
import { MemoryLicenseStore } from '../gateway/LicenseStore.js';
import { loadTargets } from './Targets.js';
import { BridgeSession, tokenMatches } from './BridgeSession.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mime = new Map([['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json'], ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.ico', 'image/x-icon'], ['.wgsl', 'text/plain; charset=utf-8']]);
export async function createBridge({ token = randomBytes(32).toString('hex'), targets = new Map(), host = '127.0.0.1', port = 8787, tlsOptions, publicOrigin, allowedOrigins = [], licenseStore } = {}) {
    requireThat(typeof token === 'string' && token.length >= 24 && token.length <= 512, 'TOKEN_POLICY', 'Bridge token must have at least 24 characters');
    requireThat(tlsOptions || ['127.0.0.1', '::1', 'localhost'].includes(host), 'LISTEN_POLICY', 'Non-loopback listeners require HTTPS certificates');
    requireThat(!tlsOptions || publicOrigin, 'ORIGIN_POLICY', 'HTTPS requires LRDP_PUBLIC_ORIGIN with the exact externally used origin');
    if (publicOrigin) {
        const u = new URL(publicOrigin);
        requireThat(u.origin === publicOrigin && (tlsOptions ? u.protocol === 'https:' : u.protocol === 'http:'), 'ORIGIN_POLICY', 'Public origin must be an exact scheme://host:port origin');
    }
    requireThat(Array.isArray(allowedOrigins) && allowedOrigins.length <= 32, 'ORIGIN_POLICY', 'At most 32 explicitly allowed browser origins');
    const origins = new Set(allowedOrigins.map(normalizeOrigin));
    const ownedStore = licenseStore === undefined;
    licenseStore ??= new MemoryLicenseStore();
    for (const method of ['hardwareId', 'machineName', 'find', 'save'])
        requireThat(typeof licenseStore[method] === 'function', 'LICENSE_STORE', 'Invalid licensing store adapter');
    let origin;
    const sessions = new Set(), sockets = new Set(), rates = new Map();
    const handler = async (req, res) => {
        try {
            if (req.headers.host !== new URL(origin).host) {
                res.writeHead(403).end('Unrecognized Host');
                return;
            }
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Referrer-Policy', 'no-referrer');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
            res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), usb=(), serial=()');
            res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
            res.setHeader('Cache-Control', 'no-store');
            const url = new URL(req.url, origin);
            if (url.pathname.startsWith('/api/') && !applyCors(req, res, origins)) return;
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405, { Allow: 'GET, HEAD' }).end();
                return;
            }
            if (url.pathname === '/api/targets') {
                if (!tokenMatches(req.headers.authorization?.replace(/^Bearer /, ''), token)) {
                    res.writeHead(401).end('Authentication required');
                    return;
                }
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ targets: [...targets.values()].map(t => ({ id: t.id, name: t.name, allowTlsOnly: t.allowTlsOnly })) }));
                return;
            }
            if (url.pathname === '/api/health') {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ service: 'LRDP Web', version: '0.2.0', gatewayProtocol: 1, transports: ['websocket', 'tcp', 'tls', 'credssp'], protocol: 'experimental RDP client' }));
                return;
            }
            if (url.pathname === '/') {
                res.writeHead(302, { Location: '/apps/client/index.html' }).end();
                return;
            }
            const pathname = decodeURIComponent(url.pathname);
            if (!/^\/(apps\/client|packages)\//.test(pathname) || pathname.split('/').some(p => p === '..' || p.startsWith('.')) || pathname.includes('\\') || pathname.includes('\0')) {
                res.writeHead(404).end('Not found');
                return;
            }
            const file = await realpath(path.join(root, pathname));
            if (!file.startsWith(root + path.sep)) {
                res.writeHead(403).end();
                return;
            }
            const info = await stat(file);
            if (!info.isFile() || info.size > 16 * 1024 * 1024) {
                res.writeHead(404).end();
                return;
            }
            res.setHeader('Content-Type', mime.get(path.extname(file)) || 'application/octet-stream');
            res.setHeader('Content-Length', info.size);
            if (req.method === 'HEAD')
                res.end();
            else {
                const stream = createReadStream(file);
                stream.on('error', () => res.destroy());
                stream.pipe(res);
            }
        }
        catch {
            if (!res.headersSent)
                res.writeHead(404);
            res.end('Not found');
        }
    };
    const server = tlsOptions ? https.createServer({ ...tlsOptions, minVersion: 'TLSv1.2' }, handler) : http.createServer(handler);
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.keepAliveTimeout = 5000;
    server.maxHeadersCount = 32;
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('clientError', (_error, socket) => socket.destroy());
    server.on('upgrade', (req, socket, head) => {
        try {
            requireThat(req.url === '/bridge' && req.headers.host === new URL(origin).host && origins.has(req.headers.origin), 'ORIGIN', 'WebSocket origin denied');
            const ip = socket.remoteAddress || '', now = Date.now();
            if (rates.size > 1024)
                for (const [key, rate] of rates)
                    if (now - rate.start > 60000)
                        rates.delete(key);
            requireThat(rates.size < 2048, 'RATE_LIMIT', 'Too many origins');
            let rate = rates.get(ip);
            if (!rate || now - rate.start > 60000) {
                rate = { start: now, count: 0 };
                rates.set(ip, rate);
            }
            requireThat(++rate.count <= 24 && sessions.size < 16, 'RATE_LIMIT', 'Connection limit exceeded');
            const peer = WebSocketPeer.accept(req, socket);
            const session = new BridgeSession(peer, { token, targets, licenseStore, onClose: () => sessions.delete(session) });
            sessions.add(session);
            if (head.length)
                peer.receive(head);
        }
        catch {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        }
    });
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); }
    catch (error) { if (ownedStore) await licenseStore.close(); throw error; }
    const address = server.address(), hostText = host.includes(':') ? `[${host}]` : host;
    origin = publicOrigin || `${tlsOptions ? 'https' : 'http'}://${hostText}:${address.port}`;
    origins.add(origin);
    let closing;
    return { server, token, origin, address, close: () => closing ||= (async () => {
            for (const session of sessions)
                session.close();
            for (const socket of sockets)
                socket.destroy();
            await new Promise(resolve => server.close(resolve));
            if (ownedStore) await licenseStore.close();
        })() };
}
async function main() {
    const targets = await loadTargets(process.env.LRDP_TARGETS || path.join(root, 'targets.json'));
    const tlsOptions = process.env.LRDP_HTTPS_CERT && process.env.LRDP_HTTPS_KEY ? { cert: await readFile(process.env.LRDP_HTTPS_CERT), key: await readFile(process.env.LRDP_HTTPS_KEY) } : undefined;
    const bridge = await createBridge({ targets, host: process.env.LRDP_BIND || '127.0.0.1', port: Number(process.env.LRDP_PORT || 8787), token: process.env.LRDP_TOKEN || randomBytes(32).toString('hex'), tlsOptions, publicOrigin: process.env.LRDP_PUBLIC_ORIGIN, allowedOrigins: (process.env.LRDP_ALLOWED_ORIGINS || '').split(',').filter(Boolean) });
    console.log(`\nLRDP Web — ${bridge.origin}\nConfigured targets: ${targets.size}\nBridge token (keep private): ${bridge.token}\n\nThe local protocol lab works without a remote server.\nReal connections require an allowlisted target and verified certificate.\n`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'])
        process.on(signal, async () => {
            if (!stopping) {
                stopping = true;
                await bridge.close();
            }
        });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch(error => { console.error(`LRDP: ${error.message}`); process.exitCode = 1; });

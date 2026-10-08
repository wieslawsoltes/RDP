import { requireThat } from '../../packages/binary/ProtocolError.js';

export function normalizeOrigin(value) {
    requireThat(typeof value === 'string' && value.length <= 2048, 'ORIGIN_POLICY', 'Invalid allowed origin');
    let url;
    try { url = new URL(value); } catch { throw new Error('Allowed origins must be exact http(s) origins'); }
    requireThat(url.origin === value && !url.hostname.includes('*') && !url.username && !url.password &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))),
        'ORIGIN_POLICY', 'Allowed origins must be HTTPS, or HTTP on loopback; wildcards and paths are forbidden');
    return value;
}

/** CORS is not authentication: every protected API still requires the bearer token. */
export function applyCors(req, res, origins) {
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
        res.writeHead(403).end('Origin denied');
        return false;
    }
    if (origin !== undefined) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network');
    }
    if (req.method !== 'OPTIONS') return true;
    const headers = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
    if (origin === undefined || req.headers['access-control-request-method'] !== 'GET' || headers.some(h => h !== 'authorization')) {
        res.writeHead(403).end('Preflight denied');
        return false;
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization');
    // Older PNA clients use preflights. Modern browsers can additionally ask
    // for Local Network Access permission, which this endpoint cannot grant.
    if (req.headers['access-control-request-private-network'] === 'true')
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Max-Age', '300');
    res.writeHead(204).end();
    return false;
}

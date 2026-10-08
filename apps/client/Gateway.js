/** Endpoints are entered locally, never accepted from links or imported profiles. */
export function gatewayEndpoint(value) {
    if (typeof value !== 'string' || value.length > 2048 || value !== value.trim())
        throw new Error('Enter an exact gateway http(s) or ws(s) origin.');
    let url;
    try { url = new URL(value); } catch { throw new Error('Invalid gateway address. Example: http://127.0.0.1:8787'); }
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        !['/', '/bridge'].includes(url.pathname))
        throw new Error('Gateway addresses cannot contain credentials, queries, fragments or custom paths.');
    const secure = ['https:', 'wss:'].includes(url.protocol);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!secure && !loopback)
        throw new Error('Non-loopback gateways require HTTPS/WSS.');
    url.protocol = secure ? 'https:' : 'http:';
    const origin = url.origin;
    url.pathname = '/bridge';
    url.protocol = secure ? 'wss:' : 'ws:';
    return Object.freeze({ origin, websocket: url.href, loopback, secure });
}

export function defaultGateway(page, staticHosting) {
    return staticHosting ? 'http://127.0.0.1:8787' : new URL(page).origin;
}

export async function loadGatewayTargets(endpoint, token, { signal, fetcher = fetch } = {}) {
    if (typeof token !== 'string' || token.length < 24 || token.length > 512 || /[\r\n]/.test(token))
        throw new Error('Paste the private access token printed by the local gateway.');
    const response = await fetcher(`${endpoint.origin}/api/targets`, {
        method: 'GET', headers: { Authorization: `Bearer ${token}` },
        credentials: 'omit', cache: 'no-store', redirect: 'error', mode: 'cors',
        referrerPolicy: 'no-referrer', signal,
    });
    if (!response.ok) throw new Error(`Gateway rejected the target request (${response.status}). Check the token and allowed origin.`);
    if (Number(response.headers.get('content-length')) > 65536) {
        await response.body?.cancel();
        throw new Error('Gateway target response exceeds the limit.');
    }
    const reader = response.body?.getReader(), chunks = [];
    let size = 0;
    if (!reader) throw new Error('Gateway sent an empty target response.');
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 65536) throw new Error('Gateway target response exceeds the limit.');
            chunks.push(value);
        }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    const data = JSON.parse(text), ids = new Set();
    if (!Array.isArray(data.targets) || data.targets.length > 256) throw new Error('Invalid gateway target list.');
    return data.targets.map(t => {
        if (!t || typeof t.id !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(t.id) || ids.has(t.id) ||
            typeof t.name !== 'string' || t.name.length > 128 || typeof t.allowTlsOnly !== 'boolean')
            throw new Error('Invalid or duplicate gateway target.');
        ids.add(t.id);
        return Object.freeze({ id: t.id, name: t.name, allowTlsOnly: t.allowTlsOnly });
    });
}

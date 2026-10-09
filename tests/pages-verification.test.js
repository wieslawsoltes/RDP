import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { verifyPages, validatePagesManifest } from '../tools/verify-pages.js';
const commit = 'f'.repeat(40);
const assets = { 'index.html': '<html>app</html>', LICENSE: 'license',
    'apps/client/app.js': 'export const start = true;', 'apps/client/session-worker.js': 'onmessage=()=>{};' };
function manifest() { return { version: 1, hosting: 'static-browser-client', commit,
    files: Object.keys(assets), sha256: Object.fromEntries(Object.entries(assets).map(([k, v]) => [k, createHash('sha256').update(v).digest('hex')])) }; }
const mime = name => name.endsWith('.js') ? 'text/javascript' : name.endsWith('.html') ? 'text/html' : 'text/plain';
function fetcher({ mutateManifest = v => v, mutateAsset = (_, v) => v, headers = {}, status = 200 } = {}) {
    return async (url, options) => {
        assert.equal(url.origin, 'https://example.test'); assert.ok(url.pathname.startsWith('/RDP/'));
        assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
        const name = url.pathname.slice(5);
        const data = name === 'build.json' ? JSON.stringify(mutateManifest(manifest())) : mutateAsset(name, assets[name]);
        return new Response(data, { status, headers: { 'content-type': mime(name), ...headers } });
    };
}
const run = options => verifyPages({ url: 'https://example.test/RDP/', expectedManifest: manifest(),
    attempts: 1, retryDelayMs: 0, fetchImpl: fetcher(), ...options });

test('Pages verifier hashes every asset against the local build, not just index.html', async () => {
    const seen = [], fetch = fetcher();
    const result = await run({ fetchImpl: (url, opts) => { seen.push(url.pathname); return fetch(url, opts); } });
    assert.equal(result.verified, true); assert.equal(result.commit, commit); assert.equal(result.files, 4);
    assert.equal(result.bytes, Object.values(assets).reduce((n, v) => n + Buffer.byteLength(v), 0));
    assert.deepEqual(seen.sort(), ['/RDP/build.json', ...Object.keys(assets).map(p => '/RDP/' + p)].sort());
});
test('Pages verifier detects stale manifests and retries without fetching their assets', async () => {
    let count = 0, retries = 0; const fetch = fetcher();
    const result = await run({ attempts: 2, onRetry: () => retries++, fetchImpl: (url, opts) => {
        if (url.pathname.endsWith('build.json') && count++ === 0) return new Response(JSON.stringify({ ...manifest(), commit: 'a'.repeat(40) }));
        return fetch(url, opts);
    } });
    assert.equal(result.attempts, 2); assert.equal(retries, 1);
});
test('Pages verifier rejects a self-consistent remote manifest different from the local source', async () => {
    await assert.rejects(run({ fetchImpl: fetcher({ mutateManifest: m => {
        m.sha256['apps/client/app.js'] = '0'.repeat(64); return m;
    } }) }), /differs from the checked-out source/);
});
test('Pages verifier catches a changed worker, missing files, redirects and incorrect MIME', async () => {
    await assert.rejects(run({ fetchImpl: fetcher({ mutateAsset: (name, data) => name.endsWith('worker.js') ? 'bad' : data }) }), /hash mismatch/);
    for (const status of [302, 404, 500]) await assert.rejects(run({ fetchImpl: fetcher({ status }) }), /HTTP/);
    await assert.rejects(run({ fetchImpl: fetcher({ headers: { 'content-type': 'text/plain' } }) }), /content type/);
});
test('Pages manifest rejects unsafe paths, excess inventories and hidden hash entries before requests', async () => {
    for (const path of ['.nojekyll', '../key', '/outside.js', '//outside.test/a.js', 'apps/client/../bridge/a.js', 'apps/client/%2e%2e/a.js',
        'apps/client/a.js?token=x', 'apps/client/a.js#part', 'apps/bridge/server.js', 'packages/security/NtlmV2.js',
        'apps/client/x\\y.js', 'apps/client/x.js\n', 'apps/client/.private/a.js']) {
        const m = manifest(); m.files.push(path); m.sha256[path] = '0'.repeat(64);
        assert.throws(() => validatePagesManifest(m, commit), /asset path/);
    }
    const dup = manifest(); dup.files.push(dup.files[0]); assert.throws(() => validatePagesManifest(dup, commit), /duplicate/);
    const extra = manifest(); extra.sha256.unknown = '0'.repeat(64); assert.throws(() => validatePagesManifest(extra, commit), /inventory/);
    const missing = manifest(); missing.files.splice(3, 1); assert.throws(() => validatePagesManifest(missing, commit));
    const many = manifest(); many.files = Array(257).fill('index.html'); assert.throws(() => validatePagesManifest(many, commit), /count/);
    const bad = manifest(); bad.sha256.LICENSE = 'x'.repeat(64); assert.throws(() => validatePagesManifest(bad, commit), /hash/);
    let called = false;
    await assert.rejects(run({ expectedManifest: bad, fetchImpl: () => { called = true; } }));
    assert.equal(called, false);
});
test('Pages verifier bounds manifest bodies including chunked streams and cancels rejected bodies', async () => {
    let cancelled = false;
    await assert.rejects(run({ fetchImpl: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); }, cancel() { cancelled = true; }
    })) }), /Oversized/);
    assert.equal(cancelled, true);
    await assert.rejects(run({ fetchImpl: fetcher({ headers: { 'content-length': '9999999999' } }) }), /Oversized/);
});
test('Pages verifier validates URL, cancellation and numerical budgets', async () => {
    for (const url of ['http://example.test/RDP/', 'file:///tmp/RDP/', 'https://user:secret@example.test/RDP/',
        'https://example.test/RDP/?token=secret', 'https://example.test/RDP/#x', 'https://example.test/R%44P/'])
        await assert.rejects(run({ url }));
    for (const options of [{ attempts: 0 }, { attempts: 21 }, { concurrency: 0 }, { concurrency: 9 },
        { retryDelayMs: -1 }, { requestTimeoutMs: Infinity }, { attempts: 1.5 }]) await assert.rejects(run(options));
    const abort = new AbortController(); abort.abort(new Error('cancelled by owner'));
    await assert.rejects(run({ signal: abort.signal }), /cancelled by owner/);
});
test('Pages verifier enforces concurrent request bound and waits for all assets', async () => {
    let active = 0, peak = 0, finished = 0; const fetch = fetcher();
    const result = await run({ concurrency: 2, fetchImpl: async (url, opts) => {
        active++; peak = Math.max(active, peak);
        await new Promise(resolve => setTimeout(resolve, 3));
        const response = await fetch(url, opts); active--; finished++; return response;
    } });
    assert.equal(peak, 2); assert.equal(finished, 5); assert.equal(active, 0); assert.equal(result.verified, true);
});
test('Pages verifier exercises actual HTTP subpath requests without browser security overrides', async t => {
    const server = createServer((req, res) => {
        const name = req.url.slice('/RDP/'.length);
        res.setHeader('Content-Type', mime(name));
        res.end(name === 'build.json' ? JSON.stringify(manifest()) : assets[name]);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const result = await verifyPages({ url: `http://127.0.0.1:${server.address().port}/RDP/`, expectedManifest: manifest(), attempts: 1 });
    assert.equal(result.verified, true);
});
test('Pages verifier applies its timeout to response body consumption', async t => {
    const server = createServer((_req, res) => { res.writeHead(200); res.flushHeaders(); res.write('{'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    await assert.rejects(verifyPages({ url: `http://127.0.0.1:${server.address().port}/RDP/`,
        expectedManifest: manifest(), attempts: 1, requestTimeoutMs: 30 }), /aborted|timeout/i);
});
test('Pages verifier rejects oversized chunked assets before hashing the full body', async () => {
    const fetch = fetcher(); let cancelled = false;
    await assert.rejects(run({ fetchImpl: (url, opts) => {
        if (!url.pathname.endsWith('app.js')) return fetch(url, opts);
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
        }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/javascript' } }));
    } }), /Oversized/);
    assert.equal(cancelled, true);
});

test('Pages verifier deadlines settle even when fetch ignores abort', { timeout: 2000 }, async () => {
    let requests = 0, retries = 0;
    await assert.rejects(run({ attempts: 2, requestTimeoutMs: 20, onRetry: () => retries++,
        fetchImpl: () => { requests++; return new Promise(() => {}); } }), /failed after 2 attempts: Request timeout/);
    assert.equal(requests, 2); assert.equal(retries, 1);
});
test('Pages verifier never waits for a stalled stream cancellation', { timeout: 2000 }, async () => {
    let cancelled = 0;
    await assert.rejects(run({ requestTimeoutMs: 20, fetchImpl: () => new Response(new ReadableStream({
        pull() { return new Promise(() => {}); },
        cancel() { cancelled++; return new Promise(() => {}); }
    })) }), /Request timeout/);
    assert.equal(cancelled, 1);
});
test('Pages verifier releases a failed response without awaiting its cancellation', { timeout: 2000 }, async () => {
    let cancelled = 0;
    await assert.rejects(run({ fetchImpl: () => new Response(new ReadableStream({
        cancel() { cancelled++; return new Promise(() => {}); }
    }), { status: 404 }) }), /HTTP 404/);
    assert.equal(cancelled, 1);
});
test('Pages verifier settles all workers when one fails and siblings ignore abort', { timeout: 2000 }, async () => {
    const fetch = fetcher(); let blocked = 0;
    await assert.rejects(run({ concurrency: 4, requestTimeoutMs: 1000, fetchImpl: (url, options) => {
        if (url.pathname.endsWith('build.json')) return fetch(url, options);
        if (url.pathname.endsWith('LICENSE')) return new Response('', { status: 404 });
        blocked++; return new Promise(() => {});
    } }), /HTTP 404/);
    assert.equal(blocked, 3);
});
test('Pages verifier cancels a transport response that arrives after owner cancellation', { timeout: 2000 }, async () => {
    let resolveFetch, cancelled = 0;
    const abort = new AbortController();
    const verification = run({ signal: abort.signal, fetchImpl: () => new Promise(resolve => { resolveFetch = resolve; }) });
    abort.abort(new Error('owner cancelled pending fetch'));
    await assert.rejects(verification, /owner cancelled/);
    resolveFetch(new Response(new ReadableStream({ cancel() { cancelled++; } })));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, 1);
});

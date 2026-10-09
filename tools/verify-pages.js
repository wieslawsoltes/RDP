import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_ASSET_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const required = ['index.html', '.nojekyll', 'LICENSE', 'apps/client/app.js', 'apps/client/session-worker.js'];
const browserPath = /^(?:apps\/client|packages\/(?:binary|channels|codecs|input|lab|profiles|protocol|render))\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:html|js|css|svg|png|ico|wgsl)$/;
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

/** Validate before issuing any asset request. Manifests cannot redirect this probe. */
export function validatePagesManifest(value, expectedCommit) {
    ensure(value && typeof value === 'object' && value.version === 1 &&
        value.hosting === 'static-browser-client', 'Invalid Pages manifest');
    ensure(typeof expectedCommit === 'string' && /^[a-f0-9]{40}$/.test(expectedCommit) && value.commit === expectedCommit,
        'Pages commit does not match the expected revision');
    ensure(Array.isArray(value.files) && value.files.length >= required.length && value.files.length <= 256,
        'Invalid Pages file count');
    ensure(value.sha256 && typeof value.sha256 === 'object' && !Array.isArray(value.sha256), 'Invalid Pages hashes');
    const files = new Set();
    for (const name of value.files) {
        ensure(typeof name === 'string' && name.length <= 240 && !name.split('/').includes('..') &&
            (['index.html', '.nojekyll', 'LICENSE'].includes(name) || browserPath.test(name)) &&
            !files.has(name), 'Invalid or duplicate Pages asset path');
        ensure(Object.hasOwn(value.sha256, name) && /^[a-f0-9]{64}$/.test(value.sha256[name]), 'Invalid asset hash');
        files.add(name);
    }
    ensure(required.every(name => files.has(name)), 'Pages manifest omits application entry points');
    ensure(Object.keys(value.sha256).length === files.size, 'Pages manifest hash inventory differs from its files');
    return { version: 1, commit: value.commit, hosting: value.hosting,
        files: [...files].sort(), sha256: Object.fromEntries([...files].sort().map(name => [name, value.sha256[name]])) };
}

function publicationUrl(value) {
    const url = new URL(value);
    ensure(!url.username && !url.password && !url.search && !url.hash && !url.pathname.includes('%'), 'Invalid Pages URL');
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    ensure(url.protocol === 'https:' || url.protocol === 'http:' && loopback, 'Pages verification requires HTTPS or HTTP loopback');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url;
}

async function responseBytes(url, { fetchImpl, signal, timeout, limit, consume, mime }) {
    const deadline = AbortSignal.timeout(timeout);
    const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.any([signal, deadline]), headers: { 'Cache-Control': 'no-cache' } });
    let reader;
    try {
        ensure(response.status === 200 && !response.redirected, `HTTP ${response.status} for ${url.pathname}`);
        const declared = response.headers.get('content-length');
        ensure(declared === null || /^\d+$/.test(declared) && Number(declared) <= limit, `Oversized response: ${url.pathname}`);
        if (mime) ensure(mime.test(response.headers.get('content-type') || ''), `Incorrect content type: ${url.pathname}`);
        if (!response.body) return 0;
        reader = response.body.getReader();
        let size = 0;
        while (true) {
            signal.throwIfAborted(); deadline.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            ensure(size <= limit, `Oversized response: ${url.pathname}`);
            consume(value);
        }
        return size;
    } finally {
        // Cancelling early failures also releases server sockets and streaming bodies.
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        else if (response.body) await response.body.cancel().catch(() => {});
    }
}

/**
 * Compare HTTPS deployment with the manifest built from the checked-out commit,
 * then hash EVERY declared asset. Never trust a remote manifest's hashes alone.
 * Retries allow bounded CDN propagation; no successful result for stale revisions,
 * partial uploads, redirects, wrong MIME, missing files or mismatched content.
 */
export async function verifyPages({ url, expectedManifest, attempts = 12, retryDelayMs = 3000,
    requestTimeoutMs = 15000, concurrency = 4, fetchImpl = globalThis.fetch,
    signal = new AbortController().signal, onRetry = () => {} }) {
    const base = publicationUrl(url);
    const expected = validatePagesManifest(expectedManifest, expectedManifest?.commit);
    for (const [number, max, min] of [[attempts, 20, 1], [retryDelayMs, 10000, 0], [requestTimeoutMs, 30000, 1], [concurrency, 8, 1]])
        ensure(Number.isSafeInteger(number) && number >= min && number <= max, 'Invalid Pages verifier resource limit');
    ensure(typeof fetchImpl === 'function' && typeof onRetry === 'function', 'Invalid Pages verifier callback');
    let last;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        signal.throwIfAborted();
        const abort = new AbortController(), attemptSignal = AbortSignal.any([signal, abort.signal]);
        try {
            const chunks = [];
            await responseBytes(new URL('build.json', base), { fetchImpl, signal: attemptSignal,
                timeout: requestTimeoutMs, limit: MAX_MANIFEST_BYTES, consume: chunk => chunks.push(chunk.slice()) });
            const manifest = validatePagesManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')), expected.commit);
            ensure(JSON.stringify(manifest) === JSON.stringify(expected), 'Published manifest differs from the checked-out source');
            let next = 0, total = 0;
            const workers = Array.from({ length: Math.min(concurrency, expected.files.length) }, async () => {
                try {
                    while (next < expected.files.length) {
                        attemptSignal.throwIfAborted();
                        const name = expected.files[next++], hash = createHash('sha256');
                        const mime = name.endsWith('.js') ? /^(?:text|application)\/(?:java|ecma)script(?:;|$)/i :
                            name.endsWith('.html') ? /^text\/html(?:;|$)/i : name.endsWith('.css') ? /^text\/css(?:;|$)/i : undefined;
                        await responseBytes(new URL(name, base), { fetchImpl, signal: attemptSignal, timeout: requestTimeoutMs,
                            limit: MAX_ASSET_BYTES, mime, consume: chunk => {
                                total += chunk.byteLength;
                                ensure(total <= MAX_TOTAL_BYTES, 'Published asset set exceeds the total byte budget');
                                hash.update(chunk);
                            } });
                        ensure(hash.digest('hex') === expected.sha256[name], `Published asset hash mismatch: ${name}`);
                    }
                } catch (error) { abort.abort(error); throw error; }
            });
            const results = await Promise.allSettled(workers);
            const failure = results.find(result => result.status === 'rejected');
            if (failure) throw failure.reason;
            return { url: base.href, commit: expected.commit, files: expected.files.length, bytes: total,
                attempts: attempt, verified: true, scope: 'Exact static asset publication; not RDP interoperability or browser/hardware qualification' };
        } catch (error) {
            abort.abort(error);
            signal.throwIfAborted();
            last = error;
            if (attempt < attempts) {
                onRetry({ attempt, message: error.message });
                await sleep(retryDelayMs, undefined, { signal });
            }
        }
    }
    throw new Error(`Pages verification failed after ${attempts} attempts: ${last?.message}`, { cause: last });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const [url, expectedCommit, manifestPath = 'dist/pages/build.json', ...extra] = process.argv.slice(2);
        ensure(url && /^[a-f0-9]{40}$/.test(expectedCommit || '') && extra.length === 0,
            'Usage: node tools/verify-pages.js HTTPS_URL EXPECTED_COMMIT [LOCAL_MANIFEST]');
        const source = await readFile(manifestPath);
        ensure(source.length <= MAX_MANIFEST_BYTES, 'Local manifest exceeds its size budget');
        const manifest = JSON.parse(source);
        validatePagesManifest(manifest, expectedCommit);
        const result = await verifyPages({ url, expectedManifest: manifest,
            onRetry: ({ attempt, message }) => console.error(`Attempt ${attempt}: ${message}`) });
        console.log(JSON.stringify(result, null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}

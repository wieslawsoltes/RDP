import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const moduleUrl = new URL('../tools/verify-pages.js', import.meta.url).href;

// The test runner's own timeout can keep a broken unreferenced deadline alive.
// Separate processes reproduce the live verifier's unsettled-await exit 13.
for (const mode of ['fetch', 'body', 'cancel']) {
    test(`Pages ${mode} lifecycle settles in an otherwise idle Node process`, { timeout: 5000 }, async () => {
        const script = `
            import { createHash } from 'node:crypto';
            import { verifyPages } from ${JSON.stringify(moduleUrl)};
            const files = ['index.html', 'LICENSE', 'apps/client/app.js', 'apps/client/session-worker.js'];
            const manifest = {version:1, hosting:'static-browser-client', commit:'f'.repeat(40), files,
                sha256:Object.fromEntries(files.map(p => [p, createHash('sha256').update('').digest('hex')]))};
            const mode = ${JSON.stringify(mode)}, never = () => new Promise(() => {});
            const fetchImpl = mode === 'fetch' ? never : () => new Response(new ReadableStream({
                pull: never, cancel: never
            }), {status: mode === 'cancel' ? 404 : 200});
            try {
                await verifyPages({url:'https://example.test/RDP/', expectedManifest:manifest,
                    attempts:1, requestTimeoutMs:20, fetchImpl});
                throw new Error('Unexpected verification success');
            } catch (error) {
                if (!(mode === 'cancel' ? /HTTP 404/ : /Request timeout/).test(error.message)) throw error;
                console.log('bounded-failure');
            }
        `;
        const { stdout, stderr } = await execute(process.execPath, ['--input-type=module', '--eval', script],
            { timeout: 3000, maxBuffer: 65536 });
        assert.equal(stdout.trim(), 'bounded-failure');
        assert.doesNotMatch(stderr, /unsettled top-level await/i);
    });
}

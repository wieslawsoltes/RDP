import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatewayEndpoint, defaultGateway, loadGatewayTargets } from '../apps/client/Gateway.js';
import { normalizeOrigin } from '../apps/gateway/OriginPolicy.js';
import { runGateway } from '../apps/gateway/cli.js';

test('Gateway endpoint canonicalization permits loopback WS and remote WSS, not credential injection', () => {
    assert.equal(gatewayEndpoint('http://127.0.0.1:8787').websocket, 'ws://127.0.0.1:8787/bridge');
    assert.equal(gatewayEndpoint('wss://gateway.example/bridge').origin, 'https://gateway.example');
    assert.equal(gatewayEndpoint('ws://[::1]:8787').origin, 'http://[::1]:8787');
    for (const value of ['http://gateway.example', 'ws://192.168.1.1', 'https://a:b@gateway.example', 'https://gateway.example/?token=abc', 'https://gateway.example/#token', 'file:///tmp/bridge', 'https://gateway.example/proxy', ' https://gateway.example', null])
        assert.throws(() => gatewayEndpoint(value));
    assert.equal(defaultGateway('https://example.test/RDP/', true), 'http://127.0.0.1:8787');
    assert.equal(defaultGateway('https://example.test/apps/client/', false), 'https://example.test');
});
test('Gateway origin policy rejects wildcards, null, credentials and path prefixes', () => {
    assert.equal(normalizeOrigin('https://wieslawsoltes.github.io'), 'https://wieslawsoltes.github.io');
    for (const value of ['*', 'null', 'https://*.github.io', 'https://a:b@example.com', 'https://example.com/', 'https://example.com/RDP', 'http://192.168.1.2', null])
        assert.throws(() => normalizeOrigin(value));
});
test('Gateway target request strips ambient credentials, refuses redirects and validates response', async () => {
    const endpoint = gatewayEndpoint('https://gateway.example'), token = 'x'.repeat(64);
    const result = await loadGatewayTargets(endpoint, token, { fetcher: async (url, options) => {
        assert.equal(url, 'https://gateway.example/api/targets');
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        assert.equal(options.credentials, 'omit');
        assert.equal(options.redirect, 'error');
        assert.equal(options.referrerPolicy, 'no-referrer');
        return Response.json({ targets: [{ id: 'desktop', name: 'Desktop', allowTlsOnly: false, secret: 'NOT_COPIED' }] });
    } });
    assert.deepEqual(result, [{ id: 'desktop', name: 'Desktop', allowTlsOnly: false }]);
    assert.ok(Object.isFrozen(result[0]));
    for (const data of [{ targets: [{ id: 'bad id', name: 'x', allowTlsOnly: false }] }, { targets: Array(257).fill({}) }, { targets: null }])
        await assert.rejects(loadGatewayTargets(endpoint, token, { fetcher: async () => Response.json(data) }));
    await assert.rejects(loadGatewayTargets(endpoint, token, { fetcher: async () => new Response('x'.repeat(65537)) }), /exceeds/);
    await assert.rejects(loadGatewayTargets(endpoint, 'bad', { fetcher: () => { throw new Error('Should not fetch'); } }), /private access token/);
});
test('Gateway init creates non-overwriting credential-free configuration and help does not listen', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'rdp-gateway-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const lines = [];
    await runGateway(['init', '--config-dir', dir], s => lines.push(s));
    const data = JSON.parse(await readFile(join(dir, 'targets.json'), 'utf8'));
    assert.equal(data.targets[0].allowTlsOnly, false);
    assert.equal(data.targets[0].password, undefined);
    await assert.rejects(runGateway(['init', '--config-dir', dir], () => {}), /EEXIST/);
    await runGateway(['--help'], s => lines.push(s));
    assert.match(lines.join('\n'), /not an open TCP/);
    await assert.rejects(runGateway(['--port', 'NaN'], () => {}), /Port/);
    await assert.rejects(runGateway(['--https-cert', 'missing'], () => {}), /both/);
    await assert.rejects(runGateway(['unknown'], () => {}), /init or/);
});

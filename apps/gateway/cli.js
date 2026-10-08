#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBridge } from '../bridge/server.js';
import { loadTargets } from '../bridge/Targets.js';

export async function runGateway(args = process.argv.slice(2), log = console.log) {
    const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
        help: { type: 'boolean', short: 'h' }, targets: { type: 'string' },
        'config-dir': { type: 'string', default: '.rdp-gateway' },
        'allow-origin': { type: 'string', multiple: true, default: [] },
        host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '8787' },
        'https-cert': { type: 'string' }, 'https-key': { type: 'string' },
        'public-origin': { type: 'string' }, 'token-file': { type: 'string' },
    } });
    if (values.help) {
        log(`RDP local gateway (Node.js 22+)\n\n  npm run gateway:init\n  npm run gateway -- --allow-origin https://wieslawsoltes.github.io\n\nCommands: init | serve (default)\nOptions: --targets FILE --config-dir DIR --host IP --port PORT\n         --allow-origin EXACT_ORIGIN (repeatable; no wildcards)\n         --https-cert FILE --https-key FILE --public-origin https://localhost:8787\n         --token-file FILE\n\nThe gateway accepts authenticated WebSockets and opens allowlisted RDP TCP/TLS\nconnections. It terminates NLA and handles credentials. It is not an open TCP\nproxy or an implementation of Microsoft's RD Gateway protocol.\n`);
        return;
    }
    const command = positionals[0] || 'serve', dir = resolve(values['config-dir']);
    if (positionals.length > 1 || !['serve', 'init'].includes(command)) throw new Error('Use gateway init or gateway serve.');
    if (command === 'init') {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(resolve(dir, 'targets.json'), JSON.stringify({ targets: [{ id: 'desktop', name: 'My RDP desktop', host: 'localhost', port: 3389, serverName: 'localhost', allowTlsOnly: false }] }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        log(`Created ${resolve(dir, 'targets.json')}\nEdit the host and configure its trusted CA (caFile) or independently verified certSha256.\nNo credentials or certificate-verification bypass were created. Existing files are never overwritten.`);
        return;
    }
    const port = Number(values.port);
    if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535.');
    if (!!values['https-cert'] !== !!values['https-key']) throw new Error('Supply both --https-cert and --https-key.');
    const file = resolve(values.targets || resolve(dir, 'targets.json'));
    const targets = await loadTargets(file);
    let token = randomBytes(32).toString('hex');
    if (values['token-file']) {
        const file = resolve(values['token-file']), info = await stat(file);
        if (!info.isFile() || info.size > 1024 || (process.platform !== 'win32' && (info.mode & 0o077)))
            throw new Error('Token file must be private (chmod 600), regular and at most 1024 bytes.');
        token = (await readFile(file, 'utf8')).trim();
    }
    const tlsOptions = values['https-cert'] ? { cert: await readFile(values['https-cert']), key: await readFile(values['https-key']) } : undefined;
    const bridge = await createBridge({ host: values.host, port, token, targets, tlsOptions,
        publicOrigin: values['public-origin'], allowedOrigins: values['allow-origin'] });
    log(`\nRDP LOCAL GATEWAY\nLocal workspace: ${bridge.origin}\nWebSocket: ${bridge.origin.replace(/^http/, 'ws')}/bridge\nTarget configuration: ${file}\nTargets: ${targets.size}\nAllowed external origins: ${values['allow-origin'].join(', ') || '(none)'}\nPrivate access token: ${bridge.token}\n\nPaste the address and token into the browser app and press Load targets.\nNever publish the token or forward the gateway port. Ctrl+C closes sessions.\n`);
    let stopping = false;
    const stop = async () => { if (!stopping) { stopping = true; await bridge.close(); } };
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
    bridge.server.once('close', () => { for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, stop); });
    return bridge;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
    runGateway().catch(error => { console.error(`RDP gateway: ${error.message}`); process.exitCode = 1; });

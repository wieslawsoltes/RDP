import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { requireThat } from '../../packages/binary/ProtocolError.js';
export async function loadTargets(file) {
    let data;
    try {
        data = JSON.parse(await readFile(file, 'utf8'));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return new Map();
        throw error;
    }
    requireThat(Array.isArray(data.targets) && data.targets.length <= 256, 'TARGET_CONFIG', 'targets.json requires a targets array (maximum 256)');
    const targets = new Map();
    for (const item of data.targets) {
        requireThat(item && typeof item.id === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(item.id) && !targets.has(item.id), 'TARGET_CONFIG', 'Invalid or duplicate target ID');
        requireThat(typeof item.host === 'string' && /^[a-zA-Z0-9_.:\[\]-]{1,253}$/.test(item.host) && !item.host.includes('..'), 'TARGET_CONFIG', 'Invalid target host');
        const port = item.port ?? 3389;
        requireThat(Number.isInteger(port) && port >= 1 && port <= 65535, 'TARGET_CONFIG', 'Invalid target port');
        if (item.serverName !== undefined)
            requireThat(typeof item.serverName === 'string' && /^[a-zA-Z0-9.-]{1,253}$/.test(item.serverName), 'TARGET_CONFIG', 'Invalid TLS server name');
        const pin = item.certSha256?.replaceAll(':', '').toLowerCase();
        if (pin)
            requireThat(/^[a-f0-9]{64}$/.test(pin), 'TARGET_CONFIG', 'Certificate pin must be 64 hexadecimal characters');
        requireThat(item.name === undefined || (typeof item.name === 'string' && item.name.length <= 128), 'TARGET_CONFIG', 'Invalid target display name');
        targets.set(item.id, { id: item.id, name: item.name || item.id, host: item.host, port, serverName: item.serverName, certSha256: pin,
            ca: item.caFile ? await readFile(path.resolve(path.dirname(file), item.caFile)) : undefined, allowTlsOnly: item.allowTlsOnly === true });
    }
    return targets;
}

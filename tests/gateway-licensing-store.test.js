import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGateway, privateLicenseDirectory } from '../apps/gateway/cli.js';
import { loadTargets } from '../apps/bridge/Targets.js';
import { createBridge } from '../apps/bridge/server.js';
import { openLicenseStore, MemoryLicenseStore } from '../apps/gateway/LicenseStore.js';

async function directory(t) {
    const path = await mkdtemp(join(tmpdir(), 'rdp-cli-licensing-'));
    t.after(() => rm(path, { recursive: true, force: true })); return path;
}
test('Gateway target licensing alias is explicit Windows-1252 metadata and is never returned in target inventory', async t => {
    const dir = await directory(t), file = join(dir, 'targets.json');
    const target = { id: 'one', host: 'localhost', licenseUsername: 'Björk' };
    await writeFile(file, JSON.stringify({ targets: [target] }));
    const targets = await loadTargets(file); assert.equal(targets.get('one').licenseUsername, 'Björk');
    const token = 'x'.repeat(32), bridge = await createBridge({ port: 0, token, targets });
    try {
        const response = await fetch(bridge.origin + '/api/targets', { headers: { Authorization: 'Bearer ' + token } });
        assert.equal(response.status, 200); const value = await response.json();
        assert.deepEqual(Object.keys(value.targets[0]).sort(), ['allowTlsOnly', 'id', 'name']);
        assert.equal(value.targets[0].licenseUsername, undefined);
    } finally { await bridge.close(); }
    for (const alias of ['\u0000', '\ud800', 'User🙂', 42]) {
        await writeFile(file, JSON.stringify({ targets: [{ ...target, licenseUsername: alias }] }));
        await assert.rejects(loadTargets(file));
    }
});
test('Gateway CLI closes its encrypted store when HTTP listening fails and preserves the installation identity', async t => {
    const dir = await directory(t);
    const occupied = createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
    const port = occupied.address().port;
    try {
        await assert.rejects(runGateway(['serve', '--config-dir', dir, '--port', String(port)], () => {}), { code: 'EADDRINUSE' });
        await assert.rejects(lstat(join(dir, 'licenses/owner.lock')), { code: 'ENOENT' });
    } finally { await new Promise(resolve => occupied.close(resolve)); }
    const first = await readFile(join(dir, 'licenses/installation.key'));
    const signals = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
    const bridge = await runGateway(['serve', '--config-dir', dir, '--port', String(port)], () => {});
    await assert.rejects(openLicenseStore(join(dir, 'licenses')), { code: 'LICENSE_STORE_LOCKED' });
    await Promise.all([bridge.close(), bridge.close()]);
    assert.deepEqual(await readFile(join(dir, 'licenses/installation.key')), first);
    assert.deepEqual(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)), signals);
    const reopened = await openLicenseStore(join(dir, 'licenses')); await reopened.close();
});
test('An embedding host retains ownership of an explicitly supplied license store', async () => {
    const store = new MemoryLicenseStore(), identity = store.hardwareId();
    const bridge = await createBridge({ port: 0, licenseStore: store });
    await bridge.close(); assert.equal(store.closed, false); assert.deepEqual(store.hardwareId(), identity);
    await store.close();
});

test('Gateway CLI refuses caches in served browser trees, including aliases through a symlinked parent', { skip: process.platform === 'win32' }, async t => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    for (const path of ['apps/client', 'packages', 'dist'])
        await assert.rejects(privateLicenseDirectory(join(root, path, 'not-created-license-cache')), /outside browser/);
    const dir = await directory(t), alias = join(dir, 'public-alias');
    const child = await mkdtemp(join(root, 'packages/license-boundary-test-'));
    try {
        await symlink(child, alias);
        await assert.rejects(privateLicenseDirectory(alias + '/nested'), /outside browser/);
        await assert.rejects(lstat(alias + '/nested/installation.key'), { code: 'ENOENT' });
    } finally { await rm(child, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, lstat, mkdir, unlink, symlink, link, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryLicenseStore, openLicenseStore, licenseNamespace, MAX_CACHED_LICENSE } from '../apps/gateway/LicenseStore.js';
import { product } from './fixtures/Licensing.js';
const ns = 'a'.repeat(64), request = { ...product, scopes: [product.scope] };
const license = (value = 'opaque-server-issued-CAL-fixture') => ({ ...product, data: Buffer.from(value) });
async function directory(t) {
    const path = await mkdtemp(join(tmpdir(), 'rdp-license-store-'));
    t.after(() => rm(path, { recursive: true, force: true })); return path;
}
test('License store owns Buffer inputs, lookup outputs and immutable installation identity', async () => {
    const identity = Buffer.alloc(16, 19), store = new MemoryLicenseStore(identity);
    identity.fill(0); assert.deepEqual(store.hardwareId().subarray(4), new Uint8Array(16).fill(19));
    const value = license(); const saved = store.save(ns, value); value.data.fill(0); await saved;
    const found = store.find(ns, request); assert.equal(Buffer.from(found.data).toString(), 'opaque-server-issued-CAL-fixture');
    found.data.fill(0); assert.ok(store.find(ns, request).data.some(v => v !== 0));
    const secret = [...store.records.values()][0].data; await store.close();
    assert.ok(secret.every(v => v === 0)); assert.ok(store.identity.every(v => v === 0));
    assert.throws(() => store.find(ns, request), /closed/);
});
test('License lookup separates target and user identities and permits certificate renewal', () => {
    const a = { host: 'rdp.example', port: 3389, serverName: 'rdp.example', certSha256: '1'.repeat(64) };
    const credentials = { domain: 'LAB', username: 'User' };
    const first = licenseNamespace(a, credentials);
    assert.equal(first, licenseNamespace({ ...a, certSha256: '2'.repeat(64) }, credentials));
    for (const [target, cred] of [[{ ...a, port: 3390 }, credentials], [{ ...a, host: 'other' }, credentials],
        [a, { ...credentials, username: 'Other' }], [a, { ...credentials, domain: 'OTHER' }]])
        assert.notEqual(first, licenseNamespace(target, cred));
});
test('License cache replaces upgrades only after persistence and rejects downgrades', async () => {
    let release; const store = new MemoryLicenseStore(undefined, () => new Promise(resolve => { release = resolve; }));
    const initial = store.save(ns, license('first')); await Promise.resolve();
    assert.equal(store.find(ns, request), null); release(); await initial;
    const previous = [...store.records.values()][0].data;
    const next = store.save(ns, { ...license('upgrade'), version: product.version + 1 }); await Promise.resolve();
    assert.equal(Buffer.from(store.find(ns, request).data).toString(), 'first'); release(); await next;
    assert.ok(previous.every(v => v === 0)); assert.equal(store.records.size, 1);
    await assert.rejects(store.save(ns, license()), /downgrade/); await store.close();
});
test('License persistence failures retain the previous record and later transactions can recover', async () => {
    let fail = false; const store = new MemoryLicenseStore(undefined, async () => { if (fail) throw new Error('disk failure'); });
    await store.save(ns, license('old')); fail = true;
    await assert.rejects(store.save(ns, license('failed')), /disk failure/);
    assert.equal(Buffer.from(store.find(ns, request).data).toString(), 'old');
    fail = false; await store.save(ns, license('new')); assert.equal(Buffer.from(store.find(ns, request).data).toString(), 'new');
    await store.close();
});
test('License closing drains accepted transactions then rejects new writes and clears owners', async () => {
    let release; const store = new MemoryLicenseStore(undefined, () => new Promise(resolve => { release = resolve; }));
    const save = store.save(ns, license()); await Promise.resolve();
    const close = store.close(); assert.equal(close, store.close()); assert.throws(() => store.save(ns, license()), /closed/);
    release(); await save; await close; assert.equal(store.records.size, 0);
});
test('License store resource limits never silently evict an existing CAL', async () => {
    const store = new MemoryLicenseStore();
    assert.throws(() => store.save(ns, { ...license(), data: new Uint8Array(MAX_CACHED_LICENSE + 1) }), /limit/);
    for (let i = 0; i < 32; i++) await store.save(ns, { ...license(), scope: `${i}` });
    await assert.rejects(store.save(ns, { ...license(), scope: 'overflow' }), /full/);
    assert.equal(store.records.size, 32);
    assert.equal(store.find(ns, { ...request, company: 'Other' }), null);
    assert.equal(store.find('b'.repeat(64), { ...request, scopes: ['0'] }), null);
    assert.equal(store.find(ns, { ...request, scopes: ['0'], version: product.version + 1 }), null);
    await store.close();
});
test('Encrypted CALs and stable installation identity survive process-store reopen', async t => {
    const dir = await directory(t), store = await openLicenseStore(dir), identity = store.hardwareId(), machine = store.machineName();
    t.after(() => store.close()); await store.save(ns, license());
    const encrypted = await readFile(join(dir, 'licenses.bin'));
    assert.equal(encrypted.includes(Buffer.from('opaque-server-issued-CAL-fixture')), false);
    assert.equal(encrypted.includes(Buffer.from(product.company)), false);
    assert.equal(encrypted.includes(Buffer.from(ns)), false);
    if (process.platform !== 'win32') for (const name of ['installation.key', 'licenses.bin', 'owner.lock'])
        assert.equal((await lstat(join(dir, name))).mode & 0o077, 0);
    await store.close();
    const again = await openLicenseStore(dir); t.after(() => again.close());
    assert.deepEqual(again.hardwareId(), identity); assert.equal(again.machineName(), machine);
    assert.equal(Buffer.from(again.find(ns, request).data).toString(), 'opaque-server-issued-CAL-fixture');
});
test('Encrypted cache uses fresh GCM nonces even when persisting identical records', async t => {
    const dir = await directory(t), store = await openLicenseStore(dir); t.after(() => store.close());
    await store.save(ns, license()); const first = await readFile(join(dir, 'licenses.bin'));
    await store.save(ns, license()); const second = await readFile(join(dir, 'licenses.bin'));
    assert.notDeepEqual(first, second); assert.notDeepEqual(first.subarray(8, 20), second.subarray(8, 20));
});
test('License cache exclusive ownership and crash locks do not allow automatic overwrite', async t => {
    const dir = await directory(t), store = await openLicenseStore(dir); t.after(() => store.close());
    await assert.rejects(openLicenseStore(dir), /already open|crash lock/); await store.close();
    await writeFile(join(dir, 'owner.lock'), '999999999\n', { mode: 0o600 });
    await assert.rejects(openLicenseStore(dir), /crash lock/);
    assert.equal(await readFile(join(dir, 'owner.lock'), 'utf8'), '999999999\n');
});
for (const damage of ['ciphertext', 'wrong-key', 'missing-key', 'short-key', 'oversized'])
    test(`License cache ${damage} fails closed without replacing the existing cache`, async t => {
        const dir = await directory(t), store = await openLicenseStore(dir); await store.save(ns, license()); await store.close();
        const file = join(dir, 'licenses.bin'), keyFile = join(dir, 'installation.key');
        if (damage === 'ciphertext') { const data = await readFile(file); data[data.length - 1] ^= 1; await writeFile(file, data); }
        if (damage === 'wrong-key') { const data = await readFile(keyFile); data[12] ^= 1; await writeFile(keyFile, data); }
        if (damage === 'missing-key') await unlink(keyFile);
        if (damage === 'short-key') await writeFile(keyFile, Buffer.alloc(55));
        if (damage === 'oversized') await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
        const before = await readFile(file); await assert.rejects(openLicenseStore(dir));
        assert.deepEqual(await readFile(file), before);
        await assert.rejects(lstat(join(dir, 'owner.lock')), { code: 'ENOENT' });
    });
test('License cache identity does not rotate merely because the cache contains no CALs', async t => {
    const dir = await directory(t), store = await openLicenseStore(dir), identity = store.hardwareId(); await store.close();
    await unlink(join(dir, 'licenses.bin'));
    const again = await openLicenseStore(dir); t.after(() => again.close()); assert.deepEqual(again.hardwareId(), identity);
});
test('License cache serialized concurrent writes survive reopen without lost updates', async t => {
    const dir = await directory(t), store = await openLicenseStore(dir);
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.save(ns, { ...license(`${i}`), scope: `${i}` })));
    await store.close(); const again = await openLicenseStore(dir); t.after(() => again.close());
    assert.equal(again.records.size, 20);
    for (let i = 0; i < 20; i++) assert.equal(Buffer.from(again.find(ns, { ...request, scopes: [`${i}`] }).data).toString(), `${i}`);
});
test('License cache failed atomic replacement leaves the in-memory record unmodified', async t => {
    const dir = await directory(t), store = await openLicenseStore(dir); t.after(() => store.close()); await store.save(ns, license('old'));
    await rename(join(dir, 'licenses.bin'), join(dir, 'old.bin')); await mkdir(join(dir, 'licenses.bin'));
    await assert.rejects(store.save(ns, license('new')));
    assert.equal(Buffer.from(store.find(ns, request).data).toString(), 'old');
    await rm(join(dir, 'licenses.bin'), { recursive: true }); await rename(join(dir, 'old.bin'), join(dir, 'licenses.bin'));
});
test('License cache rejects exposed POSIX permissions, symlinks and hardlinks', { skip: process.platform === 'win32' }, async t => {
    const dir = await directory(t); await chmod(dir, 0o755); await assert.rejects(openLicenseStore(dir), /private/); await chmod(dir, 0o700);
    const store = await openLicenseStore(dir); await store.close();
    await chmod(join(dir, 'installation.key'), 0o644); await assert.rejects(openLicenseStore(dir), /private/);
    await chmod(join(dir, 'installation.key'), 0o600);
    await link(join(dir, 'installation.key'), join(dir, 'key-copy'));
    await assert.rejects(openLicenseStore(dir), /Hard-linked/); await unlink(join(dir, 'key-copy'));
    const destination = join(dir, 'licenses.bin'); await rename(destination, join(dir, 'original.bin'));
    await symlink(join(dir, 'original.bin'), destination); await assert.rejects(openLicenseStore(dir));
    const other = join(dir, 'alias'); await symlink(dir, other); await assert.rejects(openLicenseStore(other));
});

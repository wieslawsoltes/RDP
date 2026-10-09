import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, lstat, unlink, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { requireThat, ProtocolError } from '../../packages/binary/ProtocolError.js';

const MAX_RECORDS = 32, MAX_FILE = 2 * 1024 * 1024;
// The current RDP transport uses unsegmented 15-bit MCS lengths. Keep a CAL
// small enough to present with the RSA, HWID and security headers next time.
export const MAX_CACHED_LICENSE = 24576;
const KEY_MAGIC = Buffer.from('RDPKEY1\0'), CACHE_MAGIC = Buffer.from('RDPCAL1\0');
const digest = value => createHash('sha256').update(value).digest('hex');
const copy = value => ({ ...value, data: new Uint8Array(value.data) });
const id = (namespace, license) => JSON.stringify([namespace, license.scope, license.company, license.product]);

/** Separate targets and users; an ordinary TLS certificate renewal retains its CAL. */
export function licenseNamespace(target, credentials) {
    return digest(JSON.stringify([target.host, target.port ?? 3389, target.serverName || target.host,
        credentials.domain, credentials.username]));
}
function validate(namespace, value) {
    requireThat(typeof namespace === 'string' && /^[a-f0-9]{64}$/.test(namespace), 'LICENSE_STORE', 'Invalid license namespace');
    requireThat(value && Number.isInteger(value.version) && value.version >= 0 && value.version <= 0xffffffff,
        'LICENSE_STORE', 'Invalid stored license version');
    for (const name of ['scope', 'company', 'product'])
        requireThat(typeof value[name] === 'string' && value[name].length <= 2047 && value[name].isWellFormed() && !value[name].includes('\0'),
            'LICENSE_STORE', 'Invalid stored license index');
    requireThat(value.data instanceof Uint8Array && value.data.length > 0 && value.data.length <= MAX_CACHED_LICENSE,
        'LICENSE_STORE', 'License exceeds the supported 24 KiB transport/cache limit');
}

/** No persistence unless explicitly supplied by the gateway CLI or embedding host. */
export class MemoryLicenseStore {
    constructor(identity = randomBytes(16), persist = async () => {}) {
        requireThat(identity instanceof Uint8Array && identity.length === 16, 'LICENSE_STORE', 'Invalid installation identity');
        this.identity = new Uint8Array(identity); this.records = new Map();
        this.persist = persist; this.tail = Promise.resolve(); this.closed = false;
        this.closing = null;
    }
    hardwareId() {
        requireThat(!this.closed, 'LICENSE_STORE_CLOSED', 'License store is closed');
        // No impersonation of a Microsoft OS/vendor ID: use the OTHER platform.
        const value = new Uint8Array(20); value.set(this.identity, 4); return value;
    }
    machineName() { return `LRDP-${Buffer.from(this.identity).toString('hex').slice(0, 10)}`; }
    find(namespace, request) {
        requireThat(!this.closed, 'LICENSE_STORE_CLOSED', 'License store is closed');
        for (const scope of request.scopes) {
            const value = this.records.get(id(namespace, { ...request, scope }));
            if (value && value.version >= request.version) return copy(value);
        }
        return null;
    }
    save(namespace, license) {
        requireThat(!this.closed, 'LICENSE_STORE_CLOSED', 'License store is closed'); validate(namespace, license);
        const owned = copy(license), key = id(namespace, owned);
        const operation = this.tail.then(async () => {
            const previous = this.records.get(key);
            requireThat(!previous || owned.version >= previous.version, 'LICENSE_STORE', 'Refusing a cached-license downgrade');
            requireThat(previous || this.records.size < MAX_RECORDS, 'LICENSE_STORE_FULL', 'License cache is full; existing CALs were not discarded');
            const next = new Map(this.records); next.set(key, owned);
            // Atomic persistence precedes the in-memory commit and protocol success.
            await this.persist(next);
            this.records = next; previous?.data.fill(0);
        }).finally(() => { if (this.records.get(key) !== owned) owned.data.fill(0); });
        this.tail = operation.catch(() => {});
        return operation;
    }
    close() {
        if (this.closing) return this.closing;
        this.closed = true;
        return this.closing = this.tail.then(() => {
            for (const value of this.records.values()) value.data.fill(0);
            this.records.clear(); this.identity.fill(0); this.persist = async () => {};
        });
    }
}

function privateInfo(info, directory = false) {
    requireThat(directory ? info.isDirectory() : info.isFile(), 'LICENSE_STORE_FILE', 'License storage must use regular files and directories');
    if (process.platform !== 'win32')
        requireThat((info.mode & 0o077) === 0 && (typeof process.getuid !== 'function' || info.uid === process.getuid()),
            'LICENSE_STORE_PERMISSIONS', 'License storage must be owned by this user and private (directory 700, files 600)');
    if (!directory) requireThat(info.nlink === 1, 'LICENSE_STORE_FILE', 'Hard-linked license files are not accepted');
}
async function readPrivate(path, max) {
    let file;
    try {
        file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        const info = await file.stat(); privateInfo(info);
        requireThat(info.size <= max, 'LICENSE_STORE_FILE', 'License file exceeds its size budget');
        // A bounded read also covers concurrent changes to a file's reported size.
        const bytes = Buffer.alloc(max + 1); let position = 0;
        try {
            while (position < bytes.length) {
                const { bytesRead } = await file.read(bytes, position, bytes.length - position, position);
                if (!bytesRead) break; position += bytesRead;
            }
            requireThat(position <= max, 'LICENSE_STORE_FILE', 'License file grew beyond its size budget');
            return Buffer.from(bytes.subarray(0, position));
        } finally { bytes.fill(0); }
    } finally { await file?.close(); }
}
async function atomicWrite(directory, destination, bytes) {
    const temporary = join(directory, `.pending-${randomBytes(16).toString('hex')}`);
    let file;
    try {
        file = await open(temporary, 'wx', 0o600);
        await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
        await rename(temporary, destination);
        if (process.platform !== 'win32') {
            const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
            try { await dir.sync(); } finally { await dir.close(); }
        }
    } finally {
        await file?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
}
const missing = error => error.code === 'ENOENT';

/**
 * Private AES-256-GCM CAL cache with one installation identity and exclusive
 * process ownership. A crash lock is deliberately not removed automatically.
 * POSIX permissions are checked; Windows deployments must protect this directory
 * with their account's ACL. The key is not an OS keychain or a password vault.
 */
export async function openLicenseStore(directory) {
    directory = resolve(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory); privateInfo(info, true);
    const lockPath = join(directory, 'owner.lock'), keyPath = join(directory, 'installation.key'), cachePath = join(directory, 'licenses.bin');
    let lock, lockInfo, secrets, store;
    const release = async () => {
        if (!lock) return;
        await lock.close(); lock = null;
        const current = await lstat(lockPath).catch(error => { if (!missing(error)) throw error; });
        if (current && current.ino === lockInfo.ino && current.dev === lockInfo.dev) await unlink(lockPath);
    };
    try {
        try { lock = await open(lockPath, 'wx', 0o600); }
        catch (error) { if (error.code === 'EEXIST') throw new ProtocolError('LICENSE_STORE_LOCKED', 'License cache is already open or has a crash lock; verify no gateway is running before removing owner.lock'); throw error; }
        lockInfo = await lock.stat(); await lock.writeFile(`${process.pid}\n`); await lock.sync();
        let cached = await readPrivate(cachePath, MAX_FILE).catch(error => { if (!missing(error)) throw error; });
        secrets = await readPrivate(keyPath, 56).catch(error => { if (!missing(error)) throw error; });
        if (!secrets) {
            requireThat(!cached, 'LICENSE_STORE_KEY', 'An encrypted license cache exists without its installation key');
            secrets = Buffer.concat([KEY_MAGIC, randomBytes(32), randomBytes(16)]);
            const file = await open(keyPath, 'wx', 0o600);
            try { await file.writeFile(secrets); await file.sync(); } finally { await file.close(); }
        }
        requireThat(secrets.length === 56 && secrets.subarray(0, 8).equals(KEY_MAGIC), 'LICENSE_STORE_KEY', 'Invalid installation key file');
        const key = secrets.subarray(8, 40), identity = secrets.subarray(40);
        const aad = Buffer.concat([CACHE_MAGIC, identity]);
        const encode = records => {
            const plain = Buffer.from(JSON.stringify({ version: 1, records: [...records].map(([key, value]) =>
                [key, { ...value, data: Buffer.from(value.data).toString('base64') }]) }));
            try {
                requireThat(plain.length + 36 <= MAX_FILE, 'LICENSE_STORE_FULL', 'License cache exceeds its total size budget');
                const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
                cipher.setAAD(aad);
                const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
                return Buffer.concat([CACHE_MAGIC, nonce, cipher.getAuthTag(), encrypted]);
            } finally { plain.fill(0); }
        };
        store = new MemoryLicenseStore(identity, async records => {
            const bytes = encode(records);
            try { await atomicWrite(directory, cachePath, bytes); } finally { bytes.fill(0); }
        });
        if (cached) {
            let plain;
            try {
                requireThat(cached.length >= 36 && cached.subarray(0, 8).equals(CACHE_MAGIC), 'LICENSE_STORE_DATA', 'Invalid encrypted cache header');
                const cipher = createDecipheriv('aes-256-gcm', key, cached.subarray(8, 20));
                cipher.setAAD(aad); cipher.setAuthTag(cached.subarray(20, 36));
                // Do not expose unauthenticated output even on final() failure.
                const partial = cipher.update(cached.subarray(36));
                try { const final = cipher.final(); plain = Buffer.concat([partial, final]); final.fill(0); }
                finally { partial.fill(0); }
                const document = JSON.parse(plain.toString('utf8'));
                requireThat(document.version === 1 && Array.isArray(document.records) && document.records.length <= MAX_RECORDS,
                    'LICENSE_STORE_DATA', 'Invalid encrypted cache inventory');
                for (const entry of document.records) {
                    requireThat(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && entry[0].length <= 32768,
                        'LICENSE_STORE_DATA', 'Invalid cache index');
                    const [cacheId, value] = entry, [namespace] = JSON.parse(cacheId);
                    requireThat(value && typeof value.data === 'string' && value.data.length <= MAX_CACHED_LICENSE * 4 / 3,
                        'LICENSE_STORE_DATA', 'Invalid encoded CAL');
                    const data = Buffer.from(value.data, 'base64');
                    try {
                        requireThat(data.toString('base64') === value.data, 'LICENSE_STORE_DATA', 'Noncanonical encoded CAL');
                        validate(namespace, { ...value, data });
                        requireThat(cacheId === id(namespace, value) && !store.records.has(cacheId), 'LICENSE_STORE_DATA', 'Invalid or duplicate cache key');
                        store.records.set(cacheId, { version: value.version, scope: value.scope, company: value.company, product: value.product, data: new Uint8Array(data) });
                    } finally { data.fill(0); }
                }
            } catch { throw new ProtocolError('LICENSE_STORE_DATA', 'Encrypted license cache failed authentication or validation; it was not replaced'); }
            finally { plain?.fill(0); cached.fill(0); cached = null; }
        } else await store.persist(store.records);
        const close = store.close.bind(store); let closing;
        store.close = () => closing ||= close().finally(async () => { secrets.fill(0); aad.fill(0); await release(); });
        return store;
    } catch (error) {
        await store?.close(); secrets?.fill(0); await release(); throw error;
    }
}

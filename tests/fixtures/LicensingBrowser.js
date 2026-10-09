import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLicensingPeer } from './LicensingPeer.js';
import { makeCertificate, serveRdp } from './NetworkServer.js';
import { openLicenseStore } from '../../apps/gateway/LicenseStore.js';
import { createBridge } from '../../apps/bridge/server.js';

// The protocol peer is co-developed; CAL bytes are test fixtures, not RDS CALs.
const certificate = await makeCertificate(), directory = await mkdtemp(join(tmpdir(), 'rdp-browser-cal-'));
const store = await openLicenseStore(directory), saved = store.save.bind(store);
let released = false, release;
const permitSave = new Promise(resolve => { release = () => { released = true; resolve(); }; });
store.save = async (namespace, license) => {
    const owned = { ...license, data: new Uint8Array(license.data) };
    try {
        console.log('LICENSE_SAVE_PENDING');
        if (!released) await permitSave;
        await saved(namespace, owned); console.log('LICENSE_SAVE_COMMITTED');
    } finally { owned.data.fill(0); }
};
let count = 0;
const remote = await serveRdp(certificate, { nla: true, configurePeer: peer => {
    const number = ++count;
    configureLicensingPeer(peer, { mode: number === 1 ? 'issue' : 'cached',
        onEvent: event => console.log('LICENSE_PEER', number, event) });
} });
const denied = await serveRdp(certificate, { nla: true,
    configurePeer: peer => configureLicensingPeer(peer, { mode: 'bad-license' }) });
const bridge = await createBridge({ port: 8798, token: 'browser-fixture-token-0123456789abcdef',
    licenseStore: store, allowedOrigins: ['http://127.0.0.1:8799'],
    targets: new Map([['issued', { id: 'issued', name: 'License issuance fixture', host: '127.0.0.1', port: remote.port,
        serverName: 'localhost', ca: certificate.cert, allowTlsOnly: false }],
    ['bad', { id: 'bad', name: 'Bad license MAC fixture', host: '127.0.0.1', port: denied.port,
        serverName: 'localhost', ca: certificate.cert, allowTlsOnly: false }]]) });
const commands = createInterface({ input: process.stdin });
commands.on('line', line => {
    if (line === 'release') release();
    else if (line === 'check') {
        assert.equal(store.records.size, 1); assert.equal(count, 2);
        assert.equal(remote.errors.length, 0); assert.equal(denied.errors.length, 0);
        assert.equal(remote.credentialRecords.filter(c => c.passwordVerified).length, 2);
        console.log('LICENSE_FIXTURE_CHECKED');
    } else throw new Error('Invalid test control');
});
console.log('LICENSE_BROWSER_READY');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    if (stopping) return; stopping = true; release(); commands.close();
    await bridge.close(); await Promise.all([remote.close(), denied.close()]);
    await store.close(); await certificate.close(); await rm(directory, { recursive: true, force: true });
});

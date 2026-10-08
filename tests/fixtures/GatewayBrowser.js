import { makeCertificate, serveRdp } from './NetworkServer.js';
import { createBridge } from '../../apps/bridge/server.js';
const cert = await makeCertificate();
const remote = await serveRdp(cert, { nla: true });
const bridge = await createBridge({ port: 8798, token: 'browser-fixture-token-0123456789abcdef', allowedOrigins: ['http://127.0.0.1:8799'], targets: new Map([['fixture', { id: 'fixture', name: 'Protocol fixture', host: '127.0.0.1', port: remote.port, serverName: 'localhost', ca: cert.cert, allowTlsOnly: false }]]) });
console.log('Browser gateway fixture ready');
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, async()=> { await bridge.close(); await remote.close(); await cert.close(); });

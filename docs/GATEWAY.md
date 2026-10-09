# Local WebSocket-to-RDP gateway

```
GitHub Pages HTML/JS/WebGPU client
  -> authenticated WS or WSS, explicit Origin
  -> local Node.js gateway
  -> allowlisted TCP / verified TLS / CredSSP
  -> RDP server
```

Run `npm run gateway:init`, edit `.rdp-gateway/targets.json`, then:

```
npm run gateway -- --allow-origin https://wieslawsoltes.github.io
```

The gateway defaults to IPv4 loopback port 8787. The browser form accepts a
separate gateway origin and derives its `/api/targets` and `/bridge` URLs.
No URL parameters, deep links or imported profiles can silently redirect
credentials. Changing the endpoint clears credentials and the loaded target
list. Requests omit ambient cookies, reject HTTP redirects, enforce a timeout
and bound inventory response bytes. Gateway credentials are never persisted.

CORS allows only exact configured origins, GET and Authorization. Protected
APIs still require the bearer token. WebSocket upgrade validates Host, Origin,
rate limits and total session limits. The token is sent in the first control
frame, not in the URL. Arbitrary addresses from the browser are not accepted.
The existing TLS/NLA connector, binary framing, heartbeat, bounded TCP writes
and receive-credit backpressure remain in use. Ctrl+C closes active sessions.

For browser policies that block HTTPS-to-loopback WS, use a trusted local HTTPS
certificate with `--https-cert`, `--https-key`, and `--public-origin`. Enter its
HTTPS origin in the form. Grant local-network permissions where prompted.
Alternatively open the same-origin workspace served by the local gateway.
Do not disable mixed-content protection or certificate validation. A gateway
certificate and an RDP-server certificate are distinct trust relationships.

`--allow-origin` is repeatable (32 maximum); wildcard origins and non-loopback
HTTP origins are rejected. GitHub Pages projects on the same hostname share
one origin: `/RDP` is not an isolation boundary. Use a dedicated hostname or the
local same-origin app to avoid trusting other projects on that Pages origin.

The gateway is trusted with credentials and decrypted traffic. This is not
Microsoft RD Gateway/RD-Gateway-over-HTTP, a VPN, raw arbitrary TCP access, or
an authentication bypass. NLA remains the default. TLS-only must be enabled
for each target in trusted local configuration. No RDP-server secrets are
shipped in the Pages build. Source contains no npm runtime dependencies.

Validation includes cross-origin preflight/authorization and a real local
WebSocket -> TCP -> TLS/CredSSP -> activated RDP fixture. The peer fixture is
co-developed with the client; independent Windows interoperability is not
established by those tests. Browser cross-origin policy is separately tested
when a browser is available.

## Large transfers and backpressure

The browser negotiates optional `inputFlowControl: true`. The ready message
then grants a 256 KiB input window. Binary bytes consume that window and the
gateway returns `input-ack` credits only after their TCP/TLS write callbacks.
This acknowledges transport consumption, not remote RDP application execution.
The browser owns a bounded 32 MiB outbound queue, sends bounded bursts, checks
native WebSocket bufferedAmount and fails a stalled queue after 30 seconds.
Disconnect cancels timers and clears queued binary data. The existing reverse
direction receive-credit flow remains independent. Legacy clients can still
use the previous bounded-write mode; use the matching updated gateway for
large clipboard transfers. Gateway source is never included in Pages assets.

## Connection health and reconnection

The session footer reports gateway responsiveness separately from RDP state.
The browser worker keeps one correlated application probe outstanding, warns
at ten seconds without its pong and fails at twenty seconds. Opening the
WebSocket, completing TLS/NLA and activating/reactivating RDP have independent
15/35/60-second limits. A responsive active session is not disconnected just
because its desktop is idle. Worker suspension delays observation of deadlines;
overdue work is checked on resume. These probes do not measure server liveness.

After failure, remote input/resize is disabled and clipboard/audio state is
released. Reconnect returns sanitized metadata to setup, closes the old tab,
clears the gateway token/password and requires fresh target discovery. It
preserves the CURRENT explicitly selected gateway address, never silently
restores an older endpoint, and does not store passwords for automatic retry.
This is a new authentication, not RDP auto-reconnect-cookie session resumption.
See `docs/changes/0010-connection-health.md` for implementation/test scope.

## Licensing cache

The CLI now owns the authenticated RDP licensing exchange and its private cache.
By default the store is `.rdp-gateway/licenses`; set `--license-dir /private/path`
to choose another protected directory outside the browser source/build roots.
`installation.key` and `licenses.bin` belong together and must never be published.
Do not delete or rotate the installation identity as an attempted licensing
bypass. `owner.lock` is intentionally retained after a crash; verify no gateway
is running before removing a stale lock. Cache tamper, missing keys and server
licensing denials fail closed, not as a successful connection.

`node apps/bridge/server.js` and an embedded `createBridge()` without an adapter
use an in-memory store instead; use the gateway CLI for persistent CALs. Explicit
store adapters are owned by their embedding caller. The browser gets licensing
status only, while the gateway pauses activation until the CAL has been saved.
Optional target `licenseUsername` changes only narrow licensing metadata, not
the UTF-16 NLA account. See [the exact licensing profile](changes/0011-licensing-integration.md)
for supported fields, 24 KiB CAL and 32-record limits and unqualified server cases.


## Microphone redirection

Microphone samples travel through the existing authenticated WebSocket and RDP
DVC transport. No second media server, additional socket or device permission
is granted to the gateway. The browser owns the microphone and exposes a separate
Start/Stop control after the server requests AUDIO_INPUT. The channel offer is
disabled by default; no automatic capture is enabled by a saved profile.

The gateway-hosted same-origin workspace permits `microphone=(self)`. All browser
permission, secure-context and local-network policies still apply to separately
hosted Pages. Use the supported same-origin workspace or trusted HTTPS gateway
rather than disabling browser protections. PCM16 is supported; compressed audio,
cameras and generic device redirection remain outside this feature.

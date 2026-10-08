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

# LRDP Web 0.1.0

An independently written RDP browser client with a responsive connection workspace, a transport-independent JavaScript protocol core, WebGPU compute/presentation code, two rendering fallbacks, and a constrained Node.js TCP/TLS/CredSSP bridge.

**Status: experimental bitmap-profile implementation, not a complete RDP implementation or a Windows-qualified production client.** The source is runnable and includes real packet processing, authentication code, a protocol lab, and automated tests. Unsupported capabilities are not advertised. Windows interoperability, GPU execution on physical hardware, and an independent security review remain outstanding. Read [the exact protocol matrix](docs/PROTOCOL_MATRIX.md) before connecting to a real host.

![Connection workspace](test-results/workspace-desktop.png)

## Run the application

Install a maintained Node.js release compatible with Node 22 or newer. There are no npm or other runtime package dependencies and no compilation step.

```sh
cd lrdp-web
node apps/bridge/server.js
```

Open the exact URL printed by the process, normally **http://127.0.0.1:8787**. Select **Launch local lab** to exercise the application without a remote machine. The local lab encodes MCS, activation, bitmap, input, clipboard, and display-control PDUs and runs them through the client. It is a synthetic desktop, not Windows and not a simulated claim of Windows connectivity.

The bridge generates a private access token at startup and prints it to the terminal. The lab does not need it. Connecting to an allowlisted remote host does.

## Configure an experimental remote connection

Copy `targets.example.json` to `targets.json`, replace the example host and TLS name, and provide the issuing CA certificate. Paths in `caFile` are relative to the target configuration file.

```json
{
  "targets": [
    {
      "id": "workstation",
      "name": "Development workstation",
      "host": "rdp.example.internal",
      "port": 3389,
      "serverName": "rdp.example.internal",
      "caFile": "company-ca.pem",
      "allowTlsOnly": false
    }
  ]
}
```

Omit `caFile` to use the Node trust store. For a private self-signed certificate, an administrator can instead configure `certSha256` with the exact 64-hex-digit SHA-256 fingerprint of the DER certificate, verified out of band. Pinning is an explicit alternative trust policy, not automatic trust-on-first-use; expiration is still checked. A certificate change requires configuration review. Never use a fingerprint obtained from an unverified connection as the sole identity check.

Restart the process after editing the allowlist. In the connection form, paste the bridge token, load the targets, select a target ID, and supply the account credentials. NLA is the default. TLS-only mode is offered only for targets explicitly configured with `allowTlsOnly: true`; the application does not silently retry with weaker authentication.

**Important interoperability limit:** licensing currently accepts only the server's valid-client licensing alert. License issuance, CAL persistence, and renewal are not implemented. A real server requesting those exchanges will fail with an explicit error. Kerberos-only environments, gateway-only access, and unsupported authentication variants also will not work. No Windows version is presently qualified by the included evidence.

The browser can choose only an administrator-defined target ID, never an arbitrary TCP host. Saved profiles contain connection metadata, not passwords or bridge tokens. `.rdp` import/export is a metadata convenience, not complete `.rdp` file compatibility; imported addresses must be mapped to an allowlisted target.

## Access from a phone or another computer

The default HTTP listener is loopback only. For non-loopback access, supply an HTTPS certificate trusted by the client devices and the exact externally used origin:

```sh
LRDP_BIND=0.0.0.0 \
LRDP_PORT=8787 \
LRDP_PUBLIC_ORIGIN=https://rdp-ui.example.internal:8787 \
LRDP_HTTPS_CERT=/secure/ui-cert.pem \
LRDP_HTTPS_KEY=/secure/ui-key.pem \
LRDP_TARGETS=/secure/targets.json \
node apps/bridge/server.js
```

The browser-to-bridge HTTPS certificate and bridge-to-RDP certificate are separate trust relationships. Keep the bridge on a trusted network during development. It is not a hardened public multi-tenant service. WebGPU and local clipboard access depend on browser capabilities, secure-context rules, permissions, and hardware availability; the GUI reports actual renderer selection. Responsive layout does not imply every browser or device has been tested.

## What is implemented

| Area | Included behavior |
|---|---|
| Workspace | Session tabs, saved metadata profiles, target loading, dark/light themes, responsive layout, desktop fit/native size, screenshots, fullscreen request, diagnostics and error states. |
| Security transport | Original RFC 6455 bridge transport; TCP, X.224 negotiation, verified TLS, CredSSP 5/6 with NTLMv2, MIC, channel binding, directional signing/sealing, and server binding verification before credential delegation. |
| Session core | Bounds-checked TPKT/fast-path framing, BER/PER/GCC/MCS, joins, activation/reactivation, selected Share Control/Data PDUs, bitmap updates, palette and pointer caches. |
| Graphics | Uncompressed 8/15/16/24/32-bit bitmap decoding; interleaved RLE for 8/15/16/24-bit pixels; bottom-up/padded rows; overlapping update ordering; classic AND/XOR and 32-bit alpha pointer handling. |
| Renderers | WGSL packed-pixel conversion into a persistent RGBA desktop texture and GPU cursor presentation; WebGL2 fallback with CPU pixel conversion; Canvas 2D fallback. GPU implementations have not been runtime-validated in the supplied environment. |
| Input | Scan-code keys, Unicode UTF-16 input, mouse and wheel, extra mouse buttons, shortcut controls, release-on-blur, pointer capture, touch/pen mapped to mouse. Native RDP multitouch/pen is not implemented. |
| Clipboard | Bidirectional Unicode text over `cliprdr`, explicit browser clipboard actions, format negotiation, stale-response handling, resource limits. No images or file clipboard. |
| Display control | Reliable dynamic channels and one-primary-monitor resize through the display-control channel and server reactivation. No multi-monitor layout. |
| Diagnostics | Measured packet/byte/bitmap counters, renderer submission cost, presented-frame rate, optional GPU timestamps when available, bridge-only RTT, downloadable reports. |

Audio, microphones, webcams, drive/USB/printer/smart-card redirection, RemoteApp, gateways, UDP/multitransport, advanced graphics codecs, general drawing orders, and full licensing are **not implemented**. The complete distinctions are in [PROTOCOL_MATRIX.md](docs/PROTOCOL_MATRIX.md).

## Architecture

```text
Browser HTML/CSS workspace and input
          │ commands / transferable frame data
          ▼
Per-session module worker: RDP state machine, channels, bitmap/RLE decode
          │                                    │
          │ bounded ordered render batches     │ WebSocket + receive credits
          ▼                                    ▼
WebGPU compute → persistent texture     Node bridge: allowlist + authentication
→ cursor/presentation                  → X.224 → verified TLS → CredSSP/NTLMv2
WebGL2 / Canvas fallbacks                       │
                                               ▼
                                      Ordinary TCP RDP server
```

**The bridge is a trusted credential endpoint.** It performs TLS/NLA and can see credentials and decrypted RDP bytes. This is not an end-to-end encrypted tunnel from the browser directly to the RDP server. Protocol parsing after security establishment and graphics rendering remain client-side; there is no FreeRDP, xrdp, Guacamole, screenshot-streaming, or video-proxy backend.

The GPU path accelerates packed-pixel conversion and presentation. RLE entropy/run decoding currently executes in the worker on the CPU. It is not a compute-only RDP engine. Uploads are dirty-rectangle based, while cursor composition reads the persistent desktop without modifying it. Batches preserve painter's order by splitting around intersecting destinations. Worker render credits and bridge receive credits bound queued work. See [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Validate the source

```sh
npm run check
npm test
npm run test:fuzz
npm run bench
```

`npm test` uses Node's built-in test runner; the network fixtures additionally need an `openssl` executable to create temporary test certificates. Browser tests are optional and require Python Playwright and Chromium:

```sh
python -m pip install playwright
python -m playwright install chromium
# Keep the application running in another terminal.
python tools/browser-gui-tests.py
python tools/browser-render-tests.py
```

Use `CHROMIUM` to select an installed Chromium executable and `LRDP_TEST_ORIGIN` to change the test origin. Renderer tests fail on unavailable backends by default; `--allow-unavailable` explicitly permits reporting an unavailable GPU backend without calling it a pass. It never suppresses incorrect pixels or shader/runtime failures. See [TESTING.md](docs/TESTING.md).

### Evidence shipped with this version

The `test-results/` directory contains the captured output, not a badge standing in for a qualification program:

- **81 Node tests passed**, including real TCP/TLS and CredSSP exchanges against an independently structured but co-developed local fixture, certificate rejection, wrong-binding rejection, packet parsing, virtual channels and WebSocket behavior.
- **100,000 deterministic malformed-input cases**, with zero unexpected exceptions under the smoke-fuzzer's classifier. This is not coverage-guided fuzzing or a security audit.
- **Canvas pixel comparison: 40,960 pixels, zero differences**, including zero classic-cursor comparison differences for the fixture. GUI smoke tests exercised activation, Unicode sending, clipboard sending, resize to 800×600, profile saving, and desktop/mobile layout, with no uncaught page errors.
- **WebGPU and WebGL2 execution unverified:** the test browser returned no WebGPU adapter and no WebGL2 context. Code exists, but physical GPU correctness/performance is not established.

Tests against a server written alongside the client can share mistakes. They are not independent Windows or third-party implementation conformance evidence. The benchmark JSON contains local CPU microbenchmarks only, not remote latency, desktop FPS, or GPU throughput claims.

## Source organization

`packages/binary`, `protocol`, `channels`, `codecs`, `render`, `input`, `profiles`, `security`, `transport`, and `lab` are native ES modules with granular files. The protocol/codec/channel core can be imported without a browser or Node transport. Security and transport modules require Node. The web GUI is in `apps/client`; the bridge is in `apps/bridge`. They are source modules, not separately published npm packages in this release.

[Protocol matrix](docs/PROTOCOL_MATRIX.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](docs/SECURITY.md) · [Testing](docs/TESTING.md) · [Public specification sources](docs/SOURCES.md) · [Qualification roadmap](docs/ROADMAP.md)

## Provenance and license

This source was written for this project against public protocol specifications; it does not vendor or link an existing RDP implementation. The implementation and the local fixtures were developed together. This provenance statement is not a formal two-team clean-room attestation, security certification, patent clearance, or interoperability certification. The source is distributed under [MIT](LICENSE); referenced specifications retain their publishers' terms.

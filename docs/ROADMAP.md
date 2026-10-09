# Qualification roadmap

This is remaining engineering scope, not implemented capability or a promise of completed background work.

## 1. Independent baseline interoperability

Run recorded, reproducible tests against independently implemented RDP servers and current Windows client/server editions in an authorized lab. Capture requested/selected capabilities, certificate mode, authentication package and first failing PDU without capturing passwords. Turn every mismatch into a literal-wire regression fixture. Cover domain/local accounts, Unicode names, NLA and explicitly enabled TLS-only, session reactivation, pointer updates, keyboard layouts, clipboard races and slow/fragmented networks.

Extend and independently qualify the implemented gateway licensing exchange and encrypted store beyond its current bounded profile; qualify activation/control ordering, server information PDUs and compression negotiation. Do not turn off bounds or certificate checking merely to make a host connect.

## 2. Renderer and performance qualification

Run deterministic pixel/cursor fixtures and error-scope checks on physical Apple, Intel, AMD, NVIDIA and mobile adapters across supported browsers. Add GPU-loss, resize-while-readback, memory-pressure and large/malicious desktop tests. Profile decoding, transfer, upload, compute, presentation, network and input-to-photon separately. Only publish an FPS/latency claim with resolution, codec, network, hardware and trace methodology.

## 3. Graphics protocol expansion

Add negotiated bitmap caches/drawing orders where useful, MPPC/RDP bulk compression, RDP6 planar, surface commands, NSCodec/RemoteFX and RDPGFX codec paths. AVC paths require their own packet assembly, decoder capability/format checks, fallback strategy and lifecycle handling; merely having WebCodecs available does not implement RDPGFX. Add protocol frame acknowledgement and congestion/backpressure behavior with independent test evidence.

## 4. Network and identity expansion

Add general SPNEGO/Kerberos integration with a trusted host credential provider, supported modern authentication policies, broker redirection, RD Gateway, RDPUDP/multitransport, reconnection cookies and secure resumption. Each needs explicit trust and authorization boundaries; neither browser storage nor target profiles should become a password vault accidentally.

## 5. Device and application channels

Implement audio output/input, filesystem/printer redirection, smart cards, cameras, RemoteApp, multi-monitor, native RDP touch/pen and selected USB classes as separately testable modules. Where a browser lacks necessary native access, use an explicit consented native-host adapter rather than claiming generic device support. Give each module its own permissions, cancellation, hot-unplug behavior, queue limits and ownership policy.

## 6. Security and release gates

Independent parser/crypto/bridge audit, coverage-guided and stateful fuzzing, stable wire captures, real-server compatibility matrix, real-device/browser matrix, secrets lifecycle, deployment policy, accessibility audit, signed releases and reproducible artifacts. Preserve the distinction between independently implemented code, formal clean-room process, conformance evidence and patent/legal status.

# Architecture and extension boundaries

## 1. Ownership and trust

The browser owns the workspace, user input, post-security RDP protocol parsing and remote display. Each session creates one module worker. The worker owns its WebSocket, stream framer, MCS/Share state, static/dynamic channels, pointer cache and bitmap decoder. The main thread owns DOM and GPU/Canvas resources. Binary render payloads cross the worker boundary using transferable ArrayBuffers rather than JSON or base64.

The Node process owns the TCP socket, server certificate policy, X.224 security negotiation, TLS and CredSSP/NTLMv2. After those handshakes it forwards the TLS plaintext stream to the worker. The bridge does not decode the desktop or rasterize it, but it necessarily has visibility of the bytes and credentials. This boundary makes the bridge a credential-handling application, not an untrusted relay.

## 2. Session state machine

```text
new → mcs-connect → mcs-attach → mcs-join → licensing
    → activating → active ↔ reactivating
Any nonterminal state → failed / closed
```

`Session.receive()` feeds `Framer`, which distinguishes TPKT from fast-path output and preserves stream boundaries across arbitrary socket reads. Slow-path payloads pass through X.224 and MCS before Share Control/Data or static-channel dispatch. A protocol error terminates the session instead of guessing how to recover after stream desynchronization.

Desktop dimensions become authoritative only after Demand Active / reactivation. A display-control request does not merely resize a local canvas. The server must confirm the new desktop through the session protocol. Capability negotiation deliberately selects the implemented bitmap profile; drawing-order support, bulk compression, surface/advanced codec capabilities and device redirection are not advertised.

`Session` requires already verified security establishment. Its default protocol selection is not proof that a socket was authenticated; transport adapters must perform the handshake and pass the actual requested/selected protocol values. `RdpConnection` is the provided implementation of that precondition.

## 3. Stream parsing and memory budgets

Reader instances are scoped views with checked reads and explicit end conditions. Writer growth, BER/PER lengths, pixel arithmetic, rectangles and channels are bounded before allocation. `ByteQueue` limits both total bytes and fragment count to avoid tiny-chunk object amplification. Unknown feature combinations that cannot be decoded safely are rejected.

Representative current implementation limits:

| Resource | Limit / rule |
|---|---|
| Desktop | At most 8,192 pixels per axis and 16 megapixels overall, further bounded by the renderer/device. |
| Bitmap update | At most 4,096 rectangles, 64 MiB decoded data. |
| RDP stream framing | 4 MiB queued bytes; generic ByteQueue also caps 4,096 retained chunks. |
| Static channel message | 16 MiB; 1,600-byte outbound chunks. |
| Dynamic channel message | 8 MiB, at most 32 dynamic channels. |
| Clipboard Unicode payload | 4 MiB after line-ending expansion/encoding. |
| Worker render queue | 64 MiB and 8,192 commands; at most two batches in flight. |
| Bridge receive window | 512 KiB outstanding wire credits; paused TCP/TLS reads when exhausted. |
| Browser sessions / bridge sessions | Four GUI tabs / sixteen authenticated or negotiating bridge sessions. |

Some bounds are intentionally stricter than a maximum theoretical protocol encoding. These implementation limits are not claims of universal protocol compatibility. Limits are checked at the layer that owns the allocation, not assumed from an outer message's length.

## 4. Rendering

### Bitmap decode

The CPU decoder interprets interleaved RLE operations using foreground/background state and the previous scanline. Its result remains packed in the original pixel depth. Raw bitmap data likewise remains packed. Pixel conversion handles BGR555, BGR565, BGR24, BGRX32, palette8, row padding and bottom-up ordering.

The Canvas and WebGL2 paths use `Pixels.toRgba()` as their CPU conversion implementation. The pixel test constructs fixtures and compares renderer readback to an expected desktop buffer, then checks classic cursor output separately. That test is useful for the compositor but is not independent validation of every pixel decoder rule.

### WebGPU

`BatchPlanner` preserves update ordering: disjoint destinations can share a parallel compute dispatch; an intersecting later rectangle starts another ordered batch. `shaders.js` supplies a compute kernel with 8×8 workgroups and per-job descriptors. It unpacks source words, resolves palette entries and writes the persistent `rgba8unorm` desktop storage texture. Buffer capacities grow geometrically and are reused across frames.

The presentation pass samples the persistent desktop and applies the pointer mask/color without writing the cursor into the desktop. Classic AND/XOR cursors require the underlying desktop pixel; they are not equivalent to a normal alpha sprite. Optional timestamp queries report GPU timing only on a device that actually exposes the feature.

This source has not been executed on a GPU in the delivered test environment. The shader interfaces, storage usage and readbacks still need validation on several real adapters/drivers and browser engines before qualification.

### Fallback and loss

Automatic mode tries WebGPU, WebGL2, then Canvas. Explicit selection reports failure rather than silently using a different backend. Initialization failures remove the rejected canvas. Device/context loss is surfaced to the session view; its recovery path switches to Canvas and requests a full remote refresh. Current coverage validates initial Canvas rendering, not every real-device loss race.

## 5. Flow control

GPU submission and worker acknowledgement are distinct from GPU completion. The UI acknowledges a transferred batch after applying/submitting it; this frees worker-side in-flight slots, not a guarantee that physical presentation finished. The worker delays bridge wire acknowledgements while corresponding render work remains queued. The bridge pauses its TLS reads at the receive-credit threshold. This applies backpressure instead of dropping an arbitrary rectangle or buffering an unlimited desktop history.

Mouse motion is coalesced at animation-frame cadence; key/button edges are retained and release-on-blur prevents intentionally held state after focus loss. Clipboard request generations prevent stale format replies from overwriting a newer local ownership state. A timed-out clipboard request does not immediately reuse an ambiguous response slot.

## 6. Reuse

Example of the protocol boundary after transport security has succeeded:

```js
import { Session } from './packages/protocol/Session.js';

export function createProtocolClient(transport, negotiated, onEvent) {
    const session = new Session({
        send: bytes => transport.send(bytes),
        emit: onEvent,
        options: {
            width: 1280,
            height: 800,
            bpp: 24,
            selectedProtocol: negotiated.selectedProtocol,
            requestedProtocols: negotiated.requestedProtocols,
            username: negotiated.username,
            domain: negotiated.domain,
            // NLA credentials were already delegated by the trusted bridge.
            password: '',
            clipboard: true,
            resize: true,
        },
    });
    transport.onBytes = bytes => session.receive(bytes);
    session.start();
    return session;
}
```

The snippet describes an adapter contract, not a browser raw-TCP API. `apps/client/session-worker.js` is the complete provided adapter. The event stream includes state, desktop, bitmaps, palette, pointer, clipboard, display and error events. Input is represented by typed-discriminator objects (`key`, `unicode`, `mouse`, `mousex`, `sync`) and encoded only when the active session permits it.

To add a protocol family, implement its parser/encoder independently, establish resource and lifecycle invariants, add literal-wire fixtures and an independent-server test, and only then advertise the associated capability. Rendering a local control is not a substitute for the corresponding virtual-channel implementation.

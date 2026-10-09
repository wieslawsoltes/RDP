# NSCodec and surface graphics

The opt-in surface graphics profile negotiates Set Surface Bits, Stream Surface
Bits, frame markers, NSCodec ID 1 and a two-frame presentation window. NSCodec
raw and RLE planes are decoded into one owned transferable buffer; WebGPU fuses
signed chroma expansion and color conversion with the desktop texture write.
Canvas and WebGL2 use the CPU color conversion. RLE remains CPU-side.

The default sharp profile uses color-loss level 1 without subsampling. Balanced
mode permits the intersection of the server offer and color-loss levels 1–3,
including subsampling. The parser validates padded odd-sized planes, alpha,
24-bit source correction, strict lengths and resource limits. This is the basic
surface command path, not RDPGFX, RemoteFX or an H.264 implementation.

Marked frames are held until END, then transferred and applied as indivisible
ordered items. Ordinary bitmap updates in the frame retain their wire order.
Acknowledgements use correlated local receipt tokens after renderer completion
and an animation-frame callback, not server-provided IDs or mere packet arrival.
That is renderer completion, not proof of physical screen scanout. Reactivation
invalidates pending receipts without reusing local tokens. Incomplete frames,
slow renderers, failed delivery and excess queues fail with bounded cleanup.

Limits: 16 MiB per fast-path surface update, 64 MiB decoded frame budget, 4096
rectangles per marked frame, 15-second incomplete-frame/presentation deadlines,
two in-flight worker batches and at most 64 unacknowledged protocol frame IDs.

## Verification

The 419-test local tree passes syntax checks and the existing regression suites.
An extended real WS/TCP/TLS/CredSSP test verifies desktop reactivation, restored
keyboard input, invalidated old render receipts and a newly acknowledged frame.
The Chromium test compares NSCodec pixels, checks that an unresolved renderer
fence withholds acknowledgements, transfers a frame larger than the gateway
receive window, reactivates, and rejects an unnegotiated codec.

The previous browser failure sent a keyboard barrier while Session correctly
suppressed input during reactivation. The test now observes a *new* worker active
transition before submitting the barrier. It does not skip the reactivation or
post-reactivation pixel checks. Timeout diagnostics include worker states and
errors and the visible connection overlay. Final GitHub source/browser runs and
Pages publication must be recorded on the PR; old reports are not new evidence.

Primary specifications: MS-RDPNSC sections 2.2 and 3.1.8; MS-RDPBCGR sections
2.2.7.2.9, 2.2.9.2 and 2.2.9.1.2.1. No source from another RDP implementation
was used. Tests use a co-developed RDP peer; independent Windows/RDS and physical
GPU/browser matrix qualification remain outstanding.

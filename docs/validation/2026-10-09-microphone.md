# Microphone redirection verification — 2026-10-09

PR #13 implements reliable MS-RDPEAI AUDIO_INPUT, explicitly authorized browser
capture, bounded AudioWorklet transfers, PCM16 packetization/resampling and
integration through the actual worker and local WebSocket/TLS/NLA gateway.

## Completed pre-merge checks

Authored source/workflow head: `b5038c0d1bfe4ee9cd9c17775bc45e578ef151ca`.
Source tree: `9360226ddc3b3d227f6985af795e63654245daeb`.
CI merge candidate: `421b6a15f6dec49ca7a1d27aff87cc0463cb4640`.

- Source CI: https://github.com/wieslawsoltes/RDP/actions/runs/37961810281
- Chromium CI: https://github.com/wieslawsoltes/RDP/actions/runs/37961810288

The full source suite passes 372 tests, zero failures/cancellations/skips/todos.
This is 41 additional microphone-related tests over merged main's 331 tests:
17 channel/PCM tests, 13 browser-owner/worklet tests, eight actual-worker tests,
and three session/gateway tests. General smoke fuzzing runs 100000 bounded
malformed inputs across nine existing parser families with zero unexpected
exceptions. AUDIN additionally has 10000 malformed-PDU cases in its unit suite.
Existing planar smoke-fuzz coverage remains in the full test run.

The verified-source CI archive was checked against its published SHA-256 and
its internal checksums. All 182 tracked source files matched the local tested
tree byte-for-byte. Temporary import patches are not part of this source tree.

## Browser execution

The actual Chromium getUserMedia implementation reads a generated 48 kHz stereo
WAV through the browser's synthetic-media test facility. The test grants device
permission explicitly to the controlled HTTP loopback origin; it never disables
origin, certificate or mixed-content policy. No ambient microphone is captured.

The test confirms no AudioContext/device request before the user's Start action,
nonzero stereo PCM arriving over the actual worklet/worker/DVC/WS/TLS/NLA path,
transferable buffer detachment, at most four unacknowledged 512-frame chunks,
server-directed change to 16 kHz mono, stop/restart without duplicate Open Reply,
DVC close/recreation, no automatic restart on session selection, hidden-session
shutdown and final release of every media track and AudioContext. Existing
browser gateway, pointer, rich-clipboard, sound, recovery and licensing checks
pass in the same run. There are no uncaught page errors.

Local Chromium navigation was administrator-blocked. No bypass was attempted;
browser execution evidence comes from the repository's GitHub-hosted CI.

## Publication and limits

The final documentation commit must also pass ordinary source and browser CI
before merge. The post-merge Pages workflow builds and verifies the exact merged
revision and every public asset; this feature produces 59 browser-only assets.

These tests qualify the specified synthetic configuration, not independent
Windows/RDS interoperability, physical microphones/speakers/GPUs, every browser,
public HTTPS-to-loopback connectivity or full RDP conformance. Only reliable
PCM16 mono/stereo at 8–96 kHz and packets up to 8192 frames are offered. The
48-tap resampler is CPU-side; it is not a WebGPU audio decoder. Stop clears local
owners and unsent sample history but cannot recall bytes already in flight.
Device preferences permit channel negotiation only, never persistent consent.

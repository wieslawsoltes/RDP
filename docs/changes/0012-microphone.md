# Explicit-consent microphone redirection

This work adds the reliable MS-RDPEAI AUDIO_INPUT dynamic virtual channel,
not a browser media relay or an automatic device permission grant. The client
negotiates version 1/2 and PCM16 little-endian, mono or stereo, 8–96 kHz.
Server-selected packets are bounded to 8192 frames. Version, format selection,
Incoming Data, Open Reply and format-change ordering are protocol operations.
The proposed capture format in Open is distinct from the negotiated wire format.

## User controls and privacy boundary

Enable `Offer microphone channel (opt-in)` before connecting. This preference
only permits channel negotiation. After a server application requests recording,
use `Start mic` in that session and approve the browser's device permission.
Remote Open or format-change messages do not call getUserMedia. Stop, session
switch, hidden page, channel close, track revocation, context suspension and
session failure release the local device. Restart requires another explicit
user action; persisted profile preferences are not persisted capture consent.
The AudioWorklet outputs silence to avoid local feedback.

The browser needs a secure context and AudioWorklet/getUserMedia support. The
same-origin gateway serves `microphone=(self)` while leaving other unsupported
powerful device features disabled. Public HTTPS hosting and loopback gateway
connectivity remain subject to normal browser network/security policy.

## Resource ownership

Four 512-frame stereo Float32 chunks bound outstanding AudioWorklet transfers.
Credits are correlated by capture and chunk ID. The UI and worker reject old
chunks; packetization observes transport backpressure and discards partial
samples on pause/format change. A per-stream 48-tap polyphase FIR resamples
nonmatching sample rates using rational phase accumulation and bounded history.
The matching-rate path avoids resampling. Completed PCM packets are borrowed
only during send callbacks; retainers must copy them.

## Acceptance before merge

Core and owner-lifecycle tests exist in this branch. Final source CI and actual
Chromium AudioWorklet/getUserMedia/worker/DVC/WebSocket/TLS/NLA tests must pass
before this feature is reported as qualified. Required browser cases: no device
access before explicit action, PCM arriving at the peer, server format changes,
stop/restart, channel recreation, capture cancellation and no automatic restart.
Actual-worker tests must cover stale data, credit return and disconnect cleanup.
Tests must not disable browser security or use physical ambient audio.

Synthetic test peers and test-generated media are not independent Windows,
physical microphone, codec completeness or all-browser qualification. Compressed
microphone formats, UDP audio, camera/USB and other device classes remain separate.

## Primary references

- MS-RDPEAI overview: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpeai/f7ddb98c-85c4-4a57-8fee-baa4e8d56cf2
- Formats: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpeai/c4e53155-f577-43c6-ac1d-fad49540d02d
- Open: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpeai/97db7244-249b-4a79-ad50-7e45e2f760a0
- Format-change confirmation: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpeai/74e22a5c-535c-481b-a99b-ca30cbd40fd2
- Data ordering: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpeai/9010a07c-0cfe-45d8-bcb6-062968991d55
- Browser permissions: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- Rendering thread: https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletNode

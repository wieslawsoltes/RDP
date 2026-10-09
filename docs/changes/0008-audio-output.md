# Opt-in PCM sound output

The `rdpsnd` static channel is joined only when `audio: true` is explicitly
selected. Profiles require a boolean; imported `.rdp` files do not enable it.
The browser also gates negotiation on the availability of AudioContext. The
matching Client Info flag allows server audio playback only in this mode.

`AudioOutputChannel` implements the MS-RDPEA client-side format/quality/training
exchange over the existing reliable static channel. The client selects an exact
subset of server WAVEFORMATEX records: PCM tag 1, one or two channels, 8/16/24/32
bits, sample rates 8–96 kHz and consistent block alignment/average byte rate.
Extra format data, compressed formats and UDP are not advertised. Format indices
in subsequent audio refer to the filtered CLIENT list, not the server list.

Both split WaveInfo/Wave and version-8 Wave2 are implemented. Split samples
restore the initial four bytes and start confirmation timing at complete wave
arrival. Confirmations preserve the block number and account for elapsed time
with 16-bit timestamp wrap. Internal playback identifiers are monotonic, so a
wrapped 8-bit block number cannot acknowledge a different queued sample.
Unknown, malformed and out-of-sequence audio messages are ignored as specified,
with rate-limited diagnostics; they are not reported as successful playback.

`Pcm.js` converts little-endian PCM to owned planar Float32 buffers. Worker
messages transfer these buffers rather than clone them. `BrowserAudio` creates
an AudioContext only on the user's Enable sound action, copies planes into Web
Audio buffers, clears transferred samples and schedules monotonically against
the audio clock. It acknowledges after the source ended, or after explicit
muting/dropping. Muted, suspended or overloaded playback drops data without
opening a device. A volume slider controls only the local gain. No microphone
or other device capture is requested.

There are independent 16-sample and 2 MiB decoded queue limits, a two-second
scheduling horizon and strict encoded message bounds. Renegotiation drops old
host playback before accepting new samples without acknowledging merely on
receipt. Closing the stream drains already scheduled samples; closing the
session stops and clears samples, cancels late enablement and closes the audio
context. Partial device/buffer allocation failures clean up owned data.

## Tests and boundaries

Tests include all four PCM depths, signedness, interleaving/subarray ownership,
negotiation subset/index semantics, version gating, training, split samples,
block and timestamp wrapping, deferred/duplicate confirmations, renegotiation,
queue limits, truncation and 10,000 deterministic malformed messages. Mock Web
Audio tests cover explicit activation, scheduling, suspension, mute, close and
partial allocation failures. Actual MCS and separate WebSocket/TCP/TLS/CredSSP
fixture tests exchange both wave forms and verify exact decoded channel values.

`tools/browser-audio-tests.py` exercises real Chromium Web Audio from the built
subpath GUI through the worker and local gateway to a co-developed audio peer.
It observes actual sample-buffer values, user activation, two ended/played
samples, four deliberately dropped samples, six wire confirmations and device
release on close. Its result must come from a completed browser CI run; local
browser navigation is blocked by administrator policy, with no overrides used.

This is PCM OUTPUT support, not general RDP audio parity. AUDIN/microphone,
compressed audio codecs, UDP audio, remote pitch/volume controls and endpoint
migration remain unsupported. AudioBufferSourceNode completion is a browser
playback-consumption signal, not a measurement of physical speaker latency.
Independent Windows compatibility, speaker hardware, all browser/OS policies,
physical GPU execution and full RDP conformance remain unqualified.

## Primary specifications

- MS-RDPEA PDU header: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpea/863d154b-dbe0-4781-979d-fa48daed721e
- Client format selection: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpea/a5ccb1d6-f2b0-40f4-9f84-aea4beab9512
- WaveInfo: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpea/c53cd81c-0d7f-4e68-8b95-1c1da68dbaac
- Wave: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpea/81841793-f5d3-4305-aa22-ddcbd81a96b5
- Wave2: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpea/25cebccb-d679-4302-8dd0-df7fb9a4f9b5
- Confirmation timing: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpea/a4e42263-dc78-4748-9752-173e5bfa3dfb
- Web Audio source lifecycle: https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode

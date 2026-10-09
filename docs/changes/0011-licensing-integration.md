# Authenticated licensing exchange and persistence-gated activation

PR #12 implements a bounded MS-RDPELE client in the trusted Node gateway. It
replaces the valid-client-alert-only restriction for the provided gateway.
It does not generate CALs, suppress server denials, impersonate a Microsoft
platform, or establish full RDP/Windows licensing-server conformance.

## Wire exchange and trust boundary

The engine supports v2/v3 license preambles, license requests with RSA key
exchange, proprietary RSA1 and X.509 certificate key extraction, independently
encrypted RC4 blobs, full 128-bit licensing MAC verification, platform challenge
responses, new CALs, cached-license information, server-directed upgrades/renewal,
valid-client alerts and bounded reset/resend transitions. Platform identity is
OTHER; the installation owns its stable random device identifier.

GatewayLicensing is constructed only after the existing independently verified
TLS/NLA transport succeeds. It observes the actual server MCS user and channel
IDs, enforces joins and Client Info ordering, consumes server licensing PDUs,
and transmits engine replies itself. Browser-originated license packets or
licensing controls cannot enter that exchange. Licensing certificates are
trusted as content from that authenticated server, not as a replacement global
PKI trust policy. The proprietary signature is structurally parsed, not used
as an alternative to TLS endpoint authentication.

Issued CALs are persisted BEFORE completion is released. Coalesced Demand Active
is held in an ordered, bounded queue while the save runs. A failed MAC, denial,
cache error, timeout or early activation closes the connection without sending
successful completion. Server reads are paused during asynchronous writes/saves;
close cancels the gate's awaiters without awaiting a non-cooperative adapter.
The store itself still owns and drains transactions it has already accepted.

The browser receives only {type, status, complete}, not licensing certificates,
CALs, keys or HWIDs. The Session activation guard rejects early Demand Active
and wrong-plane completion, including the direct transport path. The protocol
lab and older/direct transports retain valid-client-alert handling; they cannot
perform the new Node licensing exchange. Update both browser and local gateway.
After licensing and the framed tail drain, server graphics use direct forwarding;
the gateway does not decode/render the desktop.

## Private cache and ownership

The gateway CLI opens `.rdp-gateway/licenses` by default. `--license-dir DIR`
selects a different private directory, outside browser/public source/build
roots (including symlinked-parent aliases). `installation.key` holds the random
AES key and stable identity; `licenses.bin` is authenticated AES-256-GCM data.
Keep these together in a protected backup. No key or CAL belongs in Git, Pages,
browser storage, diagnostic exports or public logs. Deleting the identity/cache
is not a substitute for acquiring licenses or complying with server licensing.

An exclusive `owner.lock` prevents simultaneous process writers. Crash locks
are not silently broken: first verify no gateway still owns the directory.
Atomic file replacement and serialized transactions prevent partial cache
updates. POSIX ownership/700/600 permissions, final symlinks and hardlinks are
checked. Windows users must protect the directory using their account's ACL;
this implementation is not DPAPI or an OS keychain. Cache authentication or
validation failures leave the original file intact and fail closed.

Embedded `createBridge()` defaults to an owned in-memory store. An explicitly
supplied `licenseStore` is borrowed; its caller must close it. The CLI closes
its store after the bridge and on listener startup failure. CAL namespaces bind
target host/port/TLS name and NLA domain/username. Ordinary certificate renewal
does not unnecessarily rotate the installation identity.

Licensing's narrow user/machine metadata uses lossless Windows-1252, distinct
from UTF-16 NLA credentials. An administrator may set `licenseUsername` in a
target to supply a licensing metadata alias. It does not change authentication
credentials and is not returned in the public target inventory. Names that
cannot be represented are rejected instead of silently corrupted.

## Explicit profile bounds

- Verified TLS, no Standard RDP Security or unencrypted transport.
- A licensing certificate in the request; omitted-certificate fallback from
  legacy Server Security Data is not implemented by this TLS-only gateway.
- Current unsegmented MCS payloads and CALs up to 24 KiB, 32 persisted records,
  2 MiB encrypted-cache file. A full cache fails instead of silently evicting CALs.
- 1 MiB pre-activation framing/queue and 4096 queued frames, 60-second gateway
  handshake deadline, 32 engine messages, at most three resets and three resends.
- No broker/licensing redirection, OS keychain, fabricated license issuance,
  independent RDS licensing-server qualification or protocol-wide conformance.

## Executable checks

Core tests use independently computed hash/MAC answers, native RSA decryption,
malformed inputs and strict field/ownership tests. Store tests cover tamper,
wrong/missing keys, locked ownership, permissions, atomic failure and concurrency.
Gateway tests add one-byte fragmentation, coalesced activation, pending saves,
denials, bad MACs, browser injection and close/deadline behavior.

Real socket tests exercise WS/TCP/TLS-only and WS/TCP/TLS/CredSSP first-time
issuance, maximum-profile CAL persistence, disk reopen and cached presentation,
upgrades, server errors and namespace isolation. The Chromium test holds a CAL
save pending, verifies that the actual workspace remains in licensing, releases
it, reconnects using the cached CAL and proves a tampered license cannot activate.
The browser workflow records that test separately from Node/source results.

These peers are co-developed and use synthetic test-only license bytes. Passing
these checks is not evidence of interoperability with an independent Windows
licensing server, legal license entitlement, all browsers, or physical GPUs.

## Primary protocol references

- MS-RDPELE licensing flows: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpele/32851b14-da8a-4a72-9fd4-41209bddd6e8
- Cached-license processing: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpele/89ed5e64-d4c5-4023-8df3-dd02f01e7102
- Platform challenge: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpele/41e129ad-0f35-43ad-a399-1b10e7d007a9
- Published server challenge: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpele/3e78e067-83a8-42b5-b5b3-054679ade7c7
- RDP security header: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/e13405c5-668b-4716-94b2-1c2654ca1ad4
- Valid-client/activation ordering: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/4e0177cd-b6a9-402b-910e-362a486799ae

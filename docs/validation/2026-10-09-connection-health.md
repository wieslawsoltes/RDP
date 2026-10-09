# Connection health and explicit recovery checkpoint

The local source tree for PR #11 matches materialized remote tree
`2ba3f67982415185ba8f43a2c42698fa35bdd514` byte-for-byte. Syntax checks,
263 Node tests (zero failures/skips), general 100000-input protocol smoke
fuzzing (zero unexpected exceptions), and the browser-only Pages build pass.

Twenty-two added Node regressions cover the pure watchdog and the actual
session worker in an isolated harness. They exercise independent phase
limits, unmatched and late pongs, bounded probes, clock rollback, repeated
reactivation, credential clearing, late socket opens, closed workers, and
cleanup when send or close throws. This is not independent interoperability.

Local Chromium navigation is blocked by administrator policy. No security
bypass is attempted. `tools/browser-recovery-tests.py` is registered in the
normal GitHub Chromium workflow in this authored commit. It must pass there
before this PR is merged. It deliberately drops application pongs for one
session, then checks failure UI, explicit endpoint selection, fresh token
and password entry, and a second TLS/NLA connection through the real gateway.

The browser scenario uses HTTP loopback, a co-developed RDP peer and Canvas.
It does not establish Windows-server compatibility, physical GPU/audio
hardware behavior, public-HTTPS-to-loopback compatibility across browsers,
or protocol-level automatic session resumption. Post-merge Pages verification
must hash all public assets against the exact merged source manifest.

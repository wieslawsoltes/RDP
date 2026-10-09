# Rich clipboard qualification checkpoint — 2026-10-09

The browser clipboard test is now part of the ordinary read-only browser CI
workflow. It exercises the built `/RDP/` application, explicit browser controls,
worker-owned transfers, the separate local WebSocket gateway, verified TLS and
CredSSP, and a co-developed CLIPRDR peer. It checks text/HTML/image transfers in
both directions, exact pixels, no automatic OS clipboard writes, no execution
of remote HTML, and cancellation of a pending clipboard read after tab close.

The pre-final integration run passed all three Chromium checks (gateway,
maximum-size pointers and rich clipboard):
https://github.com/wieslawsoltes/RDP/actions/runs/37898516839
Source commit: `435e585064b4482fa53c99cac9d7779eaca65f79`.

The subsequent privacy fix clears superseded unadvertised binary snapshots,
preserves the previously advertised data until its format-list acknowledgement,
and clears it when the next snapshot is advertised. Invalid candidate snapshots
are cleared without replacing a valid clipboard. Eight new browser-adapter tests
cover denied permission without fallback reads, text-only fallback, supported
MIME selection, empty/oversized data, synchronous write initiation, inert HTML,
unsupported rich writes and UTF-8 byte limits. A channel regression verifies the
snapshot lifecycle through format requests and acknowledgements.

The complete local tree after these additions passes syntax checking, 194 Node
tests (zero failures/skips), the 100,000-input general protocol smoke-fuzz run,
and the browser-only Pages build (52 staged assets). The ordinary CI run on
this documentation commit validates the materialized final source; earlier
checks on compressed transfer metadata are not substituted for that check.

Local Chromium navigation was denied by the environment's administrator policy;
no security override was used. The cited browser evidence comes from the
separate GitHub-hosted runner. These tests do not establish physical audio/GPU
execution, independent Windows interoperability, public-HTTPS-to-loopback
compatibility in every browser, or full RDP conformance. File clipboard streaming,
audio/device redirection and the other exclusions in PROTOCOL_MATRIX.md remain
outstanding. The Node gateway runs on the user's machine, not on GitHub Pages.

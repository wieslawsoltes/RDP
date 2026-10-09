# Verify the deployed app against the built source

The Pages workflow now has a separate read-only verification job after deployment.
It rebuilds the browser-only manifest from the exact checked-out commit, compares
it with the live `build.json`, and fetches and SHA-256 hashes every declared asset.
It does not treat a successful deployment API response or a working landing page
as proof that the worker, codecs, UI and shaders were all published correctly.

The command is also available independently (Node.js 22 or newer):

```sh
GITHUB_SHA="$(git rev-parse HEAD)" npm run build:pages
node tools/verify-pages.js https://wieslawsoltes.github.io/RDP/ "$(git rev-parse HEAD)"
```

This intentionally fails when the checked-out revision is not the live revision.
The third optional argument selects a different trusted local build manifest.
The probe sends no credentials, follows no redirects and does not contact the
local gateway. HTTPS is required except for HTTP loopback in local tests.

The verifier checks revision, exact file/hash inventory, MIME types needed for
browser scripts/styles/HTML, all asset hashes and safe browser-only paths. It
uses a four-request pool, per-request timeouts, bounded retries for CDN propagation,
a 128 KiB manifest budget, 256 files, 16 MiB per asset and 64 MiB total. Response
bodies are consumed as bounded streams. Errors cancel concurrent requests; all
workers settle before the next attempt. Caller cancellation is not retried.

Eleven regression tests include stale deployment retries, a tampered remote
manifest, missing or changed worker code, unsafe paths, redirects, incorrect MIME,
stream length limits, cancellation, pool limits and real loopback HTTP requests
including a server that stalls in the middle of a response.

This establishes exact static publication only. It does not establish independent
Windows RDP interoperability, public-HTTPS-to-local-gateway browser permissions,
GPU execution or conformance of the protocol implementation.

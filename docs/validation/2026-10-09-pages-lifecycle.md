# Pages lifecycle regression checkpoint — 2026-10-09

The materialized fix in PR #10 retains `.nojekyll` in the upload but removes
it from the public asset manifest. This addresses the observed 404 in
https://github.com/wieslawsoltes/RDP/actions/runs/37902029375
without ignoring any missing application file.

Sixteen verifier regressions and the Pages build test pass locally. The new
coverage includes fetch/read implementations that ignore abort, cancellation
promises that never settle, late responses and concurrent sibling failures.
A referenced deadline keeps Node alive until each outstanding request settles;
cancellation itself is best-effort and cannot delay completion indefinitely.

This authored commit runs ordinary CI on the materialized source. A subsequent
successful deploy-and-verify workflow must identify the exact main commit and
hash all its public assets before the deployment is reported as verified.
Browser integration, physical hardware and Windows-server interoperability
are separate qualification scopes; the static asset verifier proves none
of those on its own.

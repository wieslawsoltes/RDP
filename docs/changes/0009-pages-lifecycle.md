# Public Pages assets and bounded request cleanup

The first live verification run after PR #8 successfully built and deployed
commit 6ce61643a3b66c9afd1d20131b601b30ac1f0c4f, then failed to fetch `.nojekyll`:
https://github.com/wieslawsoltes/RDP/actions/runs/37902029375

`.nojekyll` is a deployment-control marker, not a browser asset. It remains in
the deployment artifact but is excluded from the public asset manifest. The
verifier continues requiring every entry point and comparing the manifest with
the checked-out source before hashing every public asset. It does not ignore
404 responses for application files or accept a remote-only hash inventory.

The failed run also exposed unsettled top-level await during request cleanup.
Request deadlines are now referenced timers. Fetch and stream reads explicitly
race cancellation, including custom transports that do not implement abort.
Reader cancellation is best-effort and cannot block request completion; late
transport responses are cancelled. A failing worker cancels its siblings and
waits for all of their bounded operations before the retry.

Five new tests cover non-cooperative fetch, stalled stream cancellation,
failed-status cancellation, sibling cancellation and late fetch completion.
The existing Pages build test verifies that the marker remains in the artifact
without becoming a required public URL. Sixteen verifier tests and the Pages
build test pass locally; ordinary CI and post-merge live verification provide
full-tree and deployment evidence separately.

# GitHub Pages deployment

`npm run build:pages` stages the complete browser client in `dist/pages`.
The build explicitly includes browser packages and excludes the Node gateway,
security/transport modules, test fixtures, credentials, target configuration,
historical test reports and private files. Every module import must resolve
inside the staged site. Relative URLs work at `/RDP/` and at a custom domain.
The root opens the workspace directly; no inline-script redirect is required.

`.github/workflows/pages.yml` validates syntax, all Node tests and protocol
smoke fuzzing before building and publishing through GitHub Pages Actions.
Only the deploy job receives `pages:write` and `id-token:write`. Third-party
actions are pinned to commit hashes. `build.json` records the deployed source
commit. Actual deployment success must be checked in Actions; committing the
workflow alone is not evidence that the site is live.

The local protocol lab works directly on Pages. Real RDP connections require
the separate local gateway documented in GATEWAY.md and in the in-app setup
page. The default endpoint is loopback, not the GitHub Pages web server. The
app does not start a localhost service or grant browser network permissions.

`browser.yml` uses an isolated test dependency environment and a Chromium
browser to exercise the `/RDP/` static build, explicit separate gateway setup,
real WebSocket/TLS/NLA fixture activation, token clearing on endpoint change,
lab resizing, mobile viewport and setup guide. This test is HTTP loopback
cross-origin, not a qualification of public-HTTPS-to-loopback permissions or
of independent Windows RDP servers. It uses the Canvas renderer; hardware GPU
execution remains a separate validation task. Local browser execution was
blocked by this development environment's administrator policy, which was
not bypassed. CI supplies the browser result.

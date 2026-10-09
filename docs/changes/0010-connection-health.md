# Gateway connection health and explicit reconnection

The previous worker stopped sending application pings after four unanswered
requests without timing out the connection. A stalled WebSocket or incomplete
RDP activation could leave the GUI waiting indefinitely.

A reusable ConnectionWatchdog now owns one pending, monotonically numbered
probe per connection. Only a matching pong can satisfy that probe. Duplicate,
stale and malformed identifiers cannot reset its deadline. The worker ticks
using performance.now(), never wall-clock timestamps. The independent limits
are 15 seconds to open the WebSocket, 35 seconds for gateway security completion,
60 seconds for initial RDP activation or server-initiated reactivation, and
20 seconds for an unanswered application-level gateway probe. A warning appears
after 10 seconds. A responsive active session can remain idle indefinitely;
ordinary traffic and stage messages do not extend the setup deadlines.

These limits are observed when the browser executes the worker. A suspended
browser cannot execute deadlines while asleep; overdue work fails when the
worker resumes. Gateway RTT/health describe the browser-to-gateway path, not
remote application latency or RDP-server liveness. Transport failures are
reported explicitly, not disguised as successful reconnects.

Failure/close clears the pending probe, timer, queued work and startup secret
references, removes WebSocket handlers and closes every owner even when socket
send/close throws. A delayed open cannot send credentials after cancellation.
The UI disables remote resize/input, clears remote clipboard state and closes
sound playback. It offers an explicit Reconnect action for terminal remote
sessions. This returns only sanitized connection metadata to the form, retains
the user's CURRENT explicit gateway selection, clears token/password/discovery,
and requires fresh allowlist discovery and authentication. It does not silently
restore an older gateway URL or persist passwords for retry. This is NOT the
RDP auto-reconnect-cookie protocol, seamless Windows session resumption or an
automatic retry loop.

## Tests

- Fourteen deterministic watchdog tests cover deadlines, matched/stale pongs,
  clock rollback, resource bounds, send failures, idle sessions and reactivation.
- Eight tests execute the actual browser worker in a controlled Node worker
  harness, covering secret-reference clearing, late events, cleanup after
  exceptions, security/activation timeouts and explicit cancellation.
- tools/browser-recovery-tests.py runs the built /RDP/ UI in Chromium against a
  separate local WebSocket gateway and TLS/NTLMv2 test peer. A test-only wrapper
  drops application pongs on the first connection; the test observes the real
  warning and timeout, changes the selected gateway, checks safe reconnection
  and completes a fresh second authenticated session. It uses no browser
  mixed-content/certificate/Origin policy overrides and no production fault flag.

The server is co-developed with the client. Independent Windows interoperability,
physical GPUs/speakers and all-browser HTTPS-to-loopback behavior remain separate
qualification tasks. The in-app coverage table also now accurately distinguishes
implemented PCM/HTML/image support from missing microphone/file redirection.

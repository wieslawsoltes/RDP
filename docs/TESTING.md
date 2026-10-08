# Test evidence and reproducibility

## Commands

Run from the repository root with Node 22 or newer. Network tests also require `openssl` in PATH.

```sh
npm run check
npm test
npm run test:fuzz
npm run bench
```

`check` performs JavaScript syntax checks, not type checking. Tests use `node:test` and built-in assertions. Temporary network-fixture certificates are created outside the source tree and removed after testing. No real RDP credentials or public endpoints are used.

## Current results

Read `test-results/node-tests.tap`, `fuzz.json`, `benchmarks.json`, `gui.json` and `renderers.json`. These reports were collected in the implementation environment; they are not a general compatibility guarantee.

| Test group | What it establishes | What it does not establish |
|---|---|---|
| Binary / protocol | Selected encoders/parsers, truncation checks, framing fragmentation, encoding values and capability checks. | Every optional RDP behavior or independent server agreement. |
| Codecs | Hand-authored RLE operation vectors, first/previous-row semantics, bounds, packed RGB conversion and cursor cases. | Exhaustive images, all codecs or GPU correctness. |
| Channels | Static/DVC fragmentation, clipboard ownership/stale responses, display requests. | All clipboard formats, devices or display topologies. |
| Security | RFC MD4/RC4 known answers, NTLMv2 calculations, directional seals/tamper handling, CredSSP DER. | Formal cryptographic verification, Windows account-name edge cases or audit. |
| Network fixtures | Actual TCP, X.224 negotiation, TLS, certificate/pin rejection, CredSSP/NTLMv2, bad binding rejection and session activation. | Windows, xrdp, FreeRDP or other independently implemented server interoperability. |
| Bridge / WebSocket | HTTP security policy, target authentication, origin checks, masking, fragmented/control frames, bounds and backpressure cases. | Hardened Internet-scale public hosting or all DoS cases. |
| GUI | Chromium desktop/mobile viewport smoke interactions and no uncaught page errors. | Physical mobile devices, every browser, accessibility certification. |
| Canvas | 40,960-pixel fixture comparison and classic cursor comparison, zero differences. | Physical GPU execution or every renderer mode. |

The completed Node run has **81 tests, 81 passed, 0 failed, 0 skipped**. This inventory intentionally does not relabel local protocol fixtures as a “full conformance suite.” Both client and fixture may encode the same wrong assumption. The matrix must add independent Windows observations before promoting compatibility status.

## Fuzzing

`tools/fuzz.js` uses deterministic seed `0x52445031` for 100,000 small bounded random inputs distributed across seven parser families. Set `FUZZ_ROUNDS` for another count up to the script's cap. It reports handled rejection and accepted input counts plus exceptions that violate its classifier. Some accepted framing inputs are only incomplete fragments; they do not necessarily represent valid packets. Zero unexpected exceptions does not prove memory safety, security or semantic correctness.

Add stateful corpus-driven and coverage-guided campaigns, allocation/time budgets, split-at-every-offset mutation and cross-implementation differential tests for stronger evidence. The existing tests include some fragmentation and malformed input cases but not every possible state transition.

## Browser tests

Start the app in another terminal, install Python Playwright, then run:

```sh
python -m pip install playwright
python -m playwright install chromium
python tools/browser-gui-tests.py
python tools/browser-render-tests.py
```

`CHROMIUM=/path/to/chromium` selects a local executable; otherwise Playwright's installed Chromium is used. `LRDP_TEST_ORIGIN` defaults to `http://127.0.0.1:8787`. `LRDP_BROWSER_ARGS` can supply additional launch arguments as a JSON array. `--headed` selects a visible browser for a real display/GPU test. The scripts do not alter browser, operating-system or organizational policies.

Renderer validation requests Canvas, WebGL2 and WebGPU separately. It compares the same deterministic packed-bitmap fixtures and reads back each backend. By default, every backend must succeed. `--allow-unavailable` marks an explicitly unavailable adapter/context as unavailable, not passed, and does not suppress shader errors, page errors, pixel differences or context loss.

The supplied environment exposed `navigator.gpu` but returned no adapter, and could not create a WebGL2 context. Thus GPU tests remain **unverified**. A software/virtual GPU run alone would not establish physical hardware performance either. The included Canvas screenshot was rendered by the implementation, not by a design mockup generator.

## Benchmark interpretation

`tools/benchmark.js` warms each operation, records five per-operation samples and reports their median. The workloads are CPU pixel conversion at 1280×800, a solid-color 64×64 interleaved-RLE block, and fragmented TPKT framing. Reported input MiB/s for a highly compressed RLE stream is compressed-input throughput, not decoded-output throughput. The script does not claim a desktop frame rate or network response time.

GUI `submitMs` covers CPU renderer update/submission work. It does not include all worker decoding, network delay, compositor display latency or physical scanout. Presented-frame counts are rendering calls, not remote frame identifiers. Bridge RTT is measured only to the bridge, not to the RDP host. Optional GPU timestamps are present only when a real adapter supports and executes them.

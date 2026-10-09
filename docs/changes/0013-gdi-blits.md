# Stateful GDI blits, bitmap caches and offscreen surfaces

## Implemented profile

This local continuation adds independently authored code in
`packages/render/gdi/{Raster,BitmapCache,Orders}.js`, integrates it into the actual
Session/worker pipeline, and adds an explicit **GDI blits and caches** GUI/profile
option. It is off by default. Only matching 24/32-bit server desktops negotiate
it. The existing 32-to-server-depth fallback still applies before this decision.

Six primary orders are implemented: DstBlt, PatBlt, ScrBlt, OpaqueRect, MemBlt and
Mem3Blt. The common header has connection-local per-type fields, signed coordinate
deltas, omitted trailing field-flag bytes, shared inclusive bounds and zero-bounds
reuse. The initial order type is PatBlt. All 256 ternary ROP truth tables are
implemented, subject to each order's valid source/pattern operands. Same-surface
copies preserve original source pixels in every overlap direction. Inline solid,
null and monochrome 8x8 pattern brushes are supported; no hatch or cached brushes
are negotiated. Glyph support is explicitly zero.

Revision 1/2 bitmap caches support raw padded rows, existing interleaved RLE and
32-bit planar codecs. Revision 2 is selected only when the server supplies the
supported Host Support capability. Its compact 15/30-bit fields, equal-height
flag and waiting-list slot are implemented. Persistence is not advertised, so no
persistent bitmap keys are sent. Indexed cached bitmaps keep their indices;
MemBlt selects one of six independently cached 256-color tables at draw time.

Create/Switch Offscreen and delete lists are handled within fixed bounds. ScrBlt
reads the primary surface; MemBlt can read cached or offscreen surfaces. The
source-Y inversion is calculated before destination clipping. Offscreen drawing
does not reach the display until copied to primary.

## Ownership and performance

The worker observes each ordinary bitmap before transferring its buffer. It keeps
canonical top-down 0x00RRGGBB storage with no host-endianness assumption. GDI damage
is serialized to owned BGRA32 descriptors for existing Canvas/WebGL2/WebGPU paths.
The CPU shadow eliminates synchronous GPU readback for screen/ROP source pixels;
**GDI rasterization is not GPU accelerated in this implementation**.

Common solid fills and source copies use native typed-array operations. Other
ROPs use bitwise truth-table evaluation across 24 color bits. Dirty 64x64 tile
metadata also retains exact sub-tile extents; a single changed pixel exports four
bytes rather than a full tile. Adjacent damage is coalesced; bounding rectangles
can include unchanged pixels, but do not overlap each other within one update.

Surfaces, cache replacements and queued untransferred render data are cleared on
failure/close. A malformed order poisons the stateful engine and terminates the
session. A PDU that fails midway emits no partial GDI damage. Previously valid
render batches and pixels already transferred remain owned by the UI.

## Resource limits

- Primary: 8192 pixels per axis and 16777216 pixels overall (64 MiB shadow max).
- Bitmap caches: 120/120/337 entries, advertised cell capacities equivalent to
  256/1024/4096 pixels at the negotiated depth. Actual allocations are lazy. The
  conservative expanded-storage guard is less than 24 MiB in total.
- Six independent 256-entry color tables. Conversion of indexed entries consumes
  per-update work even when only one output pixel is needed.
- Offscreen: 100 slots, at most 16 MiB of canonical storage. Wire size is 12 MiB
  for 24-bit or 16 MiB for 32-bit so negotiated depth cannot overpromise storage.
- Each update: 4096 orders and 67108864 pixel-work units including rasterization,
  cache decode, palette expansion and new offscreen allocation.
- Existing decoded queue: 64 MiB / 8192 commands / two in-flight frames. A single
  update may add at most one desktop's worth of exported dirty pixels.

These limits deliberately exclude arbitrary maximum protocol configurations.
Geometry/text/multi orders, glyphs/fragments, cached brushes, Revision 3/codecs,
indexed desktop order colors, RDPGFX and persistent caches remain unsupported.

## Tests and reproducibility

`npm test` includes 40 new tests in this continuation. They exercise every ROP3,
overlap traversal, wire field histories, malformed bounds/masks, both cache
revisions and bitmap compression-header forms, palette replacement, offscreen
ownership, tight damage, compressed/fragmented fast and slow updates, activated
sessions, real WebSocket/TCP/TLS/CredSSP and the actual browser worker module.
Expected images are built without the production rasterizer.

The deterministic GDI mutation smoke test uses seed `0x47444933` and 100000
cases with bounded desktops/work. It exercises random, valid and mutated PDUs
after initializing field/cache history. It is not coverage-guided or an
independent wire oracle. Reproduce with `node --test tests/gdi-fuzz.test.js`.

`npm run bench:gdi` records warmup, five samples, median, Node/platform/CPU and
sparse upload size. These are CPU microbenchmarks, not desktop FPS, end-to-end
latency, GPU performance or third-party server evidence.

`tools/browser-gdi-tests.py` uses the real GUI, session worker, Canvas and a
co-developed TLS/NLA fixture, and compares 640 pixels to a separate Python oracle.
A CI step is included. Chromium navigation in this local environment fails with
`net::ERR_BLOCKED_BY_ADMINISTRATOR`; no bypass or false passing result is used.
This test must succeed after publication before merging its PR.

## Recovery and surface integration

The original local-only checkpoint `c80f307` was recovered from its source and
four-commit patch archives. This continuation integrates it with the NSCodec
surface-graphics source merged in PR #14; it does not overwrite those changes.

An observer mirrors every decoded raw/NSCodec surface bitmap at its wire position,
before transfer, including before subsequent GDI commands within an open marked
frame. NSCodec writes canonical XRGB directly without an intermediate RGBA buffer.
GDI-generated rectangles are appended to that marked frame without a duplicate
shadow conversion and reach the renderer only after END. A malformed mixed frame
clears the shadow and held pixels and sends no acknowledgement. Queued surface
frames are also wiped during worker failure/close. WebGPU now resets the primary
texture even for equal-size desktop reactivation, matching Canvas, WebGL and the
GDI shadow; the prior early return could otherwise retain stale source pixels.

The combined local suite has 466 passing tests, including seven new cross-path
regressions. Chromium tests cover the GDI scene and mixed NSCodec/GDI/bitmap frames
through the real gateway. Final source/browser run IDs and exact post-merge Pages
publication are recorded on the PR. The old local-only evidence document is kept
as historical provenance, not current CI or deployment evidence.

## Primary specifications used

No FreeRDP, xrdp or Guacamole implementation source was used for these modules.
This is independent development against public specifications, not a formally
certified organizational clean-room process or full conformance certification.

- MS-RDPEGDI: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/745f2eee-d110-464c-8aca-06fc1814f6ad
- DstBlt: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/87ea30df-59d6-438e-a735-83f0225fbf91
- ScrBlt: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/a4e322b0-cd64-4dfc-8e1a-f24dc0edc99d
- Mem3Blt and source-coordinate rule: https://learn.microsoft.com/th-th/openspecs/windows_protocols/ms-rdpegdi/3aa21a4a-031c-4a3f-8fc5-159068f30237
- Compact 15-bit: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/7baeb5f2-8384-4d22-b647-5c66f05be4f7
- Compact 30-bit: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/f6f16e2b-8767-42ee-8eff-547780cca952
- Offscreen create: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/427758ff-4bac-4833-b388-d634cc512d0c
- Offscreen switch: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/ada4d8a9-421e-48c0-a0ed-7384fa3cf061
- Offscreen capability: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/412fa921-2faa-4f1b-ab5f-242cdabc04f9
- Monochrome brush interpretation: https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-createpatternbrush

Tests use shared/co-developed protocol peers. They can share incorrect protocol
assumptions; independent Windows captures, cached-color byte-order examples,
server-reactivation coverage, physical GPUs and browser runs remain qualification
work, not properties inferred from passing local tests.

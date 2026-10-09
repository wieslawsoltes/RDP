# GDI multi-rectangle drawing orders

This extension adds MS-RDPEGDI MultiDstBlt (15), MultiPatBlt (16), MultiScrBlt
(17) and MultiOpaqueRect (18) to the existing opt-in 24/32-bit GDI profile.
Negotiation advertises only these four additional order indices. Glyphs,
geometric orders, cached brushes, revision 3 and persistent bitmap caches remain
unadvertised. No new user permission, transport or native dependency is required.

## Decoder and retained state

`DeltaRectangles.js` implements the DELTA_RECTS_FIELD packed signed7/15 grammar,
with at most 45 rectangles and 383 encoded bytes. Zero flags run from high to low
nibbles. Left/top accumulate from an implicit zero rectangle; encoded widths
and heights replace their previous values, while omitted values repeat them.
The decoder rejects negative extents, coordinate overflow, truncated values,
excess counts and trailing encoded bytes. The unused low nibble for odd counts
is ignored. A new list is fully decoded before replacing retained region data.

Each multi-order has independent field/list history. Base-coordinate deltas do
not translate retained absolute clipping rectangles. An omitted list can reuse
its decoded entries (including a smaller active prefix); a count referring past
available history is rejected. Replacing the list or closing the connection
clears the old rectangles. Same-size reactivation retains field/cache history
while the primary surface is reset, as for the existing single orders.

## Rendering and bounds

The base destination, inclusive common bounds and delta-rectangle region are
intersected with the current surface. Overlapping/duplicate region rectangles
are normalized to a union of disjoint scan bands, so XOR affects each pixel once.
Brush origins remain absolute. MultiScrBlt source coordinates are derived from
the base/source displacement, not each clipping piece's top-left independently.

A same-surface operation captures all visible disjoint source pieces before
writing any destination. This avoids cross-piece overwrites regardless of region
enumeration or copy direction. Only visible pixels are copied; no GPU readback
or full-desktop snapshot is required. Separate offscreen targets read primary
pixels directly. All allocated copy buffers are wiped in finally blocks.

Existing limits still apply: 4096 orders/update, 64 Mi pixel-work units/update,
16-megapixel primary surface and 8192 pixels/axis. Source snapshots consume the
work budget as well as raster writes and need at most 64 MiB transient storage.
At most 89 scan bands and 45 intervals per band bound region-normalization work.
Malformed updates poison and clear the engine instead of returning partial damage.

This is CPU rasterization using the existing owned BGRA rectangle renderer ABI.
NSCodec, ordinary bitmaps and multi-orders share canonical XRGB wire ordering;
inside a marked surface frame they remain withheld until END and the correct
presentation receipt. Hardware rendering and Windows interoperability require
independent qualification; no full RDP conformance claim is made.

## Executable evidence

- Literal published MultiPatBlt example: exact decoded rectangles and every pixel
  of its 800x700 output are checked without a production-generated expectation.
- Every signed 15-bit delta and every legal multi-order ROP is tested, along with
  clipping, absolute brush origins, copy directions, retained history, empty
  regions, offscreen targeting, full 383-byte lists and malformed input cleanup.
- 1,000 deterministic sets of up to 45 rectangles are compared to a pixel-union
  oracle, including overlaps and out-of-bounds portions.
- The existing 100,000-stream GDI mutation test now includes all four multi-orders.
- Session tests exercise MPPC-compressed slow and fragmented fast paths and mixed
  NSCodec marked frames. Actual-worker tests verify ownership and presentation
  receipts. The TLS/NLA fixture and Chromium pixel oracle include all four orders.

See the PR's final-head CI for pass/fail results. Synthetic peers and browser
oracles do not establish independent Windows, physical GPU or every-browser
compatibility. Browser policy is not disabled for these tests.

## Primary specifications

- DELTA_RECTS_FIELD: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/b89f2058-b180-4da0-9bd1-aa694c87768c
- VARIABLE2_FIELD: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/aead742e-a858-47f1-a779-0311660f84af
- MultiDstBlt: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/aaae7840-3eb4-4038-9204-b95f87b44534
- MultiPatBlt: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/5f677576-a62e-48d9-a58d-711490882365
- MultiScrBlt: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/31b79b49-15b7-4709-bbc2-d58ce0362292
- MultiOpaqueRect: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/74e46cd9-d649-4bbe-9f8a-f4200f23302e
- Published MultiPatBlt example: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/86b9a664-7bc3-4e65-89e3-64b8a5f72e0c

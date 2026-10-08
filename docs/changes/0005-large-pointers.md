# Large pointers and 32-bit session negotiation

The client advertises the Large Pointer capability (type 27, flags 0x0003)
for 96x96 and 384x384 pointers. Its existing 16 MiB multifragment capacity
exceeds the required 608299-byte minimum for 384x384 at 32 bpp.

Fast-path update type 12 now decodes the large-pointer structure after stream
framing, bulk decompression and fragment reassembly. Lengths are 32-bit;
classic/new pointer messages retain their 16-bit lengths and 96-pixel limit.
Both formats share the same advertised 32 cache slots. Shape data are owned,
tightly packed RGBA; row padding, bottom-up masks, hotspots, alpha and classic
AND/XOR semantics are retained. Encoded input is capped at 608277 bytes,
output at 384x384x4 per cache entry. A cache filled with maximum-sized pointers
uses at most 18 MiB of pixel storage. 4/8-bit paletted pointers remain unsupported.
The existing Canvas, WebGL2 and WebGPU cursor interfaces accept these sizes;
physical GPU execution and independent Windows interoperability remain unverified.

The connection form and profiles now accept 32 bpp. GCC advertises 32-bit
support and requests it using WANT_32BPP_SESSION; highColorDepth is correctly
24 (not the invalid value 32) for fallback. If Demand Active offers only a
lower depth, the requested 32-bit session respects that fallback. The existing
32-bit planar decoder remains responsible for compressed bitmap data. This
change does not add RDPGFX, AVC or NSCodec.

Tests include maximum dimensions and 32-bit lengths, every representative
mask depth (1/15/16/24/32), independent alpha and AND masks, odd row padding,
cross-format cache replacement, malformed lengths/truncation, negotiated
capability bytes, fragmented 608276-byte updates through an active Session,
and 32-bit profile/GCC fields and server fallback.

Primary references:
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/41323437-c753-460e-8108-495a6fdd68a8
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/037f4d6c-5753-4627-ba5e-ce1b8e9bc0cd
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/00f1da4a-ee9c-421a-852f-c19f92343d73

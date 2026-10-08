# RDP6 planar bitmap decoder

This revision restores the previously described but unavailable local planar
scope as a new implementation. It is not a recovery of the missing checkpoint
ZIP, bundle, commit objects or their claimed test reports.

`packages/codecs/Planar.js` independently decodes the RDP6 bitmap stream into
owned BGRA bytes in wire scanline order. Raw/RLE RGB and ARGB, optional alpha,
extended run-only subsegments, vertical delta reconstruction, color-loss levels
1-7 and odd-sized chroma subsampling are implemented. The 32-bit Bitmap Update
path dispatches to it with either form of the optional compression header.

Input is bounded to 64 MiB, each dimension to 8192, total pixels to 16777216,
and output plus worst-case owned plane storage to 128 MiB (lowerable per call).
Zero controls, scanline overflow, invalid headers, trailing compressed bytes
and truncated planes produce controlled ProtocolError failures. Raw streams
accept zero or one arbitrary padding byte. No output aliases input storage.

The desktop remains an opaque surface. Alpha bytes are preserved by the decoder,
not blended by the existing desktop compositor. Decode is CPU-side; the returned
bitmap descriptor uses the existing WebGPU/WebGL2/Canvas conversion pipeline.

Only alpha omission is advertised for 32-bit bitmap capabilities. Lossy fidelity
and chroma subsampling remain unadvertised pending independent interoperability
qualification. The standalone decoder exposes sourceBpp=24 for the Microsoft
24-bit YCoCg R/B correction. Omitted alpha alone does not identify source depth.
NSCodec, RDPGFX, drawing-order caches and bulk RDP6 compression are separate
protocol features and are not implemented by this decoder.

## Validation

There are 21 focused decoder/integration tests and one additional deterministic
100000-input smoke-fuzz test. Coverage includes the published 6x3 plane example,
all 256 encoded deltas, every extended run-length control, raw/RLE equivalence,
signed nine-bit chroma recovery at all loss levels, odd-sized chroma planes,
alpha history, allocation budgets, every truncated prefix of representative
streams, both bitmap compression-header forms, cropping and row orientation.
The smoke fuzz uses seed 0x504c4e52 and accepts only ProtocolError rejections.
It is not coverage-guided fuzzing, a security audit, browser/GPU execution or
Windows-server interoperability testing. Repository CI supplies the full-tree
result rather than reusing the previous checkpoint's claimed 124-test count.

## Primary specifications

- Stream structure: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/9b422f69-8e05-4c6d-b6fb-fa02ef75a8f2
- RLE controls: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/f7e4c717-669e-4f31-8b34-e8f5ab2e107e
- Published plane example: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/46a9972c-0cdd-4673-add4-87f89b837742
- Color conversion: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/ef530a0a-03d8-482f-989b-57a1036797b2
- Chroma sampling: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpegdi/57507b94-41e6-41ff-a35e-c00211945ceb
- Bitmap capabilities: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/76670547-e35c-4b95-a242-5729a21b83f6

# Rich clipboard (experimental)

The CLIPRDR channel supports opt-in Unicode text, HTML Format (CF_HTML), PNG,
and uncompressed Windows CF_DIB / CF_DIBV5 images. Registered remote formats
are resolved by name, not hard-coded remote IDs. Capability version numbers
are informational; negotiated general flags determine long-name parsing.

Protocol data responses lack correlation IDs, so requests are serialized.
Generation changes discard stale responses without breaking stream alignment.
A timeout preserves the outstanding request; reconnect is required if the
peer never completes it. Local announcements also serialize snapshots until
ACK and honor negative format-list responses. Each encoded format is bounded
to 8 MiB; the sum of encoded representations in a local snapshot is at most
16 MiB, with at most the current and previously announced snapshots retained.

CF_HTML offsets count UTF-8 bytes. Returned HTML is untrusted, inert data and
must never be inserted into this app's DOM. Image dimensions are limited to
8192 per axis and 2 megapixels. PNG signatures, chunks, CRCs and dimensions
are checked before browser decoding. DIB supports RGB/bitfields (including
alpha), 1/4/8-bit palettes, top-down/bottom-up rows and padded strides. DIBV5
outbound images preserve alpha; the 24-bit DIB fallback flattens on white.
Embedded/linked color profiles, calibrated color conversion, DIB RLE/JPEG/PNG
compression, animated PNG, file clipboard streaming and huge files are not
supported or advertised. PNG structure validation is not full PNG inflate
validation: actual pixel decoding is delegated to the browser.

The session layer exposes setClipboardContent and requestClipboardFormat.
Rich formats are off by default; ordinary text clipboard remains supported.
Protocol tests cover both directions, generation changes, timeouts, malformed
payloads, resource limits and real MCS/static-channel fragmentation against a
co-developed peer. The tests do not establish independent Windows, browser OS
clipboard, or physical GPU interoperability; browser integration is a separate
qualification step.

Primary specifications:
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpeclip/7718c8c9-798d-4788-bb75-64afdc913869
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpeclip/680788b3-2bd8-4e2b-9806-589aba7cf814
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpeclip/1ac0265a-779b-481d-a95b-809f28d957dd
- https://learn.microsoft.com/en-us/windows/win32/dataxchg/html-clipboard-format
- https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapinfoheader
- https://learn.microsoft.com/en-us/windows/win32/api/wingdi/ns-wingdi-bitmapv5header

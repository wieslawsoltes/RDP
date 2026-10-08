# Protocol and platform coverage — 0.1.0

**This is an implementation inventory, not a conformance certificate.** “Implemented” means source and some local tests exist. The client has not been qualified against Windows, a third-party RDP server, real GPU hardware, or an independent security laboratory.

| Family | Implemented scope | Exclusions / evidence limits |
|---|---|---|
| TCP / X.224 / TPKT | Bounded stream framing, negotiation request/response/failure, TLS/NLA selection, selected-protocol checks. | No legacy Standard RDP Security or unencrypted RDP. |
| TLS | Node TLS 1.2 minimum; CA/name policy or administrator-configured certificate pin plus validity check. | No runtime certificate-ignore or automatic TOFU path. Windows server certificate variants not exhaustively tested. |
| NLA / CredSSP | Versions 5/6; NTLMv2 messages, MIC, channel binding, 128-bit directional session security, nonce-based public-key binding and password credentials. | No Kerberos, general SPNEGO negotiation, Remote Credential Guard, Restricted Admin, smart-card logon, Entra flows, or CredSSP 2–4. Non-ASCII Windows account-name case mapping unqualified. |
| GCC / MCS | Client/server connect data for implemented capabilities; domain erect, attach, user/channel joins and send data. | General conference/multipoint functionality not implemented. |
| Licensing | Valid-client licensing error alert accepted. | No license request/challenge/new license, CAL store, upgrade, renewal or reconnect licensing. This can block real servers. |
| Activation | Demand/Confirm Active, synchronization, control cooperation/request/grant, font list/map and reactivation. | Not every optional capability combination or server ordering has independent evidence. |
| Share Data | Selected display, input, control, refresh and status handling. | General unsupported PDU types are rejected; no blanket unknown-message success. |
| Fast-path output | Bounded update reassembly with single/first/next/last fragmentation and implemented bitmap/palette/pointer update types. | No bulk-compressed/encrypted fast-path profile, full surface-command path or all optional update types. |
| Raw bitmap | Decode 8/15/16/24/32 bits; padding, bottom-up rows, clipping/destination checks. | Connection negotiates 15/16/24-bit bitmap profile. Compressed 32-bit planar data unsupported. |
| Interleaved RLE | Regular/lite/mega operations, foreground/background XOR, color runs/images, dither, masks, white/black. | CPU decoder; no GPU RLE decompressor. Finite hand-authored vectors and smoke fuzzing, not exhaustive codec qualification. |
| Drawing orders / caches | Pointer cache and palette support; empty order updates accepted. | No general GDI orders, glyph cache/text orders, bitmap caches, brushes, surfaces or persistent bitmap cache. |
| Advanced graphics | None advertised. | No RemoteFX, NSCodec, RDP6 planar, RDPGFX, AVC420/444, H.264/HEVC/AV1, progressive codecs or graphics frame acknowledgement protocols. |
| Pointer | Cached classic mono/color AND/XOR and 32-bit alpha pointers, movement, hidden/default. | Maximum 96×96; paletted 4/8-bit pointer formats unsupported. |
| Static virtual channels | Fragmentation, channel ownership and strict length limits for registered channels. | Channel compression disabled; no arbitrary plugin-channel forwarding. |
| Clipboard | Unicode text format list, capabilities, data request/response, line endings, generation handling, explicit system clipboard actions. | No HTML/RTF, bitmap clipboard, file streaming, clipboard locking, format palette or automatic OS clipboard monitoring. |
| Dynamic virtual channels | Reliable v1/v2 subset, create/close/data fragmentation and channel allowlist. | No every-version DVC extension, lossy channels or transport priority implementation. |
| Display control | Server caps, one primary monitor layout and resize requests, server-driven reactivation. | No spanning, multi-monitor topology, rotation, mixed-DPI monitor graph or auxiliary display windows. |
| Keyboard | Scan codes, Unicode code units including surrogate pairs, selected extended keys, control chords, focus-loss release. | Browser/OS-reserved shortcuts remain platform constraints; complete keyboard-layout/IME equivalence unqualified. |
| Pointer input | Mouse move/buttons/wheel/horizontal wheel/extra buttons, pointer capture, touch/pen-to-mouse mapping. | No native multitouch, pen pressure/tilt, relative/raw mouse, gesture protocol or RDP input extension. |
| Audio output / input | Not implemented. | RDPSND, AUDIN and codec/device negotiation absent. |
| Filesystem / printing | Not implemented. | RDPDR drives, printers, ports, print spooling and device I/O absent. |
| USB / smart cards | Not implemented. | No generic USB redirection, PnP bridge, smart-card resources or logon. |
| Cameras / multimedia | Not implemented. | No camera capture, multimedia redirection or video optimization. |
| RemoteApp | Not implemented. | No RAIL, remote window mapping, shell integration or app launch protocol. |
| RD Gateway / broker | Not implemented. | No HTTP/RPC/UDP gateway, gateway MFA, broker redirects or connection authorization policies. |
| UDP / multitransport | Not implemented. | TCP only; no RDPUDP/FEC, transport fallback selection or network autodetection protocol. |
| Reconnect / recovery | Explicit disconnect, error reporting, GUI renderer fallback and refresh request. | No auto-reconnect cookie/resume, network reconnect state machine or session migration. |
| WebGPU | Compute pixel conversion, persistent desktop, cursor presentation and optional timing source exist. | No GPU adapter was available for execution. No GPU correctness/performance claim. |
| WebGL2 | CPU conversion + dirty texture uploads + GPU presentation source exists. | Test environment could not create a context. |
| Canvas | CPU conversion, desktop buffer and cursor composition. | Local pixel/cursor tests pass; high-resolution interactive performance not established. |
| Desktop browsers | Modern worker/module-based UI, feature-based renderer selection. | Chromium 144 Canvas-path smoke test only. Safari/Firefox/Edge and every OS/hardware combination unqualified. |
| Mobile | Responsive GUI, Unicode text panel, touch-to-mouse input code. | Chromium mobile viewport tested, not physical Android/iPhone or native RDP touch. |
| Accessibility | Semantic forms/buttons, names on session controls, focusable desktop and keyboard panel. | No remote accessibility-tree redirection, assistive-technology certification or full screen-reader audit. |

The source limits desktops to 16 megapixels and 8,192 pixels per axis, with additional adapter restrictions. “All devices and hardware” is therefore explicitly not a property of this release. Supporting a browser-local device API and implementing the corresponding RDP device protocol are separate requirements; neither is faked by enabling a checkbox.

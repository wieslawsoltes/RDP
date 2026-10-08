# Public specification sources and provenance

These are the public protocol/API documents used while writing the implementation. They describe target behavior; referencing a document does not imply every feature in it was implemented or verified. Consult `PROTOCOL_MATRIX.md` for scope. No existing RDP implementation is vendored or used as the protocol engine, renderer, fixture server or runtime dependency.

Accessed during development on 2026-10-08. The RDPBCGR landing page listed published revision 62.0 dated 2026-03-09. This project does not claim exhaustive coverage of that revision.

| Document / section | Implementation area |
|---|---|
| [MS-RDPBCGR — Basic Connectivity and Graphics Remoting](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/5073f4ed-1e93-45e1-b039-6e30c385867c) | Overall connection, capabilities, graphics, input. |
| [RDP connection sequence](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/023f1e69-cfe8-4ee6-9ee0-7e759fb4e4ee) | Session state sequencing. |
| [Negotiation consistency](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/db98be23-733a-4fd2-b086-002cd2ba02e5) | Requested and selected security protocols. |
| [Client core data](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/00f1da4a-ee9c-421a-852f-c19f92343d73) | Desktop dimensions, identity and core fields. |
| [GCC connection data](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/2610fcc7-3df4-4166-85bb-2c7ae21f6151) | Connect Initial framing. |
| [Annotated Confirm Active](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/54765b0a-39d4-4746-92c6-8914934023da) | Activation wire layout. |
| [Bitmap capabilities](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/76670547-e35c-4b95-a242-5729a21b83f6) | Bitmap negotiation. |
| [Bitmap update data](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/84a3d4d2-5523-4e49-9a48-33952c559485) | Bitmap rectangles and layout. |
| [Interleaved RLE descriptions](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/b3b60873-16a8-4cbc-8aaa-5f0a93083280) and [algorithm description](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/b6a3f5c2-0804-4c10-9d25-a321720fd23e) | Independent JavaScript interleaved decoder. |
| [Order capability set](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/9f409c29-480c-4751-9665-510b8ffff294) | Declaring unsupported drawing orders. |
| [MS-CSSP sequencing and public-key binding](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cssp/385a7489-d46b-464c-b224-f7340e308a5c) | TLS-protected CredSSP 5/6, nonce/hash binding and credential delegation ordering. |
| [MS-NLMP NTLMv2 calculations](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-nlmp/5e550938-91d4-459f-b67d-75d70009e3f3) and [response structure](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-nlmp/d43e2224-6fc3-449d-9f37-b90b55a29c80) | NTLMv2 response/key construction. |
| [MS-RDPECLIP clipboard header](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpeclip/9e97ce45-0597-43dd-b116-9f62a5b34d54), [format list](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpeclip/14e60d52-e0da-4e19-9455-e8643ff17673), [capabilities](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpeclip/7718c8c9-798d-4788-bb75-64afdc913869) | Unicode text clipboard messages. |
| [MS-RDPEDISP overview](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpedisp/bdc90b21-4b14-43bc-9c03-b7fecbfc6a1f), [layout PDU](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpedisp/22741217-12a0-4fb8-b5a0-df43905aaf06), [monitor data](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpedisp/ea2de591-9203-42cd-9908-be7a55237d1c) | Single-monitor display control. |
| [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455) | Independently written WebSocket server framing/handshake. |
| [RFC 1320](https://www.rfc-editor.org/rfc/rfc1320) | MD4 compatibility primitive and known-answer vectors. |
| [RFC 5929](https://www.rfc-editor.org/rfc/rfc5929) | TLS server endpoint channel binding. |
| [WGSL specification](https://www.w3.org/TR/WGSL/) | Compute and presentation shader source. |
| [WebGPU API](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) and [WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) | Browser graphics and transport interfaces. |

## Evidence provenance

The local protocol server, network fixtures, bitmap test vectors and GUI were written alongside the client. Some fixtures share binary utilities or cryptographic primitives with the client. They verify useful invariants but are not independent implementation witnesses. Screenshots in `test-results/` are captures of this implementation in Chromium; the lab deliberately labels itself a synthetic local fixture.

The project records local commits and public source references. It does not have a formal isolated-specification-team/implementation-team process or an externally reviewed clean-room provenance report. The MIT license applies to this project's source and does not assert rights over the specification documents or certify third-party patent status.

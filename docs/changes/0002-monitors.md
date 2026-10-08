# Multi-monitor topology

Initial GCC CS_MONITOR/CS_MONITOR_EX data is gated on the server's actual
X.224 extended-client-data flag. Dynamic layouts use the Display Control DVC;
server TS_MONITOR_LAYOUT messages are parsed and checked against the activated
desktop. Exactly one primary monitor at (0, 0) is required. Negative coordinates,
inclusive wire endpoints, physical dimensions, orientation and scale factors
are preserved. Monitor area uses all three server capacity factors and BigInt
arithmetic. Bounds include empty gaps, preventing sparse allocation amplification.

The workspace Monitor layout drawer has a two-monitor preset and an editable
JSON topology. Apply waits for server-driven reactivation; changing GUI metadata
alone does not resize the remote desktop. All displays occupy one spanning canvas.

Client limits: 16 monitors; 8192 pixels per bounding dimension; 16 megapixels;
dynamic monitor widths must be even. Physical OS monitor/window placement and
Windows-server/hardware interoperability have not been qualified. The local
loopback fixture checks actual GCC/MCS/DVC/activation packets but was developed
alongside the client, so it is not independent conformance evidence.

Primary public references:
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/a8029f8e-01e1-4f19-af67-bcad5bdef624
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/acb3c005-dc9c-4e1d-88d5-d5b7f4e09203
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpbcgr/dfaf8842-c20c-4626-bd3b-8b7d0463bc0f
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpedisp/ea2de591-9203-42cd-9908-be7a55237d1c
- https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-rdpedisp/8989a211-984e-4ecc-80f3-60694fc4b476

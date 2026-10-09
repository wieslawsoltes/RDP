# Licensing integration acceptance contract

The independent licensing engine and encrypted cache in PR #12 must be connected
at the trusted gateway boundary before this feature can be advertised. This
contract records the remaining integration work, not completed implementation.

Only licensing PDUs received from the certificate-verified RDP TLS connection
may enter the engine. The gateway must learn MCS user/global channel identity
from the actual connection sequence, never from a browser-supplied public key.
Browser-originated licensing packets must not bypass the gateway state machine.
The gateway must consume licensing PDUs, transmit the engine's responses, and
signal completion only after validated success and completed cache persistence.
The browser must reject Demand Active until licensing completes. Coalesced and
fragmented transport chunks must preserve ordering and bounded backpressure.

The CLI owns one encrypted cache and stable installation identity. Embedders
may explicitly supply a store; ownership and shutdown responsibilities must be
clear. CALs remain opaque server-issued data. Server rejection is not success;
unknown sequences, bad MACs, store failures and premature activation must fail
closed. No CAL synthesis, OS impersonation or legacy security downgrade is used.

Acceptance tests must exercise valid-client bypass, new-license issuance,
challenge integrity failure, cached-license acceptance, upgrades, denial,
fragmented/coalesced wire messages, disconnect during persistence, and actual
TCP/TLS/CredSSP + WebSocket + browser completion gating. An independent Windows
RDP server and physical GPU execution remain separate qualification tasks.

Primary specifications: MS-RDPELE sections 1.3.3 and 2.2.2; MS-RDPBCGR sections
2.2.1.12, 2.2.8.1.1.2.1 and 3.2.5.3.13.

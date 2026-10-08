# Publication reconciliation: 2026-10-08

PRs #1 (source recovery), #2 (MPPC and channel flow control), and #3
(multi-monitor topology) were merged into main in dependency order. Merge
commits preserve the source history. The final materialized source for #2
and #3 was validated again by ordinary CI before merging; green checks on
an earlier compressed-transfer commit were not treated as equivalent.

The prior conversation's RDP-implementation-checkpoint.zip and .git.bundle
exports failed. Those files and the claimed local Planar.js/test sources
were not available in this session. The available local bundle contained
only the original 0.1.0 baseline; the continuation ZIP contained documentation
and historical reports, not additional source. No unavailable source, history
or test result is represented as recovered or pushed.

The planar implementation is therefore restored in a new PR, documented in
changes/0003-planar.md, with new source and executable regression tests.
GitHub's merged source and current CI logs are the publication authority.
Historical screenshots and test reports are not validation of this revision.

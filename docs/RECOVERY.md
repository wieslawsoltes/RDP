# Source recovery

The original LRDP Web 0.1.0 Git bundle was recovered at commit `7f3060d`.
Eighty-three source/documentation files were imported, verified by SHA-256,
and checked by GitHub Actions. The baseline passes all 81 Node tests.
Generated screenshots and historical test outputs were excluded from Git.

The continuation archive supplied with the conversation contained documentation
and historical reports only. It did not contain the previously claimed licensing,
media, redirected-drive or additional graphics code. Those reports must not be
used as evidence that a feature exists. Subsequent implementation is recorded
in focused pull requests and executable tests.

The one-time recovery workflow has been removed. `ci.yml` is ordinary read-only
CI. `import-source.yml` supports bounded, SHA-256 verified text patches from
repository-authorized feature-branch pushes when direct Git transport is not
available; it validates the full tree before committing the source and removes
the temporary transfer files. It does not merge pull requests or deploy anything.

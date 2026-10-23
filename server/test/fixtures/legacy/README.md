# Frozen migration source fixtures

These snapshots contain application source only, not databases, credentials,
conversation exports, personal memories or Git history. Migration tests create
their own synthetic data in disposable temporary directories.

- `core-v0.1`: the three storage/resolver modules used before the core memory
  optimization. Tests retain the old scope defect and old-writer limitations.
- `pre-memory-first`: the ten core modules used before Memory First source
  versioning and reliable deduplication.

`manifest.json` records exact byte lengths and SHA-256 checksums. The test helper
verifies every module before copying a snapshot. Migration assertions compare
original row digests, lifecycle records and deduplication identifiers against
the current implementation; they do not require old commits or network access.

These modules deliberately retain legacy behavior. Do not deploy them or import
them from runtime code. Change current code and tests instead of silently
refreshing a fixture to make a migration pass.

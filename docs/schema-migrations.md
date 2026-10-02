# Core schema migrations

The Core SQLite schema is versioned with `PRAGMA user_version`.

- Steps live in `server/lib/store/schema.mjs` as `CORE_MIGRATIONS`, numbered contiguously from 1.
  The runner is `server/lib/store/migrations.mjs`.
- On open, every pending step runs in its own `BEGIN IMMEDIATE` transaction and then records its version.
  If a step fails, it rolls back and the stored version is unchanged.
- Steps marked `repeatable` only guarantee structure (`CREATE ... IF NOT EXISTS`, additive columns). They are
  re-checked on every open, so a database created before versioning (`user_version = 0`) or a partially
  restored copy repairs itself exactly as before.
- One-off data changes must **not** be `repeatable`. Append them as a new version; never renumber or edit a released step.
- A database whose version is newer than the running release is refused (`SCHEMA_VERSION_UNSUPPORTED`)
  instead of being opened by code that does not understand it. Prefer a forward fix or a rollback build
  that understands the current schema and preserves its authorization and privacy rules. Do not
  overwrite the live database with a pre-upgrade backup: this would discard later registrations,
  memory writes, revocations and private-visibility choices. Never lower `user_version` to bypass the guard.
  Restore a matching backup only into a separate isolated directory, with the matching Core and OAuth
  stores, encryption keys and identity mappings. A production cutover requires an explicit decision
  about all writes since the backup, an audited preservation/reconciliation plan, and a fresh backup
  of the current state. See [release review and recovery](release-review.md).
- Feature modules that own their own tables (revisions, derived memory, jobs, web visibility) still create them
  idempotently; move them into versioned steps when they next change.

Run `node --test server/test/schema-migrations.test.mjs` after adding a step.

## Privacy compatibility boundary (v7)

Version 7 records the explicit cloud-private denial table. It deliberately rejects
v6 and earlier readers: those readers ignore denials and can reveal a record under
an account-wide `read_all` policy. The denial backfill still runs transactionally
from immutable cloud receipts and preserves later reviewed exact-version grants.
The version guard complements that authorization fix; it does not replace it.

The paired-store release test creates two real synthetic accounts using the prior
release, upgrades their Core/OAuth stores, verifies unchanged account/memory/receipt
hashes and owner isolation, then restores a current snapshot into a different path.
It checks that old readers refuse the upgraded Core and that post-upgrade writes
remain in live storage. OAuth restoration invalidates old grants and console
sessions before any restored service is exposed. Encryption keys and identity
mappings must be retained with the same snapshot and never published.

```sh
node --test --test-timeout=30000 services/oauth/test/release-upgrade.test.mjs
```

The legacy source is pinned to PR #13's historical head in that test; a full Git
history and both locked OAuth/gateway dependency installations are required.

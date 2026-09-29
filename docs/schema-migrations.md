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
  instead of being opened by code that does not understand it. Roll back the release together with a matching backup.
- Feature modules that own their own tables (revisions, derived memory, jobs, web visibility) still create them
  idempotently; move them into versioned steps when they next change.

Run `node --test server/test/schema-migrations.test.mjs` after adding a step.

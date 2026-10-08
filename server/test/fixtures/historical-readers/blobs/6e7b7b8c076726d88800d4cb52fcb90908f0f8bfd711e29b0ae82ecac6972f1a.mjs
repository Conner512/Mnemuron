// Minimal, dependency-free migration runner for node:sqlite databases.
// PRAGMA user_version records the last applied step; each step commits atomically.
// Steps marked `repeatable` are idempotent schema guarantees (CREATE ... IF NOT EXISTS,
// additive columns). They are re-checked on every open so a damaged or partially
// restored database self-heals exactly as before versioning; one-off data changes
// must not be repeatable.
export class SchemaVersionError extends Error {
  constructor(message) { super(message); this.name = "SchemaVersionError"; this.code = "SCHEMA_VERSION_UNSUPPORTED"; }
}

export function validateMigrations(migrations) {
  if (!Array.isArray(migrations) || !migrations.length) throw new TypeError("At least one migration is required.");
  migrations.forEach((migration, index) => {
    if (!Number.isSafeInteger(migration?.version) || migration.version !== index + 1) throw new TypeError("Migration versions must be contiguous from 1.");
    if (typeof migration.name !== "string" || !migration.name || typeof migration.up !== "function") throw new TypeError(`Migration ${migration.version} is incomplete.`);
  });
  return migrations.at(-1).version;
}

export function schemaVersion(db) {
  return db.prepare("PRAGMA user_version").get().user_version;
}

export function applyMigrations(db, migrations) {
  const latest = validateMigrations(migrations);
  const from = schemaVersion(db);
  // Refuse to run an older release against a newer schema instead of guessing.
  if (from > latest) throw new SchemaVersionError(`Database schema version ${from} is newer than this release supports (${latest}).`);
  const applied = [];
  const ensured = migrations.slice(0, from).filter((migration) => migration.repeatable);
  if (ensured.length) {
    db.exec("BEGIN IMMEDIATE");
    try { for (const migration of ensured) migration.up(db); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  for (const migration of migrations.slice(from)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    applied.push(migration.name);
  }
  return { from, to: latest, applied };
}

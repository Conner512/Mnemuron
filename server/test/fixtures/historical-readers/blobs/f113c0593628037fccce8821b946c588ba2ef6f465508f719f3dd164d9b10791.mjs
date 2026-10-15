// Project lifecycle foundation: owner-scoped lifecycle metadata (schema v8) and the owner mutation epoch.
// Nothing here exposes deletion or merge; it only records state, refuses states this build cannot enforce,
// and keeps a conservative per-owner counter of material writes.
//
// Owner mutation epoch. AFTER INSERT/UPDATE/DELETE triggers on every material table add one to the epoch of
// the row's owner (old and new owner on an owner change; child rows through their parent). Each module
// installs the triggers for its own tables immediately after creating them, so no material write of that
// module can happen unprotected, including optional modules created later at runtime (vectors).
// The epoch only says "something material changed for this owner". It is not proof that a displayed impact
// (counts, pending previews, conflicts) is unchanged: lifecycle confirmations must recompute their impact in
// the confirming transaction, and authorization is always checked afresh, never inferred from the epoch.
import {ConflictError} from '../errors.mjs';

export const LIFECYCLE_TABLES = `
  CREATE TABLE IF NOT EXISTS project_lifecycle (
    user_id TEXT NOT NULL, project_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active','deleted','merged')),
    merged_into TEXT, lifecycle_revision INTEGER NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id),
    CHECK ((state = 'merged') = (merged_into IS NOT NULL)),
    CHECK (merged_into IS NULL OR merged_into <> project_id));
  CREATE INDEX IF NOT EXISTS project_lifecycle_merged ON project_lifecycle(user_id, merged_into);
  CREATE TABLE IF NOT EXISTS project_lifecycle_operations (
    user_id TEXT NOT NULL, operation_id TEXT NOT NULL, action TEXT NOT NULL, payload_sha256 TEXT NOT NULL,
    state TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, PRIMARY KEY (user_id, operation_id));
  CREATE TABLE IF NOT EXISTS project_lifecycle_events (
    event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, operation_id TEXT, project_id TEXT NOT NULL, action TEXT NOT NULL,
    before_json TEXT, after_json TEXT, created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS project_lifecycle_events_owner ON project_lifecycle_events(user_id, project_id, created_at);
  -- Lifecycle history is append-only. No supported Core cleanup path deletes owner history (raw event retention
  -- only edits captured events), so these rows are never updated or deleted.
  CREATE TRIGGER IF NOT EXISTS project_lifecycle_events_no_update BEFORE UPDATE ON project_lifecycle_events
    BEGIN SELECT RAISE(ABORT, 'project lifecycle history is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS project_lifecycle_events_no_delete BEFORE DELETE ON project_lifecycle_events
    BEGIN SELECT RAISE(ABORT, 'project lifecycle history is append-only'); END;
  -- INSERT OR REPLACE removes the conflicting row without firing DELETE triggers (recursive_triggers is off),
  -- so an insert that would replace an existing event is refused before conflict resolution.
  CREATE TRIGGER IF NOT EXISTS project_lifecycle_events_no_replace BEFORE INSERT ON project_lifecycle_events
    WHEN EXISTS (SELECT 1 FROM project_lifecycle_events WHERE event_id = NEW.event_id)
    BEGIN SELECT RAISE(ABORT, 'project lifecycle history is append-only'); END;
  CREATE TABLE IF NOT EXISTS project_route_log (
    route_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, requested_project_id TEXT NOT NULL, canonical_project_id TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS owner_mutation_epoch (user_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
  -- Effects with no single owner (a global vector generation, which may hold several owners' documents) and any
  -- detected loss of protection bump this instead; a freshness token is the pair (global epoch, owner epoch).
  CREATE TABLE IF NOT EXISTS global_mutation_epoch (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL);
  -- Tables whose epoch triggers were installed once. A missing or altered trigger on a recorded table means
  -- writes may have been missed: it is repaired and the global epoch is bumped, invalidating every older token.
  CREATE TABLE IF NOT EXISTS lifecycle_protection (table_name TEXT PRIMARY KEY, installed_at TEXT NOT NULL, losses INTEGER NOT NULL DEFAULT 0);`;

// Schema v9 enforcement groundwork.
//  - owner_lifecycle_generation: a monotonic per-owner counter bumped by every delete, restore and merge. Lifecycle,
//    bootstrap, resume and reconciliation authority is bound to it, so no token survives a lifecycle change and
//    restoring a project never revives earlier authority (generations never decrease).
//  - project_lifecycle_previews: owner-scoped lifecycle previews. A preview binds the complete impact hash computed
//    server-side (display summaries are bounded separately), both epochs and the generation; its own row is not part
//    of its impact. Previews are not material epoch rows: their freshness is the in-transaction impact recomputation.
// Monotonic generation guards. The only supported change is bumpGeneration (resolver), an UPSERT whose insert seed is
// already current + 1, so the BEFORE INSERT guard never rejects a legitimate bump however high the generation is.
// Refused: any UPDATE that does not strictly increase it or that moves it to another owner, DELETE, and any insert
// (including INSERT OR REPLACE / OR IGNORE, whose REPLACE deletion fires no DELETE trigger) that is not above the
// existing value. SQLite stores trigger text without IF NOT EXISTS; the stored text must equal these exactly.
export const GENERATION_GUARDS = [
  `CREATE TRIGGER owner_lifecycle_generation_no_reset BEFORE INSERT ON owner_lifecycle_generation
    WHEN EXISTS (SELECT 1 FROM owner_lifecycle_generation WHERE user_id = NEW.user_id AND generation >= NEW.generation)
    BEGIN SELECT RAISE(ABORT, 'owner lifecycle generation never decreases or resets'); END`,
  `CREATE TRIGGER owner_lifecycle_generation_no_decrease BEFORE UPDATE ON owner_lifecycle_generation
    WHEN NEW.generation <= OLD.generation OR NEW.user_id IS NOT OLD.user_id
    BEGIN SELECT RAISE(ABORT, 'owner lifecycle generation never decreases or resets'); END`,
  `CREATE TRIGGER owner_lifecycle_generation_no_delete BEFORE DELETE ON owner_lifecycle_generation
    BEGIN SELECT RAISE(ABORT, 'owner lifecycle generation never decreases or resets'); END`,
];
const guardName = sql => sql.match(/^CREATE TRIGGER (\S+)/)[1];
// Initialization marker. Once the guards were installed, a missing or altered guard means the generation may have been
// decreased, reset or deleted while unguarded, and reinstalling the guard cannot make generation-only authority safe
// again. So the marker turns any later loss into a refusal that happens BEFORE the repeatable v9 step could repair it.
// A database without the marker (fresh, or the earlier fenced v9 candidate that never exposed lifecycle authority)
// receives its first installation, and the marker is written in the same step right after the guards.
export const GENERATION_GUARD_SET = 'owner_lifecycle_generation';
/** Refuses to serve when a generation guard is missing or altered. Read-only. */
export function assertGenerationGuards(db) {
  const problems = GENERATION_GUARDS.flatMap(sql => {
    const actual = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(guardName(sql))?.sql;
    return actual === sql ? [] : [`${guardName(sql)}: ${actual === undefined ? 'missing' : 'altered'}`];
  });
  if (problems.length) throw new ConflictError(`Lifecycle protection incomplete: ${problems.join('; ')}`, 'LIFECYCLE_PROTECTION_MISSING');
}
/** Runs before any migration or repeatable repair: if the guards were ever initialized, they must still be intact. */
export function assertInitializedGenerationGuards(db) {
  if (!exists(db, 'lifecycle_guard_installations')) return;
  if (!db.prepare('SELECT 1 FROM lifecycle_guard_installations WHERE guard_set = ?').get(GENERATION_GUARD_SET)) return;
  assertGenerationGuards(db);
}
export const LIFECYCLE_ENFORCEMENT_TABLES = `
  CREATE TABLE IF NOT EXISTS owner_lifecycle_generation (user_id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK (generation >= 0));
  ${GENERATION_GUARDS.map(sql => sql.replace('CREATE TRIGGER ', 'CREATE TRIGGER IF NOT EXISTS ') + ';').join('\n  ')}
  CREATE TABLE IF NOT EXISTS lifecycle_guard_installations (guard_set TEXT PRIMARY KEY, installed_at TEXT NOT NULL);
  INSERT OR IGNORE INTO lifecycle_guard_installations (guard_set, installed_at) VALUES ('${GENERATION_GUARD_SET}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  CREATE TABLE IF NOT EXISTS project_lifecycle_previews (
    preview_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, project_id TEXT NOT NULL, target_project_id TEXT,
    payload_sha256 TEXT NOT NULL, impact_sha256 TEXT NOT NULL, impact_json TEXT NOT NULL, generation INTEGER NOT NULL,
    global_epoch INTEGER NOT NULL, owner_epoch INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','confirmed','superseded','expired')),
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS project_lifecycle_previews_owner ON project_lifecycle_previews(user_id, state, project_id);
  -- Lifecycle generation bound to pending authority (bootstrap and resume previews, reconciliation proposals) when it
  -- was produced, kept apart so the frozen preview/proposal records stay exactly as stored. Written in the producing
  -- transaction; a record without a row predates this binding (current only while the owner's generation is 0).
  CREATE TABLE IF NOT EXISTS lifecycle_authority_bindings (
    user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('project_bootstrap','task_bootstrap','resume','reconciliation')),
    record_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK (generation >= 0), created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, kind, record_id));`;

// Material tables by installing module ("group"). owner: the row's own user_id, or {parent, key} resolved
// through the parent table. updateOf: when set, only these columns are material for UPDATE; the excluded
// columns are named so the choice is reviewable. Tables not listed are excluded on purpose:
//   audit_events, settings (global), *_operations/receipts (idempotency records of writes counted at source),
//   memory_fingerprints, memory_index_outbox, memory_search_* (derived from memories, counted at source),
//   memory_derived_outbox, handoff_module_state, memory_vector_active, memory_vector_calls (global),
//   memory_model_budget, memory_profile_state, memory_owner_model_usage, memory_owner_vector_usage,
//   memory_owner_vector_build_usage, console_model_usage(_daily) (usage telemetry),
//   console_models, console_model_tests, console_model_quotas, console_vector_budget, console_vector_profiles,
//   console_vector_requests, console_settings, console_preferences, console_imports, console_import_records
//   (configuration and import receipts; their effects on memories, categories and summaries are counted there),
//   memory_vector_points (derived from memory_vector_documents, which are tracked).
const viaVectorOwner = {parent: 'memory_vector_owners', key: 'generation'};
export const MATERIAL_TABLES = [
  // core: created by the Core migrations.
  ...['projects', 'tasks', 'events', 'checkpoints', 'memories', 'resumes', 'resolver_selections', 'resume_delivery_receipts',
    'resume_injection_events', 'task_bootstrap_previews', 'task_canonical_revisions', 'task_reconciliation_proposals',
    'memory_web_denials', 'project_lifecycle'].map(table => ({table, group: 'core'})),
  // Authority, not telemetry: owner, key, scopes, expiry, revocation and the bound identity (device, agent and
  // agent instance) are material; last_used_at, label and rotated_at (set together with revoked_at) are not.
  {table: 'credentials', group: 'core', updateOf: ['user_id', 'key_hash', 'scopes_json', 'expires_at', 'revoked_at', 'device_id', 'agent_id', 'agent_instance_id']},
  ...['memory_revisions', 'memory_sources', 'memory_source_links', 'memory_processing_outbox'].map(table => ({table, group: 'revisions'})),
  ...['memory_privacy', 'memory_annotations', 'memory_category_overrides', 'memory_summaries', 'memory_summary_dependencies'].map(table => ({table, group: 'derived'})),
  {table: 'memory_summary_claims', group: 'derived', owner: {parent: 'memory_summaries', key: 'summary_id'}},
  ...['memory_web_grants', 'memory_web_policy'].map(table => ({table, group: 'web'})),
  {table: 'cloud_memory_bindings', group: 'cloud'},
  {table: 'memory_source_pins', group: 'sources'},
  // Job source sets, payloads and outcomes are material; lease, attempt, scheduling and progress counters are not.
  {table: 'memory_jobs', group: 'jobs', updateOf: ['user_id', 'job_type', 'fingerprint', 'scope_key', 'group_key', 'profile', 'metadata_json', 'input_hash', 'highwater', 'state', 'result_ref', 'total']},
  {table: 'memory_job_items', group: 'jobs'},
  {table: 'handoff_drain_resumes', group: 'handoff'},
  ...['console_project_state', 'console_organize_batches', 'console_organize_items', 'memory_vector_owners', 'memory_vector_owner_active'].map(table => ({table, group: 'console'})),
  // Rows of a global (ownerless) generation have no single owner: they bump the global epoch instead of nothing.
  {table: 'memory_vector_manifest', group: 'console', owner: viaVectorOwner, globalWhenOwnerless: true},
  // Optional: only present once vectors are configured (at startup or later from the Console).
  {table: 'memory_vector_documents', group: 'vector'},
  {table: 'memory_vector_generations', group: 'vector', owner: viaVectorOwner, globalWhenOwnerless: true, updateOf: ['generation', 'profile', 'collection_name', 'state', 'dimensions', 'distance']},
];
export const OPTIONAL_GROUPS = ['vector'];
const byTable = new Map(MATERIAL_TABLES.map(entry => [entry.table, entry]));

const exists = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
const ownerOf = (entry, row) => entry.owner ? `(SELECT user_id FROM ${entry.owner.parent} WHERE ${entry.owner.key} = ${row}.${entry.owner.key})` : `${row}.user_id`;
const bump = (owner, extra = '') => `INSERT INTO owner_mutation_epoch (user_id, epoch) SELECT ${owner}, 1 WHERE ${owner} IS NOT NULL${extra} ON CONFLICT (user_id) DO UPDATE SET epoch = epoch + 1;`;
const GLOBAL_BUMP = 'INSERT INTO global_mutation_epoch (id, epoch) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET epoch = epoch + 1;';
// One global bump per statement when the row (old or new) has no owner.
const bumpGlobalIfOwnerless = owners => `INSERT INTO global_mutation_epoch (id, epoch) SELECT 1, 1 WHERE ${owners.map(owner => `${owner} IS NULL`).join(' OR ')} ON CONFLICT (id) DO UPDATE SET epoch = epoch + 1;`;
export const triggerName = (table, op) => `lifecycle_epoch_${table}_${op}`;
export function triggerSql(entry, op) {
  const rows = op === 'insert' ? ['NEW'] : op === 'delete' ? ['OLD'] : ['NEW', 'OLD'];
  const body = (op === 'insert' ? bump(ownerOf(entry, 'NEW'))
    : op === 'delete' ? bump(ownerOf(entry, 'OLD'))
    : `${bump(ownerOf(entry, 'NEW'))} ${bump(ownerOf(entry, 'OLD'), ` AND ${ownerOf(entry, 'OLD')} IS NOT ${ownerOf(entry, 'NEW')}`)}`)
    + (entry.globalWhenOwnerless ? ` ${bumpGlobalIfOwnerless(rows.map(row => ownerOf(entry, row)))}` : '');
  const columns = op === 'update' && entry.updateOf ? ` OF ${entry.updateOf.join(', ')}` : '';
  return `CREATE TRIGGER ${triggerName(entry.table, op)} AFTER ${op.toUpperCase()}${columns} ON ${entry.table} BEGIN ${body} END`;
}
const OPS = ['insert', 'update', 'delete'];

function inTransaction(db, callback) {
  if (db.isTransaction) return callback();
  db.exec('BEGIN IMMEDIATE');
  try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Installs the epoch triggers of tables the caller has just created (a listed table must exist). The first
 * installation is recorded. If a recorded table is later found with a missing or altered trigger, writes may
 * have gone uncounted: the trigger is repaired and the global epoch is bumped, so no token taken before the
 * loss can ever match again (epochs never decrease). */
export function protectTables(db, tables) {
  inTransaction(db, () => {
    for (const table of tables) {
      const entry = byTable.get(table);
      if (!entry) throw new Error(`Not a registered material table: ${table}`);
      if (!exists(db, table)) throw new ConflictError(`Material table ${table} is missing.`, 'LIFECYCLE_PROTECTION_MISSING');
      const recorded = !!db.prepare('SELECT 1 FROM lifecycle_protection WHERE table_name=?').get(table);
      let lost = false;
      for (const op of OPS) {
        const expected = triggerSql(entry, op), name = triggerName(table, op);
        const actual = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.sql;
        if (actual === expected) continue;
        if (recorded) lost = true;
        if (actual !== undefined) db.exec(`DROP TRIGGER ${name}`);
        db.exec(expected);
      }
      if (!recorded) db.prepare('INSERT INTO lifecycle_protection (table_name, installed_at) VALUES (?, ?)').run(table, new Date().toISOString());
      else if (lost) { db.prepare('UPDATE lifecycle_protection SET losses = losses + 1 WHERE table_name=?').run(table); db.exec(GLOBAL_BUMP); }
    }
  });
}
/** An optional module may not be constructed on this open (for example vectors no longer configured) while its
 * tables remain from earlier. Its present tables are protected (and a lost trigger counted) here, so they are
 * never left unprotected; a partially present group is then refused by assertProtection. */
export function protectPresentOptional(db) {
  for (const group of OPTIONAL_GROUPS) {
    const tables = groupTables(group), present = tables.filter(table => exists(db, table));
    if (!present.length) continue;
    // A partially present group is refused before anything is repaired or counted.
    if (present.length !== tables.length) throw new ConflictError(`Lifecycle protection incomplete: ${tables.filter(table => !present.includes(table)).map(table => `${table}: missing`).join('; ')}`, 'LIFECYCLE_PROTECTION_MISSING');
    protectTables(db, present);
  }
}
/** Every table of a group that the module has created, as registered. */
export const groupTables = group => MATERIAL_TABLES.filter(entry => entry.group === group).map(entry => entry.table);
export const protectGroup = (db, group) => protectTables(db, groupTables(group));

/** Refuses to continue unless every required material table exists with exactly its triggers, and an optional
 * group that is present at all is complete and protected. Absence is only accepted for a whole optional group. */
export function assertProtection(db, groups = [...new Set(MATERIAL_TABLES.map(entry => entry.group))]) {
  const problems = [];
  for (const group of groups) {
    const tables = groupTables(group), present = tables.filter(table => exists(db, table));
    if (OPTIONAL_GROUPS.includes(group) && !present.length) continue;
    for (const table of tables) {
      if (!present.includes(table)) { problems.push(`${table}: missing`); continue; }
      for (const op of OPS) {
        const actual = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(triggerName(table, op))?.sql;
        if (actual !== triggerSql(byTable.get(table), op)) problems.push(`${table}: ${op} trigger ${actual === undefined ? 'missing' : 'altered'}`);
      }
    }
  }
  if (problems.length) throw new ConflictError(`Lifecycle protection incomplete: ${problems.join('; ')}`, 'LIFECYCLE_PROTECTION_MISSING');
}

/** This build records lifecycle metadata but does not enforce deletion or merge. It refuses any database where
 * a project is deleted or merged, before any existing record is read or written. */
export class LifecycleUnsupportedError extends Error {
  constructor() { super('This release cannot open a database with deleted or merged projects.'); this.name = 'LifecycleUnsupportedError'; this.code = 'PROJECT_LIFECYCLE_UNSUPPORTED'; }
}
export function assertNoUnenforcedLifecycle(db) {
  if (!exists(db, 'project_lifecycle')) return;
  if (db.prepare("SELECT 1 FROM project_lifecycle WHERE state <> 'active' LIMIT 1").get()) throw new LifecycleUnsupportedError();
}

/** Current epoch of an owner (0 before any material write). */
export const ownerEpoch = (db, user) => db.prepare('SELECT epoch FROM owner_mutation_epoch WHERE user_id = ?').get(user)?.epoch ?? 0;
/** Global epoch: ownerless material effects and detected protection losses. */
export const globalEpoch = db => db.prepare('SELECT epoch FROM global_mutation_epoch WHERE id = 1').get()?.epoch ?? 0;

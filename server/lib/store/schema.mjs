import {migrateEntities} from '../memory-entities/schema.mjs';
// Core database schema as ordered, versioned migrations (PRAGMA user_version).
// Every step is idempotent so databases created before versioning adopt it safely.
import { applyMigrations, schemaVersion, SchemaVersionError } from "./migrations.mjs";
import { LIFECYCLE_TABLES, LIFECYCLE_ENFORCEMENT_TABLES, protectGroup, assertInitializedGenerationGuards } from "../lifecycle/protection.mjs";
import { assertLifecycleConsistent } from "../lifecycle/resolver.mjs";

const CORE_TABLES = `
      CREATE TABLE IF NOT EXISTS credentials (
        credential_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT,
        rotated_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS credentials_instance_idx
        ON credentials(user_id, agent_instance_id, revoked_at);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        git_remotes_json TEXT NOT NULL,
        repo_fingerprints_json TEXT NOT NULL,
        path_hints_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_user_name_idx
        ON projects(user_id, name);

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        title TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        progress_json TEXT NOT NULL,
        decisions_json TEXT NOT NULL,
        blockers_json TEXT NOT NULL,
        next_steps_json TEXT NOT NULL,
        resources_json TEXT NOT NULL,
        workstreams_json TEXT NOT NULL,
        conflicts_json TEXT NOT NULL,
        canonical_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_user_activity_idx
        ON tasks(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        workstream_id TEXT,
        session_id TEXT,
        turn_id TEXT,
        event_type TEXT NOT NULL,
        hook_event_name TEXT,
        captured_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        expires_at TEXT,
        expired_at TEXT,
        content TEXT,
        raw_payload_json TEXT,
        capture_capability_json TEXT,
        cwd TEXT,
        model TEXT,
        tool_name TEXT,
        tool_use_id TEXT,
        FOREIGN KEY(credential_id) REFERENCES credentials(credential_id)
      );
      CREATE INDEX IF NOT EXISTS events_task_activity_idx
        ON events(user_id, task_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS events_expiry_idx
        ON events(expires_at, expired_at);

      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        content TEXT NOT NULL,
        scope TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        workstream_id TEXT,
        session_id TEXT,
        source TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'fact',
        status TEXT NOT NULL DEFAULT 'active',
        source_event_ids_json TEXT NOT NULL DEFAULT '[]',
        source_checkpoint_id TEXT,
        generation_method TEXT,
        confidence REAL,
        confidence_label TEXT,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        content_fingerprint TEXT,
        topic TEXT,
        topic_key TEXT,
        supersedes_memory_id TEXT,
        superseded_by_memory_id TEXT,
        lifecycle_reason TEXT,
        retracted_at TEXT,
        lifecycle_actor_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT,
        FOREIGN KEY(credential_id) REFERENCES credentials(credential_id)
      );
      CREATE INDEX IF NOT EXISTS memories_task_idx
        ON memories(user_id, task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS memory_create_operations (
        user_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        operation_type TEXT NOT NULL CHECK(operation_type = 'memory.create'),
        operation_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        submitted_identity_json TEXT NOT NULL,
        effective_scope_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(user_id, agent_instance_id, operation_type, operation_id),
        FOREIGN KEY(memory_id) REFERENCES memories(memory_id),
        FOREIGN KEY(credential_id) REFERENCES credentials(credential_id)
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        workstream_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        trigger_event_id TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        content_json TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        generation_method TEXT NOT NULL,
        confidence REAL NOT NULL,
        confidence_label TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(trigger_event_id) REFERENCES events(event_id),
        UNIQUE(user_id, task_id, workstream_id, version),
        UNIQUE(user_id, source_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS checkpoints_task_version_idx
        ON checkpoints(user_id, task_id, workstream_id, version DESC);
      CREATE INDEX IF NOT EXISTS checkpoints_session_idx
        ON checkpoints(user_id, session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS task_reconciliation_proposals (
        proposal_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        proposal_version INTEGER NOT NULL,
        base_canonical_version INTEGER NOT NULL,
        requested_by_credential_id TEXT,
        source_checkpoint_ids_json TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        source_workstreams_json TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        conflicts_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by_credential_id TEXT,
        FOREIGN KEY(requested_by_credential_id) REFERENCES credentials(credential_id),
        FOREIGN KEY(resolved_by_credential_id) REFERENCES credentials(credential_id),
        UNIQUE(user_id, source_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS task_reconciliation_task_idx
        ON task_reconciliation_proposals(user_id, task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS task_reconciliation_status_idx
        ON task_reconciliation_proposals(user_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS task_canonical_revisions (
        revision_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        canonical_version_before INTEGER NOT NULL,
        canonical_version_after INTEGER NOT NULL,
        proposal_id TEXT,
        operations_json TEXT NOT NULL,
        before_hash TEXT,
        after_hash TEXT NOT NULL,
        source_checkpoint_ids_json TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        decision TEXT NOT NULL,
        credential_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(proposal_id) REFERENCES task_reconciliation_proposals(proposal_id),
        FOREIGN KEY(credential_id) REFERENCES credentials(credential_id),
        UNIQUE(user_id, task_id, canonical_version_after)
      );
      CREATE INDEX IF NOT EXISTS task_canonical_revision_task_idx
        ON task_canonical_revisions(user_id, task_id, canonical_version_after DESC);

      CREATE TABLE IF NOT EXISTS task_bootstrap_previews (
        bootstrap_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        requested_by_credential_id TEXT NOT NULL,
        bootstrap_kind TEXT NOT NULL DEFAULT 'task',
        project_id TEXT NOT NULL,
        proposed_task_id TEXT NOT NULL,
        preview_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        binding_packet_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        confirmed_at TEXT,
        cancelled_at TEXT,
        FOREIGN KEY(requested_by_credential_id) REFERENCES credentials(credential_id),
        UNIQUE(user_id, bootstrap_id, preview_version)
      );
      CREATE INDEX IF NOT EXISTS task_bootstrap_user_created_idx
        ON task_bootstrap_previews(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS task_bootstrap_status_idx
        ON task_bootstrap_previews(user_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS resumes (
        resume_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        requested_by_credential_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        preview_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        packet_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        confirmed_at TEXT,
        cancelled_at TEXT,
        FOREIGN KEY(requested_by_credential_id) REFERENCES credentials(credential_id)
      );
      CREATE INDEX IF NOT EXISTS resumes_user_created_idx
        ON resumes(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS resolver_selections (
        selection_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        resume_id TEXT NOT NULL,
        preview_version INTEGER NOT NULL,
        query TEXT NOT NULL,
        query_fingerprint TEXT NOT NULL,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        signals_json TEXT NOT NULL,
        candidate_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(credential_id) REFERENCES credentials(credential_id),
        FOREIGN KEY(resume_id) REFERENCES resumes(resume_id),
        UNIQUE(user_id, resume_id, preview_version)
      );
      CREATE INDEX IF NOT EXISTS resolver_selection_query_idx
        ON resolver_selections(user_id, query_fingerprint, created_at DESC);
      CREATE INDEX IF NOT EXISTS resolver_selection_task_idx
        ON resolver_selections(user_id, task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS resume_injection_events (
        event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        resume_id TEXT NOT NULL,
        preview_version INTEGER NOT NULL,
        attempt_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        workstream_id TEXT NOT NULL,
        injection_method TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        FOREIGN KEY(resume_id) REFERENCES resumes(resume_id),
        FOREIGN KEY(credential_id) REFERENCES credentials(credential_id),
        UNIQUE(user_id, resume_id, attempt_id, phase)
      );
      CREATE INDEX IF NOT EXISTS resume_injection_resume_idx
        ON resume_injection_events(user_id, resume_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS resume_injection_attempt_idx
        ON resume_injection_events(user_id, resume_id, attempt_id, occurred_at ASC);

      CREATE TABLE IF NOT EXISTS resume_delivery_receipts (
        receipt_event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        resume_id TEXT NOT NULL,
        preview_version INTEGER NOT NULL,
        receipt_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        workstream_id TEXT NOT NULL,
        delivery_method TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        FOREIGN KEY(resume_id) REFERENCES resumes(resume_id),
        FOREIGN KEY(credential_id) REFERENCES credentials(credential_id),
        UNIQUE(user_id, resume_id, receipt_id, phase)
      );
      CREATE INDEX IF NOT EXISTS resume_delivery_receipt_resume_idx
        ON resume_delivery_receipts(user_id, resume_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS resume_delivery_receipt_attempt_idx
        ON resume_delivery_receipts(user_id, resume_id, receipt_id, occurred_at ASC);

      CREATE TABLE IF NOT EXISTS audit_events (
        audit_id TEXT PRIMARY KEY,
        user_id TEXT,
        credential_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        outcome TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_created_idx
        ON audit_events(created_at DESC);
    `;

const addColumns = (table, columns) => (db) => {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  for (const [column, sql] of columns) if (!existing.has(column)) db.exec(sql);
};

export const CORE_MIGRATIONS = Object.freeze([
  { version: 1, repeatable: true, name: "core-tables", up: (db) => db.exec(CORE_TABLES) },
  { version: 2, repeatable: true, name: "tasks-canonical-version", up: addColumns("tasks", [
    ["canonical_version", "ALTER TABLE tasks ADD COLUMN canonical_version INTEGER NOT NULL DEFAULT 1"],
  ]) },
  { version: 3, repeatable: true, name: "memories-structured-lifecycle", up: addColumns("memories", [
    ["memory_type", "ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'fact'"],
    ["status", "ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"],
    ["source_event_ids_json", "ALTER TABLE memories ADD COLUMN source_event_ids_json TEXT NOT NULL DEFAULT '[]'"],
    ["source_checkpoint_id", "ALTER TABLE memories ADD COLUMN source_checkpoint_id TEXT"],
    ["generation_method", "ALTER TABLE memories ADD COLUMN generation_method TEXT"],
    ["confidence", "ALTER TABLE memories ADD COLUMN confidence REAL"],
    ["confidence_label", "ALTER TABLE memories ADD COLUMN confidence_label TEXT"],
    ["warnings_json", "ALTER TABLE memories ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '[]'"],
    ["content_fingerprint", "ALTER TABLE memories ADD COLUMN content_fingerprint TEXT"],
    ["topic", "ALTER TABLE memories ADD COLUMN topic TEXT"],
    ["topic_key", "ALTER TABLE memories ADD COLUMN topic_key TEXT"],
    ["supersedes_memory_id", "ALTER TABLE memories ADD COLUMN supersedes_memory_id TEXT"],
    ["superseded_by_memory_id", "ALTER TABLE memories ADD COLUMN superseded_by_memory_id TEXT"],
    ["lifecycle_reason", "ALTER TABLE memories ADD COLUMN lifecycle_reason TEXT"],
    ["retracted_at", "ALTER TABLE memories ADD COLUMN retracted_at TEXT"],
    ["lifecycle_actor_json", "ALTER TABLE memories ADD COLUMN lifecycle_actor_json TEXT NOT NULL DEFAULT '{}'"],
    ["updated_at", "ALTER TABLE memories ADD COLUMN updated_at TEXT"],
  ]) },
  { version: 4, repeatable: true, name: "task-bootstrap-kind", up: addColumns("task_bootstrap_previews", [
    ["bootstrap_kind", "ALTER TABLE task_bootstrap_previews ADD COLUMN bootstrap_kind TEXT NOT NULL DEFAULT 'task'"],
  ]) },
  { version: 5, repeatable: true, name: "memory-lifecycle-indexes", up: (db) => db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS memories_content_fingerprint_idx
        ON memories(user_id, content_fingerprint)
        WHERE content_fingerprint IS NOT NULL;
      CREATE INDEX IF NOT EXISTS memories_status_idx
        ON memories(user_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS memories_topic_idx
        ON memories(user_id, task_id, topic_key, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS memories_lineage_idx
        ON memories(user_id, superseded_by_memory_id, supersedes_memory_id);
      CREATE INDEX IF NOT EXISTS task_bootstrap_kind_status_idx
        ON task_bootstrap_previews(user_id, bootstrap_kind, status, created_at DESC);
    `) },
  // Owner-scoped time ordering: overview recency/activity and the unfiltered library.
  { version: 6, repeatable: true, name: "memories-user-created-index", up: (db) => db.exec(`
      CREATE INDEX IF NOT EXISTS memories_user_created_idx
        ON memories(user_id, created_at DESC, memory_id);
    `) },
  // Older readers ignore explicit private denials. A schema boundary must prevent
  // rolling back to those readers even though the change is structurally additive.
  { version: 7, repeatable: true, name: "memory-web-private-denials", up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS memory_web_denials (user_id TEXT NOT NULL,memory_id TEXT NOT NULL,
        revision INTEGER NOT NULL,state_hash TEXT NOT NULL,PRIMARY KEY(user_id,memory_id));
    `) },
  // Additive lifecycle foundation: no project gets a row (no row means active), no history is rewritten.
  // Repeatable: the tables and the Core epoch triggers are re-ensured (and repaired) on every open.
  { version: 8, repeatable: true, name: "project-lifecycle-foundation", up: (db) => { db.exec(LIFECYCLE_TABLES); protectGroup(db, "core"); } },
  // Enforcement groundwork (still fenced: this schema refuses deleted/merged projects at open). Additive only.
  { version: 9, repeatable: true, name: "project-lifecycle-enforcement-groundwork", up: (db) => db.exec(LIFECYCLE_ENFORCEMENT_TABLES) },
  // The first fully enforcing schema: reads, writes and jobs enforce deleted and merged projects, so this build opens
  // such databases. The version itself is the boundary: every earlier reader (including the fenced v9 builds) refuses
  // a v10 database before reading or writing a record. The marker records when full enforcement first applied.
  { version: 10, repeatable: true, name: "project-lifecycle-enforced", up: (db) => db.exec(`
      CREATE TABLE IF NOT EXISTS project_lifecycle_enforcement (id INTEGER PRIMARY KEY CHECK (id = 1), enforced_since TEXT NOT NULL);
      INSERT OR IGNORE INTO project_lifecycle_enforcement (id, enforced_since) VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    `) },
  // Derived identity and tombstones affect retrieval. Older readers must not silently ignore this boundary.
  {version:11,repeatable:true,name:'source-grounded-entities',up:migrateEntities},
]);

export const CORE_SCHEMA_VERSION = CORE_MIGRATIONS.at(-1).version;
// Order matters for a refused open to write nothing: first the version boundary (a newer database is refused), then
// the read-only lifecycle consistency check, then the generation-guard check, and only then any migration, repeatable
// ensure or repair write. From v10 on, consistent deleted and merged projects are enforced and open normally (the fenced
// v8/v9 builds refused every one of them here); inconsistent lifecycle metadata is still refused at open.
export const migrateCoreSchema = (db) => {
  const version = schemaVersion(db);
  if (version > CORE_SCHEMA_VERSION) throw new SchemaVersionError(`Database schema version ${version} is newer than this release supports (${CORE_SCHEMA_VERSION}).`);
  // Consistent deleted/merged state opens; inconsistent lifecycle metadata still refuses the open, read-only, here.
  assertLifecycleConsistent(db);
  // Initialized generation guards that went missing or were altered are refused here, before the repeatable v9 step
  // could silently reinstall them over a generation that may have been reset while unguarded.
  assertInitializedGenerationGuards(db);
  return applyMigrations(db, CORE_MIGRATIONS);
};

# Memory-first modules (MEM-00–10)

This is implementation guidance, not a deployment or production acceptance report.
SQLite remains authoritative. Existing FTS retrieval, explicit memory writes,
OAuth/Web read-only tools, and host handoff contracts are retained.

Exact project-ID previews, colon-aware lexical retrieval, and explicit event
outbox reconciliation are described in [read correctness](READ-CORRECTNESS.md).
For summary field availability and version-pinned canonical Task field reads,
see [read-only Task details](TASK-DETAIL-READ.md).

## Independent modules

`capture/dispatch.mjs` dispatches captured events to independent memory and handoff
paths. `memory/service.mjs` depends on shared identity/scope/storage interfaces,
not Checkpoint, Resume or canonical reconciliation implementations. Existing Store
entry points remain a compatibility facade; this is not a full rewrite of Store.

With memory enabled and handoff disabled, an authorized client can save, search,
read, correct and retract a user/session memory without creating a Project, Task,
Workstream, Checkpoint, Resume or reconciliation proposal. Optional strict labeled
capture extraction also works without a Task. It is rule extraction, not an LLM.
An assistant statement is recorded as `assistant_suggestion`, never independently
fact-checked or silently promoted to a confirmed user fact.

New memory revisions atomically enqueue classification/summary intents. They remain
`blocked_config` until an explicitly configured local worker schedules them. The
optional vector projection similarly keeps an outbox. Saving and lexical retrieval
do not wait for model or vector services. Workers never start as a side effect of a
read; see [maintenance and provider contracts](OPERATIONS.md).

## One private runtime config

Adapt [the empty example](memory.runtime.example.json) to absolute paths outside
every source/Git worktree; save the runtime copy outside the checkout. Preserve
existing files. No command below installs services or moves data.

```bash
node server/bin/mnemuron-storage-doctor.mjs --config /etc/mnemuron/memory.runtime.json
MNEMURON_MEMORY_CONFIG=/etc/mnemuron/memory.runtime.json \
  node server/bin/mnemuron-server.mjs
```

`MNEMURON_DATABASE_PATH`, if present, overrides `storage.sqlite_path` and is still
guarded. The doctor requires `storage.sqlite_path`, resolves the config path before
reading it, checks configured data/config/secrets/export/backup/vector/job paths,
and reports fields and permission warnings without reading database or key files.
The declared directories are boundary checks, not new stores provisioned here.

Both `modules.memory.enabled` and `modules.handoff.enabled` must be booleans.
`existing_inflight_policy` must be `drain_before_disable`. New explicit configs
default capture extraction to off; enabling it requires
`memory.capture_extraction.enabled=true`. Enabled profiles require the complete
validated provider/network contract. Unsafe overwrite/export policies are rejected.
Models, workers and vectors remain disabled in the shipped example.

Without a new config, legacy capture/handoff behavior and a migration notice remain.
An explicitly persisted handoff-disable decision is not undone by an older client
opening the same database without module flags. Disabling memory rejects new memory
writes while preserving authorized reads of existing records.

Production rejects private paths within any Git worktree or the source root,
including symlink/parent traversal and not-yet-created children. It checks before
opening SQLite or creating its parent. The guard is startup validation, not protection
against a malicious local administrator replacing symlinks after validation.
Development storage inside `.dev/` requires both `deployment_mode=test` (or
`development`) and `development.synthetic_data=true`; real data never qualifies.
The runtime config file itself stays outside source even in this exception.

Use local SQLite/WAL storage and private directory/file permissions. Ignoring a
file in Git is not storage isolation. No automatic migration of misplaced real
files occurs; operators must inventory and authorize that move separately.

## Disabling handoff safely

The server immediately rejects new Task/Project writes, bootstrap, checkpoints,
Resume preview/confirm and reconciliation mutations with `HANDOFF_DISABLED`.
Existing records and authorized reads remain. A companion drain table snapshots
already confirmed Resumes, without modifying their original states or history.

Existing in-flight attempts may finish with their exact Session, Turn, credential,
workstream and receipt validation unchanged. A confirmed but undelivered packet may
perform its first delivery. Drain does not introduce a new retry attempt after an
earlier attempt; no ACK, cancellation or success is synthesized. Terminal receipt
retries stay idempotent. Outstanding confirmations remain explicitly `draining`
until their normal delivery terminates; forced cancellation is not implemented.

Authenticated `GET /v1/capabilities` and `/v1/status` expose module state. ChatGPT
plugin tool discovery removes new handoff operations when the central service has
disabled them, retaining pending-delivery tools only while needed for drain. A
legacy server without the capability endpoint uses existing local behavior.
The optional local `handoff_enabled=false` flag can also hide/reject new handoff
tools, but cannot weaken central policy. Hooks and exact confirmation/ACK behavior
are not removed or repurposed. The Web gateway remains read-only and does not gain
handoff tools.

## Additive versions and provenance

Companion tables store memory revisions, immutable source metadata, source links,
versioned fingerprints, processing intents and index intents. Migration batches
legacy rows for inspection but commits the companion backfill transaction atomically.
It creates revision 1 without changing original memory IDs/content/source/lifecycle
columns or resetting existing FTS state. Legacy migration creates no processing jobs.

New body/lifecycle revisions, source links, audit and outbox changes share the SQLite
transaction. Explicit operation retries retain their IDs and create no extra jobs.
The v2 fingerprint trims boundary whitespace only: case, Unicode and punctuation
are preserved. Owner, scope and branch identifiers participate. Legacy IDs are reused
only when exact content/topic and a known source event also match; old lossy
fingerprints alone cannot collapse `1.2.3` into `1-2-3`.

`GET /v1/memories/:id` adds `source_manifest` without changing existing body pagination.
Its source pagination uses `source_offset` / `next_source_offset`. Source metadata
includes hash, length/unit, role, revision, reference and availability. New extracted
spans specify their decoded JSON text selector and UTF-16 offsets; explicit-source
spans use the same offset unit. Unknown legacy spans remain unknown. Expired,
missing or hash-mismatched raw is never presented as an intact original. A retained
atomic memory is not a reconstruction of a missing raw event.

The local migration regression creates a nonempty synthetic database using the prior
Git implementation, compares every original column in six authoritative tables,
and reopens it twice. Real databases are not necessary or authorized for that test.
Operational rollback requires an authorized pre-migration copy: do not drop the
companion tables or run an old writer against a migrated live database. Writes made
after a backup would not be present in that backup. Production rollback/scale has
not been accepted by this batch.

## Verification and later work

```bash
npm run test:memory-unit
npm run test:memory-integration
npm run test:memory-model-contract
npm run test:memory-worker
npm run test:memory-vector
npm run test:memory-quality
npm run test:all
npm run test:publication
node scripts/check-publication.mjs --all-refs
node scripts/check-secrets.mjs --history
```

`test:all` runs independent suites even after another fails and reports exits,
failures, cancellations and skips. It removes inherited endpoint/key/proxy settings;
fixtures use disposable loopback databases. OAuth dependencies and the fixed
Gitleaks scanner must already be installed. Missing dependencies are not a pass.
See [publication policy](../publication-policy.md) for history/remote coverage and
optional commit-hook setup. CI configuration existing is not proof of a CI run.

The local implementation includes provider protocol adapters, leased jobs,
versioned classifications and source-grounded summaries, optional Qdrant projection,
hybrid retrieval, explicit source pins/manifests and isolated backup verification.
Synthetic contract results do not establish real-model summary quality, real Qdrant
acceptance, production capacity, or full GitHub privacy clearance. Read the execution
report in the operator's private evidence directory for actual tested coverage.
The [repeatable synthetic quality harness](QUALITY.md) freezes expected answers
before model requests and keeps protocol, hard correctness, model quality and
human review separate.
Use the [final delivery checklist](DELIVERY.md) to verify a source candidate and
distinguish local compatibility evidence from deployment or publication approval.
`production_ready` remains `false`.

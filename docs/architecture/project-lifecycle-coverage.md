# Project lifecycle: read/write coverage inventory

Operator note: a database whose lifecycle metadata is inconsistent, including lifecycle rows whose projects table is damaged or missing, is refused at open before any write or self-repair; recover it from a verified backup (isolated restore) rather than editing rows by hand.

Status: schema v11 adds the owner-scoped entity evidence graph to the v10 lifecycle enforcement boundary. Phases 5B (reads), 5C (writes) and 5D (jobs and derived outputs) remain enforced. The v10 build first opened databases with deleted or merged projects (v8/v9 refused them); inconsistent lifecycle metadata is still refused before any write or repair (`assertLifecycleConsistent`). Older readers, including v10, refuse v11 before mutation. Lifecycle state is created only by the 5E Console actions behind the 5F BFF re-authentication gate (below); the Console UI is 5G.

## Audit and entity evidence additions (v11)
- Audit resolves current titles only through the current owner's live-project filter; foreign, deleted or missing targets keep recorded references but no content or link. Recorded credential references are never inferred from labels.
- Entity nodes, names, membership, proposals, tombstones and queue cursors are owner-bound and covered by mutation-epoch protection. The SQL inventory includes all six tables, not just the authoritative memory tables.
- `MemoryEntities.source` and proof validation reload current source revisions, privacy and exact scope. Every seed, one-hop bridge and returned target is rechecked; deleted sources are unavailable, and merge never unifies same-named entities from distinct contexts.
- Console entity reads retain provenance and stale/inactive labels but withhold stale anchor text. Confirmations require a current evidence version. Organizer previews bind alias evidence and lifecycle dependencies and re-resolve under the write transaction.
- Lifecycle preview includes actual entity and proposal counts. Restoring availability requeues previously requested eligible entity work only; it never creates extraction intents for untouched historical memories. Old confirmation tokens remain invalid.
- Auto-acceptance deliberately supports only whole-source declarations with single-token engineering or Chinese names. Multiword names, attribution, quotation, conditions, negation and extra sentences stay pending. Owner-typed names never become restricted-reader evidence and retire at both endpoints when objects are linked.

## Phase 5B read enforcement (implemented; behavior tests LE-01..10, LR-01..23)
- **One rule.**
  - `ProjectLifecycle.live(user)` is computed per request from the authoritative `project_lifecycle` rows. There is no cached index.
  - A record is live when its `project_id` is NULL (a neutral memory), or names a project the caller owns that is not effectively deleted.
  - Dangling and foreign IDs are never live.
  - Inconsistent metadata throws `PROJECT_LIFECYCLE_CORRUPT` before any read (LR-08).
  - `sql(column)`, `has`, `canonicalOf` and `projectState` share this rule. Canonical grouping never grants access.
- **Memory scope.**
  - `resolveMemoryScope` attaches the filter to every resolved scope. `memoryScopeSql` refuses a scope without it, so lexical search, hybrid/semantic hydration and the vector scope list all filter before their candidate windows (LR-01, LR-09).
  - Explicit and task-derived projects resolve owner-first: `PROJECT_DELETED` for the owner, generic `PROJECT_NOT_FOUND` for others. Merged scopes read the canonical member set.
  - A task of a merged source matches its canonical target (canonical equivalence). Agent, session and workstream ownership checks are unchanged.
- **Direct and derived reads.**
  - `memoryDetail` (also with `include_history`): `PROJECT_DELETED` for the full owner credential; a web reader, dangling or foreign reference gets `MEMORY_NOT_FOUND`.
  - `DerivedMemory.currentSource` returns null for deleted-project records. This covers summary pages, vector delivery, job input/publish validation and `validateItem` (LR-03).
- **Lists, resolver and context.**
  - `listProjects`/`listTasks` are canonical and live. Merged sources lend origin-labelled `merged_sources` signals (`inherited_from`). Explicit source IDs route with `routed_from`.
  - An explicit deleted project or task ID is `PROJECT_DELETED` (LR-04).
  - Project context, task context, task branches, resume preview memories, checkpoints, reconciliation state, canonical revisions and resume injection/delivery status (LR-05, LR-06).
  - Task bootstrap similarity uses canonical equivalence.
- **Console normal views** (LR-07):
  - overview, insights, library list/search/facets/classification counts, summaries list (a summary depending on any deleted-project record, user-wide included, is not listed), projects list (canonical, live, `merged_project_ids`, member task counts), metadata values, task detail, task-branches, memory meta/versions;
  - operation replay status and the live export.
- **Review notes 17–26 (LR-10..19):**
  - **Resolver provenance.** Every inherited reason is origin-labelled. Token overlap is scored per origin (best origin wins; own names win a tie). Prior confirmations keep their total-based weight with `confirmation_origins`, and `inherited_from` when they come from a single merged project.
  - **Task scoring identity.** Project identity across all members of a canonical group (target and merged sources) is excluded from task scoring: a project-only query forces no Task, and same-named Tasks stay separate.
  - **Unavailable parents.** A Task whose parent is dangling or foreign is a generic `TASK_NOT_FOUND` on direct Core and Console paths. `PROJECT_DELETED` is returned only for an owned, effectively deleted project.
  - **Merged summaries.** `memorySummaries` through any member of a merged project pages over every member's exact origin scope key (each summary keeps its own key; single-scope cursor binding unchanged). Mixed and user-wide summaries still validate every source. The Console summary list hides summaries scoped to an owned deleted project, also without dependencies, and detail answers `PROJECT_DELETED`. Malformed, dangling and foreign keys keep their unknown-scope display.
  - **Workstream ownership.** Evidence uses canonical equivalence (a source-origin Task keeps its workstream when later records name the target) and counts only live records.
  - **Per-record history.** Checkpoints (list/latest/Console/deferred), branch activity, resume inputs (events, memories, observed workstreams), reconciliation proposals and canonical revisions are filtered on each record's own project before limits. A Task moved from P to Q never surfaces P's history after P is deleted (LR-16, built through the supported capture API).
  - **Source manifests and content.** Manifests check the Task and filter each event before count/page. Direct source content of a deleted project is `PROJECT_DELETED`; a dangling or foreign one is unavailable.
  - **Web grants.** The grant inventory lists only live memories, consistent with inspection (`PROJECT_DELETED` / `MEMORY_NOT_FOUND`).
  - **Resumes.** A resume has no project column: it is judged by its Task's current project. Aggregate injection and delivery summaries count only resumes the individual readers accept, so one deleted project never breaks status.
  - **Explicit query-form IDs.** `project-…`/`task-…` in a query get the same owner-only `PROJECT_DELETED` as signal IDs.
  - **Merged source IDs in the Console.** Their own metadata values are readable and labelled `canonical_project_id`. Project edits, archive and unarchive through a merged source are `PROJECT_NOT_CANONICAL` with no change (the source keeps its own stored metadata and archive state); the target is edited by its own ID.
  - **Bounded branch previews.** `selected_project` in task resolution and branch previews is a bounded projection: 5×200 per list for the project, name, 3 aliases and per-list counts for up to 20 merged sources, `metadata_truncated` when anything was cut. Stored values are unchanged. `finalizeReadPreview` no longer assumes sections a preview kind does not have.
  - **Organize tokens** bind owner, lifecycle generation and each row's project, so a preview never survives a delete and restore. The transactional recheck at apply is 5C wiring.
  - **Semantic delivery** revalidates after an in-flight embedding wait (LR-19).
  - BFF forwards and the catalog translates `PROJECT_DELETED`, `PROJECT_LIFECYCLE_CORRUPT`, `PROJECT_NOT_CANONICAL`, `PROJECT_MEMBER_LIMIT` and `INVALID_OPERATION_ID` (ERRORS-01 now scans `console/projects.mjs` and `lifecycle/resolver.mjs`).
- **Review notes 28–31 (LR-20..23):**
  - **Resolver evidence.** `resolverHistory` (confirmations) and `taskAssociations` (agent, device, recency) count each record only while its own project is live. A Task moved P→Q is never ranked or explained by deleted P history; live and merged-origin history still count.
  - **Semantic error contract.** The semantic/hybrid catch blocks (personal-profile path in `store.searchMemories` and `VectorIndex.search`) re-throw deterministic outcomes (validation, authentication, authorization, not found, conflicts such as `PROJECT_DELETED`) instead of reporting `SEMANTIC_UNAVAILABLE`/`VECTOR_UNAVAILABLE`. This holds both for a pre-deleted scope and for a deletion during the embedding wait. Real provider failures are still degradation.
  - **Status reconciliation.** `status().canonical_reconciliation` filters each proposal on its own project, and agrees with `reconciliationState` for a moved Task.
  - **Summaries for every project-bound scope.** `memorySummaries` expands every project-bound exact scope (project, task, workstream, session) across the canonical members; only the project slot varies. A moved Task's task/workstream summaries under both origin keys are read after P→Q merge, with no blending of other Tasks or workstreams, and every dependency is still revalidated.
- **Reviewed read exceptions:**
  - `status.counts` and `raw_availability` are account-wide stored-row and retention accounting;
  - Console `storage` counts;
  - capture/job telemetry other than per-project lists;
  - `privacyImpact` (retention dry run);
  - `pruneExpired`, migration repair, backups/restore checks and operator harnesses (unchanged, listed below).
## Phase 5C write enforcement (implemented; behavior tests LW-01..20; each lifecycle guard mutation-checked, LW-17/18 are regression tests of existing transaction and idempotency behavior)
- **One write guard.** `ProjectLifecycle.writeProject` runs only inside the write transaction, owner first:
  - an owned deleted ID is `PROJECT_DELETED`, and deleted IDs stay permanently reserved (no recreation, no edit);
  - a merged ID routes a new record to the canonical project and records the requested ID in `project_route_log` (`logRoute`);
  - a new ID with no project row follows the existing creation and ownership rules (another owner's ID is refused generically).
  - Route records commit or roll back with the write (LW-04).
- **Destinations.**
  - New records land in the canonical project, whether named through a source ID, the target ID or inferred from a source-origin Task. This covers Tasks created through a merged ID, captured events, checkpoints, memories (save and capture-derived), supersede replacements and cloud saves.
  - Existing records keep their origin:
    - a Task row re-upserted through any member of its canonical group keeps its project;
    - originals of corrected memories keep theirs;
    - retained raw event payloads are never rewritten.
  - Merged sources are not edited through their old ID (`PROJECT_NOT_CANONICAL`); the Console and Core rules agree.
  - The phase-3 no-rename rule is kept.
- **Capture.** A deleted item refuses the whole atomic batch, leaving no event or route record. A replayed event ID adds nothing. Checkpoint creation refuses a deleted Task's project, takes source events per record, and routes inside its own transaction.
  - An event first derived before its project was merged replays onto the memory already derived from it in a member project: the replay derivation looks it up by member set, scope fields, content, topic and source event ID (one `memories` read in `memory/service.mjs`), so no second copy or route record appears (LW-10).
  - A checkpoint replay (replayed trigger or manual request) is a read: the stored checkpoint's project and its Task's current project must be live before any content returns (LW-11). The Task's current project is also rechecked inside the insert transaction (LW-13).
- **Replays and existing-record writes.**
  - `saveMemory` returns stored content on replay only while that record's project is live. The request hash is still bound to the original submitted intent, and a different intent still conflicts.
  - `supersedeMemory`/`retractMemory` decide target, status, lifecycle and the idempotent reply inside the transaction, and check every returned record.
  - Cloud supersede/retract give the same generic not found as for an unreadable record, and leave no grant, privacy or replacement side effects. The metadata-only cloud receipt (`commit_snapshot`) stays an immutable historical acknowledgement and is never content.
  - Console operation replays withhold content-derived fields of a no-longer-readable memory.
- **Pending authority.** Bootstrap previews (project and task), resume previews and reconciliation proposals bind the owner's lifecycle generation in `lifecycle_authority_bindings`, written with the record; the frozen records themselves are unchanged. The bound generation is the one observed before the preview's reads, so a change committed between those reads and the insert leaves the record stale (LW-12).
  - Confirmation re-checks the binding and the record's lifecycle inside its transaction (`LIFECYCLE_AUTHORITY_STALE`, `PROJECT_DELETED`).
  - A record without a binding is current only while the owner's generation is 0.
  - Stale pending bootstrap previews are not reused.
  - Confirmed replays re-deliver packets only while authority is current; a refused replay writes no resolver selection.
  - Explicit cancel and reject stay allowed.
  - An unchanged Task hash never stands in for the binding.
- **Console writes.**
  - Organize re-plans and compares its generation-bound token inside the apply transaction. Undo skips (`PROJECT_UNAVAILABLE`) and never mutates or claims a deleted-project memory.
  - Privacy (`setSensitivity`), web grants (`webVisibility.set`) and manual categories (`setCategory`/`manualTarget`) refuse deleted, dangling or foreign project records inside their write.
- **Serialization.** A lifecycle change held on another connection blocks the write (busy); once committed, the write is `PROJECT_DELETED` with no change (LW-09).
- **Independent memory/cloud/Console review additions (LW-14..19).**
  - Organize: delete then restore with an identical visible selection stays stale, and a lifecycle change committed on another connection just before the apply transaction is seen by the in-transaction comparison (LW-14).
  - A supersede replay checks the replacement record on its own (LW-15).
  - Cloud supersede/retract denials (foreign owner, stale revision, removed exact grant, keep-private, an ungranted record of a merged member) write nothing; a merged member never lends another its grant (LW-16).
  - Injected failures at the end of organize, classify, undo, web-grant and privacy writes leave no row or success audit (LW-17); a save made through a project before its merge replays through the old ID afterwards without conflict or retargeting (LW-18).
  - A manual category write rechecks its target under the write lock: a deletion committed on another connection just before the write begins leaves no override (LW-20).
  - Tracked, low (not reachable through current callers): `ConsoleOrganizer.classify`/`undo` read their targets or batch before opening their own transaction when called directly; every Console caller runs them inside `state.sync`'s transaction. `taxonomy.save`'s `CATEGORY_IN_USE` check also counts overrides of hidden records, so a category used only by a deleted project's records is removed through `category.delete` instead.
  - **Category delete** (`categories.remove` via `category.delete`): only live records are moved in the counted, undoable batch. Records of a deleted project follow the removed category to its target as taxonomy maintenance (no organize item, not counted, not undoable), so the taxonomy stays consistent if the project is restored (LW-19). The split reads each member's project with one `memories` join in `console/organize.mjs`.
- **Reviewed write exceptions (unchanged):**
  - taxonomy-wide maintenance (`features.apply`, and the hidden-record part of `category.delete` above);
  - retention (`pruneExpired`, `privacyImpact` dry run);
  - migration repair;
  - Console imports, which create neutral personal memories.

## Phase 5D jobs and derived outputs (implemented; behavior tests LJ-01..07, each guard mutation-checked)
- **One source check.** `DerivedMemory.currentSource`/`validateItem` (status, revision, privacy, captured-source expiry and the record's own project lifecycle) decides every derived step. A deleted project's record is no source; a merged source stays a live member of its target. No record is physically purged to hide it; retention rules are unchanged.
- **Scheduling** (`scheduleLibrary`, Console schedules) takes only current sources (LJ-01).
- **Execution.** Queued jobs revalidate every chunk before building the model input (LJ-02). The per-call budget reservation (`MemoryJobs.reserve`) is the last step before every model request, the organizer's repair retry included, and revalidates that chunk's sources inside its transaction: a stale source fails `STALE_INPUT` before any budget or provider call (LJ-04).
- **Results.** `saveChunk`, `MemoryJobs.publish` and each derived publisher (`publishSummary`, `publishAnnotations`) revalidate inside their transactions, each on its own, so a deletion while the model call is in flight, or just before publication, publishes no annotation, summary or dependency (LJ-03, LJ-05).
- **Vectors.** `sync`/`syncManifest` re-read each source, hide a deleted project's documents (backend points and mappings removed), and revalidate in the embedding reservation and again after the call and before recording. A document that goes stale during its own embedding is hidden (`sync`) or marked `stale` (`syncManifest`) with any written points removed, and the build continues; a lost lease is `LEASE_LOST` and stops it (LJ-06). Only the source itself going stale is skipped: a provider-side `STALE_INPUT` for a still-valid source (for example a Console model configuration changed mid-build) stops the build without hiding or skipping live records (LJ-07). Search delivery reloads authoritative rows (LR-09, LR-19, LR-21).

## Phases 5E/5F: lifecycle mutations behind re-authentication (behavior tests LM-01..10, HTTP-LIFECYCLE-01..03)
- **Actions (full Console write credentials only):**
  - `projects.lifecycle_preview` takes `{action: delete|restore|merge, project_id, target_project_id?}`.
  - The confirms are `projects.lifecycle_delete {preview_id, confirm_name}`, `projects.lifecycle_restore {preview_id}` and `projects.merge {preview_id}`.
  - `projects.restore` is still Console unarchive.
  - Agent, MCP, cloud, web, `admin:tasks`, read-only and basic Console credentials are refused (LM-05, HTTP-LIFECYCLE-02).
- **BFF gate (5F):** every confirm requires a fresh password + OTP (`reauthenticate`, the `devices.revoke` pattern).
  - Unknown fields are refused, and only the confirm fields reach Core (`CONSOLE_LIFECYCLE_CONFIRMS`). The factors never do (HTTP-LIFECYCLE-01).
  - Previews need no factors.
  - Before checking the factors, the BFF asks Core whether the preview would still confirm (`lifecycle-preview-check`). This is a read-only Console view for full-write credentials, allow-listed in the Core reader routes and in ConsoleCore. A stale or expired preview is answered with `PREVIEW_CHANGED`/`PREVIEW_EXPIRED` without consuming a re-authentication attempt or an OTP. The confirm still rechecks everything in its own transaction (HTTP-LIFECYCLE-03).
  - A revoked Console session cannot confirm (HTTP-LIFECYCLE-03).
  - The existing re-authentication limit (5 per 15 min) and OTP replay protection are unchanged.
- **Preview:** owner first, so a foreign or unknown project gets the generic `PROJECT_NOT_FOUND`.
  - Validation:
    - delete needs an active canonical project;
    - restore needs a deleted canonical project; a merged source is restored with its target (`PROJECT_NOT_CANONICAL`);
    - merge needs distinct, active, canonical projects, with a cycle check, at most 20 sources and bounded depth.
  - The complete server-side impact is hashed. It covers, per member: name, aliases, lifecycle row, archive state, Tasks, memories, revisions, checkpoints and events. It also covers summaries, vector documents, pending bootstrap/resume previews, reconciliation proposals and queued jobs, plus same-title Task and name/alias conflicts.
  - Displays are bounded to 20 and say when truncated (LM-07). Vector impact counts memories that have an indexed vector document (each memory once, across generations).
  - The preview row stores the impact hash and the bounded display only (the impact is recomputed at confirm). Previews that expired more than a day earlier are removed when the owner previews again.
  - The preview binds the hash, the owner lifecycle generation and the owner and global epochs. Previews are not material rows.
- **Confirm (one transaction, idempotent per operation ID):**
  - The preview must be this owner's, pending, unexpired (10 min) and for this action.
  - Validation and the full impact are recomputed and compared with the generation and both epochs. Any difference, including any material write by the owner, gives `PREVIEW_CHANGED`. Delete also needs the exact typed name.
  - On success, in the same transaction:
    - the lifecycle row is written;
    - the generation is bumped;
    - one append-only lifecycle event is recorded;
    - the preview is confirmed and other pending previews superseded;
    - the action is audited.
  - Nothing is purged, rewritten or reparented (LM-01). Same-titled Tasks stay distinct and nothing is renamed (LM-04).
  - A concurrent lifecycle change serializes the confirm and makes it stale, and an injected failure leaves nothing (LM-06).
  - Merge undo is not offered (`merge_undo_available: false`).
  - **Liveness tradeoff (kept on purpose):** the owner epoch moves on any material write by the owner, including agent captures and job state, so the preview goes stale. An owner whose agents write continuously may need to preview again. That is safe, and the pre-check keeps it from costing factors. The comprehensive binding follows the brief ("later writes … force refresh"). The 5G UI refreshes a stale preview.
- **Restore:**
  - The canonical project and its members return.
  - The Console archive state is kept.
  - Earlier authority stays stale: the generation never decreases.
  - Jobs that went stale while the project was deleted are rescheduled when every item validates again (LM-03).

## Phase 5G: Console lifecycle UI (browser section `lifecycle`, 47 checks; LM-11/12)
- **Project views:**
  - Active, Console-archived, and Deleted. Deleted is retained history with Restore, and is owner-only: it and its count are shown only to full Console write credentials (LM-11).
  - Merged projects are listed under their target.
  - The project search folds case beyond ASCII and matches the name or a single alias. Merge targets may be Console-archived.
- **Dialogs:**
  - delete (impact, typed name, password + code), restore, and merge (searchable targets with keyboard selection, conflicts, the no-undo statement, Back);
  - one confirm per preview operation ID (idempotent retries; a confirmed preview's retry replays, LM-12);
  - the result is announced and focused, and focus returns to the trigger on Cancel.
- **Factors:** the authenticator code is single-use, so it is kept only after a name mismatch, which the BFF answers before checking factors. After any other error it is cleared, and after wrong factors both are cleared.
- **Staleness (decision):** a stale preview, for example from a second tab, is detected at confirm time. The BFF pre-check refuses it before the factors are checked, and the dialog refreshes the preview in place. There is no live polling, so Confirm is not disabled in advance; the confirm itself is always rechecked in the transaction.
- **Async guards:**
  - replies are ignored unless they belong to the current dialog and the newest request (reordered replies across Cancel and reopen are tested);
  - Cancel, Escape and Back stay usable while a preview loads, and Confirm is disabled without a current preview;
  - the debounced target search is cleared on close;
  - a confirm that completes after the dialog closed still refreshes the list and never leaves actions blocked.
- **Browser coverage:**
  - zh and en at 1440, 390 and 320;
  - keyboard open, radio selection and Enter;
  - Cancel/Back write nothing;
  - Enter pressed twice sends one confirm;
  - name typo, wrong factors, stale refresh, revoked session (redirect to sign-in);
  - screenshots taken after the dialog animation settles.
  - Defence in depth that a browser cannot isolate: the submit `working` guard. Controls are disabled synchronously, so a second Enter has nothing to submit.

- **Not yet enforced (deferred, tracked):**
  - **Retained-history views (5G).** Owner retained-history and restore views.
  - **Adapters (5H).** End-to-end adapter flows.

- **Machine-checked part:** `project-lifecycle-coverage.json` holds per-file counts of literal SQL read sites (`FROM`/`JOIN`) and write sites (`INSERT`/`REPLACE`/`UPDATE`/`DELETE`) for the lifecycle-relevant tables. `server/test/project-lifecycle-coverage.test.mjs` fails when those counts change, so every new or removed access site is reviewed here.
- **What the count cannot see:** writes through helpers, dynamically built SQL and triggers. These are listed by hand below. The static count is supplementary evidence, not proof; behavior tests are the proof.

## Owner controls and handoff policy access review

- `server/bin/mnemuron-owner-migrate.mjs` uses two metadata-only `memories` reads to require exactly one represented owner and confirm the requested owner. This explicit offline migration intentionally counts all retained rows, including deleted-project records; filtering them would hide a conflicting owner. It requires paused legacy workers and checks the inventory inside `BEGIN IMMEDIATE`. It reads no memory bodies and grants no processing authority.
- `server/lib/console/owner.mjs` has four literal `memories` reads and one `project_lifecycle` read. Migration and schedule saves use owner-scoped maximum rowids as high-water marks, including retained history so it cannot become newly eligible work. The owner-only read-impact count restricts active rows by user, web-read policy and the absence of a non-active lifecycle row; this aggregate is not a source authorization check. The bounded preview selects owner-scoped IDs and reloads every candidate through `DerivedMemory.currentSource`, enforcing effective lifecycle, revision and privacy before freezing items. Start, resume, execution and publication revalidate source state and lifecycle generation. Helper-mediated reads remain covered by the derived-source rules.
- `server/lib/handoff-policy.mjs` now has three literal `resumes` reads. The additional read snapshots confirmed deliveries when the owner disables handoff, inside the caller's memory transaction. Like the startup snapshot, it intentionally retains existing drain membership rather than creating new work. Receipt and injection handling still applies owner, preview-version, attempt and lifecycle checks in Store; a snapshot is not delivery authorization.

The owner-control, handoff and lifecycle behavior tests remain required alongside the literal-site inventory check. These reviewed metadata/snapshot reads do not exempt normal content reads or publication from lifecycle enforcement.

## Rules for enforcement
- **Normal reads** (scoped or unscoped) exclude projects whose effective state is deleted, and resolve merged project IDs to their canonical target. Every record keeps its own authorization: canonical membership groups results and never grants access. Web denials, keep-private, exact-version cloud grants, scopes and agent/session/workstream ownership stay in force.
- **Normal writes** validate the canonical lifecycle state inside the same write transaction (no check-then-write gap), and refuse deleted projects. Writes through an old (merged) ID are routed to the canonical target with requested-ID provenance in `project_route_log`; origin `project_id` values are never rewritten.
- **Derived outputs** (summaries, vectors, entities, context) revalidate their authoritative sources at delivery. A user-wide or mixed summary can depend on a deleted project's memory without carrying its `project_id`.
- **Previews and confirmations:**
  - The owner/global epoch is necessary but not sufficient.
  - A confirmation recomputes the displayed impact (counts, pending previews and proposals, conflicts) inside the confirming transaction and compares it with the preview's impact fingerprint.
  - Authorization (credential scopes, revocation, owner re-authentication) is checked afresh. It is never inferred from an unchanged epoch.

## Read sites by area (enforcement requirement)
| Area | Files | Requirement |
|---|---|---|
| Core store: projects, tasks, checkpoints, events, resumes, resolver, reconciliation | `server/lib/store.mjs` | Effective-live filter on every normal read; canonical equivalence instead of raw `project_id` equality for tasks, events, checkpoints and branches |
| Memory scope and retrieval | `memory-scope.mjs`, `memory-retrieval.mjs`, `memory/service.mjs`, `memory/web-visibility.mjs`, `memory/cloud.mjs`, `memory/sources.mjs` | Scope SQL gains the live/canonical predicate; web and cloud readers keep their per-record checks |
| Task context and project context | `task-context-read.mjs`, `store.mjs` (`previewProjectContext`) | Resolve the requested project first; deleted → `PROJECT_DELETED`; members for merged |
| Derived summaries and pagination | `memory-derived/store.mjs`, `memory-derived/pagination.mjs` | Dependency revalidation per summary, including mixed/user-wide summaries |
| Vectors | `vector-stores/index.mjs`, `console/service.mjs` | Reload authoritative records at delivery; never trust payload scope |
| Jobs | `memory-jobs/worker.mjs` | Revalidate sources at execution and before publishing results |
| Console reads | `console-read.mjs`, `console/features.mjs`, `console/organize.mjs`, `console/projects.mjs`, `console/state.mjs` | Normal views live-only; explicit owner retained-history/restore views are the reviewed exception |
| Lifecycle itself | `lifecycle/resolver.mjs`, `lifecycle/protection.mjs` | Owner-first resolution; open-time consistency and protection checks |

**Reviewed exceptions** (may read deleted/merged rows on purpose):
- owner retained-history and restore views (to be added);
- lifecycle impact counts;
- retention pruning (`pruneExpired`, account-wide raw-event retention, unchanged);
- migration repair (`store.migrate`);
- backups and restore checks (`server/bin/mnemuron-scheduled-backup.mjs`, `mnemuron-restore-check.mjs`);
- operator harnesses in `server/bin/*harness*` and `*reconcile*`, which run against disposable or operator-selected databases.

## Write entry points (reviewed by hand; transaction boundary → check enforcement adds)
| Entry point | Tables | Boundary | Enforcement check |
|---|---|---|---|
| `store.migrate` (repair) | projects, task_canonical_revisions | migration open | runs after the version, lifecycle-consistency and generation-guard checks; repair `INSERT OR IGNORE` only |
| `ensureProject` (via `upsertTask`) | projects | caller's `BEGIN IMMEDIATE` | refuse a deleted ID (no recreation); route a merged ID |
| `upsertProject` | projects | single statement | refuse deleted; route merged; owner guard (Phase 1) |
| `upsertTask` / `writeUpsertedTask` | tasks, task_canonical_revisions, task_reconciliation_proposals | `BEGIN IMMEDIATE` (or the Console SAVEPOINT) | canonical project live; source-task writes use canonical equivalence |
| `insertCanonicalRevision` | task_canonical_revisions | caller's transaction | none beyond caller |
| `createProjectBootstrapPreview` / `confirmProjectBootstrap` | task_bootstrap_previews, projects, tasks | preview / `BEGIN IMMEDIATE` | deleted IDs reserved; lifecycle generation bound into the preview |
| `createTaskBootstrapPreview` / `confirmTaskBootstrap` | task_bootstrap_previews, tasks | preview / `BEGIN IMMEDIATE` | project live at confirmation |
| `runReconciliation`, `applyReconciliationProposal`, `resolveReconciliation` | task_reconciliation_proposals, tasks | `BEGIN IMMEDIATE` | proposal authorization and lifecycle generation revalidated even with an unchanged task hash |
| `createCheckpointFromTrigger`, `appendEvents` | checkpoints, events | capture transaction | project live (or routed) inside the transaction |
| `saveMemory`, `supersedeMemory`, `retractMemory`, `memory/service.derive`, `memory/revisions.record` | memories, memory_revisions | `memoryTransaction` | project live inside the transaction; routed writes logged |
| `recordResolverSelection`, `createPreview`, `confirmPreview` (resume) | resolver_selections, resumes | `BEGIN IMMEDIATE` | candidates exclude deleted/merged sources; confirmation revalidates |
| `pruneExpired` | events | maintenance | unchanged (retention only) |
| Derived: `publishSummary`, `publishAnnotations`, `setCategory`, `migrate` | memory_summaries, memory_summary_dependencies | `memoryTransaction` / job | sources revalidated at publish |
| Vectors: `sync`, `syncManifest` | memory_vector_documents | job lease | authoritative reload at execution and delivery |
| Console: `projects.update`, `projects.archive/restore`, organize `invalidate`/`recordImport`, `features.apply` (taxonomy) | projects, console_project_state, memory_summaries | `state.sync` transaction | project live; archive stays Console-only and distinct |
| Triggers | memory_summaries (stale on revision/privacy change), memory_web_grants (revoked on change) | the writing statement | unchanged; epoch triggers count them |

**Optional and late-created features:**
- Vector tables are created by `VectorIndex`, at startup only when vectors are configured, or later from the Console. Each creation path installs epoch protection before its first write.
- A database whose vector tables remain while vectors are no longer configured is protected at open.
- A partially present vector group is refused.
- Future entity/alias tables must join `MATERIAL_TABLES` and this inventory when introduced.

## Epoch exclusions (summary; the full list is in `server/lib/lifecycle/protection.mjs`)
- **Excluded:** telemetry and receipts (credential last-used and label, job leases/attempts/progress, usage counters, audit, idempotency receipts), global configuration, and derived search shadows. Their material effects are counted at source.
- **Global epoch:** ownerless vector generations and their manifests bump the global epoch.
- **Protection loss:** a missing or altered epoch trigger on a previously protected table is repaired at open and bumps the global epoch, so tokens taken before the loss never match again.
- **Lifecycle history** (`project_lifecycle_events`) is append-only, including against `INSERT OR REPLACE`. No supported Core cleanup path deletes owner history (raw-event retention only edits captured events), so no purge exception exists.

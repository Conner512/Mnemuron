# Canonical Task Reconciliation v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## 1. Goal

Keep a Task's canonical state current as work continues across ChatGPT, OpenClaw, devices, Sessions, and Workstreams, without allowing a rule-derived Checkpoint or the last writer to silently overwrite another source.

The feature addresses stale canonical state: recent Checkpoints and evidence may describe completed work while `progress`, `blockers`, and `next_steps` still describe an older phase.

This phase prioritizes core task continuity. Backup/restore expansion, the 120-minute partition profile, long soak testing, and Hermes-specific acceptance are not part of this design or its first implementation slice.

## 2. Non-negotiable boundaries

- Checkpoints remain immutable, append-only Workstream snapshots.
- Raw Events, Memories, Resolver selections, Resume records, Receipts, and existing audit evidence are never rewritten.
- A Checkpoint is evidence for a canonical change; it is not canonical state by itself.
- Reconciliation is scoped to one `user_id + task_id` and never merges different Tasks.
- Workstream, Device, Agent, Agent Instance, Session, Checkpoint, and source Event provenance is retained on every proposed and applied change.
- No global last-write-wins behavior is allowed.
- Destructive or material changes are shown before they are applied.
- Resume Preview/Confirm, Task Scope, one-time delivery, and Stop ACK semantics do not change.
- `production_ready` remains `false`; this design does not promote the deployment.

## 3. Source-of-truth model

The system keeps three distinct layers:

```text
Raw Events
  -> immutable per-Workstream Checkpoints
       -> immutable Reconciliation Proposal
            -> policy decision
                 |- safe additive operation -> automatic canonical revision
                 `- material/conflicting operation -> user confirmation -> canonical revision
```

Authority order is:

1. An explicit user-confirmed reconciliation decision.
2. A previously applied canonical revision.
3. A server-verified, source-backed automatic additive operation.
4. An unapplied Checkpoint-derived suggestion.

A newer timestamp does not outrank a higher-authority source.

## 4. Canonical revision model

### 4.1 Task version

Add `canonical_version INTEGER NOT NULL DEFAULT 1` to `tasks`.

Every successful canonical change increments the value exactly once. Confirmation must include both the proposal version and the base canonical version the user reviewed.

The update uses compare-and-swap semantics:

```sql
UPDATE tasks
SET ..., canonical_version = canonical_version + 1, updated_at = ?
WHERE user_id = ? AND task_id = ? AND canonical_version = ?
```

If no row is changed, the proposal becomes `stale` and must be regenerated. It never overwrites the newer Task.

### 4.2 Reconciliation proposal

Add an append-only `task_reconciliation_proposals` table:

| Field | Purpose |
| --- | --- |
| `proposal_id` | Stable UUID |
| `user_id`, `task_id`, `project_id` | Ownership and scope |
| `proposal_version` | Starts at 1; a regenerated proposal gets a new ID |
| `base_canonical_version` | Task version used to compute the patch |
| `requested_by_credential_id` | Identity that requested proposal generation |
| `source_checkpoint_ids_json` | Exact source Checkpoints |
| `source_event_ids_json` | Deduplicated transitive source Events |
| `source_workstreams_json` | Source Workstreams and identities |
| `operations_json` | Ordered field-level operations |
| `conflicts_json` | Preserved competing claims |
| `policy_json` | Rule version and per-operation decision reasons |
| `source_fingerprint` | Idempotency key |
| `status` | Proposal state |
| `created_at`, `resolved_at` | Lifecycle timestamps |
| `resolved_by_credential_id` | Null for automatic application; exact confirmer otherwise |

Required uniqueness:

```text
UNIQUE(user_id, source_fingerprint)
```

The fingerprint covers the Task, base canonical version, ordered source Checkpoint IDs, and normalized operations. Reprocessing the same evidence returns the existing proposal.

### 4.3 Canonical revision ledger

Add an append-only `task_canonical_revisions` table:

| Field | Purpose |
| --- | --- |
| `revision_id` | Stable UUID |
| `user_id`, `task_id`, `project_id` | Ownership and scope |
| `canonical_version_before`, `canonical_version_after` | Monotonic version transition |
| `proposal_id` | Exact proposal that caused the change |
| `operations_json` | Operations actually committed |
| `before_hash`, `after_hash` | Canonical Task integrity hashes |
| `source_checkpoint_ids_json`, `source_event_ids_json` | Evidence chain |
| `decision` | `automatic` or `user_confirmed` |
| `credential_id` | Acting identity when applicable |
| `created_at` | Commit time |

The current `tasks` row remains the compatibility projection used by existing Resolver and Resume code. The revision ledger explains how it reached that state.

## 5. Field-level operations

v0.1 supports only explicit operations; it does not accept an arbitrary replacement Task document.

| Operation | Target | Default policy |
| --- | --- | --- |
| `append_unique` | `progress` | Automatic only under all safe-add rules |
| `append_unique` | `decisions`, `blockers`, `next_steps`, `resources` | Review required |
| `remove_exact` | `blockers`, `next_steps` | Review required |
| `replace_scalar` | `title`, `goal`, `status` | Review required |
| `replace_workstream_status` | one exact Workstream | Review required |
| `record_conflict` | `conflicts` | Automatic preservation; resolution requires review |

Every operation carries:

- `operation_id`;
- `field` and operation type;
- normalized value fingerprint;
- displayed before/after value;
- exact Checkpoint and Event sources;
- source Workstream and Agent identity;
- extraction confidence and warnings;
- policy decision and reason.

Only items with `source=derived_from_event` may create new operations. The `source=task_snapshot` items copied into a Checkpoint are ignored so canonical content cannot be re-imported as new evidence.

## 6. Safe automatic application

v0.1 automatically applies only a new `progress` item when all conditions hold:

1. The source is the latest Checkpoint for its Workstream.
2. The Checkpoint belongs to the same User, Project, and Task.
3. The derived item comes from the Checkpoint's latest assistant outcome Event.
4. The Checkpoint confidence is at least `medium` with score at least `0.65`.
5. The item contains an explicit completion/pass/deployment result, has no negation, and is between 12 and 500 characters.
6. Its normalized fingerprint is not already present in canonical progress or an applied revision.
7. No proposal from another Workstream contains a competing claim for the same controlled key.
8. The base canonical version still matches at commit time.

Anything else becomes `awaiting_confirmation`. In particular, v0.1 never automatically:

- completes or reopens the Task;
- removes a blocker or next step;
- changes the goal or title;
- chooses between conflicting Workstreams;
- treats low-confidence or warning-limited prose as settled truth.

This makes the automatic path useful but monotonic: it may add a provenance-backed result, but it cannot erase, replace, or close existing state.

## 7. Conflict and concurrent update behavior

### 7.1 Structural conflicts

The engine can deterministically identify conflicts when operations target the same controlled key with different outcomes, including:

- different `status` values;
- replace versus retain/remove of the same exact blocker or next step;
- different status values for the same Workstream;
- concurrent proposals computed from the same base version where at least one operation is non-additive.

Competing claims are stored together with their original sources. The proposal becomes `awaiting_confirmation`; neither claim is silently selected.

### 7.2 Free-form semantic differences

Current Checkpoints do not expose stable `fact_key/fact_value` pairs. v0.1 therefore does not pretend that two paraphrased decisions or blockers are the same fact.

It may show them side by side as `possible_semantic_conflict`, but it cannot auto-resolve or call the result authoritative. Stable fact keys or a later model-assisted reconciliation phase can extend this boundary without changing the revision protocol.

### 7.3 Concurrent writers

- Additive, non-conflicting proposals may be regenerated on the newest canonical version and applied once.
- A material proposal whose base version changed becomes `stale`.
- A stale proposal cannot be confirmed.
- Repeating the same confirmation is idempotent and returns the existing revision.
- A rejected proposal and its evidence remain append-only; later evidence creates a new proposal.

## 8. Proposal state machine

```text
generated
  |- no_effect
  |- auto_applied
  `- awaiting_confirmation
       |- applied
       |- rejected
       |- superseded
       `- stale
```

Definitions:

- `no_effect`: all operations were duplicates or already reflected in canonical state.
- `auto_applied`: every operation passed the safe additive policy and committed atomically.
- `awaiting_confirmation`: at least one material or uncertain operation needs review.
- `applied`: the exact displayed proposal version was explicitly confirmed and committed.
- `rejected`: the user explicitly rejected it.
- `superseded`: newer evidence replaced an unconfirmed proposal before a decision.
- `stale`: canonical version changed and the proposal can no longer be safely committed.

## 9. Trigger and transaction boundary

After a Checkpoint is successfully inserted, the server runs proposal generation for that Task. Checkpoint creation itself remains successful even if reconciliation fails.

The order is:

1. Commit the immutable Checkpoint.
2. Read the current Task and latest Checkpoint from each Workstream.
3. Generate or reuse the idempotent proposal.
4. Apply only an all-safe additive proposal in a separate immediate transaction.
5. Record an audit event for generation and, separately, application/failure.

`POST /v1/events` returns the Checkpoint result plus a compact reconciliation result. A reconciliation error is visible and retryable; it must not turn an accepted Event into a failed capture.

## 10. API surface

Add least-privilege scopes:

- `task:reconcile:read` for status and proposal preview;
- `task:reconcile:confirm` for apply/reject decisions.

Do not grant `admin:tasks` to normal Adapters.

Endpoints:

```text
GET  /v1/tasks/{task_id}/reconciliation
POST /v1/tasks/{task_id}/reconciliation/run
POST /v1/task-reconciliations/{proposal_id}/resolve
GET  /v1/tasks/{task_id}/canonical-revisions
```

`run` is idempotent and may also be invoked internally after Checkpoint creation. `resolve` requires:

```json
{
  "proposal_version": 1,
  "base_canonical_version": 7,
  "decision": "confirm"
}
```

Allowed decisions are `confirm` and `reject`. The response returns the existing result on an exact replay and returns `409` for a changed version, stale base, different decision, wrong Task ownership, or already superseded proposal.

## 11. Resume and status integration

### 11.1 Status

`GET /v1/status` adds:

```json
{
  "canonical_reconciliation": {
    "schema_version": "canonical-task-reconciliation-v0.1",
    "pending": 0,
    "conflicts": 0,
    "auto_applied": 0,
    "stale": 0,
    "oldest_pending_at": null
  }
}
```

### 11.2 Resume Preview

Resume Preview includes:

- `canonical_version`;
- `canonical_freshness`: `fresh`, `updates_pending`, or `conflict_pending`;
- the IDs and compact summaries of pending proposals;
- the latest applied canonical revision;
- source-preserved unresolved conflicts.

An unresolved proposal does not block creation of a Resume Preview. The preview must visibly distinguish canonical state from newer unapplied Checkpoint evidence. It must not merge the two into a single unlabeled claim.

Confirming a Resume confirms only that Resume. It does not implicitly confirm a reconciliation proposal.

### 11.3 User flow

The intended interaction is:

```text
/Mnemuron status
  -> "Canonical is current" or "3 updates proposed, 1 needs review"

/Mnemuron reconcile task-mnemuron-production-readiness-v01
  -> show exact before/after operations and sources

/Mnemuron reconcile confirm <proposal_id> <proposal_version> <base_version>
  -> apply exactly the displayed proposal
```

Natural-language equivalents may call the same tools, but material confirmation must remain a separate turn.

## 12. Example acceptance case

Use a disposable Task with synthetic Checkpoints describing completed work, a stale blocker, and a changed next step. The dry-run must:

- propose source-backed progress additions;
- keep removal of the blocker and replacement of the next step pending exact confirmation;
- distinguish canonical snapshot fields from independently derived evidence;
- preserve every original Checkpoint and Workstream identity;
- apply the reviewed operations once and return the same revision on exact replay.

The dry-run output must clearly separate automatically eligible additions from review-required changes.

## 13. Acceptance tests

### 13.1 Local engine

1. An unchanged Checkpoint produces `no_effect`.
2. Reprocessing the same Checkpoint returns the same proposal and creates no duplicate revision.
3. A safe new progress result applies once and increments `canonical_version` once.
4. Canonical snapshot items inside a Checkpoint never generate operations.
5. A low-confidence Checkpoint produces a proposal but no automatic Task mutation.
6. Removing a blocker, replacing a next step, or changing status always waits for confirmation.
7. Exact confirmation commits all operations and one revision atomically.
8. Confirmation replay returns the existing revision without another version increment.
9. A changed proposal version, base version, decision, or owner returns `409`.
10. Two non-conflicting Workstream additions are retained with independent provenance.
11. Two conflicting controlled-field operations remain visible and unapplied.
12. A stale Checkpoint cannot roll back a newer canonical revision.
13. Rejection preserves the proposal and source evidence.
14. Reconciliation failure does not roll back an accepted Event or immutable Checkpoint.

### 13.2 Resume regression

15. Resolver selection continues to use the current canonical Task projection.
16. Resume Preview displays the exact canonical version plus pending evidence state.
17. Resume confirmation does not apply a reconciliation proposal.
18. Preview -> Confirm -> next-turn delivery -> terminal ACK remains unchanged.
19. Persistent Task Scope and destination Workstream provenance remain unchanged.

### 13.3 Isolated migration

20. An old database adds the two tables and `canonical_version` without altering existing business-row counts or JSON values.
21. Reopening and rerunning migration is idempotent.
22. SQLite integrity and quick checks pass.
23. Existing Tasks start at version 1, and the first real revision moves one Task to version 2 only.

## 14. Validation sequence

1. Validate migration, proposal/revision storage, deterministic policy, and local tests.
2. Repeat migration and regression against a private disposable database copy.
3. Produce and review a dry-run proposal using synthetic Task evidence.
4. Verify the exact candidate and recovery plan before deployment to an explicitly configured target.
5. Complete real reconciliation acceptance on every Adapter included in the release scope.
6. Generate a new Resume Preview and verify that participating devices see the same updated Canonical Task while retaining their destination Workstreams.

## 15. Out of scope

- Automatic semantic resolution of arbitrary free-form contradictions.
- Cross-Task merge, Task deletion, or Task identity changes.
- Rewriting or compacting historical Checkpoints.
- Using Resume confirmation as Task-change confirmation.
- A UI dashboard beyond compact status and Preview output.
- Backup/restore expansion, 120-minute partition testing, long-duration soak, and Hermes-specific acceptance.
- Setting `production_ready=true`.

## 16. Exit criteria for v0.1

Canonical Task Reconciliation v0.1 is complete only when:

- every canonical change is versioned, attributable, and reproducible from immutable evidence;
- safe additive progress can advance automatically without duplicate application;
- removals, replacements, status changes, and conflicts require exact user confirmation;
- concurrent Workstreams cannot silently overwrite one another;
- a representative Task is reconciled through the new path;
- Device A, Device B, and OpenClaw observe the same canonical version in new Resume Previews;
- existing Resume Delivery Receipt and Task Scope regressions pass unchanged;
- `production_ready` remains `false` until the remaining release gates and final explicit promotion are complete.

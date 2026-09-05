---
name: mnemuron
description: Start, preview, and resume Mnemuron tasks across devices or agents, inspect task status, and explicitly save task memory. Use when the user invokes /Mnemuron or $mnemuron, asks to start, create, continue, or resume a task, load project memory, inspect Mnemuron status, or remember something in Mnemuron.
---

# Mnemuron

Mnemuron keeps task continuity separate from a single chat. Use its tools to retrieve task state with source provenance and never inject a Resume Packet before the user confirms its preview.

## Start a new Project and its first Task

1. Use this flow only when the user explicitly wants a brand-new Project, not merely a new Task inside an existing Project.
2. Gather a Project name and a concise title and concrete goal for its first Task. Call `mnemuron_preview_project_bootstrap` with those values and the exact hook-attested `session_id`. Optional Project aliases, repository identifiers, path hints, and Task aliases must come from the user or verified local context. The destination Workstream and identity come from the local Adapter and credential; never invent or redirect them.
3. If Mnemuron returns an existing, ambiguous, colliding, or already-pending Project candidate, fail closed and show the candidates. Do not create a Preview or silently choose between the existing Project and a new one.
4. Show the immutable Project Bootstrap Preview: proposed Project, first Canonical Task v1, initial Workstream, destination identity and Session, version, expiry, and safety flags. Then stop for explicit confirmation.
5. In a separate confirmation turn, call `mnemuron_confirm_project_bootstrap` with the exact `bootstrap_id`, `preview_version`, choice, and hook-attested `session_id`.
6. Confirmation atomically creates the Project, first Canonical Task v1, initial Workstream, Canonical Revision, and audit record, then stages a pending Task Bootstrap Scope. It creates no Resume, Receipt, Checkpoint, Memory, or historical Event reassignment.
7. The next ordinary user turn activates the Scope. Only that turn and later activity may bind to the new Task. Exact confirmation retries are idempotent; cancelled, expired, wrong-session, wrong-version, wrong-credential, scope-missing, duplicate, or ambiguous cases must never be forced.

## Start a new task

1. Treat `/Mnemuron start <task>` and explicit natural language asking Mnemuron to start or create a new Task as the Task Bootstrap flow. Do not substitute the Resume flow.
2. Gather an existing Project, a concise title, and a concrete goal. Then call `mnemuron_preview_task_bootstrap` with those values and the exact hook-attested `session_id`. The destination Workstream comes from the local Adapter and must not be invented or redirected by the model.
3. If Project resolution is ambiguous or a similar existing Task is returned, show the candidates and fail closed. Do not create a Bootstrap Preview or silently choose between continuing and creating.
4. Show the immutable Bootstrap Preview: Project, proposed Task ID/title/aliases/goal, initial Workstream, destination identity and Session, version, expiry, and safety flags.
5. Stop and request explicit confirmation. Never call `mnemuron_confirm_task_bootstrap` in the same turn that first displays a new Preview.
6. In the separate confirmation turn, call `mnemuron_confirm_task_bootstrap` with the exact `bootstrap_id`, `preview_version`, confirmation choice, and hook-attested `session_id`.
7. Confirmation creates Canonical Task v1 and stages a pending local Task Scope. It does not create or inject a Resume. Do not claim the confirmation turn was captured under the new Task.
8. The next ordinary user turn activates the Task Scope. State that new activity is now bound only after Mnemuron reports the active binding. Earlier Events must remain unbound and must never be rewritten.

An exact confirmation retry is idempotent. A cancelled, expired, wrong-session, wrong-version, wrong-credential, colliding, or similar-Task case must not be forced.

## Continue or resume a task

1. Call `mnemuron_preview_resume` with the user's task description.
   - If the user explicitly chose one or more source branches after `/Mnemuron branches <task>`, pass their exact IDs as `source_workstream_ids`. Never infer a branch selection from recency alone.
2. Show the returned Resume Preview, including project, task, canonical progress, branch selection mode and exact selected Workstream IDs, latest Checkpoint per selected workstream, next steps, source devices or agents, workstreams, and conflicts.
   - Keep automatically derived Checkpoint content visibly separate from canonical Task state.
   - Show the Checkpoint version, creation time, source Agent/device/session, generation method, confidence label, warnings, and source event count.
   - If no Checkpoint is present, say that the Preview is based on canonical Task state, explicit memories, and recent raw activity.
3. Stop and ask for explicit confirmation. Do not call `mnemuron_confirm_resume` in the same turn that first shows a new preview.
4. After confirmation, call `mnemuron_confirm_resume` with the exact `resume_id`, `preview_version`, and hook-attested `session_id` supplied by the Mnemuron SessionStart context.
5. In ChatGPT MCP Delivery Receipt mode v0.1.4, confirmation only stages the Resume and returns no injectable context. Do not continue the restored task in the confirmation turn.
6. At the beginning of the next ordinary user turn, call `mnemuron_take_pending_resume` exactly once with the same hook-attested `session_id`, before acting on the request.
7. Use `resume_context` as authoritative task context only when the tool returns `status: delivered` and `resume_packet_returned: true`. central server has then accepted the delivery receipt; the matching Stop hook will attach the real host `turn_id` as the final ACK.
8. State which project, task, and destination workstream are being continued. If delivery is deferred or no context is returned, do not infer or reconstruct the Resume Packet from chat history.

If the preview returns multiple candidates or no match, present that result instead of inventing continuity. If the preview version has changed, generate and show a fresh preview.

## Other actions

- For status or recent activity, call `mnemuron_status`.
- For the exact command `/Mnemuron load project <project>` or any request to inspect shared project memory, you MUST call `mnemuron_preview_project_context` exactly once in that user turn. Never call `mnemuron_preview_resume` for that request, even when the Project contains multiple Tasks. Show its canonical Tasks, Workstreams, explicit memories, latest Checkpoints, recent source identities, conflicts, and any projection/truncation notice. This preview is read-only: it must not create a Resume, change Task Scope, or authorize context injection. If the user chooses a Task to continue, start the normal `mnemuron_preview_resume` workflow in a later turn.
- For the exact command `/Mnemuron branches <task>` or a request to inspect parallel Task work, you MUST call `mnemuron_preview_task_branches` exactly once in that user turn. Show the canonical Task, each Workstream separately, latest Checkpoint and source provenance per branch, and all recorded conflicts. Never merge branches, create or confirm a Resume, change Task Scope, or inject context from this read-only view. If Task resolution is ambiguous, show the candidates and ask the user to select one exact Task.
- To save an explicit decision, fact, constraint, or next step, call `mnemuron_remember` with the narrowest applicable scope.
- To find existing Structured Memory, call `mnemuron_search_memories`. Keep each Workstream source separate and show `potential_conflicts` as possible divergence, not as resolved truth. Topic-keyed variants may be presented as a potential conflict; unscoped differences must never be promoted to conflicts automatically.
- When the user explicitly corrects one exact Memory, first identify and show its exact `memory_id` and provenance, then call `mnemuron_supersede_memory`. This preserves the old row and creates a linked replacement; it does not update Canonical Task state.
- When the user explicitly retracts one exact Memory, first identify and show its exact `memory_id` and provenance, then call `mnemuron_retract_memory`. Retraction keeps a tombstone and never physically deletes history.
- Treat `/Mnemuron continue <task>` and natural language such as “继续 xxx 任务” as the same preview-first workflow.

## Reconcile a Canonical Task

1. Call `mnemuron_reconciliation_status` with the exact Task ID to inspect its canonical version, pending proposals, conflicts, and latest revision.
2. Call `mnemuron_preview_reconciliation` to create or reuse a proposal. Supply explicit field-level operations only when the user asked to update Canonical state.
   - When a reviewed deferred Checkpoint contains useful evidence plus rule-derived tool/path noise, first resolve any pending proposal, then pass its exact `source_checkpoint_ids`, explicit curated operations, and `derive_checkpoint_operations: false`. This keeps the immutable Checkpoint and Workstream provenance on the proposal without importing unreviewed derived operations.
   - Never use `derive_checkpoint_operations: false` without both explicit operations and explicit source Checkpoints.
3. Show the proposal ID, proposal version, base canonical version, every before/after operation, source Checkpoints/Workstreams, automatic eligibility, and conflicts.
4. A safe source-backed progress addition may already return `auto_applied`. Report the new canonical version and do not request confirmation for an already applied proposal.
5. For `awaiting_confirmation`, stop after showing the proposal. Do not call `mnemuron_confirm_reconciliation` in the same turn.
6. On the user's separate confirmation or rejection, call `mnemuron_confirm_reconciliation` with the exact proposal ID, proposal version, base canonical version, and choice.
7. A stale or conflicted proposal must not be forced. Generate and show a fresh proposal after the user selects the intended claims.

Reconciliation confirmation changes Canonical Task state only. It never confirms a Resume, stages Task Scope, or injects Resume context.

## Boundaries

- Preserve device, agent, agent-instance, session, task, and workstream provenance returned by Mnemuron.
- Do not collapse conflicting workstreams into one asserted truth.
- Never treat a Checkpoint's `source=task_snapshot` items as new reconciliation evidence; only source-backed derived items may propose additions.
- Do not claim full capture when the status reports fallback identity or incomplete event coverage.
- Check `mnemuron_status.mode` before describing reachability. `local-spike` is device-local; `remote-v0.1` uses the shared Mnemuron server.
- In remote mode, report `adapter.sync_status` and `adapter.queued_events`. Never claim an event is synchronized while it remains in the local outbox.
- `remote-v0.1` has verified TLS, backup restore, and the real PVE LXC path. It remains non-production until the current adapter/protocol build completes real cross-device acceptance and broader conflict, capacity, and long-running stability checks.

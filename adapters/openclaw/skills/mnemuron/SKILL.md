---
name: mnemuron
description: Preview and resume Mnemuron tasks across agents, inspect shared status, and explicitly save task memory from OpenClaw.
---

# Mnemuron for OpenClaw

Use Mnemuron when the user asks to continue work from another Agent or device, invokes `/mnemuron`, asks for Mnemuron status, or explicitly wants information saved to shared memory.

## Resume workflow

1. Call `mnemuron_preview_resume` with the task description.
   - If the user explicitly selected one or more source branches, pass their exact IDs as `source_workstream_ids`. Never infer a branch selection from recency alone.
2. Show the project, task, canonical state, branch selection mode and exact selected Workstream IDs, latest Checkpoint per selected Workstream, source Agent/device/session, generation method, confidence, warnings, and source event count.
3. Stop for explicit user confirmation. Never call `mnemuron_confirm_resume` in the same turn that first displays a new Preview.
4. After confirmation, call `mnemuron_confirm_resume` with the exact `resume_id` and `preview_version`.
5. Continue using the returned Resume Packet and state which Task and Workstream are active.

Keep derived Checkpoint content separate from canonical Task state. Preserve conflicts and provenance instead of selecting one branch as truth. If no match or multiple candidates are returned, show that result and do not invent continuity.

## Other tools

- Use `mnemuron_status` for reachability, verified identity, counts, synchronization, and outbox state.
- Use `mnemuron_preview_project_context` exactly once per user turn for `/mnemuron load project <project>` or a request to inspect shared project memory. It is read-only and must not create a Resume, change Task Scope, or inject context. Show any projection/truncation notice. After displaying Tasks and sources, use the normal Resume workflow only if the user chooses a Task to continue.
- Use `mnemuron_preview_task_branches` exactly once per user turn for `/mnemuron branches <task>`. Show each Workstream and its latest Checkpoint/source separately, preserving every recorded conflict. Never merge, create a Resume, change Task Scope, or inject context from this view.
- Use `mnemuron_remember` only for explicit facts, decisions, constraints, or next steps, with the narrowest valid scope.
- Use `mnemuron_search_memories` for bounded Structured Memory lookup. Preserve Workstream provenance and present topic-keyed `potential_conflicts` without merging or resolving them automatically.
- Use `mnemuron_supersede_memory` only after the user explicitly corrects one exact Memory ID. Use `mnemuron_retract_memory` only after the user explicitly retracts one exact Memory ID. Both retain history and never update Canonical Task state.
- Treat natural language such as “继续 xxx” and `/mnemuron continue xxx` as the same Preview-first workflow.

Never claim synchronization while `adapter.queued_events` is nonzero. `remote-v0.1` remains non-production while resolver quality, injection ACK, conflict handling, capacity policy, and all target Agent adapters are incomplete.

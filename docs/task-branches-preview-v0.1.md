# Mnemuron Task Branches Preview v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Goal

Implement the manual core command `/Mnemuron branches <task>` so a user can inspect parallel Agent/device Workstreams and recorded conflicts before deciding whether to resume or reconcile a Task.

## Contract

`POST /v1/task-branches/preview` and `mnemuron_preview_task_branches` return:

- an exact or versioned Combination Resolver result for one Task;
- the canonical Task ID, status, version, freshness, and update time;
- every canonical or observed Workstream as a separate branch;
- the latest Checkpoint, recent Sessions, activity timestamp, and Agent/device provenance per branch;
- canonical conflicts with both sides and their source metadata preserved;
- reconciliation pending/conflict counts without creating a Proposal;
- a safe next action that keeps Resume Preview and Reconciliation as separate later operations.

## Safety boundary

- Read-only: no Resume, Resolver selection, Task Scope, injection, canonical mutation, merge, or Reconciliation Proposal is created.
- Ambiguous Task resolution returns candidates and never guesses a branch.
- Workstreams remain separate even if their status or next steps differ.
- Recorded conflicts are displayed, not automatically resolved.
- Raw payloads are never included.
- The serialized response is bounded to 128 KiB, with projection/truncation metadata.
- Clients call the read tool exactly once per user turn.
- Adapter coverage is validated separately, and `production_ready=false`.

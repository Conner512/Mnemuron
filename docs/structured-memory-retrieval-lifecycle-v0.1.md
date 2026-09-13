# Structured Memory Retrieval and Lifecycle v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Status

This document defines the feature contract and required acceptance checks. Deployment-specific results are not published.

## Purpose

Automatic Structured Memory v0.1 creates conservative, source-backed facts. This phase makes those records usable over time without erasing their history:

- bounded deterministic retrieval instead of returning every recent Memory;
- explicit topic metadata for conservative cross-Workstream divergence presentation;
- explicit user correction through a linked supersession chain;
- explicit user retraction through a retained tombstone;
- no automatic merge, conflict resolution, physical deletion, or Canonical Task update.

## Retrieval contract

`POST /v1/memories/query` accepts a required text query plus optional Project, Task, source Workstream, Session, type, lifecycle-status, shared-scope, and result-limit filters.

The server reads at most 500 recent candidates and returns at most 20 results. Ranking is deterministic and reports its components:

1. lexical match, including normalized text and bounded Chinese-character/bigram overlap;
2. stored confidence;
3. scope specificity;
4. recency over a one-year horizon.

The response is capped at the existing 128 KiB read-preview boundary. It is read-only with respect to Resume, Task Scope, injected context, Canonical Task, and Memory lifecycle. A `memory.query` audit event is retained.

## Topic and conflict boundary

Explicit saves may provide `topic`. Automatic labelled statements may use `类型[主题]：内容`, for example `决定[存储后端]：使用 SQLite。`.

Only active Memories with the same normalized topic and type, different normalized contents, and at least two distinct Workstreams are presented as `potential_conflict`. Each variant retains its exact Memory, Event, Checkpoint, Workstream, and Agent provenance.

Different unscoped statements are never classified as conflicts. Potential conflicts are never merged or resolved automatically. Existing Canonical Task conflicts remain a separate list.

## Lifecycle contract

`POST /v1/memories/{memory_id}/supersede` requires an exact Memory ID and replacement content. It:

- keeps the original row as `superseded`;
- creates one active `explicit_correction` replacement in the same scope;
- links both rows with `supersedes_memory_id` and `superseded_by_memory_id`;
- records reason and acting credential identity;
- is idempotent for an exact retry and rejects a different second replacement.

`POST /v1/memories/{memory_id}/retract` marks an active row `retracted`, records reason, time, and actor, and preserves the row. `DELETE /v1/memories/{memory_id}` maps to the same tombstone behavior rather than physical deletion.

Neither operation changes Canonical Task state. Superseded and retracted rows are excluded from default retrieval and previews but remain queryable when their statuses are explicitly requested.

## Schema migration

The existing `memories` table gains seven additive nullable/defaulted columns:

- `topic`, `topic_key`;
- `supersedes_memory_id`, `superseded_by_memory_id`;
- `lifecycle_reason`, `retracted_at`, `lifecycle_actor_json`.

Two supporting indexes are additive. Existing 24-column rows are not removed or rewritten.

## Acceptance gates

1. Exact and Chinese topic queries return bounded, ranked results.
2. Workstream filters preserve shared-scope semantics and never merge sources.
3. Only topic-keyed cross-Workstream variants become potential conflicts.
4. Retrieval does not create Resume, switch Task Scope, inject context, or update Canonical Task or Memory lifecycle.
5. Correction retains the original row and creates one linked replacement with acting identity.
6. Exact correction retry is idempotent; a different second replacement fails closed.
7. Retraction retains a tombstone and exact retry is idempotent.
8. Default retrieval excludes non-active rows; explicit lifecycle queries can retrieve them.
9. Existing rows migrate additively with an identical original-column digest.
10. ChatGPT and OpenClaw expose search, supersede, and retract tools; Hermes remains unchanged in this phase.
11. Full Node and Hermes regressions remain green.

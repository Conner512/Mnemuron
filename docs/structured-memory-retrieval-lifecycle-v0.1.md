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

Body, topic and concept keywords use the same token boundaries and relevance checks. Hybrid and semantic candidates preserve explicitly recognized project/task subjects, including accepted aliases and validated entity associations; a high vector score alone does not waive those subject constraints.

Console kind, topic, concept, origin and cleanup-review filters apply before candidate limits and are checked again after vector requests. Current SQLite traits produce a bounded vector document allowlist, rather than relying on copied traits in vector payloads. If more than 2000 active documents satisfy that filter, hybrid explicitly falls back to filtered lexical retrieval with `VECTOR_FILTER_TOO_BROAD`; semantic returns 503 with that degradation code. The allowlist is never silently truncated. A ranked result window that omits further matches reports `truncated` and its retrieval diagnostics.

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

## Similarity hints after saving

Save-time similarity probes send a bounded document to the vector query path without applying the public lexical search's 64-term limit. They retain the same read authorization, current visibility, lifecycle, embedding egress permission and request budgets. Ordinary search requests keep the term limit; no JSON field enables the internal document probe.

Hint thresholds use a cosine-comparable score: Cosine and normalized Dot use their similarity directly, while normalized Euclid converts distance with `1 - distance² / 2`. Unnormalized Dot/Euclid have no universal conversion and fall back to the exact-token check instead of receiving unsupported duplicate labels.

A successful save has already committed its new Memory. `similar_memories` is an advisory list of existing records, not a preflight decision, an authorization to merge, or an automatic deduplication result. Search before saving; an explicit correction should call supersede on the existing record without first creating a separate save.

If a later hint reveals a redundant save, preserve both records until the current user explicitly requests cleanup. Retract the **newly saved Memory ID returned by the save**, not the existing ID in the hint. This leaves the original active and retains the redundant save as a tombstone. Do not supersede the existing record merely because of a duplicate hint: supersede creates a third record and leaves the separate save active. Similar wording alone does not prove redundancy; preserve new information and report cleanup failures.

Cloud cleanup also requires reading the current revision and an explicit current write grant. A private save receipt or account-wide read access is not such a grant. If the adapter cannot read or retract the saved record, leave it intact and explain that cleanup needs an authorized owner action. See [cloud memory writes](cloud-memory-phase-a.md).

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

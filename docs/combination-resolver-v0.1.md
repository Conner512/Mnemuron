# Mnemuron Combination Resolver v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Scope

Combination Resolver v0.1 replaces the original project-name/title substring heuristic with a versioned, explainable Project and Task resolution flow.

The implementation adds:

- persistent Project identity metadata: aliases, Git remotes, repository fingerprints, and path hints;
- append-only confirmed Resolver selections with credential, Resume, version, query, signals, candidate snapshot, Project, Task, and timestamp provenance;
- `POST /v1/projects/resolve` and `POST /v1/tasks/resolve`;
- structured Resolver signals on `POST /v1/resume/preview` while preserving the existing `{ "query": "..." }` request;
- per-candidate score and reason output;
- explicit `resolved`, `ambiguous`, and `no_match` outcomes;
- source-preserving conflict presentation without automatic merge;
- a local-safe ChatGPT fallback that refuses ambiguous project-only or wrong-ID requests.

## Safety rules

- An exact Task ID is authoritative. An explicit but unknown Task or Project ID returns `no_match` and never falls back to a fuzzy Project-name match.
- Project path is a weak signal and can never resolve a Project by itself.
- Git remote and repository fingerprint are strong Project signals.
- Project identity scopes Task candidates but does not choose among multiple Tasks in that Project.
- Title, alias, task content, workstream, recent activity, current Agent/device history, and prior confirmed selections can be combined.
- Agent/device identity alone is insufficient to select a Task.
- A single candidate must meet the confidence threshold and the lead over the second candidate must meet the margin threshold.
- `ambiguous` and `no_match` create no Resume row, no confirmation, and no injection or Delivery Receipt state.
- Conflicting claims are returned with their original sources. The Resolver neither rewrites nor automatically chooses a claim.
- Repeating confirmation for the same Resume ID and Preview version is idempotent; the append-only Resolver selection is stored once.

## Persistence and migration

The SQLite migration is additive:

- `projects` stores stable Project identity signals;
- `resolver_selections` stores confirmed user choices and the candidate snapshot visible at confirmation time;
- existing Tasks are used to backfill a minimal Project row on first open;
- Task upsert creates a missing Project row but does not erase existing Project aliases, remotes, fingerprints, or path hints.

No existing Event, Memory, Checkpoint, Resume, injection, Delivery Receipt, credential, or audit table is rewritten.

## Conflict boundary

v0.1 preserves and presents explicit structured conflicts already attached to the canonical Task. It does not infer semantic conflicts from free-form prose because current Checkpoints do not provide stable `fact_key` and `fact_value` fields. Automatic conflict inference belongs to the later Canonical reconciliation phase and must not be simulated with untraceable text guesses.

## Concurrent Resume semantics

The existing destination Adapter state machine remains authoritative:

- different Sessions may hold independent active Task Scopes;
- a newer Resume supersedes only an active binding in the same conversation scope;
- retrying the same Resume ID/version in the same Session returns the existing binding;
- attempting to bind that same Resume ID/version to another Session returns an explicit conflict;
- changing Preview version still requires a fresh Preview.

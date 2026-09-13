# Read correctness and event recovery

This is a source-level contract, not a production deployment report. Public Web
access remains read-only; no tools, scopes or handoff actions are added.

The project/Task sections below describe local/Core contracts. The current Web
gateway only lists approved memories for an exact project filter; it does not
resolve project names or expose canonical Task information. See the
[Web memory read contract](../chatgpt-web-oauth-v0.1/web-memory-review.md).

## Exact project selection

`mnemuron_preview_project_context` accepts `project_id`, `query`, or both. At least
one is required. An explicit ID is an exact selector within the authenticated
owner's projects, even when the query names another project. Unknown or foreign
IDs return `no_match`; they never fall back to the query's project.

The Core `/v1/project-context/preview` route also preserves its legacy
`signals.project_id` input. If both locations are provided they must agree, or
the request fails with `CONFLICTING_PROJECT_ID`. Other Resume/resolver endpoints
retain their existing input and confirmation contracts. Query-only project
selection retains the original confidence and ambiguity thresholds.

Providing an ID without a query is sufficient. The optional query does not
reselect the project and does not introduce new in-project filtering semantics.
The MCP input schema permits ID-only requests; a saved client tool catalog may
need its normal refresh to discover this schema change.

For the distinction between shared user memory, explicit project association,
registered aliases and canonical Task state, see
[Project memory acceptance](PROJECT-MEMORY-ACCEPTANCE.md). A searchable marker is
not automatically a Project ID; a user-memory read and a project preview are
separate acceptance checks.

## Summary omissions and Task detail reads

Task `field_availability` distinguishes a known empty canonical field from one
that is recorded but truncated or omitted. These flags preserve the original
counts through Core and Web summary projections. Unknown fields from older
responses remain unknown; a summary's missing goal or next step is not proof
that it was never recorded.

The existing project preview tool also accepts exact `project_id`, `task_id` and
`task_field` inputs for bounded read-only canonical details. Follow its
`next_request` while retaining `canonical_version`; a changed version fails
instead of silently mixing pages. This adds no MCP tool, OAuth scope or handoff
operation. See the [Task detail contract](TASK-DETAIL-READ.md) for supported fields,
pagination, size limits, error behavior and separate live-client acceptance.

## Colon-delimited identifiers

`memory-search-v3` preserves complete existing engineering tokens and also indexes
the parts on either side of ASCII/fullwidth colons. For example, the synthetic
text `CASE-20400101-01：Memory check` is found by the bare marker. Version dots,
hyphens, slashes and compound tokens are not removed or used to merge memories.

Existing v1/v2 FTS projections rebuild at Store initialization. Only the derived
search projection changes: Memory text, source records, revisions, lifecycle and
document IDs remain intact. This is a synchronous startup rebuild, not a
zero-downtime migration. Back up and authorize a production switch separately;
never run competing old/new Store writers against the same database.

## Explicit event-outbox reconciliation

Ordinary hooks still retain and block events after `RECEIPT_MISMATCH`. Restarting
or rediscovering the queue does not silently clear that block. Once the server
contract has been repaired, an authorized maintenance caller can use
`reconcileEventOutbox(eventIds, env)` from the ChatGPT plugin's `remote-client.mjs`
with at most 100 exact event IDs and its existing private runtime config.

Before maintenance, back up the original envelopes and sidecars outside source.
The operation retries only selected blocked event envelopes whose original hash,
credential/endpoint fingerprint and lane marker still match. Older pending
predecessors cannot be skipped. It never retries Resume Injection or Delivery
Receipt records, relaxes their ownership checks, or fabricates Hook/ACK events.

Each reconciliation attempt preserves its prior state and envelope hash under
the private `sync-reconciliation/` directory, without body text or plaintext
credentials. Removing a queued original still requires the normal exact
`accepted_event_ids` and integer acceptance counts from the server. Incorrect
responses remain blocked. Changed envelope bytes remain blocked on repeated
maintenance attempts; the original expected hash is not replaced.

After successful reconciliation, normal bounded flushing can resume. Nonzero
remaining queues must still be reported as pending, including later independent
protocol failures. Keep backups until recovery has been separately reviewed.

## Regression coverage

The repository's `node scripts/test-all.mjs` runner removes inherited proxy and
private-runtime overrides and exercises synthetic databases and loopback services.
Focused coverage includes Core/Web exact-ID precedence, ID-only discovery,
foreign/unknown/conflicting IDs, colon search plus full reads, old-index upgrades,
source/version preservation, immutable event retries and rejected bypasses. Task
detail checks add both-stage summary metadata, Unicode/JSON reconstruction,
version-pinned pagination, foreign ownership refusal and business-table immutability.

No real model, production personal memory read, new OAuth scope, deployment or
Git publication is part of these tests. `production_ready` remains false.

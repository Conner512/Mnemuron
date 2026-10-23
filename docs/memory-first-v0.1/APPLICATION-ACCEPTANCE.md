# Isolated application and read-only Web acceptance

This opt-in harness checks the application boundary after private Qdrant
acceptance. It starts temporary loopback Core, OAuth and MCP gateway processes,
uses a new synthetic SQLite database, and creates a random owned Qdrant
collection. It does not attach the production application to Qdrant.

Use Node 24 and the existing locked OAuth/Web dependencies. No new dependencies
are required. Do not run this against a production database or use a live OAuth
account. The only operator-supplied configuration is the strict Qdrant object
described in [VECTOR-ACCEPTANCE.md](VECTOR-ACCEPTANCE.md).

## Run

Provision and authorize the private backend separately. Place its configuration
and credential outside every Git worktree; configuration and credentials must be
owner-readable only. Create an owner-only evidence directory outside the source
tree. The target must be the literal loopback address with an exact allowlist.

```sh
node adapters/chatgpt-web/acceptance/run-memory-vector.mjs \
  --config /private/runtime/vector-acceptance.json \
  --output /private/evidence/application-acceptance \
  --allow-network true
```

The harness validates network opt-in and storage boundaries before reading the
configuration. It accepts no database, account, model endpoint or source-data
arguments. It does not modify service units, public ingress, DNS, existing
runtime configuration, or handoff state. Retain the generated `preflight.json`
and `result.json`; a nonzero exit or any failed/not-run case is not acceptance.

## What is verified

- Explicit HTTP saves and retries work without a Task; ordinary lexical reads
  and saves do not call an embedding provider.
- Runtime configuration loads through the application path, followed by explicit
  indexing of the synthetic library and idempotent catch-up.
- Lexical, hybrid and semantic HTTP reads preserve owner/project/session
  boundaries and exact version identifiers.
- An isolated OAuth login, consent, code exchange and introspection expose the
  existing four read-only MCP tools. A search-returned ID is used to read back
  the exact Unicode source over multiple pages.
- Foreign IDs, owner override arguments, write tools and write requests made
  with the gateway's minimal Core credential are rejected.
- Read-only operations leave memory, source, processing and handoff records
  unchanged. Query budget bookkeeping is expected and counted separately.
- Retracted sources disappear before stale vector points are cleaned up;
  explicit historical reads preserve their status and source.
- A controlled 503 at the owned loopback relay makes hybrid search return a
  clearly marked lexical fallback. Semantic-only failure remains a safe
  `SEMANTIC_UNAVAILABLE` HTTP 503 through the Web gateway. The Qdrant service
  itself is not stopped. Restarting only the isolated Core preserves its index.
- Logs contain neither source bodies nor credentials; no Task, Event,
  Checkpoint, Resume or Receipt is generated.

Temporary processes, fixture OAuth accounts, relay/model keys and this run's
owned Qdrant collection are cleaned up, including after a failed case. Generated
synthetic SQLite evidence remains in the private run directory. Cleanup errors
fail the run; unrelated collection names must be unchanged. No collection
contents outside the owned run are read.

## Evidence limits

The embedding endpoint is a bounded deterministic loopback HTTP fixture using
768-dimensional vectors, **not a real model**. Its inputs are limited to the
fixed synthetic corpus and queries. It cannot establish natural-language
semantic quality, classifier quality, model latency or external-provider
reliability. The OAuth protocol is real implementation code with synthetic
credentials, not a real ChatGPT Web browser session.

The default test suite runs the same application harness with an authenticated
in-memory Qdrant REST fixture. An explicit operator run is required for real
Qdrant evidence. Neither result enables production retrieval, broadens Web
scopes, enables handoff, nor sets `production_ready=true`.

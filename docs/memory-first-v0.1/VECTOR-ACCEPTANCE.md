# Opt-in real Qdrant acceptance

This is an isolated backend correctness test, **not a deployment command** or a
real-model quality benchmark. The ordinary test suite never starts Docker, pulls
images, connects to Qdrant or calls an external model.

## Prerequisites and boundaries

- An explicitly approved disposable Qdrant `1.19.0` instance, authenticated with a
  private API key and published on `127.0.0.1` only. Do not use production storage,
  credentials, a shared collection prefix or a public tunnel.
- A pinned loopback port that remains unchanged through a controlled restart.
  An automatically allocated Docker port may change when its container restarts.
- A private, existing evidence directory outside every Git worktree; private
  vector configuration and key files outside source. Use directory mode `0700`
  and file mode `0600`.
- Node 24 or newer. No model configuration, additional JavaScript dependency,
  background worker or production database is needed.

The config contains **only** the `vector_store` object described in
[OPERATIONS.md](OPERATIONS.md#vector-projection), not an entire runtime config.
The harness additionally rejects any target other than literal `127.0.0.1`, any
extra resolved address/origin, or unknown config fields. It requires an explicit
network flag before loading config. Authenticated requests follow the fixed
[Qdrant query](https://api.qdrant.tech/api-reference/search/query-points) and
[upsert](https://api.qdrant.tech/api-reference/points/upsert-points) contracts.

```bash
npm run test:memory-vector-real -- \
  --config "$PRIVATE_VECTOR_CONFIG" \
  --output "$PRIVATE_EVIDENCE_DIRECTORY" \
  --allow-network true
```

This creates a **new synthetic SQLite database** and random, isolated collection
names. It does not load configured memories, change an existing read generation,
or remove unrelated collections. Retained evidence includes the frozen case list,
thresholds, environment, synthetic database and per-case outcomes. Failed runs
are retained independently from later successful runs. Error reports contain
bounded codes rather than credentials, remote error bodies or private memory text.

## Coverage

| Group | Required checks |
| --- | --- |
| Protocol/authentication | Version, missing/wrong key rejection, fixed dimensions, real upsert/query/filter/delete, multi-page scroll |
| Privacy/isolation | No source text in point payloads; owner, project and session prefilters; authoritative SQL hydration backstop |
| Retrieval | Hybrid exact match, identifier prefix boundaries, complete source detail and chunk-to-atom deduplication |
| Durability | Committed upsert with lost response, idempotent retry, SQLite reopen without reinsertion |
| Lifecycle | Retraction and secret-label invalidation, late points, orphan deletion across scroll pages, repeat cleanup |
| Generations | Same-dimensional profile separation, catchup before activation, request-pinned generation, stale-worker fencing |
| Fault boundary | Backend stop, continued SQLite save/lexical search, explicit hybrid degradation, semantic-only rejection, backend restart and outbox recovery |
| Handoff | No Task, Resume or delivery receipt created |

The embedding function is a deterministic 768-dimensional synthetic fixture. It
deliberately ranks a near-version document above an exact version at the vector
layer, to test the application's exact-identifier protection. **This is not a
Gemini/model embedding test and cannot establish semantic relevance quality.**
Payload inspection excludes source bodies, but vectors and opaque identifiers
still count as private data.

The CLI does not control an operator's container or service. Consequently its
controlled stop/restart case is `not_run`, and a successful remaining run exits
`2` (`partial`), not `0`. An explicitly approved operator harness may call
`evaluateVector` with `lifecycle.stop` and `lifecycle.start` callbacks that target
only the disposable instance; `start` must wait for authenticated readiness at
the same address. Only a run with all 18 cases passing exits `0`. A failed case
exits `1`. No shell command is accepted from config and no lifecycle action is
performed by normal tests or reads.

After inspection, stop/remove only the owned disposable test backend. An explicitly
approved new native service may remain enabled after removing only its recorded
synthetic collections; see [QDRANT-NATIVE.md](QDRANT-NATIVE.md). Retain the private
evidence and synthetic storage as required; do not prune shared Docker resources.
Record actual cleanup and distinguish image cache retention from a running service.
Deployment resource sizing, TLS, production-scale load/soak, real-model semantic
quality and human summary review are separate gates. `production_ready` remains
false regardless of this isolated result.

For a separately budgeted synthetic run joining real Organizer/Embedder calls to
the real vector backend, see [JOINT-ACCEPTANCE.md](JOINT-ACCEPTANCE.md).

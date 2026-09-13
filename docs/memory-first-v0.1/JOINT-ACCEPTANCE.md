# Opt-in model + Qdrant joint acceptance

This small, frozen synthetic run joins the actual Organizer, Embedder, SQLite
authority and Qdrant projection. It supplements, rather than replaces, the full
quality corpus, backend fault tests and human review. It is not a deployment
command and never changes `production_ready`.

## Safety and budget

- Obtain approval for this distinct external-call batch. Maximum: **2 Organizer
  calls and 12 Embedder calls**, one attempt each, no repair or automatic rerun.
  Append call reservations before sending. Preserve previous batch ledgers and
  report cumulative usage separately; this per-run ceiling is not a shared
  account-wide billing limit. A new run requires its own approved budget.
- Only the bundled synthetic fixture and synthetic queries may leave the process.
  The fixture contains no production memory. The harness checks outbound source
  strings against the frozen fixture; secret-labelled synthetic data is excluded.
- Use an already approved disposable Qdrant on literal `127.0.0.1`, an API key,
  and a fixed loopback port. The harness never starts Docker or any service.
- Config, key files and evidence belong outside every Git worktree. Config/key
  files must be private (`0600`); the output directory must exist with `0700`.
- Production queries remain sensitivity-gated. This synthetic config must
  explicitly permit `sensitive` query embedding and `public` fixture documents.
  Do not relax the production policy to run this test.
- No production SQLite file is opened. Every run creates a fresh synthetic
  database and randomly named collections; no existing generation is activated.

The private JSON config has exactly two top-level fields: `providers` containing
the Organizer/Embedder profiles, and `vector_store` as documented in
[OPERATIONS.md](OPERATIONS.md). Full runtime configs and database-path fields are
rejected. Both providers must be enabled, non-mock, and configured for one attempt
with no repair; batch size must be at least five. The configured provider limits
must cover the frozen run limits. The supplied model and dimension are recorded
by profile fingerprint and vector metadata, not hardcoded in the repository.

```bash
npm run test:memory-joint-real -- \
  --config "$PRIVATE_JOINT_CONFIG" \
  --output "$PRIVATE_EVIDENCE_DIRECTORY" \
  --allow-network true
```

Network approval is checked before config access. Ordinary tests replace both
transports and perform no network I/O; such results are explicitly labelled
`protocol_simulated`, never `live_model_and_qdrant`.

## Frozen cases and evidence

The `synthetic-memory-joint-v1` fixture has five short engineering memories,
three non-authorized owner/project/session decoys, one secret-labelled source,
three fixed retrieval queries and one post-retraction query. Expected IDs and
thresholds are saved before the first request; do not tune them to an observed
model result. The 14 cases cover:

1. Authenticated backend readiness.
2. Classification and full coverage of source-grounded summary quotations.
3. Repeat summary scheduling without another model call.
4. Real vector backfill, body-free point payloads and idempotent sync.
5. SQLite reopen retaining the active generation.
6. Exact/hybrid and cross-language semantic retrieval, scope isolation,
   deduplication and full detail retrieval using returned memory IDs.
7. Original body/status preservation before explicit synthetic retraction.
8. Retraction hiding SQL results, summary claims and still-present stale vectors.
9. Vector cleanup and repeat cleanup without extra embeddings.
10. Reads never invoking Organizer, and no Task/Resume/receipt creation.

All 14 cases must pass for exit `0`; any failed or incomplete case exits `1`.
Each failed run and its call reservations are retained separately. Error output
uses bounded codes, not remote response bodies or secrets. Synthetic source text
appears only in the private fixture/summary-review evidence; vector values stay
in the private projection, not JSON reports.

This narrow fixture demands 100% expected top-one hits and summary leaf/critical
qualification coverage. Short sources are quoted in full: a ratio of `1` means
faithful source selection, **not effective compression or an abstractive summary**.
Long-source summarization, ambiguous classification, larger multilingual relevance,
human review and production data rollout remain separate gates. A successful
pilot must not silently mark the earlier 24-document/16-query benchmark passed.

Afterward remove only the owned temporary container and restore its host's prior
runtime state. Retain private synthetic storage, ledgers and evidence; no shared
Docker pruning, production deployment, credential rotation or Git publication is
part of this command.

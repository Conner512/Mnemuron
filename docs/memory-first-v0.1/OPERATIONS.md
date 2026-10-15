# Opt-in memory maintenance

No command in this guide is run automatically by installation, a status request or
an OAuth/Web read. Keep runtime configs, secrets, SQLite/WAL, vectors, job results,
backups, benchmark databases and reports outside source worktrees. Existing data
must not be moved or deleted without a separately reviewed migration.

## Provider contract

`providers.organizer` and `providers.embedder` are independent profiles. Disabled
profiles only need `enabled:false`. Enabled profiles require:

- `enabled`, `provider_id`, `protocol`, `model`, `profile_revision`;
- `base_url` for HTTP protocols, with no URL credentials, query or fragment;
- `auth`: exactly one of `env`, private `secret_file`, or explicitly `none:true`;
- `timeouts.request_ms` (1–120000);
- `limits`: `input_bytes`, `input_tokens`, `output_bytes`, `output_tokens`,
  `batch_size` (1–128), `concurrency` (1–16), `daily_requests`;
- `retry`: `max_attempts` (1–10), `base_ms`, `max_ms`, optional `repair_once`;
- `capabilities.native_schema`: explicit boolean, not an inferred capability;
- `egress`: `approved`, exact `origins`, exact resolved `addresses`, `allow_private`,
  permitted `sensitivities` and separate `query_approved` booleans.

No real vendor, model, endpoint or key is selected by default. `mock` requires
explicit test mode and synthetic data, and never falls back in production. Model
errors contain bounded codes, not response pages or source text. Source text is
data, never executable instructions; output has no tool or configuration actions.
The embedding policy applies to document **text sent to the model**, not only vectors.
`secret` never enters a provider or summary. Unlabelled existing memories default
to `sensitive`, requiring explicit approval of that class. Local maintenance can
set the policy label; models cannot downgrade it.

The embedder additionally requires `dimensions` (explicitly fixed), `distance`
(`Cosine`, `Dot`, `Euclid`), `query_prefix`, `document_prefix`, `normalization`
(`none`, `l2`) and `chunker_version`. Count, numeric index mapping, finite nonzero
vectors and dimensions are checked. No dimension padding/truncation is performed.
Profile fingerprints bind endpoint/protocol/model/revision, dimensions, metric,
prefixes, normalization, route overrides and chunker. Same dimensions do not mean
same semantic index. Credential/budget changes do not alter semantic space.

Input UTF-8 byte counts conservatively bound token use in the absence of a
vendor-specific tokenizer; output tokens are capped at the provider plus a local
response-byte cap. Oversized inputs fail, rather than silently losing text.

Supported protocols (built-in Node HTTP, no core dependency additions):

- OpenAI-compatible: `POST <base_url>/chat/completions` and `/embeddings`, JSON
  non-streamed output; optional explicit native JSON Schema. `base_url` may include
  a version prefix. Reviewed `paths.chat`/`paths.embed` overrides are fixed paths,
  never caller-supplied templates. [Embedding contract](https://developers.openai.com/api/reference/resources/embeddings/methods/create).
- Ollama: `POST <base_url>/api/chat` and `/api/embed`, non-streamed JSON. Embedding
  requests set `truncate:false`. [Chat](https://docs.ollama.com/api/chat),
  [embed](https://docs.ollama.com/api/embed).
- Native schema is followed by local closed-schema validation. Without it, bounded
  JSON parsing and the same validation still apply. At most one configured repair
  request is allowed and each request reserves another daily budget unit.

The transport approves both origin and every DNS result; it then pins the actual
socket lookup, ignores environment proxies, rejects all redirects, URL credentials,
metadata/link-local addresses and unapproved private addresses. Explicit private
HTTP is permitted only for private resolved destinations. Prefer authenticated TLS.
An external request already sent cannot be undone by subsequently retracting a source.

## Leased worker and derived views

The library scan uses a stable SQLite high-water mark and keyset pages, including
records older than the previous 50/500 limits. Jobs store revision/hash/scope
manifests rather than copying full source text into retry sidecars. Classification
is ordinary-language capable: no `Fact:` label is needed for existing saved memory.
Taxonomy IDs are bounded; unknown IDs become suggestions plus `uncategorized`.
User-locked category overrides are not replaced by model output.

Day/week windows use an IANA timezone, Monday-start weeks, earliest local-date
boundaries and UTC persisted endpoints. DST days are not assumed to be 24 hours.
Missed schedules coalesce dirty closed windows; unchanged snapshots deduplicate.
The explicit local worker rechecks periodically, not while a user searches.

Short transactions claim leases and publish results. Network calls occur outside
SQLite write transactions. Expired workers cannot publish with an older fencing
token. Completed chunks survive retries; the current view publishes only when all
inputs still match. Auth errors pause one profile, budgets and exponential retry
retain jobs, and bounded invalid outputs require review. External billing is not
exactly-once even though publication is idempotent.

This first summary contract is deliberately **extractive**: every claim must equal
an exact span of an authorized input revision. Source role, negation, versions and
uncertainty are preserved, and all leaf dependencies/coverage/omissions are stored.
Short atoms (at most 1024 UTF-16 code units) must be quoted whole or omitted, so a
qualification or quoted-data disclaimer cannot be stripped from their selected
text. Longer sources may use exact excerpts; full source references remain available.
The server validates model offsets or resolves a unique verbatim match in that
same authorized revision, retaining mismatched reported offsets as provenance.
Changed text, wrong revisions and ambiguous offset repairs require review. No
semantic paraphrase or automatic fact verification is inferred from a text match.
The prompt asks the model to account for long/repetitive sources and to retain
final decisions even when qualifications occur in separate sections. This improves
selection but is not a semantic proof that every important fact was selected.
New jobs use summary prompt `grounded-extractive-v5` with schema
`memory-derived-spans-v2`: up to four non-overlapping quotes may represent one long
source, allowing separate qualifications to survive without copying intervening
background. Quotes remain separate claims; text is never joined into a fabricated
source span. Duplicate/overlapping spans are rejected and selected-source counts
are distinct memory counts, not claim counts. Native schema bounds follow actual
input lengths and revisions. Short atoms still require one whole-source quote.
The v5 prompt additionally requires at least one uniquely locatable occurrence of
any distinct warning inside repetitive background; a warning does not become
dispensable merely because it is repeated. Existing v4 and older pending jobs
keep their original prompt/schema contract and fingerprint;
failed results are not rewritten. A newly scheduled version is a distinct job.

Classification prompt `grounded-classification-v2` distinguishes source subject
from quoted commands and unapproved suggestions; these must not become inferred
user preferences. Unknown/ambiguous subjects remain uncategorized. This is guidance,
not a claim of perfect classification; locked user categories still take priority.

Some compatible model gateways reject native JSON Schema requests. A rejected HTTP
request is retained as `HTTP_REJECTED / blocked_config`, without blind retries or
remote error bodies in job logs. After explicit profile review,
`capabilities.native_schema=false` selects JSON-object output with **unchanged local
schema/source validation**. It is not an automatic fallback, a permission change or
proof that native schema works for that provider.
It is not an unrestricted abstractive reasoning engine. Day/week views read atoms,
not only earlier summaries. Existing facts are never replaced or merged. Current
summaries are immediately hidden on source revision, privacy, override or availability
changes and revalidated on read. Claims are `derived_summary`, not independently
fact-checked. Real-model quality still needs separately authorized human assessment.

Read responses expose `coverage_status` (`complete` or `partial`),
`selected_source_count`, `omitted_source_count`, and up to 100
`omitted_sources` (authorized memory IDs plus revisions). The
`omitted_sources_truncated` flag reports a longer omission list. These counts use
all stored claims, not just the bounded 100-claim preview. Legacy `coverage` still
means total dependency count, not successfully summarized sources. A succeeded
job means its output was durably processed; it does not imply complete coverage
or semantic quality. Source detail remains authoritative.

## Local CLI

The published runtime Schema is checked offline with the full Draft 2020-12
validator already locked by the Web gateway dependencies. With those existing
dependencies installed, run `node scripts/check-memory-schema.mjs` or
`npm run test:memory-schema`. No new core dependency, model request, database open
or automatic dependency installation is involved. Missing/mismatched validation
dependencies fail the check instead of being skipped. Runtime validation still
enforces contextual rules such as mock isolation, address approval and timezones.

Use `node server/bin/mnemuron-memory.mjs COMMAND --config PRIVATE_CONFIG`.
The config and database must exist in private locations. Owner-scoped actions need
`--user OWNER`; the CLI uses local filesystem administrative authority, not a public
read-only token. No maintenance scopes are added to existing credentials.

| Command | Additional arguments and effect |
| --- | --- |
| `status` | Read-only SQLite connection; counts/component metadata only, no model, source bodies, database creation or migration |
| `provider-validate` | No network by default; `--allow-network true` explicitly probes organizer output and both document/query embeddings using synthetic inputs, without opening the memory database |
| `organize` | `--user OWNER --type classification` or `summary`; schedules only |
| `worker-once` | `--user OWNER --max-jobs 100`; runs bounded ready jobs |
| `worker-loop` | `--user OWNER`; explicit separate process, configurable poll interval; no service installed |
| `category-set` | `--user OWNER --memory-id ID --value CATEGORY`; explicit locked override |
| `sensitivity-set` | `--user OWNER --memory-id ID --value secret`; invalidate derived outputs |
| `summaries` | `--user OWNER --type user`; exact scope read, no organization side effects |
| `sources` | `--user OWNER --task-id ID --workstream-id ID --session-id ID`; bounded manifest, not full original |
| `source-read` | `--user OWNER --event-id ID --offset 0 --limit 4096`; exact Unicode source page |
| `jobs-resume-profile` | `--user OWNER --profile FINGERPRINT`; explicit profile pause recovery |
| `jobs-cancel` | `--user OWNER --job-id ID`; cancel that owner's job, fence old worker |
| `pin` / `unpin` | `--user OWNER --pin-id ID`, plus `--event-id ID` for pin; explicit retention only |
| `privacy-dry-run` | `--user OWNER --memory-id ID`; atoms, revisions, derived outputs, known points/job results and backup limits |
| `index-rebuild` | Creates a new inactive generation; does not switch reads |
| `index-sync` | `--generation ID`; backfill/catchup without changing authoritative memory |
| `index-activate` | `--generation ID`; requires full current coverage; atomic SQLite read-pointer switch |
| `index-reconcile` | `--generation ID`; remove orphan/stale projection points |
| `backup` | `--destination NEW_PRIVATE_FILE`; read-only source connection, consistent SQLite/WAL snapshot and content manifest; no source migration |
| `backup-verify` | `--backup PRIVATE_FILE`; file hash, per-table row hashes and foreign-key integrity |
| `restore-isolated` | `--backup PRIVATE_FILE --destination NEW_PRIVATE_FILE`; no replacement, no service, vector activation invalidated |
| `migration-dry-run` | `--destination PRIVATE_FILE`; inspect path boundaries, no copying or DB creation |

Jobs require `jobs.enabled=true`, memory enabled and an approved organizer profile.

Status reports `not_initialized` for missing maintenance tables in an older
database; it does not initialize them. Database-opening maintenance commands
reject missing, empty or non-file databases with `MEMORY_DATABASE_REQUIRED`.
Only the dry-run and provider-validation paths can operate without that database.
Backup verification/restoration instead require the explicit existing backup.
Other maintenance commands still open the regular Store and require an operator-
approved schema migration beforehand; `migration-dry-run` itself never applies it.

Backup and restore destinations must have no existing main file, `-wal`, `-shm`,
`-journal` or `.manifest.json` sibling. The destination is exclusively reserved
with mode `0600` before copying; a backup reserves its manifest at the same time.
Existing files are never replaced. All these paths, including a verification
manifest resolved through symlinks, must remain outside source worktrees. On a
failed copy, any newly reserved partial files are retained privately for operator
inspection, not presented as a verified backup or silently reused. Retry with a
new destination. Use an owner-only parent directory; these guards do not defend
against a malicious local administrator changing paths during an operation.

The manifest covers authoritative SQLite tables, including inline raw sources,
memory revisions and retention pins, using schema and sorted row-content hashes
plus foreign-key/integrity checks. It is a consistent snapshot, not a promise that
writes committed after the snapshot are included. It does not export arbitrary
external object directories or Qdrant data. Isolated restore rebuilds lexical
projection and invalidates vector activation; original backup/source data stays
unchanged. Backups can retain personal data even after a live retraction.

Provider probes report each component independently, including a failed organizer
and a successful embedder. Disabled/unconfigured components are not a passed test;
a failed or blocked probe exits nonzero. A structurally valid negative probe answer
cannot be counted as success. Protocol validation is not classification, summary
or retrieval quality acceptance. Test such quality separately against frozen
synthetic expected results before enabling processing of actual memories.
Recovery from `blocked_auth/config/budget` is explicit through `jobs-resume-profile`;
no credentials are changed automatically. Source manifests accept `--after`,
`--highwater` and `--limit`; summary reads accept `--offset` and `--limit`.
Keep the returned high-water mark when fetching subsequent manifest pages.

The additive REST `POST /v1/memory-summaries/query` requires `memory:read` and an exact
scope. `POST /v1/memories/query` remains lexical by default and accepts explicit
`mode:hybrid|semantic` only through configured vector capability. OAuth/Web tools
retain their existing allowed schemas/readonly boundary: no source-raw or maintenance
tool is exposed. Full source access/pins require new explicit `memory:sources:read`
and `memory:retention` scopes; category writes require `memory:organize`.

## Vector projection

`vector_store` is optional and requires `protocol:qdrant-rest-v1.19`, explicit
private `base_url`, `auth.env` or private `auth.secret_file`, a private resolved-address
allowlist, request/response limits and `collection_prefix`. The API-key header is
required. See [Qdrant query contract](https://api.qdrant.tech/api-reference/search/query-points)
and [upsert contract](https://api.qdrant.tech/api-reference/points/upsert-points).
No real Qdrant instance is launched by ordinary tests. [The deployment template](qdrant.compose.example.yaml)
is opt-in, bound to loopback and not part of Cloudflare ingress.
The separate [real-backend acceptance harness](VECTOR-ACCEPTANCE.md) requires
explicit network approval and an already running disposable loopback instance;
it never starts a service or opens a configured memory database.
The [joint acceptance harness](JOINT-ACCEPTANCE.md) separately joins real model
calls to that isolated backend with a frozen synthetic fixture and request budget.

Points contain opaque owner/scope/document surrogates, revision/profile/hash and
lifecycle metadata, never source text or real names. Vectors and opaque identifiers
are still private. Deterministic revision/chunk/profile IDs make upserts idempotent.
SQLite outbox/coverage state survives vector errors. Queries pin profile + physical
collection + generation before embedding, prefilter scope and owner, then recheck
the authoritative memory revision/lifecycle/source before returning text. Orphan
cleanup and restore invalidation prevent late/future points becoming authoritative.

Hybrid uses stable RRF rather than adding incomparable model/BM25 scores; exact
literal identifiers take precedence using full authoritative text and normalized
token boundaries, not prefixes of longer versions or truncated result previews.
Model/vector failure produces explicit lexical
degradation; semantic-only fails clearly. Atom results are deduplicated; summaries
are separately read views, so they do not crowd out their atoms. More than 128
distinct authorized scope tuples requires a narrower query rather than unsafe
post-filtering. Generations are retained for operator review; old model profiles
must remain configured while their read generation is active.

## Evidence and limitations

`test:all` reports core, plugin, OpenClaw, Hermes, OAuth/Web, memory unit/integration,
model-contract, worker, vector and full-schema suites independently. Optional performance runs:

```bash
node server/bin/mnemuron-memory-benchmark.mjs --output PRIVATE_EXISTING_DIRECTORY
```

It freezes thresholds/environment before running 10k/100k synthetic fixtures and
records save/search latency, worker load, RSS, event-loop delay and SQLite/FTS size.
Private fixture databases are retained there for inspection, never published.
Local synthetic performance is not service production acceptance. Real-model quality,
real Qdrant behavior, deployment, GitHub surface/history remediation and scanner/CI
execution must be reported separately; no blocked gate is silently marked passed.
See [synthetic quality evaluation](QUALITY.md) for fixed expected/forbidden IDs,
separate lexical/embedding metrics, and opt-in bounded real-model requests.

Privacy dry-run never claims physical erasure of backups, exports or provider copies.
Existing lifecycle tombstones remain. Operational restore/migration requires separate
operator approval. Production readiness stays false.

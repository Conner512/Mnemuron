# Hybrid search defaults and relevance / 混合搜索与相关性

## Behavior

Search now defaults to **hybrid** in the desktop console, the cloud MCP personal-model path, and Core when the deployment has not explicitly selected another default. Existing `mode: lexical` requests and an explicit Core runtime default are honored. The local MCP search tool now accepts and forwards `mode`; it is not necessary to change its storage or handoff protocol.

Hybrid means keyword plus an authorized, ready vector index; it does **not** enable a provider, approve query egress, share another account's model key or allocate a new budget. Without those prerequisites it returns filtered keyword results and `requested_mode: hybrid`, `effective_mode: lexical`, `degraded: true` with a safe reason. The console displays that reason. Explicit semantic-only queries still report an error rather than claiming keyword results are semantic results. A successful search with zero relevant results is not an error and is never padded to `limit`.

The console reset and a URL without a mode select hybrid. Explicit keyword bookmarks retain `mode=lexical`. Blank queries still browse the existing account-scoped inventory without an embedding request. Keyword mode is described as keyword retrieval, not guaranteed exact-string matching.

## Why results changed

Previously Chinese unigrams and bigrams were all joined with OR, and any nonzero token match could acquire confidence, recency and scope boosts. The console's lexical path also exposed raw candidates. Now multi-character Chinese queries use meaningful bigrams and must cover at least two thirds of each meaningful query group; isolated common characters cannot rescue an unrelated result. Literal terms, Unicode-normalized engineering identifiers and explicit one-character queries remain supported. English identifier prefixes such as `17.9.8` / `17.9.80` and `ali` / `quality` are not equivalent.

This relevance filter runs **before** the existing bounded 500-candidate window. Confidence and recency only rank candidates that have passed it. A degraded hybrid console query preserves the existing 25-row paging within that 500-keyword window; an actual fused result remains bounded by the current 20-result Core contract. Category filters still operate on the bounded candidate window. This change is not an unbounded retrieval or pagination redesign.

## Aliases

Expansion uses a bounded, non-recursive query plan. Sources are:

- Explicit current memory declarations, such as synthetic `星桥（Orion）`, reverse bilingual parentheses, and explicit `又称 / 别名 / aka` forms.
- Existing own project/task alias metadata for local/console readers only.

A query containing a known alias is expanded one hop, preserving its remaining subject. `星桥 网络配置` must not match an invoice simply because both mention Orion. Known alias entities also constrain vector neighbours, preventing a similar record about a different supplier from entering fusion.

There is no global dictionary of personal aliases, automatic transliteration, LLM-generated synonym list, transitive expansion or automatic writeback. A name absent from authorized declarations/metadata is not assumed to be an alias. Duplicate conflicting alias groups are marked `alias_ambiguous` and are not silently expanded; the console asks for a clearer name. At most 64 matching declaration records per source kind, nine query variants and 256 expanded tokens are considered. Source overflow disables expansion and reports `alias_source_truncated` rather than silently trusting a partial map.

Every declaration lookup retains user, explicit scope and lifecycle restrictions. Cloud readers cannot use hidden memory text or internal project metadata to discover aliases. Retraction or visibility changes take effect without maintaining a separate persistent alias cache. Data returned from memory remains untrusted data, never authorization.

## Vector relevance

Previously nearest neighbours were fed directly into reciprocal-rank fusion, which can rank the first result highly even when all absolute similarities are poor. The new gate checks the actual finite score **before** fusion, validates source revision/content/profile and privacy, sorts with the metric's direction, and deduplicates multiple chunks by their best qualifying score. RRF remains `rrf-v1`; its rank score is not a probability or similarity threshold.

Merge the optional settings into the existing private runtime file; do not replace its provider, storage or privacy configuration:

```json
{
  "memory": {
    "retrieval": {
      "mode": "hybrid",
      "semantic_min_score": 0.55
    }
  }
}
```

- Cosine and L2-normalized Dot: minimum similarity, default **0.55**.
- L2-normalized Euclid: maximum distance derived as `sqrt(2 - 2 * minimum_similarity)`, unless `semantic_max_distance` is explicitly supplied.
- Unnormalized Dot: requires an explicit minimum. Unnormalized Euclid: requires an explicit maximum distance.
- Missing calibration for an unnormalized metric produces `RELEVANCE_NOT_CONFIGURED` (hybrid falls back; semantic-only fails).
- Invalid, missing, NaN and infinite scores are not candidates. Threshold configuration is validated; no client-provided arbitrary thresholds are accepted.

**0.55 is an initial tunable operating threshold, not a universal correctness guarantee.** Similarity distributions depend on the embedding model and domain. Evaluate known-relevant, known-irrelevant and no-answer queries with the installation's model before adjusting it; raising it usually trades recall for precision. This patch does not call a real paid provider or tune against private memories. A high-scoring false positive remains possible, particularly where no explicit entity alias exists. Additional reranking should be justified with evaluation rather than enabled as an unapproved model call.

Responses expose applicable `relevance_policy`, `alias_expanded`, `alias_ambiguous`, `alias_source_truncated`, semantic threshold/direction/metric, eligible rejected-hit count, and per-record `ranking.semantic_score`. Rejected counts exclude foreign, hidden or stale records. These are diagnostics, not independent fact verification.

## Compatibility and deployment

No database migration, memory rewrite, alias writeback, authentication change or new application dependency is required. The existing lossless `memory-search-v3` token projection is unchanged; query-time filtering is separate. Deploy the **complete** commit, including `server/lib/search-query.mjs`, then restart the affected Core/OAuth/MCP processes by the installation's established procedure. Existing browser asset URLs and CSP remain unchanged.

Preserve the existing query-egress consent, per-user allocation, budget, scope, lifecycle, Web visibility, revision validation and handoff gates. Old explicit keyword clients continue to work. Public examples contain synthetic names only.

## Verification

`server/test/search-relevance.test.mjs` covers defaults, no-egress overrides, Chinese noise, bidirectional/ambiguous/retired/scoped aliases, near identifiers, over-500 candidate noise, low/malformed vector scores, chunk deduplication, no-answer results, configured thresholds, metric directions and Web privacy. Cloud adapter and real-browser tests cover mode forwarding, URL/reload/reset and visible degradation while preserving existing workflows.

The original baseline also contained six failures in four older Core suites: their fixed September capture dates had crossed the production 30-day retention period. Those fixtures now shift their original relative capture intervals to a recent fixed reference per test process. Ordering, assertions, explicit expired-record tests and the production clock/retention are unchanged. This is a test-fixture maintenance change, not a workaround that disables retention.

Run in isolated data:

```bash
node --test server/test/search-relevance.test.mjs adapters/chatgpt-web/test/multi-model-policy.test.mjs
node scripts/test-all.mjs
node scripts/check-publication.mjs --worktree
node scripts/check-publication.mjs --staged
node scripts/check-publication.mjs --all-refs
node scripts/check-secrets.mjs --history
```

Real provider calibration, production deployment, installed-host behavior and live ChatGPT authorization are separate acceptance steps. This patch does not claim they have been performed.

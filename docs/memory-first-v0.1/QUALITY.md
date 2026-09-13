# Repeatable synthetic quality evaluation

This harness evaluates a fixed public synthetic fixture, not a live memory library.
It does not start Qdrant, a worker service, OAuth or handoff, and cannot open the
configured production database. Every run creates a new SQLite file under a
private output directory outside all source/Git worktrees. Prior evidence is never
overwritten. Providers, keys and private model choices are not bundled.

## Offline and authorized model runs

Contract tests always use simulated responses, never a real endpoint:

```bash
npm run test:memory-quality
```

For a retained offline evaluation, first provide an existing operator-owned
directory with mode `0700` outside the checkout:

```bash
node server/bin/mnemuron-memory-quality.mjs --output /var/lib/mnemuron/quality
```

Offline mode does not read a provider config even when `--config` is supplied.
It measures SQLite exact retrieval, scope exclusion, complete detail reads and
atomic lifecycle behavior. Model quality is `not_run`, not implicitly passed.

Only after approving synthetic text egress and the bounded model cost:

```bash
node server/bin/mnemuron-memory-quality.mjs \
  --output /var/lib/mnemuron/quality \
  --config /etc/mnemuron/model-test.json \
  --allow-network true
```

The existing runtime config selects the Organizer and Embedder independently.
Enabled profiles require approved origin/address/sensitivity settings and private
credential references. Only fixture text and queries are sent. This command ignores
the configured database, vector store and worker enablement flags because it builds
an isolated synthetic library; it does not enable them in the running application.
Mock profiles cannot be passed off as a real-model run.

Exit codes: `0` means automated gates passed, `1` means a failure or blocked
preflight, and `2` means partial/offline or missing model acceptance. Neither `0`
nor provider authentication is a production promotion or human acceptance.

## Frozen inputs and bounded calls

`synthetic-memory-quality-v1` includes 24 memory documents, eight exact queries,
eight semantic queries and eight summary/classification sources. It includes
near-identical versions/serials/documentation addresses, uncertainty, conflicting
decisions, quoted instructions, and long English/Chinese notes. Japanese/Spanish
queries and documents exercise cross-language retrieval. Expected and forbidden
IDs and quality thresholds are recorded before any model request, along with a
fixture digest and runtime information. Change the fixture version when intentionally
changing the evaluation; never adjust expected answers to fit returned results.

With batch size eight, a full run reserves at most two Organizer and five Embedder
requests. Smaller configured batches increase the frozen bound. Retries/repairs
share that bound; they cannot silently increase it. Each request reservation is
persisted before sending. A new invocation is a new paid run, so an operator must
also enforce any cumulative cross-run budget. The harness does not auto-repeat.
Partial failures still permit independent components to collect their evidence.

The organizer summarizes one uncategorized window before classification to keep
summary coverage independent of taxonomy accuracy. Classification can invalidate
that earlier view; an already-absent view is not recorded as a successful retraction
test. Worker/lifecycle unit tests cover those invalidation paths independently.

## Correctness is not quality

Hard gates require zero cross-owner/session disclosure, unchanged atomic bodies,
exact source/revision references, no automatic fact verification, stable job
deduplication, complete detail reads, correct exact identifiers and no handoff
state. A model may return a valid exact quote while omitting an important condition:
that is recorded as a quality failure even when source validation succeeds.

Quality gates require all eight summary sources and their frozen critical
qualifications, at least 7/8 classification matches, semantic top-one accuracy
at least 0.75, mean reciprocal rank at least 0.8, and all expected sources in the
semantic top five. Exact lexical top-one accuracy must be 1.0. Missing queries
remain in the denominator, and queries requiring both conflicting sources must
retrieve both for full recall credit. Report numerators and dataset size; this
small set is not a universal quality estimate.

The report also records selected/source UTF-16 lengths, their ratio, and the
number of whole-source quotations. Full retention can be achieved by quoting
everything: a ratio of `1` is not evidence of compression or abstractive summary
quality. This version deliberately does not claim abstractive summarization.

Embedding results are ranked by cosine similarity **in process** and never saved
as vector values. This isolates model quality from Qdrant and is not an acceptance
test of the deployed semantic/hybrid service. Qdrant and human review remain
`not_run`. Inspect `summary-review.json` alongside the original fixture before
claiming human approval; exact quotation is not independent truth verification.

## Private evidence

Each run retains `preflight.json`, per-request reservation records, `results.json`,
an isolated `synthetic.sqlite3` and, when applicable, a source/claim review file.
Outputs contain no key, authorization header, endpoint URL or remote error body.
Only counts, durations and provider fingerprints enter execution metadata; source
bodies in the review file are the published synthetic fixture. The database also
contains local synthetic credential state, so keep the entire output private.

Report the initial failure and any targeted follow-up separately. A subsequent
summary-only pass must not overwrite an earlier failed whole-run report or imply
that classification, embedding or human review were rerun. Keep
`production_ready=false` until separately authorized acceptance and promotion.

## Expanded v2 and actual Qdrant projection

The opt-in `--edition v2` preserves every v1 document and question, then adds eight
classification cases: explicit preferences, quoted fake preferences, ambiguity and
technical suggestions. It freezes 32 documents, 16 questions, 16 classification
sources and the same eight summary sources. Original v1 reports remain comparable
and are never rewritten. Classification still requires at least 87.5%; the two
quoted-instruction cases additionally require zero preference misclassifications.

Long summary sources must retain every frozen critical fragment while selecting
at most half of each source. Omitting a source or quoting it whole cannot satisfy
that new compression gate. Short atoms remain whole. This measures extractive
compression, not abstractive reasoning, truth verification or human acceptance.

After authorizing a new bounded synthetic run, an existing private loopback Qdrant
can be exercised alongside the reference ranking:

```bash
node server/bin/mnemuron-memory-quality.mjs \
  --output /var/lib/mnemuron/quality \
  --config /etc/mnemuron/model-test.json \
  --edition v2 --with-vector true --allow-network true
```

No service is installed or started. The selected `vector_store` must be an
authenticated literal loopback target; invalid destinations and missing query
egress approval are rejected before any model calls. Only the harness's fresh
synthetic SQLite is indexed. A distinct random collection must be absent before
creation; cleanup deletes only that owned name, verifies absence, and reports a
failure if cleanup cannot be verified. Existing collections are never enumerated
for deletion. An operator may provide an authenticated SSH bridge to a previously
approved private backend; report that topology separately from protocol mocks.

With provider batch size eight, v2 reserves **3 Organizer and 6 Embedder** calls for
reference evaluation, plus **50 Embedder** calls for the complete projection
(32 sources, two scope decoys, 16 queries). The combined bound is **3 + 56**, not a
per-retry allowance. Each exact query uses hybrid ranking; each semantic query uses
semantic ranking. Scope isolation, exact identifiers, non-degraded retrieval,
deduplication, returned-ID detail reads, body-free point payloads and repeat sync
are checked. Reference ranking alone cannot mark this projection passed.

Reports distinguish actual default transports from `protocol_simulated` test
transports. A complete failed run stays failed even if a later summary-only check
passes. Native-schema rejection and an explicitly configured JSON-compatible run
are separate evidence; changing capability flags is never automatic. Each extra
diagnostic run needs its own bounded budget recorded before the call. Keep the
original reports and cumulative request counts, including rejected requests.

### Stricter warning-retention oracle

`--edition v3` uses exactly the v2 source bodies, questions and classifications,
but adds an important qualification found during source review: the repeated
Chinese observations say that one successful read/write is not capacity,
reliability or deployment acceptance. Selecting only the opening and final
decision loses that warning even when the older v2 critical-fragment score is
perfect. V3 requires it, without changing v1/v2 historical goldens. The model may
select one complete occurrence; it need not repeat all identical warnings.

Use v3 for new quality runs. Budgets and projection topology are unchanged.
V3's added hard-to-omit fragment is still a finite oracle, not exhaustive semantic
review: reports must retain `human_review=not_run` until a person reviews the
source/excerpt comparison. Do not convert a passing targeted v3 summary check
into a passing full classification/embedding/projection run.

### Recording human review

Keep the original model, metric and failed-run reports unchanged. Record a later
human decision in a separate private review record, binding it to the digests of
the reviewed source/excerpt artifact and its result. Include the decision, review
scope, recorded time and remaining limits; reference that record from the updated
acceptance matrix. An automated check or an assistant's own review is not a human
decision. A subsequent change to the sources, excerpts or summary implementation
needs a new applicability check rather than silently inheriting the approval.

Acceptance of a synthetic extractive-summary format does not approve abstractive
summaries, unrestricted model egress, production data indexing or deployment.
Neither a review sidecar nor a revised matrix changes a failed historical run into
a passed run. Keep private reviewer details and real acceptance evidence outside
the public source tree.

The complete regression suite also runs migrations from exact prior Git commits.
A source-only archive intentionally contains no Git history, so running that suite
requires a separate private local Git history context in addition to the existing
locked OAuth/Web dependencies. Do not bundle repository history or dependency
directories into a source-only candidate just to satisfy test prerequisites.

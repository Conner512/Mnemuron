# Memory quality and review workbench

Tracking: [implementation issue #6](https://github.com/Conner512/Mnemuron/issues/6).
This is an opt-in Console capability, not a deployment or production-readiness claim.
No model is called by any of these reads or review actions. Existing capture policies,
explicit memory-save behavior, model budgets and automatic processing are unchanged.

## Where to use it

- Memory library → **Memory review workbench / 记忆审核工作台**: preview candidates
  from a selected, already received source event. The selector shows at most 30 recent
  available events. Each candidate shows its role, extraction rule and exact original
  range. Edit and explicitly save, or dismiss. Candidate confirmation/dismissal requires
  the current password and a fresh authenticator code; factors stop at the BFF.
- Active memory detail → **Review and compare / 复查与对照**: enter another current
  memory ID or choose an existing similarity/conflict hint. Both sides show owner-scoped
  source metadata, project/scope and paged original bodies. Similarity is not a truth
  verdict. Choose keep both, undecided, replace the left using right-side content, or
  retract the left as redundant. Replacement creates a normal superseding record and
  preserves both old history and the right-hand reference; it does not silently merge
  IDs. Destructive reconciliation is allowed only in the exact same scope. Explicit Web
  denials from either side are preserved on the replacement.
- Summary detail → **Summary quality and source comparison / 摘要质量与原文对照**:
  compare exact quotations with paged originals, inspect source revisions and record
  accurate/missing-context/misleading/needs-review feedback. A changed source binding
  invalidates the old feedback instead of presenting it as a current judgment.

Manual verification records `last_verified_at` and an optional `review_due_at` (no more
than one year ahead). It does not mean an independent fact check happened. Version or
scope changes mark the recorded review as stale. Due dates are metadata, not a scheduler
or an automatic deletion instruction.

Pair decisions are bound to **both** memory revisions and source versions. Withdrawing,
correcting, moving or changing the evidence of either side makes that pair judgment
historical; a single-memory verification has no counterpart dependency. Earlier rows
without a counterpart source binding are retained by the additive migration but shown
as stale until the user reviews them again. Changing language or theme preserves all
unsubmitted candidate edits, comparison inputs, due dates and feedback selections.

## Bounds and meaning

- Preview extraction reuses the existing strict labeled-statement and conservative
  user-statement rules, with overlapping rule matches deduplicated. A source is limited
  to 128 × 1,024 UTF-16 code units and one preview to 30 candidates; candidate bodies must fit
  the 4,000-unit review editor. The server never asks a model to infer new facts.
- Pending and dismissed candidate rows are separate from `memories`. They cannot enter
  search, context, summaries, vectors or the graph through this workflow. Existing
  automatic capture may independently have created memories before a manual preview;
  the workbench does not disable or rewrite those existing policies or records.
- The stable candidate identity includes owner, event, source/scope/lifecycle version,
  exact selector/span and extraction rule. Re-previewing the same source cannot undo a
  previous dismissal or create another candidate. Confirmed candidates cannot be saved
  a second time. Retrying an operation ID must use its exact business payload and fresh
  factors; withdrawn, expired or changed dependencies reject stale receipt replay.
- An already pinned source whose original retention date has passed remains eligible
  while its body is retained. Preview rules use an isolated, pin-aware input; the stored
  retention deadline is never extended. Unpinning or purging the raw source invalidates
  old candidates and confirmations.
- Summary counters use **UTF-16 code units**, consistently with stored claim offsets.
  Character reduction is `1 - excerpt characters / source characters`; unique quoted
  coverage unions overlapping ranges per source. Source coverage counts selected versus
  represented dependencies. Neither metric proves semantic completeness or factuality.
- Quality review validates all dependencies (up to 2,000); source dropdowns show the
  first 100 with an explicit truncation note. Claims page eight at a time; quote previews
  are limited to 1,600 units and never labelled complete when shortened. Original-body
  pages use 4,096 Unicode code points, so emoji remain intact. Oversized snapshots fail
  visibly rather than silently omitting validation.
- Candidate responses are byte-bounded below the BFF response cap; the continuation
  offset advances only over actually examined rows. Source expiry hides the candidate
  body. Manual confirmation rechecks the live source and frozen version transactionally.

## Contract and authorization

Read views: `review-candidates`, `memory-review`, `summary-quality`.
Write actions: `review.extract`, `review.candidate`, `review.summary`, `review.verify`,
`review.resolve`. All writes need the exact full Console write grant and the existing
operations policy. Source candidate reads also need this full grant; ordinary memory
readers, basic Console credentials and MCP do not gain raw-source review access.
Other review reads retain Console plus memory-read requirements.

The BFF enforces login, CSRF, account identity, allowed actions and rate limits. It checks
current review versions or an exact completed operation before consuming fresh factors.
Core rechecks source/scope/revision and lifecycle generation inside the write transaction.
Business receipts contain identifiers and bindings, not copied originals or feedback text.
New tables are listed in the ownership and lifecycle inventories and protected by owner
mutation epoch triggers. They are additive and do not change existing source rows.

Deployment needs the updated Core, OAuth/static assets, and the **exact** new ingress
paths from `console-ingress.example.yml`. That example is not applied automatically.

## Synthetic verification

```
TMPDIR=/var/tmp node --test server/test/console-memory-review.test.mjs
TMPDIR=/var/tmp node --test --test-name-pattern=HTTP-REVIEW services/oauth/test/console-actions.test.mjs
TMPDIR=/var/tmp node --test services/oauth/test/console-feature-map.test.mjs
```

`scripts/test-console-memory-review.mjs` runs real loopback Core + OAuth + Chromium. Set
`PLAYWRIGHT_MODULE` and optionally `CHROMIUM_EXECUTABLE`; evidence is written outside the
worktree to a private synthetic-test directory. It verifies editable candidate promotion,
no pre-confirm memory write, source comparison, real feedback and verification persistence,
Chinese/English, narrow viewport behavior and login revocation. The fixture never loads
operator configuration, real memories or a production model.

# Long-source summary checkpoints

Part of issue #6. This extends the existing grounded extractive summaries; it does not rewrite original memories, enable a model, or automatically resume historical work.

## What changes

The worker still tries a fitting batch of whole sources first. When one long summary source cannot fit the **complete serialized request** (instructions, schema, identifiers and metadata included), it plans contiguous segments ending at sentence or paragraph boundaries. Fenced code and inline code are not cut internally. Decimal numbers, dotted versions, IP addresses and UTF-16 surrogate pairs are not split at a size limit. At most 64 segments are permitted.

All segments must fit before the first attempt is reserved. An indivisible oversized statement/code block, an impossible minimum prompt budget, or a source of at most 1,024 UTF-16 code units that cannot be sent whole remains `INPUT_TOO_LARGE`. No character truncation, silent omission or hidden budget increase is used. Classification/traits/entities retain their current whole-source policy.

Each segment carries its original revision, role, evidence kind, source length and source offsets. Model offsets are local to the provided segment and must resolve to exact text there. An empty segment result, wrong revision or invented/out-of-segment quote cannot become a successful checkpoint. Short segments must be quoted whole under the existing atomic-source rule.

## Durable, fenced progress

`memory_job_items` keeps a private `state='partial'` checkpoint in its existing `result_json`: the versioned layout hash, exact ranges, frozen classification hint and confirmed original-bound spans. No new table or schema migration is needed. The hash binds the source revision/state/scope, job/profile and complete request/schema for each segment. A later classification annotation does not invalidate the frozen hint or cause paid prefixes to be sent again. A checkpoint is not a completed source and never appears in the summary index, retrieval, graph or context.

Every attempt, including provider retries/repair, uses the same owner/run budget, egress policy, current-source validation and lease fence as whole-source work. Every checkpoint write repeats the owner grant, lease and original-item checks. Retraction, supersession, project deletion or cancellation during a model call prevents its late output from being saved or published.

Restarting a permitted job reuses its frozen layout and confirmed prefix, even if an increased request-size limit could now fit the whole source. A failed, unconfirmed segment can be billed again; confirmed segments are not. If a saved segment no longer fits the configured limits, the job remains `INPUT_TOO_LARGE`. A changed prompt/schema/layout or corrupt checkpoint fails closed with `INVALID_SOURCE_SET`; it is not silently discarded and reprocessed. Review the configuration or create a fresh explicit processing run. Request-size limits and call-budget limits remain different controls.

Only when every segment and source succeeds does publication occur. Original coordinates are restored and exact spans are combined deterministically, without a second lossy model rewrite. If more than four spans remain for the original source, the smallest gaps are filled with **original text** until the bound is satisfied. This favors faithful wording over an attractive compression ratio; a summary may legitimately retain the whole source. Coverage still counts original sources, not segments, and all claims remain `independently_fact_checked:false`.

## Display and operations

The memory processing detail shows `saved segments / total` and explicitly says the summary is not yet published. Its read returns only counts, never the private checkpoint body, and sends no model requests. Existing budget/config/retry controls govern continuation. No schedule or paid work is started by opening the page.

An older worker does not understand the private checkpoint: it treats the source as unfinished and may reprocess it whole or stop on size. Do not downgrade a running job expecting the new no-resend guarantee. Pause work first, keep a tested backup, and finish or explicitly replace the affected run on the matching code version. No destructive down-migration is needed.

## Verification boundary

`memory-first-jobs-segments.test.mjs` covers Unicode, fenced code, actual native/fallback-schema budgets, complete original coverage, budget pause, retry/restart, interrupted final checkpoints, corrupt layouts, source/cancellation/lifecycle fences and bounded lossless stitching. Existing whole-source budget tests remain required. Core/renderer tests cover counts without checkpoint-body exposure. All fixtures use synthetic sources and mock/loopback providers; real-model retention quality, latency, charges and production acceptance are separate checks.

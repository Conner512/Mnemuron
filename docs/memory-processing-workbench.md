# Memory processing workbench

Implements completeness and targeted repair from issue #6, on top of the memory pipeline reliability branch (PR #5). It does not activate processing or deploy a service.

## Read before processing

The memory detail pane reads `GET /v1/console/memory-processing?memory_id=…&revision=…` through the authenticated BFF. This is Console-only, owner/live-project scoped and pinned to the current revision. It reports source availability, missing kind/strength, current summary citations, local confirmed vector chunks in the serving generation, and at most 20 jobs/runs and summary observations. Optional keywords are not reported as mandatory missing fields.

The read never constructs a provider, sends text, queries Qdrant or claims remote health. A source that expires, is withdrawn, moves outside a live project or changes revision cannot silently retain its previous processing status. Summary evidence revalidates all dependencies, including expiring raw events. Missing evidence means unknown or missing, not a successful remote check.

## Explicit selected repair

The library selection toolbar and detail pane can preview `traits`, `summary` or `vector` repair. `processing.preview` accepts an optional `items` array of 1–50 unique `{memory_id, revision}` pairs; `limit` must equal the array length. Range parameters cannot be mixed with a selection. Unknown, foreign, withdrawn or stale selections fail before freezing a manifest. Complete traits, current summary citations and current indexed revisions are skipped. Manually supplied traits are never overwritten.

The preview discloses the exact revisions, skipped count, model and finite call budget, but sends no production content. Only explicit `processing.start` with its matching digest, existing fresh BFF proof, model/egress grants and feature gates authorizes background work. Existing per-run/daily/total limits apply to every attempt. A selected-preview receipt revalidates the original state hashes and lifecycle generation before returning stored titles, even when the memory revision number has not changed. Run-list entries whose frozen source is stale expose only IDs/revisions and an explicit stale marker, never a newer record's title. Expired selections must be selected again; they never become library-wide previews.

### Serving-index repair

Selected vector work requires an active generation with the configured model fingerprint. It pins that generation and uses its writer lease. It does **not** build or activate a replacement collection, walk unrelated pending rows, change the first-run manifest, or overwrite the global build request. Changing the serving index invalidates the grant. Retained old-model indices remain readable, but cannot silently be repaired with another configured model.

Only confirmed chunks of the exact revision/layout are reused. A lost publication acknowledgement retries publication without embedding confirmed chunks again. Source, credential, model, policy and lease checks run before transport and after waits. Cancellation/withdrawal cannot publish a late result. Partial confirmation is displayed honestly; existing paused/blocked run controls remain available.

## Context and profile completeness

Session context retains its string field and adds per-item revision/full-read references. Unicode-safe previews are marked `PREVIEW` in the string itself and disclosed through `truncation_reasons` (`item_preview`, `token_budget`, `candidate_limit`). The text token count is explicitly heuristic, not an exact provider tokenizer. A short later item may fit when a preceding one exceeds the budget. Candidate caps are never advertised as complete coverage.

Project profiles use the same NFKC/whitespace/case keyword key as the library and map, counting each memory once per normalized concept. Distinct versions and identifiers remain distinct.

## Verification and operating limits

- Synthetic Core tests cover read scope/revision, manual preservation, completed-step skip, selected summary coverage, preview replay fencing, active-generation isolation, publication retry and in-flight withdrawal.
- Synthetic BFF and pure-view tests cover routing/static ingress, account/revision fences, bilingual labels, escaped content, processing permissions and no filter-wide grant.
- Existing owner, vector chunk, context, profile, lifecycle and Console regressions remain required.
- Local contract/UI checks are not acceptance evidence for a real model, real Qdrant, production source data or deployment ingress. No historical jobs are automatically resumed.

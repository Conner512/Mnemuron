# Memory titles, ChatGPT read policy and embedding first run

This guide covers three changes and the gates that separate authoring from activation.
Nothing here is performed by deploying the code alone, except the display changes in part 1
and the removal of the console visibility controls in part 2.

## 1. Memory presentation (display only)

- List rows and `memory-meta` derive a short **title**:
  - From the topic when it reads as a title: it contains CJK text or a space, has at most 40
    characters, and is not an identifier path.
  - Otherwise from the first sentence of the content. CJK titles are at most 28 characters.
    Latin titles are at most 56 characters and are cut at a word.
- Imported or namespace topics (for example `AgentMemory/observation/Mnemuron` or `observation`)
  are shown separately as an **original tag**. They are never used as a title or a file path.
- A leading text is shown as a file path only when it is clearly one: it starts with `/`, `~/`,
  `./`, a drive letter, `[...]` or a backtick, or it has a file extension.
- The detail pane is headed by the title. It lists type (`memory_type`), category, status,
  revision, origin (imported with the original date, console, AI tool, or agent), the original
  tag and the sensitivity.
- Nothing is stored or rewritten. Topics, content and sources are unchanged, and the topic facet
  and filter still use the stored topic.
- Migration: none.

## 2. ChatGPT read policy

**Deploying the code** removes the console's per-memory ChatGPT controls:

- The `memory.visibility` and `memory.web_policy` actions are gone, along with their buttons and
  the read-all toggle.
- The Privacy page shows the effective policy read-only.

Effective access does **not** change. Existing grants, denials and read-all settings stay in
force, but they can no longer be edited from the console. The operator CLI
`mnemuron-admin web-visibility` remains available for the legacy mode.

**Activation** is a separate, explicitly approved operator step. It changes effective access.

1. Deploy the ChatGPT adapter and Core from this revision together. The adapter accepts both
   `web-memory-visibility-v1` and `web-memory-active-uniform-v1`. An older adapter fails closed
   (`CORE_AUTH_UNAVAILABLE`) against an activated Core.
2. In the Core runtime config, set:

   ```json
   "memory": { "agent_read_policy": "active_uniform_v1" }
   ```

3. Restart Core. The policy binds to each ChatGPT credential at authentication, and
   `GET /v1/identity` reports `web_read_policy: "web-memory-active-uniform-v1"`.

| Record | Before (default) | After activation |
|---|---|---|
| active, public | readable | readable |
| active, internal/sensitive with a current grant or read-all | readable | readable |
| active, internal/sensitive without a grant | hidden | **readable** |
| active, explicitly denied (keep_private, console deny, private default, imported `cloud_private`) | hidden | **readable** |
| active, secret | hidden | hidden |
| superseded or retracted (any classification) | legacy rule | legacy rule (denials and secret stay hidden) |
| another account | hidden | hidden |

- The same predicate applies to every ChatGPT read path:
  - get
  - lexical search with any status filter, including history
  - hybrid and semantic hits and their freshness check
  - summary dependencies
  - project context
  - the correction precondition
- Lifecycle, tenant, authentication, OAuth connection binding and scopes are unchanged.
- **Rollback:** remove the key (or set it to `chatgpt_per_memory_v1`) and restart Core. No grant
  or denial row is written or deleted by the new policy, so the previous result is restored
  exactly.
- Sensitivity remains the model-egress control: organizer and embedding models never receive
  `secret`.

## 3. Embedding first run (personal index)

### Runtime configuration (operator, Core host)

```json
"console": {
  "key_file": "/<private>/console.key",
  "worker_enabled": true,
  "personal_vectors": true
},
"vector_store": {
  "enabled": true,
  "protocol": "qdrant-rest-v1.19",
  "base_url": "http://127.0.0.1:6333",
  "auth": { "secret_file": "/<private>/qdrant-collection.key" },
  "egress": { "approved": true, "origins": ["http://127.0.0.1:6333"], "addresses": ["127.0.0.1"], "allow_private": true },
  "timeouts": { "request_ms": 10000 },
  "limits": { "input_bytes": 1048576, "output_bytes": 1048576 },
  "collection_prefix": "mnemuron_vec",
  "precreated_collections": ["mnemuron_vec_embed768_v1"]
}
```

- **Pre-creating the collection.** Operations pre-create each listed collection with
  `{"vectors":{"size":768,"distance":"Cosine"}}`.
  - Every name must start with `<collection_prefix>_`.
  - Mnemuron then only reads collection metadata (`GET /collections/{name}/exists` and
    `GET /collections/{name}`). It never creates or deletes a collection.
  - A collection-scoped read/write key is sufficient if it allows those two reads.
  - Each pre-created name serves one index generation. A later model or dimension change, or a
    second build kept for rollback, needs another pre-created name.
- **The vector key file** (`secret_file`, mode 0600) is read on every request. Replacing the file
  rotates the key without a restart. An expired or rejected key appears as `VECTOR_AUTH_FAILED`:
  - Before or at the start of a build, the build stops before any embedding call. No budget is
    spent, and the embedding model is not marked as failed.
  - After activation, semantic search stops and hybrid search falls back to keywords with
    `degradation_code: VECTOR_AUTH_FAILED`. Nothing else happens automatically.
  - If the key expires in the middle of a build, at most the calls for the document in flight are
    spent.
  - Recovery: install a new key file, then re-schedule the build (step 4). An active index
    resumes by itself once the key works.

### Embedding model (owner, console → Models → Embedding model)

| Field | Value |
|---|---|
| Protocol | `openai_compatible` |
| Model service address | `https://<embedding-gateway>/v1` (requests go to `/v1/embeddings`) |
| Model | `<embedding-model>` |
| Model revision | an operator label, for example `site-2026-10` |
| Vector dimensions | the configured size, for example `768` (sent as `dimensions`; the probe verifies the actual length) |
| Daily requests | unchanged (for example 25); the first-run budget replaces it for build calls only. Owner call limits, once set, replace it (see below). |
| Batch size | at least 1. Each record usually needs one call. |
| Highest allowed sensitivity | the highest class among the records to embed. Records without a classification count as `sensitive`. |
| Approve egress / approve queries | explicit choices |
| API key | entered once and sealed with the console key. Shown only as "saved". |

The API key is a persistent credential stored in the Core database. Entering it is part of the
bundled approval.

### Gated steps (owner, console → Models → Vectorization → First vector index build)

1. **Prepare and freeze the list.** Action `vector.prepare {budget_calls: N}`, where 1 ≤ N ≤ 150.
   - It freezes a manifest of `(memory_id, revision, state_hash)` for this account's **active**
     records. Secret records are excluded, and only sensitivities the embedder may receive are
     included.
   - It reports the manifest count, the digest, and the excluded counts (inactive,
     secret/unavailable, sensitivity not approved).
   - It opens the budget and picks the pre-created collection.
   - No model is called.
   - Compare the count with the expected count from the screening record, and record the digest.
   - The budget is never reset or raised from the console (`BUDGET_ALREADY_SET`).
   - Re-preparing is allowed only while nothing has been embedded, and it frees the collection.
2. **Synthetic probe.** Use "Test model API" for the embedding model. It makes two synthetic calls
   (document, plus query if query egress is approved), and the returned dimensions must equal
   768. The calls count against the budget and the daily cap.
3. **Confirm and build.** Action
   `vector.schedule {generation, expected_count, expected_digest}`.
   - The UI asks for the expected count and sends the digest it showed.
   - It is refused when the probe has not passed (`PROBE_REQUIRED`), when the count or digest
     differs (`MANIFEST_CHANGED`), or when the model changed (`VECTOR_PROFILE_MISMATCH`).
   - The worker embeds only manifest records, ten per tick.
   - A record changed after freezing is skipped as stale, with no call made.
   - The build ends in state **built**. It is never switched on automatically and never retried
     automatically. A retry is another explicit `vector.schedule`.
4. **Activate.** Action `vector.activate {generation}`. Semantic and hybrid search now use the
   index. Use synthetic queries only for the first checks.
5. **Rollback.** Action `vector.deactivate {generation}`. Search returns to keywords
   (`VECTOR_NOT_READY`). The collection, the points and the manifest are kept, and
   `vector.activate` can switch it on again without re-embedding.

### Budget accounting (one per account, at most 150 in total)

- Every embedder HTTP request reserves one unit before it is sent. This covers each probe call,
  each build call (one per manifest record when its chunks fit the batch size), each explicit
  retry and each semantic or hybrid query.
- Stale or excluded records and vector-store failures that happen before embedding cost nothing.
- Build calls bypass the daily cap. Probe and query calls are bounded by both the daily cap and
  the budget.
- At zero remaining, every embedder call fails with `BUDGET_EXHAUSTED` before anything is sent.
- A run needs 2 (probe) plus one call per manifest record. Size N to leave room for retries and
  synthetic queries, within 150.
- Progress and the used/total figures are shown on the Models page and in
  `processing.vector.first_run`.

### Owner call limits (console → Models → Call limits, action `models.quota`)

Each account sets a daily and a total call limit for each model kind (`organizer`, `embedder`):

```json
{"kind":"embedder","expected_revision":0,"daily_limit":null,"total_limit":null}
```

- `null` is an explicit **no limit**. A whole number is a cap: `0` allows no call. Daily is at
  most 1,000,000 and total at most 1,000,000,000. A missing key, a string, a fraction, a negative
  number or anything out of range is refused with `QUOTA_INVALID` and nothing is stored. A stale
  `expected_revision` is refused with `QUOTA_VERSION_CHANGED`.
- **Before a kind has a saved setting, nothing changes**: the model's daily requests and the
  first-run budget are enforced as described above (`processing.quotas.<kind>.mode: "legacy"`).
- **Once saved, the owner's limits are the only call-count caps for that kind** (`mode: "manual"`):
  the model's daily requests and the first-run total (150 at most) are no longer enforced. The
  first-run budget row stays as a record, keeps counting, and still marks first-run mode (no
  catch-up, no ordinary rebuild).
- **Counting never stops or resets.** Every reserved call is counted, limited or not. The embedder
  total starts from the first-run calls already used (for example 105). Calls already counted
  today under the account's model profiles carry into the daily count. The organizer total counts
  from the deployment of this change (`counting_since`).
- **Daily is per UTC day, per account and kind**, across model changes. First-run manifest build
  calls stay outside the daily count and inside the total.
- **Transitions.** A new or lower limit applies to the next call, against the existing counts.
  Lowering below the current usage is accepted and shown as exhausted (`DAILY_BUDGET_EXHAUSTED`,
  `TOTAL_BUDGET_EXHAUSTED`). The next call is then refused with `BUDGET_EXHAUSTED` before
  anything is sent. Re-enabling a limit counts the calls made while there was none.
- **A limit change has no side effects.** It does not change the model configuration or its probe
  result, retry or resume jobs (a `blocked_budget` job waits for an explicit retry), activate,
  rebuild or catch up an index, or widen egress. "No limit" is about counts only: what is sent
  and where is still governed by the model's egress approvals and the manifest.
- Each check and increment runs in the same `BEGIN IMMEDIATE` transaction as the existing
  reservation, so concurrent calls cannot exceed an enabled cap.
- Readiness: `processing.quotas.<kind>` shows mode, limits, used and remaining (`null` means no
  limit), plus the exhausted codes. They also appear as classification/summary blockers and as
  semantic-search blockers. The `model-usage` view reports the enforced daily limit (`limit:
  null` when there is none) and the total.
- Every change is audited (`console.models.quota.change`, with the previous and new limits).

### No catch-up

While a first-run budget exists for the account:

- The worker's periodic catch-up is off.
- The ordinary full rebuild is refused (`FIRST_RUN_ACTIVE`).

As a result:

- Memories created or corrected after the manifest are not in the semantic index. Hybrid search
  still finds them by keywords.
- ChatGPT hybrid or semantic reads fall back to lexical search (`VECTOR_STALE`) once any newer
  ChatGPT-visible active record exists.
- Ordinary incremental indexing needs a separate later approval and change.

### Data sent to external services

| Destination | What is sent | When |
|---|---|---|
| Embedding gateway (the configured model service) | Two synthetic probe strings | Step 2 |
| Embedding gateway | The full text of each manifest record (active, non-secret, approved sensitivity, this account only) | Step 3 |
| Embedding gateway | Query text of semantic or hybrid searches | After step 4, while active |
| The private vector store | Vectors plus payloads holding hashed owner/scope/document identifiers, revision, profile and content hash. No text. | Steps 3 to 5 |

A ChatGPT read denial is a read filter, not an egress control. Denied active records
are sent to the embedding gateway if they are in the manifest.

### Model change after activation

Each generation keeps the embedder profile it was built with, so a later model change does not
silently break the serving index. The status shows `serving_profile_differs`.

The retained profile still follows current consent:

- It stops when the embedding model is disabled.
- Egress, query approvals and sensitivities are intersected with the current settings.
- On the same origin, the current key is used.

### Known limits (deliberate in this bounded first run)

- **Budget size.** Prepare refuses a budget that cannot cover the probe and one call per listed
  record (`MANIFEST_EXCEEDS_BUDGET`). Leave headroom for retries and queries.
- **An exhausted budget is final.** Once it is used up, every embedding call for the account,
  queries included, fails with `BUDGET_EXHAUSTED`, and search falls back to keywords. Closing or
  replacing the budget for ordinary operation is a separate, later approval and change. An
  owner call limit (`models.quota`) replaces it as the enforced total, without resetting it.
- **One first run per account.** After a first run has embedded records, a new prepare is
  refused (`FIRST_RUN_EXISTS`); the existing index can be activated again at any time.
- **Pre-created collections are not reclaimed.** A generation keeps its pre-created collection
  for rollback, and nothing deletes points. Further builds need further pre-created names.
- **ChatGPT search after new writes.** ChatGPT semantic and hybrid reads require every
  ChatGPT-readable active record to be indexed. Without catch-up, they fall back to lexical
  search once a newer record exists. This also happens when the embedder's approved sensitivities
  exclude records that ChatGPT may read.
- **Provider change.** A retained profile serves only on the embedder's current origin, using the
  current key; keys are never copied into retained profiles. Moving the embedder to another
  origin stops the old index (`VECTOR_PROFILE_MISMATCH`) until a new build is approved.
- **Legacy account read-all.** An account that earlier enabled "ChatGPT may read all memories"
  keeps that setting under the default policy. The console now shows it but can no longer change
  it.

### Schema, compatibility and rollback

- **Additive tables only**, created idempotently at start: `console_vector_budget`,
  `console_vector_profiles` and `memory_vector_manifest`, and for owner call limits
  `console_model_quotas`, `console_model_usage` and `console_model_usage_daily`. Rolling the
  code back ignores the call-limit tables, so the legacy caps apply again (for example 25 per day
  and 150 in total). The schema version is unchanged and no
  existing row is rewritten.
- **Deploy Core and the console BFF together.** They share the action contract.
- **Code rollback to 330c7e2:**
  - The new tables are ignored.
  - **Deactivate the first-run index (step 5), or disable the embedding model, before rolling
    back.** The base code has no first-run mode: its worker would resume catch-up of the active
    index under the daily cap.
  - The base code ignores `memory.agent_read_policy`, so ChatGPT returns to the per-memory filter.
    Remove the key anyway, so a later roll-forward does not re-activate it unintentionally.

# Eleven-category defaults and explicit account adoption

The default taxonomy does not migrate an existing account or schedule any classification.

## Stable default IDs

| ID | Display name | Primary subject |
| --- | --- | --- |
| technical | 技术 | Code, mechanisms, infrastructure and troubleshooting |
| projects | 项目 | A particular project's scope, status, deliverables and milestones |
| workflows | 工作流程 | Reusable work procedures and collaboration |
| documentation | 文档规范 | Document structure, templates, naming and writing standards |
| personal | 个人资料 | Explicit profile facts, roles and background |
| family | 家庭 | Explicit family relationships, responsibilities and arrangements |
| preferences | 偏好 | Stated likes, dislikes and habitual choices |
| goals | 目标计划 | Desired outcomes, plans and intentions |
| decisions | 决策 | Adopted choices and their rationale; not proposals |
| lessons | 经验教训 | Explicit retrospective conclusions grounded in outcomes |
| uncategorized | 未分类 | Insufficient or ambiguous evidence |

Each memory has one main category. Boundary descriptions in both interface languages distinguish commonly overlapping subjects. Classifier prompt v4 uses a snapshot of current account IDs, names and descriptions and asks for up to eight factual tags. Explicit descriptions replace defaults; renamed IDs never inherit an old built-in meaning. Older classification jobs without a definition snapshot block before model egress and require explicit rescheduling. The model output schema enumerates only allowed IDs; invalid output is rejected without creating a category. The lower-level legacy annotation writer retains its unknown-category fallback for compatibility. No model quality improvement is claimed without a separately approved evaluation.

## Account compatibility

- Keep every old ID, including `personal`; only its untranslated built-in display changes to 个人资料 / Personal profile. Account-defined display labels win.
- Existing accounts without a saved taxonomy retain `console-default-v1` and its six categories. Reads perform no backfill or taxonomy writes.
- On first credential issuance for a new Core owner, inside the issuance transaction, persist a `taxonomy-default` preference with v2. An operator taxonomy, existing credentials (including revoked), preferences, audit records, memories, events or tasks prevent this initialization. Existing accounts that have never been provisioned in Core are treated as new Core owners.
- Read precedence: explicit account taxonomy, operator `memory.taxonomy`, the new owner's saved default, legacy v1 fallback. A saved default is separate from an account customization so operator configuration remains effective.
- No schema migration. Credential issuance and initial preference insertion commit or roll back together. OTP/authentication policy is unchanged.

## Read-only adoption preview

The existing owner-authorized `GET /console-api/taxonomy` response now includes `default_adoption`. This does not mutate preferences, jobs or memories and makes no model request. It includes current version, expected revision, current IDs, additive proposed IDs, added IDs, preserved labels, label-review collisions and the 64-category limit check. Custom categories are kept: a custom account may have more than eleven categories after adoption. The UI does not offer a new one-click adoption or classification action in this change.

Before any actual account adoption:

1. Read the intended owner's taxonomy metadata and review `default_adoption`; no memory bodies are needed. If `requires_adoption` is false, no metadata operation is needed. Resolve labels that intentionally repurpose a built-in ID and category-limit conflicts.
2. Present the exact owner, added IDs and retained custom IDs/labels for approval. Applying the existing `taxonomy.save` action changes account metadata, carries forward existing classifications for retained IDs, fences old pending organizer jobs and marks summaries stale. It does not send data to a model or reclassify history.
3. Only after approval use the existing owner-authorized action with the returned `expected_revision`. On a revision conflict, refresh the preview instead of retrying stale data. Do not overwrite the entire account with the eleven-item default array.
4. Confirm the taxonomy, counts, preserved assignments and paused workers. Changing back to the former IDs is another explicit metadata operation; removing used categories may require a separate move plan.

Historical reclassification is a separate approval: name the account, eligible memory count/sensitivity and revision set, exact configured provider/model and destination, estimated batches/request-token cost and budget cap, whether manual overrides stay locked, and treatment of previously queued jobs. Category adoption itself costs zero model calls. Do not resume a worker simply to adopt categories.

## What appears in the overview

The ring and short legend keep the largest five nonzero categories plus an explicitly labeled statistical Other when more than six categories have records. Counts and the percentage denominator include all active records. The full expandable directory includes every configured category, zero states, independent per-category counts/shares, descriptions and browse links. A defensive union also retains observed categories absent from the taxonomy. Independent rounding may sum to 99 or 101 percent.

## Tags: existing support and minimum next step

Tags are already bounded to eight strings in classification output and stored in `memory_annotations.tags_json`, scoped to owner, memory revision and taxonomy version. The Console currently has no full tag display/filter API; `topic` and the eight `memory_type` values are separate dimensions, not nested categories. This change improves future classifier tag guidance but does not claim tags are browsable.

The smallest follow-up is read-only chips on memory detail, obtained through its existing authorized metadata route for the current revision and taxonomy version, with explicit empty/stale handling and escaped text. A tag facet/search API plus backfill is a larger independent task; do not infer it from this UI change and do not regenerate existing tags without model-egress approval.

## Local validation and rollout

Use disposable synthetic fixtures only. Browser screenshots preview the eleven-category choice using loopback response fixtures; they are not production screenshots or proof of production adoption. Source-backed tests cover new owners, legacy fallback, custom settings, operator priority, restarts, read-only previews and limits; existing organizer/identity tests check compatibility.

For an approved deployment, back up code/config and perform normal source/asset/health validation; do not alter ingress, credentials, paused workers or jobs. Existing owners should remain on their former taxonomy until approved adoption. For rollback after new owners have begun using v2, preserve their effective taxonomy as an explicit account preference before returning to code that does not understand `taxonomy-default`; this is a separately reviewed metadata operation. Do not silently discard the v2 preference or its annotation version.

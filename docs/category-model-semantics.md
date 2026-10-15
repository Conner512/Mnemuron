# Account category names and model classification

Category edits update account taxonomy definitions without automatically scheduling classification.

## User behavior

Use the existing Memory library → Manage categories → Edit name & description dialog. New categories also accept an optional description (600 characters). This reuses `category.create` and `category.rename`; no new route or permission is needed. The reserved `uncategorized` category remains fixed.

- The ID is stable. A name-only edit retains an explicitly saved description. An empty description means the name is the scope; when an ID is renamed, its old built-in boundary no longer applies.
- Editing the description redefines the intended scope. Model input uses the account's own label and description, not a hard-coded interpretation of its ID. Conflicting or ambiguous definitions should result in `uncategorized` rather than inferred meaning.
- Built-ins without customization use their default labels and boundaries. The Console localizes built-in labels; the model receives the canonical Chinese label and English boundary. Custom names and descriptions are transmitted verbatim as descriptive data.
- The current overview shows saved custom descriptions. User text is escaped. `topic`, `memory_type`, tags and category IDs remain distinct.
- Neither kind of edit rewrites memory bodies, reassigns old records, or schedules classification. Existing model annotations are carried forward to the new taxonomy version; manual category locks continue to win. Both kinds of edit invalidate pending work planned under older definitions. Responses identify `change_kind` as `name` or `definition`.

## Execution and concurrency

New classification jobs use prompt v4 and store the exact allowed IDs and category definitions plus a digest of the owner's effective taxonomy, labels and descriptions. This metadata participates in the job fingerprint, so a previous successful job or cached chunk is not reused after definition changes. The supplied taxonomy for Console jobs comes from that authenticated account; offline synthetic evaluation may pass its own explicit test taxonomy.

The worker compares the snapshot before each batch, in the reservation transaction immediately before model egress (including repairs), after a response, and inside the publication transaction. Category edits increment the taxonomy version, carry forward retained annotations, and fence pending/leased/retrying non-entity jobs. A concurrent edit therefore either follows an already-completed publication or prevents the late output from being published. Manual classification also changes the source state hash and causes a late result to be rejected.

Classification jobs predating the snapshot contract stop with `STALE_TAXONOMY` before a model call, including jobs with old cached partial results. The Jobs view flags these even if the taxonomy version string happens to match. An explicitly authorized `jobs.retry` replans with fresh definitions and marks superseded jobs cancelled. It does not reuse their cached results. Renaming does not initiate this retry automatically. The existing retry planner can select the account's eligible library records, so review its scope before using it to process real history.

The response schema enumerates only allowed stable IDs, including uncategorized. Unknown IDs are rejected as invalid model output and never become categories. The lower-level annotation writer retains its legacy fallback (uncategorized plus suggestion) for compatibility; the new worker uses schema validation before publication.

## Adoption and limits

Deploy this code only after separate authorization. Existing accounts retain their chosen category IDs/defaults; adding the proposed eleven-category missing IDs remains a separate metadata operation. Category name/description editing uses the existing revision guard. On conflict reload the latest definitions; do not resend stale data or overwrite another edit. ID-list editing and category delete/undo preserve descriptions of retained/restored categories.

No real model was used in validation. Tests establish what the model receives, the permitted output shape, revision/lease fencing and preservation of assignments, not semantic accuracy. A real classification run still needs an explicit account, record/sensitivity scope, provider/model destination and call-cost limit. Keep workers paused until that run is approved.

## Investigating uncategorized records

Possible causes include no current annotation, failed or blocked processing, an unknown model category, intentional uncategorized output, a manual uncategorized override, or an annotation revision/taxonomy mismatch. Determine the cause from authorized account-scoped metadata; worker pause or taxonomy size alone does not prove the cause.

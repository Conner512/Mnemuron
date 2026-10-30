# Memory model usage and backup evidence

These additions expose observations, not new execution permissions. Opening the model or health page does not call a provider, create a backup, enable a timer, download a platform database, or restore over a running database.

## Model attempts, tokens and estimates

The model page keeps the existing **reserved-call hard limits** and their history. A separate observation panel describes actual dispatch attempts made by this account's Console Organizer / Embedder providers, including capability probes, query embeddings, retained-profile queries, retries and JSON repairs. A reservation can be consumed before dispatch is possible, so the two counters are intentionally not interchangeable.

Each attempt receives an internal UUID. After the complete request-size checks and a successful reservation, a durable `started` observation must be saved before dispatch. Failure to save that observation stops the request. A finished observation records a fixed outcome/error code, elapsed time and safe provider-reported token counts. Re-delivery of an observation UUID is idempotent; a new request or repair has a new UUID. A process interruption, lost response or failed completion write leaves an unfinished observation with unknown usage. It does not mean the supplier charged zero.

- Token counts must be nonnegative safe integers. Numeric strings, fractions, nonfinite values and unsafe integers are unknown, not coerced or rounded.
- Cached input tokens greater than total input are invalid. The remaining valid counters may still be displayed.
- Usage from a returned response is observed before output/schema/vector validation and before a post-response configuration fence can reject the result.
- No prompts, response bodies, API keys, base URLs or raw supplier error messages enter the ledger. The model identifier is the owner's saved configuration, not a supplier reply.
- `memory_model_attempts` is account-owned operational telemetry. It has no source/project IDs, does not grant lifecycle authority and does not advance material-memory mutation epochs.
- The default read window is 14 UTC days. `/v1/console/model-usage?days=30` accepts 1–90 days. The response groups by day, model profile and purpose, reports incomplete counts separately, and returns at most 50 recent attempts / 200 groups. Totals still include the entire requested window.

### Optional prices

The existing model configuration form can save this optional field:

```json
{
  "pricing": {
    "currency": "USD",
    "version": "owner-price-version-1",
    "input_per_million": 1.0,
    "output_per_million": 2.0,
    "cached_input_per_million": 0.1
  }
}
```

These numbers are **synthetic examples, not current supplier prices**. `output_per_million` is required only for an Organizer. The cached-input price is optional. All prices must be finite, nonnegative and at most `1e9`. A price of zero is explicit; an empty required field is rejected. The three-letter currency and bounded version are owner supplied. `pricing: null` disables future estimates.

The attempt snapshots the applicable price configuration at dispatch. A later change never reprices or backfills history. Retained embedding profiles do not inherit a different current model's price; without a matching current profile price they remain unpriced. If a cached-input price is configured but the response omits the cached count, the estimate is unknown. Without a cached price, all reported input uses the ordinary input rate. A response with insufficient required token counts is not estimated, even after an error. Known estimates are subtotaled **per currency**, with the number of unestimated attempts alongside them; they are never labelled a total bill. Taxes, subscriptions, discounts, invoice reconciliation and financial accuracy are outside this feature.

### Coverage boundary

The per-account Console factories attach the persistent observer. Standalone/global runtime-file providers expose the same optional `attemptObserver` interface, but are not assigned an account by guessing. Their unbound usage is explicitly **unobserved**, not zero. Existing global budgets remain enforced. No old reservations are converted to tokens or costs.

## Trusted local backup evidence

The health page's backup section is operator-only through the existing Console gateway. Single-owner Core additionally checks the configured owner. It exposes only operation kind, timestamps, result, fixed error code, snapshot hash and byte size; it does not expose paths, table/owner counts, database contents, downloads or a Web restore action.

Configure the already supported `storage.backup_dir` in the private runtime configuration used by Core and the maintenance CLI. The operator commands record evidence in a **separate** `backup-evidence.sqlite3` inside that directory. The source database is not modified to store evidence, and `restore-isolated` never opens the source database writable or starts a service. Reading status opens the evidence database read-only and never creates directories or files.

The evidence directory must be owned by the service/command user with mode `0700`; evidence files must be owned by that user with mode `0600`. Unsafe permissions, symlinked evidence files, wrong application/schema markers and unreadable evidence fail closed. The tool does not repair permissions or import arbitrary status files during a read. Operators should run the commands as the same service user that reads the evidence, not create root-owned evidence that the service cannot read.

### Recording a manual snapshot and checks

The following are **operator examples**, not commands run automatically by the application. Replace the private paths with the deployment's actual paths; select fresh destinations because the existing no-overwrite checks still apply.

```sh
node server/bin/mnemuron-memory.mjs backup \
  --config /etc/mnemuron/memory.runtime.json \
  --destination /var/lib/mnemuron/backups/manual-snapshot.sqlite3

node server/bin/mnemuron-memory.mjs backup-verify \
  --config /etc/mnemuron/memory.runtime.json \
  --backup /var/lib/mnemuron/backups/manual-snapshot.sqlite3

node server/bin/mnemuron-memory.mjs restore-isolated \
  --config /etc/mnemuron/memory.runtime.json \
  --backup /var/lib/mnemuron/backups/manual-snapshot.sqlite3 \
  --destination /var/lib/mnemuron/backups/isolated-rehearsal.sqlite3
```

`backup` creates a consistent SQLite snapshot and content manifest using the existing helper. `backup-verify` checks the file digest, table-content/schema manifest, integrity and foreign keys. `restore-isolated` verifies the backup, copies only to a new isolated destination, compares the restored content manifest and checks lexical search. Restored vector generations are invalidated and require a separate rebuild; external vector-store snapshots are not certified by this check.

A successful created snapshot establishes provenance for the source database. Subsequent verify/restore success is associated only with an artifact hash already registered for that same database. The private ledger identifies the source by a hash of canonical path, filesystem device, inode and birth time; normal writes, checkpoints, migrations and restarts preserve that identity, while moving/replacing the source requires new evidence. Paths and filesystem identities are not returned to the browser. This local-operator trust boundary is not cryptographic attestation against an administrator who can alter the source and evidence files.

An existing backup made before evidence recording can still be verified/restored by the CLI, but a valid arbitrary SQLite file and its manifest cannot certify that the live database has a registered backup. Such success is `unlinked`. A byte-identical copy of a previously registered artifact can be linked by digest. Only a completed, linked verification or isolated restore registers its input path as a trusted alias, so a later failure at that path supersedes earlier green verification; failed and unlinked attempts cannot create provenance. If the live source is unavailable, isolated recovery remains usable but returns `database_unavailable` for evidence linkage. No unavailable source file is created or migrated.

### Existing scheduled command

`mnemuron-scheduled-backup.mjs` still performs one backup when invoked by the operator's existing scheduler, preserves the legacy operator counters and does not delete older files. It now uses the same snapshot + manifest + verification implementation. To record status, give it `MNEMURON_MEMORY_CONFIG` pointing at the same private runtime configuration used by Core. `MNEMURON_DATABASE_PATH` still overrides its source database, and `MNEMURON_BACKUP_DIR` still controls snapshot destination. Evidence always uses the runtime `storage.backup_dir`, not an arbitrary HTTP parameter. The legacy env-only invocation works but explicitly reports `not_configured` for evidence.

For a restricted systemd unit, the operator must also allow writes to the configured evidence directory (the shipped legacy unit only permits its scheduled snapshot directory). Align the source override, directory permissions and service user before enabling this integration. This change does **not** edit, install or enable a timer. Files left by a failed copy are not automatically deleted: their creation/verification failed, and the operator can inspect them safely. No failed file is reported as a verified backup.

### Meaning of the health states

| State | Meaning |
| --- | --- |
| Not configured | No trusted evidence directory was configured; actual backups may still exist elsewhere. |
| Missing | No applicable execution evidence was recorded; not a claim of failure. |
| Created | A consistent snapshot completed, but no independent verification of the latest snapshot is recorded. |
| Verified | The latest snapshot's recorded verification completed successfully within the reference freshness window. Restore rehearsal has its own row. |
| Failed | The latest applicable attempt failed with a bounded local error code. Earlier success does not hide it. |
| Running / interrupted unknown | A started operation has no completed result. It is never treated as successful. |
| Stale | Successful evidence is older than the reference window: 7 days for backup/verification, 30 days for isolated restore. These windows do not imply a schedule. |
| Unlinked / unavailable | The operation cannot be linked to this database, or the evidence cannot be trusted/read. |

The verification row is for the latest successfully created snapshot. A restore rehearsal of an older registered snapshot is explicitly labelled as older, not as proof that the newest snapshot was rehearsed. Full disaster-recovery RPO/RTO, encryption, off-host retention and external vector-store restoration still require deployment-specific exercises.

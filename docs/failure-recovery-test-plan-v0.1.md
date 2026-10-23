# Mnemuron Failure and Recovery Test Plan v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Objective

Prove that the current `remote-v0.1` deployment preserves Event, Resume, Receipt, Task Scope, and provenance correctness when a component stops, a client is temporarily unable to reach the service, a delivery is replayed, or a backup is restored in isolation.

This document freezes the v0.1 execution contract. It does not authorize a service restart, forced process termination, network change, temporary credential, production Event write, production database write, firewall/Caddy change, backup deletion, Adapter installation, or restore execution. `production_ready` remains `false` until every applicable case has real evidence and the user explicitly approves final promotion.

The release report must list every supported Adapter and its required cases. Excluding an Adapter from a test run does not establish acceptance for that Adapter.

## Frozen safety model

1. Run only one fault at a time and return every participating component to a verified healthy baseline before starting the next case.
2. Every generated Event, Resume, delivery Attempt, Receipt, Session, Task, Workstream, and turn uses a unique deterministic run prefix. Existing Agent credentials and active outboxes are never used as test generators.
3. Production-path cases require a fresh, least-privilege, expiring credential and an online pre-run backup. The credential is revoked and every Key copy is removed during the same run.
4. Historical failed or unreported records remain append-only evidence. A new case passes only on its own IDs; aggregate historical debt is never relabelled as current failure or current success.
5. A managed restart and a crash-like restart are different faults and are recorded separately. Deliberate restarts must not be hidden inside `NRestarts` or service uptime summaries.
6. Network-partition cases isolate only the disposable test client transport. They must not change DNS, Caddy, PVE firewall, the client network, an active Agent route, or another service.
7. Restore cases use a private disposable directory, a random loopback port, and a copied backup. The production database and listener are never opened by the restored process.
8. Evidence directories are mode `0700`; files are mode `0600`. Secrets, raw payload content, and Key material are excluded from reports.

## Test identity and run isolation

Each executable layer uses a new `run_id` and a dedicated identity:

```text
device_id: failure-recovery-v01
agent_id: mnemuron-fault-harness
agent_instance_id: mnemuron-fault-harness-<run_id>
project_id: project-mnemuron
task_id: task-mnemuron-production-readiness-v01
workstream_id: workstream-failure-recovery
session_id: failure-recovery-<case_id>-<run_id>
```

Local and server-isolated tests use only temporary credentials. A later private-TLS run uses a newly issued credential restricted to the minimum scopes required by the selected case. A case that needs `resume:confirm` must not reuse the `capture:write` credential from Event-only cases.

## Execution layers

### Layer 1 — local isolation

- Current server and Adapter source, random loopback ports, temporary SQLite database, and temporary client state.
- Dependency-free transport fault gate with real wall-clock or explicitly accelerated unit timing, clearly labelled in evidence.
- Covers all state-machine, duplicate, unrelated-Session, cleanup, and short restart paths without contacting Mnemuron server.

### Layer 2 — Mnemuron server disposable isolation

- The target's supported Node runtime and exact candidate Harness hashes.
- Random loopback service, copied backup or temporary database, and disposable directories only.
- Production PID, listener, database stat, credentials, and service unit must remain unchanged.
- Covers service crash/recovery mechanics, restore checks, and evidence cleanup before any production fault.

### Layer 3 — bounded private-TLS production path

- The explicitly configured HTTPS endpoint → reverse proxy → central service path.
- Fresh pre-run backup and temporary least-privilege identity.
- Only the explicitly approved case runs. A pass in one case does not authorize the next fault.
- Run client-local acceptance on each participating device using its own trusted runtime and identity.

## Cases and frozen acceptance criteria

### FR-00 — preflight and postflight invariant snapshot

Capture the same fields before and after every case:

- Mnemuron server PID, deliberate restart ledger, `NRestarts`, live/ready status, PVE-authoritative memory/swap/PSI/OOM state, database/WAL sizes, filesystem free bytes, SQLite quick/integrity results, and Raw classification;
- Event IDs and provenance for the case prefix;
- all participating Adapter queue counts and oldest queued age;
- Resume status, Resolver selection count, Task Scope, Attempt/Receipt phase rows, Session, Workstream, turn ID, and error code;
- scheduled backup last-success/freshness and temporary artifact inventory.

Required result: the baseline is healthy before the fault, every case-specific invariant passes after recovery, and no unrelated Agent queue or canonical Task record changes.

### FR-01 — Mnemuron server service restart matrix

Run a durable test client at 10 Events/s through private TLS. The client writes each Event to its private outbox before transmission. Execute five individually labelled cycles, waiting for full recovery and reconciliation between cycles:

1. three managed `systemctl restart mnemuron.service` cycles;
2. two crash-like `SIGKILL` cycles, allowing `Restart=on-failure` to recover the service after its configured three-second delay.

Required result for every cycle:

- `/livez` and `/readyz` recover within 60 seconds;
- the deliberate restart ledger records exactly one cycle and there is no extra automatic restart;
- every generated Event exists exactly once after the queue drains;
- transient failures remain queued and final queue depth is 0 within five minutes;
- Raw remains `accounted`, SQLite checks are `ok`, and no false Resume ACK or Receipt appears;
- memory stays below 70% of 1 GiB, no new OOM/OOM-kill/max event occurs, and filesystem free remains above 20%.

Any crash-like cycle is a separate high-impact action and needs explicit authorization even if the three managed cycles already passed.

### FR-02 — Adapter restart recovery

Run one fresh Resume per Adapter. Establish `delivered/in_flight`, restart only the selected Adapter before its terminal ACK, then reopen the same Agent conversation and retry with a fresh Attempt/Receipt where the protocol requires it.

| Adapter | Required evidence |
| --- | --- |
| Device A ChatGPT | Current Hook-attested Session cannot be failed or claimed by an unrelated Session; a valid restart path preserves Task/Workstream and ends with one matching Stop ACK |
| Device B ChatGPT | Local preflight first proves current plugin version, trusted Hooks, queues 0, and server-verified identity; then the same rules as Device A apply |
| OpenClaw | The exact ordinary user Session must own the retry; generic/internal runs cannot claim a direct-chat Resume without the required route identity |
| Hermes | Verify the selected gateway Session, one-time delivery, matching terminal ACK, and no later reinjection |

Required result: the original failure remains append-only, the retry receives a fresh Attempt/Receipt ID, the valid Session alone can complete ACK, later turns do not reinject, and no third Attempt is created.

### FR-03 — durable queue under network partition

Use only the disposable fault client. A Harness transport gate rejects that client's network operations while leaving the host, DNS, Caddy, Mnemuron server, and active Agents unchanged. When the gate opens, traffic uses the real private-TLS endpoint.

Run the durations independently in this order: 5 minutes, 30 minutes, and 120 minutes. Return to FR-00 healthy state between runs.

Required result for each duration:

- all generated Event files remain mode `0600` in a mode `0700` outbox and preserve enqueue order;
- the queue count and oldest age match the generated sequence during the partition;
- reopening transport drains the queue completely within five minutes;
- generated and stored ID counts and SHA-256 digests match, with zero missing or duplicate IDs;
- no 413 quarantine, false ACK, cross-Session claim, silent truncation, or unrelated Agent queue change occurs.

The 120-minute run is a long disruptive test window and needs a separate execution approval after the 5- and 30-minute cases pass.

### FR-04 — duplicate delivery, duplicate ACK, and Session ownership

Exercise one disposable confirmed Resume and one Receipt through the isolated API first, then repeat the exact approved sequence through private TLS:

1. insert `delivered` once and replay the same phase;
2. attempt ACK before delivery on a different Receipt;
3. ACK the valid Receipt once and replay the same ACK;
4. replay with a different event ID but identical Receipt/phase;
5. try to change Session, credential provenance, Workstream, or delivery method;
6. try a second delivery after another Receipt has already completed.

Required result:

- one `delivered` row and one matching `acknowledged` row exist for the successful Receipt;
- exact duplicates return idempotent duplicate results without adding rows;
- ACK-before-delivery, changed provenance, unrelated Session, concurrent in-flight Receipt, and post-completion second delivery return explicit conflict responses;
- the real host turn ID exists only on ACK, Task Scope remains correct, and no false or orphan ACK is created.

### FR-05 — scheduled-backup RPO and isolated-restore RTO

Use the latest successful timer-created backup, not a capacity-test or manual backup. Before copying it, require:

```text
free_bytes >= (backup_bytes * 1.25) + (filesystem_bytes * 0.20)
latest_timer_backup_age <= 26 hours
last_backup_service_result == success
```

Start the RTO clock immediately before the private copy and stop it only after all checks complete:

- backup and restored database `quick_check=ok` and `integrity_check=ok`;
- random-loopback `/livez`, `/readyz`, authenticated identity, Task, latest confirmed Resume, Delivery Receipt, Checkpoint, Resolver selection, and device/Agent/Session/Workstream/turn provenance checks pass;
- production database stat, PID, listener, and credential state remain unchanged;
- disposable process stops and every temporary file/directory is removed.

Required result: timer RPO is at most 24 hours, freshness at observation is at most 26 hours, isolated restore RTO is at most 30 minutes, and no production object is overwritten. Recalculate restore headroom at execution time.

## Global stop conditions

Stop the active case, preserve evidence, revoke the temporary credential, and do not start another fault if any of the following occurs:

- `unexplained_raw_unavailable > 0`, SQLite quick/integrity failure, missing or duplicate case Event ID, or changed immutable provenance;
- readiness does not recover within 60 seconds, an unexpected restart appears, or a process remains after its cleanup deadline;
- any queue fails to drain within five minutes, oldest queue age cannot be determined, or a permanent item blocks later valid items;
- an unrelated Session claims/fails a Receipt, ACK appears without matching delivery, or the same Resume is injected after successful ACK;
- new OOM/OOM-kill/max event, memory at least 90% with full-memory PSI at least 1%, material swap growth of at least 32 MiB across three increasing samples, or filesystem free below 20%;
- backup freshness exceeds 26 hours, restore headroom formula fails, or a temporary database/backup artifact remains;
- identity is not `server_verified`, private TLS verification fails, or an existing Agent outbox is nonzero before the case.

## Evidence package

Every run must seal:

- `manifest.json`: run/case IDs, exact source and deployed hashes, versions, timestamps, identity labels, and scope booleans;
- `timeline.csv`: monotonic and UTC timestamps for fault start, first failure, recovery, queue-zero, reconciliation, ACK, and cleanup;
- `events.json`: generated/stored counts and sorted-ID SHA-256, without Raw content;
- `receipts.json`: safe phase/provenance fields only, without Packet content;
- `resources.csv`: Harness process and disposable-filesystem samples; Mnemuron server runs additionally seal `pve-resources.csv` and `production-invariants.json` from the PVE-authoritative wrapper;
- `backup.json`: timer freshness, file stat, checks, RPO/RTO, restore assertions, and cleanup;
- `adjudication.md` and `adjudication.json`: pass, fail, or blocked per case, with no aggregate green result while a case is incomplete.

## Planned execution order and authorization boundaries

1. Pass local and disposable-server isolation for every selected case.
2. Configure `MNEMURON_PVE_HOST`, `MNEMURON_CTID`, and an HTTPS `MNEMURON_SERVER_URL` for FR-01, FR-03, and FR-04 orchestration. Missing or reserved example destinations fail closed.
3. Verify the real target and private backup, then run only the approved fault with a fresh temporary credential.
4. Reconcile events and lifecycle records, return to a healthy baseline, revoke the credential, and verify cleanup.
5. Run each wall-clock partition duration independently; accelerated tests do not satisfy those gates.
6. Validate each Adapter included in the release scope and the latest timer-created backup's restore RPO/RTO.
7. Keep any missing, blocked, or deferred case explicit in the private acceptance report.

No execution step in this plan sets `production_ready=true`.

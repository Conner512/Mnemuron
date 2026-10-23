# Mnemuron Capacity and Backpressure Test Plan v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Objective

Measure whether the selected deployment can preserve complete Event provenance and bounded delivery under sustained load, burst load, large request bodies, temporary disconnection, and retention pruning. This plan does not authorize a production load run, credential creation, service restart, firewall change, retention change, or test-data deletion.

`production_ready` remains `false` until every applicable case below has real evidence and the user explicitly approves final promotion.

## Target configuration and baseline

Configure the target explicitly with `MNEMURON_PVE_HOST`, `MNEMURON_CTID`, and `MNEMURON_SERVER_URL` (HTTPS). The private-TLS harness also accepts its existing `--ssh-host`, `--ctid`, and `--server-url` options. Missing configuration and reserved example destinations fail before remote execution.

Capture the actual CPU/memory/swap limits, filesystem headroom, service PID/restart count, body limit, SQLite/WAL sizes, health, and participating Adapter queues for each run. For PVE, use host-authoritative resource data and the matching container cgroup; the guest root cgroup is not an authoritative container limit. Fail closed when the target or resource scope cannot be established.

The numerical profile below is a test fixture: 1 GiB memory and an 8 MiB request limit. Confirm the selected deployment matches the profile before executing it; these values are not a public inventory of any operator's system.

## Isolation and identity rules

Testing uses three layers in order:

1. **Local isolated layer** — current server and Adapter code, a temporary database, loopback only, and no existing credential or outbox.
2. **Mnemuron server isolated layer** — a private temporary database and random loopback port inside Mnemuron server, using the deployed Node runtime and the same 8 MiB body limit. It must not open or migrate the live database.
3. **Bounded private-TLS layer** — the real Caddy-to-Mnemuron server path using a dedicated, temporary test Agent identity. This layer starts only after the first two pass and requires a separate user confirmation.

The test identity is scoped as follows:

```text
device_id: capacity-example-v02
agent_id: mnemuron-loadgen
agent_instance_id: mnemuron-loadgen-capacity-v02
project_id: project-mnemuron
task_id: task-mnemuron-production-readiness-v01
workstream_id: workstream-capacity
session_id: capacity-v02-<run_id>
```

- A new credential must be issued immediately before the bounded real-path run and revoked immediately after evidence collection.
- Credential contents must never enter the repository, command output, captured evidence, or Mnemuron Event payloads.
- Active Device A, Device B, OpenClaw, and Hermes credentials and outbox directories are not load generators.
- Adapter backpressure cases use isolated config/data directories. ChatGPT uses an isolated `MNEMURON_CONFIG_PATH`; OpenClaw uses temporary `outboxDir`, pending, Task Scope, and injection-event directories.
- Record which Adapters are included in the run. An omitted Adapter is not covered by the result.

## Workload and payload model

Every HTTP request is sized by the encoded JSON body byte length, not by the `content` string length. Each Event receives a deterministic run prefix plus a unique UUID, full test identity, Session, Task, Workstream, capture timestamp, and `raw_hook_payload` marker.

| Class | Encoded request size | Purpose |
| --- | ---: | --- |
| S | 1–4 KiB | normal Hook traffic and sustained/burst throughput |
| M | 64–128 KiB | tool results and moderately large transcripts |
| H | 3,272,419 bytes | fixed synthetic regression size above the default 2 MiB limit |
| L | 7.5 MiB maximum | accepted near-limit request; size includes JSON envelope overhead |
| X | 8 MiB + 1 byte minimum | explicit rejection path |

The 12,000 throughput Events use a deterministic representative mix: 80% S, 15% 16 KiB, and 5% 128 KiB. Large-body cases are separate so they do not distort normal latency percentiles.

## Test cases

### A. Request-limit correctness

| ID | Action | Required result |
| --- | --- | --- |
| BODY-01 | Send one H request through isolated server and private TLS | 202; exact Raw payload retained; no 413/502 |
| BODY-02 | Send two L requests concurrently through private TLS | both return 202; both Event IDs exist exactly once |
| BODY-03 | Send one X request through direct isolated path and private TLS | explicit JSON 413 on both paths; never 502; no Event row created |
| BODY-04 | Send a valid S request immediately after BODY-03 on the same keep-alive client | 202; proves the server consumed the rejected body and kept the connection usable |

### B. Sustained and burst capacity

| ID | Workload | Required result |
| --- | --- | --- |
| LOAD-01 | 10 Events/s for 15 minutes (9,000 Events) | zero loss, zero duplicate IDs, zero 5xx, append p95 below 1 second |
| LOAD-02 | 50 Events/s for 60 seconds (3,000 Events) | zero loss, zero duplicate IDs, zero 5xx, append p95 below 1 second |
| LOAD-03 | Run BODY-02 while 10 Events/s background traffic continues | both large Events and every small Event succeed exactly once |

Latency is measured from client send start to complete HTTP response. Report p50, p95, p99, maximum, status-code counts, connection errors, and achieved request rate. Averages alone are insufficient.

### C. Durable outbox and backpressure

| ID | Action | Required result |
| --- | --- | --- |
| QUEUE-01 | Point an isolated Adapter config at an unreachable endpoint and enqueue 3,000 valid Events | all Events persist in private `0600` files inside a `0700` directory; no active outbox changes |
| QUEUE-02 | Restore connectivity and flush QUEUE-01 | queue reaches zero within 5 minutes; 3,000 central Event IDs exist exactly once |
| QUEUE-03 | Interrupt a flush mid-run, restart only the isolated client, and flush again | queue drains without duplicate Event rows or skipped IDs |
| QUEUE-04 | Place one permanent over-limit Event ahead of later valid Events | over-limit Event is explicitly terminal/quarantined; later valid Events continue to drain |

QUEUE-04 must preserve the oversized original and terminal size/SHA-256/error metadata in private quarantine, continue draining later valid Events, and expose degraded status while quarantine records exist. Silent truncation and silent deletion remain forbidden.

The 30-minute and 120-minute network partitions belong to the later fault-injection gate. They reuse the same harness after the five-minute capacity/backpressure case passes.

### D. Retention, storage growth, and backup interaction

| ID | Action | Required result |
| --- | --- | --- |
| RET-01 | On an isolated database, expire only test Raw payloads and run prune | only eligible `content` and `raw_payload_json` are cleared; Event identity/provenance remains |
| RET-02 | Compare Task, Memory, Checkpoint, Resume, Resolver selection, injection, Receipt, credential, and audit counts before/after prune | every non-Raw count and immutable record is unchanged |
| RET-03 | Run online backup during 10 Events/s load | no 5xx/loss; record backup duration, maximum append latency, size, mode 0600, and `integrity_check=ok` |
| RET-04 | Measure database/WAL/filesystem before load, after load, after checkpoint, and after prune | growth is reported by phase; free space never falls below 20% |

Real-path test Events use the minimum supported one-day Raw retention. They are not manually deleted in this phase. Any later cleanup is a separate destructive action requiring explicit authorization.

## Resource and stop thresholds

Sample Mnemuron server every five seconds during LOAD and QUEUE drain:

- service active state, PID, and restart count;
- cgroup current/peak memory and swap use;
- CPU utilization and load average;
- filesystem free bytes and database/WAL sizes;
- HTTP 2xx/4xx/5xx counts and latency percentiles;
- generated, acknowledged, queued, flushed, failed, and duplicate Event counts;
- oldest outbox age and total outbox bytes.

Stop the run immediately when any of these occurs:

- production-service memory reaches 70% of 1 GiB (751,619,276 bytes);
- container Swap grows by at least 32 MiB from the run baseline across three consecutive increasing samples; smaller positive growth is retained as a warning;
- a new container/service OOM, OOM-kill, or cgroup `memory.events.max` event occurs;
- container memory reaches 90% of its cgroup limit while full-memory PSI `avg10` is at least 1%;
- filesystem free space falls below 20%;
- unexpected `mnemuron.service` restart or readiness failure;
- any unexplained 5xx, Event loss, duplicate Event ID, database integrity failure, or live Agent queue growth;
- append p95 remains at or above 1 second for two consecutive one-minute windows;
- the test generator cannot prove its credential and data directories are isolated.

## Evidence package

Each run writes one private evidence directory identified by `run_id` and contains no credential values:

- manifest with source commit/file hashes, server limit, topology, identity IDs, start/end time, and exact workload parameters;
- pre/post central table counts and `integrity_check` results;
- request status and latency histogram in JSON/CSV;
- Event-ID reconciliation: generated, 202-accepted, centrally stored, duplicates, and missing;
- resource samples, service restarts, database/WAL/storage deltas, and backup timing;
- Adapter outbox file counts/bytes/oldest age, flush attempts, terminal errors, and final state;
- direct-versus-TLS BODY-03 comparison proving 413 rather than 502;
- explicit deviations and a Pass/Fail result for every case.

Derived Checkpoints are recorded as side effects but cannot be used as the source of truth for generated/stored Event reconciliation.

## Execution order and approval boundary

1. Run the repeatable Harness and regression against a disposable local database.
2. Repeat the same cases on an isolated server with a random loopback listener and temporary database.
3. Verify the real target, resource limits, storage headroom, backup/recovery plan, and explicit run scope.
4. Issue a fresh least-privilege credential and run the approved bounded private-TLS cases.
5. Reconcile every generated and stored Event, record per-case outcomes, and validate queue drain and Raw accounting.
6. Revoke the temporary credential, remove its Key copies, and verify temporary backup cleanup.
7. Preserve failed and blocked runs privately. An incomplete workload cannot be promoted to Pass using independent successful cases.

No execution step sets `production_ready=true`.

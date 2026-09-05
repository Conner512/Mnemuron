# Production Readiness Evidence Matrix v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Acceptance profile

This is a reusable single-user release profile. List the actual participating ChatGPT devices, OpenClaw and Hermes instances, service resources, HTTPS entrypoint, and credential boundaries in a private run manifest. The 1 GiB memory and 8 MiB body limits below describe the reference test fixture, not a deployed host. Confirm and freeze the applicable profile before execution.

`production_ready` remains `false` until every required gate passes and production promotion is explicitly approved.

## Gate matrix

| Gate | Public evidence status | Required private evidence |
| --- | --- | --- |
| Continuity correctness | Not published | Repeated real Preview/Confirm/delivery/ACK cycles on each destination |
| Event integrity | Not published | Exact Raw accounting and complete provenance during load and soak |
| Resolver and conflicts | Not published | Ambiguity handling, source preservation, concurrency and idempotency |
| Failure and recovery | Not published | Restart, partition, duplicate/ownership and timer-backup restore cases |
| Capacity and retention | Not published | Complete workload, queue drain, storage and concurrent-backup cases |
| Security | Not published | TLS, access restrictions, credential and permission checks |
| Observability | Not published | Queue/Receipt age, backup freshness, disk and restart reporting |
| Stability | Not published | Seven-day soak with daily private snapshots |

These entries do not replace or reclassify private historical results. Each release must attach its own current evidence.

## Frozen pass/fail thresholds

### 1. Continuity correctness

- Each supported destination completes three consecutive real Preview → exact Confirm → next ordinary turn → terminal ACK cycles.
- Zero Packet delivery before confirmation, zero duplicate delivery, zero cross-Session rollback, and zero silent Task/Workstream fallback.
- Every accepted ChatGPT Receipt has exactly one `delivered` phase followed by one terminal `acknowledged` or explicit `failed` phase with matching immutable provenance.
- OpenClaw and Hermes retain the existing injection-event contract and must not regress while ChatGPT uses MCP Delivery Receipt.

### 2. Event integrity

- `unexplained_raw_unavailable = events - raw_events_available - expired_events` must remain 0.
- Missing device, Agent, Agent instance, Session, Project, Task, and Workstream provenance must remain 0.
- Duplicate Event IDs after retries must remain 0.
- Completed assistant and tool-result Events require a real `turn_id`; pre-turn ingress exceptions must be counted separately.
- No full-capture claim is permitted when any unexplained gap is nonzero.

### 3. Resolver, conflict, and concurrency

- Exact Task ID resolves uniquely in 100% of tests.
- At least 20 scripted ambiguous or conflicting cases must show candidates/conflicts and perform no confirmation or injection before user selection.
- Concurrent confirmations in different Sessions must never supersede or alter each other.
- A newer Resume may supersede only the prior binding in the same conversation scope.
- Retry of the same ID/version must be idempotent; a changed Preview version requires a new Preview.

### 4. Capacity, backpressure, and retention

- Sustain 10 Events/s for 15 minutes and burst 50 Events/s for 60 seconds with zero loss, duplicates, or 5xx responses.
- Event append p95 must remain below 1 second on the private deployment.
- Two simultaneous request bodies up to 7.5 MiB must succeed; an over-limit request must return an explicit 413 and must not surface as 502.
- After connectivity returns, each Adapter outbox must drain completely within 5 minutes under the normal four-Agent profile.
- During tests, Mnemuron server memory stays below 70% of 1 GiB and filesystem free space stays above 20%.
- Expiry/prune removes only eligible Raw content; canonical Task, Memory, Checkpoint, Receipt, and audit metadata remain intact.

### 5. Failure and recovery

- Five Mnemuron server service restart cycles during Event traffic produce zero loss, duplicate injection, or false ACK.
- Adapter restart recovery is tested independently on both clients, OpenClaw, and Hermes.
- Network partitions of 5, 30, and 120 minutes preserve ordered durable queues and drain within the five-minute recovery target after reconnection.
- Duplicate delivery and ACK calls remain idempotent; unrelated Session startup cannot fail or claim another Session's Receipt.
- Daily backup RPO is at most 24 hours; latest-backup freshness must be at most 26 hours.
- Isolated restore RTO is at most 30 minutes and must finish with `integrity_check=ok` plus identity, Task, Receipt, and provenance checks.

### 6. Security

- Untrusted external clients receive 403 from Caddy.
- The service port is reachable only from the configured reverse proxy and explicitly approved administration sources before promotion.
- Every Agent keeps a distinct credential; revocation of one credential does not affect the others.
- Secret files and local binding state remain mode `0600` inside mode `0700` directories.
- No credential value appears in project files, captured summaries, logs, backups exported for review, or user-facing responses.
- No unresolved High or Critical security finding is allowed at promotion.

### 7. Observability

- Status reports `expired_events`, `unexplained_raw_unavailable`, queue count and age, latest sync error, Receipt phase/age, backup freshness, disk use, and service restart count.
- Degraded state is raised when any queue remains nonzero for more than 5 minutes, a Receipt stays in flight for more than 10 minutes, the latest backup exceeds 26 hours, disk free space falls below 20%, or an unexpected service restart occurs.
- Production status must distinguish policy expiry, temporary backlog, confirmed data loss, and a merely unreachable server.

### 8. Stability soak

- Run seven continuous days using all four Agent instances under ordinary work.
- Zero unexplained Raw loss, duplicate Event, duplicate Resume injection, false ACK, stuck queue, or unplanned service restart.
- Daily snapshots record Event/Raw/expired counts, queue age, Receipt phases, database/WAL size, disk, memory, backup integrity/freshness, and latest Checkpoint per Workstream.
- Database and backup growth must remain linear and leave at least 20% filesystem free at the projected 30-day point.

## Execution order

1. Freeze the release scope and profile.
2. Verify source and isolated tests, then collect current installed-runtime evidence.
3. Complete approved capacity and failure/recovery cases.
4. Review exposure, credential handling and observability.
5. Complete the stability soak and review every remaining gate before promotion.

This matrix is an acceptance contract, not authorization to change a deployment.

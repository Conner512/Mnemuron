# Production Readiness v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Goal

Promote Mnemuron `remote-v0.1` from a validated cross-device and cross-Agent prototype to an evidence-backed production candidate. This phase does not set `production_ready=true`; promotion requires every gate below to pass and a final explicit user decision.

## Evidence boundary

The public repository contains reproducible test code and acceptance requirements. Actual deployment results, run IDs, identities, timelines, backup inventories, and raw evidence belong in a private report. A feature test or source-tree pass does not establish production readiness for a specific deployment.

## Acceptance gates

| Gate | Required evidence | Exit condition |
| --- | --- | --- |
| Continuity correctness | Preview-first, exact confirmation, one-time delivery, persistent Task Scope, destination Workstream preservation | All four Agent/device paths pass without silent fallback or duplicate Resume delivery |
| Event integrity | Event/raw-event accounting, provenance completeness, idempotency, large-event preservation | Every gap is resolved or explicitly explained; no unsupported full-capture claim remains |
| Resolver and conflict behavior | Combined signal resolution, ambiguous candidates, cross-workstream differences, supersession and concurrent confirmation | Ambiguity is shown before action; no candidate is silently selected or merged |
| Failure and recovery | Service restart, Adapter restart, network partition, retry, duplicate Receipt, backup and isolated restore | No loss, duplicate injection, cross-session rollback, or false ACK under tested faults |
| Capacity and retention | Large body, burst, sustained load, outbox backpressure, database growth, prune and backup duration | Agreed thresholds pass with bounded queues and measured storage growth |
| Security | Credential isolation, revocation, audit, TLS, direct-port boundary, file permissions, least privilege | No open high-risk finding; exposure and operational controls are documented and verified |
| Observability | Queue depth, sync age, delivery phases, error classes, backup freshness, storage and service health | Operators can distinguish healthy, degraded, blocked, and data-loss-risk states |
| Stability | Agreed soak duration across normal Agent use, checkpoint generation, restart-free operation and queue drain | No unexplained loss, duplicate delivery, stuck queue, or uncontrolled growth during the soak |

## Work order

1. Freeze the release scope, evidence matrix, and numerical pass/fail thresholds.
2. Validate Raw Event accounting and provenance before making completeness claims.
3. Validate Resolver, Reconciliation, confirmation, and cross-device visibility.
4. Complete local, isolated-server, and approved real-path capacity/retention cases.
5. Complete failure/recovery, real Adapter restart, partition, and scheduled-backup RPO/RTO cases.
6. Close security and observability findings.
7. Run the agreed stability soak.
8. Present the complete evidence for an explicit production-promotion decision.

## Boundaries

- Unrelated memory services and their configuration are outside this project's acceptance scope.
- Existing raw events, failed Receipts, Checkpoints, and audit records remain immutable evidence.
- Tests and documentation must preserve device, Agent, Agent instance, Session, Task, Workstream, Resume, Receipt, and turn provenance.

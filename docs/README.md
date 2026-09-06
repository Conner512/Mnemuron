# Documentation

[Project overview](../README.md) · [项目中文介绍](../README.zh-CN.md)

Start with the local API, then choose an adapter. A deployment guide or versioned design document is not a record of a successful installation. Some detailed specifications are currently in Chinese; translation improvements are welcome.

## Start here

| Goal | Guide |
| --- | --- |
| Run the API and save your first memory | [Getting started](getting-started.md) |
| Connect a ChatGPT / Codex host | [Plugin guide](../plugins/mnemuron/README.md) |
| Connect OpenClaw | [Adapter guide](../adapters/openclaw/README.md) |
| Connect Hermes | [Adapter guide](../adapters/hermes/README.md) |
| Work on the code or documentation | [Contributing](../CONTRIBUTING.md) |

## Concepts and protocols

- [Core specification](core-spec-v0.1.md): records, identities, and continuity boundaries.
- [Project memory preview](project-memory-preview-v0.1.md) and [task branch inspection](task-branches-preview-v0.1.md): read-only discovery before choosing what to resume.
- [Task bootstrap and binding](task-bootstrap-binding-v0.1.md) and [project bootstrap](project-bootstrap-initial-task-v0.1.md): previewed creation of new work.
- [Combination resolver](combination-resolver-v0.1.md) and [branch-aware selection](branch-aware-resume-selection-v0.1.md): select context without erasing its source.
- [Dynamic task scope](dynamic-task-scope-v0.1.md): bind subsequent activity to the restored task while retaining the destination workstream.
- [Resume injection ACK](resume-injection-ack-v0.1.md) and [ChatGPT MCP Delivery Receipt](chatgpt-mcp-delivery-receipt-v0.1.4.md): adapter-specific delivery and completion contracts. The ChatGPT receipt flow is distinct from native adapter injection attempts.
- [Checkpoints](checkpoint-v0.1.md), [automatic structured memory](automatic-structured-memory-v0.1.md), and [memory retrieval/lifecycle](structured-memory-retrieval-lifecycle-v0.1.md): derived context and explicit memory records.
- [Canonical reconciliation](canonical-task-reconciliation-v0.1.md): proposal versions, reconciliation policy, and authoritative task updates.

## Operations

- [Linux/LXC deployment example](pve-lxc-deployment-v0.1.md): service layout, TLS, and independent client identities. This is one deployment option, not a required topology.
- [OpenClaw deployment](openclaw-deployment.md) and [Hermes deployment](hermes-deployment.md): host-specific configuration boundaries.
- [Deployment evidence checklist](deployment-evidence.md): what to verify in your own environment.
- [Production readiness](production-readiness-v0.1.md) and [evidence matrix](production-readiness-evidence-matrix-v0.1.md): release gates, not a production-readiness claim.
- [Capacity/backpressure plan](capacity-backpressure-test-plan-v0.1.md) and [failure/recovery plan](failure-recovery-test-plan-v0.1.md): operator-run test designs. Do not point fault or load harnesses at a live service without an explicit test scope.

## Implementation notes

- [ChatGPT core foundation](chatgpt-core-foundation-v0.1.md) and [core correctness](core-correctness-v0.2.md).
- [Core optimization release notes](core-optimization-v0.2/release-notes.md), [retrieval design](core-optimization-v0.2/retrieval-decision.md), and [acceptance cases](core-optimization-v0.2/ACCEPTANCE_TESTS.md).
- [Core review v0.3](core-review-v0.3/README.md): mixed-script retrieval, search readiness, and strict event acceptance receipts; no OAuth connector.

Version labels identify individual contracts or work packages. They are not a single repository-wide release version. Consult the relevant implementation and tests when changing a contract.

## Sharing safely

[Publication policy](publication-policy.md) covers source, fixtures, reports, and historical Git content. Keep runtime data, personal memory, credentials, and environment-specific evidence outside public contributions.

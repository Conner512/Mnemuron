# Mnemuron

**Self-hosted memory for AI agents, with optional task handoff.**

English · [简体中文](README.zh-CN.md)

Mnemuron stores reusable memories with their sources and revisions, so authorized agents can search and read them across sessions and devices. Memory works independently of task handoff. When continuity is needed, a separate review-and-confirm flow prepares a context packet without treating summaries as authoritative task state.

The central service stores data in SQLite. Adapters connect agent lifecycle events to the service and keep a local outbox when it is unavailable. There is no required cloud memory service or external vector database.

> **Status: experimental.** Single-owner self-hosting remains the default. An opt-in account-isolated console is available for local evaluation; deployment and recovery policies require separate review. APIs, schemas, and host integrations may change. `production_ready` remains `false`; adapter availability is not a claim that every host version or deployment is supported.

**Desktop console actions:** the opt-in [functional console guide](docs/console-functional-actions-v0.4.md) connects memory editing, personal model/worker settings, security, invitations and operator administration to real account-scoped services. Existing consoles stay read-only until explicitly enabled; the ChatGPT MCP remains read-only.

## Why Mnemuron?

- **Continue work without starting over.** Discover a project, select a task or source branch, review its Resume Preview, and explicitly confirm before delivery.
- **Keep context tied to its source.** Records retain their agent, session, and workstream provenance. Resuming a task preserves the destination agent's workstream.
- **Distinguish facts from summaries.** Canonical task state, automatically derived checkpoints, and structured memories are separate records—not interchangeable versions of the truth.
- **Retrieve and revise memory.** Search scoped memories with SQLite FTS5, inspect full content, and supersede or retract records while retaining lifecycle history.
- **Read memories from ChatGPT Web.** An optional OAuth gateway provides versioned reads, bounded summaries and explicit search modes, without Web writes, project restoration or handoff. Per-record authorization and content-free read audits help inspect access without publishing memory contents.
- **Make delivery observable.** Durable outboxes, idempotent retries, and delivery acknowledgements help distinguish queued, delivered, and completed work.

## How it works

```text
ChatGPT / Codex  ─┐
OpenClaw        ─┼─ Adapters + local outboxes ─► Mnemuron API ─► SQLite / WAL
Hermes          ─┘
```

An **Event** is a captured activity record. A **Checkpoint** is a derived snapshot with source references. A **Canonical Task** is the authoritative task state, updated through reconciliation rules rather than by treating every summary as an overwrite. A **Memory** is a scoped, reusable item with its own lifecycle.

To resume work: **Preview → explicit Confirm → next ordinary turn → delivery → matching completion ACK**. A preview does not inject context. Confirmation does not mean the destination agent has already received or completed the handoff. The exact delivery mechanism depends on the adapter.

## Quick start: run the local API

Requirements: **Node.js 24+** with `node:sqlite` and FTS5, Git, and a POSIX shell. The server has no third-party npm runtime dependencies. Python 3 is needed for the Hermes adapter and the full test suite.

```bash
git clone https://github.com/Conner512/Mnemuron.git
cd Mnemuron
umask 077
MNEMURON_EXAMPLE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mnemuron-example.XXXXXX")"

MNEMURON_HOST=127.0.0.1 \
MNEMURON_PORT=47831 \
MNEMURON_DATABASE_PATH="$MNEMURON_EXAMPLE_DIR/mnemuron.sqlite3" \
  node server/bin/mnemuron-server.mjs
```

In a second terminal:

```bash
curl --fail http://127.0.0.1:47831/livez
curl --fail http://127.0.0.1:47831/readyz
```

These check process liveness and database readiness. They do **not** verify search, adapter capture, or a Resume handoff. Stop the server with `Ctrl+C`; the disposable database stays in the generated directory outside the checkout. Use a private, persistent directory outside all Git worktrees for real data.

For independent memory operation without new tasks or handoffs, see [memory-only configuration and storage checks](docs/memory-first-v0.1/README.md). Existing installations without module flags keep their handoff behavior; nothing is silently switched off.

**Next: [create an agent credential, save a memory, and query it](docs/getting-started.md).** This local example does not install a host plugin or expose the service to the network. Use HTTPS and separate agent credentials for remote clients.

## Agent integrations

| Integration | Implementation | Start here |
| --- | --- | --- |
| ChatGPT / Codex plugin | Local MCP server, Skill, and host lifecycle hooks; MCP Delivery Receipt flow | [Plugin guide](plugins/mnemuron/README.md) |
| OpenClaw | Native plugin, lifecycle hooks, and `/mnemuron` commands | [Adapter guide](adapters/openclaw/README.md) |
| Hermes | Python user plugin, lifecycle hooks, and `/mnemuron` commands | [Adapter guide](adapters/hermes/README.md) |
| ChatGPT Web / remote MCP | Optional OAuth service and stateless read-only HTTP gateway; separate from host hooks | [OAuth guide](docs/chatgpt-web-oauth-v0.1/README.md) |

These are source integrations, not a universal installer. Host plugin loading, hook permissions, and session identity must be verified in the target host. An MCP connection alone does not prove that lifecycle capture or completion ACKs are working. The optional web gateway is locally tested with synthetic data; it requires separate deployment and real ChatGPT verification, and does not capture conversations or resume tasks.

## Documentation

- [Getting started](docs/getting-started.md) — a local, authenticated API walkthrough.
- [Documentation index](docs/README.md) — concepts, protocol contracts, adapters, and operations.
- [Account console preview](docs/integrated-console-v0.3.md) — invitation-based registration, local TOTP, account-bound reads, migration and deliberately blocked operations.
- [Core specification](docs/core-spec-v0.1.md) — the data model and continuity boundaries.
- [Deployment guide](docs/pve-lxc-deployment-v0.1.md) — an optional Linux/LXC deployment example; Proxmox is not required by the core API.
- [Core optimization notes](docs/core-optimization-v0.2/release-notes.md) and [retrieval/sync review](docs/core-review-v0.3/README.md) — implementation changes and compatibility notes.

## Development

From a full Git clone, run:

```bash
npm test
node scripts/check-publication.mjs --worktree
```

Migration regressions use checked-in, hash-verified legacy fixtures. Tests use synthetic records and disposable local storage; OAuth tests also need the two separately locked dependency installations. Zero discovered tests and unapproved skips fail the aggregate runner. See [CONTRIBUTING.md](CONTRIBUTING.md) for focused commands and pull request guidance.

```text
server/             HTTP API, SQLite storage, administration, and tests
plugins/mnemuron/   ChatGPT / Codex plugin
adapters/           OpenClaw, Hermes, and optional read-only HTTP MCP integrations
services/oauth/     Optional password + TOTP authorization service
web/console/        Same-origin desktop console, themes and bilingual catalogue
shared/             Shared OAuth/gateway boundary helpers
scripts/            Benchmarks, regression runners, and publication checks
docs/               Guides, specifications, and test plans
```

## Current boundaries

- Single-owner by default, with opt-in account isolation and a desktop console. This is not a managed multi-tenant service or a production certification.
- Lexical/FTS retrieval works without models. Optional, operator-configured embedding and Qdrant modules provide hybrid/semantic retrieval; query egress approval and budgets remain required. Hybrid fallback is marked; unavailable semantic search is an error, not a fabricated success.
- Derived summaries preserve source revisions and coverage. Read-only summary retrieval never schedules a model; see [Memory First](docs/memory-first-v0.1/README.md).
- Automatic summaries can omit context. Source records and explicit task state remain distinct.
- Capture and delivery depend on host hooks and permissions; complete capture across arbitrary hosts is not guaranteed.
- Test plans describe acceptance requirements, not a production certification or deployment history.

## Contributing and feedback

Bug reports, documentation improvements, and focused patches are welcome. Start with the [contribution guide](CONTRIBUTING.md), [report a bug](https://github.com/Conner512/Mnemuron/issues/new?template=bug_report.yml), or [suggest an improvement](https://github.com/Conner512/Mnemuron/issues/new?template=feature_request.yml).

Use synthetic examples in reports. Do not attach real conversations, memory exports, credentials, databases, or private infrastructure details. See the [publication policy](docs/publication-policy.md).

## License

Mnemuron is licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for attribution. Third-party runtimes and agent hosts retain their own licenses.

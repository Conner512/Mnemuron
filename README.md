# Mnemuron

**Self-hosted task continuity and structured memory for AI agents.**

English · [简体中文](README.zh-CN.md)

Mnemuron helps an agent pick up work started in another session, on another device, or in another agent host. It keeps task state, source records, and reusable memories separate, then prepares a reviewable context packet when you want to continue.

The central service stores data in SQLite. Adapters connect agent lifecycle events to the service and keep a local outbox when it is unavailable. There is no required cloud memory service or external vector database.

> **Status: experimental.** The project targets a single user's self-hosted workspace. APIs, schemas, and host integrations may change. `production_ready` remains `false`; adapter availability is not a claim that every host version or deployment is supported.

## Why Mnemuron?

- **Continue work without starting over.** Discover a project, select a task or source branch, review its Resume Preview, and explicitly confirm before delivery.
- **Keep context tied to its source.** Records retain their agent, session, and workstream provenance. Resuming a task preserves the destination agent's workstream.
- **Distinguish facts from summaries.** Canonical task state, automatically derived checkpoints, and structured memories are separate records—not interchangeable versions of the truth.
- **Retrieve and revise memory.** Search scoped memories with SQLite FTS5, inspect full content, and supersede or retract records while retaining lifecycle history.
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
mkdir -p .dev

MNEMURON_HOST=127.0.0.1 \
MNEMURON_PORT=47831 \
MNEMURON_DATABASE_PATH="$PWD/.dev/mnemuron.sqlite3" \
  node server/bin/mnemuron-server.mjs
```

In a second terminal:

```bash
curl --fail http://127.0.0.1:47831/livez
curl --fail http://127.0.0.1:47831/readyz
```

These check process liveness and database readiness. They do **not** verify search, adapter capture, or a Resume handoff. Stop the server with `Ctrl+C`; the database stays in `.dev/`, which is ignored by Git.

**Next: [create an agent credential, save a memory, and query it](docs/getting-started.md).** This local example does not install a host plugin or expose the service to the network. Use HTTPS and separate agent credentials for remote clients.

## Agent integrations

| Integration | Implementation | Start here |
| --- | --- | --- |
| ChatGPT / Codex plugin | Local MCP server, Skill, and host lifecycle hooks; MCP Delivery Receipt flow | [Plugin guide](plugins/mnemuron/README.md) |
| OpenClaw | Native plugin, lifecycle hooks, and `/mnemuron` commands | [Adapter guide](adapters/openclaw/README.md) |
| Hermes | Python user plugin, lifecycle hooks, and `/mnemuron` commands | [Adapter guide](adapters/hermes/README.md) |

These are source integrations, not a universal installer. Host plugin loading, hook permissions, and session identity must be verified in the target host. An MCP connection alone does not prove that lifecycle capture or completion ACKs are working. A ChatGPT web OAuth connector is not included.

## Documentation

- [Getting started](docs/getting-started.md) — a local, authenticated API walkthrough.
- [Documentation index](docs/README.md) — concepts, protocol contracts, adapters, and operations.
- [Core specification](docs/core-spec-v0.1.md) — the data model and continuity boundaries.
- [Deployment guide](docs/pve-lxc-deployment-v0.1.md) — an optional Linux/LXC deployment example; Proxmox is not required by the core API.
- [Core optimization notes](docs/core-optimization-v0.2/release-notes.md) and [retrieval/sync review](docs/core-review-v0.3/README.md) — implementation changes and compatibility notes.

## Development

From a full Git clone, run:

```bash
npm test
node scripts/check-publication.mjs --worktree
```

Migration regressions read earlier source revisions from Git, so a ZIP download or shallow clone is not sufficient for the full suite. Tests use synthetic records and disposable local storage. See [CONTRIBUTING.md](CONTRIBUTING.md) for focused test commands and pull request guidance.

```text
server/             HTTP API, SQLite storage, administration, and tests
plugins/mnemuron/   ChatGPT / Codex plugin
adapters/           OpenClaw and Hermes integrations
scripts/            Benchmarks, regression runners, and publication checks
docs/               Guides, specifications, and test plans
```

## Current boundaries

- Built for single-user self-hosting, not a managed multi-tenant service.
- Retrieval is lexical/FTS-based, not embedding-based semantic search.
- Automatic summaries can omit context. Source records and explicit task state remain distinct.
- Capture and delivery depend on host hooks and permissions; complete capture across arbitrary hosts is not guaranteed.
- Test plans describe acceptance requirements, not a production certification or deployment history.

## Contributing and feedback

Bug reports, documentation improvements, and focused patches are welcome. Start with the [contribution guide](CONTRIBUTING.md), [report a bug](https://github.com/Conner512/Mnemuron/issues/new?template=bug_report.yml), or [suggest an improvement](https://github.com/Conner512/Mnemuron/issues/new?template=feature_request.yml).

Use synthetic examples in reports. Do not attach real conversations, memory exports, credentials, databases, or private infrastructure details. See the [publication policy](docs/publication-policy.md).

## License

A license has not been selected yet. This public repository does not currently grant an open-source license; please do not assume reuse or redistribution rights until a `LICENSE` file is added.

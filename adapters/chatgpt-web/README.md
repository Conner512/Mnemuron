# Mnemuron HTTP MCP gateway

Default and legacy connections remain readonly. The opt-in [cloud memory Phase A contract](../../docs/cloud-memory-phase-a.md) adds a separately bound `memory_readwrite` profile, with explicit OAuth consent, version checks and durable receipts. [Personal connections](../../docs/cloud-connections.md) adds configured OAuth clients and an explicitly gated `/mcp/generic` resource for finite personal tokens. No handoff or administrative proxy is exposed.

Optional stateless Streamable HTTP adapter using the official MCP SDK. Every protected request validates an opaque access token with the fixed authorization service, then maps its immutable subject to one local owner. This is not the stdio plugin and does not provide capture, Task Scope changes, Resume confirmation or Stop ACKs.

The `auth_only` profile registers one diagnostic tool and never reads Core. The `readonly` profile also registers memory search, single-memory detail, and project context preview, using a dedicated Core key with exactly `memory:read` and `resume:read`.

Project preview is a compatibility memory listing, not Task restoration. Omitted details are explicit; use memory search and paginated single-memory reads for full content. Oversized read responses are rejected without widening limits. Write receipts reserve their bounded output before mutation; uncertain post-commit delivery is recovered by operation ID.

See the [OAuth guide](../../docs/chatgpt-web-oauth-v0.1/README.md) and [deployment checklist](../../docs/chatgpt-web-oauth-v0.1/deployment-inputs.md). Keep the complete repository layout, including `shared/` and `services/oauth/` for the test fixtures.

From the repository root with Node.js 24 LTS:

```bash
npm ci --prefix services/oauth --ignore-scripts
npm ci --prefix adapters/chatgpt-web --ignore-scripts
npm run test:oauth
```

No deployment is performed by installation or testing. LICENSE and NOTICE cover this component; installed dependencies retain their own licenses.

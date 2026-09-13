# Mnemuron read-only HTTP MCP gateway

Optional stateless Streamable HTTP adapter using the official MCP SDK. Every protected request validates an opaque access token with the fixed authorization service, then maps its immutable subject to one local owner. This is not the stdio plugin and does not provide capture, Task Scope changes, Resume confirmation or Stop ACKs.

The `auth_only` profile registers one diagnostic tool and never reads Core. The `readonly` profile also registers memory search, single-memory detail, and project context preview, using a dedicated Core key with exactly `memory:read` and `resume:read`.

If a project preview exceeds the complete MCP response budget, the gateway returns an explicitly marked summary with task versions, memory IDs, and provenance. Omitted details are listed; use memory search and paginated single-memory reads for full content. Responses that still exceed the budget are rejected, without widening limits or permissions.

See the [OAuth guide](../../docs/chatgpt-web-oauth-v0.1/README.md) and [deployment checklist](../../docs/chatgpt-web-oauth-v0.1/deployment-inputs.md). Keep the complete repository layout, including `shared/` and `services/oauth/` for the test fixtures.

From the repository root with Node.js 24 LTS:

```bash
npm ci --prefix services/oauth --ignore-scripts
npm ci --prefix adapters/chatgpt-web --ignore-scripts
npm run test:oauth
```

No deployment is performed by installation or testing. LICENSE and NOTICE cover this component; installed dependencies retain their own licenses.

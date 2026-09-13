# OAuth and read-only ChatGPT Web MCP

An optional, experimental connection for reading Mnemuron from an OAuth-capable remote MCP client. It is separate from the local ChatGPT / Codex plugin. Local synthetic integration tests do **not** establish compatibility with a particular ChatGPT account, public proxy, or deployment.

## Architecture and scope

```text
Browser ── password + TOTP + consent ──► Authorization service ──► private auth SQLite
ChatGPT ── opaque access token ────────► Stateless HTTP MCP gateway
                                         ├─► fixed AS introspection (separate secret)
                                         └─► private Core API (minimum-scope key)
```

The authorization service uses `oidc-provider`, one pre-registered confidential ChatGPT client, authorization code + mandatory S256 PKCE, and a single fixed resource. A different client authenticates the gateway's introspection requests; it cannot authorize users or issue tokens. There is no dynamic registration, password grant, public administration API, or development login shortcut.

The gateway uses the official MCP SDK's stateless Streamable HTTP transport. Every protected request, including initialization, tool discovery, calls, and notifications, is authenticated again. Opaque access tokens are checked by the configured authorization server, not parsed as JWTs. There is no positive introspection cache or token passthrough to Core.

| Mode / profile | Available behavior | Core access |
| --- | --- | --- |
| `bootstrap_metadata_only` | Public discovery; `/mcp` returns a 401 challenge; authorization is unavailable | None; no core credential read |
| `oauth` + `auth_only` | Real login/consent/token lifecycle; `mnemuron_auth_status` only | None |
| `oauth` + `readonly` | Diagnostic and the three business read tools below | Dedicated read-only agent credential |

| Tool | OAuth scope | Fixed Core route |
| --- | --- | --- |
| `mnemuron_auth_status` | `memory:read` | None; no personal identity in the result |
| `mnemuron_search_memories` | `memory:read` | `POST /v1/memories/query` |
| `mnemuron_get_memory` | `memory:read` | `GET /v1/memories/:id` |
| `mnemuron_preview_project_context` | `project:read` | `POST /v1/project-context/preview` |

Only the local `issuer + immutable sub` mapping selects the Core user and agent. Tool parameters and `_meta` cannot select credentials or override that identity. This is one owner's authorized data, **not** per-project OAuth access control: project and task parameters narrow a query, not the underlying grant.

The gateway does not register memory writes, Resume confirmation, task switching, hooks, capture, or arbitrary REST proxying. It does not collect complete conversations or generate Stop ACKs. Existing local API-key clients and the Preview → Confirm → next-turn delivery → Stop ACK contract are unchanged. `production_ready` remains `false`.

## Run the isolated test suite

Use **Node.js 24 LTS**, Python 3, and a full repository clone. The OAuth components have separate dependency manifests and locks; there is no root runtime dependency installation.

```bash
npm ci --prefix services/oauth --ignore-scripts
npm ci --prefix adapters/chatgpt-web --ignore-scripts
npm run test:oauth
npm test
node scripts/check-publication.mjs --worktree
```

The tests create disposable loopback servers, an independently enrolled synthetic owner, real OTPs, separate databases, and random credentials. They never use deployment configurations. The explicitly named `--isolated-fixture` option permits literal HTTP loopback only; it does not bypass password, MFA, PKCE, or scope checks. Never use it to expose real data.

See the [dependency decision](dependency-decision.md), [local verification report](implementation-report.md), and [deployment input checklist](deployment-inputs.md).

## Prepare an installation

Deployment is an operator-controlled step, not a side effect of running tests. Keep the repository layout intact: both components import `shared/`, so copying only a component directory is insufficient. The dependency directories are installed separately and must not be published with credentials or runtime data.

Start from:

- [Authorization configuration](../../services/oauth/config/auth.runtime.example.json)
- [Gateway configuration](../../adapters/chatgpt-web/config/gateway.runtime.example.json)
- [Identity mapping](../../adapters/chatgpt-web/config/identity-map.example.json)
- [Ingress allowlist](config/cloudflared.ingress.example.yml)
- [AS service unit](config/mnemuron-oauth.service.example) and [gateway service unit](config/mnemuron-web.service.example)

These examples intentionally cannot start unchanged. Supply a controlled HTTPS hostname, the exact ChatGPT callback copied from the app management page, and your own protected paths. No trailing slash, URL credentials, query, fragment, wildcard callback, or reserved example hostname is accepted in normal mode. Production startup requires a supported Node LTS release and rejects protocol debug logging through `DEBUG` or `NODE_DEBUG`.

### Public origin and route separation

The examples explicitly select `public_origin_mode=shared`: the issuer is `https://memory.example.com` and the resource is exactly `https://memory.example.com/mcp`. One public hostname does **not** mean one backend process, database, credential or authorization role. The tunnel routes paths without rewriting them:

| Public paths | Private destination |
| --- | --- |
| `/mcp`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp` | HTTP MCP gateway, loopback port 47832 |
| `/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | Authorization service, loopback port 47833 |
| `/authorize`, `/authorize/:uid`, `/token`, `/jwks`, `/revoke`, `/introspect`, `/interaction/:uid` and its login/confirm/abort actions | Authorization service, loopback port 47833 |
| Everything else, including Core `/v1/*`, health, private files and administration | Reject at ingress |

Use the exact path expressions in the ingress template, not broad prefix or catch-all forwarding. A remotely-managed Tunnel token selects the configuration held by Cloudflare; a local YAML file does not replace those remote routes. Inspect and update only the approved tunnel and hostname before starting the connector.

Shared origin changes the browser trust boundary. Do not host unrelated HTML, scripts or user uploads on this hostname. The gateway discards Cookie headers before authentication/SDK dispatch, never uses the AS login session as an MCP credential, and emits no-store, nosniff and restrictive content-security headers. AS signed HttpOnly/Secure cookies, per-interaction CSRF, explicit consent and exact issuer/resource/PKCE validation remain required.

Existing separate-origin installations remain supported: omit `public_origin_mode` or set it to `separate`, and supply different issuer/resource origins. Both services must agree on the mode. Shared origins without explicit opt-in and mismatched configurations fail closed. The isolated shared-origin test uses a third loopback listener as the ingress; this is not proof of public TLS or Cloudflare behavior.

### Co-located authorization transport

The gateway defaults to `authorization_server_transport: { "mode": "issuer_url" }`, using the canonical issuer endpoints with normal TLS validation. If the AS and gateway run on the same machine, an operator can explicitly select:

```json
"authorization_server_transport": { "mode": "loopback_http", "host": "127.0.0.1", "port": 47833 }
```

Only the gateway's fixed discovery GET and introspection POST use this local connection. Their `Host` remains the public issuer, and returned issuer, endpoint, audience, client, subject and scope checks are unchanged. Public metadata, browser redirects, the MCP resource and external HTTPS are not rewritten. This avoids changing system DNS, hosts files or existing client routes; it is not a public-IP pin or a fallback after TLS failure.

The internal hop is deliberately **unencrypted HTTP over literal IPv4 loopback**, like the local tunnel-to-AS hop; use it only for co-located services inside the same trusted host/network namespace. Remote addresses, hostnames, arbitrary endpoints, redirects and the gateway's own port are rejected. The timeout and response-size budgets apply to both transports. No new dependency or listener is added. It does not solve a browser's split-DNS routing: verify the real browser reaches the intended public entry separately.

Use separate OS users for the services. Private directories must be owned by the running service user with mode `0700`; files must be `0600`. The AS has signing/cookie keys, the ChatGPT client secret, the introspection secret, account state, and its own database. The gateway has only its copy of the introspection secret, the identity map, and, in `readonly`, a separate Core key. Neither running service needs a Core administrator key. Runtime configuration should also be owner-controlled and outside Git.

### 1. Discovery bootstrap

Fill the actual issuer/resource/host values in both configurations but leave `mode=bootstrap_metadata_only`, `tool_profile=auth_only`. Start only after the intended proxy boundaries are approved. Discovery is available without an owner or keys; `/mcp` returns 401 and `/readyz` returns 503. AS token/login endpoints are unavailable, not a demo authentication path.

Use this phase only to obtain the precise callback from ChatGPT. Both current callback shapes are recognized, but **copy the actual URI** instead of choosing one by guesswork. The AS emits `iss` on validated authorization redirects. OAuth discovery and callback requirements are documented by [OpenAI](https://developers.openai.com/plugins/build/auth).

### 2. Local owner and credentials

Run the following on the authorization host as its service user, with owner-controlled configuration. The example configuration remains in bootstrap mode during enrollment. These commands create private files and do not contact Core:

```bash
node services/oauth/bin/admin.mjs init-secrets --config /etc/mnemuron-oauth/auth.runtime.json
node services/oauth/bin/admin.mjs owner-create --config /etc/mnemuron-oauth/auth.runtime.json --username owner
node services/oauth/bin/admin.mjs owner-enrollment --config /etc/mnemuron-oauth/auth.runtime.json --output /etc/mnemuron-oauth/private/enrollment-uri
node services/oauth/bin/admin.mjs owner-enroll-mfa --config /etc/mnemuron-oauth/auth.runtime.json --recovery-output /etc/mnemuron-oauth/private/recovery-codes.json
node services/oauth/bin/admin.mjs status --config /etc/mnemuron-oauth/auth.runtime.json
```

Passwords and OTPs are prompted without echo. For non-interactive use, supply `--password-file` or `--otp-file` pointing to private files; never put their values in shell arguments. Enroll the private authenticator URI locally and protect/remove the enrollment artifact according to your secret policy. Recovery codes are written once to the private output, never printed; account state stores their hashes. Keep recovery material securely available, outside the public repository.

`owner-create` prints the newly generated immutable subject and enrollment status, not secrets. Put that subject into the gateway's identity map. Transfer only the gateway introspection secret into its separately owned secret file; do not make the AS secret directory readable by the gateway. Enter the ChatGPT client secret only in the client management interface, not a chat message. Secret initialization refuses existing files and never runs automatically on restart.

After setting the exact callback and completing MFA, switch both services to `mode=oauth`, keeping the gateway `tool_profile=auth_only`. A verified browser login session can be reused within its lifetime; offline access always requires explicit consent, including when the client omits `prompt=consent`.

### 3. Start and inspect the components

In separate service processes, using the intended LTS Node executable:

```bash
MNEMURON_OAUTH_CONFIG=/etc/mnemuron-oauth/auth.runtime.json node services/oauth/src/server.mjs
MNEMURON_WEB_CONFIG=/etc/mnemuron-web/gateway.runtime.json node adapters/chatgpt-web/src/server.mjs
```

Use the supplied service-unit templates only after replacing their install/runtime paths. `SIGTERM` closes each component normally. The AS permits one process per database; a dead-process lock can be recovered after an abnormal exit. Do not run multiple AS instances, an alternate writer, or rolling replicas against the same authorization database.

Both services validate the public `Host` even on loopback probes. For a local readiness request, supply the **actual configured hostname** as the Host header. `/livez` means the process responds. AS `/readyz` checks the owner, database integrity, and a small committed write probe in the auth database. Gateway `/readyz` checks discovery and its mapping, plus Core identity/search readiness in `readonly`. Keep all health routes out of the public ingress. A green readiness response is not a successful OAuth grant or ChatGPT tool call.

Complete a real `auth_only` ChatGPT login/consent/diagnostic test before granting data access. Record failures without passwords, tokens, authorization URLs, or cookies.

### 4. Enable the business read tools

The Core build must include authenticated `GET /v1/identity` and `GET /readyz/search`. `/v1/identity` is additive self-introspection: it returns the current credential's public identity and scopes, never the key. There is no OAuth migration of the business database. An older Core without this route is unsupported by `readonly` and fails closed; `auth_only` does not depend on it.

Set the mapping's existing Core user ID and a dedicated agent instance. Configure the Core URL as literal loopback HTTP on the same host or verified private HTTPS on another host. Do not expose Core to the public ingress or disable TLS verification.

A separate, explicit provisioning command can create the minimum-scope agent credential. It reads a protected administrator key for **this one operation only**, checks that the administrator owns the mapped user, and makes one registration request. Prepare a gateway configuration with `mode=oauth`, `tool_profile=readonly`, but keep the running gateway in `auth_only` until provisioning succeeds:

```bash
node adapters/chatgpt-web/bin/provision-core.mjs --config /etc/mnemuron-web/gateway.runtime.json --admin-file /private/operator/core-admin-token --provision
```

This is a Core write; it is not part of startup. The result key is written directly to the protected credential file, not stdout. An uncertain response requires inspecting the registration before repeating; there is no blind retry or overwrite. Remove the administrator input from the gateway's access after provisioning. Do not use an existing broad/default agent key as a substitute.

On each business read, the gateway verifies the Core credential belongs to the mapped user/agent and has **exactly** `memory:read` and `resume:read`. Extra scopes are rejected. Start/restart the gateway in `readonly` only after this check and the real diagnostic stage pass. Test the three read tools, cross-user denial, refresh, revocation, and relinking before treating the connection as accepted.

### 5. Refresh the client's tool metadata

Changing the gateway profile does not establish that an existing ChatGPT connection has loaded its new tools. If `mnemuron_auth_status` reports `readonly` but the client still lists only that diagnostic tool, inspect the saved connection's actions and refresh its metadata. For developer-mode connections, open the existing connection in ChatGPT Plugins, select **Refresh**, verify the advertised tools, then retest in a new conversation. Published plugins use reviewed metadata snapshots and require a new published version instead. See [OpenAI's metadata refresh instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).

The saved server URL must include `/mcp`. In `readonly`, expect exactly the four tools listed above; refreshing metadata must not add write, Resume or handoff capabilities. Check the returned search IDs with `mnemuron_get_memory`, follow pagination until `content_complete=true`, and compare the real tool results with successful gateway requests. An authenticated status response alone is not memory-read acceptance. Keep account-specific results and memory contents outside the repository.

## Limits, failures and maintenance

- Codes expire after 60 seconds; opaque access tokens after 300 seconds. Refresh tokens rotate on every use, with a 7-day idle and 30-day absolute family lifetime. Reusing a consumed refresh token revokes the whole grant. Browser sessions last at most 8 hours; interactions 10 minutes.
- Code/refresh mutations are serialized in a bounded single-instance queue. Consumption and grant revocation are durable. SQLite payloads and backups contain sensitive authorization material; they are **not** all hashes and are not encrypted by this implementation.
- Passwords use salted scrypt (`N=65536`, `r=8`, `p=1`, 64-byte output). TOTP permits a fixed ±30-second tolerance and rejects reused time steps. Recovery and MFA reset require local administrative access; reset invalidates grants and requires enrollment again.
- Login limits persist across restart (owner plus socket peer). Caller-supplied forwarding headers are stripped. With a local tunnel, clients share a conservative peer bucket; the gateway does not trust arbitrary `X-Forwarded-For` as a unique browser IP. This is a single-owner design, not a multi-tenant rate limiter.
- Default limits are 64 KiB request bodies, 128 KiB complete tool-call responses, four concurrent requests per subject, and 120 requests/minute per subject. Core/introspection replies and timeouts are bounded. Oversized tool responses return `422 TOOL_RESPONSE_TOO_LARGE`; narrow the query or use memory pagination. The gateway never silently claims a full result after truncating it.
- Invalid tokens return 401, insufficient scope or a denied subject 403, unavailable AS 503 `AUTH_DEPENDENCY_UNAVAILABLE`, unusable Core credentials 503 `CORE_AUTH_UNAVAILABLE`, and unavailable search 503 `SEARCH_UNAVAILABLE`. A backend failure is not a request to give ChatGPT more privileges.
- Logs contain generated request IDs, time, component, status/error category, latency, and, on authenticated gateway requests, a hashed subject and allowlisted tool name. Never enable protocol debug logs or add request bodies, query strings, cookies, or memory contents to proxy logging.

Local revocation examples (no network admin endpoint):

```bash
node services/oauth/bin/admin.mjs grant-revoke --config /etc/mnemuron-oauth/auth.runtime.json --all
node services/oauth/bin/admin.mjs owner-disable --config /etc/mnemuron-oauth/auth.runtime.json
node services/oauth/bin/admin.mjs owner-reset-mfa --config /etc/mnemuron-oauth/auth.runtime.json --recovery-code-file /private/operator/recovery-code
```

`grant-revoke` also accepts `--subject` or `--client-id`. It clears browser login state so a new link cannot silently reuse that state. Reset MFA locally with the AS stopped, enroll again, then restart; it does not reset the immutable subject. Re-enabling an owner does not restore revoked grants.

Revocation takes effect on the **next new authorization check**. It cannot retract already returned data or cancel a request that already passed authorization. `userinfo`, profile/email claims, and enterprise email-based account matching are not provided in this version.

## Rollback and authorization-database restore

To disable the optional connection, stop the gateway and remove only its approved host/path ingress rules. The existing Core, stdio plugin, and adapters do not depend on these processes. Revoke grants as appropriate; preserve private key/account/database files rather than deleting them as a rollback shortcut. Never downgrade an authorization database against incompatible code without an isolated check.

Keep authorization backups separate from business backups. Stop the AS before a simple file copy, or use a SQLite-consistent backup procedure. Do not copy only the main file of a live WAL database. An old auth backup can revive revoked grants: restore it off-network, run local `grant-revoke --all` against that restored configuration, verify no old code/access/refresh token works, then reopen ingress and require relinking. This policy does not alter memory data. Automatic restore detection or production backup automation is not included.

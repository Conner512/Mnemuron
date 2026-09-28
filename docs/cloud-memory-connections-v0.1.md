# Cloud memory connections / 云端记忆连接

This additive change connects the existing personal memory Core to managed OAuth and generic MCP credentials. It does not implement a second memory store, change local hook behavior, or grant administrators access to other users' memory. `production_ready` remains false. Related work: issue #11.

## What the cloud plugin can do

| Capability | Behavior |
| --- | --- |
| Search, full detail, sources, existing summaries | Existing bounded, owner-scoped and Web-visible reads remain unchanged |
| `mnemuron_remember` | Save an explicitly requested memory in an existing owned scope |
| `mnemuron_supersede_memory` | Check the exact current revision, preserve the old record, create a linked replacement |
| `mnemuron_retract_memory` | Check the exact revision and keep a lifecycle tombstone; not physical deletion |
| Local lifecycle capture / handoff | Not provided by a remote MCP connection. No simulated hooks, project creation, task activation, Resume or Stop ACK |
| Model classification / vectors | Continue through existing Core/worker configuration; no arbitrary model or paid-job controls are exposed as new MCP tools |

The plugin and generic MCP use the same read/write memory handlers. A connection does not silently collect entire conversations. Returned text is untrusted data; instructions tell the client to write only after an explicit request and report actual status. OpenAI host-side confirmations are additional to, not substitutes for, server authorization.

## Deployment and compatibility

Back up the Core and authorization databases consistently, along with their existing private encryption keys. Stage with synthetic accounts before deploying. Do not recreate users, change subjects, or copy runtime data into Git.

Merge this **root-level** block into both the existing authorization and gateway runtime JSON:

```json
{
  "cloud_connections": {
    "enabled": true,
    "allow_write": true,
    "max_active": 20,
    "max_ttl_days": 90
  }
}
```

- Multi-account mode is required. Omitted policy means disabled. `allow_write` cannot be true when `enabled` is false. Both switches must be explicit booleans. Quota is 1–100 active entries; maximum credential lifetime is 1–365 days. User-selected days must not exceed the installation maximum.
- The gateway retains the existing `tool_profile: "readonly"` as its baseline configuration for compatibility. Actual write tools appear only for an enabled managed connection whose verified token includes `memory:write`; `mnemuron_auth_status` then reports `readwrite`. `auth_only` never exposes memory operations.
- Install matching Core, authorization, gateway and console code. Configure/restart the new gateway **before** issuing a read/write connection. The gateway must keep an explicit `cloud_connections` block even when managed issuance is subsequently disabled, so already upgraded internal Web credentials can still serve legacy read-only grants.
- A read/write connection additionally requires the owner's console credential to have explicitly granted basic memory writes or full console writes. Follow the existing console upgrade guide; this change does not auto-upgrade a read-only console or require granting operator/admin roles.
- When an authorized owner creates their first read/write connection, Core validates and narrowly upgrades **that owner's** Web binding from `memory:read,resume:read` to the same scopes plus `memory:write`. It does not return the internal token, change account IDs, or expand existing OAuth grants. Old gateway binaries do not understand that exact scope set: do not issue new connections with an old gateway running.
- The existing static OAuth Client ID/Secret and its grants remain read-only. Existing local agents and `mnm_` credentials are not converted to MCP tokens. The new `mnmc_` credentials are deliberately rejected by direct Core REST authentication.
- Tables `identity_cloud_connections` and `memory_cloud_operations` are additive. Old authorization binaries can reject the expanded identity schema. Rollback is coordinated code/configuration plus an appropriate consistent backup, not deletion of unknown tables or forced credential downgrade.
- The same `/mcp`, OAuth, `/console-api/connections`, `/console-api/action` and existing asset paths are used. Two new `/v1/...` Core routes are internal only and must NOT be exposed through public ingress. Keep private Core and introspection boundaries. No Cloudflare configuration is changed by this PR.

## Connection management

The desktop page has three setup entries: **ChatGPT plugin**, **General MCP**, and **Agent templates (reserved)**. New managed connections have an active/history/all view, name/ID search, type filter and 20-item pagination. OAuth grants, active legacy Agent credentials, internal bindings and legacy revoked/expired credentials are separate collapsed sections. Old records are retained. Legacy Core inventory is bounded to 100 rows and warns when truncated; it is not a complete historical export.

Each managed connection has a name, kind, explicit permission and expiration. Issuance, rotation and revocation require a current console session, exact account binding, CSRF/Origin checks, password and an unused TOTP. There is no auto-admin or shared password/key fallback.

The status timestamp is **last token verification**, not proof of a physical device, a successful model response, or that a client consumed memory. A revoked/expired credential is not revived by replaying a response receipt.

### ChatGPT plugin

1. Open ChatGPT's developer plugin creation UI and enter the MCP address from Mnemuron. Use the current exact redirect URI displayed by ChatGPT. Do not copy a temporary `/interaction/...` URL.
2. In Mnemuron choose **Add connection → ChatGPT plugin → Generate connection**, provide a recognizable name, read-only or read/write permission, lifetime and that redirect URI, then reauthenticate.
3. Copy the issued **Client ID, Client Secret and complete MCP URL** into ChatGPT's predefined OAuth-client configuration. These are dedicated to this connection, not the installation-wide client secret or an internal `mnm_` key.
4. Complete username/password/TOTP login at Mnemuron and review the scope consent. The OAuth client belongs to the account that created it; another Mnemuron account cannot authorize it. Install/select the cloud plugin in a new Work conversation, inspect `mnemuron_auth_status`, and test with an explicitly synthetic memory.
5. For read/write acceptance, save a synthetic record, open a separate conversation/transport, read the same `memory_id`, then explicitly correct or retract it. UI presence alone is not evidence that ChatGPT performed a tool call.

Production redirects are exact HTTPS URLs on `chatgpt.com`, either `/connector_platform_oauth_redirect` or `/connector/oauth/<callback_id>`. No wildcard, query, fragment, userinfo or ambiguous normalization is accepted. A future host callback format needs an explicit reviewed allowlist update. Loopback callbacks are permitted only by the existing isolated test mode.

The owner chooses read/write before credentials are issued. Its MCP URL includes `?access=readwrite`; copy it intact. This public hint requests the write scope during discovery; it never grants authorization. The canonical protected resource and token audience remain the configured base `/mcp`. The unqualified legacy `/mcp` URL continues to request read-only scopes, so old static clients do not acquire an invalid expanded authorization request. A read/write client can also choose a narrower read-only consent; writes then remain unavailable. Never change a callback or requested scope merely to get an error to disappear.

Pre-registration is authenticated through the console, not a public Dynamic Client Registration endpoint. Existing PKCE S256, single-use authorization codes, refresh rotation, issuer identification and token introspection remain in use. Client rotation intentionally changes both Client ID and Client Secret, invalidates old authorization, and requires updating ChatGPT plus a new consent.

### General remote MCP

Choose **Add connection → General MCP**. Select read-only or read/write, set an expiry, reauthenticate, and copy the issued bearer token into the client's protected secret storage. Use the complete issued endpoint and Streamable HTTP. Example only; replace placeholders locally and never commit the credential:

```json
{
  "mcpServers": {
    "mnemuron": {
      "url": "https://memory.example.com/mcp?access=readwrite",
      "headers": {
        "Authorization": "Bearer <YOUR_MCP_ACCESS_TOKEN>"
      }
    }
  }
}
```

Client schemas differ; the example shows the endpoint and header contract rather than claiming all clients use the same JSON. An OAuth-only client that cannot supply a bearer header needs a suitable OAuth integration; do not label it connected using this token recipe. No local stdio bridge, command execution or filesystem access is introduced by this mode.

The token has 256 random bits, an expiry, one resource audience and fixed memory scopes. Only its hash is stored in the connection table. It is validated through the existing authenticated AS introspection channel on each gateway request. A browser cookie, a client secret, an ID/refresh token or a raw Core key cannot be substituted. Rotation changes the token; old values are immediately inactive at the next check.

### Agents reserved

Codex, Claude Code, Cursor, OpenClaw and Hermes have clearly marked placeholder cards. They do not run installers or mint imaginary adapter configurations. Existing local adapters continue separately; a compatible client's generic HTTP MCP configuration may use the general recipe above.

## Secret and lifecycle rules

OAuth Client Secrets are encrypted using the existing private identity key. Generic MCP access tokens are hashed. Neither secret, ciphertext nor token hash is returned in list/guide APIs. Initial issuance returns the secret; close the dialog after securely saving it. Exact same-account operation retries may recover the **same encrypted issuance response for 600 seconds** to tolerate a lost response. This is not an unlimited reveal-secret API. Inspecting the connection later only returns configuration metadata; rotate to recover access after losing a secret.

Password/TOTP changes, verified recovery and account security-version changes invalidate managed clients and tokens. Rotation requires fresh normal login and factors. Existing expiry is retained during rotation. Revocation is owner-scoped; no one can revoke or rotate another account's connection through an identifier. Disabling the cloud feature makes managed tokens inactive while retaining metadata and old static read-only access. List states distinguish active, revoked, expired, reauthorize and disabled.

## Memory write contract

All writes require a verified connection `memory:write` scope and the exact server-verified owner Web credential. The browser or model never selects an arbitrary `user_id`, internal connection identity or destination credential.

- `operation_id` is required. Repeating the same operation/payload for the same authoritative connection returns the persistent result. Reusing it with different content produces `IDEMPOTENCY_CONFLICT`. Rotation uses a new client identity; clients should not intentionally retry old operations under newly rotated credentials.
- Creation and correction require explicit `allow_future_read: true/false`. True grants only the resulting new memory's exact revision for subsequent cloud reads. False saves it privately and returns `web_readable:false`; do not claim it will be found from another ChatGPT conversation.
- Correction and retraction require the current revision of an existing, Web-visible, owned record. Hidden, secret or foreign IDs cannot be changed. A version change requires re-reading and renewed user intent, not blindly retrying a stale correction.
- Writes preserve original facts/versions and provenance. Correction does not overwrite a canonical task. Retraction does not physically delete data. Memory, exact-revision grants, idempotency receipt and audit are committed together. Audit failure rolls back the transaction.
- Evidence is labelled `tool_submitted` and not independently fact checked. There is no claim to have captured the full user's conversation. No raw memory body or credential is added to request logs.

## Verification and release gate

Focused tests are `adapters/chatgpt-web/test/cloud-memory.test.mjs` and `services/oauth/test/cloud-connections-ui.test.mjs`. They exercise actual Core/AS/gateway HTTP, OAuth and SDK transports, persistence/restart, rollback, negative authorization, expiry, readonly compatibility, scope discovery and source lifecycle. The browser workflow extends existing actual form and CSP tests with setup, credential issuance/rotation/revocation, filtering and desktop themes; it never screenshots generated secrets.

Run existing isolated suites as well as these additions; do not disable the tests, CSP, MFA or tenancy checks. All fixture accounts, ports, keys and databases are synthetic/disposable. Local or CI success is not a completed real ChatGPT login, a production deployment, or a promise that every client will automatically call a memory tool each turn.

Protocol reference: OpenAI plugin authentication <https://developers.openai.com/plugins/build/auth>, Developer mode <https://developers.openai.com/api/docs/guides/developer-mode>, and MCP authorization <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>. Recheck host UI/callback changes at deployment.

# Cloud memory connections

This opt-in extension builds on [cloud memory writes](cloud-memory-phase-a.md).
It adds owner-scoped logical connections, personal OAuth clients, finite resource
tokens and a real console wizard. It does not add handoff, host Hooks, anonymous
client registration, shared spaces, or an administrative proxy.

## Objects and permissions

A logical connection owns its OAuth client or personal tokens, credential
versions, grants and activity. Its owner comes from the authenticated console
session, never a form parameter. `identity.connection_management` is independent
of operator roles, model configuration and console memory-write permissions.
Sensitive changes require the existing CSRF, password and fresh TOTP checks.

Configuration (`draft`, `ready`, `disabled`, `revoked`) and evidence of use are
separate. Missing callbacks or pending identity publication cannot authorize a
memory request. OAuth consent records authorization; only a successful real
memory tool call records verification. Authentication status and readiness probes
do not. Failed memory calls retain the last-success time and a bounded error code;
this is historical evidence, not proof of present client connectivity or a
physical device identity.

The current list aggregates logical connections, not every grant or key version.
Search, type/profile/state filters and pagination execute on owner-scoped SQL.
Revoked and expired entries are in history. Internal credentials and legacy
shared-client grants remain separate, preserved and never grouped by display
name or address. Revoking one OAuth grant is distinct from revoking a connection.
No internal Core key is displayed or issued by this wizard.

## Operator configuration

Use multi-account identity mode and the existing **isolated maintenance worker**.
The in-process maintenance mode is not a connection-provisioning substitute.
First enable the Phase A memory contract without replacing old readonly keys.
The following policy is an example requiring an operator's explicit adoption;
there is no implicit production default:

```json
{
  "enabled": true,
  "max_connections": 20,
  "pat_default_ttl_seconds": 2592000,
  "pat_max_ttl_seconds": 7776000,
  "secret_receipt_ttl_seconds": 300,
  "rotation_overlap_seconds": 0
}
```

Place that object at `identity.connection_management` in the OAuth runtime.
Set `connection_management: true` separately in the gateway and isolated worker
runtimes. Omission/false disables new connection use; do not conflate the three
files or grant the OAuth service access to Core storage. Keep its registry
encryption key in its existing private key file, outside source control.

Set `cloud_memory.enabled` independently in Core's memory runtime, OAuth, gateway
and worker. `allow_submitted_revision_grant` may be true only after approving its
meaning: an explicitly submitted version may be read by other authorized cloud
connections **of the same account**. The connection checkbox merely permits that
request; each save/correction must also choose `allow_submitted_revision`.
Old memories are not opened. Secret content remains excluded. Readonly profiles
cannot request this grant or write. Old shared-client access and refresh tokens
remain readonly until a separate explicit upgrade and new consent.

The policy permits 1–100 logical connections, finite PATs no longer than 90 days,
and secret receipt windows no longer than 5 minutes. The deployment must supply
all values. Nonrevoked connections consume quota, including disabled/expired
ones. Revoke an unused connection to release its slot. OAuth Client Secrets last
until rotation/revocation, independently of access-token/PAT/invitation lifetimes.

## Using the console

1. Open Connections, choose Add connection, then ChatGPT Web or Generic MCP.
2. Enter its purpose/name and readonly or memory-readwrite profile. Read the
   per-version disclosure explanation; choose a finite lifetime for a PAT.
3. Reauthenticate and securely save the resulting **Client ID + Client Secret**
   or **resource PAT**. No automatic clipboard copy or browser persistence occurs.
4. For ChatGPT, create a custom MCP connection using the displayed URL and
   OAuth `client_secret_post`. Copy the exact callback shown by that client's
   management UI back into Mnemuron. Do not use an interaction URL as a callback.
5. Wait for secure identity publication, complete username/password/TOTP and
   explicit consent in Mnemuron, then call a memory tool from the client.

The deployed callback must exactly match the configured HTTPS callback family;
wildcards, encoded paths, fragments, alternate hosts and query parameters are
rejected. The supported families are the platform redirect and per-connector
redirect published by ChatGPT. Authentication documentation was checked on
2026-09-28: [OpenAI authentication](https://developers.openai.com/plugins/build/auth).
Client UI names and availability may change. ChatGPT Web, Work and other clients
require their own real-client validation; appearing in a tool list is not it.

Parameter templates contain placeholders, never saved secrets. Metadata APIs
return `has_secret` and credential version, not recoverable plaintext. If a
generation response is lost, retry the same action/operation ID and parameters
in the **same login** during the configured receipt window. A different login,
changed intent, elapsed window or invalidated connection cannot recover it.
Encrypted short-lived receipts are pruned; rotate if the secret was not saved.

Rotation invalidates old access/refresh/PAT credentials immediately. Disable
blocks all connection access; enable generates new credentials. Revoke is final
for that logical record but never deletes memories. Callback/profile updates also
invalidate old grants; refresh the client's tool definitions and authorize again.
After an account security-version change, recreate/rotate the connection binding
from a fresh login. An old credential cannot inherit the new account version.

## Transports and actual support

| Client capability | Entry and requirement |
| --- | --- |
| Streamable HTTP with configured OAuth | Existing `/mcp`, exact approved callback, PKCE S256, explicit consent and resource validation |
| Streamable HTTP with custom Authorization header | `/mcp/generic`, `Authorization: Bearer <YOUR_PRIVATE_TOKEN>` |
| stdio-only or no custom authentication | Requires an adapter; this URL/template is not directly compatible |
| Other Agent card | Reserved, explicitly unavailable; no simulated installation |

The PAT is a product compatibility mode, not a replacement for ChatGPT OAuth or
a universal MCP configuration format. Do not put it in a URL, query string,
chat, log, source tree or localStorage. `/mcp` rejects PATs; `/mcp/generic` rejects
OAuth tokens and wrong-resource credentials. Standard OAuth is available through
the existing trusted registration contract; arbitrary generic OAuth callback
self-registration is **not** provided. No DCR or CIMD was added.

The guide includes URL/resource, transport, timeout suggestion, scopes and tools.
Use MCP SDK initialize, tools/list and tools/call to verify a client, not GET 200.
For 401, check expiry, rotation/revocation and the correct credential kind. For
403, check scopes/current identity publication; refreshing a readonly grant does
not add writes. `invalid_client` can mean a missing callback, pending binding or
rotated secret. After a timeout during a write, query the same operation ID before
retrying. Retraction is lifecycle change, not physical deletion.

## Migration, ingress and downgrade

Five additive OAuth tables preserve account IDs, old grants and data:
`identity_connections`, `identity_connection_tokens`,
`identity_connection_operations`, `identity_connection_activity`, and
`identity_connection_credentials`. Durable encrypted `identity_operations` reuse
the existing worker coordination. Prepare/apply/publish/ack phases retain a fixed
credential ID after interruption and reject stale connection/account versions.
Authorization rechecks live state on every MCP request, even before an asynchronous
Core-key revocation completes. No external token is forwarded to Core.

Back up both stores/configuration; validate the candidate against disposable data
and prepare a compatible rollback binary. The old strict OAuth store rejects
unknown tables: its rollback allowlist must recognize these five tables (and the
Phase A table) without exposing their operations. Never drop populated tables or
restore an old database over newer user writes just to roll back code.

Only two ingress additions are needed: `/assets/connections.mjs` to the OAuth/
console service and `/mcp/generic` to the existing gateway. Extend exact existing
rules as shown in [the unapplied ingress example](console-ingress.example.yml).
Do not replace unrelated rules, change DNS or expose Core/admin/database routes.

To disable new connection issuance/use, turn off the three connection gates.
Existing legacy readonly mappings remain intact. To disable writes but retain
personal reads, turn off cloud-write flags, use the readonly gateway profile and
revoke/re-authorize affected write grants; old tokens containing removed scopes
must fail closed. Do not change bindings in place to silently enlarge authority.

## Reproducible validation

Run `node scripts/test-all.mjs`. Registry, BFF, isolated worker and real loopback
OAuth/MCP SDK tests use synthetic users/databases. `scripts/test-console-connections.mjs`
uses an already installed Playwright module specified by `PLAYWRIGHT_MODULE`, an
optional `CHROMIUM_EXECUTABLE`, and a private, **outside-worktree**
`MNEMURON_UI_EVIDENCE` directory. It verifies actual HTTP assets/CSP, both wizards,
account separation, credential lifecycle/cleanup, desktop themes/languages and
existing memory/model/job/registration interactions. It does not install software,
call paid models, use real credentials, or read production personal memory.

Keep actual logs/screenshots/deployment identifiers outside Git. Synthetic local
success, PVE deployment, public ingress and real-client validation are separate
claims. `production_ready` remains false.

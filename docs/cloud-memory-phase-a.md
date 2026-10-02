# Cloud memory writes — Phase A

This opt-in extension adds memory operations to the existing OAuth MCP gateway. It does not add a connection-management UI, personal access tokens, new OAuth clients, handoff, model configuration or unrestricted Core access. `auth_only` and `readonly` remain compatible. Local host Hooks remain independent.

## Authority and contracts

| Profile / principal | Tools | Core credential |
| --- | --- | --- |
| `auth_only` | Authentication status | None |
| `readonly` | Existing memory reads | Existing exact `memory:read resume:read` key |
| `memory_readwrite`, old readonly grant | Existing memory reads | Original readonly key |
| `memory_readwrite`, explicitly provisioned account and new write grant | Reads plus the four tools below | Separate exact `memory:read resume:read memory:write` key, bound to account/version/connection |

The deployment profile, current account, OAuth scope, immutable connection binding, internal credential and target visibility all constrain an operation. The model cannot supply owner, role, confirmation, key, URL, SQL or filesystem authority. OAuth tokens are never forwarded to Core. There is no shared mutable owner credential.

The four tools are `mnemuron_save_memory`, `mnemuron_supersede_memory`, `mnemuron_retract_memory`, and the metadata-only `mnemuron_get_operation`. Save supports `scope=user` without a Task, Workstream, Hook or Resume. Other scopes use existing owned IDs. Correction/retraction require an owned, currently Web-visible record, its exact `expected_revision` and a reason. Correction creates a new record and supersedes the old one; retraction changes lifecycle, not physical history.

The internal gateway allowlist adds only `POST /v1/cloud-memory/operations` and `GET /v1/cloud-memory/operations/:operation_id?connection_id=...`. Keep these behind the existing loopback Core boundary; no new public Core route is required.

## Save is not permission to disclose

Save and correction require an explicit `cloud_read` value:

- `keep_private`: an explicit, owner-scoped Web denial, overriding account `read_all`, public classification and grants. Result and receipt contain metadata only, never the submitted body. The denial survives metadata/lifecycle changes and local corrections; only an explicit, reviewed current-version allow can release it.
- `allow_submitted_revision`: disabled unless explicitly approved in the deployment, connection binding and OAuth consent. It grants **only the final version submitted by this operation**. The existing grant is account-level: other authorized cloud readers of this account may read it too. It is not a current-connection-only grant. It cannot grant arbitrary existing records, copy old sources, or change sensitive content to public. Secret records remain inaccessible.

Until that deployment policy is approved, use `allow_submitted_revision_grant: false`. The permission failure is explicit; private saving still works. Changes to content, privacy or lifecycle invalidate old version grants.

Cloud provenance is `capture_mode=tool_only`, `evidence_kind=model_submitted`, with account, connection, credential, operation and version metadata. It is not a captured user utterance, fact-checked assertion or fabricated Hook. Returned memory text is untrusted data, not instructions.

## Reliable results

All writes require a stable `operation_id`. A new intent gets a new ID; a retry reuses the same ID and exact parameters. The fingerprint preserves punctuation, content, expected version, action and disclosure choice. Same operation plus different parameters returns `IDEMPOTENCY_CONFLICT`.

Memory, revision, source, outboxes, audit, optional grant and receipt commit atomically in Core. Database uniqueness and transactions protect concurrent retries; neither an in-process lock nor an MCP session is the authority. `status=committed` and `saved=true` are returned only after commit.

Receipts have `receipt_semantics=commit_snapshot`: a replay reports the original commit, not current visibility/lifecycle, and cannot revive a later retracted record. Revoked credentials cannot query old receipts. Another account or connection cannot query them.

Before a write, the gateway reserves an 8 KiB response envelope for the at-most-2 KiB metadata receipt. Network loss or invalid post-commit output returns `OPERATION_STATUS_UNKNOWN` with `next_action=query_same_operation`. Query the same ID; do not interpret uncertainty as failure, or retry with a new ID. A not-found query alone does not prove an in-flight write cannot commit. Read pagination still preserves revision and source-version pins.

## Operator activation (private files only)

1. Back up configuration and the separate SQLite stores. Stop/schedule affected services using the normal deployment procedure. Preserve service uid/gid separation and all existing credentials.
2. Add `"cloud_memory":{"enabled":true,"allow_submitted_revision_grant":false}` to Core's memory runtime, OAuth runtime, gateway runtime and isolated identity-worker configuration. Omission keeps the feature off. Set the grant flag true only after approving its account-wide disclosure meaning.
3. Add `memory:write` to OAuth `resource_scopes`, OAuth `chatgpt_client.allowed_scopes` and gateway `requested_scopes`. Do not add other privileged scopes, weaken resource/client checks, or change redirects.
4. Set gateway `tool_profile` to `memory_readwrite`. Preserve old read-tool entries, and add these entries to `tools` (all four are required):

```json
{
  "mnemuron_save_memory": {"required_scope":"memory:write","profile":["memory_readwrite"]},
  "mnemuron_supersede_memory": {"required_scope":"memory:write","profile":["memory_readwrite"]},
  "mnemuron_retract_memory": {"required_scope":"memory:write","profile":["memory_readwrite"]},
  "mnemuron_get_operation": {"required_scope":"memory:write","profile":["memory_readwrite"]}
}
```

The new profile inherits the existing read tools; keep their old profile arrays and keep `core.required_internal_scopes` at the old readonly pair. Write authority uses a **separate** `mapping.cloud_write` supplied by the maintenance worker, not the readonly key.

5. Select an existing eligible account deliberately. As the existing OAuth service OS identity, queue its binding (example paths and ID, not runnable defaults):

```bash
node services/oauth/bin/identity.mjs cloud-enable \
  --config /private/auth.runtime.json --account-id example-account \
  --cloud-read keep_private --confirm
```

Use `--cloud-read allow_submitted_revision` only when that policy is approved. The normal privileged, local-only `identity-worker.mjs --config /private/worker.json --once` consumes the durable encrypted operation, applies one Core credential under the Core OS identity, publishes it under the gateway OS identity, and acknowledges it under the OAuth OS identity. No public administrative endpoint or cross-service database permission is added. Repeating interrupted work reuses the same credential. Stale account versions cannot publish a usable binding. A policy change on an existing queued operation is refused; it is not an implicit upgrade.

6. Refresh the client's discovered tool schema and perform a **new explicit OAuth authorization** requesting `memory:write`. Old access/refresh tokens remain readonly and cannot acquire write permission by refreshing. In multi-account mode a missing prepared binding blocks write consent. No account is automatically enrolled by deployment.

Phase A supports the existing operator-registered OAuth client only. A trusted connection key is derived from issuer, client and subject; it is not a physical-device assertion. It deliberately does not claim Phase B's connection registry or general credential UI.

## Additive migration and downgrade

Core adds `cloud_memory_bindings`, `cloud_memory_operations` and `memory_web_denials`; OAuth adds `identity_cloud_bindings` and reuses the existing encrypted durable operation queue. Existing memory IDs, subjects, users, revisions and sources are not rewritten. All new tables have explicit owner classifications.

The private-denial migration atomically backfills earlier committed `keep_private` choices and their local replacements, except records with a valid current explicit grant. A one-time settings marker prevents a later reviewed allow from being undone on restart. Original commit-snapshot receipts are not rewritten: an old receipt may still say `cloud_readable=true` even though present access is denied. Current reads, not historical receipts, determine current visibility. Portable exports preserve denials with optional `cloud_private: true`; imports validate that boolean and preserve the restriction. Legacy records without the field retain their existing import semantics.

Do not roll back Core to code that ignores `memory_web_denials` while cloud reads remain enabled. Such a rollback would reopen the original privacy defect; retain the corrected enforcement layer or block cloud traffic until it is restored. The migration neither deletes original data nor changes the account-wide read policy.

To disable writes without losing data: set gateway back to `readonly`, remove the four write-tool config entries, remove `memory:write` from advertised/requested scopes, disable all cloud flags, and revoke dedicated cloud credentials/grants through the existing private maintenance boundary. Never rotate or replace old readonly credentials just to enable or disable this feature. Keep receipts and history.

For a code rollback, Core's additive tables can remain. **Older OAuth/identity-worker code rejects unknown database tables.** Prepare a compatible rollback build that recognizes only the new `identity_cloud_bindings` table before switching, or retain the new backward-compatible auth storage layer. Do not drop populated tables or restore an old database over newer user activity. No destructive down-migration is supplied.

## Verification and release boundary

Run the aggregate suite (`node scripts/test-all.mjs`) and the focused tests in `server/test/cloud-memory.test.mjs`, `adapters/chatgpt-web/test/cloud-memory.test.mjs`, and `services/oauth/test/isolated-maintenance.test.mjs`. Tests use synthetic users, real local OAuth/PKCE flows, the installed MCP SDK, disposable databases and loopback services. They do not call paid models, production memory or a real ChatGPT account.

Record actual results and deployments outside Git. Local/isolated success is not real-client acceptance or production readiness. Verify login, consent, discovery, old readonly behavior and an explicitly authorized real-client write separately. Keep `production_ready=false`.

Protocol references checked during implementation: [OpenAI authentication](https://developers.openai.com/plugins/build/auth), [tool declarations and annotations](https://developers.openai.com/plugins/plan/tools), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). Annotations inform clients; server-side authorization remains mandatory. The pinned SDK publishes auth schemes via the compatible `_meta.securitySchemes` field; real-client refresh/consent still requires separate acceptance.

## 中文摘要

本批只做 OAuth 云端记忆新增、版本化修订、撤回与持久回执。默认和旧连接仍只读；必须单独开启配置、为明确选定的账户供应独立写凭证，并完成新的 OAuth 授权。保存不等于允许外发；明确选择“保持私有”优先于账户“读取全部”，本地修订和导入导出保留限制，只有审核当前版本后明确允许才能解除。旧私有选择会一次性回补，原提交回执保留历史快照而不伪装成当前权限。原记忆和 handoff 门禁保留，不增加连接管理 UI、通用令牌或模拟成功；上线、真实客户端验收和生产就绪分别记录。

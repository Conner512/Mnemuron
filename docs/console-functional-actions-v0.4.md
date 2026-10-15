# Functional desktop console / 桌面控制台功能接通

This is an additive, opt-in extension of the existing Layout A console. It does not grant writes to ChatGPT MCP, replace identity providers, delete data or enable production deployment. `production_ready` stays `false`.

## 1. Feature and authorization matrix

| Page | Real operation | Boundary |
| --- | --- | --- |
| Overview | Owner counts, recent records and navigation | No synthetic counts or connection assertions |
| Memories | Create, version-checked correction, retraction, manual category, sensitivity, exact-revision ChatGPT grant | Own records only; correction creates a replacement; retraction retains history; secret is never granted |
| Categories / summaries | Current category inventory, existing grounded summaries and source-version pagination; submit classification/summary jobs | Original text is not overwritten by an LLM |
| Jobs | Queue, inspect, cancel, retry, periodic schedule, actual worker/index status | Existing persistent worker/leases/fences; retry does not reset usage or attempts |
| Models | Save organizer/embedder separately, change/remove write-only API key, synthetic connectivity probe, disable and request personal vector build | Per-owner encryption/profile/budget; explicit egress and query consent; no browser-supplied file or environment secrets |
| Connections | Read/rotate/revoke user-created memory-only Agent credentials, revoke OAuth grants | Exact owner, no admin/capture/handoff scopes; internal and legacy privileged keys remain operator-managed |
| Security | Change password, verify replacement TOTP, rotate recovery codes, revoke one/other console sessions | Fresh password + unused TOTP for credential changes; new TOTP verified before replacement; old sessions/authorization invalidated |
| Audit | Account-scoped Core and identity events | No passwords, API keys, memory bodies or other accounts' events |
| Storage | Download personal portable JSON; import as new personal memories | NOT a database backup/restore; no credentials or other account rows; no overwrites |
| Appearance | Three palettes, light/dark, Chinese/English | Existing account-scoped preference behavior and fixed A layout retained |
| Invitations | Batch issue with 1–1440 minute TTL, single/batch revoke, effective expiry | Explicit operator role + fresh password/TOTP; ordinary members cannot issue or list codes |
| Accounts | Account metadata, explicit operator grant/revoke, disable/enable | No private memory browsing, impersonation or automatic first-user admin; last active operator protected |
| Registration / recovery | Real invitation/password/TOTP/recovery-code flow; optional automatic Core provisioning; configured web/CLI recovery | Multi-account mode, dedicated restricted recovery session and explicit proof policy |

The UI uses server capabilities, then the BFF and Core independently authorize every operation. Disabling a button is not an authorization control. Domain operations are fixed allowlisted actions; no arbitrary REST path, SQL, OS command, filesystem destination or role is accepted.

## 2. Upgrade without changing existing clients

Back up both existing databases with the established offline/consistent-backup procedure and keep the encryption keys outside all Git worktrees. Deploy first to disposable/staging data. Node.js 24+ is required. Install the two existing lockfiles; no new application runtime dependency is introduced.

```bash
npm ci --prefix services/oauth --ignore-scripts
npm ci --prefix adapters/chatgpt-web --ignore-scripts
node scripts/test-all.mjs
```

Keep the existing subject, user ID, account ID, memory IDs and credential files. New tables are additive, documented in `docs/architecture/account-ownership.json`. Old read-only console credentials continue to work. Do not overwrite databases or recreate accounts. Older authorization binaries can reject the extended schema; rollback is a coordinated binary + backup operation, not deletion of unknown tables.

### 2.1 Core private configuration

Merge this fragment into the **existing** runtime file, not a replacement of its module/provider/vector settings. All paths below are examples and must be private operator-approved paths outside the checkout.

```json
{
  "console": {
    "key_file": "/var/lib/mnemuron-private/console-secret.key",
    "worker_enabled": true,
    "personal_vectors": false,
    "allowed_private_origins": []
  }
}
```

Generate the separate encryption key once. The command refuses to overwrite an existing destination. Keep it with the private backups; losing it makes saved console model credentials and secret operation receipts unreadable.

```bash
umask 077
node services/oauth/bin/console-operator.mjs core-key \
  --output /var/lib/mnemuron-private/console-secret.key --confirm
```

`worker_enabled` runs bounded jobs periodically in the Core process. Without it, jobs can be queued but the UI reports that the worker is not running; it never calls queued work complete. Personal model settings never borrow the installation's shared provider credentials. A private HTTP Ollama service requires its exact origin in the operator-only `allowed_private_origins` list. Cloud metadata/link-local/redirects remain denied. Public HTTPS addresses are resolved and pinned for the connection; browser-configured environment or filesystem secret references are rejected.

For semantic retrieval, retain the existing separately configured Qdrant backend and set `console.personal_vectors=true`. This permits a configured vector backend without a shared global embedder. Each user's model profile, generation, activation pointer and budget are isolated. Save that user's embedder, explicitly authorize query egress, request an index build, and wait for actual success. Changing the model does not activate an incompatible old index. Hybrid reads explicitly degrade to lexical; semantic-only requests fail when their index is unavailable. A user with a personal profile never silently falls back to a shared paid provider.

### 2.2 Authorization private configuration

Under the existing `identity` object:

```json
{
  "console_operations": true,
  "recovery_policy": {
    "password": ["recovery_code", "totp"],
    "totp": ["recovery_code", "password"]
  },
  "provisioning": {
    "enabled": true,
    "core_database": "/var/lib/mnemuron-private/core.sqlite3",
    "credential_directory": "/var/lib/mnemuron-private/account-credentials",
    "identity_map_file": "/var/lib/mnemuron-private/identity-map.json",
    "memory_config_file": "/var/lib/mnemuron-private/memory.runtime.json"
  }
}
```

`identity.console_operations` is an explicit deployment switch, not a user privilege flag. It does not upgrade old Core credentials itself. `provisioning` is an **optional co-located private worker**: the auth process must have authorized access to these paths and the existing Core database. It creates no public administrative API and never accepts a path from a browser. If services are on separate hosts, do not point this at a nonexistent database or expose the Core admin API; retain the established operator provisioning process instead. `memory_config_file` must describe the actual Core configuration.

This worker checks pending, already MFA-verified registrations approximately every five seconds, verifies the two account-bound credentials, publishes the derived identity map and activates the account only after recovery-code acknowledgement. Pending operations are durable and replay-safe. An unavailable Core leaves the account provisioning, not falsely active. It also publishes security-version changes and handles durable account-disable revocation. A failed revocation is reported and retried; no successful state is fabricated.

Upgrade each existing account's **console** binding explicitly, and grant operator to the intended account by its existing ID:

```bash
node services/oauth/bin/console-operator.mjs enable-console \
  --config /var/lib/mnemuron-private/auth.runtime.json \
  --core-database /var/lib/mnemuron-private/core.sqlite3 \
  --account-id EXISTING_ACCOUNT_ID --confirm

node services/oauth/bin/console-operator.mjs grant-operator \
  --config /var/lib/mnemuron-private/auth.runtime.json \
  --account-id EXISTING_ACCOUNT_ID --confirm

node services/oauth/bin/console-operator.mjs provision-once \
  --config /var/lib/mnemuron-private/auth.runtime.json --confirm
```

The exact legacy console scopes are `memory:read`, `resume:read`, `console:read`. The enabled console additionally has `memory:write`, `memory:organize`, `console:write`. The ChatGPT credential and its scopes are unchanged. Explicit upgrade validates the account, credential ID, agent and instance before modification. An operator role permits account metadata/invitation administration, **not** reading other users' memories.

Restart services using the installation's established process after reviewing configuration; this guide performs no deployment. Check `/console-api/capabilities` in an authenticated browser: enabled switch, actual writable Core binding, operator role and maintenance readiness are independent facts.

### 2.3 Same-origin ingress

Merge the exact paths from [console-ingress.example.yml](console-ingress.example.yml), including `/assets/actions.mjs`, `/assets/visuals.mjs`, `/console-api/action`, `/console-api/capabilities`, `/console-api/export` and `/recover/start` / `/recover/complete`. An old proxy allowlist can otherwise make correctly implemented buttons fail with 404. Keep the final deny rule. `/v1/*`, database files, private keys and generic admin routes must **not** be published. Do not replace the current Tunnel configuration blindly.

## 3. Account and recovery semantics

Password changes require the current password and an unused TOTP. Rebinding TOTP keeps the old factor until the new code verifies within the bound 10-minute enrollment. Password or TOTP changes increment the account security version, revoke console sessions and OAuth authorization, and preserve data ownership. Ordinary password changes do not silently revoke standalone Agent keys; those remain separately manageable credentials. Account disable and verified recovery revoke all that account's Core credentials and fence its pending jobs; enabling supplies fresh account bindings and does not resurrect old Agent keys.

Recovery is disabled when no valid proof policy is configured. The supported policy requires **recovery code + current TOTP** for forgotten-password recovery, or **recovery code + password** for lost-TOTP recovery. No email/SMS/one-factor bypass is invented. A recovery session cannot browse memories. Failed independent Core revocation leaves a durable paused account and reports `REVOCATION_INCOMPLETE`. Completion requires provisioning and a fresh normal login.

The CLI uses the same policy and private proof files, not secrets on command arguments:

```bash
node services/oauth/bin/console-operator.mjs recovery-begin \
  --config /var/lib/mnemuron-private/auth.runtime.json \
  --proof-file /var/lib/mnemuron-private/recovery-proof.json \
  --output /var/lib/mnemuron-private/recovery-session.json --confirm
node services/oauth/bin/console-operator.mjs recovery-complete \
  --config /var/lib/mnemuron-private/auth.runtime.json \
  --session-file /var/lib/mnemuron-private/recovery-session.json \
  --proof-file /var/lib/mnemuron-private/new-factor.json --confirm
```

Proof-file fields follow `RecoveryService.begin`: `username`, `action` (`password` or `totp`), `recoveryCode`, and `otp` or `password`. Completion uses `password` (new password) or `otp` (new factor). For lost-factor recovery the private output also contains the enrollment URI/secret. These files must be mode 0600, never committed/uploaded, and removed according to the operator's secret retention policy. The old disabled emergency-reset command is not repurposed into a weak recovery path.

## 4. API, persistence and failure handling

- `/console-api/action`: POST `application/x-www-form-urlencoded` fields `account_id`, `csrf`, `action`, `operation_id`, and JSON-encoded `payload`. Account equality, same Origin, exact session, CSRF and operation authority are checked server-side. No model or Agent can acquire this browser authority via MCP.
- `/v1/console/action`: private Core endpoint with exact console credential authority; the original generic write endpoints remain unavailable to console destination credentials.
- Memory mutations are transactional with audit + operation result. Existing records require the reviewed revision. The same operation ID and intent replay without duplicate writes; changed intent conflicts. Replayed memory results expose the current lifecycle instead of resurrecting content.
- Model-test network calls have durable running/result state and request reservations; uncertain completion is not automatically repeated. Retrying jobs preserves input versions and budgets, and cannot claim global worker authority.
- Secret operation replies are encrypted at rest and recoverable to the same authorized account for ten minutes. API keys are never returned by list/config endpoints. Plain credential strings are not logged or stored in localStorage.
- Frontend state is account-scoped, cleared on logout/expired session, and rejects delayed responses from another account. Concurrent CSRF changes request a fresh explicit retry without automatically repeating writes.
- Personal organizer workers use the existing grounded output schema and validation; no guaranteed factual correctness is claimed for a model response.

## 5. Deliberate limits, not fake operations

Personal portable JSON exports contain current memory bodies, lifecycle/type/privacy and original-scope labels. They do **not** contain raw event bodies, attachments, all historical revisions, complete handoff state, embeddings, credentials or database files. Import creates new user-scope records with import provenance and deduplicates the original ID/revision; it never trusts file-supplied account/project authority or overwrites live records. Superseded/retracted imported records do not become active facts. This is portability, not full backup restoration.

The browser limits a portable file to 16 MiB; import preflights the established 4096 UTF-16-unit write limit. Oversized legacy records produce an explicit error instead of truncation. The export is a bounded live traversal, not a transactionally consistent database snapshot. Use the established private offline backup/restore tools for full-system disaster recovery; a multi-user database download or restore is intentionally not an ordinary console action.

Lists retain bounded page sizes (accounts 500, invitation inventory 1000, most activity lists 100). Memory body and source-manifest continuation remain available. This update does not introduce cross-user shared workspaces, impersonation, permanent physical memory deletion, access to privileged legacy Agent keys from the ordinary console, or arbitrary model/network/OS administration.

Actual paid models, production Cloudflare/TLS, existing personal databases and a real ChatGPT login require separate operator acceptance. No development test performs those actions.

## 6. Validation

```bash
node --test server/test/console-actions.test.mjs
node --test services/oauth/test/console-actions.test.mjs
node --test services/oauth/test/console-ui.test.mjs services/oauth/test/console-layout-a.test.mjs
node scripts/test-all.mjs
python3 scripts/test-console-browser.py
```

The browser script needs Playwright 1.57.0 and Chromium/Chrome, creates disposable identities and a real loopback Core/OAuth/BFF plus synthetic HTTP model, and tests real module/CSP loading and UI writes. `.github/workflows/console-browser.yml` runs it in a disposable CI runner. It uploads only selected synthetic, non-secret page previews on success, not databases, credentials, test-state dumps or logs. Environment browser-policy denial is a blocked test, not an application pass, and must not be bypassed by weakening policy.

Review every failure and skip rather than assuming previous UI screenshots or green syntax checks prove account isolation. The existing concurrent-enrollment and resource-harness tests have shown timing sensitivity in earlier runs; do not delete or weaken them to force a green result.

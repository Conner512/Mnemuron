# Integrated account console (experimental)

This is an **opt-in local implementation**, not a deployment instruction to run
against an existing installation without a maintenance review. No production
accounts, invitations, recovery proofs, domain routes or model permissions are
created by installing the code. `production_ready` remains `false`.

See the [architecture decision](adr/0010-integrated-console-identity.md) and
[ownership inventory](architecture/account-ownership.md). Existing memory storage,
OAuth authorization, read-only MCP, vector adapters and workers are reused.
Handoff remains separate and retains its confirmation and receipt gates.

## Architecture and interface

The existing OAuth service serves local CSS/native ES modules and authenticates
the console with a purpose-bound, HttpOnly, Secure, SameSite=Lax cookie. It holds
no shared owner bearer. Each request resolves the immutable account and obtains
its independently verified Core console credential. Browser-supplied `user_id`
cannot choose an owner. The MCP gateway continues to require an OAuth access
token, with a separate per-account Core Web credential and uncached activity
checks. Console cookies do not authorize MCP.

Changing the console account or signing out expires that browser's OAuth session
and pending consent, without revoking other devices' existing grants. A different
principal entered during OAuth login must start a fresh authorization; stale
interaction pages cannot transfer grants to another subject.

| Route | Contract |
| --- | --- |
| `GET /register`, `/register/account`, `/register/totp`, `/register/recovery-codes`, `/register/status` | Server-controlled, invitation-bound steps; incomplete identities cannot read memory. |
| `POST /register/reserve`, `/register/account`, `/register/totp`, `/register/ack` | Exact form fields, same-origin CSRF, atomic invite/TOTP checks; not a general account API. |
| `GET/POST /login` | Username, password and TOTP; success requires MFA, Core binding and recovery-code acknowledgement. |
| `GET /recover` | Truthful `blocked_policy` page; no weaker recovery fallback. |
| `GET /app` and `/app/{memories,summaries,jobs,connections,models,security,audit,storage,appearance,invitations,accounts}` | Fixed-A desktop console; page visibility grants no operation rights. |
| `GET /console-api/me`, `/security`, `/connections`, `/audit`, `/overview`, `/memories`, `/memory`, `/summaries`, `/summary`, `/jobs`, `/storage` | Authenticated, account-bound reads only. `/memory` requires `memory_id`; use the returned revision and continuation fields for body/source pages. `/summary` uses the returned pinned detail request. |
| `POST /console-api/logout` | CSRF-checked server revocation and browser data cleanup. |
| Models, invitations, accounts and other writes under `/console-api/` | Denied server-side pending policy. No export/download or role-management API is exposed. |

`/authorize`, dynamic `/interaction/:uid`, `/token`, `/introspect`, `/revoke`,
`/jwks` and discovery retain their exact existing protocol contracts. There is no
SPA catch-all. The same-origin reverse proxy must route **only** the named OAuth,
console and assets paths to the OAuth service, `/mcp` and protected-resource
metadata to the gateway. Never forward `/v1` or arbitrary paths to Core. Review
the existing same-origin route allowlist before deploying; this change does not
automatically alter any proxy or DNS configuration.
An [unapplied console ingress example](console-ingress.example.yml) is exercised
by the isolated same-origin tests. The legacy ingress example remains unchanged.

## Configuration and secrets

Start from the existing private, validated OAuth/gateway configuration, retaining
all PKCE, exact callback, scopes, token lifetime and proxy settings. Add:

- Both services: `identity_mode: "multi_account_v1"`. Omission keeps
  `legacy_owner`; legacy processes refuse an upgraded identity database.
- OAuth: `identity.encryption_key_file`, an absolute, owner-only file outside
  every Git worktree, containing a separately generated 32-byte base64url key.
  It encrypts pending factors/credential intents; back it up separately with
  appropriate protection. Losing it prevents resuming pending operations.
- OAuth: `identity.invitation_batch_limit`, an explicitly chosen integer in
  `1..1000`. No default is selected for production. Invitation expiry itself is
  an integer **1..1440 minutes**, selected per batch.
- OAuth: `identity.console_session_ttl_seconds`, an explicitly chosen integer in
  `60..28800`. No production default is selected.
- OAuth: `identity.core.base_url`, the approved Core loopback/private-TLS origin;
  registration activation additionally requires the local provisioning command.
- OAuth: `login.registration_enabled: true` only after registration policy and
  the local supply workflow are approved; otherwise keep it false.
- Gateway: `identity_map_file` points to the private atomic map derived by
  provisioning. Do not hand-edit it into a shared-owner mapping. Every mapped
  account has unique subject, Core user, credential ID/file and security version.

Keep configuration/key directories `0700` and private files `0600`; do not pass
secrets through shell arguments. The service checks that identity storage is
outside worktrees before opening it. The CLI and provisioning also guard output
paths, including symlinks. No account data is bundled into static assets.

The only new runtime dependency is exact `qrcode@1.5.4` in the existing OAuth
module, locally generating the TOTP QR. Install its reviewed lockfile with
`npm ci --ignore-scripts --prefix services/oauth`; no CDN or external QR service.
Native console modules need no build step or frontend package installation.

## Operator commands and resumable migration

Run `node services/oauth/bin/identity.mjs --help`. All paths below denote private
operator-selected files, not repository files. Commands are **not** a grant to
change production. They intentionally require an exact target and `--confirm`
for state transitions.

1. Inventory the old OAuth issuer/subject, Core `user_id`, exact Web mapping,
   filesystem ownership and existing pending handoffs. Stop incompatible OAuth
   writers in an approved maintenance window. `migrate-owner` obtains the same
   exclusive process lease as the service and rejects a live process.
2. Take consistent OAuth/Core backups and protect keys, mapping and permissions.
   Verify copies in an isolated directory first. Do not treat a raw copy of a
   live WAL file alone as a database backup.
3. Use `migrate-owner --config /private/auth.json
   --legacy-file /private/owner.json --mapping-file /private/legacy-map.json
   --confirm`. The original file is not edited. Existing subject, Core user,
   password parameters, factor and recovery hashes are preserved. Retrying
   returns the same account rather than duplicating memories.
4. Use `provision --config /private/auth.json
   --core-database /private/core.sqlite3 --credential-directory /private/keys
   --identity-map /private/identity-map.json --confirm`. It persists an encrypted
   operation before the separate Core transaction, reuses exact credentials
   after interruption, validates Core identity and publishes the map atomically.
   A pending/failed operation cannot borrow the legacy owner's credential.
5. The same **local** provisioning command reconciles subsequent completed
   registrations. Arrange approved operator runs or a reviewed service schedule;
   the web server cannot administer Core. Run again after recovery-code
   acknowledgement if provision happened first, so the derived map reflects
   activation. `status` and pending counts distinguish incomplete work. This
   release does not silently install a scheduler/service.
6. Do not restart old binaries on an upgraded database. To inspect a backup,
   restore into a new isolated path. If later registrations or memories exist,
   never overwrite them with a pre-migration copy: freeze writes, inventory the
   delta and design an explicit reconciliation/forward-fix first.

Invitation command shape:

```text
node services/oauth/bin/identity.mjs invite-issue --config /private/auth.json \
  --count APPROVED_INTEGER --ttl-minutes APPROVED_INTEGER \
  --issuer OPERATOR_LABEL --output /private/new-invitations.json
node services/oauth/bin/identity.mjs invite-list --config /private/auth.json
node services/oauth/bin/identity.mjs invite-revoke --config /private/auth.json \
  --batch-id EXACT_BATCH_ID --confirm
```

Each code is independently random, single-use and digest-only in the database.
The first command writes plaintext once to an exclusive private output file;
stdout/list/audit contain no usable codes. Revocation affects unused codes only.
Reservations expire; reclaim creates a new binding, never inherits the previous
claimant's password or factor. An ambiguous completion retries the same identity.
Usernames use ASCII letters/digits and `_.@-`, case-insensitive unique labels;
immutable UUIDs are the actual identity. Passwords retain spaces, require 14–1024
characters and use scrypt. TOTP seeds appear once during binding, then recovery
codes appear once and must be acknowledged before normal access.

## Deliberately blocked policies

- Web password/TOTP recovery proof combinations, operator reset proofs and old
  owner recovery approval. `recovery-inspect` exposes only state; `recovery-reset`
  records the request and refuses it. The internal recovery engine is tested
  using explicitly synthetic policies, not an enabled production backdoor.
- Memory writes, job scheduling, per-account model configuration/billing,
  invitation issuance from Web, platform roles, export and whole-database restore.
- Multi-account query model egress: lexical works; semantic reports unavailable
  and hybrid explicitly degrades to lexical until the policy is approved.
  Owner-attributed usage accounting is not authorization to spend or disclose.
- Console grant revocation/reset controls await the corresponding operation
  policy. Existing OAuth revocation protocol remains intact.

Themes (Neural Indigo, Signal Teal, Paper Amber) only change colors; light/dark
and Chinese/English share geometry and permissions. Browser persistence stores
allowlisted appearance settings only, keyed by account; content, cursors,
passwords, seeds and bearer credentials are not persisted. Layout is desktop-first.

## Before any deployment

- Review migration backups and cross-database retry/activation evidence; verify
  no incompatible old process can write; preserve later data in rollback plans.
- Approve batch cap, session TTL, recovery proof policy and role/model boundaries.
  Unapproved branches stay closed, not defaulted on.
- Approve the first-visit appearance defaults before rollout. A/light/Chinese is
  the local preview default, not a confirmed production preference.
- Review exact same-domain route allowlist, cookies, TLS, CSP/CSRF, callback and
  firewall; check that Core `/v1` is not public. Do not reuse test `isolated` mode.
- Check account credential/file separation, encryption-key backup and logs.
- Run `npm test`, publication and the pinned local secret scanner. Keep runtime
  data and actual evidence outside Git. Inspect six themes and both languages.
- Separately authorize two-user ChatGPT tests using synthetic sentinels, complete
  reads and revocation isolation. Local protocol tests do not certify that host.
- Obtain explicit deployment/restart approval. Do not equate this preview or its
  UI with production readiness, mobile support or approved recovery operations.

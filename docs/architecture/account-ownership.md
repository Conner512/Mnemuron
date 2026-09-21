# Account ownership and boundaries

> **Opt-in functional update:** [console actions v0.4](../console-functional-actions-v0.4.md) adds separately authorized human-console writes, owner-isolated models and explicit operator roles. The original read-only mode remains the default; old `blocked_policy` statements below describe that mode, not the new enabled mode. ChatGPT MCP scopes are unchanged.


This is an implementation inventory, not permission to deploy. The executable
inventory beside this document covers every Core and OAuth table; regression
tests fail when a table is added without a classification. `sqlite_%` tables
are SQLite internals, not additional application access paths.

## Authoritative and derived storage

- Direct `user_id` tables are filtered using the authenticated credential or
  verified account mapping. User-supplied IDs do not select the principal.
- Summary claims and derived outboxes inherit their summary's `user_id`.
  Summary cursors bind owner, scope, source manifest and revision. A foreign
  summary is indistinguishable from a missing summary.
- FTS tables are shared physical indices, not a shared space. Candidate IDs
  join authoritative memories with the owner filter before results, counts
  and conflicts are returned. No console route exposes FTS rows or raw SQL.
- Vector payloads contain owner/document surrogates, not plaintext memory.
  Query filters and authoritative owner/revision hydration both apply. The
  index generation, health and service-wide budget ceiling are operator state.
- Jobs carry owner, scope, model profile, input manifest and a fenced lease.
  Chunk results must match the persisted owner/source set. Organizer and
  embedding usage have separate owner-attribution ledgers; this does **not**
  approve a model-cost allocation policy. New multi-account Web and console
  query paths use lexical retrieval until that policy exists. Existing
  operator-controlled model workers are not exposed as console actions.
- Settings, retention, handoff module enablement, profile health, global
  budgets and vector generations are operator infrastructure. Ordinary
  accounts cannot read or mutate them through BFF/MCP. Retention and model
  administration remain existing privileged local operations, not platform UI.

## Identity, sessions and credentials

`account_id`, `(issuer, subject)` and Core `user_id` are stable and unique.
Username is a login label, never a storage key. Accounts, bindings, provisioning
and recovery operations are account-owned. Pending registration sessions have
only a reservation until an account is created. Invitations are operator batch
records whose claim binds a registration session; plaintext is not stored.

OAuth records contain subject, grant/client/transaction references; they are
validated by the existing provider, then account eligibility and security
version. MFA replay counters are per subject. CSRF belongs to the interaction
or restricted cookie purpose. Rate buckets distinguish subject/account,
client and peer; the hashed key is not an alternate identity. Operator-only
invitation and migration audit entries have a null account and are not returned
in any normal account's audit feed.

Each account has **two distinct Core credentials**, one Web read-only and one
console read-only. The request constructs a client for the matched principal;
there is no global mutable owner token. OAuth introspection is performed on
each request. Discovery/JWKS metadata caching never substitutes for it.

## Route inventory

| Surface | Principal and boundary |
| --- | --- |
| OAuth `/authorize`, `/interaction/:uid/*`, `/token`, `/revoke`, `/introspect`, `/userinfo`, `/jwks`, discovery | Existing protocol validation, exact redirect, PKCE, purpose-specific clients, CSRF, verified subject/security version; no frontend fallback |
| `/register/*` | Invitation-bound registration cookie; strict field set; cannot access private BFF/MCP |
| `/login`, `/console-api/logout`, `/recover` | Password + TOTP; separate console cookie; POST origin and CSRF; recovery is `blocked_policy` |
| `/app` and its twelve fixed pages, `/assets/*` | Fixed route/asset allowlist; private pages require eligible account; no SPA catch-all |
| `/console-api/me`, security, connections, audit | Verified console session; only same-account metadata; no secrets/raw queries or private content of others |
| `/console-api/overview`, memories, memory, summaries, summary, jobs, storage | Owner-bound console Core key, authoritative credential identity check, strict query allowlist, session rechecked after awaited read |
| Models, invitation/account administration, export/restore and all other BFF mutations | Denied or `blocked_policy`; visible navigation grants no authority |
| `/mcp` tools | OAuth only, strict read-only tool allowlist, owner mapping and revision-pinned Web visibility; console cookies cannot authenticate |
| Core `/v1/identity`, capabilities/status, memory/source/summary/project/task reads | Existing scopes plus owner checks; console and Web agent route allowlists restrict the subset available to each |
| Core capture/checkpoint, bootstrap/reconciliation, Resume/confirm/receipts, memory writes | Existing agent scopes and owner checks; never forwarded by BFF or Web MCP; existing handoff gates remain |
| Core agent registration/rotation/revocation, retention and task administration | Existing operator/agent permissions; registration cannot override credential `user_id`; no public BFF passthrough |
| Liveness/readiness | Bounded service metadata only; not private content, keys or an identity selector |

## Files, caches, queues and workers

- Core SQLite/WAL contain all owners; OAuth SQLite/WAL contain identity state.
  They are private server files, not per-account downloads. The threat model
  does not claim isolation from an OS administrator who can read both databases
  and encryption keys.
- Credential files are server-generated account UUID/purpose/version names in
  a validated, private directory outside **all** Git worktrees. The mapping is
  a derived atomic publication, serialized with identity transactions. No
  browser-supplied path, username or user ID determines a key filename.
- Password hashes, TOTP ciphertext, recovery-code hashes and encrypted pending
  provisioning payloads remain server-side. The AES key, signing/cookie keys,
  identity map, invitation output and all backup material stay outside Git.
- Browser memory content exists only in the current DOM/request state.
  Only theme/mode/locale persist under an account-keyed preference. Exit aborts
  requests, clears detail/cursor/draft state and rejects late responses;
  back-forward restoration forces reauthentication. All private HTTP responses
  are `no-store`.
- Durable memory source/processing/index outboxes retain owner and revision.
  Source files are reached through authorized manifest pins, not direct paths.
  Summary outboxes resolve their summary parent. Job/view access uses the owner,
  not a global status endpoint. No account export/download endpoint is enabled.
- Logs contain request metadata and safe error codes; no body, password, OTP,
  query string or bearer. Audit UI returns only the account's allowlisted
  metadata. Core audit `target_id` is returned only within that same owner.
- Provisioning is a local worker with durable encrypted intent, Core-side
  idempotency and authoritative identity recheck. It does not run implicitly on
  a public registration request. Migration shares the authorization process
  lease; legacy runtime access to upgraded tables fails closed.

Recovery proof combinations, roles, invitation batch cap, console session TTL,
initial appearance defaults, model resources/costs and high-risk web actions
must be explicitly configured/approved before deployment. No platform role is
implemented that implicitly grants access to another account's private body.

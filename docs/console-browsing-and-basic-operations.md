# Console browsing and scoped basic operations

Viewing owned data does not require permission to change it. Overview cards,
category links, memory/source details, model metadata, jobs, connections and
sessions remain inspectable when general console operations are disabled.
Unavailable writes are explained as policy restrictions, not simulated actions.

## Read contracts

- Memory browsing accepts `query`, `mode`, `category`, `status`, `offset` and
  `limit`. Pages default to 25, with a maximum of 50; offsets must be safe integers
  from 0 to 1,000,000. Category and lifecycle filtering happen before page slicing.
  With no lifecycle filter the console includes active, superseded and retracted
  records. This does not change the read-only MCP search defaults.
- Lexical search pages through at most 500 owner-authorized candidates and reports
  `truncated` when that window is exceeded. Hybrid/semantic search currently uses
  a 20-result window and reports `window_limited`; the UI asks for narrower filters
  rather than presenting it as an exhaustive listing. Such searches use only an
  account's configured model policy, never a deployment-wide paid-model fallback.
- Query/filter/offset state survives refresh in the URL. Offset-based list pages
  are live views, not immutable snapshots during concurrent writes. Body/source
  continuation is different: it retains revision/source-version fences and fails
  closed on changes. Back navigation re-reads the pinned page; content ranges and
  end-of-content indicators do not claim earlier pages have been read.
- Summaries and jobs use the same bounded list pagination. Stale summaries are
  labelled and link to original memories instead of offering a failing current
  summary read. Current summary claims link to their exact source revision.
- Audit pages advance both owner-scoped identity and Core streams independently.
  They are not a single globally ordered timeline; each stream retains its own
  order. The UI follows `next_offset` until both streams are exhausted.
- `/console-api/jobs?job_id=...` reads one owned job. The existing
  `/console-api/memory?memory_id=...&metadata=true` reads mutation preconditions
  without accepting a frontend owner ID. These aliases avoid requiring new
  public ingress paths; existing dedicated detail routes remain compatible.
- Model details contain sanitized configuration and a `has_key` boolean, never
  decrypted API keys. Read endpoints recheck the console session after awaited
  Core access, including revocation races.

## Optional basic-operation policy

No deployment setting is enabled by the code update. After explicit operator
approval, an installation can merge selected groups into its private OAuth config:

```json
{
  "identity": {
    "console_operations": false,
    "console_basic_operations": {
      "memory": false,
      "security": false,
      "oauth": false
    }
  }
}
```

An absent object preserves legacy behavior. When present, omitted groups are
false. Unknown keys, arrays, nulls and non-boolean values are rejected.

| Group | Permitted actions when explicitly enabled |
| --- | --- |
| `memory` | Create, correct, retract, classify, set sensitivity and Web visibility for the current owner's memories |
| `security` | Change own password/TOTP with required proofs; revoke own sessions |
| `oauth` | Revoke own application grants |

This policy does not enable recovery-code rotation, recovery workflows, paid model
configuration/testing, scheduling, vector rebuilding, Agent credential issuance,
imports/exports or role grants. Invitation/account administration retains its
independent operator policy. ChatGPT MCP retains read-only credentials and tools;
console memory writes do not grant Web access to every record. Explicit visibility,
revision and sensitivity checks still apply.

`/console-api/capabilities` returns `allowed_actions`, the intersection of server
policy, account role and actual Core credential capabilities. Hiding a button is
not authorization: the BFF and Core independently validate every action. CSRF,
Origin, account binding, exact object ownership, operation IDs, revision/state
fences and fresh-factor checks remain in force. Corrections preserve originals
and links; retraction is not physical deletion.

### Credential and deployment boundary

The granular policy does not upgrade existing Core credentials. For an approved
basic-only rollout, use the server operator command `enable-console-basic` with
an exact account ID, private auth config and Core database path, and `--confirm`.
It checks the existing account binding and upgrades only that console credential
in place. Repeating it is idempotent; credential IDs, key hashes and the separate
ChatGPT credential are unchanged. Existing full-write or unexpected scope sets
are rejected by this command rather than silently downgraded or widened.

Basic console scopes are the read scopes plus `memory:write` and
`memory:organize`, without `console:write`. Core accepts exactly six memory
actions; jobs, paid models, vector rebuilds, credential management and export
remain denied even if a caller bypasses the BFF. The BFF also applies its explicit
group policy. Security and application-grant actions remain account-scoped in
the identity service, not Core write permissions.

For newly registered or re-enabled accounts, the root-owned isolated worker
configuration can explicitly set `console_access: "basic_memory"`. The matching
OAuth config must enable `console_basic_operations.memory` and leave
`console_operations` false. The default worker stays read-only; it cannot issue
full console permissions. Already prepared provisioning operations keep their
durable original scopes through retries, so a previously prepared read-only
binding still requires an explicit subsequent upgrade. Never reuse a shared owner
token, upgrade the MCP credential, or give the public OAuth process Core DB access.

No schema migration is introduced. Deploy matching Core, OAuth and console assets
as a compatible release; updating assets alone cannot supply the new read aliases
or permission contract. Keep private configs and credentials outside Git. Before
deployment verify disk headroom, backup/rollback paths, effective service identities,
read-only MCP behavior and representative account capabilities. Preserve
`production_ready=false` and all handoff confirmation/receipt boundaries.

## Regression and browser checks

```bash
node --test server/test/console-browsing.test.mjs \
  services/oauth/test/console-browsing-ui.test.mjs \
  services/oauth/test/console-actions.test.mjs \
  services/oauth/test/console-reads.test.mjs \
  services/oauth/test/boundaries.test.mjs \
  adapters/chatgpt-web/test/multi-model-policy.test.mjs
node scripts/test-all.mjs
```

Use disposable two-owner databases and synthetic text only. Check real browser
search/pagination/refresh, long-body back/forward pages, category navigation,
summary-to-source links, detail dialogs, appearance persistence and restricted
controls. Test actual synthetic writes only under an explicitly enabled local
policy, then repeat viewing with that policy closed. Do not use production personal
memories or paid model calls as fixtures. Record non-zero failures and resource
guard blocks honestly; never reduce safety thresholds to make a suite pass.

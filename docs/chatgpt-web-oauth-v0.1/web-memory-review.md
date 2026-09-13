# Web memory reads: contract and verification

This implementation addresses the first read-only batch of the review against
baseline `626c159`: WEB-MEM-01–04, basic WEB-MEM-07 calling instructions, and the
related documentation/test-count corrections. It is not an approval to deploy,
publish, read personal memory, run real models or enable Web writes.

## Security boundary

The Web destination is selected from the Core-authenticated credential, whose
`agent_id` is `chatgpt-web`. A model-supplied destination, identity, `_meta`,
query text or header cannot select a different policy. The dedicated credential
still has exactly `memory:read` and `resume:read`; it cannot call other Core routes.
The gateway also verifies the Core policy marker, owner and agent instance on
each business call. No positive OAuth/introspection cache was introduced.

| Classification | Web read rule |
| --- | --- |
| `public` | Visible following explicit local classification |
| `internal` | Requires a local grant for the current revision/state/classification |
| `sensitive`, including unclassified records | Same explicit grant requirement |
| `secret`, unknown classifications | Not visible; a grant cannot override this |

No grant is inferred from OAuth consent, a provider's egress approval, a remembered
instruction, or a previous successful read. The additive `memory_web_grants`
table starts empty. Memory updates/revisions and privacy changes revoke grants.
Changing a public classification is a separate local operation, not a grant
revocation. Core local readers keep their original owner/scope behavior.

Filtering occurs before lexical candidate limits, counters and conflict creation,
and again after awaited vector requests. Details and historical lifecycle records
apply the same rule. A summary requires **every dependency**, including omitted
sources, to be current and Web-visible. Source metadata is projected to opaque
source identifiers and bounded availability/evidence information: no raw bodies,
source paths, deployment identities, lifecycle neighbors or diagnostic free text.

Unapproved Task/raw/checkpoint data has no Web grant mechanism in this batch.
Project compatibility responses therefore omit these fields, including small
responses and unresolved results. Task detail arguments are explicitly rejected;
local canonical Task reading and handoff contracts are unchanged.

### Local grant management

Use an existing private database and a local administrator with `admin:tasks`.
Keep the administrator credential outside the checkout; do not give it to the
gateway. Inspect metadata, separately review the exact memory locally, then use
the returned version and hash for a deliberate grant:

```bash
node server/bin/mnemuron-admin.mjs memory-web-visibility --memory MEMORY_ID --inspect
node server/bin/mnemuron-admin.mjs memory-web-visibility \
  --memory MEMORY_ID --revision REVIEWED_REVISION --state-hash REVIEWED_STATE_HASH --allow
```

Use `--deny` with the current version/hash to revoke an internal/sensitive grant.
`--inspect` does not return memory text. Stale versions are rejected; there is no
Web grant endpoint, wildcard grant, automatic batch approval or Web scope change.

## Read contract

- `mnemuron_search_memories` accepts optional `mode=lexical|hybrid|semantic`.
  When omitted, the configured Core default still applies. Lexical requests do
  not embed the query. Hybrid responses report requested/effective mode and an
  explicit degradation code. Semantic failure is a tool error, never a successful
  empty/lexical answer. Existing query egress and daily request budgets remain
  authoritative; no provider settings or credentials are exposed by this change.
  Web checks authorized-scope index coverage before and after vector waits.
  Missing current revisions report `VECTOR_STALE`, distinct from `VECTOR_DISABLED`,
  `VECTOR_NOT_READY`, `EGRESS_DENIED` and `BUDGET_EXHAUSTED`; hybrid falls back to
  lexical and semantic-only returns an explicit error. This conservative Web
  coverage gate does not change existing local vector-reader behavior.
- `mnemuron_get_memory` exposes `source_offset`, `source_version` and `revision`, in addition to
  Unicode body pagination. Follow `next_request` and `next_source_request`
  independently. Every continuation pins the memory revision; a changed revision
  requires restarting. A source-link-set digest also pins source continuation:
  replayed captures can add sources without changing the memory revision. That
  case returns `SOURCE_MANIFEST_CHANGED` instead of duplicating/skipping entries;
  restart and follow the newly returned continuation. `include_history` cannot
  bypass Web eligibility.
- `mnemuron_get_summary` reads existing summaries only. Enable it explicitly in
  the gateway tool configuration with `required_scope: memory:read` and
  `profile: [readonly]`, as in the updated example. Older four-tool configurations
  remain valid and do not silently acquire a fifth tool. The summary request
  selects an exact scope, optional category and limit; follow `next_request`
  unchanged until null. Tag filters and new summary generation are not exposed.

Summary continuation uses authenticated encryption, owner/credential/scope/filter
binding, a fixed insertion high-water mark and stable keyset traversal. It expires
after 15 minutes and is invalidated by service restart. It does not disclose
internal row positions or owner identifiers. New summaries are excluded from an
existing traversal, while source revocation takes effect immediately. A changed
source during a partial summary produces an explicit version error.

Byte-budget-deferred rows are not consumed. Large claims use Unicode quote pages
with `quote_offset`, `quote_length` and `quote_complete`; coverage and body
completeness remain separate. Web summary pages reserve space below 48 KiB so
the final JSON-RPC response, including both text and structured copies, can fit
the normal 128 KiB gateway budget. Smaller operator budgets can produce a safe
size error; they never silently drop memory content. Legacy numeric summary
offsets are retained for local compatibility; new clients must follow the opaque
cursor because partial claims cannot be represented by numeric offsets alone.

## Protocol and calling guidance

Authentication, origin checks, request limits and OAuth scope challenges remain
at the HTTP boundary. Core business reads run only in the accepted SDK handler,
after protocol/tool-input validation. Malformed envelopes never execute a Core
tool. Accepted business failures use `isError: true` and an allowlisted structured
error with a retry flag and next action. Private provider messages, HTML, tokens
and paths do not escape into tool results or summaries of logs.

The installed MCP SDK's actual `tools/list` output is tested, including its object
output schemas, read-only hints and `_meta.securitySchemes`. Error objects are
validated locally because this SDK skips output validation on `isError` results.
The implementation retains the SDK's protocol dispatcher instead of replacing it.
See the [OpenAI tool reference](https://developers.openai.com/plugins/reference)
and [MCP error contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

Server instructions and tool descriptions guide English/Chinese memory questions
toward search, full detail and summary coverage checks. Returned commands remain
inert data; empty search results are not proof of missing records. These are
contract tests, not a claim about real-model tool selection quality.

## Verification and remaining scope

Verification uses synthetic records, disposable SQLite databases, loopback OAuth
and the installed MCP SDK. Vector tests use in-memory or loopback REST fixtures,
not a real Qdrant deployment. Existing Hook/Confirm/Receipt and local Task tests
remain in the aggregate suite. The aggregate runner rejects zero tests,
cancelled/failed tests and unapproved skips; an explicit optional skip is counted
separately, never reported as passed work.

Focused regressions cover secret/default-sensitive rejection, exact-version
grants, metadata/lifecycle redaction, revocation during vector waits, 45-source
pagination, budget-deferred summaries, oversized Unicode claims, cursor tampering
and expiry, all-leaf summary authorization, small/unresolved project projection,
invalid-protocol no-execution, real emitted tool schemas and safe business errors.
The original privacy and pre-dispatch reproductions failed before the fix, as did
the four-summary reproduction (three returned with one silently missing).

### Change inventory

| Area | Changed files |
| --- | --- |
| Trusted Web eligibility, exact grants and source redaction | `server/lib/memory/web-visibility.mjs` (new), `server/lib/memory-retrieval.mjs`, `server/lib/store.mjs`, `server/lib/app.mjs`, `server/bin/mnemuron-admin.mjs` |
| Stable body/source/summary reads | `server/lib/memory/revisions.mjs`, `server/lib/memory-derived/pagination.mjs` (new), `server/lib/memory-derived/store.mjs` |
| Await-time eligibility and explicit index degradation | `server/lib/vector-stores/index.mjs` |
| SDK execution, input/output schemas, safe errors and optional summary tool | `adapters/chatgpt-web/src/{tools,server,core-client,config}.mjs`, `adapters/chatgpt-web/config/gateway.runtime.example.json` |
| New Web regression files | `server/test/web-memory-boundary.test.mjs`, `server/test/web-summary-pagination.test.mjs`, `adapters/chatgpt-web/test/web-review.test.mjs` |
| Existing synthetic Web controls adapted to explicit grants and no Task access | `adapters/chatgpt-web/test/{fixture,gateway.test,limits.test,project-context-id.test,project-memory-context.test,project-summary.test,shared-origin.test,task-context-read.test}.mjs`, `adapters/chatgpt-web/acceptance/memory-vector.mjs` |
| Trustworthy test totals | `scripts/test-all.mjs`, `server/test/memory-first-privacy.test.mjs` |
| Capability and compatibility documentation | `README.md`, `README.zh-CN.md`, `docs/chatgpt-web-oauth-v0.1/README.md`, this report, `docs/memory-first-v0.1/{READ-CORRECTNESS,TASK-DETAIL-READ}.md` |

Independent read-only investigation reproduced the privacy/execution issues.
One independent read-only patch review also identified the legacy-offset mismatch,
source replay during pagination, and inferred project metadata. These findings
were addressed with explicit regressions; this is not an exhaustive security audit.
Additional contract checks cover exact/one-byte-over-budget pages, empty pages,
stale filtering with concurrent inserts, actual output schemas, query egress
denial, daily budget exhaustion, and authorized-scope vector staleness.

### Original batch local verification record

Baseline HEAD remains `626c159768c1429a8fe5a0529f34db3e7ed89b41`.
The following results describe the local working tree, not GitHub CI or deployment.
Runtime: Node 24.20.0; existing independently locked OAuth/MCP dependencies and
Python for Hermes. No new dependency was installed.

| Aggregate suite | Passed | Failed / skipped / cancelled |
| --- | ---: | --- |
| core | 156 | 0 / 0 / 0 |
| plugin | 41 | 0 / 0 / 0 |
| openclaw | 12 | 0 / 0 / 0 |
| hermes | 25 | 0 / 0 / 0 |
| oauth, including Web MCP | 60 | 0 / 0 / 0 |
| memory-unit | 23 | 0 / 0 / 0 |
| memory-integration | 47 | 0 / 0 / 0 |
| memory-model-contract | 10 | 0 / 0 / 0 |
| memory-worker | 18 | 0 / 0 / 0 |
| memory-vector | 18 | 0 / 0 / 0 |
| memory-schema | 3 | 0 / 0 / 0 |
| **Total** | **413** | **0 / 0 / 0** |

Commands, all from the repository root using the existing runtimes:

| Verification | Command | Exit code |
| --- | --- | ---: |
| Full matrix | `node scripts/test-all.mjs` | 0 |
| Dedicated Web regressions, 17 tests | `node --test server/test/web-memory-boundary.test.mjs server/test/web-summary-pagination.test.mjs adapters/chatgpt-web/test/web-review.test.mjs` | 0 |
| Syntax, all 27 changed/new JavaScript modules | `node --check <each changed/new .mjs file>` | 0 |
| Whitespace | `git diff --check` | 0 |
| Publication policy, 334 worktree files | `node scripts/check-publication.mjs --worktree` | 0 |
| Redacted Gitleaks 8.24.3, same worktree scope, zero findings | `node scripts/check-secrets.mjs --worktree` with the existing pinned scanner selected | 0 |

Privacy coverage is the tracked and non-ignored untracked source/documentation
snapshot, not production storage. Ignored runtime data, local Git history, remote
refs/PRs/issues/releases/Actions, forks/caches and LFS payloads were not inspected.
The downloaded review package was not copied into the repository. No actual
memory records, personal deployment settings, keys or provider configuration were
used as fixtures or written into these changes. Synthetic scans do not certify
uninspected history or external systems.

Not implemented or run in the original local-only batch:

- Web proposal/create/supersede/retract and human approval (WEB-MEM-05).
- Web Organizer job submission/status and maintenance scheduling (WEB-MEM-06).
- Real ChatGPT natural-language benchmark, performance caching, public OAuth
  acceptance, deployment, real-model calls or real Qdrant acceptance.
- GitHub publication or historical Git privacy cleanup.

Before deployment, operators must review the new default-deny data boundary,
approve only intended private memory revisions, optionally enable the summary
tool, and refresh the client's tool metadata. Then verify real Web reads and
revocation with non-sensitive acceptance records. `production_ready=false` stays
unchanged. Local implementation/tests alone do not close those external gates.

### Daily operations follow-up

The follow-up adds metadata-only grant inventory and versioned, bounded
connection/read audit records, plus an offline allowlisted audit viewer. Search
results now identify the stored revision; unknown legacy revisions remain null.
See [daily operations](web-read-operations.md) for the identity and evidence
boundaries. An OAuth connection is not a verified physical terminal, and an HTTP
response finishing is not proof that ChatGPT consumed the entire body.

The final local matrix passes **421/421**, with zero failures, skips or
cancellations: Core 158, OAuth/Web 66, and the other suites unchanged. Eight new
tests cover owner-scoped grant inventory, exact returned references, Unicode page
audits, denied/version/invalid-input errors, an interrupted transport, summary
reference bounds, conflict-only returned revisions and safe offline log inspection.
They use isolated synthetic data and no external model or vector service. Deployment and real-client results
must be recorded separately from these local counts.

### Bounded real-client acceptance

The first Core/Web candidate was subsequently deployed with a verified
rollback backup. The existing authorization, tunnel and vector services and
their credential/configuration files were unchanged. The deployment host passed
78 isolated relevant tests: 65 OAuth/Web and 13 Core visibility/pagination tests.
These overlap the local matrix; they are not additional test cases.

A controlled ChatGPT Web check refreshed the existing connection's actual tool
metadata and used one new, non-personal synthetic fixture. Observed results:

| Check | Evidence and result |
| --- | --- |
| Unapproved record | Real Web lexical search returned zero results |
| Exact local grant | Only the reviewed fixture revision was approved |
| Forced body pagination | Six actual detail calls covered 2,779 Unicode points, offsets 0/512/1024/1536/2048/2560, without gaps; final page complete |
| New conversation | A second independent chat searched and read the same ID/revision and exact final marker |
| Grant revocation | Fresh search returned zero; direct known-ID read returned `MEMORY_NOT_FOUND`, no body |
| Individual audit | Server-generated request records matched the Web read sequence, returned revision, page offsets and outcomes |
| Grant inventory | The operator CLI listed metadata only; unrelated historical memories were not granted |

The fixture grant remained revoked after acceptance. The real source set fit in
one page; larger source sets are covered by isolated tests, not claimed as a live
multi-page source test. OAuth-token revocation was tested in isolation and is
distinct from this live per-memory grant revocation.

The client initially probed an unsupported protocol version during metadata
refresh, then negotiated successfully. That rejected probe is retained separately
from successful calls; it is not counted as a completed read. Connection identity
does not establish which physical device originated a call. Gateway completion
flags alone do not prove client consumption; real-client UI evidence was also
checked. No personal memory body, operator/connection identifier, fixture content,
credential or private deployment log is included in this published record.

The final candidate includes the conflict-only audit correction and passed
**80/80** relevant deployment-host tests: 66 OAuth/Web and 14 Core tests. It was
activated without database migration or changes to protected configuration files.
Fresh ChatGPT Web calls after activation produced matching server audit records:
an existing authorized synthetic memory returned its complete 340-point body at
revision 1, while the revoked fixture returned `MEMORY_NOT_FOUND`. The workstation
then locked, so the final response's rendered text was not inspected; this last
check is server-side request/result evidence, separate from the earlier observed
client pagination and revocation checks. The verified rollback backup is retained.

Web writes, Organizer submission, project restoration and handoff remain out of
scope. Real provider quality, real vector-service acceptance, long-running
stability and global production promotion are not established by these checks.
`production_ready` remains false. Private evidence and rollback material are
retained outside the repository; publication is a separate final privacy gate.

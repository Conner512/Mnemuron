# Local implementation and verification report

## Release boundary

The independent authorization service and read-only HTTP MCP gateway are implemented and locally verified, including explicitly configured shared-origin routing. This source report does **not** certify a public deployment or a real ChatGPT connection. `production_ready=false`. Operator-owned installation evidence and private configuration belong outside the repository; installing metadata-only services is not OAuth login or data-access acceptance.

The existing Core/stdio trust boundary remains intact. Core gains only authenticated self-introspection at `GET /v1/identity`, needed to reject accidentally overprivileged gateway keys. Existing routes and business schemas are unchanged. OAuth uses its own private SQLite tables and refuses a database containing business/unknown tables.

## Reproducible baseline

- Historical baseline: the core memory implementation before the independent OAuth service was introduced.
- Verification target: the OAuth working-tree changes on that baseline. The checks below record that implementation-stage run, not a certification of the current deployment or a dependency on old Git history.
- Test runtime: Node.js `24.20.0` LTS; Python 3 for the existing Hermes suite.
- Inputs: temporary loopback servers, synthetic owner/MFA data and credentials, disposable independent SQLite databases. No real conversations or memory exports.
- Source/test/config fingerprint: **38 files**, SHA-256 `da6f74f3412ef64d5d4476bb151fec2b828afd53f20a9a633dfb97a232f440d5`.

The fingerprint hashes repository-relative paths in sorted order, each followed by a NUL, file contents and another NUL. It includes `.mjs`/`.json` files under `services/oauth/`, `adapters/chatgpt-web/` and `shared/`, plus root `package.json`, `server/lib/app.mjs` and `server/test/identity.test.mjs`. Ignored dependencies/runtime files and documentation are excluded. Recompute it after source changes; this is not a deployment build ID.

## Executed checks

Commands are shown with `node` referring to the stated LTS runtime. Existing package-local lockfile installations were reused for this publication check. `npm ls --depth=0` confirmed both components' pinned direct dependencies; no dependency version or lockfile was changed during verification.

| Command / check | Result | Exit |
| --- | --- | --- |
| `npm ls --prefix services/oauth --depth=0` | Pinned direct dependencies present | 0 |
| `npm ls --prefix adapters/chatgpt-web --depth=0` | Pinned direct dependencies present | 0 |
| `node --test --test-timeout=30000 services/oauth/test/*.test.mjs adapters/chatgpt-web/test/*.test.mjs` | **44 passed**, 0 failed, 0 skipped | 0 |
| `node --test --test-timeout=15000 server/test/*.test.mjs plugins/mnemuron/test/*.test.mjs adapters/openclaw/test/*.test.mjs` | **176 passed**, 0 failed, 0 skipped | 0 |
| `python3 -m unittest discover -s adapters/hermes/test -p 'test_*.py'` | **25 passed** | 0 |
| `npm audit --prefix services/oauth --omit=dev` | No reported vulnerabilities at execution time | 0 |
| `npm audit --prefix adapters/chatgpt-web --omit=dev` | No reported vulnerabilities at execution time | 0 |
| `git diff --check` | Passed | 0 |
| `node scripts/check-publication.mjs --worktree` | Passed; no prohibited content found | 0 |

Audit/publication checks are limited automated checks, not guarantees that no vulnerability or sensitive information can exist. The provider emits a one-time warning for the bounded raw-form fallback described in the [dependency decision](dependency-decision.md). Tests retain this warning; no dependency source or production validation was bypassed to obtain a pass.

During test development, the secure-cookie fixture was corrected to distinguish its logical HTTPS origin from its loopback transport. Restart tests now close fixture HTTP connections rather than accidentally reusing a dead keep-alive socket; token exchanges are not blindly retried. The final full test run above includes those corrections.

Five additional shared-origin groups exercise the actual path patterns from the ingress template, explicit mode selection, both discovery documents, login and resumed authorization, SDK calls, refresh/revocation, cookie-independent MCP authentication, and owner-isolated business reads. Wrong-Host probes use the native HTTP client because the higher-level fetch client rewrites that header. MCP removes browser cookies from both normalized and raw request headers before the SDK sees them. These are isolated HTTP fixtures, not evidence of Cloudflare or real-client TLS behavior.

The co-located transport adds three groups and runs the two authorization dependency groups under both transports. They cover strict loopback opt-in, unchanged public Host/issuer/resource, real synthetic provider and SDK operation without a public backend round trip, continued introspection when the public ingress is closed, no DNS dependency or fallback, bounded failures, and live revocation. Loopback HTTP is explicit and confined to the same trusted host; normal issuer transport retains TLS validation. No system resolver or existing client configuration is changed by this feature.

The form-origin regressions preserve native same-origin login and consent submissions while rejecting null or foreign origins and retaining CSRF checks. The oversized-project regression verifies an explicitly marked, Unicode-bounded summary with stable memory IDs and provenance; it preserves the original Core response and rejects a summary that still exceeds the complete wire budget.

## What the local evidence demonstrates

Scenario IDs in test titles cross-reference grouped requirements, not a separate passing test for every ID. Grouped regression coverage and deployment-only requirements must remain distinct.

| Area | Local evidence | Remaining external boundary |
| --- | --- | --- |
| Core review / compatibility | Existing retrieval, event receipts, migration, Task Scope, Resume and matching ACK suites pass; self-identity endpoint does not write business state | Installed host behavior is not re-certified by this run |
| Configuration / secrets | Unsafe modes, example URLs, secret aliasing, permissions, unknown owner mapping, broad Core scopes and business DB reuse fail closed | Actual service users, deployment paths and permissions must be verified on target |
| Discovery / callbacks | Real provider metadata, protected-resource aliases and challenges, fixed clients, exact callback/resource rules, response `iss`, and a test client rejecting missing/wrong issuer | Exact app callback and public proxy traversal remain unverified |
| Shared-origin routing | Explicit opt-in, documented disjoint path allowlist, private-route denial, unchanged token/CSRF/Host/Origin boundaries and cookie-independent MCP | Remotely managed tunnel configuration and the entire browser origin must be reviewed before public activation |
| Login / MFA | Password plus real synthetic TOTP, explicit consent/cancel, CSRF/browser binding, OTP time-step replay prevention, local recovery and limits | Real browser / ChatGPT login through the intended ingress remains unverified |
| Cookies / session fixation | Trusted-termination **component fixture** checks Secure/HttpOnly/SameSite, rejects an unsigned fixed session cookie and observes identifier rotation | This is not a real TLS, browser or Cloudflare test |
| Token lifecycle | Opaque token introspection; signed ID token separated from API token; expired/code/client/redirect/PKCE/resource/scope rejection; code concurrency; refresh rotation, idle/absolute expiry and full-family replay revocation | Actual ChatGPT expiry/refresh/relink behavior remains unverified |
| Persistence / failure | Real child-process SIGKILL and clean restart; consumed artifacts remain invalid; read-only storage and mid-token-write failure return no credentials; existing grants are not cleared | No claim of HA, multi-process AS, production fault or soak acceptance |
| Gateway authorization | Fixed AS/TLS/response-schema validation; issuer/audience/client/subject/scope checks; no positive cache; no caller-selected backend/identity; bounded failures | Real deployment trust/certificate chain remains unverified |
| HTTP MCP / data reads | Official SDK initialization/list/call/notifications; stateless behavior; read-only annotations and schemas; Core read integration, user isolation, pagination/provenance and inert injection text | Real ChatGPT tool presentation and business reads remain unverified |
| Limits / readiness / logs | Whole-wire tool response budget, body/header/Origin rejection, per-subject concurrency/rate limits, component failure codes, private readiness checks and synthetic secret-log assertions | External cache/challenge policies and proxy logging remain unverified |
| Isolated restore policy | A closed synthetic auth snapshot is restored separately, explicitly revoked before service, and old tokens are rejected without touching Core | No automatic rollback detection or production backup/restore deployment |

Relevant executable evidence:

- [Authorization flow tests](../../services/oauth/test/flow.test.mjs)
- [Configuration, account and failure tests](../../services/oauth/test/boundaries.test.mjs)
- [Cookie/session component test](../../services/oauth/test/interaction-security.test.mjs)
- [Real-process restart and isolated restore tests](../../services/oauth/test/restart.test.mjs)
- [SDK and read-only gateway tests](../../adapters/chatgpt-web/test/gateway.test.mjs)
- [Authorization dependency and provisioning tests](../../adapters/chatgpt-web/test/authorization.test.mjs)
- [Gateway limits and wire protocol tests](../../adapters/chatgpt-web/test/limits.test.mjs)
- [Shared-origin ingress and authentication tests](../../adapters/chatgpt-web/test/shared-origin.test.mjs)
- [Co-located authorization transport tests](../../adapters/chatgpt-web/test/auth-transport.test.mjs)
- [Bounded project summary test](../../adapters/chatgpt-web/test/project-summary.test.mjs)
- [Core self-identity test](../../server/test/identity.test.mjs)

## Deployment-only acceptance

The source-only checks above do not certify any operator's deployment. Validate these boundaries separately and retain the evidence privately:

- Real proxy routing, resumed authorization paths, cache/challenge behavior and private-route denial (DISC-08, OPS-01/02 and deployment portions of CFG/LOGIN).
- The saved ChatGPT `/mcp` endpoint and refreshed tool metadata; service templates and an authenticated panel do not establish callable-tool acceptance.
- Actual owner login, diagnostic call, expiry/refresh, revocation/relink and all three read tools, with explicitly authorized data access (OPS-06/07).
- Production promotion, fault/soak acceptance and operational policy, none of which is implied by publishing source code.

Use the [deployment input checklist](deployment-inputs.md), then metadata-only and real `auth_only` acceptance. Enabling `readonly` follows that diagnostic gate; neither stage is inferred from these local results.

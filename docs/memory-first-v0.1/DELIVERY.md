# Memory-first source delivery

MEM-09 covers compatibility and operational boundaries; MEM-10 covers reproducible
verification and evidence packaging. Completing a private source candidate does
not deploy it, publish Git history or certify production readiness.

## Candidate contents and prerequisites

Include source, tests, generic documentation, license notices, configuration
schemas/examples and existing lockfiles. Exclude runtime configs/keys, raw
memories, SQLite/WAL, vector data, logs, local reports, benchmark databases,
dependency installations and Git internals. Keep a SHA-256 file manifest and an
archive checksum in the operator's private delivery directory. Verify exact paths
and file hashes after extraction, then test that extracted tree.

Use Node 24 and Python 3. OAuth/Web tests require the dependencies locked in
`services/oauth` and `adapters/chatgpt-web`. Full-schema tests use the Web
dependencies. The other suites do not require those packages. No models or vector
services are started by `node scripts/test-all.mjs`; its protocol fixtures bind to
disposable loopback ports and use synthetic data. Do not substitute live endpoints
or personal databases to make a local test pass.

Migration and publication-history regressions also need the relevant original Git
baseline. A source archive deliberately contains no history: provide a separate
local read-only history context for those tests, or explicitly report them blocked.
Do not fetch or rewrite history as an unannounced packaging step. Verify dependency
lockfiles and record any reused local dependency or history context.

## Required evidence

| Gate | Evidence to retain privately |
| --- | --- |
| C-01–02 | Existing local/HTTP/MCP reads; unchanged OAuth/Web schemas and read-only permissions; denied writes, maintenance and handoff operations |
| C-03–04 | More-than-50 source pagination, Unicode content reconstruction/hash, explicit retention pins, honest expired-source status |
| C-05 | Nonempty live-WAL snapshot and restore manifests; occupied target/sidecar refusal; private file creation; old vector activation invalidated |
| C-06–08 | No-copy migration dry-run; status/backup without source migration; privacy-impact limits; transient SQL errors versus damaged lexical index recovery |
| Q-01–02 | All eleven suite exit codes, test/pass/fail/skip/cancellation counts; later suites still run after an earlier failure |
| Q-03–05 | Frozen exact/semantic goldens, bounded model/profile evidence, human-reviewed summary implementation hashes and synthetic performance results |
| Q-06 | Runtime schema/example validation, locked dependencies, CLI/documentation consistency |
| Q-07 | Separate current tree, index, HEAD and local-ref scans; actual scanner exit codes; explicit remote/history coverage gaps |
| Q-08 | Actual file changes, baseline preservation, checksums, evidence matrix, incomplete gates and `production_ready=false` |

Do not collapse a successful protocol test into a model-quality result. A prior
human review applies only to its reviewed fixture/output and implementation hashes;
changed summary logic needs new review. Likewise, prior performance evidence must
name its environment and bounded workload, not imply a new production load test.

## Compatibility and next operator actions

SQLite remains authoritative; models and Qdrant are optional projections. Existing
lexical save/search/read and OAuth/Web read-only access remain usable without
handoff, model requests or Qdrant. Hook attestation, exact Preview/Confirm,
next-turn delivery and Receipt/Stop ACK checks are not replaced by memory jobs.

Follow [OPERATIONS.md](OPERATIONS.md) for explicit maintenance. A backup is private
data, not a publishable artifact. Restore only to an unoccupied private destination;
no operation in delivery starts a service or changes a production database.

Report implementation/local verification, real-backend/model acceptance,
browser-client acceptance, deployment, GitHub publication/history privacy and
production readiness separately. A clean current candidate does not clear older
commits, PRs, issues, releases, Actions artifacts, LFS, forks or caches. Those are
separate operator-authorized gates, never inferred from a green local suite.

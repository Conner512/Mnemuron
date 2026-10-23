# Release review and recovery

This is a release-candidate checklist, not production approval. `production_ready`
remains `false`. See the [feature matrix](release-feature-matrix.md) for all 63
console entries and the [existing production contract](production-readiness-evidence-matrix-v0.1.md)
for real-host, capacity, recovery and seven-day stability thresholds.

## Candidate content

The candidate retains the in-progress account console, private cloud-memory choices,
connection onboarding, classification/summary/vector configuration and their tests.
Release preparation adds:

- Core schema v7: old readers refuse the explicit-private contract rather than
  silently ignoring its denial table. Cloud receipt backfill and reviewed grants
  remain authoritative; no existing memory or receipt is rewritten.
- A pinned historical-source, two-account Core/OAuth upgrade and recovery exercise.
  It checks preserved identities, encrypted identity material, memories and receipts,
  post-upgrade writes, owner boundaries and rejection by the old reader.
- Compatible gateway lockfile patches for `fast-uri` and `ip-address`; direct runtime
  dependencies are unchanged. Reinstall both lockfiles before validation.
- A date-independent retrieval regression fixture, and browser assertions based on
  the real job state rather than untranslated English or an ambiguous connection button.
- All four browser suites in CI, with explicit synthetic storage cleanup checks.
  `.node-version` and development documentation select Node 24 LTS.

## Reproducible local acceptance

Use a full Git clone, Node 24 LTS, Python 3 and the two independent lockfiles. Keep
all run evidence and synthetic storage outside the source tree. No personal
credentials or existing service URLs should be inherited by test processes.

```sh
node --version
npm ci --prefix services/oauth --ignore-scripts
npm ci --prefix adapters/chatgpt-web --ignore-scripts
npm run test:all
npm audit --prefix services/oauth --omit=dev
npm audit --prefix adapters/chatgpt-web --omit=dev
node scripts/check-publication.mjs --worktree
node scripts/check-publication.mjs --all-refs
node scripts/check-secrets.mjs --worktree
node scripts/check-secrets.mjs --history
```

The secret wrapper requires exactly Gitleaks 8.24.3; a missing scanner is blocked,
not a pass. For browser commands and pinned disposable dependencies, follow
`.github/workflows/console-browser.yml`. The four suites exercise real local HTTP,
CSP, registration/TOTP, form operations, permission denial, connection lifecycle,
models, translations and layout. No test disables production TOTP. Synthetic
operator fixtures exist only to test operator functions and are destroyed with
their isolated databases; no real operator test account is provisioned.

Run the local fault/capacity harnesses with `--evidence-dir` outside the checkout.
`--quick` is a smoke profile, not the full production capacity or partition gate.
The repository deploys as a Node service in an LXC example. It has no Dockerfile;
a Docker image build is not an existing release deliverable and must not be
reported as passed. Inspect the actual LXC/service installation independently.

## Upgrade runbook

1. Freeze a candidate commit and a sorted path/SHA-256 source manifest. Record
   each currently active service's release path, runtime, configuration digest,
   dependency lockfile digest, unit configuration and health without exporting
   credentials, user records or raw logs. Mixed release directories are possible.
2. Obtain approval for the specific target, version, service interruption,
   migrations and backup procedure. Keep scopes, TOTP, accounts, public routes and
   model egress settings unchanged unless separately approved.
3. Before migration, stop all writers to both stores: Core, OAuth, provisioning
   worker and scheduled jobs; stop the gateway to avoid misleading partial access.
   Create a private paired snapshot of Core/OAuth plus matching encryption keys,
   identity mappings and runtime configuration. Protect directories/files with
   0700/0600. Include vector backend configuration and snapshot/rebuild procedure.
   A copy of one SQLite file while WAL writers run is not a consistent backup.
4. Verify hashes and SQLite integrity on separate copies. Rehearse restore in a
   non-public location; preserve restored auth revocations and invalidate restored
   OAuth grants, interactions, console sessions and one-time credential receipts
   before any exposure. Review generic PATs, device keys and identity bindings
   separately; `AuthStore.revoke({all:true})` is not a universal credential reset.
   Never use real memories in review screenshots or reports.
5. Stage the immutable source release and install each locked dependency tree
   separately with `npm ci --ignore-scripts` under Node 24. Do not share a mutable
   `node_modules` directory across old/new lockfiles. Verify the source manifest.
6. Start the approved version on existing service endpoints. Core startup advances
   schema to v7 and backfills private choices. Check Core/OAuth/gateway readiness,
   worker state, permissions, version hashes and configured private/public ingress.
7. Use an approved finite-lifetime member test identity to validate real OAuth/MCP,
   own-memory CRUD/visibility and account isolation using only namespaced synthetic
   data. Do not read another person's memory to prove isolation. Record IDs of only
   the new test resources; revoke and clean those resources by supported mechanisms.
   A real account, persistent key or MFA exception needs its specific approval.
8. Verify backups and observability, collect the real-host evidence, then start the
   seven-day soak. A deployed process and green readiness are not release approval.

## Rollback and recovery

**Never lower `PRAGMA user_version` and never replace live stores with an old
backup after writes resume.** That loses new registrations/writes and can revive
revoked credentials or expose private memories. v6 cannot safely read v7.

Before deployment prepare a compatible rollback build containing the v7 schema
guard, explicit-private authorization/backfill and paired-store recovery tests,
while reverting only the faulty non-privacy feature. Exercise it against a copy
containing post-upgrade writes. If no such build has been tested, the only safe
immediate response is to stop ingress/writers and forward-fix; do not promise an
untested one-command downgrade. Keep the current stores, WAL and evidence intact.

For backup disaster recovery, restore into a new isolated path, verify both stores
and key/mapping consistency, invalidate restored access material as above and
reconcile writes after the snapshot under explicit approval. Preserve the current
state before any cutover. Document the accepted RPO/data-preservation decision;
a backup restore is not a data-preserving code rollback.

## Seven-day observation contract

Use the existing thresholds, not a seven-day timer with no measurements. Before
starting, freeze the release hash and supported agent/device list. Sample service
health, restart counts, queue size/oldest age, receipts/ACK phases, unexplained raw
loss, disk free, DB/WAL growth and backup freshness at a bounded interval (for
example hourly), with daily signed/hash-bound summaries and a restore check.
Avoid raw memory, credentials and unrestricted logs in the evidence.

- Zero unexplained event loss, duplicate delivery, false ACK, stuck queue or
  unplanned restart. Reconcile expected raw expiry separately.
- Alert on queue age above 5 minutes, in-flight receipts above 10 minutes,
  backup age above 26 hours, disk free below 20%, or unexpected restarts.
- Require the agreed real preview/confirm/next-turn delivery/ACK cycles per host.
- A material failure pauses promotion. Diagnose, preserve evidence, fix and repeat
  affected acceptance; a code/security/deployment change starts a new clean soak
  window rather than counting incompatible versions as one uninterrupted pass.
- Only seven consecutive complete days on the approved build, plus all other
  gates and the owner's explicit promotion decision, allow a readiness claim.

## Release review checklist

- [ ] Freeze scope, supported hosts and a fully identified candidate artifact.
- [ ] No original uncommitted work lost; inherited changes identified separately.
- [ ] Locked installs, aggregate tests, all browser suites and scans on that artifact.
- [ ] Two-account authorization, keep-private/read-all, replay and migration evidence.
- [ ] Approved paired backup, verified restore and tested compatible recovery path.
- [ ] Installed runtime/source hashes and route/port boundaries verified.
- [ ] Each claimed real host's own acceptance evidence collected.
- [ ] Only this run's temporary accounts/data/keys cleaned; cleanup verified.
- [ ] Numerical capacity/recovery gates and seven-day observation completed.
- [ ] Remaining planned/policy features accurately disclosed; promotion approved.

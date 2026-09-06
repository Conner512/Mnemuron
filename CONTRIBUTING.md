# Contributing to Mnemuron

Thank you for helping make task continuity more reliable and easier to use. Focused bug fixes, reproducible reports, tests, documentation, and translations are welcome.

The project is experimental and licensed under the [Apache License, Version 2.0](LICENSE). Unless explicitly stated otherwise, contributions intentionally submitted for inclusion are provided under that license, as described in its contribution clause. Contribute only material you have the right to license, and preserve any applicable third-party copyright and license notices. No separate contributor agreement is required by this repository.

## Start with a small, reproducible change

- For a bug, provide the expected behavior, actual behavior, component version, and a minimal synthetic reproduction.
- For a larger feature or protocol change, explain the use case and compatibility implications in an issue before implementing it.
- For documentation, check examples against the current code. Keep the [English](README.md) and [Chinese](README.zh-CN.md) overviews consistent when changing shared claims or commands.
- English and Chinese reports are both welcome. Do not include private session history to explain a bug.

## Development setup

Use Node.js 24+ with `node:sqlite` and SQLite FTS5, Python 3, and a full Git clone. The core uses built-in runtime libraries, so there is no root dependency installation step.

```bash
git clone https://github.com/Conner512/Mnemuron.git
cd Mnemuron
npm test
```

The migration suite reads historical source revisions through Git. If your checkout is shallow, retrieve its history before running the full suite. A source ZIP does not contain that history.

Focused checks:

```bash
node --test server/test/*.test.mjs
node --test plugins/mnemuron/test/*.test.mjs
node --test adapters/openclaw/test/*.test.mjs
python3 -m unittest discover -s adapters/hermes/test -p 'test_*.py'
```

Use disposable databases, loopback services, and synthetic identities. Give concurrent test instances separate ports, database files, configuration, and adapter data directories. Never run a test harness against an existing personal or shared service by default.

## Preserve the core contracts

- Keep Preview, explicit confirmation, next-turn delivery, and matching completion ACK as distinct steps.
- Match Session, Turn, agent identity, and workstream ownership; do not substitute another session to make a test pass.
- Keep canonical task state separate from derived checkpoints and memory projections.
- Preserve immutable event identity, explicit idempotency, and failed-attempt history. Only remove an outbox item after the server's acceptance receipt matches it.
- Make scope, authorization, truncation, and degraded retrieval behavior explicit rather than silently widening or hiding them.
- Do not present a local regression result as host compatibility, deployment acceptance, or production readiness.

Add regression coverage for changed behavior. Keep runtime changes separate from unrelated refactors and generated artifacts. If a change affects more than one adapter, test each affected implementation or state clearly which remains unverified.

## Before opening a pull request

1. Run the relevant tests and review the complete diff.
2. Update the affected guide or protocol contract.
3. Check that every example is synthetic and that no runtime files are staged.
4. Run the publication checks:

   ```bash
   node scripts/check-publication.mjs --worktree
   node scripts/check-publication.mjs --staged
   ```

5. Summarize the behavior change, actual checks performed, and any compatibility or migration risk.

The checker catches common patterns; it is not a secret scanner with complete coverage. Follow the [publication policy](docs/publication-policy.md) and review new text manually. Do not attach real conversations, memory exports, database copies, credentials, or deployment logs. Use synthetic test vectors and redact incidental environment details.

For a suspected security issue, do not post secrets or exploit details in a public issue. Use a private reporting channel if the repository provides one; otherwise ask for a private contact without disclosing the sensitive details.

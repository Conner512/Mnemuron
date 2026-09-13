# Mnemuron OAuth authorization service

Optional single-owner password + TOTP authorization service, backed by `oidc-provider` and its own private SQLite database. It is independent of the Core API and local agent credentials.

See the [OAuth guide](../../docs/chatgpt-web-oauth-v0.1/README.md) for boundaries, setup, local administrator commands, tests and deployment gates. Configuration examples are intentionally non-runnable until real operator values are supplied. Start with discovery-only or `auth_only`; do not expose real memory while testing authentication.

```bash
npm ci --ignore-scripts
npm test
node bin/admin.mjs --help
```

Run with Node.js 24 LTS from a complete repository checkout. Never deploy `--isolated-fixture`, share the Core database, regenerate keys on startup, or enable protocol debug logs with real credentials. LICENSE and NOTICE cover this component; installed dependencies retain their own licenses.

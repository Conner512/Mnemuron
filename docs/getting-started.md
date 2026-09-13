# Getting started

[Overview](../README.md) · [Documentation index](README.md)

This walkthrough runs the core API on your own machine, creates a test agent, and saves and retrieves one synthetic memory. It does not install an agent-host plugin, capture conversations, or exercise Resume delivery.

Use a new local development database. Do not substitute a production database, an existing credential file, or a remote service into these commands.

## 1. Prepare a local checkout

You need Node.js 24+ with `node:sqlite` and FTS5, Git, curl, and a POSIX shell such as bash or zsh. Python 3 is required only for the Hermes adapter and the full test suite. The core has no third-party npm runtime dependencies.

```bash
git clone https://github.com/Conner512/Mnemuron.git
cd Mnemuron
umask 077
export MNEMURON_EXAMPLE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mnemuron-example.XXXXXX")"
export MNEMURON_DATABASE_PATH="$MNEMURON_EXAMPLE_DIR/mnemuron.sqlite3"
```

If you already ran the README quick start, stop that foreground process with `Ctrl+C` before continuing. This walkthrough creates a separate disposable directory. If reusing an existing database with an administrator, use your private administration procedure instead of repeating bootstrap.

The directory is outside the checkout. The restrictive file-creation mask keeps new credentials and data private to your operating-system user. Production startup now rejects private paths inside source trees, even when Git ignores them. See [storage policy](memory-first-v0.1/README.md) for the explicit synthetic-only development exception.

## 2. Create separate administrator and agent credentials

Run this once for the new database:

```bash
set -C
node server/bin/mnemuron-admin.mjs bootstrap-admin \
  --label "Local development administrator" > "$MNEMURON_EXAMPLE_DIR/admin.json"

export MNEMURON_ADMIN_API_KEY="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  process.stdout.write(JSON.parse(readFileSync(process.env.MNEMURON_EXAMPLE_DIR + "/admin.json", "utf8")).api_key);
')"

node server/bin/mnemuron-admin.mjs register-agent \
  --device example-device \
  --agent example \
  --instance example-local \
  --label "Local example agent" > "$MNEMURON_EXAMPLE_DIR/agent.json"

unset MNEMURON_ADMIN_API_KEY
```

`set -C` prevents shell redirection from overwriting existing output files. If a command fails or a file already exists, stop and inspect the cause; do not delete an existing database or credential file to retry. New API keys are returned only at issuance. Both JSON files contain secrets—do not paste them into an issue or commit them.

The administrator manages identities and configuration. Use the **agent** credential for memory and Resume APIs; do not configure an agent host with the administrator key. Each additional agent instance should receive its own credential.

Prepare a private curl header file and a plain-text key file for later adapter use:

```bash
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const directory = process.env.MNEMURON_EXAMPLE_DIR;
  const { api_key } = JSON.parse(readFileSync(directory + "/agent.json", "utf8"));
  writeFileSync(directory + "/agent.headers", `Authorization: Bearer ${api_key}\n`, { mode: 0o600, flag: "wx" });
  writeFileSync(directory + "/agent.key", `${api_key}\n`, { mode: 0o600, flag: "wx" });
'
```

These files avoid putting the literal token in curl arguments or shell history. The `wx` flag refuses to overwrite an existing file. `api_key_file` in an adapter expects the plain key file, **not** the JSON issuance response.

## 3. Start the server

In the same terminal, with the database variable still set:

```bash
MNEMURON_HOST=127.0.0.1 \
MNEMURON_PORT=47831 \
  node server/bin/mnemuron-server.mjs
```

Leave it running. In a second terminal, set `MNEMURON_EXAMPLE_DIR` to the exact directory created above (do not create a second one), then run:

```bash
curl --fail http://127.0.0.1:47831/livez
curl --fail http://127.0.0.1:47831/readyz
curl --fail --header "@$MNEMURON_EXAMPLE_DIR/agent.headers" http://127.0.0.1:47831/readyz/search
curl --fail --header "@$MNEMURON_EXAMPLE_DIR/agent.headers" http://127.0.0.1:47831/v1/status
```

- `/livez` returns `status: ok` for the process.
- `/readyz` returns `status: ready` for the database, not the search index.
- `/readyz/search` checks search readiness and requires `memory:read`. A successful database check does not replace this check.
- `/v1/status` reports service and identity information. An empty database is expected; the example has not created a project or task.

Only the first two health endpoints are unauthenticated. A `401` means the credential is missing or invalid; a `403` means the credential lacks the required scope. Do not work around either by using another agent's identity.

## 4. Save a memory

```bash
curl --fail --request POST http://127.0.0.1:47831/v1/memories \
  --header "@$MNEMURON_EXAMPLE_DIR/agent.headers" \
  --header 'Content-Type: application/json' \
  --data '{"scope":"user","memory_type":"fact","topic":"example-storage","content":"The example project uses SQLite for local storage.","operation_id":"example-memory-001"}'
```

The response has `status: saved` and a generated `memory.memory_id`. This is a user-scoped synthetic memory, so it does not require a task seed.

Run the exact same request again to check idempotency: it returns the same memory ID with `idempotent: true`. Reusing that operation ID with different content is a conflict, not a new write. Use a new operation ID for a genuinely new save.

## 5. Retrieve it

```bash
curl --fail --request POST http://127.0.0.1:47831/v1/memories/query \
  --header "@$MNEMURON_EXAMPLE_DIR/agent.headers" \
  --header 'Content-Type: application/json' \
  --data '{"query":"SQLite","limit":5}'
```

The saved memory should appear in `results`, with its scope, provenance, and ranking information. This is SQLite FTS5-backed lexical retrieval, not embedding-based search. Results expose candidate and result truncation; a bounded result is not a claim of exhaustive conflict detection.

Stop the foreground server with `Ctrl+C` when finished. Starting it again with the same `MNEMURON_DATABASE_PATH` reopens the existing database. Keep the development directory private; do not upload it as a bug report.

## Configuration reference

These are the server entry point's defaults, not a sizing recommendation:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MNEMURON_HOST` | `127.0.0.1` | Bind address |
| `MNEMURON_PORT` | `47831` | TCP port |
| `MNEMURON_DATABASE_PATH` | `/var/lib/mnemuron/mnemuron.sqlite3` | Local persistent SQLite file; override for development |
| `MNEMURON_MEMORY_CONFIG` | Unset (legacy compatibility) | Absolute path to the private [memory runtime config](memory-first-v0.1/README.md); server database env override takes precedence over its `storage.sqlite_path` |
| `MNEMURON_RAW_RETENTION_DAYS` | `30` | Default retention for new raw event payloads; not a memory expiration setting |
| `MNEMURON_MAX_BODY_BYTES` | `2097152` (2 MiB) | Maximum JSON request body; supported range 64 KiB–64 MiB |

Keep SQLite/WAL on local storage, not a shared multi-writer network filesystem. For remote clients, terminate HTTPS at a controlled reverse proxy, restrict access to the backend port, and use independent credentials. Do not turn the loopback HTTP example into a public listener without configuring those boundaries. See the optional [Linux/LXC deployment guide](pve-lxc-deployment-v0.1.md).

## Next: connect an agent host

Choose the [ChatGPT / Codex plugin](../plugins/mnemuron/README.md), [OpenClaw adapter](../adapters/openclaw/README.md), or [Hermes adapter](../adapters/hermes/README.md). Register an identity for that adapter rather than reusing the walkthrough's generic identity.

Task continuity needs host lifecycle hooks and a real session. Verify capture first, then test Preview → explicit Confirm → next ordinary turn → delivery → matching completion ACK. Creating a key or seeing an MCP tool is not sufficient proof of this flow.

New-project creation also requires explicit project-bootstrap scopes; they are not part of the default agent scope set. Consult [project bootstrap](project-bootstrap-initial-task-v0.1.md) before granting them. Existing example seeds are optional fixtures, not tasks you must import into your workspace.

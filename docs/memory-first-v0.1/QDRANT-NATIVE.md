# Opt-in native Qdrant service

Qdrant can run as an independent native Linux service on the same host as
Mnemuron. Docker is not required. Installing it does **not** enable indexing,
run a model, open an existing memory database or change OAuth/Web and handoff.
Obtain approval for the new persistent service, resource limits and maintenance
responsibility before installation. Do not install it from a read/status command.

## Pinned candidate and layout

The current adapter contract targets [Qdrant 1.19.0](https://github.com/qdrant/qdrant/releases/tag/v1.19.0).
Choose the official release archive for the target architecture; verify its
SHA-256 against the release asset digest before extraction. Inspect archive paths,
types and links; reject traversal or unexpected entries. Do not run an unpinned
download or overwrite an existing service, account or data directory.

| Path | Ownership / purpose |
| --- | --- |
| `/opt/qdrant/1.19.0/qdrant` | Root-owned executable, `0755`; versioned and immutable to the service account |
| `/opt/qdrant/current` | Root-owned link to the verified version |
| `/etc/qdrant/config.yaml` | Root-owned, group `qdrant`, `0640` |
| `/etc/qdrant/runtime.env` | Root-owned `0600`; only the private API-key environment entry |
| `/var/lib/qdrant` | Dedicated non-login `qdrant` account/group, `0700`; storage, snapshots and temporary data |
| `/etc/systemd/system/qdrant.service` | Root-owned unit, `0644` |

The configuration directory should be root-owned, group `qdrant`, `0750`.
Generate a new random credential directly in the private environment file as
`QDRANT__SERVICE__API_KEY`; do not put the value in source, a unit file, command
arguments, terminal output or a report. A missing environment file or empty key
must prevent service startup. The service account needs no login or sudo access.

Review [qdrant.native.example.yaml](qdrant.native.example.yaml) and
[qdrant.service.example](qdrant.service.example) against the target host. Validate
the installed unit with `systemd-analyze verify` before enabling this service.
The example deliberately uses:

- authenticated REST on **`127.0.0.1:6333` only**, with gRPC and clustering disabled;
- disabled telemetry, CORS and recovery from remote snapshot URLs;
- storage outside all source worktrees; no source text in application vector payloads;
- a dedicated account, no capabilities, read-only system/home boundaries and a
  writable data directory only;
- bounded workers and a 2 GiB service memory ceiling (1.5 GiB high watermark),
  150% CPU quota and bounded tasks/restarts.

These limits are an initial operator example, not a production sizing result.
Check host headroom and actual cgroup enforcement. Loopback HTTP is suitable only
for this same-host boundary: never publish the port through a reverse proxy,
tunnel or container port mapping. Remote access needs a separately reviewed
authenticated TLS configuration; do not simply change the bind address.
Local API keys and vectors remain private data, not an isolation boundary from root.

## Acceptance before integration

Record the new service's version, executable/config/unit hashes, identity,
permissions, enabled state, actual listening sockets and resource consumption.
Require missing and incorrect credentials to fail a protected API operation.
Record existing application health, process starts and configuration fingerprints
before/after; do not restart those services to validate this one.

Run [VECTOR-ACCEPTANCE.md](VECTOR-ACCEPTANCE.md) with a new synthetic database and
random owned collections before enabling application integration. For a new,
otherwise unused native service, approved lifecycle callbacks may stop/start that
service only and must wait for authenticated readiness. Restart persistence,
lexical fallback, explicit semantic unavailability and outbox recovery are required;
a health probe alone is insufficient. No real model is needed for these 18 cases.

Run the operator harness on the vector host, not by exposing its loopback port.
If source must be copied, use a minimal module allowlist, strip filesystem extended
attributes, verify source hashes and keep the evidence directory outside the copied
source. Never copy a whole worktree, private config, keys or production database.

Preserve per-case results and synthetic SQLite evidence privately. After checking
that the initial collection set was empty and the final set equals the run's
recorded owned names, remove only those synthetic collections. An installed service
may then stay enabled with an empty store. Do not claim that Mnemuron/Web is using
vectors until a separate approved integration and real tool-call test establishes it.

## Updates and rollback

The operator owns upstream security/version tracking, credential rotation and
storage monitoring. Do not auto-update the binary. Stage a verified new version,
review compatibility and obtain an appropriate data snapshot before an upgrade.
Changing the version link alone is not a safe downgrade after storage migration.

For a never-integrated empty service, rollback can stop/disable **only** its unit
and archive its configuration, executable and private data for recovery. Do not
delete shared paths or change the application's existing database/runtime config.
For an integrated service, first review affected readers/writers, durable intents,
backups and the explicit lexical-fallback policy. Never erase authoritative memory
to repair a derived vector index.

Native service acceptance is not production load/soak, full model-quality acceptance
or production promotion. `production_ready` remains `false`.

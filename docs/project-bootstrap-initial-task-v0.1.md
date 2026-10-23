# Project Bootstrap + Initial Canonical Task v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Status and boundary

This specification describes Project Bootstrap for the ChatGPT adapter. Installing a package without restarting and verifying its running version does not establish loaded-code or real-session acceptance. This capability does not enable OpenClaw or Hermes behavior and does not change `production_ready`.

## Protocol

1. `mnemuron_preview_project_bootstrap` accepts the proposed Project and first Task, verifies the exact Hook-attested Session, derives the destination Workstream from the local adapter, and creates an immutable Preview.
2. Preview does not create a Project, Task, canonical revision, Task Scope, Resume, Receipt, Checkpoint, Memory, or rebound Event.
3. Matching or ambiguous existing Projects, identifier collisions, and competing pending Project Bootstrap Previews fail closed. Project path is only a weak hint and cannot block bootstrap by itself. HTTP(S), SSH URL, and SCP-style Git remotes are sanitized before freezing, never retain userinfo, passwords, query parameters, or fragments, and compare by canonical host/repository identity across SSH and HTTPS transports.
4. `mnemuron_confirm_project_bootstrap` requires the same Credential, Session, Preview version, and the independent `project:bootstrap:confirm` scope.
5. A positive confirmation transactionally creates the Project, first active Canonical Task v1, initial Workstream, canonical revision, immutable confirmation result, and audit record.
6. The ChatGPT adapter hides the server binding packet and stages a local `task_bootstrap` Scope in `pending` state. The next ordinary `UserPromptSubmit` activates it. No Resume or delivery Receipt is created.

The Preview kind and binding packet kind are `project_and_initial_task`. Existing Task Bootstrap rows remain `task` after the additive migration.

## Credential policy

The administrator credential includes the two independent scopes:

- `project:bootstrap:preview`
- `project:bootstrap:confirm`

Agent credentials do not receive these scopes by default. Existing and future Agent credentials remain unchanged until an administrator explicitly applies `project-bootstrap-scopes --instance ID --apply`; running the command without `--apply` is read-only and reports the required update. Apply the scopes only to explicitly selected ChatGPT Agent instances. OpenClaw and Hermes credentials are outside this capability's scope.

## Acceptance coverage

Server tests cover zero-side-effect Preview, strong duplicate signals, path-only non-collision, competing Preview handling, exact Credential/Session/version/scope enforcement, atomic confirmation and rollback, idempotent and concurrent confirmation, compare-and-swap cancellation, logical TTL accounting, safe input limits, transport-independent Git remote collision detection and secret removal, explicit legacy-scope migration, and old-database schema migration.

The ChatGPT integration test covers local Workstream and credential provenance, pending-to-active next-turn binding, persistence, no historical Event rebound, and absence of Resume/Receipt/Checkpoint/Memory creation. Adversarial coverage also exercises Session mismatch, identifier ambiguity, secret-bearing Git remotes, confirmation races, cancellation races, and migration from the pre-Project-Bootstrap schema.

Deployment acceptance requires installation, restart and loaded-code verification on each participating client, followed by a real cross-device Project/initial-Task Preview → Confirm → next-turn binding check. Validate other Adapters separately.

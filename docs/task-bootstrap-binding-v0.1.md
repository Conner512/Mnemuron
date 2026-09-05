# Task Bootstrap and Binding v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Status

This document defines the feature contract and required acceptance checks. Deployment-specific results are not published.

## Core gap

Mnemuron can reliably continue an existing Canonical Task across devices and Agents, but an ordinary Agent cannot yet create the first Canonical Task for new work. Without that bootstrap, unbound Events correctly remain outside every Task and there is no durable object that another Agent can later resume.

This phase closes only that gap:

1. preview a brand-new Task inside one existing Project;
2. explicitly confirm the immutable Preview in a separate turn;
3. atomically create Canonical Task v1 and its initial destination Workstream;
4. stage the current Session's Task Scope as pending;
5. activate that Scope on the next ordinary user turn without rewriting earlier Events.

## User flow

The intended command is `/Mnemuron start <task>`. Natural-language requests to start or create a Mnemuron Task follow the same path.

The Preview shows:

- resolved existing Project and Resolver evidence;
- proposed Task ID, title, aliases, goal, status, and Canonical version 1;
- initial Workstream;
- exact destination device, Agent instance, and Hook-attested Session;
- expiry time and explicit safety guarantees.

Confirmation requires the exact `bootstrap_id`, `preview_version`, and Hook-attested `session_id`. Preview alone never creates a Task or Scope.

## Server contract

Two additive endpoints are introduced:

- `POST /v1/task-bootstrap/preview` requires `task:bootstrap:preview`;
- `POST /v1/task-bootstrap/{bootstrap_id}/confirm` requires `task:bootstrap:confirm`.

The Preview is stored in `task_bootstrap_previews` and frozen for 30 minutes. Its state machine is:

`pending_confirmation -> confirmed | cancelled | expired`

Unknown or ambiguous Projects return a selection-required result without storing a Bootstrap Preview. Similar existing Tasks return candidates and fail closed rather than creating or overwriting a Task.

Successful confirmation runs in one SQLite transaction and creates exactly:

- one active Canonical Task at version 1;
- one initial Workstream with server-verified Agent provenance;
- one Canonical revision with `decision=bootstrap_confirmed`;
- one immutable binding packet;
- one confirmation audit event.

It does not create a Resume, Resolver selection, Resume injection event, Delivery Receipt, Memory, or Checkpoint. Repeating the exact confirmation returns the original binding packet without adding rows.

## ChatGPT binding contract

The ChatGPT MCP surface adds:

- `mnemuron_preview_task_bootstrap`;
- `mnemuron_confirm_task_bootstrap`.

Both require the exact Session authorized by the Mnemuron `SessionStart` Hook. The local destination Workstream is always taken from `MNEMURON_DEFAULT_WORKSTREAM_ID`; model input cannot redirect it.

Confirmation writes one private pending Task Scope with `binding_kind=task_bootstrap`, `binding_id`, and `bootstrap_id`. It does not queue Resume content. The confirmation turn remains outside the new Task. The next ordinary `UserPromptSubmit` activates the Scope, and that Event plus later Events use the new Task and destination Workstream. Earlier Events are never rebound.

Task Scope storage remains backward-compatible with Resume-created bindings. Same-Session activation supersedes only the previous same-Session Scope; other Sessions remain independent.

## Security and scope boundary

- Bootstrap uses two least-privilege scopes rather than `admin:tasks`.
- Only an existing Project can be selected in v0.1; creating Projects remains administrative.
- Only the credential that created a Preview may confirm it.
- Session, version, ownership, expiry, Task-ID collision, and similarity checks fail closed.
- Canonical Task editing, conflict resolution, automatic Project creation, historical Event rebinding, and Resume injection are out of scope.
- Network policy, retention, backup policy, unrelated services, and production promotion are outside this feature's scope.

## Acceptance gates

1. Preview is immutable and changes no Task, Canonical revision, Resume, or Task Scope.
2. Cancellation and expiry create no Task or binding.
3. Exact confirmation atomically creates Task v1, the initial Workstream, revision, audit, and binding packet.
4. Exact retry is idempotent; concurrent exact-ID or similar-Task creation cannot produce duplicate or partial state.
5. Wrong Credential, Session, version, scope, Project, and similar existing Task all fail closed.
6. Pre-confirmation Events remain unbound; the next ordinary turn activates the new Scope; later turns reuse it without reactivation.
7. Bootstrap creates no Resume or delivery/injection lifecycle records.
8. Device A can create and bind a Task; Device B can discover it in Project Preview and complete the existing Preview/Confirm/Delivery/Stop-ACK resume flow.
9. If OpenClaw or Hermes is included in the release scope, independently verify that Adapter can read and continue the Task after the ChatGPT path passes.
10. Full regressions pass and `production_ready` remains `false`.

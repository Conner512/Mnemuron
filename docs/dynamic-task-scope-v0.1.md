# Dynamic Task Scope v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Goal

After a user previews and explicitly confirms a Resume Packet, the next ordinary Agent turn must write its events to the restored Task instead of the Adapter's static default Task. The Resume Packet is still injected once, while the task binding remains active for later turns in the same conversation.

## Scope model

An active binding contains:

- restored `project_id` and `task_id` from the confirmed Resume Packet;
- destination `workstream_id` from the local Adapter identity;
- source `resume_id` and `preview_version`;
- destination conversation/session selector;
- activation time and durable status.

The destination Workstream is intentional. A task resumed from OpenClaw on Hermes continues under the restored Task ID but writes to `workstream-hermes`, preserving parallel Agent provenance rather than pretending that Hermes produced the source OpenClaw history.

## State machine

```text
Preview shown
    -> explicit exact ID/version confirmation
    -> pending task scope (confirmation turn remains unchanged)
    -> next ordinary user turn
    -> active task scope + one-time Resume Packet injection
    -> later turns keep active task scope without reinjection
    -> a newer confirmed Resume supersedes the old binding for that conversation
```

Cancelled or expired Previews never create a binding. A failed first Agent turn may retry Packet delivery, but its selected Task Scope remains active so subsequent capture does not fall back to an unrelated Adapter task.

## Adapter selectors

- ChatGPT Desktop: `CODEX_THREAD_ID`, cross-checked against Hook `session_id`.
- OpenClaw: stable channel `sessionKey`, channel, and sender identity.
- Hermes: hashed gateway chat/user tokens plus the Hermes Agent session identifier.

Task-scope files are local Adapter state, not central canonical memory. Directories use mode `0700`; records use `0600`. Event raw provenance states whether the scope came from a confirmed Resume or the Adapter default.

## Compatibility and boundaries

- No Mnemuron server API or database migration is required; existing Event fields already carry project, task, workstream, session, and provenance.
- Existing pending Resume files and one-time delivery ACK semantics remain unchanged.
- Static Adapter Task IDs remain the fallback before any confirmed Resume is activated.
- `remote-v0.1` remains `production_ready: false`; Dynamic Task Scope does not complete resolver, conflict reasoning, retention capacity, or public exposure hardening.

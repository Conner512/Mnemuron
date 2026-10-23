# Resume Injection ACK v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Goal

Make Resume delivery independently observable by Mnemuron. A local Adapter flag is not enough: Mnemuron server must be able to prove which verified Agent/device injected which confirmed Resume into which session and turn, and whether that turn completed.

## State model

Each delivery uses a stable `attempt_id` and append-only events:

```text
confirmed Resume
    -> injected       central accepts the exact attempt before context handoff
    -> acknowledged   the matching Agent turn completed
       or failed      the turn failed or the Adapter restarted before completion
```

`ack_complete=true` requires both `injected` and `acknowledged` for the same attempt. An isolated ACK is reported as `acknowledged_unpaired`, never as successful delivery. A completed attempt prevents a second injection. An in-flight attempt prevents a different concurrent attempt.

## Server contract

- `POST /v1/resume/:id/injection-events` accepts `injected`, `acknowledged`, and `failed` events.
- `GET /v1/resume/:id/injection-status` returns the derived delivery state and recent attempts.
- `/v1/status` includes aggregate `resume_injection_acks` counts.
- Device, Agent, Agent instance, and credential provenance come from the authenticated API key, not the client body.
- Preview version, credential, session, turn, destination Workstream, and injection method are immutable within an attempt.
- Events are idempotent by Resume, attempt, and phase.

The SQLite migration is additive. It creates `resume_injection_events` and does not rewrite existing Resume, Task, Event, Memory, Checkpoint, or Credential records.

## Adapter contract

| Adapter | Injection evidence | Completion evidence |
| --- | --- | --- |
| ChatGPT Desktop | preferred synchronous `UserPromptSubmit`; compatibility v0.1.3 uses a packet-free MCP probe followed by `PostToolUse` `additionalContext` after Mnemuron server accepts `injected` | matching `Stop` hook |
| OpenClaw | `before_prompt_build` prepend context after Mnemuron server accepts `injected` | matching `agent_end` |
| Hermes | `pre_llm_call` context after Mnemuron server accepts `injected` | matching `on_session_end` |

Terminal evidence is written to a private local injection-event outbox if Mnemuron server is unavailable. On restart, an unacknowledged in-flight attempt is reported as `failed`, the local Packet receives a fresh attempt ID, and retry remains possible.

## Failure boundary

This is an at-least-once protocol around host lifecycle hooks, not a transaction with the model runtime. A process can still crash after context handoff but before the completion hook. Mnemuron records that attempt as failed after restart and retries with a new attempt. Therefore `production_ready` remains `false` until real-device crash/retry, queue-drain, permissions, and long-running stability acceptance are complete.

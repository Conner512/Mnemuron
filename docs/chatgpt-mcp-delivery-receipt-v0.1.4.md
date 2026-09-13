# ChatGPT MCP Delivery Receipt v0.1.4

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Problem

Current ChatGPT Desktop can execute Mnemuron MCP calls as nested tool calls that are not exposed to plugin `PostToolUse`. The v0.1.3 compatibility path therefore failed safely after central confirmation: no local pending delivery was created, no Resume context was injected, and no false ACK was emitted.

## Protocol

```text
SessionStart/UserPromptSubmit Hook
    -> authorize exact session_id locally

explicit confirmation turn
    -> mnemuron_confirm_resume(session_id)
    -> confirm centrally
    -> stage Task Scope + host-private local Packet state
    -> armed=false; no Resume context returned
    -> Stop Hook arms the pending delivery with the real confirmation turn_id

next ordinary user turn
    -> mnemuron_take_pending_resume(session_id)
    -> Mnemuron server records phase=delivered with a stable receipt_id
    -> MCP returns the one-time resume_context and activates destination Task Scope
    -> Stop Hook records phase=acknowledged with the real delivery turn_id
```

The local state is stored in mode `0700` directories and `0600` files. The MCP server accepts a session only after a Codex Hook has attested it locally. A confirmation result never returns injectable Resume context. A delivery is not returned if Mnemuron server cannot accept or idempotently recognize its `delivered` receipt.

## Mnemuron server API

- `POST /v1/resume/:id/delivery-receipts`
- `GET /v1/resume/:id/delivery-receipt-status`
- `GET /v1/status` includes `resume_delivery_receipts`

Receipt phases are append-only:

- `delivered`: Mnemuron server accepted the stable receipt before MCP returned context; `turn_id` must be null.
- `acknowledged`: the matching ChatGPT `Stop` Hook completed and supplies the real host `turn_id`.
- `failed`: an accepted or uncertain delivery did not reach a matching Stop, including adapter restart recovery.

Identity and credential provenance come from the authenticated API key. Preview version, credential, device, Agent, Agent instance, session, destination Workstream, and delivery method are immutable within a receipt. A completed receipt prevents another delivery; an in-flight receipt prevents a concurrent receipt. Repeating the same phase is idempotent.

Recovery is session-scoped. A `SessionStart` may fail and retry only an in-flight delivery whose `claimed_session_id` matches that starting session. A concurrent or post-compaction `SessionStart` from another ChatGPT conversation must not alter the active delivery or its stable receipt ID. The implementation enforces this boundary to prevent cross-session rollback. Compaction-specific handling is described in the ChatGPT Core Foundation specification.

The additive SQLite migration creates `resume_delivery_receipts`. It does not rewrite existing Resume, Task, Event, Memory, Checkpoint, Credential, or legacy `resume_injection_events` records. OpenClaw and Hermes continue using the existing injection-event protocol and are not changed by this build.

## Acceptance boundary

Automated acceptance must cover confirmation-turn non-delivery, hook-attested session enforcement, central delivery declaration, one-time MCP context return, destination Task/Workstream preservation, real Stop-turn ACK, duplicate suppression, matching-session restart recovery, unrelated-session isolation, and unchanged OpenClaw/Hermes regressions.

`production_ready` remains `false` after deployment. Real Device A and Device B Preview/Confirm/next-turn/Stop checks are required before this phase is considered accepted.

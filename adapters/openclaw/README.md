# OpenClaw adapter

[Project overview](../../README.md) · [Local API walkthrough](../../docs/getting-started.md) · [Deployment guide](../../docs/openclaw-deployment.md)

Native OpenClaw plugin. It provides:

- Native lifecycle capture through `message_received`, `after_tool_call`, `agent_end`, delivery, Session, and compaction hooks.
- A private disk outbox when the Mnemuron server is temporarily unavailable.
- Read-only Project and Task-branch inspection through `mnemuron_preview_project_context` and `mnemuron_preview_task_branches`, alongside the existing status, Resume, confirmation, and memory tools.
- `/mnemuron` Telegram command semantics with Preview-first confirmation.
- One-time next-turn Resume Packet injection after explicit confirmation, with centrally recorded `injected` and terminal `acknowledged` / `failed` events.
- A separate private injection-event outbox so terminal ACK evidence survives a temporary Mnemuron server outage.

The API key remains in a separate `0600` file. Plugin config stores only its path. Conversation hooks require `plugins.entries.mnemuron.hooks.allowConversationAccess=true`. Verify plugin API compatibility, hook permissions, and session routing in your OpenClaw version; source availability alone does not certify a host deployment.

Example client identity:

```text
device_id: openclaw-host
agent_id: openclaw
agent_instance_id: openclaw-local
workstream_id: workstream-openclaw
```

Set the client identity to the values issued by your Mnemuron server.

Run the server-side onboarding helper `deploy/onboard-server.mjs` on the Mnemuron server with a task seed file argument and explicitly set `MNEMURON_DEVICE_ID`, `MNEMURON_AGENT_INSTANCE_ID`, and `MNEMURON_AGENT_KEY_FILE`. No container target is predefined. The key path must be a private server-local file. Optional `MNEMURON_DATABASE_PATH` and `MNEMURON_ADMIN_KEY_FILE` override the standard server layout. The helper registers the configured client and imports the seed task.

## Console-confirmed handoff

The Console can select this Agent only after a real, owner-scoped session capture and with an active credential containing `capture:write`, `resume:read` and `resume:confirm`. Confirmation creates a queued authorization, not a delivery. At the next host user turn, `before_prompt_build` pulls at most one packet through `/v1/resume/pending` for the exact canonical route/session and current workstream. Internal/background or ambiguously routed sessions do not poll this queue.

The response's Agent, device, instance, session and workstream are checked before local queuing. The existing central `injected` declaration must be accepted before task-scope activation and one-time `prependContext`; only the matching `agent_end` supplies completion evidence. A completion racing before actual context handoff is a failed attempt, not a successful ACK. Temporary failures remain recoverable; permanently stale Console packets cannot block newer confirmed packets. A fresh Core authorization can renew an expired local pending copy without resetting in-flight or completed delivery fences.

This does not enable the server handoff flag, grant new scopes, install the adapter into a host, or certify a particular OpenClaw version. Older servers without this endpoint retain the manual confirmation flow.

## License and attribution

This adapter is licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE) for attribution. Include both files when distributing a stand-alone adapter package. OpenClaw itself is separate software with its own licensing terms.

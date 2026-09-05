# Mnemuron Hermes Adapter v0.1

Native Hermes user plugin. It uses only documented Hermes plugin APIs and Python's standard library; Hermes core files and its virtual environment are not modified.

## Identity

```text
device_id: hermes-host
agent_id: hermes
agent_instance_id: hermes-local
project_id: project-mnemuron
task_id: task-mnemuron-hermes-adapter-v01
workstream_id: workstream-hermes
```

## Runtime contract

- `pre_llm_call`: captures the complete user message and injects one confirmed, scope-matched Resume Packet.
- `post_llm_call`: captures the complete final assistant response.
- `post_tool_call`: captures tool name, arguments, result, status, error, and duration.
- `on_session_start` / `on_session_end`: captures lifecycle and creates automatic server checkpoints from normal completed turns.
- `pre_gateway_dispatch`: derives hashed platform/chat/user scope tokens for `/mnemuron` confirmation. Raw Telegram identifiers are not written to plugin state.
- Failed event writes and Resume injection lifecycle events use private local outboxes and retry before the next status/startup synchronization.
- Confirmed Packets are compacted to at most 30 KiB while full records remain in Mnemuron.

## Commands

```text
/mnemuron status
/mnemuron continue <task name or exact task ID>
/mnemuron confirm <resume_id> <version>
/mnemuron cancel <resume_id> <version>
/mnemuron remember <content>
```

Preview never injects. Confirm/cancel must use the exact `resume_id` and `preview_version` shown to the user. A confirmed Packet is injected once into the next ordinary Hermes turn in the same scope. The Mnemuron server records `injected` before context handoff and accepts `acknowledged` only after that turn completes; failures and restart recovery are recorded as retryable `failed` attempts.

## Hermes settings

Settings live under `plugins.entries.mnemuron.settings` in `~/.hermes/config.yaml`. The API key itself stays in a separate `0600` file referenced by `api_key_file`.

The identities above are examples. Set `device_id` and `agent_instance_id` to the identity issued by your Mnemuron server.

The server-side onboarding helper `deploy/onboard-ct131.mjs` retains its legacy filename but contains no fixed container target. Run it on the Mnemuron server with a task seed file argument and explicitly set `MNEMURON_DEVICE_ID`, `MNEMURON_AGENT_INSTANCE_ID`, and `MNEMURON_AGENT_KEY_FILE`. The key path must be a private server-local file. Optional `MNEMURON_DATABASE_PATH` and `MNEMURON_ADMIN_KEY_FILE` override the standard server layout. The helper registers the configured client and imports the seed task.

# Hermes adapter

[Project overview](../../README.md) · [Local API walkthrough](../../docs/getting-started.md) · [Deployment guide](../../docs/hermes-deployment.md)

Native Hermes user plugin using Python's standard library. It does not require changes to Hermes core files or its virtual environment. Verify plugin API compatibility, hook permissions, and gateway/session routing in your Hermes version; source availability alone does not certify a host deployment.

## Identity

```text
device_id: hermes-host
agent_id: hermes
agent_instance_id: hermes-local
project_id: project-example
task_id: task-example
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

Run the server-side onboarding helper `deploy/onboard-server.mjs` on the Mnemuron server with a task seed file argument and explicitly set `MNEMURON_DEVICE_ID`, `MNEMURON_AGENT_INSTANCE_ID`, and `MNEMURON_AGENT_KEY_FILE`. No container target is predefined. The key path must be a private server-local file. Optional `MNEMURON_DATABASE_PATH` and `MNEMURON_ADMIN_KEY_FILE` override the standard server layout. The helper registers the configured client and imports the seed task.

## License

This adapter is licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE) for attribution. Include both files when distributing a stand-alone adapter package. Hermes itself is separate software with its own licensing terms.

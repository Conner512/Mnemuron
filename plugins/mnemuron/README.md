# ChatGPT / Codex plugin

[Project overview](../../README.md) · [Local API walkthrough](../../docs/getting-started.md)

This source integration connects a compatible local agent host to Mnemuron using an MCP server, a Skill, and lifecycle hooks. It is not a ChatGPT web OAuth connector or a stand-alone desktop app.

## Components

| Path | Role |
| --- | --- |
| [.codex-plugin/plugin.json](.codex-plugin/plugin.json) | Plugin metadata |
| [.mcp.json](.mcp.json) | Local MCP launch definition |
| [hooks/hooks.json](hooks/hooks.json) | Session, prompt, tool, compaction, and completion capture |
| [skills/mnemuron/SKILL.md](skills/mnemuron/SKILL.md) | User-facing command and confirmation flow |
| [scripts/](scripts/) | Runtime, private outboxes, task binding, and delivery receipts |
| [test/](test/) | Local regression tests |

The target host must support loading these components and granting the relevant hook permissions. Host setup and compatibility must be verified separately; starting the MCP process alone does not attest a session or enable Stop ACKs.

## Configure remote mode

First provision the Mnemuron API and issue a distinct credential for this agent instance. The server URL must be reachable from the client. Put the raw key in a private `0600` file and keep adapter state in a private directory.

The adapter reads `~/.mnemuron/config.json`, or the file selected by `MNEMURON_CONFIG_PATH`. Non-empty environment variables take precedence over the corresponding JSON settings. The following paths and identities are placeholders, not an installation command:

```json
{
  "mode": "remote",
  "server_url": "https://mnemuron.example.com",
  "data_dir": "/absolute/path/to/private/mnemuron-data",
  "api_key_file": "/absolute/path/to/private/agent.key",
  "device_id": "example-device",
  "agent_id": "chatgpt",
  "agent_instance_id": "chatgpt-example"
}
```

Use the identity issued by your server, not an identity copied from another client. `api_key_file` contains the plain token, not the credential issuance JSON. Add `tls_ca_file` if your deployment uses a private CA. Do not disable TLS validation to connect a remote client.

The default mode is local development storage. Shared task continuity requires `mode: remote` and a working server connection. `default_project_id`, `default_task_id`, and `default_workstream_id` are optional static scope defaults; configure only IDs you actually own and intend to use. A confirmed Resume can activate a dynamic scope for the current session on the next ordinary turn.

## Installation boundary

Use the plugin-loading mechanism supported by your local host and select this plugin's source or an appropriate packaged build. This repository does not provide a universal host-registration command.

The included [macOS installer](deploy/install-macos.sh) is an **upgrade-package installer**. It expects a sibling `plugin/` payload, a `SHA256SUMS` manifest, and an existing plugin registration. Those inputs are not present beside the script in a plain source checkout. Do not run that file as a fresh-install command or assume that copying files updates an already running host.

## Verify a host integration

1. Check which plugin build and source path the host actually loaded.
2. Confirm that the lifecycle hooks are trusted and that a new session is attested by the real SessionStart hook.
3. Use `/Mnemuron status` to check remote mode, server-verified identity, and queue state.
4. Create a Resume Preview for one exact task and inspect the source and destination scope.
5. Confirm the exact Resume ID and version in a separate user message.
6. Send a normal continuation message. Verify the receipt for that session and turn, then check for a matching Stop ACK after completion.
7. Send a later normal message and verify persistent task binding without a second delivery.

A global pending count is not proof that the current session has a pending delivery. Do not reuse a different session's ID, replay a completed packet, or count task activation alone as an ACK.

The protocol is specified in [ChatGPT MCP Delivery Receipt](../../docs/chatgpt-mcp-delivery-receipt-v0.1.4.md), [dynamic task scope](../../docs/dynamic-task-scope-v0.1.md), and the [core foundation](../../docs/chatgpt-core-foundation-v0.1.md).

## Development

From the repository root:

```bash
node --test plugins/mnemuron/test/*.test.mjs
```

Use isolated data and configuration directories. Local tests do not constitute acceptance of a particular host version, installed cache, or deployment.

## License

This plugin is licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE) for attribution. Include both files when distributing a stand-alone plugin package. The host application is separate software with its own licensing terms.

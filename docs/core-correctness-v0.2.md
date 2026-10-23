# Mnemuron Core Correctness v0.2

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

Core Correctness v0.2 removes two sources of false canonical state while preserving immutable evidence and explicit user control.

## Scope

- Automatic Reconciliation ignores derived `tool` and `working_directory` resource telemetry. Those items remain in immutable Checkpoints, but they do not become Canonical Task operations.
- Explicit, evidence-backed `resources` operations remain supported and require the existing exact Proposal confirmation flow.
- A ChatGPT Session without an active confirmed Task Scope is captured with null Project, Task, and Workstream identifiers. Adapter defaults no longer assign unrelated conversations to the Plugin Spike Task.
- Explicit event scope and confirmed Resume Task Scope remain supported. Confirmed Task Scope is authoritative for the bound Session.
- ChatGPT `mnemuron_remember` no longer falls back to adapter-default scope. Non-user memory scopes require the corresponding explicit identifier when no confirmed Task Scope is active.
- The ChatGPT MCP surface includes the three Canonical Task Reconciliation tools already implemented in the workspace source.

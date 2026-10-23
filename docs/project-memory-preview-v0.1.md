# Mnemuron Project Memory Preview v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Goal

Complete the read-only discovery half of `/Mnemuron load project <project>`. A user can inspect shared project state across devices and Agents before choosing a concrete Task to resume.

This phase intentionally does not create a second injection protocol. Task continuation continues to use the existing immutable Resume Preview, exact confirmation, next-turn delivery, and terminal ACK lifecycle.

## Contract

`POST /v1/project-context/preview` and `mnemuron_preview_project_context` return:

- the versioned Project Resolver result and signals;
- canonical Tasks in the Project, including version and freshness;
- each Task's Workstreams, conflicts, progress, blockers, next steps, and latest Checkpoint per Workstream;
- explicit structured memories scoped to the Project or its Tasks;
- recent project activity with device, Agent, Agent instance, Session, Task, and Workstream provenance;
- source counts and identities;
- an explicit next action containing the selectable Task IDs.

## Safety boundary

- The operation is read-only and creates no Resume row or Resolver selection.
- It cannot confirm a Resume, change Task Scope, or inject context.
- A path hint is never enough to resolve a Project by itself.
- Ambiguous and unknown Projects return `ambiguous` or `no_match`; no Project is guessed.
- Selecting a Task starts the existing `mnemuron_preview_resume` flow in a later turn.
- Raw records remain authoritative and unchanged; the response is only a bounded working view.
- `production_ready` remains `false`.

## Current implementation scope

- Mnemuron server route and source-rich Project projection.
- ChatGPT MCP tool in local and remote modes.
- OpenClaw tool plus `/mnemuron load project <project>` command routing.
- ChatGPT Skill and OpenClaw Skill instructions that preserve the read-only and Resume-confirmation boundaries.
- Hermes support must be checked separately against its Adapter contract.

## Routing and response bounds

Clients route `/Mnemuron load project <project>` to `mnemuron_preview_project_context` once per user turn. Project loading must not substitute Resume creation. The response projects bounded strings and arrays, declares truncation metadata, and stays below 128 KiB under oversized source data.

A managed plugin installation must update the source and cache consistently and verify the running client after restart. Private configuration, credentials, outboxes, and Task Scope state are separate from replaceable plugin files.

# Mnemuron Branch-aware Resume Selection v0.1

> Public specification and example configuration only. Personal deployment records and acceptance evidence are retained privately. This document is not proof of production readiness; `production_ready=false` remains the release boundary.

## Goal

Let the user inspect `/Mnemuron branches <task>` and then create a Resume Preview from one exact source Workstream or an explicit set of source Workstreams. The destination Agent keeps its own Workstream and Session; source selection controls only which branch evidence is placed in the immutable Resume Preview and Packet.

## User contract

- Existing `/Mnemuron continue <task>` remains backward compatible and uses the all-branch view.
- One branch: pass `source_workstream_ids: ["workstream-id"]`.
- Multiple branches: pass every explicitly selected ID. The result is a source-preserving `combined_view`, not an automatic merge.
- OpenClaw native form: `/mnemuron continue <task> --from <workstream-id[,workstream-id]>`.
- A branch is never selected from recency, current device, or an Agent guess. The user must name it explicitly after inspecting branches.

## Preview and confirmation invariants

- `branch_selection` records schema version, explicit/default mode, exact selected IDs, all available IDs, provenance preservation, and `automatic_merge_performed=false`.
- A single-branch Preview includes only that branch's recent Events, Workstream-scoped Memories, and latest Checkpoint. Unscoped project/task Memories remain available as shared context.
- Canonical Task fields and recorded conflicts remain visible; branch selection does not rewrite Canonical state or hide conflicts.
- Confirmation uses the already stored Preview. `selected_workstreams` and `branch_selection` are copied unchanged into the immutable Resume Packet.
- The destination Task Scope continues to use the destination Adapter's Workstream. Source Workstream selection must never overwrite it.
- Unknown or empty Workstream selections fail before a Resume row is created.

## Acceptance

1. One source Workstream survives Preview → Confirm unchanged.
2. Two explicit Workstreams return `combined_view` with no automatic merge.
3. Unknown selection returns 400 and creates no Resume.
4. Default calls preserve the existing all-branch behavior.
5. ChatGPT MCP and OpenClaw tool schemas forward exact source IDs.
6. OpenClaw native syntax displays the frozen source selection before confirmation.
7. Delivery/ACK and destination Task Scope behavior remain unchanged in regression.
8. Mnemuron server and real Agent deployment require separate installed-code checks; other Adapters require their own coverage and `production_ready=false`.

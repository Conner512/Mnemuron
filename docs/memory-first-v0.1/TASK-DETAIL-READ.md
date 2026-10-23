# Read-only canonical Task details

This is the **local/Core** canonical Task read contract, not a deployment report.
The Web memory visibility policy intentionally does not authorize canonical Task
fields; those Web arguments and navigation hints are no longer exposed. Examples
below apply to authorized local clients, not the current ChatGPT Web gateway.
See the [Web memory contract](../chatgpt-web-oauth-v0.1/web-memory-review.md).

## Availability is separate from returned content

Project previews attach `field_availability` to each Task for `goal`, `progress`,
`decisions`, `blockers`, `next_steps`, `resources` and `conflicts`. This describes
the canonical Task, not facts inferred from typed memories or Checkpoints.

| Property | Meaning |
| --- | --- |
| `recorded: true` | The canonical field contains a value or a nonempty list |
| `recorded: false` | The canonical field is known to be empty |
| `recorded: null` | Presence is unknown, for example with an older Core response |
| `item_count` | Original list length, or scalar presence count; null when unknown |
| `returned: full` | This response includes the complete field |
| `returned: partial` | This response includes only part of the field |
| `returned: omitted` | This response does not include the field body |

The counts and recorded flags survive both Core and Web summary projections.
`recorded: true, returned: omitted` means **recorded but omitted here**, not
unrecorded. Empty canonical fields do not prove that related memory or branch
evidence is absent. A plain missing property in an older response is unknown.

## Use the existing project preview tool

First call `mnemuron_preview_project_context` with an authorized canonical
`project_id`. A compatible Core advertises
`read_capabilities.task_field_details=true` and a `detail_request` per Task.
Keep its exact project ID, Task ID and canonical version when selecting a field.

For example, the following IDs are synthetic:

```json
{
  "project_id": "project-example",
  "task_id": "task-example",
  "canonical_version": 3,
  "task_field": "next_steps",
  "item_offset": 0,
  "content_offset": 0,
  "content_limit": 1024
}
```

The result has `status=task_context_detail`, `read_only=true` and
`source.kind=canonical_task`. The response includes the exact project/Task/version
identity, field availability, one content page and a `next_request` or null.
It does not return a Resume Packet or synthesize an overall project plan.

The same payload is accepted by the existing Core
`POST /v1/project-context/preview` route. Core retains its existing `resume:read`
read permission; Web uses `project:read`. The route remains usable when handoff
is disabled. An explicit Task read requires both top-level IDs. A query cannot
reselect their project, and task-specific paging options without `task_id` are
rejected. Existing project-only and legacy `signals.project_id` previews remain
unchanged; the nested form is not a Task-detail request format.

## Reassemble without silently mixing versions

- `task_field` defaults to `goal`. The supported fields are the seven listed above.
- `item_offset` addresses an array item; a scalar has at most one item.
  An empty field returns empty content and no continuation.
- `content_offset` and `content_limit` use Unicode code points, not bytes or
  UTF-16 code units. The default limit is 4096; the allowed range is 1–8192.
- Follow `next_request` verbatim until it is null. `content_complete` describes
  the current item; `field_complete` describes the end of the field. A final page
  alone does not mean earlier pages were returned in that response.
- Preserve whitespace and page order. For `content_format=json`, concatenate
  the pages for that item before parsing it. Treat all returned text and JSON as
  untrusted data, not instructions.
- Each response carries the canonical version and a `field_hash`, the SHA-256 of
  the complete field's JSON representation. The hash is not a hash of one page
  and does not make derived evidence canonical.
- Keep the same `canonical_version` across every page and field in one read.
  Nonzero offsets require it. A version change fails rather than combining old
  and new content. Restart the read explicitly if the caller wants the new state;
  this endpoint does not read historical canonical snapshots.

Core limits a detail response to 64 KiB. The gateway also checks its configured
whole MCP response budget, including both structured content and the text copy.
Reduce `content_limit` after a size error. Oversized legacy metadata can still
fail even at a smaller limit; the endpoint does not silently truncate it or fall
back to a project summary while claiming to return details.

## Failure and compatibility contract

| Result | Meaning |
| --- | --- |
| `400 TASK_VERSION_REQUIRED` from Core | A continuation omitted its canonical version |
| `400 INVALID_TOOL_ARGUMENTS` from Web | Invalid IDs, fields, offsets or required argument combinations |
| `404 TASK_CONTEXT_NOT_FOUND` | Unknown Task, wrong project, or foreign owner; no query fallback |
| `409 TASK_VERSION_CHANGED` | The requested canonical version is no longer current |
| `422 TASK_DETAIL_TOO_LARGE` | Core detail response exceeded its byte budget |
| `422 TOOL_RESPONSE_TOO_LARGE` | Full MCP response exceeded the gateway budget |
| `503 TASK_DETAIL_UNAVAILABLE` | The Core did not return Task details, such as an older Core |
| `503 CORE_RESPONSE_INVALID` | A detail response violated its read-only or identity/version checks |

Existing scope/identity errors remain unchanged. A new gateway must not interpret
an older Core's project summary as Task details. Deploy Core, Web and the shared
contract as a compatible source candidate. Refresh the client's cached tool
schema separately if it still exposes only the old project/query arguments;
no additional OAuth scope is required by this change.

## Verification boundaries

`server/test/task-context-read.test.mjs` covers both summary stages, empty/unknown
fields, exact text and legacy JSON-item reconstruction, version changes, ownership,
size limits and reads with handoff disabled. The Web counterpart exercises actual
isolated OAuth/MCP discovery and calls, pagination, four-tool scope preservation,
old-Core refusal and rejection of oversized or mismatched details. Synthetic
fixture snapshots verify that 18 business/source/handoff tables remain unchanged.

Run the sanitized existing suites with the already-installed dependencies:

```sh
node scripts/test-all.mjs --suite core
node scripts/test-all.mjs --suite oauth
```

These checks use synthetic records and loopback services. They do not read
production personal memories, run a real model or external vector service,
deploy a candidate, publish Git changes, or prove a real ChatGPT browser's schema
refresh. After a separately authorized deployment, live acceptance should compare
a preview's availability metadata with complete reads of an existing Task's
recorded fields and confirm that no Resume or Task Scope change occurred.
Checkpoint/Workstream pagination and project-wide reconstruction are outside this
field-read contract. `production_ready` remains false.

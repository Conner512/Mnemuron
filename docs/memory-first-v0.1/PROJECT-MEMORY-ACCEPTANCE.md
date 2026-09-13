# Project memory acceptance

Memory First does not require every memory to belong to a Project or Task. A
successful user-memory search verifies retrieval, not project creation. This
acceptance contract separates those claims without relabeling existing data.

## Identifiers and association

| Input or record | Meaning |
| --- | --- |
| A marker written in memory content | Searchable text, not a new project |
| `project_id` in a preview | Exact canonical ID within the authenticated owner |
| A registered project name or alias in `query` | Resolver input, subject to confidence and ambiguity checks |
| `scope=project` with an owned `project_id` when saving | Explicit project association |
| `scope=task` with an owned `task_id` when saving | Project derived from that Task; a conflicting project is rejected |
| An unassociated `scope=user` memory | Shared user context; no inferred project or Task |

Registering a project alias does not retroactively attach memories that mention
it. Passing an alias as `project_id` does not resolve it; unknown and foreign IDs
fail closed. No project is automatically created by search or preview.

Project-filtered memory **search can include shared user memories**. Their returned
`scope` and `project_id` must be inspected; a search hit is not proof of project
membership. Project Context Preview instead includes active memories with the
matching project association, including Task/Workstream memories in that project.

## Context, not invented state

Project preview returns canonical Tasks and their recorded goals, progress,
decisions, blockers and next steps separately from typed memories. The eight
memory types are `goal`, `fact`, `constraint`, `decision`, `completed`, `blocker`,
`remaining` and `next_step`. Reading or correcting a typed memory does not promote
its content into canonical Task state.

An existing project can be previewed without any Task. Empty lists remain empty;
one fact does not imply a goal, completion, blocker or next step. Clients should
label a canonical field unrecorded only when `field_availability.recorded=false`.
An omitted or partial field is not unrecorded; absent metadata from older responses
is unknown. Neither case should be filled from inference.

Only active memories belong in a current preview. Superseded/retracted memories
remain available through an explicit historical read with their original source
and status. Preview text is bounded, and the Web gateway may produce a summary
projection. Read a returned memory ID using `mnemuron_get_memory` and follow
pagination to verify full content and source versions.

For canonical goals, progress, decisions, blockers and next steps, use a Task's
`detail_request` with the same existing project preview tool and follow versioned
field pagination. See [read-only Task details](TASK-DETAIL-READ.md). This reads
canonical data directly, not a substitute plan assembled from memories.

## Reproducible isolated checks

Run the existing sanitized runner with Node 24 and the already-locked OAuth/Web
dependencies:

```sh
node scripts/test-all.mjs --suite core
node scripts/test-all.mjs --suite oauth
```

`server/test/project-memory-context.test.mjs` and
`adapters/chatgpt-web/test/project-memory-context.test.mjs` add these checks:

- Two synthetic writer identities save all eight memory types over Core HTTP;
  Task-scoped saves derive the correct project and keep their source identity.
- Two read-only Core clients and a same-origin OAuth/MCP client retrieve the same
  associated project content by canonical ID, exact name and registered aliases.
- An earlier user-memory marker remains unassociated after alias registration.
  Shared search results do not contaminate project preview; same-text foreign
  owner/project records do not leak into it.
- Empty and memory-only projects do not require a Task or fabricate a plan.
- Actual OAuth login/consent/code exchange, MCP discovery, search and full reads
  retain source hashes and versions; the Web credential still cannot write.
- Correction and retraction change current views while preserving history and
  canonical Tasks. Repeated reads leave 18 business/source/handoff tables intact;
  expected read audit records are not counted as business mutations.

All data, credentials and services in these checks are temporary synthetic
fixtures on loopback. No model, external vector service or production personal
memory is needed. This is application-path evidence, not a real browser session.

## Separate live-client acceptance

Use an existing, authorized canonical project ID. Do not turn a user-memory
marker into a project just to make a check pass. In ChatGPT Web, request a
read-only `mnemuron_preview_project_context` with that `project_id`; an optional
`query` does not reselect or filter the project.

Verify that the returned project ID, recorded Tasks and associated memories match
expectations, then read a returned memory ID if full content verification is
needed. Never request writes, a Resume, Task Scope changes or handoff for this
check. If project details are absent, record that specific gap; do not infer a
failure of unrelated user-memory retrieval. Local checks, live-client evidence,
deployment and production readiness remain distinct acceptance gates.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMnemuronApp } from "../lib/app.mjs";

async function api(baseUrl, apiKey, method, endpoint, body, expectedStatus = 200) {
  const response = await fetch(new URL(endpoint, baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(data));
  return data;
}

function task(taskId, title, status = "active") {
  return {
    task_id: taskId,
    project_id: "project-mnemuron",
    project_name: "Mnemuron",
    title,
    aliases: [],
    goal: `Complete ${title}.`,
    status,
    progress: [`${title} has source-backed progress.`],
    decisions: [],
    blockers: [],
    next_steps: [],
    resources: [],
    workstreams: [{ workstream_id: `workstream-${taskId}`, name: title, status }],
    conflicts: [],
  };
}

test("project memory preview is source-rich and creates no Resume or Task Scope state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-project-context-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const agent = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "Project context test",
      device_id: "macbook-project-context",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-macbook-project-context",
    }, 201);
    await api(baseUrl, admin.api_key, "POST", "/v1/projects", {
      project_id: "project-mnemuron",
      name: "Mnemuron",
      aliases: ["跨 Agent 记忆"],
      git_remotes: ["https://github.com/example/mnemuron.git"],
      repo_fingerprints: ["sha256:project-context"],
      path_hints: ["/Users/test/Documents/Mnemuron"],
    });
    const active = task("task-context-active", "Project Context Active");
    active.goal = `Complete a bounded Project view. ${"goal ".repeat(40_000)}`;
    active.progress = [`Source detail remains in Mnemuron. ${"progress ".repeat(30_000)}`];
    active.workstreams.push({
      workstream_id: "workstream-macbook",
      name: "MacBook branch",
      status: "active",
    });
    active.conflicts = [{
      field: "next_steps",
      left: {
        value: "Continue on the source Agent.",
        workstream_id: active.workstreams[0].workstream_id,
        provenance: { agent_instance_id: "chatgpt-macmini-project-context" },
      },
      right: {
        value: "Continue on the destination Agent.",
        workstream_id: "workstream-macbook",
        provenance: { agent_instance_id: "chatgpt-macbook-project-context" },
      },
    }];
    const completed = task("task-context-completed", "Project Context Completed", "completed");
    await api(baseUrl, admin.api_key, "POST", "/v1/tasks", active);
    await api(baseUrl, admin.api_key, "POST", "/v1/tasks", completed);
    await api(baseUrl, agent.api_key, "POST", "/v1/memories", {
      content: "Project context must preserve cross-device provenance.",
      scope: "project",
      project_id: "project-mnemuron",
    }, 201);
    const eventId = randomUUID();
    const accepted = await api(baseUrl, agent.api_key, "POST", "/v1/events", {
      event: {
        event_id: eventId,
        event_type: "assistant_message",
        captured_at: new Date().toISOString(),
        project_id: active.project_id,
        task_id: active.task_id,
        workstream_id: active.workstreams[0].workstream_id,
        session_id: "session-project-context",
        content: "Project Context Active reached its first checkpoint.",
      },
    }, 202);
    assert.equal(accepted.checkpoints[0].status, "created");

    const resumeCountBefore = app.store.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count;
    const preview = await api(baseUrl, agent.api_key, "POST", "/v1/project-context/preview", {
      query: "Mnemuron",
    });
    assert.equal(preview.schema_version, "project-memory-preview-v0.1");
    assert.equal(preview.status, "project_context_preview");
    assert.equal(preview.read_only, true);
    assert.equal(preview.project.project_id, "project-mnemuron");
    assert.equal(preview.tasks.length, 2);
    assert.equal(preview.source_summary.active_task_count, 1);
    assert.equal(preview.structured_memories.length, 1);
    assert.equal(preview.structured_memories[0].provenance.device_id, "macbook-project-context");
    assert.equal(preview.recent_activity[0].event_id, eventId);
    assert.equal(preview.recent_activity[0].provenance.agent_instance_id,
      "chatgpt-macbook-project-context");
    assert.equal(preview.tasks.find((item) => item.task_id === active.task_id)
      .latest_checkpoints.length, 1);
    assert.equal(preview.safety.resume_created, false);
    assert.equal(preview.safety.task_scope_changed, false);
    assert.equal(preview.safety.context_injected, false);
    assert.equal(preview.safety.task_selection_required_before_resume, true);
    assert.deepEqual(new Set(preview.next_action.task_ids), new Set([active.task_id, completed.task_id]));
    assert.equal(preview.resume_id, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 128 * 1024);
    assert.equal(preview.projection.response_budget_bytes, 128 * 1024);
    assert.equal(preview.projection.raw_payload_included, false);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count,
      resumeCountBefore);

    const resolverCountBefore = app.store.db.prepare(
      "SELECT COUNT(*) AS count FROM resolver_selections",
    ).get().count;
    const branches = await api(baseUrl, agent.api_key, "POST", "/v1/task-branches/preview", {
      query: active.task_id,
    });
    assert.equal(branches.schema_version, "task-branches-preview-v0.1");
    assert.equal(branches.status, "task_branches_preview");
    assert.equal(branches.read_only, true);
    assert.equal(branches.task.task_id, active.task_id);
    assert.deepEqual(new Set(branches.branches.map((branch) => branch.workstream_id)), new Set([
      active.workstreams[0].workstream_id,
      "workstream-macbook",
    ]));
    assert.equal(branches.branches.find((branch) =>
      branch.workstream_id === active.workstreams[0].workstream_id)
      .latest_checkpoint.provenance.agent_instance_id, "chatgpt-macbook-project-context");
    assert.equal(branches.conflicts.length, 1);
    assert.equal(branches.conflicts[0].left.workstream_id, active.workstreams[0].workstream_id);
    assert.equal(branches.conflicts[0].right.workstream_id, "workstream-macbook");
    assert.equal(branches.conflict_summary.source_preserved, true);
    assert.equal(branches.conflict_summary.automatic_merge_performed, false);
    assert.equal(branches.safety.resume_created, false);
    assert.equal(branches.safety.task_scope_changed, false);
    assert.equal(branches.safety.context_injected, false);
    assert.equal(branches.safety.canonical_task_changed, false);
    assert.equal(branches.resume_id, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(branches)) < 128 * 1024);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count,
      resumeCountBefore);
    assert.equal(app.store.db.prepare(
      "SELECT COUNT(*) AS count FROM resolver_selections",
    ).get().count, resolverCountBefore);

    const pathOnly = await api(baseUrl, agent.api_key, "POST", "/v1/project-context/preview", {
      query: "继续",
      signals: { cwd: "/Users/test/Documents/Mnemuron/server" },
    });
    assert.equal(pathOnly.status, "ambiguous");
    assert.equal(pathOnly.resume_id, undefined);

    const unknown = await api(baseUrl, agent.api_key, "POST", "/v1/project-context/preview", {
      query: "project-does-not-exist",
    });
    assert.equal(unknown.status, "no_match");
    assert.equal(unknown.resume_id, undefined);
  } finally {
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

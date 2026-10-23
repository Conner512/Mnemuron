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

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-branch-resume-v01-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const admin = app.store.bootstrapAdmin();
  const agent = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
    label: "Branch resume test Agent",
    device_id: "branch-resume-test",
    agent_id: "chatgpt",
    agent_instance_id: "chatgpt-branch-resume-test",
  }, 201);
  const task = {
    task_id: "task-branch-resume-test",
    project_id: "project-mnemuron",
    project_name: "Mnemuron",
    title: "Branch-aware Resume Test",
    aliases: ["branch resume"],
    goal: "Select exact source Workstreams before confirmation.",
    status: "active",
    progress: ["Branches exist."],
    decisions: [],
    blockers: [],
    next_steps: ["Select one source branch."],
    resources: [],
    workstreams: [
      { workstream_id: "workstream-clientb", name: "Client B", status: "active" },
      { workstream_id: "workstream-clienta", name: "Client A", status: "active" },
    ],
    conflicts: [{
      conflict_id: "conflict-branch-test",
      subject: "next_step",
      status: "unresolved",
      claims: [
        { value: "mini", workstream_id: "workstream-clientb" },
        { value: "book", workstream_id: "workstream-clienta" },
      ],
    }],
  };
  await api(baseUrl, admin.api_key, "POST", "/v1/tasks", task);

  for (const [workstreamId, sessionId, content] of [
    ["workstream-clientb", "session-mini", "Client B branch result."],
    ["workstream-clienta", "session-book", "Client A branch result."],
  ]) {
    await api(baseUrl, agent.api_key, "POST", "/v1/events", {
      event: {
        event_id: randomUUID(),
        event_type: "user_message",
        captured_at: new Date().toISOString(),
        project_id: task.project_id,
        task_id: task.task_id,
        workstream_id: workstreamId,
        session_id: sessionId,
        content,
      },
    }, 202);
    await api(
      baseUrl,
      agent.api_key,
      "POST",
      `/v1/sessions/${sessionId}/checkpoint`,
      { task_id: task.task_id, workstream_id: workstreamId },
      201,
    );
  }

  await api(baseUrl, agent.api_key, "POST", "/v1/memories", {
    content: "Shared project constraint.",
    scope: "project",
    project_id: task.project_id,
  }, 201);
  await api(baseUrl, agent.api_key, "POST", "/v1/memories", {
    content: "Client B branch memory.",
    scope: "workstream",
    project_id: task.project_id,
    task_id: task.task_id,
    workstream_id: "workstream-clientb",
  }, 201);
  await api(baseUrl, agent.api_key, "POST", "/v1/memories", {
    content: "Client A branch memory.",
    scope: "workstream",
    project_id: task.project_id,
    task_id: task.task_id,
    workstream_id: "workstream-clienta",
  }, 201);
  return { root, app, baseUrl, key: agent.api_key, task };
}

async function cleanup(context) {
  if (context.app.server.listening) await context.app.close();
  rmSync(context.root, { recursive: true, force: true });
}

test("Resume Preview freezes one exact source Workstream through confirmation", async () => {
  const context = await fixture();
  try {
    const preview = await api(context.baseUrl, context.key, "POST", "/v1/resume/preview", {
      query: context.task.task_id,
      source_workstream_ids: ["workstream-clientb"],
    }, 201);
    assert.equal(preview.branch_selection.schema_version, "resume-branch-selection-v0.1");
    assert.equal(preview.branch_selection.explicit, true);
    assert.equal(preview.branch_selection.mode, "single");
    assert.deepEqual(preview.branch_selection.selected_workstream_ids, ["workstream-clientb"]);
    assert.deepEqual(preview.workstreams.map((item) => item.workstream_id), ["workstream-clientb"]);
    assert.deepEqual(preview.latest_checkpoints.map((item) => item.workstream_id), ["workstream-clientb"]);
    assert.ok(preview.recent_activity.length > 0);
    assert.ok(preview.recent_activity.every((item) => item.workstream_id === "workstream-clientb"));
    assert.ok(preview.structured_memories.some((item) => item.content === "Shared project constraint."));
    assert.ok(preview.structured_memories.some((item) => item.content === "Client B branch memory."));
    assert.ok(!preview.structured_memories.some((item) => item.content === "Client A branch memory."));
    assert.equal(preview.conflicts.length, 1);
    assert.equal(preview.conflict_summary.automatic_merge_performed, false);

    const confirmed = await api(
      context.baseUrl,
      context.key,
      "POST",
      `/v1/resume/${preview.resume_id}/confirm`,
      { preview_version: preview.preview_version, confirmed: true },
    );
    assert.deepEqual(
      confirmed.resume_packet.selected_workstreams.map((item) => item.workstream_id),
      ["workstream-clientb"],
    );
    assert.deepEqual(confirmed.resume_packet.branch_selection, preview.branch_selection);
    assert.deepEqual(
      confirmed.resume_packet.context.latest_checkpoints.map((item) => item.workstream_id),
      ["workstream-clientb"],
    );
  } finally {
    await cleanup(context);
  }
});

test("multiple branches form an explicit combined view without automatic merge", async () => {
  const context = await fixture();
  try {
    const preview = await api(context.baseUrl, context.key, "POST", "/v1/resume/preview", {
      query: context.task.task_id,
      source_workstream_ids: [
        "workstream-clienta",
        "workstream-clientb",
        "workstream-clienta",
      ],
    }, 201);
    assert.equal(preview.branch_selection.mode, "combined_view");
    assert.deepEqual(preview.branch_selection.selected_workstream_ids, [
      "workstream-clienta",
      "workstream-clientb",
    ]);
    assert.equal(preview.branch_selection.automatic_merge_performed, false);
    assert.equal(preview.latest_checkpoints.length, 2);
  } finally {
    await cleanup(context);
  }
});

test("unknown source Workstream fails before creating a Resume", async () => {
  const context = await fixture();
  try {
    const before = context.app.store.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count;
    const failure = await api(context.baseUrl, context.key, "POST", "/v1/resume/preview", {
      query: context.task.task_id,
      source_workstream_ids: ["workstream-does-not-exist"],
    }, 400);
    assert.match(failure.error, /Unknown source Workstream/);
    const after = context.app.store.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count;
    assert.equal(after, before);
  } finally {
    await cleanup(context);
  }
});

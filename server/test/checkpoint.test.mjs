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

const task = {
  task_id: "task-checkpoint-v01",
  project_id: "project-mnemuron",
  project_name: "Mnemuron",
  title: "Automatic Checkpoint v0.1",
  aliases: ["自动 Checkpoint"],
  goal: "Create a traceable cross-agent checkpoint automatically.",
  status: "active",
  progress: ["Raw event capture is available."],
  decisions: ["Canonical task state is not overwritten by derived checkpoints."],
  blockers: [],
  next_steps: ["Validate the checkpoint in Resume Preview."],
  resources: ["docs/checkpoint-v0.1.md"],
  workstreams: [
    { workstream_id: "workstream-clientb", name: "Client B", status: "active" },
    { workstream_id: "workstream-clienta", name: "Client A", status: "active" },
  ],
  conflicts: [],
};

test("automatic checkpoints are immutable, traceable, idempotent, and included in previews", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-checkpoint-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const mini = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "Client B ChatGPT",
      device_id: "clientb-checkpoint",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-clientb-checkpoint",
    }, 201);
    const book = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "Client A ChatGPT",
      device_id: "clienta-checkpoint",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-clienta-checkpoint",
    }, 201);
    await api(baseUrl, admin.api_key, "POST", "/v1/tasks", task);

    const userEventId = randomUUID();
    const assistantEventId = randomUUID();
    const events = [
      {
        event_id: userEventId,
        event_type: "user_message",
        hook_event_name: "UserPromptSubmit",
        captured_at: "2026-08-24T01:00:00.000Z",
        project_id: task.project_id,
        task_id: task.task_id,
        workstream_id: "workstream-clientb",
        session_id: "session-checkpoint-mini",
        content: "请实现自动 Checkpoint v0.1。",
      },
      {
        event_id: assistantEventId,
        event_type: "assistant_message",
        hook_event_name: "Stop",
        captured_at: "2026-08-24T01:01:00.000Z",
        project_id: task.project_id,
        task_id: task.task_id,
        workstream_id: "workstream-clientb",
        session_id: "session-checkpoint-mini",
        content: "已完成不可变 Checkpoint 表。确认采用规则提炼且不覆盖任务状态。无阻塞。下一步在 Client A 验证 Preview。",
        provenance: { device_id: "forged", agent_instance_id: "forged" },
      },
    ];
    const accepted = await api(baseUrl, mini.api_key, "POST", "/v1/events", { events }, 202);
    assert.equal(accepted.inserted, 2);
    assert.equal(accepted.checkpoints.length, 1);
    assert.equal(accepted.checkpoints[0].status, "created");
    const checkpoint = accepted.checkpoints[0].checkpoint;
    assert.equal(checkpoint.version, 1);
    assert.equal(checkpoint.generation.method, "deterministic-rules-v0.1");
    assert.equal(checkpoint.generation.automatic, true);
    assert.equal(checkpoint.generation.canonical_task_state_overwritten, false);
    assert.deepEqual(checkpoint.source_event_ids, [userEventId, assistantEventId]);
    assert.equal(checkpoint.provenance.device_id, "clientb-checkpoint");
    assert.equal(checkpoint.active_request.source_event_id, userEventId);
    assert.equal(checkpoint.latest_outcome.source_event_id, assistantEventId);
    assert.ok(checkpoint.completed_items.some(({ text }) => text.includes("已完成不可变")));
    assert.ok(checkpoint.decisions.some(({ text }) => text.includes("确认采用")));
    assert.equal(checkpoint.blockers.length, 0);
    assert.ok(checkpoint.recommended_next_steps.some(({ text }) => text.includes("下一步")));

    const duplicate = await api(baseUrl, mini.api_key, "POST", "/v1/events", { events }, 202);
    assert.equal(duplicate.inserted, 0);
    assert.equal(duplicate.checkpoints[0].status, "existing");

    const sessionEndId = randomUUID();
    const ended = await api(baseUrl, mini.api_key, "POST", "/v1/events", {
      event: {
        event_id: sessionEndId,
        event_type: "session_end",
        hook_event_name: "SessionEnd",
        captured_at: "2026-08-24T01:02:00.000Z",
        project_id: task.project_id,
        task_id: task.task_id,
        workstream_id: "workstream-clientb",
        session_id: "session-checkpoint-mini",
      },
    }, 202);
    assert.equal(ended.checkpoints[0].status, "skipped");
    assert.equal(ended.checkpoints[0].reason, "no_new_meaningful_events");

    const listed = await api(
      baseUrl,
      book.api_key,
      "GET",
      `/v1/tasks/${task.task_id}/checkpoints?workstream_id=workstream-clientb`,
    );
    assert.equal(listed.checkpoints.length, 1);

    const preview = await api(baseUrl, book.api_key, "POST", "/v1/resume/preview", {
      query: "自动 Checkpoint",
    }, 201);
    assert.equal(preview.latest_checkpoints.length, 1);
    assert.equal(preview.latest_checkpoints[0].checkpoint_id, checkpoint.checkpoint_id);
    assert.equal(preview.source_summary.checkpoint_count, 1);
    const confirmed = await api(
      baseUrl,
      book.api_key,
      "POST",
      `/v1/resume/${preview.resume_id}/confirm`,
      { preview_version: preview.preview_version, confirmed: true },
    );
    assert.equal(
      confirmed.resume_packet.context.latest_checkpoints[0].checkpoint_id,
      checkpoint.checkpoint_id,
    );

    app.store.db.prepare("UPDATE events SET expires_at = ? WHERE event_id IN (?, ?)")
      .run("2000-01-01T00:00:00.000Z", userEventId, assistantEventId);
    await api(baseUrl, admin.api_key, "POST", "/v1/retention/prune", {});
    const afterPrune = await api(
      baseUrl,
      book.api_key,
      "GET",
      `/v1/tasks/${task.task_id}/checkpoints`,
    );
    assert.equal(afterPrune.checkpoints[0].latest_outcome.source_event_id, assistantEventId);
    assert.match(afterPrune.checkpoints[0].latest_outcome.text, /已完成不可变/);

    const manualEventId = randomUUID();
    await api(baseUrl, book.api_key, "POST", "/v1/events", {
      event: {
        event_id: manualEventId,
        event_type: "user_message",
        captured_at: "2026-08-24T02:00:00.000Z",
        project_id: task.project_id,
        task_id: task.task_id,
        workstream_id: "workstream-clienta",
        session_id: "session-checkpoint-book",
        content: "在 Client A 上继续检查。",
      },
    }, 202);
    const manual = await api(
      baseUrl,
      book.api_key,
      "POST",
      "/v1/sessions/session-checkpoint-book/checkpoint",
      { task_id: task.task_id, workstream_id: "workstream-clienta" },
      201,
    );
    assert.equal(manual.status, "created");
    assert.equal(manual.checkpoint.version, 1);
    assert.equal(manual.checkpoint.generation.automatic, false);

    const status = await api(baseUrl, mini.api_key, "GET", "/v1/status");
    assert.equal(status.counts.checkpoints, 2);
  } finally {
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

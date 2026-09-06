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
  task_id: "task-memory-lifecycle-v01",
  project_id: "project-mnemuron",
  project_name: "Mnemuron",
  title: "Structured Memory Retrieval and Lifecycle v0.1",
  aliases: ["memory lifecycle"],
  goal: "Retrieve and explicitly correct source-preserving memories.",
  status: "active",
  progress: [],
  decisions: [],
  blockers: [],
  next_steps: [],
  resources: [],
  workstreams: [
    { workstream_id: "workstream-clientb", name: "Client B", status: "active" },
    { workstream_id: "workstream-clienta", name: "Client A", status: "active" },
  ],
  conflicts: ["A recorded Canonical conflict remains visible."],
};

test("memory retrieval ranks bounded results and presents only topic-keyed branch divergence", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-memory-retrieval-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const mini = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "Client B",
      device_id: "clientb-memory-lifecycle",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-clientb-memory-lifecycle",
    }, 201);
    const book = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "Client A",
      device_id: "clienta-memory-lifecycle",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-clienta-memory-lifecycle",
    }, 201);
    await api(baseUrl, admin.api_key, "POST", "/v1/tasks", task);

    const miniDecisionEvent = randomUUID();
    await api(baseUrl, mini.api_key, "POST", "/v1/events", { events: [
      {
        event_id: miniDecisionEvent,
        event_type: "user_message",
        captured_at: "2026-09-04T05:00:00.000Z",
        project_id: task.project_id,
        task_id: task.task_id,
        workstream_id: "workstream-clientb",
        session_id: "session-memory-mini",
        content: "决定[存储后端]：使用 SQLite。\n约束：确认前不得注入。",
      },
      {
        event_id: randomUUID(),
        event_type: "assistant_message",
        hook_event_name: "Stop",
        captured_at: "2026-09-04T05:01:00.000Z",
        project_id: task.project_id,
        task_id: task.task_id,
        workstream_id: "workstream-clientb",
        session_id: "session-memory-mini",
        content: "收到。",
      },
    ] }, 202);
    await api(baseUrl, book.api_key, "POST", "/v1/events", { events: [
      {
        event_id: randomUUID(),
        event_type: "user_message",
        captured_at: "2026-09-04T05:02:00.000Z",
        project_id: task.project_id,
        task_id: task.task_id,
        workstream_id: "workstream-clienta",
        session_id: "session-memory-book",
        content: "决定[存储后端]：使用 PostgreSQL。\n事实：另一条无主题事实。",
      },
      {
        event_id: randomUUID(),
        event_type: "assistant_message",
        hook_event_name: "Stop",
        captured_at: "2026-09-04T05:03:00.000Z",
        project_id: task.project_id,
        task_id: task.task_id,
        workstream_id: "workstream-clienta",
        session_id: "session-memory-book",
        content: "收到。",
      },
    ] }, 202);

    const before = app.store.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memories) AS memories,
        (SELECT COUNT(*) FROM resumes) AS resumes,
        (SELECT canonical_version FROM tasks WHERE task_id = ?) AS canonical_version
    `).get(task.task_id);
    const result = await api(baseUrl, book.api_key, "POST", "/v1/memories/query", {
      query: "存储后端",
      project_id: task.project_id,
      task_id: task.task_id,
      source_workstream_ids: ["workstream-clientb", "workstream-clienta"],
      memory_types: ["decision"],
      limit: 10,
    });
    assert.equal(result.schema_version, "structured-memory-retrieval-v0.1");
    assert.equal(result.read_only, true);
    assert.equal(result.result_count, 2);
    assert.ok(result.results.every((memory) => memory.ranking.score > 0));
    assert.ok(result.results.every((memory) => memory.topic === "存储后端"));
    assert.equal(result.conflict_presentation.potential_conflicts.length, 1);
    assert.deepEqual(
      result.conflict_presentation.potential_conflicts[0].workstream_ids,
      ["workstream-clienta", "workstream-clientb"],
    );
    assert.equal(
      result.conflict_presentation.potential_conflicts[0].automatic_resolution_performed,
      false,
    );
    assert.deepEqual(
      result.conflict_presentation.recorded_task_conflicts,
      task.conflicts,
    );
    assert.deepEqual(result.safety, {
      resume_created: false,
      task_scope_changed: false,
      context_injected: false,
      canonical_task_state_overwritten: false,
      memory_lifecycle_changed: false,
    });
    const after = app.store.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM memories) AS memories,
        (SELECT COUNT(*) FROM resumes) AS resumes,
        (SELECT canonical_version FROM tasks WHERE task_id = ?) AS canonical_version
    `).get(task.task_id);
    assert.deepEqual(after, before);

    const miniOnly = await api(baseUrl, mini.api_key, "POST", "/v1/memories/query", {
      query: "存储后端",
      task_id: task.task_id,
      source_workstream_ids: ["workstream-clientb"],
      include_shared: false,
    });
    assert.equal(miniOnly.result_count, 1);
    assert.equal(miniOnly.results[0].workstream_id, "workstream-clientb");
    assert.equal(miniOnly.conflict_presentation.potential_conflicts.length, 0);

    const miniMemory = result.results.find((memory) =>
      memory.workstream_id === "workstream-clientb");
    const superseded = await api(
      baseUrl,
      book.api_key,
      "POST",
      `/v1/memories/${encodeURIComponent(miniMemory.memory_id)}/supersede`,
      {
        content: "使用 SQLite WAL。",
        reason: "用户纠正存储后端描述。",
      },
    );
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.previous_memory.status, "superseded");
    assert.equal(
      superseded.previous_memory.lifecycle.superseded_by_memory_id,
      superseded.replacement_memory.memory_id,
    );
    assert.equal(
      superseded.replacement_memory.lifecycle.supersedes_memory_id,
      miniMemory.memory_id,
    );
    assert.equal(superseded.replacement_memory.source, "explicit_correction");
    assert.equal(superseded.replacement_memory.topic, "存储后端");
    assert.equal(superseded.replacement_memory.task_id, task.task_id);
    assert.equal(superseded.replacement_memory.workstream_id, "workstream-clientb");
    assert.equal(
      superseded.replacement_memory.lifecycle.actor.agent_instance_id,
      "chatgpt-clienta-memory-lifecycle",
    );

    const retried = await api(
      baseUrl,
      book.api_key,
      "POST",
      `/v1/memories/${encodeURIComponent(miniMemory.memory_id)}/supersede`,
      {
        content: "使用 SQLite WAL。",
        reason: "用户纠正存储后端描述。",
      },
    );
    assert.equal(retried.status, "existing");
    assert.equal(retried.idempotent, true);
    assert.equal(
      retried.replacement_memory.memory_id,
      superseded.replacement_memory.memory_id,
    );
    await api(
      baseUrl,
      book.api_key,
      "POST",
      `/v1/memories/${encodeURIComponent(miniMemory.memory_id)}/supersede`,
      { content: "使用不同替代内容。" },
      409,
    );

    const active = await api(baseUrl, book.api_key, "POST", "/v1/memories/query", {
      query: "SQLite WAL",
      task_id: task.task_id,
      statuses: ["active"],
    });
    assert.equal(active.result_count, 1);
    assert.equal(active.results[0].memory_id, superseded.replacement_memory.memory_id);
    const history = await api(baseUrl, book.api_key, "POST", "/v1/memories/query", {
      query: "SQLite",
      task_id: task.task_id,
      statuses: ["active", "superseded"],
    });
    assert.ok(history.results.some((memory) => memory.memory_id === miniMemory.memory_id));
    assert.ok(history.results.some((memory) =>
      memory.memory_id === superseded.replacement_memory.memory_id));

    const retracted = await api(
      baseUrl,
      mini.api_key,
      "POST",
      `/v1/memories/${encodeURIComponent(superseded.replacement_memory.memory_id)}/retract`,
      { reason: "该修正不再有效。" },
    );
    assert.equal(retracted.status, "retracted");
    assert.equal(retracted.memory.status, "retracted");
    assert.equal(retracted.physically_deleted, false);
    const retractRetry = await api(
      baseUrl,
      mini.api_key,
      "POST",
      `/v1/memories/${encodeURIComponent(superseded.replacement_memory.memory_id)}/retract`,
      { reason: "该修正不再有效。" },
    );
    assert.equal(retractRetry.status, "existing");
    assert.equal(retractRetry.idempotent, true);

    const finalStatus = await api(baseUrl, book.api_key, "GET", "/v1/status");
    assert.equal(finalStatus.structured_memory.superseded, 1);
    assert.equal(finalStatus.structured_memory.retracted, 1);
    assert.equal(app.store.db.prepare(
      "SELECT canonical_version FROM tasks WHERE task_id = ?",
    ).get(task.task_id).canonical_version, before.canonical_version);
    assert.deepEqual(
      app.store.db.prepare(`
        SELECT action FROM audit_events
        WHERE action IN ('memory.query', 'memory.supersede', 'memory.retract')
        GROUP BY action ORDER BY action
      `).all().map((row) => row.action),
      ["memory.query", "memory.retract", "memory.supersede"],
    );
    assert.equal(
      app.store.db.prepare("SELECT COUNT(*) AS count FROM memories").get().count,
      before.memories + 1,
    );
    assert.equal(
      app.store.db.prepare(
        "SELECT COUNT(*) AS count FROM memories WHERE memory_id = ?",
      ).get(superseded.replacement_memory.memory_id).count,
      1,
    );
    assert.deepEqual(JSON.parse(app.store.db.prepare(
      "SELECT source_event_ids_json FROM memories WHERE memory_id = ?",
    ).get(miniMemory.memory_id).source_event_ids_json), [miniDecisionEvent]);
  } finally {
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory query and lifecycle requests fail closed on invalid input", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-memory-lifecycle-invalid-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const agent = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "Agent",
      device_id: "device-memory-invalid",
      agent_id: "chatgpt",
      agent_instance_id: "agent-memory-invalid",
    }, 201);
    await api(baseUrl, agent.api_key, "POST", "/v1/memories/query", { query: "" }, 400);
    await api(baseUrl, agent.api_key, "POST", "/v1/memories/query", {
      query: "anything",
      statuses: [],
    }, 400);
    await api(baseUrl, agent.api_key, "POST", "/v1/memories/query", {
      query: "anything",
      memory_types: ["opinion"],
    }, 400);
    await api(baseUrl, agent.api_key, "POST", "/v1/memories/query", {
      query: "anything",
      limit: "10",
    }, 400);
    await api(baseUrl, agent.api_key, "POST", "/v1/memories/not-present/supersede", {
      content: "replacement",
    }, 404);
    await api(baseUrl, agent.api_key, "POST", "/v1/memories/not-present/retract", {}, 404);
  } finally {
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

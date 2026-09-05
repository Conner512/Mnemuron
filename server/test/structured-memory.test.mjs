import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
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
  task_id: "task-structured-memory-v01",
  project_id: "project-mnemuron",
  project_name: "Mnemuron",
  title: "Automatic Structured Memory v0.1",
  aliases: ["结构化记忆"],
  goal: "Derive conservative long-term memories from explicit source statements.",
  status: "active",
  progress: [],
  decisions: [],
  blockers: [],
  next_steps: [],
  resources: [],
  workstreams: [
    { workstream_id: "workstream-macmini", name: "Mac mini", status: "active" },
    { workstream_id: "workstream-macbook", name: "MacBook", status: "active" },
  ],
  conflicts: [],
};

test("automatic structured memories are strict, traceable, idempotent, and branch-preserving", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-structured-memory-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const mini = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "Mac mini ChatGPT",
      device_id: "macmini-structured-memory",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-macmini-structured-memory",
    }, 201);
    const book = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "MacBook ChatGPT",
      device_id: "macbook-structured-memory",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-macbook-structured-memory",
    }, 201);
    await api(baseUrl, admin.api_key, "POST", "/v1/tasks", task);

    const userEventId = randomUUID();
    const assistantEventId = randomUUID();
    const labeledEvents = [
      {
        event_id: userEventId,
        event_type: "user_message",
        captured_at: "2026-09-04T01:00:00.000Z",
        project_id: task.project_id,
        task_id: task.task_id,
        workstream_id: "workstream-macmini",
        session_id: "session-structured-memory-mini",
        content: "约束：确认前不得注入。\n决定：使用严格标签生成长期记忆。",
      },
      {
        event_id: assistantEventId,
        event_type: "assistant_message",
        hook_event_name: "Stop",
        captured_at: "2026-09-04T01:01:00.000Z",
        project_id: task.project_id,
        task_id: task.task_id,
        workstream_id: "workstream-macmini",
        session_id: "session-structured-memory-mini",
        content: "已完成：自动结构化记忆已生成。\n阻塞：无\n下一步：验证跨分支保留。",
      },
    ];
    const accepted = await api(baseUrl, mini.api_key, "POST", "/v1/events", {
      events: labeledEvents,
    }, 202);
    assert.equal(accepted.checkpoints.length, 1);
    assert.equal(accepted.checkpoints[0].status, "created");
    assert.deepEqual(
      {
        extracted: accepted.checkpoints[0].structured_memories.extracted,
        created: accepted.checkpoints[0].structured_memories.created,
        existing: accepted.checkpoints[0].structured_memories.existing,
      },
      { extracted: 4, created: 4, existing: 0 },
    );
    const checkpointId = accepted.checkpoints[0].checkpoint.checkpoint_id;
    const rows = app.store.db.prepare(`
      SELECT * FROM memories
      WHERE task_id = ? AND workstream_id = ?
      ORDER BY memory_type, content
    `).all(task.task_id, "workstream-macmini");
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((row) => row.memory_type), [
      "completed",
      "constraint",
      "decision",
      "next_step",
    ]);
    assert.ok(rows.every((row) => row.status === "active"));
    assert.ok(rows.every((row) => row.scope === "workstream"));
    assert.ok(rows.every((row) => row.source === "checkpoint_derived"));
    assert.ok(rows.every((row) => row.source_checkpoint_id === checkpointId));
    assert.ok(rows.every((row) => row.content_fingerprint));
    assert.equal(rows.some((row) => row.memory_type === "blocker"), false);

    const constraint = rows.find((row) => row.memory_type === "constraint");
    assert.equal(constraint.confidence, 0.95);
    assert.equal(constraint.confidence_label, "high");
    assert.deepEqual(JSON.parse(constraint.source_event_ids_json), [userEventId]);
    assert.deepEqual(JSON.parse(constraint.warnings_json), []);
    const completed = rows.find((row) => row.memory_type === "completed");
    assert.equal(completed.confidence, 0.75);
    assert.equal(completed.confidence_label, "medium");
    assert.deepEqual(JSON.parse(completed.source_event_ids_json), [assistantEventId]);
    assert.equal(JSON.parse(completed.warnings_json).length, 1);

    const duplicate = await api(baseUrl, mini.api_key, "POST", "/v1/events", {
      events: labeledEvents,
    }, 202);
    assert.equal(duplicate.inserted, 0);
    assert.equal(duplicate.checkpoints[0].status, "existing");
    assert.equal(duplicate.checkpoints[0].structured_memories.created, 0);
    assert.equal(duplicate.checkpoints[0].structured_memories.existing, 4);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM memories").get().count, 4);

    const unlabeled = await api(baseUrl, mini.api_key, "POST", "/v1/events", {
      events: [
        {
          event_id: randomUUID(),
          event_type: "user_message",
          captured_at: "2026-09-04T01:10:00.000Z",
          project_id: task.project_id,
          task_id: task.task_id,
          workstream_id: "workstream-macmini",
          session_id: "session-unlabeled-mini",
          content: "我们聊一下记忆生成，但这不是需要保存的正式事实。",
        },
        {
          event_id: randomUUID(),
          event_type: "assistant_message",
          hook_event_name: "Stop",
          captured_at: "2026-09-04T01:11:00.000Z",
          project_id: task.project_id,
          task_id: task.task_id,
          workstream_id: "workstream-macmini",
          session_id: "session-unlabeled-mini",
          content: "普通对话已完成，但没有结构化标签。",
        },
      ],
    }, 202);
    assert.equal(unlabeled.checkpoints[0].structured_memories.extracted, 0);
    assert.equal(unlabeled.checkpoints[0].structured_memories.created, 0);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM memories").get().count, 4);

    const branchDecisionEventId = randomUUID();
    const branchAccepted = await api(baseUrl, book.api_key, "POST", "/v1/events", {
      events: [
        {
          event_id: branchDecisionEventId,
          event_type: "user_message",
          captured_at: "2026-09-04T02:00:00.000Z",
          project_id: task.project_id,
          task_id: task.task_id,
          workstream_id: "workstream-macbook",
          session_id: "session-structured-memory-book",
          content: "决定：使用严格标签生成长期记忆。",
        },
        {
          event_id: randomUUID(),
          event_type: "assistant_message",
          hook_event_name: "Stop",
          captured_at: "2026-09-04T02:01:00.000Z",
          project_id: task.project_id,
          task_id: task.task_id,
          workstream_id: "workstream-macbook",
          session_id: "session-structured-memory-book",
          content: "收到。",
        },
      ],
    }, 202);
    assert.equal(branchAccepted.checkpoints[0].structured_memories.created, 1);
    const matchingDecisions = app.store.db.prepare(`
      SELECT workstream_id, content_fingerprint FROM memories
      WHERE task_id = ? AND memory_type = 'decision' AND content = ?
      ORDER BY workstream_id
    `).all(task.task_id, "使用严格标签生成长期记忆。");
    assert.equal(matchingDecisions.length, 2);
    assert.notEqual(matchingDecisions[0].content_fingerprint, matchingDecisions[1].content_fingerprint);

    const preview = await api(baseUrl, book.api_key, "POST", "/v1/resume/preview", {
      query: task.task_id,
      source_workstream_ids: ["workstream-macmini"],
    }, 201);
    assert.equal(preview.branch_selection.mode, "single");
    assert.ok(preview.structured_memories.length >= 4);
    assert.ok(preview.structured_memories.every((memory) =>
      memory.workstream_id === "workstream-macmini"));
    const previewDecision = preview.structured_memories.find((memory) =>
      memory.memory_type === "decision");
    assert.equal(previewDecision.status, "active");
    assert.equal(previewDecision.source_checkpoint_id, checkpointId);
    assert.deepEqual(previewDecision.source_event_ids, [userEventId]);
    assert.equal(previewDecision.generation.method, "strict-labeled-statements-v0.1");
    assert.equal(previewDecision.generation.confidence_label, "high");

    const explicit = await api(baseUrl, book.api_key, "POST", "/v1/memories", {
      content: "用户显式保存的项目事实。",
      scope: "project",
      project_id: task.project_id,
      memory_type: "fact",
    }, 201);
    assert.equal(explicit.memory.source, "explicit");
    assert.equal(explicit.memory.status, "active");
    assert.equal(explicit.memory.generation.method, "explicit-user-save-v0.1");
    assert.equal(explicit.memory.generation.confidence, 1);
    const status = await api(baseUrl, book.api_key, "GET", "/v1/status");
    assert.equal(status.structured_memory.active, 6);
    assert.equal(status.structured_memory.checkpoint_derived, 5);
    assert.equal(status.structured_memory.explicit, 1);
    assert.equal(status.structured_memory.by_type.decision, 2);
    assert.equal(status.structured_memory.automatic_merge_performed, false);

    app.store.db.prepare("UPDATE events SET expires_at = ? WHERE event_id IN (?, ?)")
      .run("2000-01-01T00:00:00.000Z", userEventId, assistantEventId);
    await api(baseUrl, admin.api_key, "POST", "/v1/retention/prune", {});
    const afterPrune = await api(baseUrl, book.api_key, "POST", "/v1/project-context/preview", {
      query: "Mnemuron",
    });
    const retained = afterPrune.structured_memories.find((memory) =>
      memory.source_checkpoint_id === checkpointId && memory.memory_type === "constraint");
    assert.equal(retained.content, "确认前不得注入。");
    assert.deepEqual(retained.source_event_ids, [userEventId]);
    assert.equal(afterPrune.safety.context_injected, false);
  } finally {
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy memory rows migrate additively without being rewritten or removed", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-memory-migration-"));
  const databasePath = path.join(root, "legacy.sqlite3");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE memories (
      memory_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      credential_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      agent_instance_id TEXT NOT NULL,
      content TEXT NOT NULL,
      scope TEXT NOT NULL,
      project_id TEXT,
      task_id TEXT,
      workstream_id TEXT,
      session_id TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO memories VALUES (
      'memory-legacy', 'user-local', 'credential-legacy', 'device-legacy',
      'chatgpt', 'agent-legacy', 'legacy content', 'project', 'project-legacy',
      NULL, NULL, NULL, 'explicit', '2026-09-01T00:00:00.000Z'
    );
  `);
  legacy.close();

  const app = createMnemuronApp({ databasePath });
  try {
    const row = app.store.db.prepare("SELECT * FROM memories WHERE memory_id = 'memory-legacy'").get();
    assert.equal(row.content, "legacy content");
    assert.equal(row.memory_type, "fact");
    assert.equal(row.status, "active");
    assert.equal(row.source_event_ids_json, "[]");
    assert.equal(row.warnings_json, "[]");
    assert.equal(row.content_fingerprint, null);
    assert.deepEqual(app.store.memoryFromRow(row), {
      memory_id: "memory-legacy",
      content: "legacy content",
      scope: "project",
      project_id: "project-legacy",
      task_id: null,
      workstream_id: null,
      session_id: null,
      memory_type: "fact",
      status: "active",
      topic: null,
      topic_key: null,
      source: "explicit",
      source_event_ids: [],
      source_checkpoint_id: null,
      verification: {
        submission_identity: "authenticated",
        content_evidence: "caller_submitted",
        independently_fact_checked: false,
      },
      generation: {
        method: null,
        confidence: null,
        confidence_label: null,
        warnings: [],
      },
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      lifecycle: {
        schema_version: "structured-memory-lifecycle-v0.1",
        supersedes_memory_id: null,
        superseded_by_memory_id: null,
        reason: null,
        retracted_at: null,
        actor: {},
      },
      provenance: {
        device_id: "device-legacy",
        agent_id: "chatgpt",
        agent_instance_id: "agent-legacy",
      },
    });
  } finally {
    app.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

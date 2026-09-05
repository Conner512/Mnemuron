import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMnemuronApp } from "../../../server/lib/app.mjs";
import { normalizeHookEvent } from "../scripts/hook.mjs";
import {
  activateTaskScope,
  listDeliveryReceiptOutbox,
  listInjectionEventOutbox,
  pendingResumeCounts,
  resolveTaskScope,
  stageTaskScopeForSession,
  taskScopeCounts,
} from "../scripts/storage.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(TEST_DIR, "..");
const HOOK = path.join(PLUGIN_ROOT, "scripts", "launch-hook");
const MCP = path.join(PLUGIN_ROOT, "scripts", "mcp-server.mjs");

function bindingPacket() {
  return {
    schema_version: "task-bootstrap-binding-v0.1",
    bootstrap_id: "bootstrap-chatgpt-local-v1",
    preview_version: 1,
    project: { project_id: "project-mnemuron", name: "Mnemuron" },
    task: {
      task_id: "task-bootstrap-local-v01",
      title: "Task Bootstrap local test",
      goal: "Bind one new Task without creating a Resume.",
      status: "active",
      canonical_version: 1,
    },
    workstream: {
      workstream_id: "workstream-macbook",
      name: "MacBook",
      status: "active",
      agent_id: "chatgpt",
      device_id: "macbook-example",
      agent_instance_id: "chatgpt-macbook-example",
    },
    target_session_id: "session-bootstrap-owner",
    binding_authorized_at: "2026-09-04T08:00:00.000Z",
    provenance: {
      device_id: "macbook-example",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-macbook-example",
      identity_status: "server_verified",
    },
  };
}

function startMcp(env) {
  const child = spawn(process.execPath, [MCP], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let requestId = 1;
  let stderr = "";
  const pending = new Map();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const boundary = buffer.indexOf("\n");
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (!line) continue;
      const response = JSON.parse(line);
      const waiter = pending.get(response.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(response.id);
      waiter.resolve(response);
    }
  });
  return {
    child,
    request(method, params = {}) {
      const id = requestId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP timeout while calling ${method}; stderr=${stderr}`));
        }, 5_000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
  };
}

function runHook(payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(HOOK, [], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test("Task Bootstrap binding stages pending, activates once, and stays isolated from Resume state", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-bootstrap-binding-"));
  const packet = bindingPacket();
  const env = {
    MNEMURON_CONFIG_PATH: path.join(dataDir, "missing-config.json"),
    MNEMURON_DEFAULT_WORKSTREAM_ID: packet.workstream.workstream_id,
    CODEX_THREAD_ID: "",
    CODEX_SESSION_ID: "",
  };
  try {
    const pending = stageTaskScopeForSession(
      dataDir,
      packet,
      packet.target_session_id,
      env,
    );
    assert.equal(pending.schema_version, "mnemuron-task-scope-v0.1");
    assert.equal(pending.binding_kind, "task_bootstrap");
    assert.equal(pending.binding_id, packet.bootstrap_id);
    assert.equal(pending.bootstrap_id, packet.bootstrap_id);
    assert.equal(pending.resume_id, null);
    assert.equal(pending.project_id, packet.project.project_id);
    assert.equal(pending.task_id, packet.task.task_id);
    assert.equal(pending.workstream_id, packet.workstream.workstream_id);
    assert.equal(pending.target_session_id, packet.target_session_id);
    assert.equal(pending.active_session_id, null);
    assert.equal(pending.status, "pending");
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 1, active: 0, superseded: 0 });
    assert.deepEqual(pendingResumeCounts(dataDir), { pending: 0, in_flight: 0, delivered: 0 });
    assert.deepEqual(listInjectionEventOutbox(dataDir), []);
    assert.deepEqual(listDeliveryReceiptOutbox(dataDir), []);
    assert.equal(resolveTaskScope(dataDir, packet.target_session_id, env), null);

    assert.equal(activateTaskScope(dataDir, "session-bootstrap-other", env), null);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 1, active: 0, superseded: 0 });

    const active = activateTaskScope(dataDir, packet.target_session_id, env);
    assert.equal(active.status, "active");
    assert.equal(active.binding_kind, "task_bootstrap");
    assert.equal(active.bootstrap_id, packet.bootstrap_id);
    assert.equal(active.resume_id, null);
    assert.equal(active.active_session_id, packet.target_session_id);
    const normalized = normalizeHookEvent({
      hook_event_name: "UserPromptSubmit",
      session_id: packet.target_session_id,
      turn_id: "turn-bootstrap-first",
      prompt: "开始新任务的第一轮工作。",
    }, env, new Date("2026-09-04T08:01:00.000Z"), active);
    assert.equal(normalized.project_id, packet.project.project_id);
    assert.equal(normalized.task_id, packet.task.task_id);
    assert.equal(normalized.workstream_id, packet.workstream.workstream_id);
    assert.deepEqual(normalized.raw_hook_payload.mnemuron_task_scope, {
      schema_version: "mnemuron-task-scope-v0.1",
      source: "confirmed-task-bootstrap",
      binding_kind: "task_bootstrap",
      binding_id: packet.bootstrap_id,
      resume_id: null,
      bootstrap_id: packet.bootstrap_id,
      preview_version: 1,
      project_id: packet.project.project_id,
      task_id: packet.task.task_id,
      workstream_id: packet.workstream.workstream_id,
      activated_at: active.activated_at,
    });

    const repeatedStage = stageTaskScopeForSession(
      dataDir,
      packet,
      packet.target_session_id,
      env,
    );
    assert.deepEqual(repeatedStage, active);
    const repeatedActivation = activateTaskScope(dataDir, packet.target_session_id, env);
    assert.deepEqual(repeatedActivation, active);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 0, active: 1, superseded: 0 });
    assert.equal(resolveTaskScope(dataDir, "session-bootstrap-other", env), null);
    assert.deepEqual(pendingResumeCounts(dataDir), { pending: 0, in_flight: 0, delivered: 0 });
    assert.deepEqual(listDeliveryReceiptOutbox(dataDir), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("remote Task Bootstrap Preview and Confirm bind only the next ordinary Hook turn", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-bootstrap-integration-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "server.sqlite3") });
  let client;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const adminAuth = app.store.authenticate(admin.api_key);
    app.store.upsertProject(adminAuth, {
      project_id: "project-mnemuron",
      name: "Mnemuron",
      aliases: ["Cross-Agent Memory"],
      git_remotes: [],
      repo_fingerprints: [],
      path_hints: [],
    });
    const book = app.store.registerAgent(adminAuth, {
      label: "ChatGPT MacBook bootstrap integration",
      device_id: "macbook-bootstrap-test",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-macbook-bootstrap-test",
    });
    const dataDir = path.join(root, "book");
    const sessionId = "session-bootstrap-integration";
    const env = {
      MNEMURON_MODE: "remote",
      MNEMURON_SERVER_URL: serverUrl,
      MNEMURON_ALLOW_INSECURE_HTTP: "true",
      MNEMURON_API_KEY: book.api_key,
      MNEMURON_CONFIG_PATH: path.join(root, "missing-config.json"),
      MNEMURON_SPIKE_DATA_DIR: dataDir,
      MNEMURON_DEVICE_ID: "macbook-bootstrap-test",
      MNEMURON_AGENT_ID: "chatgpt",
      MNEMURON_AGENT_INSTANCE_ID: "chatgpt-macbook-bootstrap-test",
      MNEMURON_RAW_RETENTION_DAYS: "30",
      MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-macbook-bootstrap",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
    };

    const sessionStart = await runHook({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
    }, env);
    assert.equal(sessionStart.status, 0, sessionStart.stderr);

    const preConfirm = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-before-bootstrap",
      prompt: "先描述一个尚未创建 Canonical Task 的新任务。",
    }, env);
    assert.equal(preConfirm.status, 0, preConfirm.stderr);

    client = startMcp(env);
    await client.request("initialize", { protocolVersion: "2025-06-18" });
    const previewCall = await client.request("tools/call", {
      name: "mnemuron_preview_task_bootstrap",
      arguments: {
        project_query: "Mnemuron",
        title: "Cross-device Bootstrap Acceptance",
        goal: "Create one new Canonical Task and bind this exact ChatGPT session.",
        aliases: ["Bootstrap Acceptance"],
        workstream_name: "MacBook Bootstrap",
        session_id: sessionId,
      },
    });
    const preview = previewCall.result.structuredContent;
    assert.equal(preview.status, "pending_confirmation");
    assert.equal(preview.task_scope, undefined);
    assert.equal(preview.resume_id, undefined);
    assert.equal(app.store.listTasks(book.credential.user_id).length, 0);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count, 0);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 0, active: 0, superseded: 0 });

    const confirmationPrompt = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-confirm-bootstrap",
      prompt: `确认创建任务 ${preview.bootstrap_id} v${preview.preview_version}`,
    }, env);
    assert.equal(confirmationPrompt.status, 0, confirmationPrompt.stderr);
    const confirmedCall = await client.request("tools/call", {
      name: "mnemuron_confirm_task_bootstrap",
      arguments: {
        bootstrap_id: preview.bootstrap_id,
        preview_version: preview.preview_version,
        confirmed: true,
        session_id: sessionId,
      },
    });
    const confirmed = confirmedCall.result.structuredContent;
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.idempotent, false);
    assert.equal(confirmed.binding_packet_returned, false);
    assert.equal(confirmed.task_scope.status, "pending");
    assert.equal(confirmed.task_scope.binding_kind, "task_bootstrap");
    assert.equal(confirmed.task_scope.bootstrap_id, preview.bootstrap_id);
    assert.equal(confirmed.task_scope.resume_id, null);
    assert.equal(confirmed.task_scope.target_session_id, sessionId);
    assert.deepEqual(confirmed.safety, {
      resume_created: false,
      resume_packet_returned: false,
      context_injected: false,
      historical_events_rebound: false,
    });
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 1, active: 0, superseded: 0 });
    assert.deepEqual(pendingResumeCounts(dataDir), { pending: 0, in_flight: 0, delivered: 0 });
    assert.deepEqual(listDeliveryReceiptOutbox(dataDir), []);

    const confirmationTool = await runHook({
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      turn_id: "turn-confirm-bootstrap",
      tool_name: "mcp__mnemuron__mnemuron_confirm_task_bootstrap",
      tool_input: {
        bootstrap_id: preview.bootstrap_id,
        preview_version: preview.preview_version,
        confirmed: true,
        session_id: sessionId,
      },
      tool_response: { structuredContent: confirmed },
    }, env);
    assert.equal(confirmationTool.status, 0, confirmationTool.stderr);
    const confirmationStop = await runHook({
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: "turn-confirm-bootstrap",
      last_assistant_message: "Task Bootstrap was confirmed for the next ordinary turn.",
    }, env);
    assert.equal(confirmationStop.status, 0, confirmationStop.stderr);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 1, active: 0, superseded: 0 });

    const beforeRows = app.store.db.prepare(`
      SELECT event_type, task_id, workstream_id
      FROM events
      WHERE agent_instance_id = ? AND turn_id IN (?, ?)
      ORDER BY captured_at
    `).all(
      "chatgpt-macbook-bootstrap-test",
      "turn-before-bootstrap",
      "turn-confirm-bootstrap",
    );
    assert.ok(beforeRows.length >= 3);
    assert.ok(beforeRows.every((row) => row.task_id === null && row.workstream_id === null));

    const unrelated = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-bootstrap-unrelated",
      turn_id: "turn-unrelated",
      prompt: "另一个会话不应接管这个 Task。",
    }, env);
    assert.equal(unrelated.status, 0, unrelated.stderr);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 1, active: 0, superseded: 0 });

    const firstBound = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-bootstrap-first",
      prompt: "开始执行新任务。",
    }, env);
    assert.equal(firstBound.status, 0, firstBound.stderr);
    assert.deepEqual(JSON.parse(firstBound.stdout), {});
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 0, active: 1, superseded: 0 });
    const active = resolveTaskScope(dataDir, sessionId, env);
    assert.equal(active.status, "active");
    assert.equal(active.binding_kind, "task_bootstrap");
    assert.equal(active.task_id, preview.task.task_id);
    assert.equal(resolveTaskScope(dataDir, "session-bootstrap-unrelated", env), null);

    const firstBoundEvent = app.store.db.prepare(`
      SELECT task_id, workstream_id, raw_payload_json
      FROM events
      WHERE agent_instance_id = ? AND turn_id = ? AND event_type = 'user_message'
      ORDER BY captured_at DESC LIMIT 1
    `).get("chatgpt-macbook-bootstrap-test", "turn-bootstrap-first");
    assert.equal(firstBoundEvent.task_id, preview.task.task_id);
    assert.equal(firstBoundEvent.workstream_id, "workstream-macbook-bootstrap");
    const scopeEvidence = JSON.parse(firstBoundEvent.raw_payload_json).mnemuron_task_scope;
    assert.equal(scopeEvidence.source, "confirmed-task-bootstrap");
    assert.equal(scopeEvidence.binding_kind, "task_bootstrap");
    assert.equal(scopeEvidence.bootstrap_id, preview.bootstrap_id);
    assert.equal(scopeEvidence.resume_id, null);

    const replayCall = await client.request("tools/call", {
      name: "mnemuron_confirm_task_bootstrap",
      arguments: {
        bootstrap_id: preview.bootstrap_id,
        preview_version: preview.preview_version,
        confirmed: true,
        session_id: sessionId,
      },
    });
    const replay = replayCall.result.structuredContent;
    assert.equal(replay.status, "confirmed");
    assert.equal(replay.idempotent, true);
    assert.equal(replay.task_scope.status, "active");
    assert.equal(replay.task_scope.activated_at, active.activated_at);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 0, active: 1, superseded: 0 });
    assert.equal(app.store.listTasks(book.credential.user_id).length, 1);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM task_canonical_revisions").get().count, 1);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count, 0);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM resume_delivery_receipts").get().count, 0);
    assert.equal(existsSync(path.join(dataDir, "pending-resumes")), true);
    assert.deepEqual(readdirSync(path.join(dataDir, "pending-resumes")), []);

    const afterRows = app.store.db.prepare(`
      SELECT task_id, workstream_id
      FROM events
      WHERE agent_instance_id = ? AND turn_id IN (?, ?)
    `).all(
      "chatgpt-macbook-bootstrap-test",
      "turn-before-bootstrap",
      "turn-confirm-bootstrap",
    );
    assert.ok(afterRows.every((row) => row.task_id === null && row.workstream_id === null));
  } finally {
    client?.child.kill();
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

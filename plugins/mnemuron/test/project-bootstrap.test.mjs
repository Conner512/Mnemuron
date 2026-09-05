import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMnemuronApp } from "../../../server/lib/app.mjs";
import {
  listDeliveryReceiptOutbox,
  listInjectionEventOutbox,
  pendingResumeCounts,
  resolveTaskScope,
  taskScopeCounts,
} from "../scripts/storage.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(TEST_DIR, "..");
const HOOK = path.join(PLUGIN_ROOT, "scripts", "launch-hook");
const MCP = path.join(PLUGIN_ROOT, "scripts", "mcp-server.mjs");

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

test("ChatGPT Project Bootstrap creates and binds only after Preview, Confirm, and next turn", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-project-bootstrap-integration-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "server.sqlite3") });
  let client;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const adminAuth = app.store.authenticate(admin.api_key);
    const book = app.store.registerAgent(adminAuth, {
      label: "ChatGPT MacBook Project Bootstrap",
      device_id: "macbook-project-bootstrap-test",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-macbook-project-bootstrap-test",
      scopes: [
        "capture:write",
        "memory:read",
        "project:bootstrap:preview",
        "project:bootstrap:confirm",
      ],
    });
    const dataDir = path.join(root, "book");
    const sessionId = "session-project-bootstrap-integration";
    const env = {
      MNEMURON_MODE: "remote",
      MNEMURON_SERVER_URL: serverUrl,
      MNEMURON_ALLOW_INSECURE_HTTP: "true",
      MNEMURON_API_KEY: book.api_key,
      MNEMURON_CONFIG_PATH: path.join(root, "missing-config.json"),
      MNEMURON_SPIKE_DATA_DIR: dataDir,
      MNEMURON_DEVICE_ID: "macbook-project-bootstrap-test",
      MNEMURON_AGENT_ID: "chatgpt",
      MNEMURON_AGENT_INSTANCE_ID: "chatgpt-macbook-project-bootstrap-test",
      MNEMURON_RAW_RETENTION_DAYS: "30",
      MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-macbook-project-bootstrap",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
    };

    const sessionStart = await runHook({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
    }, env);
    assert.equal(sessionStart.status, 0, sessionStart.stderr);
    const before = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-before-project-bootstrap",
      prompt: "我要创建一个此前不存在的项目。",
    }, env);
    assert.equal(before.status, 0, before.stderr);

    client = startMcp(env);
    await client.request("initialize", { protocolVersion: "2025-06-18" });
    const listed = await client.request("tools/list");
    const previewTool = listed.result.tools.find((tool) =>
      tool.name === "mnemuron_preview_project_bootstrap");
    assert.ok(previewTool);
    assert.equal(previewTool.inputSchema.additionalProperties, false);
    assert.equal(previewTool.inputSchema.properties.workstream_id, undefined);
    assert.equal(previewTool.inputSchema.properties.workstream_name, undefined);
    assert.equal(previewTool.inputSchema.properties.device_id, undefined);
    assert.equal(previewTool.inputSchema.properties.agent_instance_id, undefined);

    const previewCall = await client.request("tools/call", {
      name: "mnemuron_preview_project_bootstrap",
      arguments: {
        project_name: "Greenfield Notebook",
        project_aliases: ["Greenfield"],
        git_remotes: ["https://github.com/example/greenfield-notebook.git"],
        repo_fingerprints: ["sha256:greenfield-notebook"],
        path_hints: ["/Users/test/Documents/Greenfield Notebook"],
        task_title: "Build initial notebook workflow",
        task_goal: "Create a usable first workflow under a new Canonical Project.",
        task_aliases: ["Initial workflow"],
        session_id: sessionId,
        workstream_id: "workstream-forged-by-tool-client",
        workstream_name: "forged workstream",
        device_id: "forged-device",
        agent_id: "forged-agent",
        agent_instance_id: "forged-agent-instance",
      },
    });
    assert.equal(previewCall.result.isError, undefined);
    const preview = previewCall.result.structuredContent;
    assert.equal(preview.status, "pending_confirmation");
    assert.equal(preview.bootstrap_kind, "project_and_initial_task");
    assert.equal(preview.workstream.workstream_id, env.MNEMURON_DEFAULT_WORKSTREAM_ID);
    assert.equal(preview.workstream.name, `${env.MNEMURON_DEVICE_ID} ${env.MNEMURON_AGENT_ID}`);
    assert.equal(preview.provenance.device_id, env.MNEMURON_DEVICE_ID);
    assert.equal(preview.provenance.agent_instance_id, env.MNEMURON_AGENT_INSTANCE_ID);
    assert.equal(app.store.listProjects(book.credential.user_id).length, 0);
    assert.equal(app.store.listTasks(book.credential.user_id).length, 0);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM task_canonical_revisions")
      .get().count, 0);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 0, active: 0, superseded: 0 });

    const confirmationPrompt = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-confirm-project-bootstrap",
      prompt: `确认创建项目 ${preview.bootstrap_id} v${preview.preview_version}`,
    }, env);
    assert.equal(confirmationPrompt.status, 0, confirmationPrompt.stderr);
    const confirmedCall = await client.request("tools/call", {
      name: "mnemuron_confirm_project_bootstrap",
      arguments: {
        bootstrap_id: preview.bootstrap_id,
        preview_version: preview.preview_version,
        confirmed: true,
        session_id: sessionId,
      },
    });
    assert.equal(confirmedCall.result.isError, undefined);
    const confirmed = confirmedCall.result.structuredContent;
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.idempotent, false);
    assert.equal(confirmed.binding_packet_returned, false);
    assert.equal(confirmed.project.project_id, preview.project.project_id);
    assert.equal(confirmed.task.task_id, preview.task.task_id);
    assert.equal(confirmed.task_scope.status, "pending");
    assert.equal(confirmed.task_scope.binding_kind, "task_bootstrap");
    assert.equal(confirmed.task_scope.bootstrap_id, preview.bootstrap_id);
    assert.equal(confirmed.task_scope.resume_id, null);
    assert.equal(confirmed.task_scope.target_session_id, sessionId);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 1, active: 0, superseded: 0 });
    assert.deepEqual(pendingResumeCounts(dataDir), { pending: 0, in_flight: 0, delivered: 0 });
    assert.deepEqual(listDeliveryReceiptOutbox(dataDir), []);
    assert.deepEqual(listInjectionEventOutbox(dataDir), []);
    assert.equal(app.store.listProjects(book.credential.user_id).length, 1);
    assert.equal(app.store.listTasks(book.credential.user_id).length, 1);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM task_canonical_revisions")
      .get().count, 1);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count, 0);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM checkpoints").get().count, 0);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM memories").get().count, 0);

    const confirmationStop = await runHook({
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: "turn-confirm-project-bootstrap",
      last_assistant_message: "Project Bootstrap confirmed for the next ordinary turn.",
    }, env);
    assert.equal(confirmationStop.status, 0, confirmationStop.stderr);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 1, active: 0, superseded: 0 });

    const beforeRows = app.store.db.prepare(`
      SELECT task_id, workstream_id FROM events
      WHERE agent_instance_id = ? AND turn_id IN (?, ?)
    `).all(
      env.MNEMURON_AGENT_INSTANCE_ID,
      "turn-before-project-bootstrap",
      "turn-confirm-project-bootstrap",
    );
    assert.ok(beforeRows.length >= 3);
    assert.ok(beforeRows.every((row) => row.task_id === null && row.workstream_id === null));

    const firstBound = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-project-bootstrap-first-bound",
      prompt: "开始执行新项目的首个任务。",
    }, env);
    assert.equal(firstBound.status, 0, firstBound.stderr);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 0, active: 1, superseded: 0 });
    const active = resolveTaskScope(dataDir, sessionId, env);
    assert.equal(active.task_id, preview.task.task_id);
    assert.equal(active.project_id, preview.project.project_id);
    assert.equal(active.workstream_id, env.MNEMURON_DEFAULT_WORKSTREAM_ID);
    const event = app.store.db.prepare(`
      SELECT task_id, project_id, workstream_id, raw_payload_json
      FROM events WHERE turn_id = ? AND event_type = 'user_message'
      ORDER BY captured_at DESC LIMIT 1
    `).get("turn-project-bootstrap-first-bound");
    assert.equal(event.task_id, preview.task.task_id);
    assert.equal(event.project_id, preview.project.project_id);
    assert.equal(event.workstream_id, env.MNEMURON_DEFAULT_WORKSTREAM_ID);
    const evidence = JSON.parse(event.raw_payload_json).mnemuron_task_scope;
    assert.equal(evidence.source, "confirmed-task-bootstrap");
    assert.equal(evidence.bootstrap_id, preview.bootstrap_id);
    assert.equal(evidence.resume_id, null);

    const replayCall = await client.request("tools/call", {
      name: "mnemuron_confirm_project_bootstrap",
      arguments: {
        bootstrap_id: preview.bootstrap_id,
        preview_version: 1,
        confirmed: true,
        session_id: sessionId,
      },
    });
    assert.equal(replayCall.result.structuredContent.idempotent, true);
    assert.equal(replayCall.result.structuredContent.task_scope.status, "active");
    assert.equal(app.store.listProjects(book.credential.user_id).length, 1);
    assert.equal(app.store.listTasks(book.credential.user_id).length, 1);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM task_canonical_revisions")
      .get().count, 1);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count, 0);
    assert.deepEqual(readdirSync(path.join(dataDir, "pending-resumes")), []);
    assert.equal(existsSync(path.join(dataDir, "task-scopes")), true);
  } finally {
    client?.child.kill();
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

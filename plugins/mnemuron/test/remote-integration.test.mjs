import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMnemuronApp } from "../../../server/lib/app.mjs";
import { resolveTaskScope, taskScopeCounts } from "../scripts/storage.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(TEST_DIR, "..");
const HOOK = path.join(PLUGIN_ROOT, "scripts", "launch-hook");
const MCP = path.join(PLUGIN_ROOT, "scripts", "mcp-server.mjs");
const fixtureTask = {
  task_id: "task-mnemuron-plugin-spike",
  project_id: "project-mnemuron",
  project_name: "Mnemuron",
  title: "Mnemuron ChatGPT Plugin Spike",
  aliases: ["Mnemuron plugin", "插件原型"],
  goal: "Prove cross-device capture and resume through one central service.",
  status: "active",
  progress: ["Mac mini and MacBook local plugin tests passed."],
  decisions: ["Use preview before confirmation."],
  blockers: [],
  next_steps: ["Deploy the verified server to PVE LXC."],
  resources: ["docs/core-spec-v0.1.md"],
  workstreams: [
    { workstream_id: "workstream-macmini", name: "Mac mini", status: "active" },
    { workstream_id: "workstream-macbook", name: "MacBook", status: "active" },
  ],
  conflicts: [],
};

function startMcp(env) {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let id = 1;
  const pending = new Map();
  let stderr = "";
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
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(response.id);
        waiter.resolve(response);
      }
    }
  });
  return {
    child,
    request(method, params = {}) {
      const requestId = id++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`MCP timeout: ${stderr}`)), 5000);
        pending.set(requestId, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
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

test("Mac mini hook events can be previewed and confirmed by MacBook MCP", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-remote-plugin-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "server.sqlite3") });
  let client;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const serverUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const mini = app.store.registerAgent(app.store.authenticate(admin.api_key), {
      device_id: "macmini-example",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-macmini-example",
    });
    const book = app.store.registerAgent(app.store.authenticate(admin.api_key), {
      device_id: "macbook-example",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-macbook-example",
    });
    app.store.upsertTask(app.store.authenticate(admin.api_key), fixtureTask);

    const common = {
      MNEMURON_MODE: "remote",
      MNEMURON_SERVER_URL: serverUrl,
      MNEMURON_ALLOW_INSECURE_HTTP: "true",
      MNEMURON_RAW_RETENTION_DAYS: "30",
      MNEMURON_DEFAULT_PROJECT_ID: fixtureTask.project_id,
      MNEMURON_DEFAULT_TASK_ID: fixtureTask.task_id,
    };
    const hook = await runHook({
        hook_event_name: "Stop",
        session_id: "session-macmini",
        turn_id: "turn-1",
        project_id: fixtureTask.project_id,
        task_id: fixtureTask.task_id,
        workstream_id: "workstream-macmini",
        last_assistant_message: "Central transport is complete; deploy it to the PVE LXC next.",
      }, {
        ...common,
        MNEMURON_API_KEY: mini.api_key,
        MNEMURON_SPIKE_DATA_DIR: path.join(root, "mini"),
        MNEMURON_DEVICE_ID: "macmini-example",
        MNEMURON_AGENT_ID: "chatgpt",
        MNEMURON_AGENT_INSTANCE_ID: "chatgpt-macmini-example",
        MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-macmini",
    });
    assert.equal(hook.status, 0, hook.stderr);
    assert.deepEqual(JSON.parse(hook.stdout), {});

    const bookEnv = {
      ...common,
      MNEMURON_API_KEY: book.api_key,
      MNEMURON_SPIKE_DATA_DIR: path.join(root, "book"),
      MNEMURON_DEVICE_ID: "macbook-example",
      MNEMURON_AGENT_ID: "chatgpt",
      MNEMURON_AGENT_INSTANCE_ID: "chatgpt-macbook-example",
      MNEMURON_DEFAULT_TASK_ID: "task-chatgpt-adapter-default",
      MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-macbook",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
    };
    const sessionId = "chatgpt-book-thread";
    const sessionStart = await runHook({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
    }, bookEnv);
    assert.equal(sessionStart.status, 0, sessionStart.stderr);
    assert.match(JSON.parse(sessionStart.stdout).hookSpecificOutput.additionalContext, /v0\.1\.4/);

    client = startMcp(bookEnv);
    await client.request("initialize", { protocolVersion: "2025-06-18" });
    const statusCall = await client.request("tools/call", { name: "mnemuron_status", arguments: {} });
    const status = statusCall.result.structuredContent;
    assert.equal(status.mode, "remote-v0.1");
    assert.equal(status.identity.device_id, "macbook-example");
    assert.equal(status.adapter.plugin_version, "0.1.14+codex.20260904233116");
    assert.equal(
      status.adapter.resume_injection_mode,
      "chatgpt-mcp-delivery-receipt-v0.1.4",
    );
    assert.equal(status.adapter.sync_status, "synchronized");
    assert.deepEqual(status.adapter.task_scope_bindings, {
      pending: 0,
      active: 0,
      superseded: 0,
    });

    const projectContextCall = await client.request("tools/call", {
      name: "mnemuron_preview_project_context",
      arguments: { query: "Mnemuron" },
    });
    const projectContext = projectContextCall.result.structuredContent;
    assert.equal(projectContext.schema_version, "project-memory-preview-v0.1");
    assert.equal(projectContext.status, "project_context_preview");
    assert.equal(projectContext.project.project_id, fixtureTask.project_id);
    assert.equal(projectContext.tasks.length, 1);
    assert.equal(projectContext.tasks[0].latest_checkpoints.length, 1);
    assert.equal(projectContext.tasks[0].latest_checkpoints[0].provenance.device_id,
      "macmini-example");
    assert.equal(projectContext.safety.resume_created, false);
    assert.equal(projectContext.safety.task_scope_changed, false);
    assert.equal(projectContext.safety.context_injected, false);
    assert.equal(projectContext.resume_id, undefined);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count, 0);

    const rememberedCall = await client.request("tools/call", {
      name: "mnemuron_remember",
      arguments: {
        content: "Use SQLite for the memory lifecycle test.",
        scope: "task",
        task_id: fixtureTask.task_id,
        project_id: fixtureTask.project_id,
        memory_type: "decision",
        topic: "storage backend",
      },
    });
    const remembered = rememberedCall.result.structuredContent.memory;
    assert.equal(remembered.topic, "storage backend");
    const searchCall = await client.request("tools/call", {
      name: "mnemuron_search_memories",
      arguments: {
        query: "storage backend",
        task_id: fixtureTask.task_id,
        memory_types: ["decision"],
      },
    });
    const search = searchCall.result.structuredContent;
    assert.equal(search.schema_version, "structured-memory-retrieval-v0.1");
    assert.equal(search.read_only, true);
    assert.equal(search.results[0].memory_id, remembered.memory_id);
    const supersedeCall = await client.request("tools/call", {
      name: "mnemuron_supersede_memory",
      arguments: {
        memory_id: remembered.memory_id,
        content: "Use SQLite WAL for the memory lifecycle test.",
        reason: "Explicit test correction.",
      },
    });
    const superseded = supersedeCall.result.structuredContent;
    assert.equal(superseded.status, "superseded");
    assert.equal(superseded.replacement_memory.lifecycle.supersedes_memory_id,
      remembered.memory_id);
    const retractCall = await client.request("tools/call", {
      name: "mnemuron_retract_memory",
      arguments: {
        memory_id: superseded.replacement_memory.memory_id,
        reason: "Explicit test retraction.",
      },
    });
    assert.equal(retractCall.result.structuredContent.status, "retracted");
    assert.equal(retractCall.result.structuredContent.physically_deleted, false);

    const branchesCall = await client.request("tools/call", {
      name: "mnemuron_preview_task_branches",
      arguments: { query: fixtureTask.task_id },
    });
    const branches = branchesCall.result.structuredContent;
    assert.equal(branches.schema_version, "task-branches-preview-v0.1");
    assert.equal(branches.status, "task_branches_preview");
    assert.equal(branches.task.task_id, fixtureTask.task_id);
    assert.deepEqual(new Set(branches.branches.map((branch) => branch.workstream_id)), new Set([
      "workstream-macmini",
      "workstream-macbook",
    ]));
    assert.equal(branches.safety.resume_created, false);
    assert.equal(branches.safety.task_scope_changed, false);
    assert.equal(branches.safety.automatic_merge_performed, false);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count, 0);

    const unboundRemember = await client.request("tools/call", {
      name: "mnemuron_remember",
      arguments: {
        content: "This must not fall back to the adapter default Task.",
        scope: "task",
      },
    });
    assert.equal(unboundRemember.result.isError, true);
    assert.match(unboundRemember.result.structuredContent.error, /task_id is required/);

    const reconciliationStatusCall = await client.request("tools/call", {
      name: "mnemuron_reconciliation_status",
      arguments: { task_id: fixtureTask.task_id },
    });
    const reconciliationStatus = reconciliationStatusCall.result.structuredContent;
    assert.equal(reconciliationStatus.canonical_version, 1);
    assert.equal(reconciliationStatus.schema_version, "canonical-task-reconciliation-v0.1");

    const reconciliationPreviewCall = await client.request("tools/call", {
      name: "mnemuron_preview_reconciliation",
      arguments: {
        task_id: fixtureTask.task_id,
        derive_checkpoint_operations: true,
        operations: [{
          op: "append_unique",
          field: "decisions",
          value: "Canonical reconciliation confirmation remains separate from Resume confirmation.",
        }],
      },
    });
    const reconciliationProposal = reconciliationPreviewCall.result.structuredContent.proposal;
    assert.equal(reconciliationProposal.status, "awaiting_confirmation");
    assert.equal(reconciliationProposal.base_canonical_version, 1);

    const reconciliationConfirmedCall = await client.request("tools/call", {
      name: "mnemuron_confirm_reconciliation",
      arguments: {
        proposal_id: reconciliationProposal.proposal_id,
        proposal_version: reconciliationProposal.proposal_version,
        base_canonical_version: reconciliationProposal.base_canonical_version,
        confirmed: true,
      },
    });
    const reconciliationConfirmed = reconciliationConfirmedCall.result.structuredContent;
    assert.equal(reconciliationConfirmed.status, "applied");
    assert.equal(reconciliationConfirmed.task.canonical_version, 2);

    const previewCall = await client.request("tools/call", {
      name: "mnemuron_preview_resume",
      arguments: {
        query: "继续 Mnemuron plugin",
        source_workstream_ids: ["workstream-macmini"],
      },
    });
    const preview = previewCall.result.structuredContent;
    assert.equal(preview.status, "pending_confirmation");
    assert.equal(preview.canonical_version, 2);
    assert.equal(preview.canonical_freshness, "fresh");
    assert.ok(preview.decisions.includes(
      "Canonical reconciliation confirmation remains separate from Resume confirmation.",
    ));
    assert.equal(preview.recent_activity[0].provenance.device_id, "macmini-example");
    assert.equal(preview.branch_selection.mode, "single");
    assert.deepEqual(preview.branch_selection.selected_workstream_ids, ["workstream-macmini"]);
    assert.deepEqual(preview.workstreams.map((item) => item.workstream_id), ["workstream-macmini"]);
    assert.equal(preview.resume_packet, undefined);

    const confirmationPrompt = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-confirm",
      prompt: `确认 ${preview.resume_id} v${preview.preview_version}`,
    }, bookEnv);
    assert.equal(confirmationPrompt.status, 0, confirmationPrompt.stderr);

    const confirmedCall = await client.request("tools/call", {
      name: "mnemuron_confirm_resume",
      arguments: {
        resume_id: preview.resume_id,
        preview_version: preview.preview_version,
        confirmed: true,
        session_id: sessionId,
      },
    });
    const confirmed = confirmedCall.result.structuredContent;
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.resume_packet_returned, false);
    assert.equal(confirmed.resume_packet, undefined);
    assert.equal(confirmed.task_scope.target_session_id, sessionId);
    assert.equal(confirmed.task_scope.status, "pending");
    assert.equal(confirmed.adapter_injection.armed, false);

    const confirmationTurnStop = await runHook({
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: "turn-confirm",
      last_assistant_message: "Resume confirmed and staged for the next ordinary turn.",
    }, bookEnv);
    assert.equal(confirmationTurnStop.status, 0, confirmationTurnStop.stderr);
    assert.deepEqual(JSON.parse(confirmationTurnStop.stdout), {});
    const confirmationEvent = app.store.db.prepare(
      "SELECT task_id FROM events WHERE agent_instance_id = ? AND turn_id = ? ORDER BY captured_at DESC LIMIT 1",
    ).get("chatgpt-macbook-example", "turn-confirm");
    assert.equal(confirmationEvent.task_id, null);

    const resumedPrompt = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-resumed",
      prompt: "继续恢复后的任务。",
    }, bookEnv);
    assert.equal(resumedPrompt.status, 0, resumedPrompt.stderr);
    assert.equal(resolveTaskScope(path.join(root, "book"), sessionId, bookEnv), null);
    assert.deepEqual(taskScopeCounts(path.join(root, "book")), {
      pending: 1,
      active: 0,
      superseded: 0,
    });
    const preDeliveryPromptEvent = app.store.db.prepare(`
      SELECT task_id, workstream_id
      FROM events
      WHERE agent_instance_id = ? AND turn_id = ? AND event_type = 'user_message'
      ORDER BY captured_at DESC LIMIT 1
    `).get("chatgpt-macbook-example", "turn-resumed");
    assert.equal(preDeliveryPromptEvent.task_id, null);
    assert.equal(preDeliveryPromptEvent.workstream_id, null);
    const deliveryCall = await client.request("tools/call", {
      name: "mnemuron_take_pending_resume",
      arguments: { session_id: sessionId },
    });
    const delivered = deliveryCall.result.structuredContent;
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.resume_packet_returned, true);
    assert.match(delivered.resume_context, new RegExp(preview.resume_id));
    assert.match(delivered.resume_context, /Central transport is complete/);
    assert.match(delivered.resume_context, /resume-branch-selection-v0\.1/);
    assert.match(delivered.resume_context, /workstream-macmini/);
    assert.equal(delivered.task_scope.task_id, fixtureTask.task_id);
    assert.equal(
      resolveTaskScope(path.join(root, "book"), sessionId, bookEnv).resume_id,
      preview.resume_id,
    );
    const inFlight = app.store.deliveryReceiptStatus(
      app.store.authenticate(book.api_key),
      preview.resume_id,
    );
    assert.equal(inFlight.status, "in_flight");
    assert.equal(inFlight.ack_complete, false);
    assert.equal(inFlight.latest_receipt.turn_id, null);

    const unrelatedSessionStart = await runHook({
      hook_event_name: "SessionStart",
      session_id: "chatgpt-book-unrelated-thread",
      source: "compact",
    }, bookEnv);
    assert.equal(unrelatedSessionStart.status, 0, unrelatedSessionStart.stderr);
    const preservedInFlight = app.store.deliveryReceiptStatus(
      app.store.authenticate(book.api_key),
      preview.resume_id,
    );
    assert.equal(preservedInFlight.status, "in_flight");
    assert.equal(preservedInFlight.ack_complete, false);
    assert.equal(preservedInFlight.latest_receipt.receipt_id, delivered.receipt_id);

    const stopHook = await runHook({
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: "turn-resumed",
      last_assistant_message: "The restored task continued from Mnemuron context.",
    }, bookEnv);
    assert.equal(stopHook.status, 0, stopHook.stderr);
    assert.deepEqual(JSON.parse(stopHook.stdout), {});
    const acknowledged = app.store.deliveryReceiptStatus(
      app.store.authenticate(book.api_key),
      preview.resume_id,
    );
    assert.equal(acknowledged.status, "acknowledged");
    assert.equal(acknowledged.ack_complete, true);
    assert.equal(acknowledged.latest_receipt.session_id, sessionId);
    assert.equal(acknowledged.latest_receipt.turn_id, "turn-resumed");
    const resumedEvent = app.store.db.prepare(
      "SELECT task_id, workstream_id, raw_payload_json FROM events WHERE agent_instance_id = ? AND turn_id = ? ORDER BY captured_at DESC LIMIT 1",
    ).get("chatgpt-macbook-example", "turn-resumed");
    assert.equal(resumedEvent.task_id, fixtureTask.task_id);
    assert.equal(resumedEvent.workstream_id, "workstream-macbook");
    assert.equal(
      JSON.parse(resumedEvent.raw_payload_json).mnemuron_task_scope.source,
      "confirmed-resume",
    );

    const laterPrompt = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-later",
      prompt: "继续持久绑定。",
    }, bookEnv);
    assert.equal(laterPrompt.status, 0, laterPrompt.stderr);
    const laterDeliveryCall = await client.request("tools/call", {
      name: "mnemuron_take_pending_resume",
      arguments: { session_id: sessionId },
    });
    assert.equal(laterDeliveryCall.result.structuredContent.status, "no_pending_resume");
    assert.equal(laterDeliveryCall.result.structuredContent.resume_packet_returned, false);
  } finally {
    client?.child.kill();
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

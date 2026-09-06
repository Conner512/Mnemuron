import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  armPendingResumeDeliveries,
  authorizeMcpSession,
} from "../scripts/storage.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(TEST_DIR, "..", "scripts", "mcp-server.mjs");

function startClient(dataDir) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      MNEMURON_MODE: "local",
      MNEMURON_CONFIG_PATH: path.join(dataDir, "missing-config.json"),
      MNEMURON_SPIKE_DATA_DIR: dataDir,
      MNEMURON_DEVICE_ID: "device-test",
      MNEMURON_AGENT_ID: "chatgpt",
      MNEMURON_AGENT_INSTANCE_ID: "chatgpt-test",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });

  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}; stderr=${stderr}`));
      }, 3000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  return { child, request, stderr: () => stderr };
}

test("MCP server enforces preview before confirmation", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-mcp-"));
  const sessionId = "chatgpt-session-mcp-v014";
  authorizeMcpSession(dataDir, sessionId, { hookEventName: "SessionStart" });
  const client = startClient(dataDir);
  try {
    const initialized = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" },
    });
    assert.equal(initialized.result.serverInfo.name, "mnemuron-spike");
    assert.equal(initialized.result.serverInfo.version, "0.1.14");

    const listed = await client.request("tools/list");
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name),
      [
        "mnemuron_status",
        "mnemuron_preview_resume",
        "mnemuron_preview_project_context",
        "mnemuron_preview_task_branches",
        "mnemuron_preview_project_bootstrap",
        "mnemuron_confirm_project_bootstrap",
        "mnemuron_preview_task_bootstrap",
        "mnemuron_confirm_task_bootstrap",
        "mnemuron_confirm_resume",
        "mnemuron_take_pending_resume",
        "mnemuron_remember",
        "mnemuron_search_memories",
        "mnemuron_supersede_memory",
        "mnemuron_retract_memory",
        "mnemuron_reconciliation_status",
        "mnemuron_preview_reconciliation",
        "mnemuron_confirm_reconciliation",
      ],
    );
    assert.equal(
      listed.result.tools.find((tool) => tool.name === "mnemuron_preview_reconciliation")
        .inputSchema.properties.derive_checkpoint_operations.type,
      "boolean",
    );
    assert.match(
      listed.result.tools.find((tool) => tool.name === "mnemuron_preview_project_context")
        .description,
      /Required tool for the exact command `\/Mnemuron load project <project>`/,
    );
    assert.match(
      listed.result.tools.find((tool) => tool.name === "mnemuron_preview_task_branches")
        .description,
      /Required read-only tool for `\/Mnemuron branches <task>`/,
    );
    assert.match(
      listed.result.tools.find((tool) => tool.name === "mnemuron_preview_resume")
        .description,
      /Never use this tool for `\/Mnemuron load project <project>`/,
    );

    const localReconciliation = await client.request("tools/call", {
      name: "mnemuron_reconciliation_status",
      arguments: { task_id: "task-mnemuron-plugin-spike" },
    });
    assert.equal(localReconciliation.result.isError, true);
    assert.match(
      localReconciliation.result.structuredContent.error,
      /requires Mnemuron remote mode/,
    );

    const projectOnlyCall = await client.request("tools/call", {
      name: "mnemuron_preview_resume",
      arguments: { query: "继续 Mnemuron 任务" },
    });
    assert.equal(projectOnlyCall.result.structuredContent.status, "ambiguous");
    assert.equal(projectOnlyCall.result.structuredContent.selection_required, true);
    assert.equal(projectOnlyCall.result.structuredContent.resume_id, undefined);

    const wrongIdCall = await client.request("tools/call", {
      name: "mnemuron_preview_resume",
      arguments: { query: "task-mnemuron-does-not-exist" },
    });
    assert.equal(wrongIdCall.result.structuredContent.status, "no_match");
    assert.equal(wrongIdCall.result.structuredContent.resume_id, undefined);

    const projectContextCall = await client.request("tools/call", {
      name: "mnemuron_preview_project_context",
      arguments: { query: "Mnemuron" },
    });
    const projectContext = projectContextCall.result.structuredContent;
    assert.equal(projectContext.schema_version, "project-memory-preview-v0.1");
    assert.equal(projectContext.status, "project_context_preview");
    assert.equal(projectContext.read_only, true);
    assert.equal(projectContext.project.project_id, "project-mnemuron");
    assert.equal(projectContext.tasks.length, 1);
    assert.equal(projectContext.safety.resume_created, false);
    assert.equal(projectContext.safety.task_scope_changed, false);
    assert.equal(projectContext.safety.context_injected, false);
    assert.equal(projectContext.resume_id, undefined);

    const branchesCall = await client.request("tools/call", {
      name: "mnemuron_preview_task_branches",
      arguments: { query: "task-mnemuron-plugin-spike" },
    });
    const branches = branchesCall.result.structuredContent;
    assert.equal(branches.schema_version, "task-branches-preview-v0.1");
    assert.equal(branches.status, "task_branches_preview");
    assert.equal(branches.read_only, true);
    assert.equal(branches.task.task_id, "task-mnemuron-plugin-spike");
    assert.equal(branches.safety.resume_created, false);
    assert.equal(branches.safety.task_scope_changed, false);
    assert.equal(branches.safety.automatic_merge_performed, false);
    assert.equal(branches.resume_id, undefined);

    const statusAfterProjectPreview = await client.request("tools/call", {
      name: "mnemuron_status",
      arguments: {},
    });
    assert.equal(statusAfterProjectPreview.result.structuredContent.counts.previews, 0);

    const previewCall = await client.request("tools/call", {
      name: "mnemuron_preview_resume",
      arguments: { query: "继续 Mnemuron plugin spike" },
    });
    const preview = previewCall.result.structuredContent;
    assert.equal(preview.status, "pending_confirmation");
    assert.equal(preview.requires_confirmation, true);
    assert.equal(preview.resume_packet, undefined);

    const wrongVersion = await client.request("tools/call", {
      name: "mnemuron_confirm_resume",
      arguments: {
        resume_id: preview.resume_id,
        preview_version: preview.preview_version + 1,
        confirmed: true,
        session_id: sessionId,
      },
    });
    assert.equal(wrongVersion.result.isError, true);

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
    assert.equal(confirmed.task_scope.task_id, "task-mnemuron-plugin-spike");
    assert.equal(confirmed.adapter_injection.armed, false);

    const repeatedConfirmation = await client.request("tools/call", {
      name: "mnemuron_confirm_resume",
      arguments: {
        resume_id: preview.resume_id,
        preview_version: preview.preview_version,
        confirmed: true,
        session_id: sessionId,
      },
    });
    assert.equal(repeatedConfirmation.result.structuredContent.status, "confirmed");
    assert.equal(repeatedConfirmation.result.structuredContent.resume_packet_returned, false);
    assert.equal(repeatedConfirmation.result.structuredContent.adapter_injection.receipt_id,
      confirmed.adapter_injection.receipt_id);

    const confirmationTurnProbe = await client.request("tools/call", {
      name: "mnemuron_take_pending_resume",
      arguments: { session_id: sessionId },
    });
    assert.deepEqual(confirmationTurnProbe.result.structuredContent, {
      status: "no_pending_resume",
      resume_packet_returned: false,
      compatibility_mode: "chatgpt-mcp-delivery-receipt-v0.1.4",
    });

    armPendingResumeDeliveries(dataDir, sessionId, "turn-confirm");
    const deliveredCall = await client.request("tools/call", {
      name: "mnemuron_take_pending_resume",
      arguments: { session_id: sessionId },
    });
    const delivered = deliveredCall.result.structuredContent;
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.resume_packet_returned, true);
    assert.match(delivered.resume_context, new RegExp(preview.resume_id));
    assert.equal(delivered.task_scope.task_id, "task-mnemuron-plugin-spike");
    const repeatedDelivery = await client.request("tools/call", {
      name: "mnemuron_take_pending_resume",
      arguments: { session_id: sessionId },
    });
    assert.equal(repeatedDelivery.result.structuredContent.status, "already_delivered_this_turn");
    assert.equal(repeatedDelivery.result.structuredContent.resume_packet_returned, false);

    const rememberedCall = await client.request("tools/call", {
      name: "mnemuron_remember",
      arguments: {
        content: "Preview must be confirmed before injection.",
        scope: "task",
        task_id: "task-mnemuron-plugin-spike",
      },
    });
    assert.equal(rememberedCall.result.structuredContent.status, "saved");

    const statusCall = await client.request("tools/call", {
      name: "mnemuron_status",
      arguments: {},
    });
    assert.equal(statusCall.result.structuredContent.plugin_version, "0.1.14");
    assert.equal(
      statusCall.result.structuredContent.resume_injection_mode,
      "chatgpt-mcp-delivery-receipt-v0.1.4",
    );
    assert.equal(statusCall.result.structuredContent.identity.identity_status, "configured");
    assert.equal(statusCall.result.structuredContent.counts.memories, 1);
  } finally {
    client.child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

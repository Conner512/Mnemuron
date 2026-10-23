import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callTool } from "../scripts/mcp-core.mjs";
import {
  acquireMcpResumeDeliveryLock,
  activateTaskBootstrapScope,
  armPendingResumeDeliveries,
  authorizeMcpSession,
  enqueueDeliveryReceipt,
  finishMcpResumeDelivery,
  listDeliveryReceiptOutbox,
  pendingMcpDeliveryAcknowledgements,
  pendingMcpDeliveryAcknowledgementIntents,
  pendingResumeCounts,
  queueResumeInjection,
  recordMcpDeliveryAcknowledgementIntent,
  releaseMcpResumeDeliveryLock,
  resolveTaskScope,
  stageTaskScopeForSession,
  taskScopeCounts,
} from "../scripts/storage.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(TEST_DIR, "..", "scripts", "launch-hook");
const MCP = path.resolve(TEST_DIR, "..", "scripts", "mcp-server.mjs");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

const receiptPayloads = new Map();
function readRequestJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const payload=chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        if(payload.receipt_id) {
          const history=receiptPayloads.get(payload.receipt_id)||{};
          history[payload.phase]=payload;history.latest=payload;receiptPayloads.set(payload.receipt_id,history);
        }
        resolve(payload);
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function remoteEnv(dataDir, serverUrl) {
  return {
    MNEMURON_MODE: "remote",
    MNEMURON_CONFIG_PATH: path.join(dataDir, "missing-config.json"),
    MNEMURON_SPIKE_DATA_DIR: dataDir,
    MNEMURON_SERVER_URL: serverUrl,
    MNEMURON_ALLOW_INSECURE_HTTP: "true",
    MNEMURON_API_KEY: "test-api-key",
    MNEMURON_DEVICE_ID: "clienta-test",
    MNEMURON_AGENT_ID: "chatgpt",
    MNEMURON_AGENT_INSTANCE_ID: "chatgpt-clienta-test",
    MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-clienta",
    CODEX_THREAD_ID: "",
    CODEX_SESSION_ID: "",
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

function startMcp(env) {
  const child = spawn(process.execPath, [MCP], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const boundary = buffer.indexOf("\n");
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  return {
    child,
    request(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP timeout while calling ${method}; stderr=${stderr}`));
        }, 5_000);
        pending.set(id, { resolve, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
  };
}

function packet() {
  return {
    resume_id: "resume-delivery-gate",
    preview_version: 1,
    project: { project_id: "project-mnemuron" },
    task: { task_id: "task-delivery-gate" },
    selected_workstreams: [{ workstream_id: "workstream-source" }],
    context: {},
  };
}

function centralDeliveryResponse(receiptId, {
  status = "in_flight",
  ackComplete = false,
  inserted = 1,
  duplicate = 0,
  centralReceiptId = receiptId,
} = {}) {
  const history=receiptPayloads.get(receiptId)||{},p=history.latest||{};
  return {
    inserted,
    duplicate,
    receipt_event_id:p.receipt_event_id,
    delivery: {
      resume_id: "resume-delivery-gate",
      preview_version: 1,
      status,
      ack_complete: ackComplete,
      latest_receipt: { receipt_id: centralReceiptId },
      receipts:[{receipt_id:centralReceiptId,session_id:p.session_id,turn_id:p.turn_id,workstream_id:p.workstream_id,
        receipt_event_ids:['delivered','acknowledged','failed'].flatMap(phase=>history[phase]?[history[phase].receipt_event_id]:[]),
        delivered_at:history.delivered?.occurred_at,acknowledged_at:history.acknowledged?.occurred_at,failed_at:history.failed?.occurred_at,ack_complete:ackComplete}],
    },
  };
}

test("Resume Task Scope activates only after central server accepts the exact Delivery Receipt", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-delivery-gate-"));
  let rejectDelivery = true;
  let expectedReceiptId = null;
  const submittedEvents = [];
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url.includes("/delivery-receipts")) {
      response.statusCode = rejectDelivery ? 503 : 200;
      response.end(JSON.stringify(rejectDelivery
        ? { error: "receipt unavailable" }
        : centralDeliveryResponse(expectedReceiptId)));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/events") {
      const { event } = await readRequestJson(request);
      submittedEvents.push(event);
      response.statusCode = 200;
      response.end(JSON.stringify({ status: "accepted", received: 1, inserted: 1, duplicate: 0, accepted_event_ids: [event.event_id] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  try {
    const address = await listen(server);
    const env = remoteEnv(dataDir, `http://127.0.0.1:${address.port}`);
    const sessionId = "session-delivery-gate";
    const resumePacket = packet();
    authorizeMcpSession(dataDir, sessionId, { hookEventName: "UserPromptSubmit" });
    const previousBootstrap = {
      bootstrap_id: "bootstrap-previous-active",
      preview_version: 1,
      project: { project_id: "project-mnemuron" },
      task: { task_id: "task-previous-active" },
      workstream: { workstream_id: "workstream-clienta" },
    };
    stageTaskScopeForSession(dataDir, previousBootstrap, sessionId, env);
    activateTaskBootstrapScope(dataDir, sessionId, env);
    stageTaskScopeForSession(dataDir, {
      bootstrap_id: "bootstrap-delivery-gate",
      preview_version: 1,
      project: { project_id: "project-mnemuron" },
      task: { task_id: "task-bootstrap-delivery-gate" },
      workstream: { workstream_id: "workstream-clienta" },
    }, sessionId, env);
    const scope = stageTaskScopeForSession(dataDir, resumePacket, sessionId, env);
    const pendingDelivery = queueResumeInjection(
      dataDir,
      resumePacket,
      sessionId,
      scope.workstream_id,
      { injectionMethod: "codex-mcp-delivery-receipt", armed: false },
    );
    expectedReceiptId = pendingDelivery.receipt_id;

    const firstPrompt = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-delivery-first",
      prompt: "继续待恢复任务。",
    }, env);
    assert.equal(firstPrompt.status, 0, firstPrompt.stderr);
    assert.equal(
      resolveTaskScope(dataDir, sessionId, env).bootstrap_id,
      previousBootstrap.bootstrap_id,
    );
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 2, active: 1, superseded: 0 });
    const firstPromptEvent = submittedEvents.find((event) => (
      event.turn_id === "turn-delivery-first" && event.event_type === "user_message"
    ));
    assert.equal(firstPromptEvent.task_id, null);
    assert.equal(firstPromptEvent.workstream_id, null);
    assert.equal(
      armPendingResumeDeliveries(dataDir, sessionId, "turn-confirm-stop").length,
      1,
    );

    const deferred = await callTool(
      "mnemuron_take_pending_resume",
      { session_id: sessionId },
      env,
    );
    assert.equal(deferred.status, "delivery_deferred");
    assert.equal(deferred.resume_packet_returned, false);
    assert.equal(
      resolveTaskScope(dataDir, sessionId, env).bootstrap_id,
      previousBootstrap.bootstrap_id,
    );
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 2, active: 1, superseded: 0 });

    const deferredTool = await runHook({
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      turn_id: "turn-delivery-first",
      tool_name: "mcp__mnemuron__mnemuron_take_pending_resume",
      tool_input: { session_id: sessionId },
      tool_response: { structuredContent: deferred },
    }, env);
    assert.equal(deferredTool.status, 0, deferredTool.stderr);
    const deferredStop = await runHook({
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: "turn-delivery-first",
      last_assistant_message: "Resume delivery is still pending.",
    }, env);
    assert.equal(deferredStop.status, 0, deferredStop.stderr);
    const deferredTurnEvents = submittedEvents.filter((event) => (
      event.turn_id === "turn-delivery-first"
    ));
    assert.ok(deferredTurnEvents.length >= 3);
    assert.ok(deferredTurnEvents.every((event) => (
      event.task_id === null && event.workstream_id === null
    )));
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 0,
      in_flight: 1,
      delivered: 0,
    });

    const retryPrompt = await runHook({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-delivery-retry",
      prompt: "继续重试恢复。",
    }, env);
    assert.equal(retryPrompt.status, 0, retryPrompt.stderr);
    assert.equal(
      resolveTaskScope(dataDir, sessionId, env).bootstrap_id,
      previousBootstrap.bootstrap_id,
    );
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 2, active: 1, superseded: 0 });
    const retryPromptEvent = submittedEvents.find((event) => (
      event.turn_id === "turn-delivery-retry" && event.event_type === "user_message"
    ));
    assert.equal(retryPromptEvent.task_id, null);
    assert.equal(retryPromptEvent.workstream_id, null);

    const nextResumePacket = {
      ...packet(),
      resume_id: "resume-delivery-gate-next",
      task: { task_id: "task-delivery-gate-next" },
    };
    const nextScope = stageTaskScopeForSession(dataDir, nextResumePacket, sessionId, env);
    queueResumeInjection(
      dataDir,
      nextResumePacket,
      sessionId,
      nextScope.workstream_id,
      { injectionMethod: "codex-mcp-delivery-receipt", armed: true },
    );
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 1,
      in_flight: 1,
      delivered: 0,
    });

    rejectDelivery = false;
    const delivered = await callTool(
      "mnemuron_take_pending_resume",
      { session_id: sessionId },
      env,
    );
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.resume_id, resumePacket.resume_id);
    assert.equal(delivered.resume_packet_returned, true);
    assert.equal(delivered.task_scope.resume_id, resumePacket.resume_id);
    assert.equal(resolveTaskScope(dataDir, sessionId, env).resume_id, resumePacket.resume_id);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 1, active: 1, superseded: 2 });

    const deliveryTool = await runHook({
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      turn_id: "turn-delivery-retry",
      tool_name: "mcp__mnemuron__mnemuron_take_pending_resume",
      tool_input: { session_id: sessionId },
      tool_response: { structuredContent: delivered },
    }, env);
    assert.equal(deliveryTool.status, 0, deliveryTool.stderr);
    const deliveryStop = await runHook({
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: "turn-delivery-retry",
      last_assistant_message: "Resume delivery committed.",
    }, env);
    assert.equal(deliveryStop.status, 0, deliveryStop.stderr);
    const committedEvents = submittedEvents.filter((event) => (
      event.turn_id === "turn-delivery-retry" && event.event_type !== "user_message"
    ));
    assert.ok(committedEvents.length >= 2);
    assert.ok(committedEvents.every((event) => (
      event.task_id === resumePacket.task.task_id
      && event.workstream_id === "workstream-clienta"
    )));
  } finally {
    if (server.listening) await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("status includes Delivery Receipt outbox in adapter synchronization state", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-delivery-status-"));
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/status") {
      response.statusCode = 200;
      response.end(JSON.stringify({
        mode: "remote-v0.1",
        production_ready: false,
        cross_device_ready: true,
      }));
      return;
    }
    if (request.method === "POST" && request.url.includes("/delivery-receipts")) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "receipt unavailable" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  try {
    const address = await listen(server);
    const env = remoteEnv(dataDir, `http://127.0.0.1:${address.port}`);
    enqueueDeliveryReceipt(dataDir, "resume-status-test", {
      receipt_event_id: "receipt-event-status-test",
      receipt_id: "receipt-status-test",
      preview_version: 1,
      phase: "acknowledged",
      session_id: "session-status-test",
      turn_id: "turn-status-test",
      workstream_id: "workstream-clienta",
      delivery_method: "codex-mcp-tool-result",
      occurred_at: "2026-09-04T08:00:00.000Z",
    });

    const status = await callTool("mnemuron_status", {}, env);
    assert.equal(status.server_reachable, true);
    assert.equal(status.adapter.queued_events, 0);
    assert.equal(status.adapter.queued_delivery_receipts, 1);
    assert.equal(status.adapter.delivery_receipt_sync_status, "pending");
    assert.equal(status.adapter.sync_status, "pending");
    assert.equal(status.adapter.last_delivery_receipt_flush.status, 'not_run_read_only');
    assert.equal(status.adapter.sync_state.queued, 1);
  } finally {
    if (server.listening) await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("terminal or mismatched central 2xx Delivery Receipt states fail closed", async (t) => {
  for (const scenario of [
    {
      name: "already acknowledged",
      status: "acknowledged",
      ackComplete: true,
      expectedReason: "central_delivery_state_not_deliverable",
    },
    {
      name: "already failed",
      status: "failed",
      ackComplete: false,
      expectedReason: "central_delivery_state_not_deliverable",
    },
    {
      name: "different receipt owns in-flight delivery",
      status: "in_flight",
      ackComplete: false,
      centralReceiptId: "receipt-owned-elsewhere",
      expectedReason: "receipt_identity_mismatch",
    },
  ]) {
    await t.test(scenario.name, async () => {
      const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-delivery-reconcile-"));
      let expectedReceiptId = null;
      let receiptPosts = 0;
      const server = http.createServer((request, response) => {
        response.setHeader("content-type", "application/json");
        if (request.method === "POST" && request.url.includes("/delivery-receipts")) {
          receiptPosts += 1;
          response.statusCode = 200;
          response.end(JSON.stringify(centralDeliveryResponse(expectedReceiptId, {
            status: scenario.status,
            ackComplete: scenario.ackComplete,
            inserted: 0,
            duplicate: 1,
            centralReceiptId: scenario.centralReceiptId || expectedReceiptId,
          })));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
      });
      try {
        const address = await listen(server);
        const env = remoteEnv(dataDir, `http://127.0.0.1:${address.port}`);
        const sessionId = `session-${scenario.status}-${scenario.centralReceiptId || "same"}`;
        const resumePacket = packet();
        authorizeMcpSession(dataDir, sessionId, { hookEventName: "UserPromptSubmit" });
        const scope = stageTaskScopeForSession(dataDir, resumePacket, sessionId, env);
        const pendingDelivery = queueResumeInjection(
          dataDir,
          resumePacket,
          sessionId,
          scope.workstream_id,
          { injectionMethod: "codex-mcp-delivery-receipt", armed: true },
        );
        expectedReceiptId = pendingDelivery.receipt_id;

        const result = await callTool(
          "mnemuron_take_pending_resume",
          { session_id: sessionId },
          env,
        );
        assert.equal(result.status, "delivery_reconciliation_required");
        assert.equal(result.reconciliation_required, true);
        assert.equal(result.retryable, false);
        assert.equal(result.resume_packet_returned, false);
        assert.equal(result.resume_context, undefined);
        assert.equal(result.reconciliation.reason, scenario.expectedReason);
        assert.equal(result.reconciliation.central_status, scenario.status);
        assert.equal(receiptPosts, 1);
        assert.equal(resolveTaskScope(dataDir, sessionId, env), null);
        assert.deepEqual(taskScopeCounts(dataDir), {
          pending: 1,
          active: 0,
          superseded: 0,
        });
      } finally {
        if (server.listening) await close(server);
        rmSync(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("session-taking MCP tools reject a previously attested but non-current ChatGPT Session", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-current-session-gate-"));
  try {
    const currentSessionId = "session-current-chatgpt";
    const oldSessionId = "session-previously-attested";
    const env = {
      ...remoteEnv(dataDir, "http://127.0.0.1:1"),
      CODEX_THREAD_ID: currentSessionId,
      CODEX_SESSION_ID: currentSessionId,
    };
    authorizeMcpSession(dataDir, oldSessionId, { hookEventName: "SessionStart" });
    const resumePacket = packet();
    const scope = stageTaskScopeForSession(dataDir, resumePacket, oldSessionId, env);
    queueResumeInjection(
      dataDir,
      resumePacket,
      oldSessionId,
      scope.workstream_id,
      { injectionMethod: "codex-mcp-delivery-receipt", armed: true },
    );

    const cases = [
      ["mnemuron_take_pending_resume", { session_id: oldSessionId }],
      ["mnemuron_confirm_resume", {
        resume_id: "resume-old-session",
        preview_version: 1,
        confirmed: true,
        session_id: oldSessionId,
      }],
      ["mnemuron_preview_project_bootstrap", {
        project_name: "Old Session Project",
        task_title: "Initial Task",
        task_goal: "Must not be created from another Session.",
        session_id: oldSessionId,
      }],
      ["mnemuron_confirm_project_bootstrap", {
        bootstrap_id: "bootstrap-old-session",
        preview_version: 1,
        confirmed: true,
        session_id: oldSessionId,
      }],
      ["mnemuron_preview_task_bootstrap", {
        project_query: "Old Session Project",
        title: "Old Session Task",
        goal: "Must not be created from another Session.",
        session_id: oldSessionId,
      }],
      ["mnemuron_confirm_task_bootstrap", {
        bootstrap_id: "task-bootstrap-old-session",
        preview_version: 1,
        confirmed: true,
        session_id: oldSessionId,
      }],
    ];
    for (const [name, args] of cases) {
      await assert.rejects(
        callTool(name, args, env),
        /does not match the current ChatGPT runtime Session/,
        name,
      );
    }
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 1,
      in_flight: 0,
      delivered: 0,
    });
    assert.equal(resolveTaskScope(dataDir, currentSessionId, env), null);

    authorizeMcpSession(dataDir, currentSessionId, { hookEventName: "SessionStart" });
    await assert.rejects(
      callTool("mnemuron_take_pending_resume", { session_id: currentSessionId }, {
        ...env,
        CODEX_SESSION_ID: "session-runtime-disagreement",
      }),
      /runtime Session identifiers disagree/,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("concurrent cross-process take calls post and return one Resume Packet only", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-delivery-lock-"));
  let receiptPosts = 0;
  let expectedReceiptId = null;
  let firstClient;
  let secondClient;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url.includes("/delivery-receipts")) {
      receiptPosts += 1;
      setTimeout(() => {
        response.statusCode = 200;
        response.end(JSON.stringify(centralDeliveryResponse(expectedReceiptId)));
      }, 50);
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  try {
    const address = await listen(server);
    const env = remoteEnv(dataDir, `http://127.0.0.1:${address.port}`);
    const sessionId = "session-concurrent-delivery";
    const resumePacket = packet();
    authorizeMcpSession(dataDir, sessionId, { hookEventName: "UserPromptSubmit" });
    const scope = stageTaskScopeForSession(dataDir, resumePacket, sessionId, env);
    const pendingDelivery = queueResumeInjection(
      dataDir,
      resumePacket,
      sessionId,
      scope.workstream_id,
      { injectionMethod: "codex-mcp-delivery-receipt", armed: true },
    );
    expectedReceiptId = pendingDelivery.receipt_id;

    firstClient = startMcp(env);
    secondClient = startMcp(env);
    await Promise.all([
      firstClient.request("initialize", { protocolVersion: "2025-06-18" }),
      secondClient.request("initialize", { protocolVersion: "2025-06-18" }),
    ]);
    const calls = await Promise.all([
      firstClient.request("tools/call", {
        name: "mnemuron_take_pending_resume",
        arguments: { session_id: sessionId },
      }),
      secondClient.request("tools/call", {
        name: "mnemuron_take_pending_resume",
        arguments: { session_id: sessionId },
      }),
    ]);
    const results = calls.map((call) => call.result.structuredContent);
    const delivered = results.filter((result) => result.status === "delivered");
    const losers = results.filter((result) => result.status === "delivery_in_progress");
    assert.equal(delivered.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(delivered[0].resume_packet_returned, true);
    assert.match(delivered[0].resume_context, /resume-delivery-gate/);
    assert.equal(losers[0].resume_packet_returned, false);
    assert.equal(losers[0].resume_context, undefined);
    assert.equal(receiptPosts, 1);
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 0,
      in_flight: 1,
      delivered: 0,
    });

    const repeated = await callTool(
      "mnemuron_take_pending_resume",
      { session_id: sessionId },
      env,
    );
    assert.equal(repeated.status, "already_delivered_this_turn");
    assert.equal(repeated.resume_packet_returned, false);
    assert.equal(receiptPosts, 1);
  } finally {
    firstClient?.child.kill();
    secondClient?.child.kill();
    if (server.listening) await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a stale cross-process delivery lock is recovered without releasing its successor", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-delivery-stale-lock-"));
  let receiptPosts = 0;
  let expectedReceiptId = null;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url.includes("/delivery-receipts")) {
      receiptPosts += 1;
      response.statusCode = 200;
      response.end(JSON.stringify(centralDeliveryResponse(expectedReceiptId, {
        inserted: 0,
        duplicate: 1,
      })));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  try {
    const address = await listen(server);
    const env = remoteEnv(dataDir, `http://127.0.0.1:${address.port}`);
    const sessionId = "session-stale-delivery-lock";
    const resumePacket = packet();
    authorizeMcpSession(dataDir, sessionId, { hookEventName: "UserPromptSubmit" });
    const scope = stageTaskScopeForSession(dataDir, resumePacket, sessionId, env);
    const pendingDelivery = queueResumeInjection(
      dataDir,
      resumePacket,
      sessionId,
      scope.workstream_id,
      { injectionMethod: "codex-mcp-delivery-receipt", armed: true },
    );
    expectedReceiptId = pendingDelivery.receipt_id;
    const staleLock = acquireMcpResumeDeliveryLock(dataDir, sessionId, {
      now: new Date(Date.now() - 5 * 60_000),
    });
    assert.ok(staleLock);

    const delivered = await callTool(
      "mnemuron_take_pending_resume",
      { session_id: sessionId },
      env,
    );
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.resume_packet_returned, true);
    assert.equal(receiptPosts, 1);
    assert.equal(releaseMcpResumeDeliveryLock(staleLock), false);
  } finally {
    if (server.listening) await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("SessionStart recovery defers while a live take owns the Session delivery lock", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-take-recovery-race-"));
  let expectedReceiptId = null;
  let receiptPosts = 0;
  let receiptStartedResolve;
  let releaseReceiptResolve;
  const receiptStarted = new Promise((resolve) => { receiptStartedResolve = resolve; });
  const releaseReceipt = new Promise((resolve) => { releaseReceiptResolve = resolve; });
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url.includes("/delivery-receipts")) {
      receiptPosts += 1;
      receiptStartedResolve();
      await releaseReceipt;
      response.statusCode = 200;
      response.end(JSON.stringify(centralDeliveryResponse(expectedReceiptId)));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/events") {
      response.statusCode = 200;
      response.end(JSON.stringify({ status: "accepted", received: 1, inserted: 1, duplicate: 0, accepted_event_ids: [(await readRequestJson(request)).event.event_id] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  try {
    const address = await listen(server);
    const env = remoteEnv(dataDir, `http://127.0.0.1:${address.port}`);
    const sessionId = "session-take-recovery-race";
    const resumePacket = packet();
    authorizeMcpSession(dataDir, sessionId, { hookEventName: "UserPromptSubmit" });
    const scope = stageTaskScopeForSession(dataDir, resumePacket, sessionId, env);
    const pendingDelivery = queueResumeInjection(
      dataDir,
      resumePacket,
      sessionId,
      scope.workstream_id,
      { injectionMethod: "codex-mcp-delivery-receipt", armed: true },
    );
    expectedReceiptId = pendingDelivery.receipt_id;

    const takePromise = callTool(
      "mnemuron_take_pending_resume",
      { session_id: sessionId },
      env,
    );
    await receiptStarted;
    const sessionStart = await runHook({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
    }, env);
    assert.equal(sessionStart.status, 0, sessionStart.stderr);
    assert.match(sessionStart.stderr, /recovery deferred: a live delivery owns this Session/i);
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 0,
      in_flight: 1,
      delivered: 0,
    });

    releaseReceiptResolve();
    const delivered = await takePromise;
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.resume_packet_returned, true);
    assert.equal(delivered.receipt_id, expectedReceiptId);
    assert.equal(receiptPosts, 1);
    assert.equal(resolveTaskScope(dataDir, sessionId, env).resume_id, resumePacket.resume_id);
  } finally {
    releaseReceiptResolve?.();
    if (server.listening) await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("compact SessionStart preserves an in-flight delivery for the matching Stop ACK", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-compact-delivery-"));
  let expectedReceiptId = null;
  const receiptPhases = [];
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url.includes("/delivery-receipts")) {
      const body = await readRequestJson(request);
      receiptPhases.push(body);
      response.statusCode = 200;
      response.end(JSON.stringify(centralDeliveryResponse(expectedReceiptId, {
        status: body.phase === "acknowledged" ? "acknowledged" : "in_flight",
        ackComplete: body.phase === "acknowledged",
      })));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/events") {
      response.statusCode = 200;
      response.end(JSON.stringify({ status: "accepted", received: 1, inserted: 1, duplicate: 0, accepted_event_ids: [(await readRequestJson(request)).event.event_id] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  try {
    const address = await listen(server);
    const env = remoteEnv(dataDir, `http://127.0.0.1:${address.port}`);
    const sessionId = "session-compact-delivery";
    const resumePacket = packet();
    authorizeMcpSession(dataDir, sessionId, { hookEventName: "UserPromptSubmit" });
    const scope = stageTaskScopeForSession(dataDir, resumePacket, sessionId, env);
    const pendingDelivery = queueResumeInjection(
      dataDir,
      resumePacket,
      sessionId,
      scope.workstream_id,
      { injectionMethod: "codex-mcp-delivery-receipt", armed: true },
    );
    expectedReceiptId = pendingDelivery.receipt_id;

    const delivered = await callTool(
      "mnemuron_take_pending_resume",
      { session_id: sessionId },
      env,
    );
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.receipt_id, expectedReceiptId);

    const compactStart = await runHook({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "compact",
    }, env);
    assert.equal(compactStart.status, 0, compactStart.stderr);
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 0,
      in_flight: 1,
      delivered: 0,
    });
    assert.equal(resolveTaskScope(dataDir, sessionId, env).resume_id, resumePacket.resume_id);
    assert.deepEqual(receiptPhases.map((body) => body.phase), ["delivered"]);

    const stopped = await runHook({
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: "turn-compact-delivery",
      last_assistant_message: "done after compaction",
    }, env);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 0,
      in_flight: 0,
      delivered: 1,
    });
    assert.deepEqual(receiptPhases.map((body) => body.phase), [
      "delivered",
      "acknowledged",
    ]);
    assert.equal(receiptPhases[1].turn_id, "turn-compact-delivery");
  } finally {
    if (server.listening) await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a current lock owned by a dead process is recovered immediately", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-delivery-dead-lock-"));
  let expectedReceiptId = null;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url.includes("/delivery-receipts")) {
      response.statusCode = 200;
      response.end(JSON.stringify(centralDeliveryResponse(expectedReceiptId)));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  try {
    const address = await listen(server);
    const env = remoteEnv(dataDir, `http://127.0.0.1:${address.port}`);
    const sessionId = "session-dead-delivery-lock";
    const resumePacket = packet();
    authorizeMcpSession(dataDir, sessionId, { hookEventName: "UserPromptSubmit" });
    const scope = stageTaskScopeForSession(dataDir, resumePacket, sessionId, env);
    const pendingDelivery = queueResumeInjection(
      dataDir,
      resumePacket,
      sessionId,
      scope.workstream_id,
      { injectionMethod: "codex-mcp-delivery-receipt", armed: true },
    );
    expectedReceiptId = pendingDelivery.receipt_id;
    const exitedProcess = spawn(process.execPath, ["-e", ""]);
    const deadProcessId = exitedProcess.pid;
    await once(exitedProcess, "exit");
    const deadLock = acquireMcpResumeDeliveryLock(dataDir, sessionId, {
      processId: deadProcessId,
    });
    assert.ok(deadLock);

    const delivered = await callTool(
      "mnemuron_take_pending_resume",
      { session_id: sessionId },
      env,
    );
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.resume_packet_returned, true);
    assert.equal(releaseMcpResumeDeliveryLock(deadLock), false);
  } finally {
    if (server.listening) await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a Stop ACK intent survives cross-process lock contention and is recovered by its exact Session", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-delivery-stop-intent-"));
  let expectedReceiptId = null;
  let deliveredPosts = 0;
  const acknowledgedPayloads = [];
  let heldLock = null;
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url.includes("/delivery-receipts")) {
      const body = await readRequestJson(request);
      if (body.phase === "delivered") deliveredPosts += 1;
      if (body.phase === "acknowledged") acknowledgedPayloads.push(body);
      response.statusCode = 200;
      response.end(JSON.stringify(centralDeliveryResponse(expectedReceiptId)));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/events") {
      response.statusCode = 200;
      response.end(JSON.stringify({ status: "accepted", received: 1, inserted: 1, duplicate: 0, accepted_event_ids: [(await readRequestJson(request)).event.event_id] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  try {
    const address = await listen(server);
    const env = remoteEnv(dataDir, `http://127.0.0.1:${address.port}`);
    const sessionId = "session-stop-intent-owner";
    const otherSessionId = "session-stop-intent-other";
    const stopTurnId = "turn-stop-intent-owner";
    const resumePacket = packet();
    authorizeMcpSession(dataDir, sessionId, { hookEventName: "UserPromptSubmit" });
    const scope = stageTaskScopeForSession(dataDir, resumePacket, sessionId, env);
    const pendingDelivery = queueResumeInjection(
      dataDir,
      resumePacket,
      sessionId,
      scope.workstream_id,
      { injectionMethod: "codex-mcp-delivery-receipt", armed: true },
    );
    expectedReceiptId = pendingDelivery.receipt_id;
    const delivered = await callTool(
      "mnemuron_take_pending_resume",
      { session_id: sessionId },
      env,
    );
    assert.equal(delivered.status, "delivered");
    assert.equal(deliveredPosts, 1);

    heldLock = acquireMcpResumeDeliveryLock(dataDir, sessionId);
    assert.ok(heldLock);
    const stopped = await runHook({
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: stopTurnId,
      last_assistant_message: "done",
    }, env);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stderr, /ACK deferred: this Session delivery is still locked/i);
    assert.equal(pendingMcpDeliveryAcknowledgementIntents(dataDir, sessionId).length, 1);
    assert.equal(
      pendingMcpDeliveryAcknowledgementIntents(dataDir, sessionId)[0].turn_id,
      stopTurnId,
    );
    const repeatedIntent = recordMcpDeliveryAcknowledgementIntent(
      dataDir,
      sessionId,
      stopTurnId,
    );
    assert.equal(repeatedIntent.turn_id, stopTurnId);
    assert.throws(
      () => recordMcpDeliveryAcknowledgementIntent(
        dataDir,
        sessionId,
        "turn-stop-intent-conflict",
      ),
      /already belongs to a different Stop turn/,
    );
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 0,
      in_flight: 1,
      delivered: 0,
    });

    const wrongSessionStart = await runHook({
      hook_event_name: "SessionStart",
      session_id: otherSessionId,
      source: "startup",
    }, env);
    assert.equal(wrongSessionStart.status, 0, wrongSessionStart.stderr);
    assert.equal(pendingMcpDeliveryAcknowledgementIntents(dataDir, sessionId).length, 1);
    assert.equal(acknowledgedPayloads.length, 0);
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 0,
      in_flight: 1,
      delivered: 0,
    });

    assert.equal(releaseMcpResumeDeliveryLock(heldLock), true);
    heldLock = null;
    const ownerSessionStart = await runHook({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
    }, env);
    assert.equal(ownerSessionStart.status, 0, ownerSessionStart.stderr);
    assert.deepEqual(pendingMcpDeliveryAcknowledgementIntents(dataDir, sessionId), []);
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 0,
      in_flight: 0,
      delivered: 1,
    });
    assert.equal(acknowledgedPayloads.length, 1);
    assert.equal(acknowledgedPayloads[0].receipt_id, expectedReceiptId);
    assert.equal(acknowledgedPayloads[0].session_id, sessionId);
    assert.equal(acknowledgedPayloads[0].turn_id, stopTurnId);

    const duplicateSessionStart = await runHook({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
    }, env);
    assert.equal(duplicateSessionStart.status, 0, duplicateSessionStart.stderr);
    const duplicateStop = await runHook({
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: stopTurnId,
      last_assistant_message: "done again",
    }, env);
    assert.equal(duplicateStop.status, 0, duplicateStop.stderr);
    assert.equal(acknowledgedPayloads.length, 1);
  } finally {
    if (heldLock) releaseMcpResumeDeliveryLock(heldLock);
    if (server.listening) await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("recovery that linearizes before a late Stop cannot ACK the replacement receipt", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-delivery-recovery-first-"));
  let deliveredPosts = 0;
  let failedPosts = 0;
  const acknowledgedPayloads = [];
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url.includes("/delivery-receipts")) {
      const body = await readRequestJson(request);
      if (body.phase === "delivered") deliveredPosts += 1;
      if (body.phase === "failed") failedPosts += 1;
      if (body.phase === "acknowledged") acknowledgedPayloads.push(body);
      response.statusCode = 200;
      response.end(JSON.stringify(centralDeliveryResponse(body.receipt_id, {
        centralReceiptId: body.receipt_id,
      })));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/events") {
      response.statusCode = 200;
      response.end(JSON.stringify({ status: "accepted", received: 1, inserted: 1, duplicate: 0, accepted_event_ids: [(await readRequestJson(request)).event.event_id] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  try {
    const address = await listen(server);
    const env = remoteEnv(dataDir, `http://127.0.0.1:${address.port}`);
    const sessionId = "session-recovery-before-stop";
    const resumePacket = packet();
    authorizeMcpSession(dataDir, sessionId, { hookEventName: "UserPromptSubmit" });
    const scope = stageTaskScopeForSession(dataDir, resumePacket, sessionId, env);
    queueResumeInjection(
      dataDir,
      resumePacket,
      sessionId,
      scope.workstream_id,
      { injectionMethod: "codex-mcp-delivery-receipt", armed: true },
    );
    const firstDelivery = await callTool(
      "mnemuron_take_pending_resume",
      { session_id: sessionId },
      env,
    );
    assert.equal(firstDelivery.status, "delivered");
    assert.equal(deliveredPosts, 1);

    const recovery = await runHook({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
    }, env);
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(failedPosts, 1);
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 1,
      in_flight: 0,
      delivered: 0,
    });

    const lateStop = await runHook({
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: "turn-before-recovery",
      last_assistant_message: "late stale Stop",
    }, env);
    assert.equal(lateStop.status, 0, lateStop.stderr);
    assert.deepEqual(pendingMcpDeliveryAcknowledgementIntents(dataDir, sessionId), []);
    assert.equal(acknowledgedPayloads.length, 0);

    const retryDelivery = await callTool(
      "mnemuron_take_pending_resume",
      { session_id: sessionId },
      env,
    );
    assert.equal(retryDelivery.status, "delivered");
    assert.notEqual(retryDelivery.receipt_id, firstDelivery.receipt_id);
    assert.equal(deliveredPosts, 2);
    assert.equal(acknowledgedPayloads.length, 0);

    const currentStop = await runHook({
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: "turn-after-recovery",
      last_assistant_message: "current Stop",
    }, env);
    assert.equal(currentStop.status, 0, currentStop.stderr);
    assert.equal(acknowledgedPayloads.length, 1);
    assert.equal(acknowledgedPayloads[0].receipt_id, retryDelivery.receipt_id);
    assert.equal(acknowledgedPayloads[0].turn_id, "turn-after-recovery");
  } finally {
    if (server.listening) await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a finished Stop ACK intent survives a crash before submission and replays once", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-delivery-ack-journal-"));
  let expectedReceiptId = null;
  let deliveredPosts = 0;
  let acknowledgedPosts = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url.includes("/delivery-receipts")) {
      const body = await readRequestJson(request);
      if (body.phase === "delivered") deliveredPosts += 1;
      if (body.phase === "acknowledged") acknowledgedPosts += 1;
      response.statusCode = 200;
      response.end(JSON.stringify(centralDeliveryResponse(expectedReceiptId,{status:body.phase==='acknowledged'?'acknowledged':'in_flight',ackComplete:body.phase==='acknowledged'})));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/events") {
      response.statusCode = 200;
      response.end(JSON.stringify({ status: "accepted", received: 1, inserted: 1, duplicate: 0, accepted_event_ids: [(await readRequestJson(request)).event.event_id] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  try {
    const address = await listen(server);
    const env = remoteEnv(dataDir, `http://127.0.0.1:${address.port}`);
    const sessionId = "session-delivery-ack-journal";
    const resumePacket = packet();
    authorizeMcpSession(dataDir, sessionId, { hookEventName: "UserPromptSubmit" });
    const scope = stageTaskScopeForSession(dataDir, resumePacket, sessionId, env);
    const pendingDelivery = queueResumeInjection(
      dataDir,
      resumePacket,
      sessionId,
      scope.workstream_id,
      { injectionMethod: "codex-mcp-delivery-receipt", armed: true },
    );
    expectedReceiptId = pendingDelivery.receipt_id;

    const delivered = await callTool(
      "mnemuron_take_pending_resume",
      { session_id: sessionId },
      env,
    );
    assert.equal(delivered.status, "delivered");
    assert.equal(deliveredPosts, 1);
    const intent = recordMcpDeliveryAcknowledgementIntent(
      dataDir,
      sessionId,
      "turn-journaled-stop",
    );
    assert.equal(intent.status, "pending");
    const finished = finishMcpResumeDelivery(dataDir, sessionId, "turn-journaled-stop");
    assert.equal(finished.length, 1);
    assert.equal(finished[0].delivery_ack_pending, true);
    assert.equal(finished[0].delivery_ack_reported_at, null);
    assert.equal(finished[0].delivery_ack_payload.turn_id, "turn-journaled-stop");
    assert.equal(pendingMcpDeliveryAcknowledgements(dataDir).length, 1);
    assert.equal(pendingMcpDeliveryAcknowledgementIntents(dataDir, sessionId).length, 1);
    assert.deepEqual(listDeliveryReceiptOutbox(dataDir), []);

    const firstRestart = await runHook({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
    }, env);
    assert.equal(firstRestart.status, 0, firstRestart.stderr);
    assert.equal(acknowledgedPosts, 1);
    assert.deepEqual(pendingMcpDeliveryAcknowledgements(dataDir), []);
    assert.deepEqual(pendingMcpDeliveryAcknowledgementIntents(dataDir, sessionId), []);
    assert.deepEqual(listDeliveryReceiptOutbox(dataDir), []);

    const secondRestart = await runHook({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
    }, env);
    assert.equal(secondRestart.status, 0, secondRestart.stderr);
    assert.equal(acknowledgedPosts, 1);
    assert.deepEqual(pendingMcpDeliveryAcknowledgements(dataDir), []);
  } finally {
    if (server.listening) await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

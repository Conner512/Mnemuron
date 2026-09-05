import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { backup } from "node:sqlite";
import { createMnemuronApp } from "../lib/app.mjs";
import { MnemuronStore } from "../lib/store.mjs";

async function api(baseUrl, apiKey, method, endpoint, body, expectedStatus = null) {
  const response = await fetch(new URL(endpoint, baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (expectedStatus !== null) assert.equal(response.status, expectedStatus, JSON.stringify(data));
  return { response, data };
}

const task = {
  task_id: "task-cross-device-test",
  project_id: "project-mnemuron",
  project_name: "Mnemuron",
  title: "Mnemuron cross device test",
  aliases: ["跨设备测试", "cross device"],
  goal: "Continue a Mac mini task on MacBook through the central service.",
  status: "active",
  progress: ["Both ChatGPT plugins are installed."],
  decisions: ["Resume Preview is required before confirmation."],
  blockers: [],
  next_steps: ["Capture on Mac mini and resume on MacBook."],
  resources: ["docs/core-spec-v0.1.md"],
  workstreams: [
    { workstream_id: "workstream-macmini", name: "Mac mini", status: "active" },
    { workstream_id: "workstream-macbook", name: "MacBook", status: "active" },
  ],
  conflicts: [],
};

test("request body limit accepts the blocked event size and returns a real 413 response", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-body-limit-"));
  const app = createMnemuronApp({
    databasePath: path.join(root, "mnemuron.sqlite3"),
    maxBodyBytes: 4 * 1024 * 1024,
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const agent = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "MacBook ChatGPT body limit test",
      device_id: "macbook-body-limit-test",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-macbook-body-limit-test",
    }, 201);
    const event = {
      event_id: randomUUID(),
      event_type: "tool_result",
      captured_at: new Date().toISOString(),
      content: "x".repeat(3_300_000),
    };
    await api(baseUrl, agent.data.api_key, "POST", "/v1/events", { event }, 202);

    const rejected = await api(baseUrl, agent.data.api_key, "POST", "/v1/events", {
      event: {
        ...event,
        event_id: randomUUID(),
        content: "x".repeat(4_300_000),
      },
    }, 413);
    assert.equal(rejected.data.error, "Request body is too large.");
  } finally {
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("central API preserves server provenance, confirmation gate, revocation, retention, and restart state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-server-"));
  const databasePath = path.join(root, "mnemuron.sqlite3");
  let app = createMnemuronApp({ databasePath });
  let baseUrl;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();

    const mini = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "Mac mini ChatGPT",
      device_id: "macmini-example",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-macmini-example",
    }, 201);
    const book = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "MacBook ChatGPT",
      device_id: "macbook-example",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-macbook-example",
    }, 201);
    const miniKey = mini.data.api_key;
    const bookKey = book.data.api_key;

    const retention = await api(baseUrl, admin.api_key, "PUT", "/v1/retention", {
      raw_retention_days: 30,
    }, 200);
    assert.equal(retention.data.raw_retention_days, 30);

    await api(baseUrl, admin.api_key, "POST", "/v1/tasks", task, 200);

    const eventId = randomUUID();
    const event = {
      event_id: eventId,
      event_type: "assistant_message",
      captured_at: new Date().toISOString(),
      project_id: task.project_id,
      task_id: task.task_id,
      workstream_id: "workstream-macmini",
      session_id: "session-mini",
      content: "Mac mini completed the central API implementation and is ready for handoff.",
      provenance: {
        device_id: "forged-device",
        agent_instance_id: "forged-agent",
      },
    };
    const accepted = await api(baseUrl, miniKey, "POST", "/v1/events", {
      event,
      raw_retention_days: 1,
    }, 202);
    assert.equal(accepted.data.inserted, 1);
    const duplicate = await api(baseUrl, miniKey, "POST", "/v1/events", {
      event,
      raw_retention_days: 1,
    }, 202);
    assert.equal(duplicate.data.inserted, 0);
    assert.equal(duplicate.data.duplicate, 1);

    const previewCall = await api(baseUrl, bookKey, "POST", "/v1/resume/preview", {
      query: "继续跨设备测试",
    }, 201);
    const preview = previewCall.data;
    assert.equal(preview.status, "pending_confirmation");
    assert.equal(preview.resume_packet, undefined);
    assert.equal(Date.parse(preview.expires_at) - Date.parse(preview.created_at), 30 * 60_000);
    assert.equal(preview.recent_activity.length, 1);
    assert.equal(preview.recent_activity[0].provenance.device_id, "macmini-example");
    assert.equal(preview.recent_activity[0].provenance.agent_instance_id, "chatgpt-macmini-example");

    const wrongVersion = await api(
      baseUrl,
      bookKey,
      "POST",
      `/v1/resume/${preview.resume_id}/confirm`,
      { preview_version: 2, confirmed: true },
      409,
    );
    assert.match(wrongVersion.data.error, /version changed/i);

    const confirmed = await api(
      baseUrl,
      bookKey,
      "POST",
      `/v1/resume/${preview.resume_id}/confirm`,
      { preview_version: 1, confirmed: true },
      200,
    );
    assert.equal(confirmed.data.status, "confirmed");
    assert.equal(confirmed.data.resume_packet.context.recent_activity[0].provenance.device_id, "macmini-example");

    const injectionAttemptId = randomUUID();
    const injectedEvent = {
      event_id: randomUUID(),
      attempt_id: injectionAttemptId,
      preview_version: preview.preview_version,
      phase: "injected",
      session_id: "session-book-resume",
      turn_id: "turn-book-resume",
      workstream_id: "workstream-macbook",
      injection_method: "codex-hook-additional-context",
      occurred_at: new Date().toISOString(),
    };
    const injected = await api(
      baseUrl,
      bookKey,
      "POST",
      `/v1/resume/${preview.resume_id}/injection-events`,
      injectedEvent,
      202,
    );
    assert.equal(injected.data.delivery.status, "in_flight");
    assert.equal(injected.data.delivery.ack_complete, false);
    const duplicateInjected = await api(
      baseUrl,
      bookKey,
      "POST",
      `/v1/resume/${preview.resume_id}/injection-events`,
      { ...injectedEvent, event_id: randomUUID() },
      202,
    );
    assert.equal(duplicateInjected.data.inserted, 0);
    assert.equal(duplicateInjected.data.duplicate, 1);
    await api(
      baseUrl,
      bookKey,
      "POST",
      `/v1/resume/${preview.resume_id}/injection-events`,
      { ...injectedEvent, event_id: randomUUID(), turn_id: "turn-changed" },
      409,
    );

    await api(
      baseUrl,
      miniKey,
      "POST",
      `/v1/resume/${preview.resume_id}/injection-events`,
      {
        ...injectedEvent,
        event_id: randomUUID(),
        phase: "acknowledged",
        occurred_at: new Date().toISOString(),
      },
      409,
    );

    const acknowledged = await api(
      baseUrl,
      bookKey,
      "POST",
      `/v1/resume/${preview.resume_id}/injection-events`,
      {
        ...injectedEvent,
        event_id: randomUUID(),
        phase: "acknowledged",
        occurred_at: new Date().toISOString(),
      },
      202,
    );
    assert.equal(acknowledged.data.delivery.status, "acknowledged");
    assert.equal(acknowledged.data.delivery.ack_complete, true);
    assert.equal(acknowledged.data.delivery.latest_attempt.provenance.device_id, "macbook-example");
    assert.equal(acknowledged.data.delivery.latest_attempt.provenance.agent_instance_id, "chatgpt-macbook-example");

    const deliveryStatus = await api(
      baseUrl,
      bookKey,
      "GET",
      `/v1/resume/${preview.resume_id}/injection-status`,
      undefined,
      200,
    );
    assert.equal(deliveryStatus.data.ack_complete, true);
    assert.equal(deliveryStatus.data.latest_attempt.session_id, "session-book-resume");
    assert.equal(deliveryStatus.data.latest_attempt.turn_id, "turn-book-resume");
    await api(
      baseUrl,
      bookKey,
      "POST",
      `/v1/resume/${preview.resume_id}/injection-events`,
      { ...injectedEvent, event_id: randomUUID(), attempt_id: randomUUID() },
      409,
    );
    const ackStatus = await api(baseUrl, bookKey, "GET", "/v1/status", undefined, 200);
    assert.equal(ackStatus.data.resume_injection_acks.acknowledged, 1);
    assert.equal(ackStatus.data.resume_injection_acks.unreported, 0);

    const receiptId = randomUUID();
    const deliveredReceipt = {
      receipt_event_id: randomUUID(),
      receipt_id: receiptId,
      preview_version: preview.preview_version,
      phase: "delivered",
      session_id: "session-book-mcp-receipt",
      turn_id: null,
      workstream_id: "workstream-macbook",
      delivery_method: "codex-mcp-tool-result",
      occurred_at: new Date().toISOString(),
    };
    const receipted = await api(
      baseUrl,
      bookKey,
      "POST",
      `/v1/resume/${preview.resume_id}/delivery-receipts`,
      deliveredReceipt,
      202,
    );
    assert.equal(receipted.data.delivery.status, "in_flight");
    assert.equal(receipted.data.delivery.ack_complete, false);
    assert.equal(receipted.data.delivery.latest_receipt.turn_id, null);
    const duplicateReceipt = await api(
      baseUrl,
      bookKey,
      "POST",
      `/v1/resume/${preview.resume_id}/delivery-receipts`,
      { ...deliveredReceipt, receipt_event_id: randomUUID() },
      202,
    );
    assert.equal(duplicateReceipt.data.inserted, 0);
    assert.equal(duplicateReceipt.data.duplicate, 1);
    await api(
      baseUrl,
      bookKey,
      "POST",
      `/v1/resume/${preview.resume_id}/delivery-receipts`,
      {
        ...deliveredReceipt,
        receipt_event_id: randomUUID(),
        phase: "acknowledged",
        turn_id: null,
      },
      400,
    );
    await api(
      baseUrl,
      miniKey,
      "POST",
      `/v1/resume/${preview.resume_id}/delivery-receipts`,
      {
        ...deliveredReceipt,
        receipt_event_id: randomUUID(),
        phase: "acknowledged",
        turn_id: "turn-book-mcp-receipt",
      },
      409,
    );
    const acknowledgedReceipt = await api(
      baseUrl,
      bookKey,
      "POST",
      `/v1/resume/${preview.resume_id}/delivery-receipts`,
      {
        ...deliveredReceipt,
        receipt_event_id: randomUUID(),
        phase: "acknowledged",
        turn_id: "turn-book-mcp-receipt",
        occurred_at: new Date().toISOString(),
      },
      202,
    );
    assert.equal(acknowledgedReceipt.data.delivery.status, "acknowledged");
    assert.equal(acknowledgedReceipt.data.delivery.ack_complete, true);
    assert.equal(
      acknowledgedReceipt.data.delivery.latest_receipt.turn_id,
      "turn-book-mcp-receipt",
    );
    const receiptStatus = await api(
      baseUrl,
      bookKey,
      "GET",
      `/v1/resume/${preview.resume_id}/delivery-receipt-status`,
      undefined,
      200,
    );
    assert.equal(receiptStatus.data.protocol, "chatgpt-mcp-delivery-receipt-v0.1.4");
    assert.equal(receiptStatus.data.latest_receipt.provenance.device_id, "macbook-example");
    const statusWithReceipt = await api(baseUrl, bookKey, "GET", "/v1/status", undefined, 200);
    assert.equal(statusWithReceipt.data.resume_delivery_receipts.acknowledged, 1);
    assert.equal(statusWithReceipt.data.resume_delivery_receipts.unreported, 0);
    assert.deepEqual(statusWithReceipt.data.raw_availability, {
      schema_version: "mnemuron-raw-availability-status-v0.1",
      total_events: 1,
      raw_events_available: 1,
      expired_events: 0,
      unexplained_raw_unavailable: 0,
      status: "accounted",
    });

    app.store.db.prepare("UPDATE events SET expires_at = ? WHERE event_id = ?")
      .run("2000-01-01T00:00:00.000Z", eventId);
    const pruned = await api(baseUrl, admin.api_key, "POST", "/v1/retention/prune", {}, 200);
    assert.equal(pruned.data.expired_events, 1);
    const stored = app.store.db.prepare("SELECT content, raw_payload_json, expired_at FROM events WHERE event_id = ?")
      .get(eventId);
    assert.equal(stored.content, null);
    assert.equal(stored.raw_payload_json, null);
    assert.ok(stored.expired_at);
    const statusAfterPrune = await api(baseUrl, miniKey, "GET", "/v1/status", undefined, 200);
    assert.equal(statusAfterPrune.data.counts.raw_events_available, 0);
    assert.equal(statusAfterPrune.data.counts.expired_events, 1);
    assert.equal(statusAfterPrune.data.counts.unexplained_raw_unavailable, 0);
    assert.equal(statusAfterPrune.data.raw_availability.status, "accounted");

    const backupPath = path.join(root, "backup.sqlite3");
    await backup(app.store.db, backupPath);
    const backupStore = new MnemuronStore(backupPath);
    try {
      const backupStatus = backupStore.status(backupStore.authenticate(miniKey));
      assert.equal(backupStatus.counts.tasks, 1);
      assert.equal(backupStatus.counts.events, 1);
      assert.equal(backupStatus.counts.expired_events, 1);
      assert.equal(backupStatus.raw_availability.status, "accounted");
    } finally {
      backupStore.close();
    }

    await api(
      baseUrl,
      admin.api_key,
      "POST",
      "/v1/agent-instances/chatgpt-macbook-example/revoke",
      {},
      200,
    );
    await api(baseUrl, bookKey, "GET", "/v1/status", undefined, 401);

    await app.close();
    app = createMnemuronApp({ databasePath });
    const restartedAddress = await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${restartedAddress.port}`;
    const status = await api(baseUrl, miniKey, "GET", "/v1/status", undefined, 200);
    assert.equal(status.data.counts.tasks, 1);
    assert.equal(status.data.counts.events, 1);
    assert.equal(status.data.identity.identity_status, "server_verified");
    assert.equal(status.data.retention.raw_retention_days, 30);
  } finally {
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw availability reports unexplained missing payloads as degraded", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-raw-availability-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const agent = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "Raw availability test",
      device_id: "raw-availability-test",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-raw-availability-test",
    }, 201);
    const eventId = randomUUID();
    await api(baseUrl, agent.data.api_key, "POST", "/v1/events", {
      event: {
        event_id: eventId,
        event_type: "assistant_message",
        captured_at: new Date().toISOString(),
        content: "This payload is deliberately removed without a retention marker.",
      },
    }, 202);
    app.store.db.prepare("UPDATE events SET raw_payload_json = NULL WHERE event_id = ?")
      .run(eventId);

    const status = await api(baseUrl, agent.data.api_key, "GET", "/v1/status", undefined, 200);
    assert.equal(status.data.counts.events, 1);
    assert.equal(status.data.counts.raw_events_available, 0);
    assert.equal(status.data.counts.expired_events, 0);
    assert.equal(status.data.counts.unexplained_raw_unavailable, 1);
    assert.equal(status.data.raw_availability.status, "degraded");
  } finally {
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resume preview gives an embedded exact task id priority over shared project matches", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-task-id-match-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const agent = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "OpenClaw example client",
      device_id: "openclaw-host",
      agent_id: "openclaw",
      agent_instance_id: "openclaw-local",
    }, 201);
    const target = {
      ...task,
      task_id: "task-mnemuron-openclaw-adapter-v01",
      title: "Mnemuron OpenClaw Adapter v0.1",
    };
    const sibling = {
      ...task,
      task_id: "task-mnemuron-chatgpt-plugin-spike",
      title: "Mnemuron ChatGPT Plugin Spike",
    };
    await api(baseUrl, admin.api_key, "POST", "/v1/tasks", target, 200);
    await api(baseUrl, admin.api_key, "POST", "/v1/tasks", sibling, 200);

    const preview = await api(baseUrl, agent.data.api_key, "POST", "/v1/resume/preview", {
      query: "继续任务 task-mnemuron-openclaw-adapter-v01（Mnemuron OpenClaw Adapter v0.1）",
    }, 201);
    assert.equal(preview.data.status, "pending_confirmation");
    assert.equal(preview.data.task.task_id, target.task_id);
    assert.equal(preview.data.match.score, 1);
  } finally {
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMnemuronApp } from "../lib/app.mjs";

async function api(baseUrl, apiKey, method, endpoint, body, expectedStatus) {
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

test("a retry delivered in the same event millisecond supersedes the failed receipt", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-delivery-receipt-order-"));
  const app = createMnemuronApp({
    databasePath: path.join(root, "mnemuron.sqlite3"),
  });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const agent = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "Client A delivery retry test",
      device_id: "clienta-delivery-retry",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-clienta-delivery-retry",
    }, 201);
    const taskId = "task-delivery-retry-same-millisecond";
    await api(baseUrl, admin.api_key, "POST", "/v1/tasks", {
      task_id: taskId,
      project_id: "project-mnemuron",
      project_name: "Mnemuron",
      title: "Delivery Receipt same-millisecond retry",
      aliases: [],
      goal: "Keep a newer retry in flight when event timestamps collide.",
      status: "active",
      progress: [],
      decisions: [],
      blockers: [],
      next_steps: [],
      resources: [],
      workstreams: [{
        workstream_id: "workstream-clienta",
        name: "Client A",
        status: "active",
      }],
      conflicts: [],
    }, 200);
    const preview = await api(baseUrl, agent.api_key, "POST", "/v1/resume/preview", {
      query: taskId,
    }, 201);
    await api(
      baseUrl,
      agent.api_key,
      "POST",
      `/v1/resume/${preview.resume_id}/confirm`,
      { preview_version: preview.preview_version, confirmed: true },
      200,
    );

    const occurredAt = "2026-09-04T12:34:56.789Z";
    const common = {
      preview_version: preview.preview_version,
      session_id: "session-delivery-retry",
      workstream_id: "workstream-clienta",
      delivery_method: "codex-mcp-tool-result",
      occurred_at: occurredAt,
    };
    const failedReceiptId = "receipt-retry-0001";
    await api(
      baseUrl,
      agent.api_key,
      "POST",
      `/v1/resume/${preview.resume_id}/delivery-receipts`,
      {
        ...common,
        receipt_event_id: randomUUID(),
        receipt_id: failedReceiptId,
        phase: "delivered",
        turn_id: null,
      },
      202,
    );
    const failed = await api(
      baseUrl,
      agent.api_key,
      "POST",
      `/v1/resume/${preview.resume_id}/delivery-receipts`,
      {
        ...common,
        receipt_event_id: randomUUID(),
        receipt_id: failedReceiptId,
        phase: "failed",
        turn_id: null,
        error_code: "adapter_restarted",
      },
      202,
    );
    assert.equal(failed.delivery.status, "failed");

    const retryReceiptId = "receipt-retry-0002";
    const retried = await api(
      baseUrl,
      agent.api_key,
      "POST",
      `/v1/resume/${preview.resume_id}/delivery-receipts`,
      {
        ...common,
        receipt_event_id: randomUUID(),
        receipt_id: retryReceiptId,
        phase: "delivered",
        turn_id: null,
      },
      202,
    );
    assert.equal(retried.delivery.status, "in_flight");
    assert.equal(retried.delivery.ack_complete, false);
    assert.equal(retried.delivery.latest_receipt.receipt_id, retryReceiptId);
    assert.ok(
      retried.delivery.latest_receipt.latest_received_at
        > retried.delivery.receipts[1].latest_received_at,
    );

    const status = await api(
      baseUrl,
      agent.api_key,
      "GET",
      `/v1/resume/${preview.resume_id}/delivery-receipt-status`,
      undefined,
      200,
    );
    assert.equal(status.status, "in_flight");
    assert.equal(status.latest_receipt.receipt_id, retryReceiptId);
    assert.deepEqual(
      status.receipts.map((receipt) => receipt.receipt_id),
      [retryReceiptId, failedReceiptId],
    );
  } finally {
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

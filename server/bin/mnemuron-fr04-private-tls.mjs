#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import https from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const TASK_ID = "task-mnemuron-production-readiness-v01";
const WORKSTREAM_ID = "workstream-failure-recovery";
const DELIVERY_METHOD = "failure-recovery-private-tls-receipt-v0.1";

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${item}.`);
    result[item.slice(2)] = next;
    index += 1;
  }
  return result;
}

function writePrivate(file, content) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function writeJson(file, value) {
  writePrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function modeOf(file) {
  return (statSync(file).mode & 0o777).toString(8).padStart(4, "0");
}

function safeError(data) {
  if (!data || typeof data !== "object") return null;
  return {
    error: typeof data.error === "string" ? data.error : null,
    code: typeof data.code === "string" ? data.code : null,
  };
}

function safeResponse(label, response) {
  return {
    label,
    status: response.status,
    latency_ms: response.latency_ms,
    inserted: Number.isInteger(response.data?.inserted) ? response.data.inserted : null,
    duplicate: Number.isInteger(response.data?.duplicate) ? response.data.duplicate : null,
    delivery_status: response.data?.delivery?.status || null,
    ack_complete: response.data?.delivery?.ack_complete ?? null,
    error: safeError(response.data),
  };
}

function requestJson({ baseUrl, apiKey = null, method = "GET", endpoint, body, timeoutMs = 15_000 }) {
  const target = new URL(endpoint, baseUrl);
  if (target.protocol !== "https:") throw new Error("FR-04 production runner requires HTTPS.");
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      timeout: timeoutMs,
      headers: {
        accept: "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(payload ? {
          "content-type": "application/json",
          "content-length": payload.length,
        } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch {
          data = { error: "invalid_json_response" };
        }
        resolve({
          status: response.statusCode,
          data,
          latency_ms: Number((performance.now() - started).toFixed(3)),
        });
      });
    });
    request.on("timeout", () => request.destroy(new Error("request_timeout")));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new Error(`${label} returned ${response.status}; expected ${expected}.`);
  }
}

function assertKeyFile(file, label) {
  if (modeOf(file) !== "0600") throw new Error(`${label} key file must be mode 0600.`);
  const key = readFileSync(file, "utf8").trim();
  if (!key.startsWith("mnm_")) throw new Error(`${label} key file is invalid.`);
  return key;
}

function phasePayload(base, overrides = {}) {
  return {
    ...base,
    receipt_event_id: randomUUID(),
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

export async function runFr04(options) {
  const serverUrl = new URL(options.serverUrl);
  if (serverUrl.protocol !== "https:") throw new Error("FR-04 production runner requires an HTTPS server URL.");
  const evidenceDir = path.resolve(options.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  chmodSync(evidenceDir, 0o700);
  const primaryKey = assertKeyFile(path.resolve(options.primaryKeyFile), "primary");
  const unrelatedKey = assertKeyFile(path.resolve(options.unrelatedKeyFile), "unrelated");
  const startedAt = new Date().toISOString();
  const responses = [];

  const livez = await requestJson({ baseUrl: serverUrl, endpoint: "/livez" });
  const readyz = await requestJson({ baseUrl: serverUrl, endpoint: "/readyz" });
  assertStatus(livez, 200, "livez");
  assertStatus(readyz, 200, "readyz");

  const previewResponse = await requestJson({
    baseUrl: serverUrl,
    apiKey: primaryKey,
    method: "POST",
    endpoint: "/v1/resume/preview",
    body: { query: TASK_ID },
  });
  assertStatus(previewResponse, 201, "preview");
  const preview = previewResponse.data;
  if (preview?.status !== "pending_confirmation" || preview?.task?.task_id !== TASK_ID) {
    throw new Error("Preview did not resolve the exact Production Readiness Task.");
  }
  if (preview?.resolution?.status !== "resolved" || preview?.resolution?.match?.task_id !== TASK_ID) {
    throw new Error("Combination Resolver did not return the exact Task.");
  }

  const confirmResponse = await requestJson({
    baseUrl: serverUrl,
    apiKey: primaryKey,
    method: "POST",
    endpoint: `/v1/resume/${preview.resume_id}/confirm`,
    body: { preview_version: preview.preview_version, confirmed: true },
  });
  assertStatus(confirmResponse, 200, "confirm");
  if (confirmResponse.data?.status !== "confirmed") throw new Error("Resume confirmation failed.");

  const receiptId = randomUUID();
  const concurrentReceiptId = randomUUID();
  const ackBeforeDeliveryReceiptId = randomUUID();
  const afterCompletionReceiptId = randomUUID();
  const sessionId = `fr04-private-tls-${options.runId}`;
  const turnId = `${sessionId}-turn`;
  const baseReceipt = {
    receipt_id: receiptId,
    preview_version: preview.preview_version,
    phase: "delivered",
    session_id: sessionId,
    turn_id: null,
    workstream_id: WORKSTREAM_ID,
    delivery_method: DELIVERY_METHOD,
  };
  const endpoint = `/v1/resume/${preview.resume_id}/delivery-receipts`;
  const send = async (label, apiKey, body, expected) => {
    const response = await requestJson({ baseUrl: serverUrl, apiKey, method: "POST", endpoint, body });
    responses.push(safeResponse(label, response));
    assertStatus(response, expected, label);
    return response;
  };

  const delivered = await send("delivered", primaryKey, phasePayload(baseReceipt), 202);
  const duplicateDelivered = await send("duplicate_delivered", primaryKey, phasePayload(baseReceipt), 202);
  await send("changed_session", primaryKey, phasePayload(baseReceipt, { session_id: `${sessionId}-other` }), 409);
  await send("changed_workstream", primaryKey, phasePayload(baseReceipt, { workstream_id: `${WORKSTREAM_ID}-other` }), 409);
  await send("changed_delivery_method", primaryKey, phasePayload(baseReceipt, { delivery_method: `${DELIVERY_METHOD}-other` }), 409);
  await send("unrelated_identity_claim", unrelatedKey, phasePayload(baseReceipt, {
    phase: "acknowledged",
    turn_id: turnId,
  }), 409);
  await send("concurrent_delivery", primaryKey, phasePayload(baseReceipt, { receipt_id: concurrentReceiptId }), 409);
  await send("ack_before_delivery", primaryKey, phasePayload(baseReceipt, {
    receipt_id: ackBeforeDeliveryReceiptId,
    phase: "acknowledged",
    turn_id: `${sessionId}-early-turn`,
  }), 409);
  const acknowledged = await send("acknowledged", primaryKey, phasePayload(baseReceipt, {
    phase: "acknowledged",
    turn_id: turnId,
  }), 202);
  const duplicateAcknowledged = await send("duplicate_acknowledged", primaryKey, phasePayload(baseReceipt, {
    phase: "acknowledged",
    turn_id: turnId,
  }), 202);
  await send("delivery_after_completion", primaryKey, phasePayload(baseReceipt, {
    receipt_id: afterCompletionReceiptId,
  }), 409);

  const receiptStatus = await requestJson({
    baseUrl: serverUrl,
    apiKey: primaryKey,
    endpoint: `/v1/resume/${preview.resume_id}/delivery-receipt-status`,
  });
  assertStatus(receiptStatus, 200, "receipt status");
  const latest = receiptStatus.data?.latest_receipt;
  const passed = delivered.data?.inserted === 1
    && duplicateDelivered.data?.inserted === 0
    && duplicateDelivered.data?.duplicate === 1
    && acknowledged.data?.inserted === 1
    && duplicateAcknowledged.data?.inserted === 0
    && duplicateAcknowledged.data?.duplicate === 1
    && receiptStatus.data?.status === "acknowledged"
    && receiptStatus.data?.ack_complete === true
    && receiptStatus.data?.receipts?.length === 1
    && latest?.receipt_id === receiptId
    && latest?.receipt_event_ids?.length === 2
    && latest?.session_id === sessionId
    && latest?.turn_id === turnId
    && latest?.workstream_id === WORKSTREAM_ID
    && latest?.delivery_method === DELIVERY_METHOD;
  if (!passed) throw new Error("FR-04 acceptance invariants did not pass.");

  const completedAt = new Date().toISOString();
  const manifest = {
    run_id: options.runId,
    case_id: "FR-04",
    profile: "bounded_private_tls_production_path",
    server_origin: serverUrl.origin,
    task_id: TASK_ID,
    workstream_id: WORKSTREAM_ID,
    started_at: startedAt,
    completed_at: completedAt,
    runner_sha256: sha256File(fileURLToPath(import.meta.url)),
    temporary_credentials: 2,
    key_material_recorded: false,
    raw_packet_recorded: false,
    service_restart_performed: false,
    network_change_performed: false,
    caddy_change_performed: false,
    production_ready_promoted: false,
  };
  const receipts = {
    resume_id: preview.resume_id,
    preview_version: preview.preview_version,
    receipt_id: receiptId,
    concurrent_receipt_id: concurrentReceiptId,
    ack_before_delivery_receipt_id: ackBeforeDeliveryReceiptId,
    after_completion_receipt_id: afterCompletionReceiptId,
    status: receiptStatus.data.status,
    ack_complete: receiptStatus.data.ack_complete,
    latest_receipt: latest,
    response_checks: responses,
  };
  const summary = {
    run_id: options.runId,
    case_id: "FR-04",
    result: "pass",
    resume_id: preview.resume_id,
    preview_version: preview.preview_version,
    resolver_status: preview.resolution.status,
    resolver_task_id: preview.resolution.match.task_id,
    receipt_id: receiptId,
    delivery_status: receiptStatus.data.status,
    ack_complete: receiptStatus.data.ack_complete,
    receipt_phase_rows: latest.receipt_event_ids.length,
    exact_duplicates_idempotent: true,
    changed_session_conflict: true,
    changed_workstream_conflict: true,
    changed_delivery_method_conflict: true,
    unrelated_identity_conflict: true,
    concurrent_delivery_conflict: true,
    ack_before_delivery_conflict: true,
    post_completion_delivery_conflict: true,
    temporary_identity_authenticated: true,
    production_status_checked_out_of_band: true,
  };
  const timeline = [
    "timestamp,event,status",
    `${startedAt},fr04_start,started`,
    `${preview.created_at},resume_preview,pending_confirmation`,
    `${confirmResponse.data?.resume_packet?.injection_authorized_at || startedAt},resume_confirm,confirmed`,
    `${latest.delivered_at},receipt_delivery,delivered`,
    `${latest.acknowledged_at},receipt_ack,acknowledged`,
    `${completedAt},fr04_complete,pass`,
  ].join("\n");
  writeJson(path.join(evidenceDir, "manifest.json"), manifest);
  writeJson(path.join(evidenceDir, "responses.json"), { responses });
  writeJson(path.join(evidenceDir, "receipts.json"), receipts);
  writeJson(path.join(evidenceDir, "summary.json"), summary);
  writePrivate(path.join(evidenceDir, "timeline.csv"), `${timeline}\n`);
  return { manifest, receipts, summary, evidence_dir: evidenceDir };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["server-url", "primary-key-file", "unrelated-key-file", "run-id", "evidence-dir"]) {
    if (!args[required]) throw new Error(`--${required} is required.`);
  }
  const result = await runFr04({
    serverUrl: args["server-url"],
    primaryKeyFile: args["primary-key-file"],
    unrelatedKeyFile: args["unrelated-key-file"],
    runId: args["run-id"],
    evidenceDir: args["evidence-dir"],
  });
  process.stdout.write(`${JSON.stringify({
    status: result.summary.result,
    run_id: result.summary.run_id,
    resume_id: result.summary.resume_id,
    receipt_id: result.summary.receipt_id,
    evidence_dir: result.evidence_dir,
  })}\n`);
}

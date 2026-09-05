#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createMnemuronApp } from "../lib/app.mjs";
import { drainIsolatedOutbox } from '../lib/harness-sync.mjs';
import {
  MnemuronClient,
  resolveAdapterConfig,
} from "../../adapters/openclaw/dist/client.js";

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const HISTORICAL_BODY_BYTES = 3_272_419;
export const NEAR_LIMIT_BODY_BYTES = Math.floor(7.5 * 1024 * 1024);
export const OVER_LIMIT_BODY_BYTES = MAX_BODY_BYTES + 1;
export const MEMORY_STOP_BYTES = Math.floor(0.7 * 1024 * 1024 * 1024);

const TABLES_PRESERVED_BY_PRUNE = [
  "tasks",
  "memories",
  "checkpoints",
  "resumes",
  "resolver_selections",
  "resume_injection_events",
  "resume_delivery_receipts",
  "credentials",
];

const DEFAULTS = {
  executionLayer: "local-isolated",
  sustainedRate: 10,
  sustainedSeconds: 15 * 60,
  burstRate: 50,
  burstSeconds: 60,
  concurrentRate: 10,
  concurrentSeconds: 10,
  queueCount: 3_000,
  queueInterruptCount: 500,
  queueInterruptAfter: 100,
  sampleIntervalMs: 5_000,
};

export const QUICK_DEFAULTS = {
  executionLayer: "local-isolated",
  sustainedRate: 5,
  sustainedSeconds: 1,
  burstRate: 20,
  burstSeconds: 1,
  concurrentRate: 5,
  concurrentSeconds: 1,
  queueCount: 40,
  queueInterruptCount: 20,
  queueInterruptAfter: 5,
  sampleIntervalMs: 250,
};

const EXECUTION_LAYERS = new Set(["local-isolated", "ct131-isolated"]);

function executionIdentity(executionLayer) {
  if (executionLayer === "ct131-isolated") {
    return {
      label: "Mnemuron server isolated capacity harness",
      device_id: "capacity-server-v02",
      agent_id: "mnemuron-loadgen",
      agent_instance_id: "mnemuron-loadgen-capacity-v02",
    };
  }
  return {
    label: "Mnemuron local capacity harness",
    device_id: "capacity-local-v02",
    agent_id: "mnemuron-loadgen",
    agent_instance_id: "mnemuron-loadgen-local-v02",
  };
}

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function writePrivate(file, content) {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function writeJson(file, value) {
  writePrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256(readFileSync(file));
}

function sizeOf(file) {
  return existsSync(file) ? statSync(file).size : 0;
}

function modeOf(file) {
  return statSync(file).mode & 0o777;
}

function tableCount(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function tableCounts(db, tables) {
  return Object.fromEntries(tables.map((table) => [table, tableCount(db, table)]));
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return Number(sorted[Math.max(0, index)].toFixed(3));
}

export function latencySummary(records) {
  const values = records
    .filter((record) => Number.isFinite(record.latency_ms))
    .map((record) => record.latency_ms);
  const statuses = {};
  for (const record of records) {
    const key = record.error ? "error" : String(record.status);
    statuses[key] = (statuses[key] || 0) + 1;
  }
  return {
    count: records.length,
    statuses,
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
    p99_ms: percentile(values, 0.99),
    max_ms: values.length ? Number(Math.max(...values).toFixed(3)) : null,
  };
}

export function createBackupProgressTracker() {
  let steps = 0;
  let previousRemaining = null;
  let rewindSignals = 0;
  let largestRemainingIncrease = 0;
  let totalPagesMin = null;
  let totalPagesMax = null;
  let first = null;
  let last = null;

  return {
    record({ totalPages, remainingPages }) {
      const sample = {
        step: steps + 1,
        total_pages: Number(totalPages),
        remaining_pages: Number(remainingPages),
      };
      if (!Number.isFinite(sample.total_pages) || !Number.isFinite(sample.remaining_pages)) {
        throw new Error("Backup progress must contain finite page counts.");
      }
      if (previousRemaining !== null && sample.remaining_pages > previousRemaining) {
        rewindSignals += 1;
        largestRemainingIncrease = Math.max(
          largestRemainingIncrease,
          sample.remaining_pages - previousRemaining,
        );
      }
      steps += 1;
      previousRemaining = sample.remaining_pages;
      totalPagesMin = totalPagesMin === null
        ? sample.total_pages
        : Math.min(totalPagesMin, sample.total_pages);
      totalPagesMax = totalPagesMax === null
        ? sample.total_pages
        : Math.max(totalPagesMax, sample.total_pages);
      first ||= sample;
      last = sample;
    },
    summary() {
      return {
        progress_steps: steps,
        rewind_signals: rewindSignals,
        largest_remaining_increase_pages: largestRemainingIncrease,
        total_pages_min: totalPagesMin,
        total_pages_max: totalPagesMax,
        first_progress: first,
        last_progress: last,
      };
    },
  };
}

function safeCsv(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(file, columns, rows) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => safeCsv(row[column])).join(","));
  writePrivate(file, `${lines.join("\n")}\n`);
}

function eventTemplate({
  eventId,
  runId,
  sessionId,
  content = "",
  eventType = "tool_result",
  captureSource = "capacity-harness-local-isolated-v0.2",
}) {
  return {
    event_id: eventId,
    event_type: eventType,
    hook_event_name: "CapacityHarness",
    captured_at: new Date().toISOString(),
    project_id: "project-mnemuron",
    task_id: "task-mnemuron-production-readiness-v01",
    workstream_id: "workstream-capacity",
    session_id: sessionId,
    turn_id: `${runId}-turn`,
    content,
    capture_capability: {
      user_messages: true,
      assistant_messages: true,
      tool_events: true,
      session_lifecycle: true,
      transcript_parser_used: false,
      source: captureSource,
    },
  };
}

export function makeSizedEnvelope(targetBytes, identity) {
  if (!Number.isInteger(targetBytes) || targetBytes < 1) {
    throw new Error("targetBytes must be a positive integer.");
  }
  const envelope = {
    event: eventTemplate({ ...identity, content: "" }),
    raw_retention_days: 1,
  };
  const baseBytes = Buffer.byteLength(JSON.stringify(envelope));
  if (targetBytes < baseBytes) {
    throw new Error(`Target ${targetBytes} is smaller than the ${baseBytes}-byte envelope.`);
  }
  envelope.event.content = "x".repeat(targetBytes - baseBytes);
  const body = JSON.stringify(envelope);
  const actualBytes = Buffer.byteLength(body);
  if (actualBytes !== targetBytes) {
    throw new Error(`Envelope sizing failed: expected ${targetBytes}, got ${actualBytes}.`);
  }
  return { envelope, body, bytes: actualBytes };
}

function httpJson({ baseUrl, apiKey, method, endpoint, body, agent, timeoutMs = 60_000 }) {
  const target = new URL(endpoint, baseUrl);
  const payload = body === undefined
    ? null
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const request = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      agent,
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        ...(payload ? {
          "content-type": "application/json",
          "content-length": payload.length,
        } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = { invalid_json: text.slice(0, 200) };
        }
        resolve({
          status: response.statusCode,
          data,
          latency_ms: performance.now() - started,
          reused_socket: request.reusedSocket,
          request_bytes: payload?.length || 0,
        });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("request_timeout")));
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
  });
}

function storageSnapshot(root, databasePath, label) {
  const fs = statfsSync(root, { bigint: true });
  const total = Number(fs.blocks * fs.bsize);
  const free = Number(fs.bavail * fs.bsize);
  return {
    label,
    captured_at: new Date().toISOString(),
    database_bytes: sizeOf(databasePath),
    wal_bytes: sizeOf(`${databasePath}-wal`),
    shm_bytes: sizeOf(`${databasePath}-shm`),
    filesystem_total_bytes: total,
    filesystem_free_bytes: free,
    filesystem_free_percent: Number(((free / total) * 100).toFixed(3)),
  };
}

function resourceSample(root, databasePath, label) {
  const usage = process.memoryUsage();
  return {
    ...storageSnapshot(root, databasePath, label),
    rss_bytes: usage.rss,
    heap_used_bytes: usage.heapUsed,
    heap_total_bytes: usage.heapTotal,
    cpu_user_us: process.cpuUsage().user,
    cpu_system_us: process.cpuUsage().system,
    load_1m: os.loadavg()[0],
  };
}

function identityFor(runId, phase, index) {
  return {
    eventId: `${runId}-${phase}-${String(index).padStart(6, "0")}`,
    runId,
    sessionId: `capacity-v02-${runId}-${phase}`,
  };
}

function loadPayloadBytes(index) {
  const bucket = index % 20;
  if (bucket === 0) return 128 * 1024;
  if (bucket <= 3) return 16 * 1024;
  return 2 * 1024;
}

async function runRatePhase({
  phase,
  rate,
  seconds,
  runId,
  baseUrl,
  apiKey,
  agent,
  latencyRecords,
  generatedIds,
  stopState,
}) {
  const count = rate * seconds;
  const intervalMs = 1_000 / rate;
  const started = performance.now();
  const pending = new Set();
  for (let index = 0; index < count; index += 1) {
    if (stopState.reason) break;
    const targetAt = started + (index * intervalMs);
    const waitMs = targetAt - performance.now();
    if (waitMs > 0) await sleep(waitMs);
    const identity = identityFor(runId, phase, index);
    generatedIds.add(identity.eventId);
    const sized = makeSizedEnvelope(loadPayloadBytes(index), identity);
    const promise = httpJson({
      baseUrl,
      apiKey,
      method: "POST",
      endpoint: "/v1/events",
      body: sized.body,
      agent,
    }).then((response) => {
      latencyRecords.push({
        phase,
        index,
        event_id: identity.eventId,
        payload_bytes: sized.bytes,
        status: response.status,
        latency_ms: Number(response.latency_ms.toFixed(3)),
        error: "",
      });
    }).catch((error) => {
      latencyRecords.push({
        phase,
        index,
        event_id: identity.eventId,
        payload_bytes: sized.bytes,
        status: "",
        latency_ms: null,
        error: error.message,
      });
    });
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    if (pending.size >= 256) await Promise.race(pending);
  }
  await Promise.allSettled([...pending]);
  return {
    phase,
    target_rate: rate,
    target_seconds: seconds,
    target_count: count,
    scheduled_count: latencyRecords.filter((record) => record.phase === phase).length,
    elapsed_ms: Number((performance.now() - started).toFixed(3)),
  };
}

function reconcileIds(db, generatedIds) {
  const stored = new Set(db.prepare("SELECT event_id FROM events").all().map((row) => row.event_id));
  const missing = [...generatedIds].filter((eventId) => !stored.has(eventId));
  const storedGenerated = [...generatedIds].filter((eventId) => stored.has(eventId));
  return {
    generated: generatedIds.size,
    stored: storedGenerated.length,
    missing_count: missing.length,
    missing_sample: missing.slice(0, 20),
    generated_id_sha256: sha256([...generatedIds].sort().join("\n")),
    stored_id_sha256: sha256(storedGenerated.sort().join("\n")),
    duplicate_ids: 0,
  };
}

async function verifiedBackup(db, target, { ratePages = 100 } = {}) {
  const started = performance.now();
  const progress = createBackupProgressTracker();
  const pagesBackedUp = await backup(db, target, {
    rate: ratePages,
    progress: (sample) => progress.record(sample),
  });
  chmodSync(target, 0o600);
  const copy = new DatabaseSync(target, { readOnly: true });
  const integrity = copy.prepare("PRAGMA integrity_check").get().integrity_check;
  const counts = {
    events: tableCount(copy, "events"),
    tasks: tableCount(copy, "tasks"),
    credentials: tableCount(copy, "credentials"),
  };
  copy.close();
  return {
    duration_ms: Number((performance.now() - started).toFixed(3)),
    rate_pages: ratePages,
    pages_backed_up: pagesBackedUp,
    ...progress.summary(),
    bytes: sizeOf(target),
    mode: modeOf(target).toString(8).padStart(4, "0"),
    integrity_check: integrity,
    counts,
  };
}

function caseResult(id, passed, evidence, blocker = null) {
  return {
    id,
    result: passed ? "pass" : "fail",
    blocker,
    evidence,
  };
}

function taskFixture() {
  return {
    task_id: "task-mnemuron-production-readiness-v01",
    project_id: "project-mnemuron",
    project_name: "Mnemuron",
    title: "Mnemuron Production Readiness v0.1",
    aliases: ["Production Readiness"],
    goal: "Run isolated capacity and backpressure acceptance.",
    status: "active",
    progress: [],
    decisions: ["production_ready remains false."],
    blockers: [],
    next_steps: [],
    resources: ["docs/capacity-backpressure-test-plan-v0.1.md"],
    workstreams: [
      { workstream_id: "workstream-capacity", name: "Capacity Harness", status: "active" },
    ],
    conflicts: [],
  };
}

async function seedIdentity({ baseUrl, adminKey, agent, identity }) {
  const registration = await httpJson({
    baseUrl,
    apiKey: adminKey,
    method: "POST",
    endpoint: "/v1/agent-instances/register",
    body: {
      label: identity.label,
      device_id: identity.device_id,
      agent_id: identity.agent_id,
      agent_instance_id: identity.agent_instance_id,
    },
    agent,
  });
  if (registration.status !== 201) {
    throw new Error(`Agent registration failed (${registration.status}).`);
  }
  const task = await httpJson({
    baseUrl,
    apiKey: adminKey,
    method: "POST",
    endpoint: "/v1/tasks",
    body: taskFixture(),
    agent,
  });
  if (task.status !== 200) throw new Error(`Task seed failed (${task.status}).`);
  return registration.data.api_key;
}

function adapterConfig({ root, baseUrl, apiKey, identity }) {
  const keyFile = path.join(root, "capacity-harness.key");
  writePrivate(keyFile, `${apiKey}\n`);
  return resolveAdapterConfig({
    serverUrl: baseUrl,
    allowInsecureHttp: true,
    apiKeyFile: keyFile,
    outboxDir: path.join(root, "adapter", "outbox"),
    pendingResumeDir: path.join(root, "adapter", "pending-resume"),
    taskScopeDir: path.join(root, "adapter", "task-scopes"),
    injectionEventOutboxDir: path.join(root, "adapter", "injection-event-outbox"),
    deviceId: identity.device_id,
    agentId: identity.agent_id,
    agentInstanceId: identity.agent_instance_id,
    projectId: "project-mnemuron",
    taskId: "task-mnemuron-production-readiness-v01",
    workstreamId: "workstream-capacity",
    rawRetentionDays: 1,
    requestTimeoutMs: 1_000,
  });
}

function queueEvent(runId, phase, index, content = "queued") {
  return eventTemplate({
    ...identityFor(runId, phase, index),
    content,
  });
}

function outboxPermissions(client) {
  const files = client.outboxFiles();
  return {
    directory_mode: modeOf(client.config.outboxDir).toString(8).padStart(4, "0"),
    file_modes: [...new Set(files.map((file) => modeOf(file).toString(8).padStart(4, "0")))],
    files: files.length,
    bytes: files.reduce((total, file) => total + sizeOf(file), 0),
  };
}

async function runQueueCases({ app, root, baseUrl, apiKey, runId, options, identity }) {
  const cases = [];
  const liveConfig = adapterConfig({ root, baseUrl, apiKey, identity });
  const offlineConfig = {
    ...liveConfig,
    serverUrl: new URL("http://127.0.0.1:1"),
    requestTimeoutMs: 100,
  };
  const offlineClient = new MnemuronClient(offlineConfig);
  const queuedIds = new Set();
  const first = queueEvent(runId, "queue01", 0);
  queuedIds.add(first.event_id);
  const probe = await offlineClient.submitEvent(first);
  for (let index = 1; index < options.queueCount; index += 1) {
    const event = queueEvent(runId, "queue01", index);
    queuedIds.add(event.event_id);
    offlineClient.queueEnvelope({ event, raw_retention_days: 1 });
  }
  const permissions = outboxPermissions(offlineClient);
  const queue01Passed = probe.delivery === "queued"
    && permissions.files === options.queueCount
    && permissions.directory_mode === "0700"
    && permissions.file_modes.length === 1
    && permissions.file_modes[0] === "0600";
  cases.push(caseResult("QUEUE-01", queue01Passed, {
    offline_probe_delivery: probe.delivery,
    offline_probe_count: 1,
    direct_atomic_queue_count: options.queueCount - 1,
    ...permissions,
  }));

  const liveClient = new MnemuronClient(liveConfig);
  const drainStarted = performance.now();
  const drained = await drainIsolatedOutbox(liveClient);
  const drainMs = performance.now() - drainStarted;
  const queueReconcile = reconcileIds(app.store.db, queuedIds);
  const queue02Passed = drained.queued_before === options.queueCount
    && drained.flushed === options.queueCount
    && liveClient.outboxFiles().length === 0
    && queueReconcile.missing_count === 0
    && drainMs < 5 * 60_000;
  cases.push(caseResult("QUEUE-02", queue02Passed, {
    ...drained,
    drain_ms: Number(drainMs.toFixed(3)),
    final_queue: liveClient.outboxFiles().length,
    reconciliation: queueReconcile,
  }));

  const interruptedIds = new Set();
  for (let index = 0; index < options.queueInterruptCount; index += 1) {
    const event = queueEvent(runId, "queue03", index);
    interruptedIds.add(event.event_id);
    liveClient.queueEnvelope({ event, raw_retention_days: 1 });
  }
  const interruptingClient = new MnemuronClient(liveConfig);
  const originalRequest = interruptingClient.request.bind(interruptingClient);
  let interruptInjected = false;
  let requestCount = 0;
  interruptingClient.request = async (...args) => {
    if (requestCount >= options.queueInterruptAfter) {
      interruptInjected = true;
      throw Object.assign(new Error("harness_interrupt"), {errorCode:'HARNESS_INTERRUPT'});
    }
    requestCount += 1;
    return originalRequest(...args);
  };
  let interruptError = null;
  try {
    const interrupted=await interruptingClient.flushOutbox();
    if(interrupted.blocked && interruptInjected)interruptError='harness_interrupt';
  } catch (error) {
    interruptError = error.message;
  }
  const remainingAfterInterrupt = interruptingClient.outboxFiles().length;
  const restartedClient = new MnemuronClient(liveConfig);
  const restartDrain = await drainIsolatedOutbox(restartedClient);
  const interruptedReconcile = reconcileIds(app.store.db, interruptedIds);
  const queue03Passed = interruptError === "harness_interrupt"
    && remainingAfterInterrupt === options.queueInterruptCount - options.queueInterruptAfter
    && restartDrain.flushed === remainingAfterInterrupt
    && restartedClient.outboxFiles().length === 0
    && interruptedReconcile.missing_count === 0;
  cases.push(caseResult("QUEUE-03", queue03Passed, {
    interrupt_error: interruptError,
    flushed_before_interrupt: options.queueInterruptAfter,
    remaining_after_interrupt: remainingAfterInterrupt,
    restarted_flush: restartDrain,
    final_queue: restartedClient.outboxFiles().length,
    reconciliation: interruptedReconcile,
  }));

  const oversizeIdentity = {
    eventId: `${runId}-queue04-000000`,
    runId,
    sessionId: `capacity-v02-${runId}-queue04`,
  };
  const validIdentity = {
    eventId: `${runId}-queue04-zzzzzz`,
    runId,
    sessionId: `capacity-v02-${runId}-queue04-independent`,
  };
  const oversize = makeSizedEnvelope(OVER_LIMIT_BODY_BYTES, oversizeIdentity);
  const valid = makeSizedEnvelope(2 * 1024, validIdentity);
  restartedClient.queueEnvelope(oversize.envelope);
  restartedClient.queueEnvelope(valid.envelope);
  let queue04Error = null;
  try {
    await restartedClient.flushOutbox();
  } catch (error) {
    queue04Error = error.message;
  }
  const queue04Files = restartedClient.outboxFiles().map((file) => path.basename(file));
  const quarantineFiles = restartedClient.outboxQuarantineFiles()
    .map((file) => path.basename(file));
  const quarantineItems = restartedClient.quarantinedOutboxItems();
  const [terminal] = quarantineItems;
  const quarantinedOriginal = path.join(
    restartedClient.config.outboxQuarantineDir,
    `${oversizeIdentity.eventId}.json`,
  );
  const validStored = app.store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_id = ?")
    .get(validIdentity.eventId).count;
  const oversizedStored = app.store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_id = ?")
    .get(oversizeIdentity.eventId).count;
  const requiredBehaviorPassed = queue04Error === null
    && queue04Files.length === 0
    && quarantineFiles.length === 2
    && quarantineItems.length === 1
    && terminal?.event_id === oversizeIdentity.eventId
    && terminal?.terminal_status === "quarantined"
    && terminal?.reason === "permanent_http_413"
    && terminal?.http_status === 413
    && terminal?.original_bytes === OVER_LIMIT_BODY_BYTES + 1
    && existsSync(quarantinedOriginal)
    && modeOf(restartedClient.config.outboxQuarantineDir) === 0o700
    && modeOf(quarantinedOriginal) === 0o600
    && validStored === 1
    && oversizedStored === 0;
  cases.push(caseResult("QUEUE-04", requiredBehaviorPassed, {
    error: queue04Error,
    remaining_files: queue04Files,
    quarantine_files: quarantineFiles,
    quarantine_terminal: terminal || null,
    quarantine_directory_mode: modeOf(restartedClient.config.outboxQuarantineDir)
      .toString(8).padStart(4, "0"),
    quarantine_original_mode: existsSync(quarantinedOriginal)
      ? modeOf(quarantinedOriginal).toString(8).padStart(4, "0")
      : null,
    valid_event_stored: validStored,
    oversized_event_stored: oversizedStored,
    actual_behavior: requiredBehaviorPassed
      ? "permanent_413_quarantined_later_valid_event_drained"
      : "see_evidence",
  }, requiredBehaviorPassed ? null : "permanent_413_head_of_line_blocking"));

  return cases;
}

function finalReportMarkdown(summary) {
  const lines = [
    "# Local Capacity and Backpressure Harness Result",
    "",
    `- Run ID: \`${summary.run_id}\``,
    `- Status: **${summary.status}**`,
    `- Started: ${summary.started_at}`,
    `- Finished: ${summary.finished_at}`,
    `- Production contacted: no`,
    `- production_ready changed: no`,
    "",
    "## Cases",
    "",
    "| Case | Result | Blocker |",
    "| --- | --- | --- |",
  ];
  for (const testCase of summary.cases) {
    lines.push(`| ${testCase.id} | ${testCase.result} | ${testCase.blocker || "—"} |`);
  }
  lines.push(
    "",
    "## Load summary",
    "",
    `- Requests: ${summary.load_latency.count}`,
    `- p95: ${summary.load_latency.p95_ms} ms`,
    `- Missing Events: ${summary.load_reconciliation.missing_count}`,
    `- Integrity: ${summary.final_integrity_check}`,
    "",
    summary.mode === "ct131-isolated"
      ? "This result is server disposable loopback evidence only. It does not represent private-TLS acceptance."
      : "This result is local isolated evidence only. It does not represent deployed-server or private-TLS acceptance.",
    "",
  );
  return lines.join("\n");
}

export async function runLocalHarness(input = {}) {
  const options = { ...DEFAULTS, ...input };
  if (!EXECUTION_LAYERS.has(options.executionLayer)) {
    throw new Error("executionLayer must be local-isolated or ct131-isolated.");
  }
  const startedAt = new Date().toISOString();
  const runId = options.runId || `local-${timestampId()}-${randomUUID().slice(0, 8)}`;
  const identity = executionIdentity(options.executionLayer);
  const evidenceDir = path.resolve(options.evidenceDir
    || path.join(process.cwd(), "evidence", "capacity-backpressure", runId));
  ensurePrivateDirectory(evidenceDir);

  const root = mkdtempSync(path.join(os.tmpdir(), `mnemuron-capacity-${options.executionLayer}-`));
  chmodSync(root, 0o700);
  const databasePath = path.join(root, "mnemuron.sqlite3");
  const app = createMnemuronApp({
    databasePath,
    defaultRetentionDays: 1,
    maxBodyBytes: MAX_BODY_BYTES,
  });
  const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64 });
  const latencyRecords = [];
  const resourceRecords = [];
  const storageRecords = [];
  const cases = [];
  const generatedLoadIds = new Set();
  const stopState = { reason: null };
  let sampler = null;
  let summary = null;
  let baseUrl = null;

  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin({ label: "Local capacity harness admin" });
    const apiKey = await seedIdentity({
      baseUrl,
      adminKey: admin.api_key,
      agent: keepAliveAgent,
      identity,
    });
    storageRecords.push(storageSnapshot(root, databasePath, "baseline"));

    const sample = () => {
      const record = resourceSample(root, databasePath, "running");
      resourceRecords.push(record);
      if (record.rss_bytes >= MEMORY_STOP_BYTES) stopState.reason = "memory_stop_threshold";
      if (record.filesystem_free_percent < 20) stopState.reason = "filesystem_stop_threshold";
    };
    sample();
    sampler = setInterval(sample, options.sampleIntervalMs);

    const body01Identity = identityFor(runId, "body01", 0);
    const body01 = makeSizedEnvelope(HISTORICAL_BODY_BYTES, body01Identity);
    const body01Response = await httpJson({
      baseUrl,
      apiKey,
      method: "POST",
      endpoint: "/v1/events",
      body: body01.body,
      agent: keepAliveAgent,
    });
    const body01Stored = app.store.db.prepare(`
      SELECT length(raw_payload_json) AS raw_bytes FROM events WHERE event_id = ?
    `).get(body01Identity.eventId);
    cases.push(caseResult("BODY-01", body01Response.status === 202
      && body01Stored?.raw_bytes > 3_000_000, {
      request_bytes: body01.bytes,
      status: body01Response.status,
      raw_payload_json_bytes: body01Stored?.raw_bytes || 0,
      latency_ms: Number(body01Response.latency_ms.toFixed(3)),
    }));

    const body02Identities = [0, 1].map((index) => identityFor(runId, "body02", index));
    const body02Payloads = body02Identities.map((identity) => makeSizedEnvelope(
      NEAR_LIMIT_BODY_BYTES,
      identity,
    ));
    const body02Responses = await Promise.all(body02Payloads.map((payload) => httpJson({
      baseUrl,
      apiKey,
      method: "POST",
      endpoint: "/v1/events",
      body: payload.body,
      agent: keepAliveAgent,
    })));
    const body02Stored = body02Identities.reduce((total, identity) => total
      + app.store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_id = ?")
        .get(identity.eventId).count, 0);
    cases.push(caseResult("BODY-02", body02Responses.every((response) => response.status === 202)
      && body02Stored === 2, {
      request_bytes_each: NEAR_LIMIT_BODY_BYTES,
      statuses: body02Responses.map((response) => response.status),
      latencies_ms: body02Responses.map((response) => Number(response.latency_ms.toFixed(3))),
      stored_events: body02Stored,
    }));

    const body03Identity = identityFor(runId, "body03", 0);
    const body03 = makeSizedEnvelope(OVER_LIMIT_BODY_BYTES, body03Identity);
    const body03Response = await httpJson({
      baseUrl,
      apiKey,
      method: "POST",
      endpoint: "/v1/events",
      body: body03.body,
      agent: keepAliveAgent,
    });
    const body03Stored = app.store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_id = ?")
      .get(body03Identity.eventId).count;
    cases.push(caseResult("BODY-03", body03Response.status === 413
      && body03Response.data?.error === "Request body is too large."
      && body03Stored === 0, {
      request_bytes: body03.bytes,
      status: body03Response.status,
      error: body03Response.data?.error,
      stored_events: body03Stored,
      latency_ms: Number(body03Response.latency_ms.toFixed(3)),
    }));

    const body04Identity = identityFor(runId, "body04", 0);
    const body04 = makeSizedEnvelope(2 * 1024, body04Identity);
    const body04Response = await httpJson({
      baseUrl,
      apiKey,
      method: "POST",
      endpoint: "/v1/events",
      body: body04.body,
      agent: keepAliveAgent,
    });
    const body04Stored = app.store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_id = ?")
      .get(body04Identity.eventId).count;
    cases.push(caseResult("BODY-04", body04Response.status === 202
      && body04Response.reused_socket === true
      && body04Stored === 1, {
      status: body04Response.status,
      reused_socket: body04Response.reused_socket,
      stored_events: body04Stored,
      latency_ms: Number(body04Response.latency_ms.toFixed(3)),
    }));

    const backupTarget = path.join(root, "online-during-load.sqlite3");
    let backupPromise = null;
    const backupTimer = setTimeout(() => {
      backupPromise = verifiedBackup(app.store.db, backupTarget);
    }, Math.min(5_000, Math.max(100, options.sustainedSeconds * 250)));
    const load01 = await runRatePhase({
      phase: "LOAD-01",
      rate: options.sustainedRate,
      seconds: options.sustainedSeconds,
      runId,
      baseUrl,
      apiKey,
      agent: keepAliveAgent,
      latencyRecords,
      generatedIds: generatedLoadIds,
      stopState,
    });
    clearTimeout(backupTimer);
    if (!backupPromise) backupPromise = verifiedBackup(app.store.db, backupTarget);
    const backupResult = await backupPromise;
    const load01Records = latencyRecords.filter((record) => record.phase === "LOAD-01");
    const load01Latency = latencySummary(load01Records);
    cases.push(caseResult("LOAD-01", !stopState.reason
      && load01.scheduled_count === load01.target_count
      && load01Latency.statuses["202"] === load01.target_count
      && load01Latency.p95_ms < 1_000, {
      ...load01,
      latency: load01Latency,
    }, stopState.reason));

    const load02 = await runRatePhase({
      phase: "LOAD-02",
      rate: options.burstRate,
      seconds: options.burstSeconds,
      runId,
      baseUrl,
      apiKey,
      agent: keepAliveAgent,
      latencyRecords,
      generatedIds: generatedLoadIds,
      stopState,
    });
    const load02Records = latencyRecords.filter((record) => record.phase === "LOAD-02");
    const load02Latency = latencySummary(load02Records);
    cases.push(caseResult("LOAD-02", !stopState.reason
      && load02.scheduled_count === load02.target_count
      && load02Latency.statuses["202"] === load02.target_count
      && load02Latency.p95_ms < 1_000, {
      ...load02,
      latency: load02Latency,
    }, stopState.reason));

    const load03Promise = runRatePhase({
      phase: "LOAD-03",
      rate: options.concurrentRate,
      seconds: options.concurrentSeconds,
      runId,
      baseUrl,
      apiKey,
      agent: keepAliveAgent,
      latencyRecords,
      generatedIds: generatedLoadIds,
      stopState,
    });
    await sleep(Math.min(1_000, Math.max(50, options.concurrentSeconds * 250)));
    const bodyDuringLoadIdentities = [0, 1].map((index) => identityFor(runId, "load03-large", index));
    const bodyDuringLoad = await Promise.all(bodyDuringLoadIdentities.map((identity) => {
      const sized = makeSizedEnvelope(NEAR_LIMIT_BODY_BYTES, identity);
      return httpJson({
        baseUrl,
        apiKey,
        method: "POST",
        endpoint: "/v1/events",
        body: sized.body,
        agent: keepAliveAgent,
      });
    }));
    const load03 = await load03Promise;
    const load03Records = latencyRecords.filter((record) => record.phase === "LOAD-03");
    const load03Latency = latencySummary(load03Records);
    const largeDuringLoadStored = bodyDuringLoadIdentities.reduce((total, identity) => total
      + app.store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_id = ?")
        .get(identity.eventId).count, 0);
    cases.push(caseResult("LOAD-03", !stopState.reason
      && load03.scheduled_count === load03.target_count
      && load03Latency.statuses["202"] === load03.target_count
      && bodyDuringLoad.every((response) => response.status === 202)
      && largeDuringLoadStored === 2, {
      ...load03,
      background_latency: load03Latency,
      large_statuses: bodyDuringLoad.map((response) => response.status),
      large_latencies_ms: bodyDuringLoad.map((response) => Number(response.latency_ms.toFixed(3))),
      large_stored_events: largeDuringLoadStored,
    }, stopState.reason));
    storageRecords.push(storageSnapshot(root, databasePath, "after-load"));

    const loadReconciliation = reconcileIds(app.store.db, generatedLoadIds);
    const acceptedLoad = latencyRecords.filter((record) => record.status === 202).length;
    for (const testCase of cases.filter((item) => item.id.startsWith("LOAD-"))) {
      if (loadReconciliation.missing_count || acceptedLoad !== generatedLoadIds.size) {
        testCase.result = "fail";
        testCase.blocker = "load_event_reconciliation_failed";
      }
    }

    const queueCases = await runQueueCases({
      app,
      root,
      baseUrl,
      apiKey,
      runId,
      options,
      identity,
    });
    cases.push(...queueCases);

    const pruneTarget = body04Identity.eventId;
    const beforePruneCounts = tableCounts(app.store.db, TABLES_PRESERVED_BY_PRUNE);
    const auditBefore = tableCount(app.store.db, "audit_events");
    app.store.db.prepare("UPDATE events SET expires_at = ? WHERE event_id = ?")
      .run("2000-01-01T00:00:00.000Z", pruneTarget);
    const adminAuth = app.store.authenticate(admin.api_key);
    const pruneResult = app.store.pruneExpired(adminAuth);
    const afterPruneCounts = tableCounts(app.store.db, TABLES_PRESERVED_BY_PRUNE);
    const auditAfter = tableCount(app.store.db, "audit_events");
    const prunedRow = app.store.db.prepare(`
      SELECT content, raw_payload_json, expired_at FROM events WHERE event_id = ?
    `).get(pruneTarget);
    const preservedCounts = TABLES_PRESERVED_BY_PRUNE.every((table) => (
      beforePruneCounts[table] === afterPruneCounts[table]
    ));
    cases.push(caseResult("RET-01", pruneResult.expired_events === 1
      && prunedRow.content === null
      && prunedRow.raw_payload_json === null
      && Boolean(prunedRow.expired_at), {
      prune_result: pruneResult,
      target_event_id: pruneTarget,
      content_cleared: prunedRow.content === null,
      raw_cleared: prunedRow.raw_payload_json === null,
      metadata_retained: Boolean(prunedRow.expired_at),
    }));
    cases.push(caseResult("RET-02", preservedCounts && auditAfter === auditBefore + 1, {
      before: beforePruneCounts,
      after: afterPruneCounts,
      audit_before: auditBefore,
      audit_after: auditAfter,
      expected_audit_append: 1,
    }));
    cases.push(caseResult("RET-03", backupResult.integrity_check === "ok"
      && backupResult.mode === "0600"
      && latencyRecords.every((record) => !record.error && record.status === 202), {
      backup: backupResult,
      load_requests_during_test: latencyRecords.length,
    }));

    app.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    storageRecords.push(storageSnapshot(root, databasePath, "after-wal-checkpoint"));
    storageRecords.push(storageSnapshot(root, databasePath, "after-prune"));
    const storagePassed = storageRecords.every((record) => record.filesystem_free_percent >= 20);
    cases.push(caseResult("RET-04", storagePassed, {
      snapshots: storageRecords,
    }, storagePassed ? null : "filesystem_free_below_20_percent"));

    const finalIntegrity = app.store.db.prepare("PRAGMA integrity_check").get().integrity_check;
    const rawCounts = app.store.db.prepare(`
      SELECT
        COUNT(*) AS events,
        SUM(CASE WHEN raw_payload_json IS NOT NULL THEN 1 ELSE 0 END) AS raw_available,
        SUM(CASE WHEN expired_at IS NOT NULL THEN 1 ELSE 0 END) AS expired
      FROM events
    `).get();
    clearInterval(sampler);
    sampler = null;
    sample();

    const failedCases = cases.filter((testCase) => testCase.result !== "pass");
    const finishedAt = new Date().toISOString();
    summary = {
      schema_version: "mnemuron-capacity-backpressure-local-v0.2",
      run_id: runId,
      status: failedCases.length ? "blocked" : "pass",
      started_at: startedAt,
      finished_at: finishedAt,
      mode: options.executionLayer,
      production_contacted: false,
      production_ready_changed: false,
      hermes_touched: false,
      temporary_database_removed_after_run: true,
      parameters: {
        max_body_bytes: MAX_BODY_BYTES,
        historical_body_bytes: HISTORICAL_BODY_BYTES,
        near_limit_body_bytes: NEAR_LIMIT_BODY_BYTES,
        over_limit_body_bytes: OVER_LIMIT_BODY_BYTES,
        sustained_rate: options.sustainedRate,
        sustained_seconds: options.sustainedSeconds,
        burst_rate: options.burstRate,
        burst_seconds: options.burstSeconds,
        concurrent_rate: options.concurrentRate,
        concurrent_seconds: options.concurrentSeconds,
        queue_count: options.queueCount,
      },
      source_hashes: {
        harness: sha256File(fileURLToPath(import.meta.url)),
        app: sha256File(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib/app.mjs")),
        store: sha256File(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib/store.mjs")),
        openclaw_client: sha256File(path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../../adapters/openclaw/dist/client.js",
        )),
      },
      cases,
      load_latency: latencySummary(latencyRecords),
      load_reconciliation: loadReconciliation,
      final_integrity_check: finalIntegrity,
      raw_counts: rawCounts,
      stop_reason: stopState.reason,
      evidence_files: ["manifest.json", "summary.json", "latency.csv", "resources.csv", "report.md"],
    };

    const manifest = {
      schema_version: summary.schema_version,
      run_id: runId,
      generated_at: finishedAt,
      topology: {
        server: options.executionLayer === "ct131-isolated"
          ? "in-process current createMnemuronApp on the server"
          : "in-process current createMnemuronApp",
        listener: "127.0.0.1 random port",
        database: "temporary SQLite removed after run",
        tls: false,
        ct131: options.executionLayer === "ct131-isolated",
      },
      identity: {
        device_id: identity.device_id,
        agent_id: identity.agent_id,
        agent_instance_id: identity.agent_instance_id,
        project_id: "project-mnemuron",
        task_id: "task-mnemuron-production-readiness-v01",
        workstream_id: "workstream-capacity",
      },
      parameters: summary.parameters,
      source_hashes: summary.source_hashes,
      credentials_in_evidence: false,
    };
    writeJson(path.join(evidenceDir, "manifest.json"), manifest);
    writeJson(path.join(evidenceDir, "summary.json"), summary);
    writeCsv(path.join(evidenceDir, "latency.csv"), [
      "phase",
      "index",
      "event_id",
      "payload_bytes",
      "status",
      "latency_ms",
      "error",
    ], latencyRecords);
    writeCsv(path.join(evidenceDir, "resources.csv"), [
      "captured_at",
      "label",
      "rss_bytes",
      "heap_used_bytes",
      "heap_total_bytes",
      "cpu_user_us",
      "cpu_system_us",
      "load_1m",
      "database_bytes",
      "wal_bytes",
      "filesystem_total_bytes",
      "filesystem_free_bytes",
      "filesystem_free_percent",
    ], resourceRecords);
    writePrivate(path.join(evidenceDir, "report.md"), `${finalReportMarkdown(summary)}\n`);
    return { summary, evidenceDir };
  } finally {
    if (sampler) clearInterval(sampler);
    keepAliveAgent.destroy();
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer.`);
  return number;
}

function parseArgs(argv) {
  const values = {};
  let quick = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--quick") {
      quick = true;
      continue;
    }
    if (!item.startsWith("--")) throw new Error(`Unknown argument: ${item}`);
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}.`);
    values[key] = next;
    index += 1;
  }
  const base = quick ? QUICK_DEFAULTS : DEFAULTS;
  return {
    ...base,
    executionLayer: values["execution-layer"] || base.executionLayer,
    runId: values["run-id"],
    evidenceDir: values["evidence-dir"],
    sustainedRate: values["sustained-rate"]
      ? parsePositiveInteger(values["sustained-rate"], "sustained-rate")
      : base.sustainedRate,
    sustainedSeconds: values["sustained-seconds"]
      ? parsePositiveInteger(values["sustained-seconds"], "sustained-seconds")
      : base.sustainedSeconds,
    burstRate: values["burst-rate"]
      ? parsePositiveInteger(values["burst-rate"], "burst-rate")
      : base.burstRate,
    burstSeconds: values["burst-seconds"]
      ? parsePositiveInteger(values["burst-seconds"], "burst-seconds")
      : base.burstSeconds,
    concurrentRate: values["concurrent-rate"]
      ? parsePositiveInteger(values["concurrent-rate"], "concurrent-rate")
      : base.concurrentRate,
    concurrentSeconds: values["concurrent-seconds"]
      ? parsePositiveInteger(values["concurrent-seconds"], "concurrent-seconds")
      : base.concurrentSeconds,
    queueCount: values["queue-count"]
      ? parsePositiveInteger(values["queue-count"], "queue-count")
      : base.queueCount,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { summary, evidenceDir } = await runLocalHarness(options);
  process.stdout.write(`${JSON.stringify({
    status: summary.status,
    run_id: summary.run_id,
    evidence_dir: evidenceDir,
    failed_cases: summary.cases.filter((testCase) => testCase.result !== "pass")
      .map((testCase) => ({ id: testCase.id, blocker: testCase.blocker })),
    p95_ms: summary.load_latency.p95_ms,
    missing_events: summary.load_reconciliation.missing_count,
    integrity_check: summary.final_integrity_check,
  })}\n`);
  process.exitCode = summary.status === "pass" ? 0 : 2;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
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
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createMnemuronApp } from "../lib/app.mjs";
import { MnemuronStore } from "../lib/store.mjs";
import {
  MnemuronClient,
  resolveAdapterConfig,
} from "../../adapters/openclaw/dist/client.js";

const SOURCE_FILE = fileURLToPath(import.meta.url);
const SOURCE_DIR = path.dirname(SOURCE_FILE);
const SERVER_ENTRY = path.resolve(SOURCE_DIR, "mnemuron-server.mjs");
const APP_FILE = path.resolve(SOURCE_DIR, "../lib/app.mjs");
const STORE_FILE = path.resolve(SOURCE_DIR, "../lib/store.mjs");
const CLIENT_FILE = path.resolve(SOURCE_DIR, "../../adapters/openclaw/dist/client.js");
const EXECUTION_LAYERS = new Set(["local-isolated", "ct131-isolated"]);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const READY_TIMEOUT_MS = 60_000;
const DRAIN_TIMEOUT_MS = 5 * 60_000;
const RESTORE_TIMEOUT_MS = 30 * 60_000;

const DEFAULTS = {
  executionLayer: "local-isolated",
  restartQueuePerCycle: 20,
  adapterQueueCount: 100,
  partitionQueueCount: 100,
  partitionTimeScale: 1,
};

export const QUICK_DEFAULTS = {
  executionLayer: "local-isolated",
  restartQueuePerCycle: 4,
  adapterQueueCount: 8,
  partitionQueueCount: 6,
  partitionTimeScale: 0.0005,
};

function timestampId(date = new Date()) {
  return date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stage(name, operation) {
  try {
    return await operation();
  } catch (error) {
    throw new Error(`${name}: ${error?.message || String(error)}`, { cause: error });
  }
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

function safeCsv(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeCsv(file, columns, rows) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((column) => safeCsv(row[column])).join(","));
  writePrivate(file, `${lines.join("\n")}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256(readFileSync(file));
}

function modeOf(file) {
  return (statSync(file).mode & 0o777).toString(8).padStart(4, "0");
}

function sizeOf(file) {
  return existsSync(file) ? statSync(file).size : 0;
}

function fileSystemSnapshot(root, label) {
  const stats = statfsSync(root, { bigint: true });
  const total = Number(stats.blocks * stats.bsize);
  const free = Number(stats.bavail * stats.bsize);
  const memory = process.memoryUsage();
  return {
    captured_at: new Date().toISOString(),
    label,
    process_rss_bytes: memory.rss,
    process_heap_used_bytes: memory.heapUsed,
    filesystem_total_bytes: total,
    filesystem_free_bytes: free,
    filesystem_free_percent: Number(((free / total) * 100).toFixed(3)),
  };
}

function testIdentity(executionLayer, runId, suffix = "primary") {
  const location = executionLayer === "ct131-isolated" ? "ct131" : "local";
  return {
    label: `Mnemuron ${location} failure recovery ${suffix}`,
    device_id: `failure-${location}-v01`,
    agent_id: "mnemuron-fault-harness",
    agent_instance_id: `mnemuron-fault-${location}-${suffix}-${runId.slice(-8)}`,
  };
}

function projectFixture() {
  return {
    project_id: "project-mnemuron",
    name: "Mnemuron",
    aliases: ["Failure Recovery"],
    git_remotes: [],
    repo_fingerprints: [],
    path_hints: ["/isolated/mnemuron"],
  };
}

function taskFixture() {
  return {
    task_id: "task-mnemuron-production-readiness-v01",
    project_id: "project-mnemuron",
    project_name: "Mnemuron",
    title: "Mnemuron Production Readiness v0.1",
    aliases: ["Production Readiness", "Failure Recovery"],
    goal: "Validate failure and recovery without setting production_ready.",
    status: "active",
    progress: ["Failure and Recovery Harness is isolated."],
    decisions: ["production_ready remains false."],
    blockers: [],
    next_steps: ["Run separately authorized production fault cases."],
    resources: ["docs/failure-recovery-test-plan-v0.1.md"],
    workstreams: [
      {
        workstream_id: "workstream-failure-recovery",
        name: "Failure and Recovery Harness",
        status: "active",
      },
    ],
    conflicts: [],
  };
}

function seedDatabase(databasePath, executionLayer, runId) {
  const store = new MnemuronStore(databasePath, { defaultRetentionDays: 1 });
  try {
    const admin = store.bootstrapAdmin({ label: "Failure recovery isolated admin" });
    const adminAuth = store.authenticate(admin.api_key);
    store.upsertProject(adminAuth, projectFixture());
    store.upsertTask(adminAuth, taskFixture());
    const primaryIdentity = testIdentity(executionLayer, runId, "primary");
    const unrelatedIdentity = testIdentity(executionLayer, runId, "unrelated");
    const primary = store.registerAgent(adminAuth, primaryIdentity);
    const unrelated = store.registerAgent(adminAuth, unrelatedIdentity);
    return {
      primaryIdentity,
      unrelatedIdentity,
      primaryKey: primary.api_key,
      unrelatedKey: unrelated.api_key,
    };
  } finally {
    store.close();
  }
}

function adapterConfig({ root, baseUrl, keyFile, identity, stateName }) {
  const stateRoot = path.join(root, "adapter-state", stateName);
  return resolveAdapterConfig({
    serverUrl: baseUrl,
    allowInsecureHttp: true,
    apiKeyFile: keyFile,
    outboxDir: path.join(stateRoot, "outbox"),
    pendingResumeDir: path.join(stateRoot, "pending-resume"),
    taskScopeDir: path.join(stateRoot, "task-scopes"),
    injectionEventOutboxDir: path.join(stateRoot, "injection-event-outbox"),
    deviceId: identity.device_id,
    agentId: identity.agent_id,
    agentInstanceId: identity.agent_instance_id,
    projectId: "project-mnemuron",
    taskId: "task-mnemuron-production-readiness-v01",
    workstreamId: "workstream-failure-recovery",
    rawRetentionDays: 1,
    requestTimeoutMs: 5_000,
  });
}

function eventFor(runId, caseId, index, eventType = "tool_result") {
  const session = `failure-recovery-${caseId.toLowerCase()}-${runId}`;
  return {
    event_id: `${runId}-${caseId.toLowerCase()}-${String(index).padStart(6, "0")}`,
    event_type: eventType,
    hook_event_name: "FailureRecoveryHarness",
    captured_at: new Date().toISOString(),
    project_id: "project-mnemuron",
    task_id: "task-mnemuron-production-readiness-v01",
    workstream_id: "workstream-failure-recovery",
    session_id: session,
    turn_id: `${session}-turn-${String(index).padStart(6, "0")}`,
    content: `${caseId} isolated evidence ${index}`,
    capture_capability: {
      source: "failure-recovery-harness-v0.1",
      transcript_parser_used: false,
      isolated: true,
    },
  };
}

function requestJson({ baseUrl, apiKey = null, method = "GET", endpoint, body, timeoutMs = 5_000 }) {
  const target = new URL(endpoint, baseUrl);
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const request = http.request({
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
          data = { invalid_json: raw.slice(0, 200) };
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

async function unusedPort() {
  const server = net.createServer();
  server.unref();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForReady(baseUrl, timeoutMs = READY_TIMEOUT_MS) {
  const started = performance.now();
  let lastError = null;
  while (performance.now() - started < timeoutMs) {
    try {
      const response = await requestJson({ baseUrl, endpoint: "/readyz", timeoutMs: 500 });
      if (response.status === 200 && response.data?.status === "ready") {
        return Number((performance.now() - started).toFixed(3));
      }
      lastError = new Error(`readyz returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(25);
  }
  throw new Error(`isolated service did not become ready: ${lastError?.message || "timeout"}`);
}

function startServer({ databasePath, port }) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      MNEMURON_HOST: "127.0.0.1",
      MNEMURON_PORT: String(port),
      MNEMURON_DATABASE_PATH: databasePath,
      MNEMURON_RAW_RETENTION_DAYS: "1",
      MNEMURON_MAX_BODY_BYTES: String(MAX_BODY_BYTES),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function startReadyServer({ databasePath, port }) {
  const child = startServer({ databasePath, port });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const readyMs = await waitForReady(baseUrl);
    return { child, baseUrl, readyMs };
  } catch (error) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => {});
    throw error;
  }
}

async function stopServer(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return { signal, exit_code: child?.exitCode ?? null, exit_signal: child?.signalCode ?? null };
  }
  const started = performance.now();
  child.kill(signal);
  const [exitCode, exitSignal] = await once(child, "exit");
  return {
    signal,
    exit_code: exitCode,
    exit_signal: exitSignal,
    stop_ms: Number((performance.now() - started).toFixed(3)),
  };
}

function databaseIntegrity(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      quick_check: db.prepare("PRAGMA quick_check").get().quick_check,
      integrity_check: db.prepare("PRAGMA integrity_check").get().integrity_check,
    };
  } finally {
    db.close();
  }
}

function reconcile(databasePath, eventIds) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const storedRows = db.prepare(`
      SELECT event_id, device_id, agent_id, agent_instance_id, project_id,
             task_id, workstream_id, session_id, turn_id
      FROM events WHERE event_id = ?
    `);
    const stored = [];
    const missing = [];
    const duplicate = [];
    for (const eventId of [...eventIds].sort()) {
      const rows = storedRows.all(eventId);
      if (!rows.length) missing.push(eventId);
      if (rows.length > 1) duplicate.push(eventId);
      if (rows.length === 1) stored.push(rows[0]);
    }
    return {
      generated: eventIds.size,
      stored: stored.length,
      missing_count: missing.length,
      duplicate_count: duplicate.length,
      generated_id_sha256: sha256([...eventIds].sort().join("\n")),
      stored_id_sha256: sha256(stored.map((row) => row.event_id).sort().join("\n")),
      provenance_complete: stored.every((row) => [
        row.device_id,
        row.agent_id,
        row.agent_instance_id,
        row.project_id,
        row.task_id,
        row.workstream_id,
        row.session_id,
        row.turn_id,
      ].every(Boolean)),
    };
  } finally {
    db.close();
  }
}

function outboxSnapshot(client) {
  const files = client.outboxFiles();
  return {
    count: files.length,
    directory_mode: modeOf(client.config.outboxDir),
    file_modes: [...new Set(files.map(modeOf))],
    ordered_files: files.map((file) => path.basename(file)),
  };
}

function testCase(id, passed, evidence, blocker = null) {
  return {
    id,
    result: passed ? "pass" : "fail",
    blocker: passed ? null : blocker || `${id.toLowerCase()}_failed`,
    evidence,
  };
}

async function runRestartMatrix({
  databasePath,
  root,
  keyFile,
  identity,
  runId,
  port,
  options,
  timeline,
}) {
  const eventIds = new Set();
  const cycles = [];
  let server = await startReadyServer({ databasePath, port });
  const client = new MnemuronClient(adapterConfig({
    root,
    baseUrl: server.baseUrl,
    keyFile,
    identity,
    stateName: "restart-matrix",
  }));

  for (let cycle = 0; cycle < 5; cycle += 1) {
    const caseLabel = `fr01-cycle${cycle + 1}`;
    const signal = cycle < 3 ? "SIGTERM" : "SIGKILL";
    const preEvent = eventFor(runId, caseLabel, 0);
    eventIds.add(preEvent.event_id);
    const pre = await client.submitEvent(preEvent);
    const faultAt = new Date().toISOString();
    timeline.push({ at: faultAt, case_id: "FR-01", phase: "fault_start", detail: `${cycle + 1}:${signal}` });
    const stopped = await stopServer(server.child, signal);

    const queuedIds = [];
    for (let index = 1; index <= options.restartQueuePerCycle; index += 1) {
      const event = eventFor(runId, caseLabel, index);
      eventIds.add(event.event_id);
      queuedIds.push(event.event_id);
      const queued = await client.submitEvent(event);
      if (queued.delivery !== "queued") throw new Error(`${caseLabel} did not queue while offline`);
    }
    const queued = outboxSnapshot(client);
    const restartStarted = performance.now();
    server = await startReadyServer({ databasePath, port });
    const recoveryMs = performance.now() - restartStarted;
    const drainStarted = performance.now();
    const drained = await client.flushOutbox();
    const drainMs = performance.now() - drainStarted;
    const postEvent = eventFor(runId, caseLabel, options.restartQueuePerCycle + 1);
    eventIds.add(postEvent.event_id);
    const post = await client.submitEvent(postEvent);
    timeline.push({
      at: new Date().toISOString(),
      case_id: "FR-01",
      phase: "recovered",
      detail: `${cycle + 1}:${signal}:queue0`,
    });
    cycles.push({
      cycle: cycle + 1,
      fault_type: cycle < 3 ? "managed_sigterm" : "crash_like_sigkill",
      process_exit: stopped,
      pre_delivery: pre.delivery,
      queued_before_restart: queued.count,
      queued_ids_sha256: sha256(queuedIds.sort().join("\n")),
      queue_directory_mode: queued.directory_mode,
      queue_file_modes: queued.file_modes,
      service_ready_ms: Number(recoveryMs.toFixed(3)),
      drain_ms: Number(drainMs.toFixed(3)),
      drain: drained,
      final_queue: client.outboxFiles().length,
      post_delivery: post.delivery,
    });
  }

  const reconciliation = reconcile(databasePath, eventIds);
  const passed = cycles.length === 5
    && cycles.every((cycle, index) => (
      cycle.pre_delivery === "synchronized"
      && cycle.queued_before_restart === options.restartQueuePerCycle
      && cycle.queue_directory_mode === "0700"
      && cycle.queue_file_modes.length === 1
      && cycle.queue_file_modes[0] === "0600"
      && cycle.service_ready_ms < READY_TIMEOUT_MS
      && cycle.drain_ms < DRAIN_TIMEOUT_MS
      && cycle.drain.flushed === options.restartQueuePerCycle
      && cycle.final_queue === 0
      && cycle.post_delivery === "synchronized"
      && (index < 3
        ? cycle.process_exit.exit_code === 0 && cycle.process_exit.exit_signal === null
        : cycle.process_exit.exit_code === null && cycle.process_exit.exit_signal === "SIGKILL")
    ))
    && reconciliation.missing_count === 0
    && reconciliation.duplicate_count === 0
    && reconciliation.provenance_complete;
  return {
    server,
    eventIds,
    result: testCase("FR-01", passed, {
      profile: "isolated_process_restart_matrix",
      production_systemd_restarted: false,
      cycles,
      reconciliation,
    }, "isolated_restart_matrix_failed"),
  };
}

async function runAdapterRestart({ baseUrl, databasePath, root, keyFile, identity, runId, count }) {
  const config = adapterConfig({
    root,
    baseUrl,
    keyFile,
    identity,
    stateName: "adapter-restart",
  });
  const beforeRestart = new MnemuronClient(config);
  const eventIds = new Set();
  for (let index = 0; index < count; index += 1) {
    const event = eventFor(runId, "fr02", index);
    eventIds.add(event.event_id);
    beforeRestart.queueEnvelope({ event, raw_retention_days: 1 });
  }
  const before = outboxSnapshot(beforeRestart);
  const afterRestart = new MnemuronClient(config);
  const drainStarted = performance.now();
  const drain = await afterRestart.flushOutbox();
  const drainMs = performance.now() - drainStarted;
  const reconciliation = reconcile(databasePath, eventIds);
  const passed = before.count === count
    && before.directory_mode === "0700"
    && before.file_modes.length === 1
    && before.file_modes[0] === "0600"
    && drain.queued_before === count
    && drain.flushed === count
    && afterRestart.outboxFiles().length === 0
    && drainMs < DRAIN_TIMEOUT_MS
    && reconciliation.missing_count === 0
    && reconciliation.duplicate_count === 0;
  return {
    eventIds,
    result: testCase("FR-02", passed, {
      profile: "isolated_adapter_process_recreation",
      real_agent_restart: false,
      queued_before_restart: before,
      drain,
      drain_ms: Number(drainMs.toFixed(3)),
      final_queue: afterRestart.outboxFiles().length,
      reconciliation,
    }, "isolated_adapter_restart_failed"),
  };
}

export function partitionProfiles(timeScale = 1) {
  if (!Number.isFinite(timeScale) || timeScale <= 0 || timeScale > 1) {
    throw new Error("partitionTimeScale must be greater than 0 and at most 1.");
  }
  return [5, 30, 120].map((minutes) => ({
    label: `${minutes}m`,
    target_duration_seconds: minutes * 60,
    observed_hold_ms: Math.max(25, Math.round(minutes * 60_000 * timeScale)),
    accelerated: timeScale !== 1,
    time_scale: timeScale,
  }));
}

async function runPartitions({
  baseUrl,
  databasePath,
  root,
  keyFile,
  identity,
  runId,
  options,
  timeline,
}) {
  const profiles = [];
  const allIds = new Set();
  for (const profile of partitionProfiles(options.partitionTimeScale)) {
    const stateName = `partition-${profile.label}`;
    const offline = new MnemuronClient(adapterConfig({
      root,
      baseUrl: "http://127.0.0.1:1",
      keyFile,
      identity,
      stateName,
    }));
    const eventIds = new Set();
    for (let index = 0; index < options.partitionQueueCount; index += 1) {
      const event = eventFor(runId, `fr03-${profile.label}`, index);
      eventIds.add(event.event_id);
      allIds.add(event.event_id);
      offline.queueEnvelope({ event, raw_retention_days: 1 });
    }
    const queued = outboxSnapshot(offline);
    timeline.push({
      at: new Date().toISOString(),
      case_id: "FR-03",
      phase: "partition_start",
      detail: `${profile.label}:${profile.accelerated ? "accelerated" : "wall-clock"}`,
    });
    const holdStarted = performance.now();
    await sleep(profile.observed_hold_ms);
    const actualHoldMs = performance.now() - holdStarted;
    const restored = new MnemuronClient(adapterConfig({
      root,
      baseUrl,
      keyFile,
      identity,
      stateName,
    }));
    const drainStarted = performance.now();
    const drain = await restored.flushOutbox();
    const drainMs = performance.now() - drainStarted;
    const reconciliation = reconcile(databasePath, eventIds);
    timeline.push({
      at: new Date().toISOString(),
      case_id: "FR-03",
      phase: "partition_recovered",
      detail: `${profile.label}:queue0`,
    });
    profiles.push({
      ...profile,
      actual_hold_ms: Number(actualHoldMs.toFixed(3)),
      queue: {
        count: queued.count,
        directory_mode: queued.directory_mode,
        file_modes: queued.file_modes,
        order_sha256: sha256(queued.ordered_files.join("\n")),
      },
      drain,
      drain_ms: Number(drainMs.toFixed(3)),
      final_queue: restored.outboxFiles().length,
      reconciliation,
    });
  }
  const passed = profiles.every((profile) => (
    profile.queue.count === options.partitionQueueCount
    && profile.queue.directory_mode === "0700"
    && profile.queue.file_modes.length === 1
    && profile.queue.file_modes[0] === "0600"
    && profile.actual_hold_ms >= profile.observed_hold_ms - 5
    && profile.drain.flushed === options.partitionQueueCount
    && profile.drain_ms < DRAIN_TIMEOUT_MS
    && profile.final_queue === 0
    && profile.reconciliation.missing_count === 0
    && profile.reconciliation.duplicate_count === 0
    && profile.reconciliation.generated_id_sha256 === profile.reconciliation.stored_id_sha256
  ));
  return {
    eventIds: allIds,
    result: testCase("FR-03", passed, {
      profile: options.partitionTimeScale === 1
        ? "isolated_wall_clock_transport_denial"
        : "isolated_accelerated_transport_denial",
      real_private_tls_partition: false,
      profiles,
    }, "isolated_partition_queue_recovery_failed"),
  };
}

async function runReceiptIdempotency({
  baseUrl,
  databasePath,
  primaryKey,
  unrelatedKey,
  runId,
}) {
  const checkpointEvents = [
    eventFor(runId, "fr04-checkpoint", 0, "user_message"),
    eventFor(runId, "fr04-checkpoint", 1, "assistant_message"),
  ];
  checkpointEvents[1].hook_event_name = "Stop";
  checkpointEvents[1].content = "Completed isolated duplicate Receipt verification. Next step remains production approval.";
  const appended = await requestJson({
    baseUrl,
    apiKey: primaryKey,
    method: "POST",
    endpoint: "/v1/events",
    body: { events: checkpointEvents, raw_retention_days: 1 },
  });
  const previewResponse = await requestJson({
    baseUrl,
    apiKey: primaryKey,
    method: "POST",
    endpoint: "/v1/resume/preview",
    body: { query: "task-mnemuron-production-readiness-v01" },
  });
  const preview = previewResponse.data;
  const confirmed = await requestJson({
    baseUrl,
    apiKey: primaryKey,
    method: "POST",
    endpoint: `/v1/resume/${preview.resume_id}/confirm`,
    body: { preview_version: preview.preview_version, confirmed: true },
  });

  const receiptId = randomUUID();
  const otherReceiptId = randomUUID();
  const baseReceipt = {
    receipt_event_id: randomUUID(),
    receipt_id: receiptId,
    preview_version: preview.preview_version,
    phase: "delivered",
    session_id: `failure-recovery-fr04-${runId}`,
    turn_id: null,
    workstream_id: "workstream-failure-recovery",
    delivery_method: "failure-recovery-isolated-receipt-v0.1",
    occurred_at: new Date().toISOString(),
  };
  const endpoint = `/v1/resume/${preview.resume_id}/delivery-receipts`;
  const delivered = await requestJson({
    baseUrl, apiKey: primaryKey, method: "POST", endpoint, body: baseReceipt,
  });
  const duplicateDelivered = await requestJson({
    baseUrl,
    apiKey: primaryKey,
    method: "POST",
    endpoint,
    body: { ...baseReceipt, receipt_event_id: randomUUID() },
  });
  const changedSession = await requestJson({
    baseUrl,
    apiKey: primaryKey,
    method: "POST",
    endpoint,
    body: { ...baseReceipt, receipt_event_id: randomUUID(), session_id: `${baseReceipt.session_id}-other` },
  });
  const unrelatedClaim = await requestJson({
    baseUrl,
    apiKey: unrelatedKey,
    method: "POST",
    endpoint,
    body: {
      ...baseReceipt,
      receipt_event_id: randomUUID(),
      phase: "acknowledged",
      turn_id: `${baseReceipt.session_id}-turn`,
    },
  });
  const concurrentDelivery = await requestJson({
    baseUrl,
    apiKey: primaryKey,
    method: "POST",
    endpoint,
    body: { ...baseReceipt, receipt_event_id: randomUUID(), receipt_id: otherReceiptId },
  });
  const ackBeforeDelivery = await requestJson({
    baseUrl,
    apiKey: primaryKey,
    method: "POST",
    endpoint,
    body: {
      ...baseReceipt,
      receipt_event_id: randomUUID(),
      receipt_id: randomUUID(),
      phase: "acknowledged",
      turn_id: `${baseReceipt.session_id}-pre-delivery-turn`,
    },
  });
  const acknowledgement = {
    ...baseReceipt,
    receipt_event_id: randomUUID(),
    phase: "acknowledged",
    turn_id: `${baseReceipt.session_id}-turn`,
    occurred_at: new Date().toISOString(),
  };
  const acknowledged = await requestJson({
    baseUrl, apiKey: primaryKey, method: "POST", endpoint, body: acknowledgement,
  });
  const duplicateAcknowledged = await requestJson({
    baseUrl,
    apiKey: primaryKey,
    method: "POST",
    endpoint,
    body: { ...acknowledgement, receipt_event_id: randomUUID() },
  });
  const deliveryAfterCompletion = await requestJson({
    baseUrl,
    apiKey: primaryKey,
    method: "POST",
    endpoint,
    body: { ...baseReceipt, receipt_event_id: randomUUID(), receipt_id: randomUUID() },
  });
  const receiptStatus = await requestJson({
    baseUrl,
    apiKey: primaryKey,
    endpoint: `/v1/resume/${preview.resume_id}/delivery-receipt-status`,
  });

  const db = new DatabaseSync(databasePath, { readOnly: true });
  let stored;
  try {
    stored = {
      rows_for_receipt: db.prepare(`
        SELECT receipt_event_id, receipt_id, phase, device_id, agent_id,
               agent_instance_id, session_id, turn_id, workstream_id,
               delivery_method, error_code
        FROM resume_delivery_receipts
        WHERE resume_id = ? AND receipt_id = ? ORDER BY occurred_at, received_at
      `).all(preview.resume_id, receiptId),
      all_rows_for_resume: db.prepare(`
        SELECT COUNT(*) AS count FROM resume_delivery_receipts WHERE resume_id = ?
      `).get(preview.resume_id).count,
      checkpoints: db.prepare("SELECT COUNT(*) AS count FROM checkpoints").get().count,
      resolver_selections: db.prepare(`
        SELECT COUNT(*) AS count FROM resolver_selections WHERE resume_id = ?
      `).get(preview.resume_id).count,
    };
  } finally {
    db.close();
  }

  const phases = stored.rows_for_receipt.map((row) => row.phase);
  const passed = appended.status === 202
    && appended.data?.checkpoints?.some((checkpoint) => checkpoint.status === "created")
    && previewResponse.status === 201
    && confirmed.status === 200
    && delivered.status === 202
    && delivered.data?.inserted === 1
    && duplicateDelivered.status === 202
    && duplicateDelivered.data?.duplicate === 1
    && changedSession.status === 409
    && unrelatedClaim.status === 409
    && concurrentDelivery.status === 409
    && ackBeforeDelivery.status === 409
    && acknowledged.status === 202
    && acknowledged.data?.inserted === 1
    && duplicateAcknowledged.status === 202
    && duplicateAcknowledged.data?.duplicate === 1
    && deliveryAfterCompletion.status === 409
    && receiptStatus.status === 200
    && receiptStatus.data?.status === "acknowledged"
    && receiptStatus.data?.ack_complete === true
    && stored.all_rows_for_resume === 2
    && phases.join(",") === "delivered,acknowledged"
    && stored.checkpoints >= 1
    && stored.resolver_selections === 1;

  const safeRows = stored.rows_for_receipt.map((row) => ({
    ...row,
    receipt_event_id: row.receipt_event_id,
  }));
  return {
    eventIds: new Set(checkpointEvents.map((event) => event.event_id)),
    receipts: {
      resume_id: preview.resume_id,
      preview_version: preview.preview_version,
      receipt_id: receiptId,
      status: receiptStatus.data?.status || null,
      ack_complete: receiptStatus.data?.ack_complete || false,
      rows: safeRows,
      response_statuses: {
        delivered: delivered.status,
        duplicate_delivered: duplicateDelivered.status,
        changed_session: changedSession.status,
        unrelated_claim: unrelatedClaim.status,
        concurrent_delivery: concurrentDelivery.status,
        ack_before_delivery: ackBeforeDelivery.status,
        acknowledged: acknowledged.status,
        duplicate_acknowledged: duplicateAcknowledged.status,
        delivery_after_completion: deliveryAfterCompletion.status,
      },
    },
    result: testCase("FR-04", passed, {
      preview_status: previewResponse.status,
      confirm_status: confirmed.status,
      receipt_status: receiptStatus.data?.status || null,
      ack_complete: receiptStatus.data?.ack_complete || false,
      response_statuses: {
        delivered: delivered.status,
        duplicate_delivered: duplicateDelivered.status,
        changed_session: changedSession.status,
        unrelated_claim: unrelatedClaim.status,
        concurrent_delivery: concurrentDelivery.status,
        ack_before_delivery: ackBeforeDelivery.status,
        acknowledged: acknowledged.status,
        duplicate_acknowledged: duplicateAcknowledged.status,
        delivery_after_completion: deliveryAfterCompletion.status,
      },
      stored_phase_rows: phases,
      stored_rows_for_resume: stored.all_rows_for_resume,
      checkpoints: stored.checkpoints,
      resolver_selections: stored.resolver_selections,
    }, "duplicate_receipt_or_session_ownership_failed"),
  };
}

async function runRestore({ databasePath, root, primaryKey, expectedReceipt, runId }) {
  const sourceIntegrity = databaseIntegrity(databasePath);
  const backupFile = path.join(root, `backup-${runId}.sqlite3`);
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    await backup(source, backupFile);
  } finally {
    source.close();
  }
  chmodSync(backupFile, 0o600);
  const backupIntegrity = databaseIntegrity(backupFile);
  const restoreRoot = path.join(root, "restore");
  ensurePrivateDirectory(restoreRoot);
  const restoredDatabase = path.join(restoreRoot, "mnemuron.sqlite3");
  const sourceStatBefore = statSync(databasePath);
  const started = performance.now();
  copyFileSync(backupFile, restoredDatabase);
  chmodSync(restoredDatabase, 0o600);
  const restoredApp = createMnemuronApp({ databasePath: restoredDatabase, defaultRetentionDays: 1 });
  let restoreChecks;
  try {
    const address = await restoredApp.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const livez = await requestJson({ baseUrl, endpoint: "/livez" });
    const readyz = await requestJson({ baseUrl, endpoint: "/readyz" });
    const status = await requestJson({ baseUrl, endpoint: "/v1/status", apiKey: primaryKey });
    const db = restoredApp.store.db;
    const task = db.prepare(`
      SELECT task_id, project_id, status FROM tasks
      WHERE task_id = 'task-mnemuron-production-readiness-v01'
    `).get();
    const receiptRows = db.prepare(`
      SELECT phase, session_id, turn_id, workstream_id, agent_instance_id
      FROM resume_delivery_receipts
      WHERE resume_id = ? AND receipt_id = ? ORDER BY occurred_at, received_at
    `).all(expectedReceipt.resume_id, expectedReceipt.receipt_id);
    const checkpoint = db.prepare(`
      SELECT checkpoint_id, task_id, workstream_id, session_id, device_id,
             agent_id, agent_instance_id FROM checkpoints ORDER BY created_at DESC LIMIT 1
    `).get();
    const provenance = db.prepare(`
      SELECT device_id, agent_id, agent_instance_id, project_id, task_id,
             workstream_id, session_id, turn_id
      FROM events WHERE event_id LIKE ? ORDER BY received_at DESC LIMIT 1
    `).get(`${runId}-%`);
    const resolverSelection = db.prepare(`
      SELECT r.resume_id, r.preview_version, r.task_id, r.project_id,
             c.agent_instance_id AS requested_by_agent_instance_id
      FROM resolver_selections AS r
      JOIN credentials AS c ON c.credential_id = r.credential_id
      WHERE r.resume_id = ?
    `).get(expectedReceipt.resume_id);
    restoreChecks = {
      health: { livez: livez.status, readyz: readyz.status, api_status: status.status },
      identity_status: status.data?.identity?.identity_status || null,
      production_ready: status.data?.production_ready,
      raw_status: status.data?.raw_availability?.status || null,
      task,
      receipt_phases: receiptRows.map((row) => row.phase),
      receipt_session_consistent: receiptRows.every((row) => row.session_id === expectedReceipt.session_id),
      receipt_workstream_consistent: receiptRows.every((row) => (
        row.workstream_id === "workstream-failure-recovery"
      )),
      receipt_ack_turn_present: receiptRows.some((row) => row.phase === "acknowledged" && row.turn_id),
      checkpoint,
      provenance,
      resolver_selection: resolverSelection,
    };
  } finally {
    if (restoredApp.server.listening) await restoredApp.close();
  }
  rmSync(restoreRoot, { recursive: true, force: true });
  const rtoMs = performance.now() - started;
  const sourceStatAfter = statSync(databasePath);
  const sourceUnchanged = sourceStatBefore.size === sourceStatAfter.size
    && sourceStatBefore.mtimeMs === sourceStatAfter.mtimeMs;
  const passed = sourceIntegrity.quick_check === "ok"
    && sourceIntegrity.integrity_check === "ok"
    && backupIntegrity.quick_check === "ok"
    && backupIntegrity.integrity_check === "ok"
    && modeOf(backupFile) === "0600"
    && restoreChecks.health.livez === 200
    && restoreChecks.health.readyz === 200
    && restoreChecks.health.api_status === 200
    && restoreChecks.identity_status === "server_verified"
    && restoreChecks.production_ready === false
    && restoreChecks.raw_status === "accounted"
    && restoreChecks.task?.task_id === "task-mnemuron-production-readiness-v01"
    && restoreChecks.receipt_phases.join(",") === "delivered,acknowledged"
    && restoreChecks.receipt_session_consistent
    && restoreChecks.receipt_workstream_consistent
    && restoreChecks.receipt_ack_turn_present
    && Boolean(restoreChecks.checkpoint?.checkpoint_id)
    && Boolean(restoreChecks.provenance?.agent_instance_id)
    && restoreChecks.resolver_selection?.resume_id === expectedReceipt.resume_id
    && rtoMs < RESTORE_TIMEOUT_MS
    && sourceUnchanged
    && !existsSync(restoreRoot);
  return testCase("FR-05", passed, {
    profile: "isolated_generated_backup_restore",
    timer_rpo_measured: false,
    scheduled_backup_used: false,
    production_database_overwritten: false,
    source_integrity: sourceIntegrity,
    backup: {
      bytes: sizeOf(backupFile),
      mode: modeOf(backupFile),
      quick_check: backupIntegrity.quick_check,
      integrity_check: backupIntegrity.integrity_check,
    },
    rto_ms: Number(rtoMs.toFixed(3)),
    rto_limit_ms: RESTORE_TIMEOUT_MS,
    checks: restoreChecks,
    source_database_stat_unchanged: sourceUnchanged,
    isolated_restore_removed: !existsSync(restoreRoot),
  }, "isolated_restore_validation_failed");
}

function reportMarkdown(summary) {
  const lines = [
    "# Failure and Recovery Harness v0.1",
    "",
    `- Run ID: \`${summary.run_id}\``,
    `- Layer: \`${summary.execution_layer}\``,
    `- Status: **${summary.status}**`,
    `- Started: ${summary.started_at}`,
    `- Finished: ${summary.finished_at}`,
    "- Production contacted: no",
    "- Production service restarted: no",
    "- Temporary production Key created: no",
    "- Hermes host touched: no",
    "- production_ready changed: no",
    "",
    "## Cases",
    "",
    "| Case | Result | Scope note |",
    "| --- | --- | --- |",
  ];
  for (const item of summary.cases) {
    let note = "isolated evidence";
    if (item.id === "FR-03" && summary.parameters.partition_time_scale !== 1) {
      note = "accelerated isolated timing; real 5/30/120-minute run remains open";
    }
    if (item.id === "FR-05") note = "generated backup; scheduled-backup RPO/RTO remains open";
    lines.push(`| ${item.id} | ${item.result} | ${note} |`);
  }
  lines.push(
    "",
    "This run validates only the Harness and disposable isolation layer. It does not pass a private-TLS, production server restart, real Agent restart, wall-clock network-partition, or scheduled-backup RPO/RTO gate.",
    "",
  );
  return lines.join("\n");
}

export async function runFailureRecoveryHarness(input = {}) {
  const options = { ...DEFAULTS, ...input };
  if (!EXECUTION_LAYERS.has(options.executionLayer)) {
    throw new Error("executionLayer must be local-isolated or ct131-isolated.");
  }
  if (![options.restartQueuePerCycle, options.adapterQueueCount, options.partitionQueueCount]
    .every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("queue counts must be positive integers.");
  }
  partitionProfiles(options.partitionTimeScale);
  const startedAt = new Date().toISOString();
  const runId = options.runId || `${options.executionLayer}-${timestampId()}-${randomUUID().slice(0, 8)}`;
  const evidenceDir = path.resolve(options.evidenceDir || path.join(
    process.cwd(),
    "evidence",
    "failure-recovery",
    runId,
  ));
  ensurePrivateDirectory(evidenceDir);

  const root = mkdtempSync(path.join(os.tmpdir(), `mnemuron-failure-${options.executionLayer}-`));
  chmodSync(root, 0o700);
  const databasePath = path.join(root, "mnemuron.sqlite3");
  const timeline = [];
  const resources = [fileSystemSnapshot(root, "start")];
  const allEventIds = new Set();
  const seeded = seedDatabase(databasePath, options.executionLayer, runId);
  const keyFile = path.join(root, "isolated-agent.key");
  writePrivate(keyFile, `${seeded.primaryKey}\n`);
  const port = await unusedPort();
  let activeServer = null;
  let summary = null;

  try {
    const restart = await stage("FR-01 isolated restart matrix", () => runRestartMatrix({
      databasePath,
      root,
      keyFile,
      identity: seeded.primaryIdentity,
      runId,
      port,
      options,
      timeline,
    }));
    activeServer = restart.server;
    restart.eventIds.forEach((eventId) => allEventIds.add(eventId));
    resources.push(fileSystemSnapshot(root, "after-fr01"));

    const adapter = await stage("FR-02 isolated adapter recreation", () => runAdapterRestart({
      baseUrl: activeServer.baseUrl,
      databasePath,
      root,
      keyFile,
      identity: seeded.primaryIdentity,
      runId,
      count: options.adapterQueueCount,
    }));
    adapter.eventIds.forEach((eventId) => allEventIds.add(eventId));
    resources.push(fileSystemSnapshot(root, "after-fr02"));

    const partitions = await stage("FR-03 isolated partition profiles", () => runPartitions({
      baseUrl: activeServer.baseUrl,
      databasePath,
      root,
      keyFile,
      identity: seeded.primaryIdentity,
      runId,
      options,
      timeline,
    }));
    partitions.eventIds.forEach((eventId) => allEventIds.add(eventId));
    resources.push(fileSystemSnapshot(root, "after-fr03"));

    const receipts = await stage("FR-04 isolated Receipt ownership", () => runReceiptIdempotency({
      baseUrl: activeServer.baseUrl,
      databasePath,
      primaryKey: seeded.primaryKey,
      unrelatedKey: seeded.unrelatedKey,
      runId,
    }));
    receipts.eventIds.forEach((eventId) => allEventIds.add(eventId));
    resources.push(fileSystemSnapshot(root, "after-fr04"));

    const finalStop = await stopServer(activeServer.child, "SIGTERM");
    activeServer = null;
    timeline.push({ at: new Date().toISOString(), case_id: "FR-00", phase: "isolated_server_stopped", detail: JSON.stringify(finalStop) });

    const restore = await stage("FR-05 isolated backup restore", () => runRestore({
      databasePath,
      root,
      primaryKey: seeded.primaryKey,
      expectedReceipt: {
        resume_id: receipts.receipts.resume_id,
        receipt_id: receipts.receipts.receipt_id,
        session_id: receipts.receipts.rows[0]?.session_id,
      },
      runId,
    }));
    resources.push(fileSystemSnapshot(root, "after-fr05"));

    const reconciliation = reconcile(databasePath, allEventIds);
    const integrity = databaseIntegrity(databasePath);
    const tempArtifacts = readdirSync(root).filter((name) => (
      name.endsWith(".tmp") || name.endsWith(".tmp-wal")
      || name.endsWith(".tmp-shm") || name.endsWith(".tmp-journal")
    ));
    const fr00Passed = integrity.quick_check === "ok"
      && integrity.integrity_check === "ok"
      && reconciliation.missing_count === 0
      && reconciliation.duplicate_count === 0
      && reconciliation.provenance_complete
      && tempArtifacts.length === 0
      && resources.every((sample) => sample.filesystem_free_percent >= 20);
    const fr00 = testCase("FR-00", fr00Passed, {
      final_integrity: integrity,
      event_reconciliation: reconciliation,
      temporary_artifacts: tempArtifacts,
      minimum_filesystem_free_percent: Math.min(...resources.map((sample) => (
        sample.filesystem_free_percent
      ))),
    }, "isolated_invariant_check_failed");
    const cases = [fr00, restart.result, adapter.result, partitions.result, receipts.result, restore];
    const failedCases = cases.filter((item) => item.result !== "pass");
    const finishedAt = new Date().toISOString();
    summary = {
      schema_version: "mnemuron-failure-recovery-harness-v0.1",
      run_id: runId,
      execution_layer: options.executionLayer,
      status: failedCases.length ? "blocked" : "pass_isolated_only",
      started_at: startedAt,
      finished_at: finishedAt,
      production_contacted: false,
      production_database_written: false,
      production_service_restarted: false,
      temporary_production_key_created: false,
      network_configuration_changed: false,
      ct129_touched: false,
      external_memory_service_changed: false,
      production_ready_changed: false,
      parameters: {
        restart_cycles: 5,
        managed_restart_cycles: 3,
        crash_like_restart_cycles: 2,
        restart_queue_per_cycle: options.restartQueuePerCycle,
        adapter_queue_count: options.adapterQueueCount,
        partition_queue_count: options.partitionQueueCount,
        partition_time_scale: options.partitionTimeScale,
      },
      source_hashes: {
        harness: sha256File(SOURCE_FILE),
        server_entry: sha256File(SERVER_ENTRY),
        app: sha256File(APP_FILE),
        store: sha256File(STORE_FILE),
        openclaw_client: sha256File(CLIENT_FILE),
      },
      cases,
      event_evidence: reconciliation,
      receipt_evidence: receipts.receipts,
      evidence_files: [
        "manifest.json",
        "summary.json",
        "timeline.csv",
        "events.json",
        "receipts.json",
        "resources.csv",
        "backup.json",
        "adjudication.json",
        "adjudication.md",
      ],
      temporary_root_removed_after_run: true,
    };

    writeJson(path.join(evidenceDir, "manifest.json"), {
      schema_version: summary.schema_version,
      run_id: runId,
      generated_at: finishedAt,
      execution_layer: options.executionLayer,
      topology: {
        listener: "127.0.0.1 fixed disposable port",
        database: "temporary SQLite removed after run",
        child_process_restart_matrix: true,
        private_tls: false,
        production_service: false,
      },
      identity: {
        device_id: seeded.primaryIdentity.device_id,
        agent_id: seeded.primaryIdentity.agent_id,
        agent_instance_id: seeded.primaryIdentity.agent_instance_id,
        project_id: "project-mnemuron",
        task_id: "task-mnemuron-production-readiness-v01",
        workstream_id: "workstream-failure-recovery",
      },
      parameters: summary.parameters,
      source_hashes: summary.source_hashes,
      credentials_in_evidence: false,
    });
    writeJson(path.join(evidenceDir, "summary.json"), summary);
    writeCsv(path.join(evidenceDir, "timeline.csv"), ["at", "case_id", "phase", "detail"], timeline);
    writeJson(path.join(evidenceDir, "events.json"), reconciliation);
    writeJson(path.join(evidenceDir, "receipts.json"), receipts.receipts);
    writeJson(path.join(evidenceDir, "backup.json"), restore.evidence);
    writeJson(path.join(evidenceDir, "adjudication.json"), {
      schema_version: summary.schema_version,
      run_id: runId,
      execution_layer: options.executionLayer,
      status: summary.status,
      production_ready: false,
      cases: cases.map(({ id, result, blocker }) => ({ id, result, blocker })),
      scope: {
        production_contacted: false,
        production_database_written: false,
        production_service_restarted: false,
        temporary_production_key_created: false,
        network_configuration_changed: false,
        ct129_touched: false,
        external_memory_service_changed: false,
      },
      open_production_gates: [
        "private_tls_duplicate_receipt_and_session_ownership",
        "wall_clock_network_partitions",
        "production_ct131_restart_matrix",
        "real_adapter_restart_recovery",
        "scheduled_backup_rpo_and_restore_rto",
      ],
    });
    writeCsv(path.join(evidenceDir, "resources.csv"), [
      "captured_at",
      "label",
      "process_rss_bytes",
      "process_heap_used_bytes",
      "filesystem_total_bytes",
      "filesystem_free_bytes",
      "filesystem_free_percent",
    ], resources);
    writePrivate(path.join(evidenceDir, "adjudication.md"), `${reportMarkdown(summary)}\n`);
    return { summary, evidenceDir };
  } finally {
    if (activeServer?.child) {
      await stopServer(activeServer.child, "SIGKILL").catch(() => {});
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
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
    restartQueuePerCycle: values["restart-queue-per-cycle"]
      ? positiveInteger(values["restart-queue-per-cycle"], "restart-queue-per-cycle")
      : base.restartQueuePerCycle,
    adapterQueueCount: values["adapter-queue-count"]
      ? positiveInteger(values["adapter-queue-count"], "adapter-queue-count")
      : base.adapterQueueCount,
    partitionQueueCount: values["partition-queue-count"]
      ? positiveInteger(values["partition-queue-count"], "partition-queue-count")
      : base.partitionQueueCount,
    partitionTimeScale: values["partition-time-scale"]
      ? Number(values["partition-time-scale"])
      : base.partitionTimeScale,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { summary, evidenceDir } = await runFailureRecoveryHarness(options);
  process.stdout.write(`${JSON.stringify({
    status: summary.status,
    run_id: summary.run_id,
    execution_layer: summary.execution_layer,
    evidence_dir: evidenceDir,
    failed_cases: summary.cases.filter((item) => item.result !== "pass")
      .map((item) => ({ id: item.id, blocker: item.blocker })),
  })}\n`);
  process.exitCode = summary.status === "pass_isolated_only" ? 0 : 2;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SOURCE_FILE;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

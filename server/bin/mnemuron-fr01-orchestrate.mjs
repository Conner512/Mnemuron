#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { readRemoteDeploymentConfig } from "./deployment-config.mjs";
import {
  MnemuronClient,
  resolveAdapterConfig,
} from "../../adapters/openclaw/dist/client.js";

const execFile = promisify(execFileCallback);
const deployment = readRemoteDeploymentConfig();
const PVE_HOST = deployment.sshHost;
const CTID = String(deployment.ctid);
const SERVER_URL = deployment.serverUrl;
const CT_SERVER_URL = "http://127.0.0.1:47831";
const CT_ADMIN_KEY = "/root/.mnemuron/credentials/admin.key";
const DATABASE = "/var/lib/mnemuron/mnemuron.sqlite3";
const PROJECT_ID = "project-mnemuron";
const TASK_ID = "task-mnemuron-production-readiness-v01";
const WORKSTREAM_ID = "workstream-failure-recovery";
const EVENT_INTERVAL_MS = 100;
const PRE_FAULT_MS = 2_000;
const POST_RECOVERY_MS = 2_000;
const RECOVERY_TIMEOUT_MS = 60_000;
const DRAIN_TIMEOUT_MS = 5 * 60_000;
const MEMORY_LIMIT_RATIO = 0.70;
const MIN_FREE_RATIO = 0.20;
const CYCLES = [
  { label: "managed-1", kind: "managed" },
  { label: "managed-2", kind: "managed" },
  { label: "managed-3", kind: "managed" },
  { label: "sigkill-1", kind: "sigkill" },
  { label: "sigkill-2", kind: "sigkill" },
];

function timestamp() {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function modeOf(file) {
  return (statSync(file).mode & 0o777).toString(8).padStart(4, "0");
}

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function writePrivate(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function writeJson(file, value) {
  writePrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function execute(file, args, { ignoreFailure = false, maxBuffer = 8 * 1024 * 1024 } = {}) {
  try {
    return await execFile(file, args, { encoding: "utf8", maxBuffer });
  } catch (error) {
    if (ignoreFailure) return { stdout: "", stderr: error.message, failed: true };
    throw error;
  }
}

async function ssh(args, options) {
  return execute("ssh", [PVE_HOST, ...args], options);
}

async function pct(args, options) {
  return ssh(["pct", ...args], options);
}

function parseKeyValues(value) {
  const result = {};
  for (const line of value.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

async function serviceState() {
  const result = await pct([
    "exec", CTID, "--", "systemctl", "show", "mnemuron.service",
    "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", "-p", "NRestarts",
    "-p", "ExecMainStartTimestamp", "-p", "ActiveEnterTimestampMonotonic",
  ]);
  const parsed = parseKeyValues(result.stdout);
  return {
    captured_at: new Date().toISOString(),
    active_state: parsed.ActiveState,
    sub_state: parsed.SubState,
    main_pid: Number(parsed.MainPID),
    n_restarts: Number(parsed.NRestarts),
    exec_main_start_timestamp: parsed.ExecMainStartTimestamp,
    active_enter_timestamp_monotonic: Number(parsed.ActiveEnterTimestampMonotonic),
  };
}

async function healthProbe(label, { allowFailure = false } = {}) {
  const result = { label, captured_at: new Date().toISOString() };
  for (const endpoint of ["/livez", "/readyz"]) {
    const started = performance.now();
    try {
      const response = await fetch(new URL(endpoint, SERVER_URL), {
        signal: AbortSignal.timeout(2_000),
        headers: { accept: "application/json" },
      });
      result[endpoint.slice(1)] = {
        status: response.status,
        latency_ms: Number((performance.now() - started).toFixed(3)),
        error: null,
      };
    } catch (error) {
      result[endpoint.slice(1)] = {
        status: 0,
        latency_ms: Number((performance.now() - started).toFixed(3)),
        error: error?.message || String(error),
      };
    }
  }
  const healthy = result.livez.status === 200 && result.readyz.status === 200;
  if (!healthy && !allowFailure) throw new Error(`${label} private-TLS health is not ready.`);
  return { ...result, healthy };
}

function parseMemoryEvents(value) {
  return Object.fromEntries(value.trim().split("\n").map((line) => {
    const [key, count] = line.trim().split(/\s+/u);
    return [key, Number(count)];
  }));
}

async function resourceSample(pveNode) {
  const [statusResult, eventsResult, dfResult] = await Promise.all([
    ssh(["pvesh", "get", `/nodes/${pveNode}/lxc/${CTID}/status/current`, "--output-format", "json"]),
    ssh(["cat", `/sys/fs/cgroup/lxc/${CTID}/memory.events`]),
    pct(["exec", CTID, "--", "df", "-B1", "--output=size,used,avail,pcent", "/var/lib/mnemuron"]),
  ]);
  const status = JSON.parse(statusResult.stdout);
  const fields = dfResult.stdout.trim().split("\n").at(-1).trim().split(/\s+/u);
  const filesystem = {
    bytes_total: Number(fields[0]),
    bytes_used: Number(fields[1]),
    bytes_available: Number(fields[2]),
    free_ratio: Number(fields[2]) / Number(fields[0]),
  };
  return {
    captured_at: new Date().toISOString(),
    pve: {
      vmid: Number(status.vmid),
      type: status.type,
      status: status.status,
      pid: Number(status.pid),
      mem: Number(status.mem),
      maxmem: Number(status.maxmem),
      memory_ratio: Number(status.mem) / Number(status.maxmem),
      swap: Number(status.swap),
      maxswap: Number(status.maxswap),
      pressurememorysome: status.pressurememorysome,
      pressurememoryfull: status.pressurememoryfull,
      pressureiosome: status.pressureiosome,
      pressureiofull: status.pressureiofull,
    },
    memory_events: parseMemoryEvents(eventsResult.stdout),
    filesystem,
  };
}

function sampleViolations(sample, baselineEvents) {
  const violations = [];
  if (sample.pve.vmid !== Number(CTID) || sample.pve.type !== "lxc" || sample.pve.status !== "running") {
    violations.push("pve_authoritative_scope_invalid");
  }
  if (sample.pve.memory_ratio >= MEMORY_LIMIT_RATIO) violations.push("memory_at_or_above_70_percent");
  for (const key of ["max", "oom", "oom_kill", "oom_group_kill"]) {
    if (sample.memory_events[key] !== baselineEvents[key]) violations.push(`memory_event_${key}_increased`);
  }
  if (sample.filesystem.free_ratio <= MIN_FREE_RATIO) violations.push("filesystem_free_at_or_below_20_percent");
  return violations;
}

function clientConfig({ keyFile, stateRoot, agentInstanceId }) {
  return resolveAdapterConfig({
    serverUrl: SERVER_URL,
    allowInsecureHttp: false,
    apiKeyFile: keyFile,
    outboxDir: path.join(stateRoot, "outbox"),
    pendingResumeDir: path.join(stateRoot, "pending-resume"),
    taskScopeDir: path.join(stateRoot, "task-scopes"),
    injectionEventOutboxDir: path.join(stateRoot, "injection-event-outbox"),
    deviceId: "failure-recovery-v01",
    agentId: "mnemuron-fr01",
    agentInstanceId,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    workstreamId: WORKSTREAM_ID,
    rawRetentionDays: 30,
    requestTimeoutMs: 2_000,
  });
}

function eventFor(runId, cycleLabel, index) {
  const sequence = String(index).padStart(6, "0");
  const sessionId = `failure-recovery-fr01-${cycleLabel}-${runId}`;
  return {
    schema_version: "0.1.0",
    event_id: `${runId}-fr01-${cycleLabel}-${sequence}`,
    event_type: "tool_result",
    hook_event_name: "FailureRecovery:FR-01",
    captured_at: new Date().toISOString(),
    project_id: PROJECT_ID,
    task_id: TASK_ID,
    workstream_id: WORKSTREAM_ID,
    session_id: sessionId,
    turn_id: `${sessionId}-turn-${sequence}`,
    content: `FR-01 ${cycleLabel} durable restart evidence ${sequence}`,
    capture_capability: {
      source: "failure-recovery-fr01-private-tls-v0.1",
      transcript_parser_used: false,
      disposable_fault_client: true,
      durable_before_transmit: true,
    },
  };
}

async function waitForRecovery(previousPid, label) {
  const started = performance.now();
  const observations = [];
  while (performance.now() - started < RECOVERY_TIMEOUT_MS) {
    const [service, health] = await Promise.all([
      serviceState(),
      healthProbe(`${label}-recovery`, { allowFailure: true }),
    ]);
    observations.push({ service, health });
    if (service.active_state === "active"
        && service.sub_state === "running"
        && service.main_pid > 0
        && service.main_pid !== previousPid
        && health.healthy) {
      return {
        recovered: true,
        recovery_ms: Math.round(performance.now() - started),
        service,
        health,
        observations,
      };
    }
    await sleep(250);
  }
  return {
    recovered: false,
    recovery_ms: Math.round(performance.now() - started),
    service: await serviceState(),
    health: await healthProbe(`${label}-timeout`, { allowFailure: true }),
    observations,
  };
}

async function performFault(cycle, before) {
  const invokedAt = new Date().toISOString();
  if (cycle.kind === "managed") {
    await pct(["exec", CTID, "--", "systemctl", "restart", "mnemuron.service"]);
  } else {
    await pct(["exec", CTID, "--", "kill", "-KILL", String(before.main_pid)]);
  }
  return { kind: cycle.kind, invoked_at: invokedAt, action_count: 1, target_pid: before.main_pid };
}

async function runCycle({ runId, cycle, keyFile, stateRoot, agentInstanceId, pveNode, baselineEvents }) {
  const cycleRoot = path.join(stateRoot, cycle.label);
  const client = new MnemuronClient(clientConfig({ keyFile, stateRoot: cycleRoot, agentInstanceId }));
  if (client.outboxFiles().length !== 0) throw new Error(`${cycle.label} did not start with an empty outbox.`);
  const outboxMode = modeOf(client.config.outboxDir);
  if (outboxMode !== "0700") throw new Error(`${cycle.label} outbox directory is not mode 0700.`);

  const before = await serviceState();
  const beforeHealth = await healthProbe(`${cycle.label}-before`);
  if (before.active_state !== "active" || before.sub_state !== "running" || before.main_pid <= 0) {
    throw new Error(`${cycle.label} service baseline is not active/running.`);
  }

  const generatedIds = [];
  const transientErrors = [];
  const resourceSamples = [];
  const resourceViolations = [];
  let stopProducer = false;
  let producerDone = false;
  let stopDrainer = false;
  let stopSampler = false;
  let peakQueue = 0;
  let durableFileModeOk = true;
  const cycleStartedMs = performance.now();
  const cycleStartedAt = new Date().toISOString();

  const producer = (async () => {
    let index = 0;
    while (!stopProducer && resourceViolations.length === 0) {
      const target = cycleStartedMs + index * EVENT_INTERVAL_MS;
      const remaining = target - performance.now();
      if (remaining > 0) await sleep(remaining);
      if (stopProducer || resourceViolations.length > 0) break;
      const event = eventFor(runId, cycle.label, index);
      const file = client.queueEnvelope({ event, raw_retention_days: 30 });
      if (modeOf(file) !== "0600") durableFileModeOk = false;
      generatedIds.push(event.event_id);
      peakQueue = Math.max(peakQueue, client.outboxFiles().length);
      index += 1;
    }
    producerDone = true;
  })();

  const drainer = (async () => {
    const drainDeadline = Date.now() + PRE_FAULT_MS + RECOVERY_TIMEOUT_MS + POST_RECOVERY_MS + DRAIN_TIMEOUT_MS;
    while (!stopDrainer
        && (!producerDone || client.outboxFiles().length > 0)
        && Date.now() < drainDeadline) {
      try {
        await client.flushOutbox();
      } catch (error) {
        transientErrors.push({ at: new Date().toISOString(), error: error?.message || String(error) });
      }
      peakQueue = Math.max(peakQueue, client.outboxFiles().length);
      await sleep(50);
    }
  })();

  const sampler = (async () => {
    while (!stopSampler) {
      try {
        const sample = await resourceSample(pveNode);
        resourceSamples.push(sample);
        for (const violation of sampleViolations(sample, baselineEvents)) {
          if (!resourceViolations.includes(violation)) resourceViolations.push(violation);
        }
      } catch (error) {
        if (!resourceViolations.includes("resource_probe_failed")) {
          resourceViolations.push("resource_probe_failed");
          resourceSamples.push({ captured_at: new Date().toISOString(), error: error?.message || String(error) });
        }
      }
      if (!stopSampler) await sleep(750);
    }
  })();

  let fault;
  let recovery;
  let producerCompletedMs;
  try {
    await sleep(PRE_FAULT_MS);
    if (resourceViolations.length) throw new Error(`${cycle.label} resource stop condition triggered before fault.`);
    fault = await performFault(cycle, before);
    recovery = await waitForRecovery(before.main_pid, cycle.label);
    if (!recovery.recovered) throw new Error(`${cycle.label} did not recover within 60 seconds.`);
    await sleep(POST_RECOVERY_MS);
  } finally {
    stopProducer = true;
    await producer;
    producerCompletedMs = performance.now();
    if (!recovery?.recovered) stopDrainer = true;
    await drainer;
    stopSampler = true;
    await sampler;
  }

  while (client.outboxFiles().length > 0 && performance.now() - producerCompletedMs < DRAIN_TIMEOUT_MS) {
    try {
      await client.flushOutbox();
    } catch (error) {
      transientErrors.push({ at: new Date().toISOString(), error: error?.message || String(error) });
      await sleep(250);
    }
  }
  const drainMs = Math.round(performance.now() - producerCompletedMs);
  const finalQueue = client.outboxFiles().length;
  const quarantineFiles = client.outboxQuarantineFiles().length;
  const after = await serviceState();
  const afterHealth = await healthProbe(`${cycle.label}-after`);
  const expectedRestartDelta = cycle.kind === "sigkill" ? 1 : 0;
  const restartDelta = after.n_restarts - before.n_restarts;
  const stablePid = after.main_pid === recovery.service.main_pid;
  const sortedIds = [...generatedIds].sort();
  const durationMs = Math.round(performance.now() - cycleStartedMs);
  const result = {
    label: cycle.label,
    kind: cycle.kind,
    started_at: cycleStartedAt,
    completed_at: new Date().toISOString(),
    duration_ms: durationMs,
    generated: generatedIds.length,
    scheduled_generation_rate_per_second: 10,
    cycle_average_events_per_second: Number((generatedIds.length / (durationMs / 1000)).toFixed(3)),
    generated_id_sha256: sha256(sortedIds.join("\n")),
    outbox_directory_mode: outboxMode,
    durable_file_mode_ok: durableFileModeOk,
    peak_queue: peakQueue,
    final_queue: finalQueue,
    quarantine_files: quarantineFiles,
    final_drain_ms: drainMs,
    transient_error_count: transientErrors.length,
    transient_errors: transientErrors,
    before_service: before,
    fault,
    recovery,
    after_service: after,
    before_health: beforeHealth,
    after_health: afterHealth,
    restart_delta: restartDelta,
    expected_restart_delta: expectedRestartDelta,
    stable_recovered_pid: stablePid,
    resource_samples: resourceSamples,
    resource_violations: resourceViolations,
  };
  result.local_invariants_passed = generatedIds.length >= 30
    && outboxMode === "0700"
    && durableFileModeOk
    && finalQueue === 0
    && quarantineFiles === 0
    && drainMs < DRAIN_TIMEOUT_MS
    && recovery.recovered
    && recovery.recovery_ms < RECOVERY_TIMEOUT_MS
    && fault.action_count === 1
    && before.main_pid !== after.main_pid
    && restartDelta === expectedRestartDelta
    && stablePid
    && afterHealth.healthy
    && resourceViolations.length === 0;
  return result;
}

function helperArgs(command, remote, instance, extra = []) {
  return [
    "exec", CTID, "--", "/opt/mnemuron/node/bin/node", remote.ctKeyHelper,
    command,
    "--server-url", CT_SERVER_URL,
    "--admin-key-file", CT_ADMIN_KEY,
    "--instance", instance,
    "--key-file", remote.ctKey,
    "--metadata-file", remote.ctMetadata,
    ...extra,
  ];
}

async function reconcile(remote, runId, instance) {
  return reconcileDatabase(remote, DATABASE, runId, instance);
}

async function reconcileDatabase(remote, databasePath, runId, instance) {
  const result = await pct([
    "exec", CTID, "--", "/opt/mnemuron/node/bin/node", remote.ctReconcile,
    databasePath, runId, instance,
  ]);
  return JSON.parse(result.stdout);
}

async function removeKnownArtifacts(remote) {
  for (const file of [
    remote.ctKey,
    remote.ctMetadata,
    remote.ctKeyHelper,
    remote.ctReconcile,
    remote.ctBackupHelper,
  ]) {
    await pct(["exec", CTID, "--", "unlink", file], { ignoreFailure: true });
  }
  await pct(["exec", CTID, "--", "rmdir", remote.ctDir], { ignoreFailure: true });
  for (const file of [
    remote.pveKey,
    remote.pveKeyHelper,
    remote.pveReconcile,
    remote.pveBackupHelper,
  ]) {
    await ssh(["unlink", file], { ignoreFailure: true });
  }
  await ssh(["rmdir", remote.pveDir], { ignoreFailure: true });
}

async function main() {
  const runId = `fr01-private-tls-${timestamp()}`;
  const evidenceDir = path.resolve("evidence", "failure-recovery", runId);
  ensurePrivateDirectory(evidenceDir);
  const localDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-fr01-"));
  chmodSync(localDir, 0o700);
  const stateRoot = path.join(localDir, "state");
  const localKey = path.join(localDir, "fr01.key");
  const keyHelper = path.resolve("server/bin/mnemuron-temporary-agent-key.mjs");
  const reconcileHelper = path.resolve("server/bin/mnemuron-fr01-reconcile.mjs");
  const backupHelper = path.resolve("server/bin/mnemuron-fr01-online-backup.mjs");
  const orchestratorFile = new URL(import.meta.url).pathname;
  const instance = `mnemuron-fr01-${runId}`;
  const remote = {
    pveDir: `/tmp/${runId}`,
    pveKey: `/tmp/${runId}/fr01.key`,
    pveKeyHelper: `/tmp/${runId}/temporary-agent-key.mjs`,
    pveReconcile: `/tmp/${runId}/fr01-reconcile.mjs`,
    pveBackupHelper: `/tmp/${runId}/fr01-online-backup.mjs`,
    ctDir: `/run/${runId}`,
    ctKey: `/run/${runId}/fr01.key`,
    ctMetadata: `/run/${runId}/fr01.metadata.json`,
    ctKeyHelper: `/run/${runId}/temporary-agent-key.mjs`,
    ctReconcile: `/run/${runId}/fr01-reconcile.mjs`,
    ctBackupHelper: `/run/${runId}/fr01-online-backup.mjs`,
  };
  const lifecycle = {
    run_id: runId,
    instance,
    created: null,
    revoked: null,
    local_key_files_removed: false,
    remote_key_files_removed: false,
    api_key_recorded: false,
  };
  let created = false;
  let revoked = false;
  let pveNode;
  let baselineService;
  let baselineResource;
  let preReconcile;
  let backupResult;
  const cycleResults = [];
  try {
    process.stdout.write(`${JSON.stringify({ phase: "preflight_started", run_id: runId })}\n`);
    pveNode = (await ssh(["hostname"])).stdout.trim();
    baselineService = await serviceState();
    baselineResource = await resourceSample(pveNode);
    const baselineHealth = await healthProbe("preflight");
    const baselineViolations = sampleViolations(baselineResource, baselineResource.memory_events);
    if (baselineService.active_state !== "active"
        || baselineService.sub_state !== "running"
        || !baselineHealth.healthy
        || baselineViolations.length > 0) {
      throw new Error(`FR-01 baseline failed: ${baselineViolations.join(",") || "service_or_health"}.`);
    }

    await ssh(["install", "-d", "-m", "700", remote.pveDir]);
    await pct(["exec", CTID, "--", "install", "-d", "-m", "700", remote.ctDir]);
    await execute("scp", ["-q", keyHelper, `${PVE_HOST}:${remote.pveKeyHelper}`]);
    await execute("scp", ["-q", reconcileHelper, `${PVE_HOST}:${remote.pveReconcile}`]);
    await execute("scp", ["-q", backupHelper, `${PVE_HOST}:${remote.pveBackupHelper}`]);
    await pct(["push", CTID, remote.pveKeyHelper, remote.ctKeyHelper]);
    await pct(["push", CTID, remote.pveReconcile, remote.ctReconcile]);
    await pct(["push", CTID, remote.pveBackupHelper, remote.ctBackupHelper]);
    await pct([
      "exec", CTID, "--", "chmod", "700",
      remote.ctKeyHelper, remote.ctReconcile, remote.ctBackupHelper,
    ]);

    preReconcile = await reconcile(remote, runId, instance);
    if (preReconcile.target_events.count !== 0
        || preReconcile.quick_check !== "ok"
        || preReconcile.integrity_check !== "ok"
        || preReconcile.global.raw.unexplained !== 0) {
      throw new Error("FR-01 database preflight or run-prefix isolation failed.");
    }

    const databaseStat = await pct(["exec", CTID, "--", "stat", "-c", "%s:%a", DATABASE]);
    const [databaseBytes, databaseMode] = databaseStat.stdout.trim().split(":");
    const projectedFreeRatio = (
      baselineResource.filesystem.bytes_available - Number(databaseBytes)
    ) / baselineResource.filesystem.bytes_total;
    if (databaseMode !== "600" || projectedFreeRatio <= MIN_FREE_RATIO) {
      throw new Error("FR-01 local pre-run backup would cross the 20% filesystem stop line.");
    }
    const backupTarget = `/var/lib/mnemuron/backups/scheduled/mnemuron-${runId}-pre-run.sqlite3`;
    const backupCommand = await pct([
      "exec", CTID, "--", "/opt/mnemuron/node/bin/node", remote.ctBackupHelper,
      DATABASE, backupTarget,
    ]);
    const generatedBackup = JSON.parse(backupCommand.stdout);
    const backupVerification = await reconcileDatabase(
      remote,
      backupTarget,
      "fr01-backup-verification",
      instance,
    );
    const backupSuffixes = ["-wal", "-shm", "-journal", ".tmp", ".tmp-wal", ".tmp-shm", ".tmp-journal"];
    for (const suffix of backupSuffixes) {
      await pct(["exec", CTID, "--", "unlink", `${backupTarget}${suffix}`], { ignoreFailure: true });
    }
    const remainingBackupArtifacts = [];
    for (const suffix of backupSuffixes) {
      const probe = await pct(["exec", CTID, "--", "test", "-e", `${backupTarget}${suffix}`], {
        ignoreFailure: true,
      });
      if (!probe.failed) remainingBackupArtifacts.push(`${backupTarget}${suffix}`);
    }
    backupResult = {
      target: backupTarget,
      bytes: generatedBackup.bytes,
      mode: generatedBackup.mode,
      sha256: generatedBackup.sha256,
      quick_check: backupVerification.quick_check,
      integrity_check: backupVerification.integrity_check,
      pages_backed_up: generatedBackup.pages_backed_up,
      temporary_artifacts_remaining: remainingBackupArtifacts,
    };
    const postBackupResource = await resourceSample(pveNode);
    if (backupResult.quick_check !== "ok"
        || backupResult.integrity_check !== "ok"
        || backupResult.mode !== "0600"
        || backupResult.temporary_artifacts_remaining.length !== 0
        || postBackupResource.filesystem.free_ratio <= MIN_FREE_RATIO) {
      throw new Error("FR-01 pre-run NAS backup or post-backup storage verification failed.");
    }
    process.stdout.write(`${JSON.stringify({
      phase: "backup_verified",
      target: backupTarget,
      bytes: backupResult.bytes,
      sha256: backupResult.sha256,
      server_free_percent: Number((postBackupResource.filesystem.free_ratio * 100).toFixed(4)),
    })}\n`);

    const expiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const createResult = await pct(helperArgs("create", remote, instance, [
      "--device", "failure-recovery-v01",
      "--agent", "mnemuron-fr01",
      "--label", "fr01-private-tls-restart-matrix",
      "--expires-at", expiresAt,
      "--scopes", "capture:write",
    ]));
    lifecycle.created = JSON.parse(createResult.stdout);
    created = true;
    await pct(["pull", CTID, remote.ctKey, remote.pveKey]);
    await ssh(["chmod", "600", remote.pveKey]);
    await execute("scp", ["-q", `${PVE_HOST}:${remote.pveKey}`, localKey]);
    chmodSync(localKey, 0o600);

    for (const cycle of CYCLES) {
      process.stdout.write(`${JSON.stringify({ phase: "cycle_started", cycle: cycle.label, kind: cycle.kind })}\n`);
      const result = await runCycle({
        runId,
        cycle,
        keyFile: localKey,
        stateRoot,
        agentInstanceId: instance,
        pveNode,
        baselineEvents: baselineResource.memory_events,
      });
      const reconciled = await reconcile(remote, runId, instance);
      const target = reconciled.cycles[cycle.label];
      const receiptUnchanged = JSON.stringify(reconciled.global.receipts) === JSON.stringify(preReconcile.global.receipts);
      const injectionUnchanged = JSON.stringify(reconciled.global.injections) === JSON.stringify(preReconcile.global.injections);
      result.reconciliation = reconciled;
      result.server_invariants_passed = target.count === result.generated
        && target.id_sha256 === result.generated_id_sha256
        && target.raw_available === result.generated
        && target.unique_turn_ids === result.generated
        && JSON.stringify(target.distinct_credential_ids) === JSON.stringify([lifecycle.created.credential_id])
        && JSON.stringify(target.distinct_device_ids) === JSON.stringify(["failure-recovery-v01"])
        && JSON.stringify(target.distinct_agent_ids) === JSON.stringify(["mnemuron-fr01"])
        && JSON.stringify(target.distinct_agent_instance_ids) === JSON.stringify([instance])
        && JSON.stringify(target.distinct_project_ids) === JSON.stringify([PROJECT_ID])
        && JSON.stringify(target.distinct_task_ids) === JSON.stringify([TASK_ID])
        && JSON.stringify(target.distinct_workstream_ids) === JSON.stringify([WORKSTREAM_ID])
        && JSON.stringify(target.distinct_session_ids) === JSON.stringify([`failure-recovery-fr01-${cycle.label}-${runId}`])
        && reconciled.quick_check === "ok"
        && reconciled.integrity_check === "ok"
        && reconciled.global.raw.unexplained === 0
        && receiptUnchanged
        && injectionUnchanged;
      writeJson(path.join(evidenceDir, `${cycle.label}.json`), result);
      if (!result.local_invariants_passed || !result.server_invariants_passed) {
        throw new Error(`${cycle.label} acceptance invariants failed.`);
      }
      cycleResults.push(result);
      process.stdout.write(`${JSON.stringify({
        phase: "cycle_passed",
        cycle: cycle.label,
        generated: result.generated,
        recovery_ms: result.recovery.recovery_ms,
        peak_queue: result.peak_queue,
        restart_delta: result.restart_delta,
      })}\n`);
    }

    const revokeResult = await pct(helperArgs("revoke", remote, instance));
    lifecycle.revoked = JSON.parse(revokeResult.stdout);
    revoked = true;
    const finalReconcile = await reconcile(remote, runId, instance);
    const finalService = await serviceState();
    const finalHealth = await healthProbe("postflight");
    const finalResource = await resourceSample(pveNode);
    const totalGenerated = cycleResults.reduce((sum, cycle) => sum + cycle.generated, 0);
    const allIdsHash = sha256(cycleResults.flatMap((cycle) => {
      const count = cycle.generated;
      return Array.from({ length: count }, (_, index) =>
        `${runId}-fr01-${cycle.label}-${String(index).padStart(6, "0")}`);
    }).sort().join("\n"));
    const finalPassed = cycleResults.length === 5
      && cycleResults.every((cycle) => cycle.local_invariants_passed && cycle.server_invariants_passed)
      && finalReconcile.target_events.count === totalGenerated
      && finalReconcile.target_events.id_sha256 === allIdsHash
      && finalReconcile.target_events.raw_available === totalGenerated
      && finalReconcile.target_events.unique_turn_ids === totalGenerated
      && finalReconcile.quick_check === "ok"
      && finalReconcile.integrity_check === "ok"
      && finalReconcile.global.raw.unexplained === 0
      && JSON.stringify(finalReconcile.global.receipts) === JSON.stringify(preReconcile.global.receipts)
      && JSON.stringify(finalReconcile.global.injections) === JSON.stringify(preReconcile.global.injections)
      && Boolean(finalReconcile.credential?.revoked_at)
      && JSON.stringify(finalReconcile.credential?.scopes) === JSON.stringify(["capture:write"])
      && finalService.active_state === "active"
      && finalService.sub_state === "running"
      && finalService.n_restarts - baselineService.n_restarts === 2
      && finalHealth.healthy
      && sampleViolations(finalResource, baselineResource.memory_events).length === 0;

    const summary = {
      run_id: runId,
      case_id: "FR-01",
      profile: "three_managed_restart_plus_two_sigkill_private_tls",
      result: finalPassed ? "pass" : "fail",
      cycles_passed: cycleResults.length,
      managed_cycles: cycleResults.filter((cycle) => cycle.kind === "managed").length,
      sigkill_cycles: cycleResults.filter((cycle) => cycle.kind === "sigkill").length,
      total_generated: totalGenerated,
      total_stored: finalReconcile.target_events.count,
      missing: totalGenerated - finalReconcile.target_events.count,
      duplicates: 0,
      raw_status: finalReconcile.global.raw.unexplained === 0 ? "accounted" : "degraded",
      unexplained_raw_unavailable: finalReconcile.global.raw.unexplained,
      false_receipt_or_ack_created:
        JSON.stringify(finalReconcile.global.receipts) !== JSON.stringify(preReconcile.global.receipts)
        || JSON.stringify(finalReconcile.global.injections) !== JSON.stringify(preReconcile.global.injections),
      baseline_pid: baselineService.main_pid,
      final_pid: finalService.main_pid,
      baseline_n_restarts: baselineService.n_restarts,
      final_n_restarts: finalService.n_restarts,
      max_recovery_ms: Math.max(...cycleResults.map((cycle) => cycle.recovery.recovery_ms)),
      max_memory_percent: Number((Math.max(...cycleResults.flatMap((cycle) =>
        cycle.resource_samples.filter((sample) => sample.pve).map((sample) => sample.pve.memory_ratio))) * 100).toFixed(4)),
      min_filesystem_free_percent: Number((Math.min(...cycleResults.flatMap((cycle) =>
        cycle.resource_samples.filter((sample) => sample.filesystem).map((sample) => sample.filesystem.free_ratio))) * 100).toFixed(4)),
      credential_revoked: Boolean(finalReconcile.credential?.revoked_at),
      production_ready: false,
    };
    writeJson(path.join(evidenceDir, "backup.json"), backupResult);
    writeJson(path.join(evidenceDir, "baseline.json"), {
      service: baselineService,
      resource: baselineResource,
      reconciliation: preReconcile,
    });
    writeJson(path.join(evidenceDir, "postflight.json"), {
      service: finalService,
      health: finalHealth,
      resource: finalResource,
      reconciliation: finalReconcile,
    });
    writeJson(path.join(evidenceDir, "manifest.json"), {
      run_id: runId,
      case_id: "FR-01",
      server_origin: SERVER_URL,
      pve_host: PVE_HOST,
      ct_id: Number(CTID),
      pre_run_backup: backupResult.target,
      pre_run_backup_sha256: backupResult.sha256,
      pre_run_backup_storage: "container-local-scheduled",
      orchestrator_sha256: sha256File(orchestratorFile),
      reconcile_helper_sha256: sha256File(reconcileHelper),
      backup_helper_sha256: sha256File(backupHelper),
      temporary_key_helper_sha256: sha256File(keyHelper),
      temporary_credential_scope: ["capture:write"],
      key_material_recorded: false,
      raw_payload_recorded: false,
      deliberate_faults: ["systemctl-restart", "systemctl-restart", "systemctl-restart", "sigkill", "sigkill"],
      other_adapters_action_performed: false,
      network_dns_caddy_firewall_change_performed: false,
      production_ready_promoted: false,
    });
    writeJson(path.join(evidenceDir, "summary.json"), summary);
    if (!finalPassed) throw new Error("FR-01 final acceptance invariants failed.");

    process.stdout.write(`${JSON.stringify({
      status: "pass",
      run_id: runId,
      evidence_dir: evidenceDir,
      total_generated: totalGenerated,
      backup: backupResult.target,
      final_pid: finalService.main_pid,
      final_n_restarts: finalService.n_restarts,
    })}\n`);
  } finally {
    if (created && !revoked) {
      const result = await pct(helperArgs("revoke", remote, instance), { ignoreFailure: true });
      if (!result.failed && result.stdout) lifecycle.revoked = JSON.parse(result.stdout);
    }
    const state = await serviceState().catch(() => null);
    if (state && (state.active_state !== "active" || state.sub_state !== "running")) {
      lifecycle.emergency_service_start = await pct(
        ["exec", CTID, "--", "systemctl", "start", "mnemuron.service"],
        { ignoreFailure: true },
      ).then((result) => ({ attempted: true, failed: Boolean(result.failed) }));
    }
    await removeKnownArtifacts(remote);
    rmSync(localDir, { recursive: true, force: true });
    lifecycle.local_key_files_removed = true;
    lifecycle.remote_key_files_removed = true;
    if (existsSync(evidenceDir)) writeJson(path.join(evidenceDir, "credential-lifecycle.json"), lifecycle);
  }
}

await main();

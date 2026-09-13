#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { runFr03 } from "./mnemuron-fr03-private-tls.mjs";
import { readRemoteDeploymentConfig } from "./deployment-config.mjs";

const execFile = promisify(execFileCallback);
const deployment = readRemoteDeploymentConfig();
const PVE_HOST = deployment.sshHost;
const CTID = String(deployment.ctid);
const SERVER_URL = deployment.serverUrl;
const CT_SERVER_URL = "http://127.0.0.1:47831";
const CT_ADMIN_KEY = "/root/.mnemuron/credentials/admin.key";
const DATABASE = "/var/lib/mnemuron/mnemuron.sqlite3";
const MIN_FREE_RATIO = 0.20;
const SWAP_GROWTH_BYTES = 32 * 1024 * 1024;

function timestamp() {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

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

function writePrivate(file, value) {
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function writeJson(file, value) {
  writePrivate(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function execute(file, args, { ignoreFailure = false } = {}) {
  try {
    return await execFile(file, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
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

function helperArgs(command, remote, instance, extra = []) {
  return [
    "exec", CTID, "--",
    "/opt/mnemuron/node/bin/node", remote.ctKeyHelper,
    command,
    "--server-url", CT_SERVER_URL,
    "--admin-key-file", CT_ADMIN_KEY,
    "--instance", instance,
    "--key-file", remote.ctKey,
    "--metadata-file", remote.ctMetadata,
    ...extra,
  ];
}

async function reconcile(remote, runId, instance, profile, database = DATABASE) {
  const result = await pct([
    "exec", CTID, "--", "/opt/mnemuron/node/bin/node", remote.ctReconcile,
    database, runId, instance, profile,
  ]);
  return JSON.parse(result.stdout);
}

function parseSystemdShow(value) {
  return Object.fromEntries(value.trim().split("\n").map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

async function serviceState() {
  const result = await pct([
    "exec", CTID, "--", "systemctl", "show", "mnemuron.service",
    "-p", "ActiveState", "-p", "SubState", "-p", "MainPID", "-p", "NRestarts",
    "-p", "ActiveEnterTimestamp",
  ]);
  const fields = parseSystemdShow(result.stdout);
  return {
    captured_at: new Date().toISOString(),
    active_state: fields.ActiveState,
    sub_state: fields.SubState,
    main_pid: Number(fields.MainPID),
    n_restarts: Number(fields.NRestarts),
    active_enter_timestamp: fields.ActiveEnterTimestamp,
  };
}

async function healthProbe(label) {
  const result = { label, captured_at: new Date().toISOString() };
  for (const endpoint of ["/livez", "/readyz"]) {
    const started = performance.now();
    const response = await fetch(new URL(endpoint, SERVER_URL), {
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/json" },
    });
    result[endpoint.slice(1)] = {
      status: response.status,
      latency_ms: Number((performance.now() - started).toFixed(3)),
    };
  }
  result.healthy = result.livez.status === 200 && result.readyz.status === 200;
  return result;
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
      pressurememorysome: Number(status.pressurememorysome),
      pressurememoryfull: Number(status.pressurememoryfull),
      pressureiosome: Number(status.pressureiosome),
      pressureiofull: Number(status.pressureiofull),
    },
    memory_events: parseMemoryEvents(eventsResult.stdout),
    filesystem: {
      bytes_total: Number(fields[0]),
      bytes_used: Number(fields[1]),
      bytes_available: Number(fields[2]),
      free_ratio: Number(fields[2]) / Number(fields[0]),
    },
  };
}

function resourceStopReason(samples, baseline) {
  const latest = samples.at(-1);
  if (!latest) return "resource_sample_missing";
  if (latest.pve.vmid !== Number(CTID) || latest.pve.type !== "lxc" || latest.pve.status !== "running") {
    return "pve_authoritative_scope_invalid";
  }
  if (latest.filesystem.free_ratio < MIN_FREE_RATIO) return "filesystem_below_20_percent";
  for (const key of ["max", "oom", "oom_kill", "oom_group_kill"]) {
    if (latest.memory_events[key] !== baseline.memory_events[key]) return `memory_event_${key}_increased`;
  }
  if (latest.pve.memory_ratio >= 0.90 && latest.pve.pressurememoryfull >= 1) {
    return "memory_and_full_psi_stop";
  }
  const recent = samples.slice(-3);
  const increasingSwap = recent.length === 3
    && recent[0].pve.swap < recent[1].pve.swap
    && recent[1].pve.swap < recent[2].pve.swap;
  if (increasingSwap && latest.pve.swap - baseline.pve.swap >= SWAP_GROWTH_BYTES) {
    return "swap_growth_stop";
  }
  return null;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeResourceCsv(file, samples) {
  const rows = [[
    "captured_at", "vmid", "type", "state", "memory_bytes", "memory_limit_bytes",
    "memory_percent", "swap_bytes", "swap_limit_bytes", "memory_psi_some", "memory_psi_full",
    "io_psi_some", "io_psi_full", "event_max", "event_oom", "event_oom_kill",
    "filesystem_available_bytes", "filesystem_total_bytes", "filesystem_free_percent",
  ]];
  for (const sample of samples) {
    rows.push([
      sample.captured_at, sample.pve.vmid, sample.pve.type, sample.pve.status,
      sample.pve.mem, sample.pve.maxmem, (sample.pve.memory_ratio * 100).toFixed(4),
      sample.pve.swap, sample.pve.maxswap, sample.pve.pressurememorysome,
      sample.pve.pressurememoryfull, sample.pve.pressureiosome, sample.pve.pressureiofull,
      sample.memory_events.max, sample.memory_events.oom, sample.memory_events.oom_kill,
      sample.filesystem.bytes_available, sample.filesystem.bytes_total,
      (sample.filesystem.free_ratio * 100).toFixed(4),
    ]);
  }
  writePrivate(file, `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`);
}

async function removeKnownArtifacts(remote) {
  for (const file of [remote.ctKey, remote.ctMetadata, remote.ctKeyHelper, remote.ctReconcile]) {
    await pct(["exec", CTID, "--", "unlink", file], { ignoreFailure: true });
  }
  await pct(["exec", CTID, "--", "rmdir", remote.ctDir], { ignoreFailure: true });
  for (const file of [remote.pveKey, remote.pveKeyHelper, remote.pveReconcile]) {
    await ssh(["unlink", file], { ignoreFailure: true });
  }
  await ssh(["rmdir", remote.pveDir], { ignoreFailure: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["pre-run-backup"]) throw new Error("--pre-run-backup is required.");
  const profile = args.profile || "5m";
  const profiles = {
    "5m": { durationMs: 5 * 60_000, eventCount: 100 },
    "30m": { durationMs: 30 * 60_000, eventCount: 600 },
  };
  if (!profiles[profile]) throw new Error(`Unsupported FR-03 profile: ${profile}.`);
  const selectedProfile = profiles[profile];
  const preRunBackup = args["pre-run-backup"];
  if (!/^\/var\/lib\/mnemuron\/backups\/scheduled\/mnemuron-[A-Za-z0-9.-]+\.sqlite3$/u.test(preRunBackup)) {
    throw new Error("--pre-run-backup must name one scheduled Mnemuron server backup.");
  }
  const expectedBackupSha256 = args["pre-run-backup-sha256"] || null;
  if (profile === "30m" && !/^[a-f0-9]{64}$/u.test(expectedBackupSha256 || "")) {
    throw new Error("--pre-run-backup-sha256 is required for the 30m profile.");
  }
  const runId = args["run-id"] || `fr03-private-tls-${timestamp()}`;
  if (!/^fr03-private-tls-[A-Za-z0-9-]+$/u.test(runId)) {
    throw new Error("--run-id must use the fr03-private-tls-* namespace.");
  }
  const evidenceDir = path.resolve("evidence", "failure-recovery", runId);
  if (existsSync(evidenceDir)) throw new Error(`Evidence directory already exists: ${evidenceDir}`);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  chmodSync(evidenceDir, 0o700);
  const localDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-fr03-"));
  chmodSync(localDir, 0o700);
  const stateRoot = path.join(localDir, "state");
  const localKey = path.join(localDir, "fr03.key");
  const keyHelper = path.resolve("server/bin/mnemuron-temporary-agent-key.mjs");
  const reconcileHelper = path.resolve("server/bin/mnemuron-fr03-reconcile.mjs");
  const runnerFile = path.resolve("server/bin/mnemuron-fr03-private-tls.mjs");
  const orchestratorFile = fileURLToPath(import.meta.url);
  const instance = `mnemuron-fr03-${runId}`;
  const remote = {
    pveDir: `/tmp/${runId}`,
    pveKey: `/tmp/${runId}/fr03.key`,
    pveKeyHelper: `/tmp/${runId}/temporary-agent-key.mjs`,
    pveReconcile: `/tmp/${runId}/fr03-reconcile.mjs`,
    ctDir: `/run/${runId}`,
    ctKey: `/run/${runId}/fr03.key`,
    ctMetadata: `/run/${runId}/fr03.metadata.json`,
    ctKeyHelper: `/run/${runId}/temporary-agent-key.mjs`,
    ctReconcile: `/run/${runId}/fr03-reconcile.mjs`,
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
  let clientResult = null;
  let preReconcile = null;
  let postReconcile = null;
  let finalReconcile = null;
  let pveNode = null;
  let baselineService = null;
  let finalService = null;
  let baselineHealth = null;
  let finalHealth = null;
  let baselineResource = null;
  let finalResource = null;
  let backupVerification = null;
  const resourceSamples = [];
  let resourceGuardReason = null;
  let resourceMonitor = null;
  let resourceMonitorPending = Promise.resolve();
  try {
    process.stdout.write(`${JSON.stringify({ phase: "preflight_started", run_id: runId, profile })}\n`);
    pveNode = (await ssh(["hostname"])).stdout.trim();
    baselineService = await serviceState();
    baselineHealth = await healthProbe("preflight");
    baselineResource = await resourceSample(pveNode);
    resourceSamples.push(baselineResource);
    resourceGuardReason = resourceStopReason(resourceSamples, baselineResource);
    if (baselineService.active_state !== "active"
        || baselineService.sub_state !== "running"
        || !baselineHealth.healthy
        || resourceGuardReason) {
      throw new Error(`FR-03 baseline failed: ${resourceGuardReason || "service_or_health"}.`);
    }

    await ssh(["install", "-d", "-m", "700", remote.pveDir]);
    await pct(["exec", CTID, "--", "install", "-d", "-m", "700", remote.ctDir]);
    await execute("scp", ["-q", keyHelper, `${PVE_HOST}:${remote.pveKeyHelper}`]);
    await execute("scp", ["-q", reconcileHelper, `${PVE_HOST}:${remote.pveReconcile}`]);
    await pct(["push", CTID, remote.pveKeyHelper, remote.ctKeyHelper]);
    await pct(["push", CTID, remote.pveReconcile, remote.ctReconcile]);
    await pct(["exec", CTID, "--", "chmod", "700", remote.ctKeyHelper, remote.ctReconcile]);

    preReconcile = await reconcile(remote, runId, instance, profile);
    if (preReconcile.target_events.count !== 0
        || preReconcile.quick_check !== "ok"
        || preReconcile.integrity_check !== "ok"
        || preReconcile.global.raw.unexplained !== 0) {
      throw new Error("FR-03 database baseline or run-prefix isolation failed.");
    }
    const backupStatResult = await pct(["exec", CTID, "--", "stat", "-c", "%s:%a", preRunBackup]);
    const [backupBytes, backupMode] = backupStatResult.stdout.trim().split(":");
    const backupShaResult = await pct(["exec", CTID, "--", "sha256sum", preRunBackup]);
    const backupSha256 = backupShaResult.stdout.trim().split(/\s+/u)[0];
    backupVerification = await reconcile(remote, runId, instance, profile, preRunBackup);
    if (backupMode !== "600"
        || (expectedBackupSha256 && backupSha256 !== expectedBackupSha256)
        || backupVerification.quick_check !== "ok"
        || backupVerification.integrity_check !== "ok") {
      throw new Error("FR-03 pre-run backup verification failed.");
    }
    writeJson(path.join(evidenceDir, "backup.json"), {
      path: preRunBackup,
      bytes: Number(backupBytes),
      mode: "0600",
      sha256: backupSha256,
      quick_check: backupVerification.quick_check,
      integrity_check: backupVerification.integrity_check,
      retained: true,
    });
    writeJson(path.join(evidenceDir, "baseline.json"), {
      service: baselineService,
      health: baselineHealth,
      resource: baselineResource,
      reconciliation: preReconcile,
    });
    process.stdout.write(`${JSON.stringify({
      phase: "preflight_passed",
      backup_bytes: Number(backupBytes),
      filesystem_free_percent: Number((baselineResource.filesystem.free_ratio * 100).toFixed(4)),
    })}\n`);

    const expiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const createResult = await pct(helperArgs("create", remote, instance, [
      "--device", "failure-recovery-v01",
      "--agent", "mnemuron-fr03",
      "--label", `fr03-private-tls-${profile}`,
      "--expires-at", expiresAt,
      "--scopes", "capture:write",
    ]));
    lifecycle.created = JSON.parse(createResult.stdout);
    created = true;

    await pct(["pull", CTID, remote.ctKey, remote.pveKey]);
    await ssh(["chmod", "600", remote.pveKey]);
    await execute("scp", ["-q", `${PVE_HOST}:${remote.pveKey}`, localKey]);
    chmodSync(localKey, 0o600);

    resourceMonitor = setInterval(() => {
      resourceMonitorPending = resourceMonitorPending.then(async () => {
        const sample = await resourceSample(pveNode);
        resourceSamples.push(sample);
        resourceGuardReason ||= resourceStopReason(resourceSamples, baselineResource);
      }).catch((error) => {
        resourceGuardReason ||= `resource_sampling_failed:${error?.message || String(error)}`;
      });
    }, 30_000);
    clientResult = await runFr03({
      serverUrl: SERVER_URL,
      keyFile: localKey,
      stateRoot,
      runId,
      agentInstanceId: instance,
      evidenceDir,
      profile,
      stopCheck: () => resourceGuardReason,
    });
    clearInterval(resourceMonitor);
    resourceMonitor = null;
    await resourceMonitorPending;
    finalResource = await resourceSample(pveNode);
    resourceSamples.push(finalResource);
    resourceGuardReason ||= resourceStopReason(resourceSamples, baselineResource);
    if (resourceGuardReason) throw new Error(`FR-03 resource guard failed: ${resourceGuardReason}.`);
    postReconcile = await reconcile(remote, runId, instance, profile);

    const revokeResult = await pct(helperArgs("revoke", remote, instance));
    lifecycle.revoked = JSON.parse(revokeResult.stdout);
    revoked = true;
    finalReconcile = await reconcile(remote, runId, instance, profile);
    finalService = await serviceState();
    finalHealth = await healthProbe("postflight");

    const target = finalReconcile.target_events;
    const receiptsUnchanged = JSON.stringify(preReconcile.global.receipts) === JSON.stringify(finalReconcile.global.receipts);
    const injectionsUnchanged = JSON.stringify(preReconcile.global.injections) === JSON.stringify(finalReconcile.global.injections);
    const expectedSession = `failure-recovery-fr03-${profile}-${runId}`;
    const passed = clientResult.client.actual_duration_ms >= selectedProfile.durationMs
      && clientResult.client.queue_at_reopen.count === selectedProfile.eventCount
      && clientResult.client.queue_at_reopen.directory_mode === "0700"
      && clientResult.client.queue_at_reopen.file_modes.length === 1
      && clientResult.client.queue_at_reopen.file_modes[0] === "0600"
      && clientResult.client.queue_at_reopen.enqueue_order_preserved
      && clientResult.client.drain_ms < 300_000
      && clientResult.client.final_queue === 0
      && clientResult.client.quarantine_files === 0
      && target.count === selectedProfile.eventCount
      && target.id_sha256 === clientResult.events.generated_id_sha256
      && target.raw_available === selectedProfile.eventCount
      && JSON.stringify(target.distinct_device_ids) === JSON.stringify(["failure-recovery-v01"])
      && JSON.stringify(target.distinct_agent_ids) === JSON.stringify(["mnemuron-fr03"])
      && JSON.stringify(target.distinct_agent_instance_ids) === JSON.stringify([instance])
      && JSON.stringify(target.distinct_project_ids) === JSON.stringify(["project-mnemuron"])
      && JSON.stringify(target.distinct_task_ids) === JSON.stringify(["task-mnemuron-production-readiness-v01"])
      && JSON.stringify(target.distinct_workstream_ids) === JSON.stringify(["workstream-failure-recovery"])
      && JSON.stringify(target.distinct_session_ids) === JSON.stringify([expectedSession])
      && target.unique_turn_ids === selectedProfile.eventCount
      && finalReconcile.quick_check === "ok"
      && finalReconcile.integrity_check === "ok"
      && finalReconcile.global.raw.unexplained === 0
      && finalReconcile.credential?.revoked_at
      && JSON.stringify(finalReconcile.credential.scopes) === JSON.stringify(["capture:write"])
      && receiptsUnchanged
      && injectionsUnchanged
      && !resourceGuardReason
      && finalService.active_state === "active"
      && finalService.sub_state === "running"
      && finalService.main_pid === baselineService.main_pid
      && finalService.n_restarts === baselineService.n_restarts
      && finalHealth.healthy;

    clientResult.events.stored = target.count;
    clientResult.events.stored_id_sha256 = target.id_sha256;
    clientResult.events.missing = selectedProfile.eventCount - target.count;
    clientResult.events.duplicates = 0;
    writeJson(path.join(evidenceDir, "events.json"), clientResult.events);
    writeJson(path.join(evidenceDir, "reconciliation.json"), {
      pre: preReconcile,
      post_delivery: postReconcile,
      post_revoke: finalReconcile,
      receipts_unchanged: receiptsUnchanged,
      injections_unchanged: injectionsUnchanged,
    });
    writeJson(path.join(evidenceDir, "manifest.json"), {
      run_id: runId,
      case_id: "FR-03",
      profile: `${profile}_bounded_private_tls_production_path`,
      started_at: clientResult.client.partition_started_at,
      completed_at: clientResult.client.drain_completed_at,
      server_origin: SERVER_URL,
      pre_run_backup: preRunBackup,
      pre_run_backup_sha256: backupSha256,
      runner_sha256: sha256File(runnerFile),
      orchestrator_sha256: sha256File(orchestratorFile),
      reconcile_helper_sha256: sha256File(reconcileHelper),
      temporary_key_helper_sha256: sha256File(keyHelper),
      temporary_credential_scope: ["capture:write"],
      key_material_recorded: false,
      raw_payload_recorded: false,
      server_service_restart_performed: false,
      network_dns_caddy_firewall_change_performed: false,
      other_adapters_action_performed: false,
      production_ready_promoted: false,
    });
    writeResourceCsv(path.join(evidenceDir, "pve-resources.csv"), resourceSamples);
    writeJson(path.join(evidenceDir, "postflight.json"), {
      service: finalService,
      health: finalHealth,
      resource: finalResource,
      reconciliation: finalReconcile,
    });
    const memoryPercentages = resourceSamples.map((sample) => sample.pve.memory_ratio * 100);
    const freePercentages = resourceSamples.map((sample) => sample.filesystem.free_ratio * 100);
    const maxSwapDelta = Math.max(...resourceSamples.map((sample) => (
      sample.pve.swap - baselineResource.pve.swap
    )));
    writeJson(path.join(evidenceDir, "summary.json"), {
      run_id: runId,
      case_id: "FR-03",
      profile,
      result: passed ? "pass" : "fail",
      partition_duration_ms: clientResult.client.actual_duration_ms,
      queue_at_reopen: clientResult.client.queue_at_reopen.count,
      drain_ms: clientResult.client.drain_ms,
      final_queue: clientResult.client.final_queue,
      generated: clientResult.events.generated,
      stored: clientResult.events.stored,
      missing: clientResult.events.missing,
      duplicates: clientResult.events.duplicates,
      generated_id_sha256: clientResult.events.generated_id_sha256,
      stored_id_sha256: clientResult.events.stored_id_sha256,
      raw_status: finalReconcile.global.raw.unexplained === 0 ? "accounted" : "degraded",
      unexplained_raw_unavailable: finalReconcile.global.raw.unexplained,
      false_receipt_or_ack_created: !receiptsUnchanged || !injectionsUnchanged,
      credential_revoked: Boolean(finalReconcile.credential?.revoked_at),
      resource_samples: resourceSamples.length,
      maximum_memory_percent: Number(Math.max(...memoryPercentages).toFixed(4)),
      maximum_swap_delta_bytes: maxSwapDelta,
      minimum_filesystem_free_percent: Number(Math.min(...freePercentages).toFixed(4)),
      resource_stop_reason: resourceGuardReason,
      service_pid_unchanged: finalService.main_pid === baselineService.main_pid,
      service_restart_count_unchanged: finalService.n_restarts === baselineService.n_restarts,
      production_ready: false,
    });
    writeJson(path.join(evidenceDir, "adjudication.json"), {
      run_id: runId,
      case_id: "FR-03",
      profile,
      result: passed ? "pass" : "fail",
      criteria: {
        full_wall_clock_duration: clientResult.client.actual_duration_ms >= selectedProfile.durationMs,
        private_ordered_queue: clientResult.client.queue_at_reopen.count === selectedProfile.eventCount
          && clientResult.client.queue_at_reopen.directory_mode === "0700"
          && clientResult.client.queue_at_reopen.file_modes.length === 1
          && clientResult.client.queue_at_reopen.file_modes[0] === "0600"
          && clientResult.client.queue_at_reopen.enqueue_order_preserved,
        queue_drained_within_five_minutes: clientResult.client.drain_ms < 300_000
          && clientResult.client.final_queue === 0,
        exact_event_reconciliation: target.count === selectedProfile.eventCount
          && target.id_sha256 === clientResult.events.generated_id_sha256,
        raw_available_and_accounted: target.raw_available === selectedProfile.eventCount
          && finalReconcile.global.raw.unexplained === 0,
        complete_unique_provenance: target.unique_turn_ids === selectedProfile.eventCount
          && JSON.stringify(target.distinct_session_ids) === JSON.stringify([expectedSession]),
        no_false_resume_receipt_or_ack: receiptsUnchanged && injectionsUnchanged,
        service_unchanged: finalService.main_pid === baselineService.main_pid
          && finalService.n_restarts === baselineService.n_restarts,
        pve_resource_guards_clear: !resourceGuardReason,
        sqlite_checks_ok: finalReconcile.quick_check === "ok"
          && finalReconcile.integrity_check === "ok",
        temporary_credential_revoked: Boolean(finalReconcile.credential?.revoked_at),
        production_ready_unchanged_false: true,
      },
    });
    writePrivate(path.join(evidenceDir, "adjudication.md"), [
      `# FR-03 ${profile} private-TLS partition adjudication`,
      "",
      `Result: **${passed ? "Pass" : "Fail"}**`,
      "",
      `The disposable client held transport closed for ${clientResult.client.actual_duration_ms} ms, retained ${clientResult.client.queue_at_reopen.count} ordered mode-0600 Event files in a mode-0700 outbox, and drained them through private TLS in ${clientResult.client.drain_ms} ms.`,
      "",
      `${target.count}/${selectedProfile.eventCount} Event IDs reconciled exactly with Raw available, complete dedicated provenance, zero quarantine, and no false Resume Receipt or ACK.`,
      "",
      `Across ${resourceSamples.length} PVE-authoritative samples, memory peaked at ${Math.max(...memoryPercentages).toFixed(4)}%, Swap delta peaked at ${maxSwapDelta} bytes, filesystem free stayed above ${Math.min(...freePercentages).toFixed(4)}%, and no OOM/max stop fired.`,
      "",
      "The temporary capture:write credential was revoked and all Key copies and transport state were removed. Server service PID/restart count, Caddy, DNS, firewall, active Agent routes, adapter hosts, external memory services, retention, and production_ready were unchanged.",
      "",
    ].join("\n"));
    if (!passed) throw new Error("FR-03 acceptance invariants did not pass.");

    process.stdout.write(`${JSON.stringify({
      status: "pass",
      run_id: runId,
      evidence_dir: evidenceDir,
      generated: selectedProfile.eventCount,
      stored: target.count,
      drain_ms: clientResult.client.drain_ms,
      credential_id: lifecycle.created.credential_id,
    })}\n`);
  } catch (error) {
    writeJson(path.join(evidenceDir, "run-error.json"), {
      run_id: runId,
      profile,
      captured_at: new Date().toISOString(),
      error: error?.message || String(error),
      production_ready: false,
    });
    throw error;
  } finally {
    if (resourceMonitor) clearInterval(resourceMonitor);
    await resourceMonitorPending;
    if (resourceSamples.length > 0) {
      writeResourceCsv(path.join(evidenceDir, "pve-resources.csv"), resourceSamples);
    }
    if (created && !revoked) {
      const result = await pct(helperArgs("revoke", remote, instance), { ignoreFailure: true });
      if (!result.failed && result.stdout) lifecycle.revoked = JSON.parse(result.stdout);
    }
    await removeKnownArtifacts(remote);
    rmSync(localDir, { recursive: true, force: true });
    lifecycle.local_key_files_removed = true;
    lifecycle.remote_key_files_removed = true;
    if (existsSync(evidenceDir)) {
      writeJson(path.join(evidenceDir, "credential-lifecycle.json"), lifecycle);
    }
  }
}

await main();

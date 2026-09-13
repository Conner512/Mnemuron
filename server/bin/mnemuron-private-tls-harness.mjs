#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readRemoteDeploymentConfig } from "./deployment-config.mjs";
import {
  HISTORICAL_BODY_BYTES,
  latencySummary,
  makeSizedEnvelope,
  NEAR_LIMIT_BODY_BYTES,
  OVER_LIMIT_BODY_BYTES,
} from "./mnemuron-capacity-harness.mjs";
import {
  MnemuronClient,
  resolveAdapterConfig,
} from "../../adapters/openclaw/dist/client.js";

const execFile = promisify(execFileCallback);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MEMORY_STOP_BYTES = 751_619_276;
export const SWAP_STOP_DELTA_BYTES = 32 * 1024 * 1024;
export const SWAP_STOP_GROWTH_SAMPLES = 3;
export const CONTAINER_MEMORY_STOP_RATIO = 0.9;
export const MEMORY_PRESSURE_FULL_AVG10_STOP = 1;
const BACKUP_TIMEOUT_MS = 5 * 60_000;
const BACKUP_RATE_PAGES = 8_192;
const BACKUP_REMOTE_CLEANUP_GRACE_MS = 15_000;
export const SQLITE_TEMP_SUFFIXES = Object.freeze(["", "-wal", "-shm", "-journal"]);
const DEFAULTS = {
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
  backupMode: "once",
  backupTimeoutMs: BACKUP_TIMEOUT_MS,
  backupRatePages: BACKUP_RATE_PAGES,
};
const QUICK_DEFAULTS = {
  sustainedRate: 5,
  sustainedSeconds: 1,
  burstRate: 20,
  burstSeconds: 1,
  concurrentRate: 5,
  concurrentSeconds: 1,
  queueCount: 40,
  queueInterruptCount: 20,
  queueInterruptAfter: 5,
  sampleIntervalMs: 500,
  backupMode: "skip",
  backupTimeoutMs: BACKUP_TIMEOUT_MS,
  backupRatePages: BACKUP_RATE_PAGES,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export function removeSqliteTemporaryArtifacts(base) {
  for (const suffix of SQLITE_TEMP_SUFFIXES) {
    const file = `${base}${suffix}`;
    if (existsSync(file)) unlinkSync(file);
  }
}

function modeOf(file) {
  return (statSync(file).mode & 0o777).toString(8).padStart(4, "0");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  return sha256(readFileSync(file));
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[Math.max(0, index)];
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

function identityFor(runId, phase, index) {
  const phaseId = phase.toLowerCase().replaceAll("-", "");
  return {
    eventId: `${runId}-${phaseId}-${String(index).padStart(6, "0")}`,
    runId,
    sessionId: `capacity-v02-${runId}-${phaseId}`,
    captureSource: "capacity-harness-bounded-private-tls-v0.2",
  };
}

function eventFor(runId, phase, index, content = "queued") {
  const identity = identityFor(runId, phase, index);
  return {
    event_id: identity.eventId,
    event_type: "tool_result",
    hook_event_name: "CapacityHarness",
    captured_at: new Date().toISOString(),
    project_id: "project-mnemuron",
    task_id: "task-mnemuron-production-readiness-v01",
    workstream_id: "workstream-capacity",
    session_id: identity.sessionId,
    turn_id: `${runId}-turn`,
    content,
    capture_capability: {
      user_messages: true,
      assistant_messages: true,
      tool_events: true,
      session_lifecycle: true,
      transcript_parser_used: false,
      source: identity.captureSource,
    },
  };
}

function loadPayloadBytes(index) {
  const bucket = index % 20;
  if (bucket === 0) return 128 * 1024;
  if (bucket <= 3) return 16 * 1024;
  return 2 * 1024;
}

function requestJson({ baseUrl, apiKey, method, endpoint, body, agent, timeoutMs = 60_000 }) {
  const target = new URL(endpoint, baseUrl);
  const payload = body === undefined
    ? null
    : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const transport = target.protocol === "https:" ? https : http;
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const request = transport.request({
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
          latency_ms: Number((performance.now() - started).toFixed(3)),
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

function caseResult(id, passed, evidence, blocker = null) {
  return { id, result: passed ? "pass" : "fail", blocker, evidence };
}

function caseNotRun(id, evidence) {
  return { id, result: "not_run", blocker: null, evidence };
}

function value(record, field, fallback = 0) {
  const candidate = Number(record?.[field]);
  return Number.isFinite(candidate) ? candidate : fallback;
}

export function createResourceGuard({
  memoryStopBytes = MEMORY_STOP_BYTES,
  swapStopDeltaBytes = SWAP_STOP_DELTA_BYTES,
  swapStopGrowthSamples = SWAP_STOP_GROWTH_SAMPLES,
  containerMemoryStopRatio = CONTAINER_MEMORY_STOP_RATIO,
  memoryPressureFullAvg10Stop = MEMORY_PRESSURE_FULL_AVG10_STOP,
} = {}) {
  let baseline = null;
  let previousSwap = null;
  let swapGrowthSamples = 0;
  let stopReason = null;
  const warnings = new Set();

  const eventDelta = (record, scope, field) => (
    value(record, `${scope}_memory_events_${field}`)
      - value(baseline, `${scope}_memory_events_${field}`)
  );

  return {
    evaluate(record) {
      baseline ||= record;
      const currentSwap = value(record, "container_swap_current_bytes", value(record, "swap_used_bytes"));
      const baselineSwap = value(
        baseline,
        "container_swap_current_bytes",
        value(baseline, "swap_used_bytes"),
      );
      const swapDeltaBytes = Math.max(0, currentSwap - baselineSwap);
      if (swapDeltaBytes > 0) warnings.add("swap_increase_observed");
      if (previousSwap !== null && currentSwap > previousSwap) swapGrowthSamples += 1;
      else swapGrowthSamples = 0;
      previousSwap = currentSwap;

      const memoryMax = value(record, "container_memory_max_bytes");
      const memoryCurrent = value(record, "container_memory_current_bytes");
      const memoryRatio = memoryMax > 0 ? memoryCurrent / memoryMax : null;
      const pressureFullAvg10 = value(record, "container_memory_pressure_full_avg10");

      if (!stopReason && value(record, "production_memory_bytes") >= memoryStopBytes) {
        stopReason = "production_memory_stop_threshold";
      }
      if (!stopReason && value(record, "filesystem_free_percent", 100) < 20) {
        stopReason = "filesystem_stop_threshold";
      }
      if (!stopReason && (
        record.production_pid !== baseline.production_pid
          || record.production_restarts !== baseline.production_restarts
      )) {
        stopReason = "production_service_restarted";
      }
      if (!stopReason && record.production_active !== "active") {
        stopReason = "production_service_unavailable";
      }

      for (const scope of ["container", "production"]) {
        if (!stopReason && (eventDelta(record, scope, "oom") > 0
          || eventDelta(record, scope, "oom_kill") > 0)) {
          stopReason = `${scope}_oom_event`;
        }
        if (!stopReason && eventDelta(record, scope, "max") > 0) {
          stopReason = `${scope}_memory_max_event`;
        }
        if (eventDelta(record, scope, "high") > 0) {
          warnings.add(`${scope}_memory_high_event`);
        }
      }

      if (!stopReason && memoryRatio !== null
        && memoryRatio >= containerMemoryStopRatio
        && pressureFullAvg10 >= memoryPressureFullAvg10Stop) {
        stopReason = "container_memory_pressure_threshold";
      }
      if (!stopReason && swapGrowthSamples >= swapStopGrowthSamples
        && swapDeltaBytes >= swapStopDeltaBytes) {
        stopReason = "material_swap_growth_three_samples";
      }

      return {
        stop_reason: stopReason,
        warnings: [...warnings],
        swap_delta_bytes: swapDeltaBytes,
        swap_growth_samples: swapGrowthSamples,
        container_memory_ratio: memoryRatio === null
          ? null
          : Number(memoryRatio.toFixed(6)),
      };
    },
  };
}

function privateAdapterConfig({ root, baseUrl, keyFile, runId }) {
  return resolveAdapterConfig({
    serverUrl: baseUrl,
    apiKeyFile: keyFile,
    outboxDir: path.join(root, "adapter", "outbox"),
    pendingResumeDir: path.join(root, "adapter", "pending-resume"),
    taskScopeDir: path.join(root, "adapter", "task-scopes"),
    injectionEventOutboxDir: path.join(root, "adapter", "injection-event-outbox"),
    deviceId: "capacity-server-v02",
    agentId: "mnemuron-loadgen",
    agentInstanceId: `mnemuron-loadgen-${runId}`,
    projectId: "project-mnemuron",
    taskId: "task-mnemuron-production-readiness-v01",
    workstreamId: "workstream-capacity",
    rawRetentionDays: 1,
    requestTimeoutMs: 60_000,
  });
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
  expectedIds,
  stopState,
}) {
  const count = rate * seconds;
  const intervalMs = 1_000 / rate;
  const started = performance.now();
  const pending = new Set();
  for (let index = 0; index < count; index += 1) {
    if (stopState.reason) break;
    const waitMs = started + (index * intervalMs) - performance.now();
    if (waitMs > 0) await sleep(waitMs);
    const identity = identityFor(runId, phase, index);
    expectedIds.add(identity.eventId);
    const sized = makeSizedEnvelope(loadPayloadBytes(index), identity);
    const promise = requestJson({
      baseUrl,
      apiKey,
      method: "POST",
      endpoint: "/v1/events",
      body: sized.body,
      agent,
    }).then((response) => {
      latencyRecords.push({
        captured_at: new Date().toISOString(),
        phase,
        index,
        event_id: identity.eventId,
        payload_bytes: sized.bytes,
        status: response.status,
        latency_ms: response.latency_ms,
        error: "",
      });
    }).catch((error) => {
      latencyRecords.push({
        captured_at: new Date().toISOString(),
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
    target_rate: rate,
    target_seconds: seconds,
    target_count: count,
    scheduled_count: latencyRecords.filter((record) => record.phase === phase).length,
    elapsed_ms: Number((performance.now() - started).toFixed(3)),
  };
}

function remoteCommand(host, command, maxBuffer = 16 * 1024 * 1024, options = {}) {
  return execFile("ssh", [host, command], { maxBuffer, ...options });
}

function encodedNodeCommand({ ctid, code, args = [], timeoutSeconds = null }) {
  const encoded = Buffer.from(code).toString("base64");
  const quotedArgs = args.map((value) => `'${String(value).replaceAll("'", "'\\''")}'`).join(" ");
  const timeout = timeoutSeconds === null
    ? ""
    : `timeout --signal=TERM --kill-after=5s ${timeoutSeconds}s `;
  return `pct exec ${ctid} -- ${timeout}/opt/mnemuron/node/bin/node -e "eval(Buffer.from(process.argv[1],'base64').toString())" '${encoded}' ${quotedArgs}`;
}

function encodedHostShellCommand({ code, args = [] }) {
  const encoded = Buffer.from(code).toString("base64");
  const quotedArgs = args.map((item) => `'${String(item).replaceAll("'", "'\\''")}'`).join(" ");
  return `printf %s '${encoded}' | base64 --decode | bash -s -- ${quotedArgs}`;
}

export const PVE_RESOURCE_SCRIPT = String.raw`
set -eu
ctid=$1
case "$ctid" in
  ''|*[!0-9]*) printf 'invalid CTID\n' >&2; exit 64 ;;
esac
pve_node=$(hostname -s)
pve_status=$(pvesh get /nodes/$pve_node/lxc/$ctid/status/current --output-format json)
init_pid=$(printf '%s' "$pve_status" | jq -er '.pid | select(type == "number" and . > 0)')
maxmem=$(printf '%s' "$pve_status" | jq -er '.maxmem | select(type == "number" and . > 0)')
cgroup_rel=$(awk -F: '$1 == "0" { print $3 }' /proc/$init_pid/cgroup)
probe_dir=/sys/fs/cgroup$cgroup_rel
container_cgroup=
while [ "$probe_dir" != /sys/fs/cgroup ] && [ -n "$probe_dir" ]; do
  if [ -f "$probe_dir/memory.max" ]; then
    cgroup_max=$(tr -d '\n' < "$probe_dir/memory.max")
    if [ "$cgroup_max" = "$maxmem" ]; then
      container_cgroup=$probe_dir
      break
    fi
  fi
  probe_dir=$(dirname "$probe_dir")
done
if [ -z "$container_cgroup" ]; then
  printf 'authoritative CT cgroup not found\n' >&2
  exit 65
fi
number_file() {
  if [ -f "$1" ]; then
    raw=$(tr -d '\n' < "$1")
    case "$raw" in
      ''|max|*[!0-9]*) printf '0\n' ;;
      *) printf '%s\n' "$raw" ;;
    esac
  else
    printf '0\n'
  fi
}
keyed_value() {
  if [ -f "$1" ]; then
    awk -v wanted="$2" '$1 == wanted { print $2; found=1 } END { if (!found) print 0 }' "$1"
  else
    printf '0\n'
  fi
}
memory_peak=$(number_file "$container_cgroup/memory.peak")
swap_peak=$(number_file "$container_cgroup/memory.swap.peak")
anon_bytes=$(keyed_value "$container_cgroup/memory.stat" anon)
file_bytes=$(keyed_value "$container_cgroup/memory.stat" file)
events_high=$(keyed_value "$container_cgroup/memory.events" high)
events_max=$(keyed_value "$container_cgroup/memory.events" max)
events_oom=$(keyed_value "$container_cgroup/memory.events" oom)
events_oom_kill=$(keyed_value "$container_cgroup/memory.events" oom_kill)
jq -cn \
  --argjson pve "$pve_status" \
  --arg pve_node "$pve_node" \
  --arg container_cgroup_path "$container_cgroup" \
  --argjson cgroup_memory_peak_bytes "$memory_peak" \
  --argjson cgroup_swap_peak_bytes "$swap_peak" \
  --argjson cgroup_anon_bytes "$anon_bytes" \
  --argjson cgroup_file_bytes "$file_bytes" \
  --argjson cgroup_events_high "$events_high" \
  --argjson cgroup_events_max "$events_max" \
  --argjson cgroup_events_oom "$events_oom" \
  --argjson cgroup_events_oom_kill "$events_oom_kill" \
  '$pve + {
    pve_node: $pve_node,
    container_cgroup_path: $container_cgroup_path,
    cgroup_memory_peak_bytes: $cgroup_memory_peak_bytes,
    cgroup_swap_peak_bytes: $cgroup_swap_peak_bytes,
    cgroup_anon_bytes: $cgroup_anon_bytes,
    cgroup_file_bytes: $cgroup_file_bytes,
    cgroup_events_high: $cgroup_events_high,
    cgroup_events_max: $cgroup_events_max,
    cgroup_events_oom: $cgroup_events_oom,
    cgroup_events_oom_kill: $cgroup_events_oom_kill
  }'
`;

function requiredNumber(record, field, { positive = false } = {}) {
  const result = Number(record?.[field]);
  if (!Number.isFinite(result) || (positive ? result <= 0 : result < 0)) {
    throw new Error(`pve_resource_probe_invalid:${field}`);
  }
  return result;
}

export function mergePveResourceSample(guest, pve, { expectedCtid } = {}) {
  const vmid = requiredNumber(pve, "vmid", { positive: true });
  if (expectedCtid !== undefined && vmid !== Number(expectedCtid)) {
    throw new Error("pve_resource_probe_invalid:vmid_mismatch");
  }
  if (pve?.type !== "lxc" || pve?.status !== "running") {
    throw new Error("pve_resource_probe_invalid:container_status");
  }
  if (!String(pve?.container_cgroup_path || "").startsWith("/sys/fs/cgroup/")) {
    throw new Error("pve_resource_probe_invalid:container_cgroup_path");
  }
  const memoryCurrent = requiredNumber(pve, "mem");
  const memoryMax = requiredNumber(pve, "maxmem", { positive: true });
  const swapCurrent = requiredNumber(pve, "swap");
  const swapMax = requiredNumber(pve, "maxswap");
  return {
    ...guest,
    captured_at: new Date().toISOString(),
    container_metric_source: "pve-host-authoritative-v0.1",
    pve_node: String(pve.pve_node),
    pve_status: pve.status,
    pve_init_pid: requiredNumber(pve, "pid", { positive: true }),
    container_cgroup_path: pve.container_cgroup_path,
    container_memory_current_bytes: memoryCurrent,
    container_memory_peak_bytes: requiredNumber(pve, "cgroup_memory_peak_bytes"),
    container_memory_max_bytes: memoryMax,
    container_swap_current_bytes: swapCurrent,
    container_swap_peak_bytes: requiredNumber(pve, "cgroup_swap_peak_bytes"),
    container_swap_max_bytes: swapMax,
    container_anon_bytes: requiredNumber(pve, "cgroup_anon_bytes"),
    container_file_cache_bytes: requiredNumber(pve, "cgroup_file_bytes"),
    container_memory_events_high: requiredNumber(pve, "cgroup_events_high"),
    container_memory_events_max: requiredNumber(pve, "cgroup_events_max"),
    container_memory_events_oom: requiredNumber(pve, "cgroup_events_oom"),
    container_memory_events_oom_kill: requiredNumber(pve, "cgroup_events_oom_kill"),
    container_memory_pressure_some_avg10: requiredNumber(pve, "pressurememorysome"),
    container_memory_pressure_full_avg10: requiredNumber(pve, "pressurememoryfull"),
    container_io_pressure_some_avg10: requiredNumber(pve, "pressureiosome"),
    container_io_pressure_full_avg10: requiredNumber(pve, "pressureiofull"),
    swap_used_bytes: swapCurrent,
  };
}

export const RESOURCE_CODE = String.raw`
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync, statSync, statfsSync } = require("node:fs");
const path = require("node:path");
function command(...args) { return execFileSync(args[0], args.slice(1), { encoding: "utf8" }).trim(); }
function size(file) { return existsSync(file) ? statSync(file).size : 0; }
function text(file, fallback = "") { return existsSync(file) ? readFileSync(file, "utf8").trim() : fallback; }
function number(file, fallback = 0) {
  const raw = text(file, String(fallback));
  if (raw === "max") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function keyed(file) {
  return Object.fromEntries(text(file).split("\n").filter(Boolean).map(line => {
    const [key, raw] = line.trim().split(/\s+/, 2);
    return [key, Number(raw) || 0];
  }));
}
function pressure(file) {
  const result = {};
  for (const line of text(file).split("\n").filter(Boolean)) {
    const [kind, ...fields] = line.trim().split(/\s+/);
    for (const field of fields) {
      const [key, raw] = field.split("=", 2);
      result[kind + "_" + key] = Number(raw) || 0;
    }
  }
  return result;
}
const database = process.argv[2];
const fs = statfsSync("/var/lib/mnemuron", { bigint: true });
const total = Number(fs.blocks * fs.bsize);
const free = Number(fs.bavail * fs.bsize);
const rootCgroup = "/sys/fs/cgroup";
const controlGroup = command("systemctl", "show", "mnemuron.service", "-p", "ControlGroup", "--value");
const productionCgroup = path.join(rootCgroup, controlGroup);
const productionMemoryEvents = keyed(path.join(productionCgroup, "memory.events"));
const productionMemoryStat = keyed(path.join(productionCgroup, "memory.stat"));
const productionMemoryPressure = pressure(path.join(productionCgroup, "memory.pressure"));
console.log(JSON.stringify({
  captured_at: new Date().toISOString(),
  production_pid: Number(command("systemctl", "show", "mnemuron.service", "-p", "MainPID", "--value")),
  production_restarts: Number(command("systemctl", "show", "mnemuron.service", "-p", "NRestarts", "--value")),
  production_active: command("systemctl", "is-active", "mnemuron.service"),
  production_memory_bytes: Number(command("systemctl", "show", "mnemuron.service", "-p", "MemoryCurrent", "--value")),
  production_swap_bytes: number(path.join(productionCgroup, "memory.swap.current")),
  production_anon_bytes: productionMemoryStat.anon || 0,
  production_file_cache_bytes: productionMemoryStat.file || 0,
  production_memory_events_high: productionMemoryEvents.high || 0,
  production_memory_events_max: productionMemoryEvents.max || 0,
  production_memory_events_oom: productionMemoryEvents.oom || 0,
  production_memory_events_oom_kill: productionMemoryEvents.oom_kill || 0,
  production_memory_pressure_some_avg10: productionMemoryPressure.some_avg10 || 0,
  production_memory_pressure_full_avg10: productionMemoryPressure.full_avg10 || 0,
  filesystem_total_bytes: total,
  filesystem_free_bytes: free,
  filesystem_free_percent: Number((free / total * 100).toFixed(3)),
  database_bytes: size(database),
  wal_bytes: size(database + "-wal"),
  shm_bytes: size(database + "-shm"),
  load_1m: require("node:os").loadavg()[0],
}));
`;

const RECONCILE_CODE = String.raw`
const { createHash } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2], { readOnly: true });
const prefix = process.argv[3];
const allowed = /^(?:body01|body02|body04|load01|load02|load03|load03large|queue01|queue03|queue04)-/;
const rows = db.prepare("SELECT event_id FROM events WHERE event_id LIKE ? ORDER BY event_id")
  .all(prefix + "-%")
  .filter(row => allowed.test(row.event_id.slice(prefix.length + 1)));
const body01 = db.prepare("SELECT length(raw_payload_json) AS raw_bytes FROM events WHERE event_id = ?").get(prefix + "-body01-000000");
const rejected = db.prepare("SELECT count(*) AS count FROM events WHERE event_id IN (?, ?)").get(prefix + "-body03-000000", prefix + "-queue04-000000").count;
const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
const raw = db.prepare("SELECT count(*) AS events, " +
  "sum(CASE WHEN raw_payload_json IS NOT NULL THEN 1 ELSE 0 END) AS raw_available, " +
  "sum(CASE WHEN expired_at IS NOT NULL THEN 1 ELSE 0 END) AS expired " +
  "FROM events").get();
const ids = rows.map(row => row.event_id);
console.log(JSON.stringify({
  stored: ids.length,
  stored_id_sha256: createHash("sha256").update(ids.join("\n")).digest("hex"),
  body01_raw_bytes: body01?.raw_bytes || 0,
  rejected_events_stored: rejected,
  integrity_check: integrity,
  raw_counts: raw,
}));
db.close();
`;

export const BACKUP_CODE = String.raw`
const {
  chmodSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync,
} = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { backup, DatabaseSync } = require("node:sqlite");
void (async () => {
process.umask(0o077);
const database = path.resolve(process.argv[2]);
const backupDir = path.resolve(process.argv[3]);
const ratePages = Number(process.argv[4]);
const deadlineMs = Number(process.argv[5]);
if (!Number.isInteger(ratePages) || ratePages < 1) throw new Error("backup rate must be positive");
if (!Number.isInteger(deadlineMs) || deadlineMs < 1) throw new Error("backup deadline must be positive");
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const target = path.join(backupDir, "mnemuron-capacity-v02-" + timestamp + ".sqlite3");
const temporary = target + "." + process.pid + ".tmp";
const cleanupSuffixes = ${JSON.stringify(SQLITE_TEMP_SUFFIXES)};
const remove = file => { if (existsSync(file)) unlinkSync(file); };
const cleanup = () => {
  for (const suffix of cleanupSuffixes) remove(temporary + suffix);
};
const started = performance.now();
let source;
let verified;
let stopping = false;
let deadlineTimer;
const stop = (reason = "signal") => {
  if (stopping) return;
  stopping = true;
  try { verified?.close(); } catch {}
  try { source?.close(); } catch {}
  cleanup();
  if (reason === "deadline") {
    console.log(JSON.stringify({
      status: "timeout",
      duration_ms: Number((performance.now() - started).toFixed(3)),
      timeout_ms: deadlineMs,
      error_class: "backup_deadline_exceeded",
      cleanup_completed: true,
    }));
    process.exit(0);
  }
  process.exit(124);
};
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) process.once(signal, stop);
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
deadlineTimer = setTimeout(() => stop("deadline"), deadlineMs);
deadlineTimer.unref();
let previousRemaining = null;
let rewindSignals = 0;
let largestRemainingIncrease = 0;
let progressSteps = 0;
let firstProgress = null;
let lastProgress = null;
let totalPagesMin = null;
let totalPagesMax = null;
try {
  source = new DatabaseSync(database, { readOnly: true });
  const pagesBackedUp = await backup(source, temporary, {
    rate: ratePages,
    progress: ({ totalPages, remainingPages }) => {
      totalPages = Number(totalPages);
      remainingPages = Number(remainingPages);
      const sample = {
        step: progressSteps + 1,
        total_pages: totalPages,
        remaining_pages: remainingPages,
      };
      if (previousRemaining !== null && remainingPages > previousRemaining) {
        rewindSignals += 1;
        largestRemainingIncrease = Math.max(
          largestRemainingIncrease,
          remainingPages - previousRemaining,
        );
      }
      previousRemaining = remainingPages;
      progressSteps += 1;
      totalPagesMin = totalPagesMin === null ? totalPages : Math.min(totalPagesMin, totalPages);
      totalPagesMax = totalPagesMax === null ? totalPages : Math.max(totalPagesMax, totalPages);
      firstProgress ||= sample;
      lastProgress = sample;
    },
  });
  source.close();
  source = null;
  chmodSync(temporary, 0o600);
  verified = new DatabaseSync(temporary, { readOnly: true });
  const integrity = verified.prepare("PRAGMA integrity_check").get().integrity_check;
  const counts = {
    events: verified.prepare("SELECT count(*) AS count FROM events").get().count,
    tasks: verified.prepare("SELECT count(*) AS count FROM tasks").get().count,
    resumes: verified.prepare("SELECT count(*) AS count FROM resumes").get().count,
    credentials: verified.prepare("SELECT count(*) AS count FROM credentials").get().count,
  };
  verified.close();
  verified = null;
  if (integrity !== "ok") throw new Error("Backup integrity check failed: " + integrity);
  for (const suffix of cleanupSuffixes.slice(1)) remove(temporary + suffix);
  renameSync(temporary, target);
  chmodSync(target, 0o600);
  clearTimeout(deadlineTimer);
  console.log(JSON.stringify({
    status: "completed",
    backup_file: target,
    integrity_check: integrity,
    counts,
    bytes: statSync(target).size,
    mode: "0600",
    duration_ms: Number((performance.now() - started).toFixed(3)),
    rate_pages: ratePages,
    pages_backed_up: pagesBackedUp,
    progress_steps: progressSteps,
    rewind_signals: rewindSignals,
    largest_remaining_increase_pages: largestRemainingIncrease,
    total_pages_min: totalPagesMin,
    total_pages_max: totalPagesMax,
    first_progress: firstProgress,
    last_progress: lastProgress,
    retention: "no_automatic_deletion",
  }));
} finally {
  clearTimeout(deadlineTimer);
  verified?.close();
  source?.close();
  cleanup();
}
})().catch(error => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
`;

async function remoteJson({ sshHost, ctid, code, args }) {
  const result = await remoteCommand(sshHost, encodedNodeCommand({ ctid, code, args }));
  return JSON.parse(result.stdout.trim());
}

export async function readPveResourceSnapshot({ sshHost, ctid }) {
  const result = await remoteCommand(
    sshHost,
    encodedHostShellCommand({ code: PVE_RESOURCE_SCRIPT, args: [ctid] }),
  );
  return JSON.parse(result.stdout.trim());
}

async function remoteBackup({
  sshHost,
  ctid,
  databasePath,
  timeoutMs,
  ratePages,
}) {
  const started = performance.now();
  const timeoutSeconds = Math.max(
    1,
    Math.ceil((timeoutMs + BACKUP_REMOTE_CLEANUP_GRACE_MS) / 1_000),
  );
  try {
    const result = await remoteCommand(
      sshHost,
      encodedNodeCommand({
        ctid,
        code: BACKUP_CODE,
        args: [
          databasePath,
          "/var/lib/mnemuron/backups/scheduled",
          ratePages,
          timeoutMs,
        ],
        timeoutSeconds,
      }),
      16 * 1024 * 1024,
      {
        timeout: timeoutMs + BACKUP_REMOTE_CLEANUP_GRACE_MS + 5_000,
        killSignal: "SIGTERM",
      },
    );
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    const durationMs = Number((performance.now() - started).toFixed(3));
    const timedOut = error.code === 124
      || error.killed === true
      || durationMs >= timeoutMs;
    return {
      status: timedOut ? "timeout" : "failed",
      duration_ms: durationMs,
      timeout_ms: timeoutMs,
      error_class: timedOut ? "backup_deadline_exceeded" : "backup_command_failed",
      exit_code: Number.isInteger(error.code) ? error.code : null,
    };
  }
}

async function runQueueCases({ root, baseUrl, keyFile, runId, options, expectedIds }) {
  const cases = [];
  const liveConfig = privateAdapterConfig({ root, baseUrl, keyFile, runId });
  const offlineClient = new MnemuronClient({
    ...liveConfig,
    serverUrl: new URL("http://127.0.0.1:1"),
    requestTimeoutMs: 250,
  });
  const probeEvent = eventFor(runId, "QUEUE-01", 0);
  expectedIds.add(probeEvent.event_id);
  const probe = await offlineClient.submitEvent(probeEvent);
  for (let index = 1; index < options.queueCount; index += 1) {
    const event = eventFor(runId, "QUEUE-01", index);
    expectedIds.add(event.event_id);
    offlineClient.queueEnvelope({ event, raw_retention_days: 1 });
  }
  const queuedFiles = offlineClient.outboxFiles();
  const queue01Pass = probe.delivery === "queued"
    && queuedFiles.length === options.queueCount
    && modeOf(offlineClient.config.outboxDir) === "0700"
    && queuedFiles.every((file) => modeOf(file) === "0600");
  cases.push(caseResult("QUEUE-01", queue01Pass, {
    delivery: probe.delivery,
    queued_files: queuedFiles.length,
    directory_mode: modeOf(offlineClient.config.outboxDir),
    file_modes: [...new Set(queuedFiles.map(modeOf))],
  }));

  const liveClient = new MnemuronClient(liveConfig);
  const drainStarted = performance.now();
  const drained = await liveClient.flushOutbox();
  const drainMs = performance.now() - drainStarted;
  cases.push(caseResult("QUEUE-02", drained.queued_before === options.queueCount
    && drained.flushed === options.queueCount
    && liveClient.outboxFiles().length === 0
    && drainMs < 5 * 60_000, {
    ...drained,
    drain_ms: Number(drainMs.toFixed(3)),
    final_queue: liveClient.outboxFiles().length,
  }));

  for (let index = 0; index < options.queueInterruptCount; index += 1) {
    const event = eventFor(runId, "QUEUE-03", index);
    expectedIds.add(event.event_id);
    liveClient.queueEnvelope({ event, raw_retention_days: 1 });
  }
  const interruptingClient = new MnemuronClient(liveConfig);
  const originalRequest = interruptingClient.request.bind(interruptingClient);
  let requestCount = 0;
  interruptingClient.request = async (...args) => {
    if (requestCount >= options.queueInterruptAfter) throw new Error("harness_interrupt");
    requestCount += 1;
    return originalRequest(...args);
  };
  let interruptError = null;
  try {
    await interruptingClient.flushOutbox();
  } catch (error) {
    interruptError = error.message;
  }
  const remaining = interruptingClient.outboxFiles().length;
  const restartedClient = new MnemuronClient(liveConfig);
  const restartDrain = await restartedClient.flushOutbox();
  cases.push(caseResult("QUEUE-03", interruptError === "harness_interrupt"
    && remaining === options.queueInterruptCount - options.queueInterruptAfter
    && restartDrain.flushed === remaining
    && restartedClient.outboxFiles().length === 0, {
    interrupt_error: interruptError,
    remaining_after_interrupt: remaining,
    restarted_flush: restartDrain,
    final_queue: restartedClient.outboxFiles().length,
  }));

  const oversizeIdentity = identityFor(runId, "QUEUE-04", 0);
  const validEvent = eventFor(runId, "QUEUE-04", 1);
  expectedIds.add(validEvent.event_id);
  const oversize = makeSizedEnvelope(OVER_LIMIT_BODY_BYTES, oversizeIdentity);
  restartedClient.queueEnvelope(oversize.envelope);
  restartedClient.queueEnvelope({ event: validEvent, raw_retention_days: 1 });
  let queue04Error = null;
  try {
    await restartedClient.flushOutbox();
  } catch (error) {
    queue04Error = error.message;
  }
  const terminal = restartedClient.quarantinedOutboxItems()[0];
  const original = path.join(
    restartedClient.config.outboxQuarantineDir,
    `${oversizeIdentity.eventId}.json`,
  );
  const queue04Pass = queue04Error === null
    && restartedClient.outboxFiles().length === 0
    && restartedClient.outboxQuarantineFiles().length === 2
    && terminal?.event_id === oversizeIdentity.eventId
    && terminal?.reason === "permanent_http_413"
    && terminal?.http_status === 413
    && existsSync(original)
    && modeOf(restartedClient.config.outboxQuarantineDir) === "0700"
    && modeOf(original) === "0600";
  cases.push(caseResult("QUEUE-04", queue04Pass, {
    error: queue04Error,
    active_outbox_files: restartedClient.outboxFiles().length,
    quarantine_files: restartedClient.outboxQuarantineFiles().map((file) => path.basename(file)),
    terminal: terminal || null,
    quarantine_directory_mode: modeOf(restartedClient.config.outboxQuarantineDir),
    original_mode: existsSync(original) ? modeOf(original) : null,
  }, queue04Pass ? null : "permanent_413_private_tls_behavior_failed"));
  return cases;
}

async function runHarness(options) {
  options = { ...options, ...readRemoteDeploymentConfig(options) };
  const apiKey = readFileSync(0, "utf8").trim();
  if (!apiKey.startsWith("mnm_")) throw new Error("A temporary Mnemuron key is required on stdin.");
  const startedAt = new Date().toISOString();
  const evidenceDir = path.resolve(options.evidenceDir);
  mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  chmodSync(evidenceDir, 0o700);
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-private-tls-"));
  chmodSync(root, 0o700);
  const keyFile = path.join(root, "temporary-agent.key");
  writePrivate(keyFile, `${apiKey}\n`);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64 });
  const latencyRecords = [];
  const resourceRecords = [];
  const cases = [];
  const expectedIds = new Set();
  const stopState = { reason: null, warnings: [] };
  const resourceGuard = createResourceGuard();
  let sampler = null;
  let duringLoadBackup = null;

  const sample = async () => {
    try {
      const [guest, pve] = await Promise.all([
        remoteJson({
          sshHost: options.sshHost,
          ctid: options.ctid,
          code: RESOURCE_CODE,
          args: [options.databasePath],
        }),
        readPveResourceSnapshot({ sshHost: options.sshHost, ctid: options.ctid }),
      ]);
      const record = mergePveResourceSample(guest, pve, { expectedCtid: options.ctid });
      const evaluation = resourceGuard.evaluate(record);
      record.resource_stop_reason = evaluation.stop_reason;
      record.resource_warnings = evaluation.warnings.join(";");
      record.swap_delta_bytes = evaluation.swap_delta_bytes;
      record.swap_growth_samples = evaluation.swap_growth_samples;
      record.container_memory_ratio = evaluation.container_memory_ratio;
      resourceRecords.push(record);
      stopState.reason ||= evaluation.stop_reason;
      stopState.warnings = evaluation.warnings;
    } catch (error) {
      stopState.reason = `resource_probe_failed:${error.message}`;
    }
  };

  try {
    await sample();
    if (stopState.reason) throw new Error(stopState.reason);
    let sampleRunning = false;
    sampler = setInterval(() => {
      if (sampleRunning) return;
      sampleRunning = true;
      sample().finally(() => { sampleRunning = false; });
    }, options.sampleIntervalMs);

    const live = await requestJson({
      baseUrl: options.serverUrl,
      apiKey,
      method: "GET",
      endpoint: "/livez",
      agent,
    });
    const ready = await requestJson({
      baseUrl: options.serverUrl,
      apiKey,
      method: "GET",
      endpoint: "/readyz",
      agent,
    });
    if (live.status !== 200 || ready.status !== 200) throw new Error("private_tls_health_preflight_failed");

    const body01Identity = identityFor(options.runId, "BODY-01", 0);
    expectedIds.add(body01Identity.eventId);
    const body01 = makeSizedEnvelope(HISTORICAL_BODY_BYTES, body01Identity);
    const body01Response = await requestJson({
      baseUrl: options.serverUrl,
      apiKey,
      method: "POST",
      endpoint: "/v1/events",
      body: body01.body,
      agent,
    });
    cases.push(caseResult("BODY-01", body01Response.status === 202, {
      request_bytes: body01.bytes,
      status: body01Response.status,
      latency_ms: body01Response.latency_ms,
    }));

    const body02Identities = [0, 1].map((index) => identityFor(options.runId, "BODY-02", index));
    body02Identities.forEach((identity) => expectedIds.add(identity.eventId));
    const body02Responses = await Promise.all(body02Identities.map((identity) => {
      const sized = makeSizedEnvelope(NEAR_LIMIT_BODY_BYTES, identity);
      return requestJson({
        baseUrl: options.serverUrl,
        apiKey,
        method: "POST",
        endpoint: "/v1/events",
        body: sized.body,
        agent,
      });
    }));
    cases.push(caseResult("BODY-02", body02Responses.every((response) => response.status === 202), {
      request_bytes_each: NEAR_LIMIT_BODY_BYTES,
      statuses: body02Responses.map((response) => response.status),
      latencies_ms: body02Responses.map((response) => response.latency_ms),
    }));

    const body03Identity = identityFor(options.runId, "BODY-03", 0);
    const body03 = makeSizedEnvelope(OVER_LIMIT_BODY_BYTES, body03Identity);
    const body03Response = await requestJson({
      baseUrl: options.serverUrl,
      apiKey,
      method: "POST",
      endpoint: "/v1/events",
      body: body03.body,
      agent,
    });
    cases.push(caseResult("BODY-03", body03Response.status === 413
      && body03Response.data?.error === "Request body is too large.", {
      request_bytes: body03.bytes,
      status: body03Response.status,
      error: body03Response.data?.error,
      latency_ms: body03Response.latency_ms,
    }));

    const body04Identity = identityFor(options.runId, "BODY-04", 0);
    expectedIds.add(body04Identity.eventId);
    const body04 = makeSizedEnvelope(2 * 1024, body04Identity);
    const body04Response = await requestJson({
      baseUrl: options.serverUrl,
      apiKey,
      method: "POST",
      endpoint: "/v1/events",
      body: body04.body,
      agent,
    });
    cases.push(caseResult("BODY-04", body04Response.status === 202
      && body04Response.reused_socket === true, {
      status: body04Response.status,
      reused_socket: body04Response.reused_socket,
      latency_ms: body04Response.latency_ms,
    }));

    const backupTimer = options.backupMode === "once"
      ? setTimeout(() => {
        duringLoadBackup = remoteBackup({
          sshHost: options.sshHost,
          ctid: options.ctid,
          databasePath: options.databasePath,
          timeoutMs: options.backupTimeoutMs,
          ratePages: options.backupRatePages,
        });
      }, Math.min(5_000, Math.max(100, options.sustainedSeconds * 250)))
      : null;
    const load01 = await runRatePhase({
      phase: "LOAD-01",
      rate: options.sustainedRate,
      seconds: options.sustainedSeconds,
      runId: options.runId,
      baseUrl: options.serverUrl,
      apiKey,
      agent,
      latencyRecords,
      expectedIds,
      stopState,
    });
    if (backupTimer) clearTimeout(backupTimer);
    if (options.backupMode === "once" && !duringLoadBackup) {
      duringLoadBackup = remoteBackup({
        sshHost: options.sshHost,
        ctid: options.ctid,
        databasePath: options.databasePath,
        timeoutMs: options.backupTimeoutMs,
        ratePages: options.backupRatePages,
      });
    }
    const backupResult = duringLoadBackup
      ? await duringLoadBackup
      : {
        status: "not_run",
        reason: "quick_mode_avoids_remote_full_backup",
      };
    const load01Latency = latencySummary(latencyRecords.filter((record) => record.phase === "LOAD-01"));
    cases.push(caseResult("LOAD-01", !stopState.reason
      && load01.scheduled_count === load01.target_count
      && load01Latency.statuses["202"] === load01.target_count
      && load01Latency.p95_ms < 1_000, { ...load01, latency: load01Latency }, stopState.reason));

    const load02 = await runRatePhase({
      phase: "LOAD-02",
      rate: options.burstRate,
      seconds: options.burstSeconds,
      runId: options.runId,
      baseUrl: options.serverUrl,
      apiKey,
      agent,
      latencyRecords,
      expectedIds,
      stopState,
    });
    const load02Latency = latencySummary(latencyRecords.filter((record) => record.phase === "LOAD-02"));
    cases.push(caseResult("LOAD-02", !stopState.reason
      && load02.scheduled_count === load02.target_count
      && load02Latency.statuses["202"] === load02.target_count
      && load02Latency.p95_ms < 1_000, { ...load02, latency: load02Latency }, stopState.reason));

    const load03Promise = runRatePhase({
      phase: "LOAD-03",
      rate: options.concurrentRate,
      seconds: options.concurrentSeconds,
      runId: options.runId,
      baseUrl: options.serverUrl,
      apiKey,
      agent,
      latencyRecords,
      expectedIds,
      stopState,
    });
    await sleep(Math.min(1_000, Math.max(50, options.concurrentSeconds * 250)));
    const largeIdentities = [0, 1].map((index) => identityFor(options.runId, "LOAD-03-LARGE", index));
    largeIdentities.forEach((identity) => expectedIds.add(identity.eventId));
    const largeResponses = await Promise.all(largeIdentities.map((identity) => {
      const sized = makeSizedEnvelope(NEAR_LIMIT_BODY_BYTES, identity);
      return requestJson({
        baseUrl: options.serverUrl,
        apiKey,
        method: "POST",
        endpoint: "/v1/events",
        body: sized.body,
        agent,
      });
    }));
    const load03 = await load03Promise;
    const load03Latency = latencySummary(latencyRecords.filter((record) => record.phase === "LOAD-03"));
    cases.push(caseResult("LOAD-03", !stopState.reason
      && load03.scheduled_count === load03.target_count
      && load03Latency.statuses["202"] === load03.target_count
      && largeResponses.every((response) => response.status === 202), {
      ...load03,
      background_latency: load03Latency,
      large_statuses: largeResponses.map((response) => response.status),
      large_latencies_ms: largeResponses.map((response) => response.latency_ms),
    }, stopState.reason));

    cases.push(...await runQueueCases({
      root,
      baseUrl: options.serverUrl,
      keyFile,
      runId: options.runId,
      options,
      expectedIds,
    }));

    await sample();
    const reconciliation = await remoteJson({
      sshHost: options.sshHost,
      ctid: options.ctid,
      code: RECONCILE_CODE,
      args: [options.databasePath, options.runId],
    });
    const expectedSorted = [...expectedIds].sort();
    const expectedHash = sha256(expectedSorted.join("\n"));
    const reconcilePass = reconciliation.stored === expectedIds.size
      && reconciliation.stored_id_sha256 === expectedHash
      && reconciliation.rejected_events_stored === 0;
    for (const testCase of cases.filter((item) => (
      item.id.startsWith("BODY-") || item.id.startsWith("LOAD-") || item.id.startsWith("QUEUE-")
    ))) {
      if (!reconcilePass) {
        testCase.result = "fail";
        testCase.blocker = "central_event_reconciliation_failed";
      }
    }
    const allLoadAccepted = latencyRecords.every((record) => record.status === 202 && !record.error);
    if (backupResult.status === "not_run") {
      cases.push(caseNotRun("RET-03", {
        backup: backupResult,
        load_requests_during_test: latencyRecords.length,
      }));
    } else {
      cases.push(caseResult("RET-03", backupResult.status === "completed"
        && backupResult.integrity_check === "ok"
        && allLoadAccepted, {
        backup: backupResult,
        load_requests_during_test: latencyRecords.length,
      }, backupResult.status === "timeout"
        ? "backup_deadline_exceeded"
        : (backupResult.status === "completed" ? null : "backup_command_failed")));
    }
    const storagePass = resourceRecords.every((record) => record.filesystem_free_percent >= 20)
      && reconciliation.integrity_check === "ok";
    cases.push(caseResult("RET-04", storagePass, {
      samples: resourceRecords.length,
      minimum_filesystem_free_percent: Math.min(...resourceRecords.map((record) => record.filesystem_free_percent)),
      maximum_production_memory_bytes: Math.max(...resourceRecords.map((record) => record.production_memory_bytes)),
      baseline: resourceRecords[0],
      final: resourceRecords.at(-1),
      final_integrity_check: reconciliation.integrity_check,
    }, storagePass ? null : "storage_or_integrity_threshold_failed"));

    const finishedAt = new Date().toISOString();
    const failed = cases.filter((item) => item.result === "fail");
    const summary = {
      schema_version: "mnemuron-capacity-backpressure-private-tls-v0.2",
      run_id: options.runId,
      status: failed.length ? "blocked" : "pass",
      started_at: startedAt,
      finished_at: finishedAt,
      mode: "bounded-private-tls",
      production_contacted: true,
      production_database_written: true,
      production_ready_changed: false,
      hermes_touched: false,
      credential_source: "stdin",
      credential_in_evidence: false,
      test_raw_retention_days: 1,
      test_events_manually_deleted: false,
      server_url: options.serverUrl,
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
        queue_interrupt_count: options.queueInterruptCount,
        resource_guard: {
          production_memory_stop_bytes: MEMORY_STOP_BYTES,
          swap_stop_delta_bytes: SWAP_STOP_DELTA_BYTES,
          swap_stop_growth_samples: SWAP_STOP_GROWTH_SAMPLES,
          container_memory_stop_ratio: CONTAINER_MEMORY_STOP_RATIO,
          memory_pressure_full_avg10_stop: MEMORY_PRESSURE_FULL_AVG10_STOP,
        },
        backup_mode: options.backupMode,
        backup_timeout_ms: options.backupTimeoutMs,
        backup_rate_pages: options.backupRatePages,
      },
      identity: {
        device_id: "capacity-server-v02",
        agent_id: "mnemuron-loadgen",
        agent_instance_id: `mnemuron-loadgen-${options.runId}`,
        project_id: "project-mnemuron",
        task_id: "task-mnemuron-production-readiness-v01",
        workstream_id: "workstream-capacity",
      },
      cases,
      load_latency: latencySummary(latencyRecords),
      reconciliation: {
        generated: expectedIds.size,
        stored: reconciliation.stored,
        missing_count: reconcilePass ? 0 : Math.max(0, expectedIds.size - reconciliation.stored),
        generated_id_sha256: expectedHash,
        stored_id_sha256: reconciliation.stored_id_sha256,
        rejected_events_stored: reconciliation.rejected_events_stored,
      },
      raw_counts_after: reconciliation.raw_counts,
      final_integrity_check: reconciliation.integrity_check,
      resource_stop_reason: stopState.reason,
      resource_warnings: stopState.warnings,
      source_hashes: {
        private_tls_harness: sha256File(fileURLToPath(import.meta.url)),
        capacity_harness: sha256File(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mnemuron-capacity-harness.mjs")),
        openclaw_client: sha256File(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../adapters/openclaw/dist/client.js")),
      },
      evidence_files: ["manifest.json", "summary.json", "latency.csv", "resources.csv", "report.md"],
    };
    const manifest = {
      schema_version: summary.schema_version,
      run_id: options.runId,
      generated_at: finishedAt,
      topology: {
        client: os.hostname(),
        server_url: options.serverUrl,
        tls: true,
        reverse_proxy: "Configured reverse proxy",
        service: `Container ${options.ctid} mnemuron.service`,
        database: options.databasePath,
      },
      identity: summary.identity,
      parameters: summary.parameters,
      source_hashes: summary.source_hashes,
      credentials_in_evidence: false,
    };
    writeJson(path.join(evidenceDir, "manifest.json"), manifest);
    writeJson(path.join(evidenceDir, "summary.json"), summary);
    writeCsv(path.join(evidenceDir, "latency.csv"), [
      "captured_at", "phase", "index", "event_id", "payload_bytes", "status", "latency_ms", "error",
    ], latencyRecords);
    writeCsv(path.join(evidenceDir, "resources.csv"), [
      "captured_at", "production_pid", "production_restarts", "production_active",
      "container_metric_source", "pve_node", "pve_status", "pve_init_pid",
      "container_cgroup_path",
      "production_memory_bytes", "production_swap_bytes", "container_memory_current_bytes",
      "container_memory_peak_bytes", "container_memory_max_bytes", "container_swap_current_bytes",
      "container_swap_peak_bytes", "container_swap_max_bytes", "container_anon_bytes", "container_file_cache_bytes",
      "production_anon_bytes", "production_file_cache_bytes", "container_memory_events_high",
      "container_memory_events_max", "container_memory_events_oom", "container_memory_events_oom_kill",
      "production_memory_events_high", "production_memory_events_max", "production_memory_events_oom",
      "production_memory_events_oom_kill", "container_memory_pressure_some_avg10",
      "container_memory_pressure_full_avg10", "production_memory_pressure_some_avg10",
      "production_memory_pressure_full_avg10", "container_io_pressure_some_avg10",
      "container_io_pressure_full_avg10", "swap_used_bytes", "swap_delta_bytes",
      "swap_growth_samples", "container_memory_ratio", "resource_warnings", "resource_stop_reason",
      "filesystem_total_bytes",
      "filesystem_free_bytes", "filesystem_free_percent", "database_bytes", "wal_bytes",
      "shm_bytes", "load_1m",
    ], resourceRecords);
    const reportLines = [
      "# Bounded private-TLS Capacity and Backpressure Result",
      "",
      `- Run ID: \`${summary.run_id}\``,
      `- Status: **${summary.status}**`,
      `- Real path: \`${summary.server_url}\``,
      `- Generated/stored: ${summary.reconciliation.generated}/${summary.reconciliation.stored}`,
      `- Aggregate p95: ${summary.load_latency.p95_ms} ms`,
      `- Integrity: ${summary.final_integrity_check}`,
      `- production_ready changed: no`,
      "",
      "| Case | Result | Blocker |",
      "| --- | --- | --- |",
      ...summary.cases.map((item) => `| ${item.id} | ${item.result} | ${item.blocker || "—"} |`),
      "",
      "The temporary credential value is not present in this evidence package. Test Raw payloads use one-day retention and were not manually deleted.",
      "",
    ];
    writePrivate(path.join(evidenceDir, "report.md"), `${reportLines.join("\n")}\n`);
    return summary;
  } finally {
    if (sampler) clearInterval(sampler);
    agent.destroy();
    rmSync(root, { recursive: true, force: true });
  }
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function backupMode(value) {
  if (!new Set(["once", "skip"]).has(value)) {
    throw new Error("backup-mode must be once or skip.");
  }
  return value;
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
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for ${item}.`);
    values[item.slice(2)] = next;
    index += 1;
  }
  const base = quick ? QUICK_DEFAULTS : DEFAULTS;
  for (const required of ["run-id", "evidence-dir"]) {
    if (!values[required]) throw new Error(`--${required} is required.`);
  }
  const deployment = readRemoteDeploymentConfig({
    serverUrl: values["server-url"],
    sshHost: values["ssh-host"],
    ctid: values.ctid,
  });
  return {
    ...base,
    ...deployment,
    quick,
    runId: values["run-id"],
    evidenceDir: values["evidence-dir"],
    databasePath: values["database-path"] || "/var/lib/mnemuron/mnemuron.sqlite3",
    sustainedRate: values["sustained-rate"] ? positiveInteger(values["sustained-rate"], "sustained-rate") : base.sustainedRate,
    sustainedSeconds: values["sustained-seconds"] ? positiveInteger(values["sustained-seconds"], "sustained-seconds") : base.sustainedSeconds,
    burstRate: values["burst-rate"] ? positiveInteger(values["burst-rate"], "burst-rate") : base.burstRate,
    burstSeconds: values["burst-seconds"] ? positiveInteger(values["burst-seconds"], "burst-seconds") : base.burstSeconds,
    concurrentRate: values["concurrent-rate"] ? positiveInteger(values["concurrent-rate"], "concurrent-rate") : base.concurrentRate,
    concurrentSeconds: values["concurrent-seconds"] ? positiveInteger(values["concurrent-seconds"], "concurrent-seconds") : base.concurrentSeconds,
    queueCount: values["queue-count"] ? positiveInteger(values["queue-count"], "queue-count") : base.queueCount,
    queueInterruptCount: values["queue-interrupt-count"] ? positiveInteger(values["queue-interrupt-count"], "queue-interrupt-count") : base.queueInterruptCount,
    queueInterruptAfter: values["queue-interrupt-after"] ? positiveInteger(values["queue-interrupt-after"], "queue-interrupt-after") : base.queueInterruptAfter,
    sampleIntervalMs: values["sample-interval-ms"] ? positiveInteger(values["sample-interval-ms"], "sample-interval-ms") : base.sampleIntervalMs,
    backupMode: backupMode(values["backup-mode"] || base.backupMode),
    backupTimeoutMs: values["backup-timeout-ms"] ? positiveInteger(values["backup-timeout-ms"], "backup-timeout-ms") : base.backupTimeoutMs,
    backupRatePages: values["backup-rate-pages"] ? positiveInteger(values["backup-rate-pages"], "backup-rate-pages") : base.backupRatePages,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runHarness(parseArgs(process.argv.slice(2))).then((summary) => {
    process.stdout.write(`${JSON.stringify({
      status: summary.status,
      run_id: summary.run_id,
      failed_cases: summary.cases.filter((item) => item.result === "fail").map((item) => item.id),
      generated: summary.reconciliation.generated,
      stored: summary.reconciliation.stored,
      p95_ms: summary.load_latency.p95_ms,
      integrity_check: summary.final_integrity_check,
    })}\n`);
    process.exitCode = summary.status === "pass" ? 0 : 2;
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

export { parseArgs, runHarness };

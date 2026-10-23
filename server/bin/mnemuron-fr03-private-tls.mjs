#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  MnemuronClient,
  resolveAdapterConfig,
} from "../../adapters/openclaw/dist/client.js";

const TASK_ID = "task-mnemuron-production-readiness-v01";
const PROJECT_ID = "project-mnemuron";
const WORKSTREAM_ID = "workstream-failure-recovery";
const DRAIN_TIMEOUT_MS = 5 * 60_000;
const PROFILES = Object.freeze({
  "5m": Object.freeze({ durationMs: 5 * 60_000, eventCount: 100 }),
  "30m": Object.freeze({ durationMs: 30 * 60_000, eventCount: 600 }),
});

function resolveProfile(label) {
  const profile = PROFILES[label];
  if (!profile) throw new Error(`Unsupported FR-03 profile: ${label}.`);
  return { label, ...profile };
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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

function assertKeyFile(file) {
  if (modeOf(file) !== "0600") throw new Error("FR-03 Key file must be mode 0600.");
  const key = readFileSync(file, "utf8").trim();
  if (!key.startsWith("mnm_")) throw new Error("FR-03 Key file is invalid.");
}

async function healthProbe(serverUrl, label) {
  const result = { label, captured_at: new Date().toISOString() };
  for (const endpoint of ["/livez", "/readyz"]) {
    const started = performance.now();
    const response = await fetch(new URL(endpoint, serverUrl), {
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/json" },
    });
    result[endpoint.slice(1)] = {
      status: response.status,
      latency_ms: Number((performance.now() - started).toFixed(3)),
    };
    if (response.status !== 200) throw new Error(`${endpoint} returned ${response.status}.`);
  }
  return result;
}

function eventFor(runId, profile, index) {
  const sequence = String(index).padStart(6, "0");
  const sessionId = `failure-recovery-fr03-${profile.label}-${runId}`;
  return {
    schema_version: "0.1.0",
    event_id: `${runId}-fr03-${profile.label}-${sequence}`,
    event_type: "tool_result",
    hook_event_name: "FailureRecovery:FR-03",
    captured_at: new Date().toISOString(),
    project_id: PROJECT_ID,
    task_id: TASK_ID,
    workstream_id: WORKSTREAM_ID,
    session_id: sessionId,
    turn_id: `${sessionId}-turn-${sequence}`,
    content: `FR-03 ${profile.label} durable queue evidence ${sequence}`,
    capture_capability: {
      source: "failure-recovery-fr03-private-tls-v0.1",
      transcript_parser_used: false,
      disposable_fault_client: true,
    },
  };
}

function clientConfig({ serverUrl, keyFile, stateRoot, identity, allowInsecureHttp }) {
  return resolveAdapterConfig({
    serverUrl,
    allowInsecureHttp,
    apiKeyFile: keyFile,
    outboxDir: path.join(stateRoot, "outbox"),
    pendingResumeDir: path.join(stateRoot, "pending-resume"),
    taskScopeDir: path.join(stateRoot, "task-scopes"),
    injectionEventOutboxDir: path.join(stateRoot, "injection-event-outbox"),
    deviceId: identity.device_id,
    agentId: identity.agent_id,
    agentInstanceId: identity.agent_instance_id,
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    workstreamId: WORKSTREAM_ID,
    rawRetentionDays: 30,
    requestTimeoutMs: 15_000,
  });
}

function queueSnapshot(client, expectedIds) {
  const files = client.outboxFiles();
  const orderedIds = files.map((file) => path.basename(file, ".json"));
  const stats = files.map((file) => statSync(file));
  const oldestMtimeMs = stats.length ? Math.min(...stats.map((entry) => entry.mtimeMs)) : null;
  return {
    count: files.length,
    directory_mode: modeOf(client.config.outboxDir),
    file_modes: [...new Set(files.map(modeOf))],
    ordered_id_sha256: sha256(orderedIds.join("\n")),
    expected_order_sha256: sha256(expectedIds.join("\n")),
    enqueue_order_preserved: JSON.stringify(orderedIds) === JSON.stringify(expectedIds),
    oldest_enqueued_at: oldestMtimeMs === null ? null : new Date(oldestMtimeMs).toISOString(),
    oldest_age_ms: oldestMtimeMs === null ? null : Math.round(Date.now() - oldestMtimeMs),
  };
}

export async function runFr03(options) {
  const profile = resolveProfile(options.profile || "5m");
  const serverUrl = new URL(options.serverUrl);
  if (serverUrl.protocol !== "https:") {
    throw new Error("FR-03 production runner requires an HTTPS server URL.");
  }
  const keyFile = path.resolve(options.keyFile);
  const stateRoot = path.resolve(options.stateRoot);
  const evidenceDir = path.resolve(options.evidenceDir);
  assertKeyFile(keyFile);
  ensurePrivateDirectory(stateRoot);
  ensurePrivateDirectory(evidenceDir);

  const identity = {
    device_id: "failure-recovery-v01",
    agent_id: "mnemuron-fr03",
    agent_instance_id: options.agentInstanceId,
  };
  const gated = new MnemuronClient(clientConfig({
    serverUrl: "http://127.0.0.1:1",
    keyFile,
    stateRoot,
    identity,
    allowInsecureHttp: true,
  }));
  const live = new MnemuronClient(clientConfig({
    serverUrl: serverUrl.href,
    keyFile,
    stateRoot,
    identity,
    allowInsecureHttp: false,
  }));

  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const generatedIds = [];
  const healthSamples = [await healthProbe(serverUrl, "partition_start")];
  const deliveryResults = [];
  process.stdout.write(`${JSON.stringify({
    phase: "partition_started",
    profile: profile.label,
    at: startedAt,
    duration_seconds: profile.durationMs / 1000,
  })}\n`);

  for (let index = 0; index < profile.eventCount; index += 1) {
    const targetMs = startedMs + Math.floor((index * profile.durationMs) / profile.eventCount);
    const remaining = targetMs - Date.now();
    if (remaining > 0) await sleep(remaining);
    const stopReason = options.stopCheck?.();
    if (stopReason) throw new Error(`FR-03 stopped by resource guard: ${stopReason}.`);
    const event = eventFor(options.runId, profile, index);
    generatedIds.push(event.event_id);
    const result = await gated.submitEvent(event);
    deliveryResults.push(result.delivery);
    if (result.delivery !== "queued") {
      throw new Error(`Transport gate unexpectedly delivered Event ${event.event_id}.`);
    }
    if ((index + 1) % 20 === 0 && index + 1 < profile.eventCount) {
      healthSamples.push(await healthProbe(serverUrl, `partition_${index + 1}`));
      process.stdout.write(`${JSON.stringify({
        phase: "partition_progress",
        queued: gated.outboxFiles().length,
        target: profile.eventCount,
        elapsed_seconds: Number(((Date.now() - startedMs) / 1000).toFixed(1)),
      })}\n`);
    }
  }

  const holdRemaining = startedMs + profile.durationMs - Date.now();
  if (holdRemaining > 0) await sleep(holdRemaining);
  const finalStopReason = options.stopCheck?.();
  if (finalStopReason) throw new Error(`FR-03 stopped by resource guard: ${finalStopReason}.`);
  const gateOpenedAt = new Date().toISOString();
  const actualDurationMs = Date.now() - startedMs;
  healthSamples.push(await healthProbe(serverUrl, "partition_end"));
  const expectedIds = [...generatedIds].sort();
  const queued = queueSnapshot(gated, expectedIds);
  if (queued.count !== profile.eventCount
      || queued.directory_mode !== "0700"
      || queued.file_modes.length !== 1
      || queued.file_modes[0] !== "0600"
      || !queued.enqueue_order_preserved
      || actualDurationMs < profile.durationMs) {
    throw new Error("FR-03 durable queue invariants failed before reopening transport.");
  }

  process.stdout.write(`${JSON.stringify({ phase: "transport_reopened", queued: queued.count, at: gateOpenedAt })}\n`);
  const drainStartedAt = new Date().toISOString();
  const drainStartedMs = Date.now();
  const drainAttempts = [];
  while (live.outboxFiles().length > 0 && Date.now() - drainStartedMs < DRAIN_TIMEOUT_MS) {
    try {
      const result = await live.flushOutbox();
      drainAttempts.push({ at: new Date().toISOString(), ...result, error: null });
    } catch (error) {
      drainAttempts.push({ at: new Date().toISOString(), error: error?.message || String(error) });
      await sleep(1_000);
    }
  }
  const drainCompletedAt = new Date().toISOString();
  const drainMs = Date.now() - drainStartedMs;
  const finalQueue = live.outboxFiles().length;
  const quarantineFiles = live.outboxQuarantineFiles().length;
  if (finalQueue !== 0 || quarantineFiles !== 0 || drainMs >= DRAIN_TIMEOUT_MS) {
    throw new Error("FR-03 queue did not drain cleanly within five minutes.");
  }
  healthSamples.push(await healthProbe(serverUrl, "post_drain"));

  const events = {
    generated: generatedIds.length,
    generated_id_sha256: sha256(expectedIds.join("\n")),
    generated_ids_recorded: false,
    partition_delivery_results: [...new Set(deliveryResults)],
    stored: null,
    stored_id_sha256: null,
    missing: null,
    duplicates: null,
  };
  const client = {
    profile: profile.label,
    target_duration_ms: profile.durationMs,
    actual_duration_ms: actualDurationMs,
    event_count: profile.eventCount,
    partition_started_at: startedAt,
    transport_reopened_at: gateOpenedAt,
    queue_at_reopen: queued,
    drain_started_at: drainStartedAt,
    drain_completed_at: drainCompletedAt,
    drain_ms: drainMs,
    drain_attempts: drainAttempts,
    final_queue: finalQueue,
    quarantine_files: quarantineFiles,
    health_samples: healthSamples,
    real_private_tls_after_partition: true,
    network_dns_caddy_firewall_changed: false,
  };
  const timeline = [
    "timestamp,event,status,value",
    `${startedAt},transport_partition,started,client_scoped`,
    `${gateOpenedAt},transport_partition,ended,${actualDurationMs}`,
    `${drainStartedAt},outbox_drain,started,${queued.count}`,
    `${drainCompletedAt},outbox_drain,completed,${drainMs}`,
  ].join("\n");
  writeJson(path.join(evidenceDir, "events.json"), events);
  writeJson(path.join(evidenceDir, "client.json"), client);
  writePrivate(path.join(evidenceDir, "timeline.csv"), `${timeline}\n`);
  return { events, client };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["server-url", "key-file", "state-root", "run-id", "agent-instance", "evidence-dir"]) {
    if (!args[required]) throw new Error(`--${required} is required.`);
  }
  const result = await runFr03({
    serverUrl: args["server-url"],
    keyFile: args["key-file"],
    stateRoot: args["state-root"],
    runId: args["run-id"],
    agentInstanceId: args["agent-instance"],
    evidenceDir: args["evidence-dir"],
    profile: args.profile || "5m",
  });
  process.stdout.write(`${JSON.stringify({ status: "client_complete", ...result.events })}\n`);
}

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildResumeInjectionText } from "./resume-injection.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");

export function loadRuntimeEnv(env = process.env) {
  const runtimeEnv = { ...env };
  const configPath = path.resolve(
    env.MNEMURON_CONFIG_PATH ||
      path.join(env.HOME || os.homedir(), ".mnemuron", "config.json"),
  );
  if (!existsSync(configPath)) {
    return runtimeEnv;
  }

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const mappings = {
    mode: "MNEMURON_MODE",
    data_dir: "MNEMURON_SPIKE_DATA_DIR",
    server_url: "MNEMURON_SERVER_URL",
    api_key: "MNEMURON_API_KEY",
    api_key_file: "MNEMURON_API_KEY_FILE",
    tls_ca_file: "MNEMURON_TLS_CA_FILE",
    allow_insecure_http: "MNEMURON_ALLOW_INSECURE_HTTP",
    request_timeout_ms: "MNEMURON_REQUEST_TIMEOUT_MS",
    device_id: "MNEMURON_DEVICE_ID",
    agent_id: "MNEMURON_AGENT_ID",
    agent_instance_id: "MNEMURON_AGENT_INSTANCE_ID",
    raw_retention_days: "MNEMURON_RAW_RETENTION_DAYS",
    default_project_id: "MNEMURON_DEFAULT_PROJECT_ID",
    default_task_id: "MNEMURON_DEFAULT_TASK_ID",
    default_workstream_id: "MNEMURON_DEFAULT_WORKSTREAM_ID",
  };
  for (const [configKey, envKey] of Object.entries(mappings)) {
    if (!runtimeEnv[envKey] && config[configKey] !== undefined) {
      runtimeEnv[envKey] = String(config[configKey]);
    }
  }
  runtimeEnv.MNEMURON_CONFIG_PATH = configPath;
  return runtimeEnv;
}

export function resolveDataDir(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  return path.resolve(
    runtimeEnv.MNEMURON_SPIKE_DATA_DIR ||
      runtimeEnv.PLUGIN_DATA ||
      path.join(os.homedir(), ".mnemuron", "spike"),
  );
}

export function ensureDataDir(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function runtimeMode(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  return String(runtimeEnv.MNEMURON_MODE || "local").toLowerCase() === "remote"
    ? "remote"
    : "local";
}

export function resolveApiKey(env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  if (runtimeEnv.MNEMURON_API_KEY) return runtimeEnv.MNEMURON_API_KEY.trim();
  if (runtimeEnv.MNEMURON_API_KEY_FILE) {
    return readFileSync(path.resolve(runtimeEnv.MNEMURON_API_KEY_FILE), "utf8").trim();
  }
  throw new Error("Mnemuron remote mode requires api_key or api_key_file.");
}

export function appendJsonLine(dataDir, filename, value) {
  ensureDataDir(dataDir);
  appendFileSync(path.join(dataDir, filename), `${JSON.stringify(value)}\n`, "utf8");
}

export function readJsonLines(dataDir, filename) {
  const target = path.join(dataDir, filename);
  if (!existsSync(target)) {
    return [];
  }
  return readFileSync(target, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function readTasks(dataDir) {
  const localTasks = path.join(dataDir, "tasks.json");
  const source = existsSync(localTasks)
    ? localTasks
    : path.join(PLUGIN_ROOT, "fixtures", "tasks.json");
  return JSON.parse(readFileSync(source, "utf8"));
}

function assertSafeId(value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error("Invalid state identifier.");
  }
}

function assertScopeId(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function taskScopeDir(dataDir) {
  return path.join(dataDir, "task-scopes");
}

function confirmationIntentDir(dataDir) {
  return path.join(dataDir, "confirmation-intents");
}

function pendingResumeDir(dataDir) {
  return path.join(dataDir, "pending-resumes");
}

function injectionEventOutboxDir(dataDir) {
  return path.join(dataDir, "injection-event-outbox");
}

function deliveryReceiptOutboxDir(dataDir) {
  return path.join(dataDir, "delivery-receipt-outbox");
}

function sessionAuthorizationDir(dataDir) {
  return path.join(dataDir, "session-authorizations");
}

function mcpResumeDeliveryLockDir(dataDir) {
  return path.join(dataDir, "mcp-resume-delivery-locks");
}

function mcpDeliveryAckIntentDir(dataDir) {
  return path.join(dataDir, "mcp-delivery-ack-intents");
}

function taskScopeSessionIds(env = process.env, sessionId = null) {
  return [...new Set([
    sessionId,
    env.CODEX_THREAD_ID,
    env.CODEX_SESSION_ID,
  ].filter((value) => typeof value === "string" && value.trim()))];
}

function taskScopeFiles(dataDir) {
  const directory = taskScopeDir(ensureDataDir(dataDir));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return readdirSync(directory)
    .filter((name) => /^[a-zA-Z0-9_-]+-v[0-9]+\.json$/.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

function writeTaskScope(target, record) {
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temporary, target);
  chmodSync(target, 0o600);
}

function sessionAuthorizationPath(dataDir, sessionId) {
  assertScopeId(sessionId, "session_id");
  const directory = sessionAuthorizationDir(ensureDataDir(dataDir));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  return path.join(directory, `${sessionHash}.json`);
}

const MCP_RESUME_DELIVERY_LOCK_STALE_MS = 120_000;
const MCP_RESUME_DELIVERY_LOCK_ORPHAN_GRACE_MS = 2_000;

function mcpResumeDeliveryLockPath(dataDir, sessionId) {
  assertScopeId(sessionId, "session_id");
  const directory = mcpResumeDeliveryLockDir(ensureDataDir(dataDir));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  return path.join(directory, `${sessionHash}.lock`);
}

function processIsAlive(processId) {
  if (!Number.isInteger(processId) || processId < 1) return null;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error.code === "ESRCH" ? false : true;
  }
}

function mcpResumeDeliveryLockState(lockPath) {
  const timestamps = [];
  const owners = [];
  try {
    timestamps.push(statSync(lockPath).mtimeMs);
  } catch {
    return null;
  }
  try {
    for (const name of readdirSync(lockPath)) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(readFileSync(path.join(lockPath, name), "utf8"));
        const acquiredAt = Date.parse(record.acquired_at);
        if (Number.isFinite(acquiredAt)) timestamps.push(acquiredAt);
        if (record.token && record.session_id) {
          owners.push({ processAlive: processIsAlive(record.process_id) });
        }
      } catch {
        // A malformed owner record falls back to the lock directory timestamp.
      }
    }
  } catch {
    return null;
  }
  return {
    timestamp: Math.min(...timestamps),
    ownerCount: owners.length,
    deadOwner: owners.length > 0
      && owners.every((owner) => owner.processAlive === false),
  };
}

export function acquireMcpResumeDeliveryLock(dataDir, sessionId, {
  now = new Date(),
  staleAfterMs = MCP_RESUME_DELIVERY_LOCK_STALE_MS,
  orphanGraceMs = MCP_RESUME_DELIVERY_LOCK_ORPHAN_GRACE_MS,
  processId = process.pid,
} = {}) {
  const acquiredAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(acquiredAt.getTime())) throw new Error("Lock timestamp is invalid.");
  if (!Number.isInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new Error("staleAfterMs must be a positive integer.");
  }
  if (!Number.isInteger(orphanGraceMs) || orphanGraceMs < 1) {
    throw new Error("orphanGraceMs must be a positive integer.");
  }
  if (!Number.isInteger(processId) || processId < 1) {
    throw new Error("processId must be a positive integer.");
  }
  const lockPath = mcpResumeDeliveryLockPath(dataDir, sessionId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      chmodSync(lockPath, 0o700);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const lockState = mcpResumeDeliveryLockState(lockPath);
      const ageMs = lockState ? Date.now() - lockState.timestamp : 0;
      const recoverable = lockState?.deadOwner
        || (lockState?.ownerCount === 0 && ageMs > orphanGraceMs)
        || ageMs > staleAfterMs;
      if (!recoverable || attempt > 0) return null;
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        renameSync(lockPath, stalePath);
      } catch (renameError) {
        if (["ENOENT", "EEXIST", "ENOTEMPTY"].includes(renameError.code)) continue;
        throw renameError;
      }
      rmSync(stalePath, { recursive: true, force: true });
      continue;
    }
    const token = randomUUID();
    const ownerPath = path.join(lockPath, `${token}.json`);
    try {
      writeTaskScope(ownerPath, {
        schema_version: "mnemuron-mcp-resume-delivery-lock-v0.1",
        token,
        session_id: sessionId,
        acquired_at: acquiredAt.toISOString(),
        process_id: processId,
      });
    } catch (error) {
      rmSync(lockPath, { recursive: true, force: true });
      throw error;
    }
    return { lockPath, ownerPath, token, sessionId };
  }
  return null;
}

export function ownsMcpResumeDeliveryLock(lock) {
  if (!lock?.ownerPath || !existsSync(lock.ownerPath)) return false;
  try {
    const owner = JSON.parse(readFileSync(lock.ownerPath, "utf8"));
    return owner.token === lock.token && owner.session_id === lock.sessionId;
  } catch {
    return false;
  }
}

export function releaseMcpResumeDeliveryLock(lock) {
  if (!ownsMcpResumeDeliveryLock(lock)) return false;
  try {
    unlinkSync(lock.ownerPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  try {
    rmdirSync(lock.lockPath);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
  }
  return true;
}

export function authorizeMcpSession(dataDir, sessionId, {
  hookEventName = null,
  turnId = null,
} = {}) {
  const target = sessionAuthorizationPath(dataDir, sessionId);
  const now = new Date().toISOString();
  const existing = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")) : null;
  const record = {
    schema_version: "mnemuron-session-authorization-v0.1",
    session_id: sessionId,
    source: "codex-hook",
    first_seen_at: existing?.first_seen_at || now,
    last_seen_at: now,
    last_hook_event_name: hookEventName,
    last_turn_id: turnId,
    expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  };
  writeTaskScope(target, record);
  return record;
}

export function requireMcpSessionAuthorization(dataDir, sessionId) {
  const target = sessionAuthorizationPath(dataDir, sessionId);
  if (!existsSync(target)) {
    throw new Error("session_id was not attested by a Mnemuron ChatGPT hook.");
  }
  const record = JSON.parse(readFileSync(target, "utf8"));
  if (record.session_id !== sessionId || record.source !== "codex-hook") {
    throw new Error("session_id authorization is invalid.");
  }
  if (record.expires_at <= new Date().toISOString()) {
    throw new Error("session_id authorization expired; restart or continue the ChatGPT session.");
  }
  return record;
}

export function requireCurrentMcpSessionAuthorization(
  dataDir,
  sessionId,
  env = process.env,
) {
  const authorization = requireMcpSessionAuthorization(dataDir, sessionId);
  const runtimeEnv = loadRuntimeEnv(env);
  const runtimeSessionIds = [
    runtimeEnv.CODEX_THREAD_ID,
    runtimeEnv.CODEX_SESSION_ID,
  ].filter((value) => typeof value === "string" && value.trim());
  const distinctRuntimeSessionIds = new Set(runtimeSessionIds);
  if (distinctRuntimeSessionIds.size > 1) {
    throw new Error("ChatGPT runtime Session identifiers disagree; refusing Mnemuron delivery.");
  }
  if (runtimeSessionIds.length && runtimeSessionIds.some((value) => value !== sessionId)) {
    throw new Error("session_id does not match the current ChatGPT runtime Session.");
  }
  return authorization;
}

export function parseResumeConfirmationIntent(prompt) {
  if (typeof prompt !== "string") return null;
  let text = prompt.trim();
  if (text.startsWith("`") && text.endsWith("`") && text.length > 2) {
    text = text.slice(1, -1).trim();
  }
  const match = text.match(
    /^(?:确认|confirm|\/mnemuron\s+confirm)\s+([a-zA-Z0-9_-]+)\s+v?([1-9][0-9]*)$/i,
  );
  if (!match) return null;
  return {
    resume_id: match[1],
    preview_version: Number(match[2]),
  };
}

export function recordResumeConfirmationIntent(dataDir, payload) {
  const parsed = parseResumeConfirmationIntent(payload?.prompt);
  const sessionId = payload?.session_id;
  if (!parsed || typeof sessionId !== "string" || !sessionId.trim()) return null;
  assertSafeId(parsed.resume_id);
  assertScopeId(sessionId, "session_id");
  const directory = confirmationIntentDir(ensureDataDir(dataDir));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  const target = path.join(
    directory,
    `${parsed.resume_id}-v${parsed.preview_version}-${sessionHash}.json`,
  );
  if (existsSync(target)) return JSON.parse(readFileSync(target, "utf8"));
  const now = new Date().toISOString();
  const record = {
    schema_version: "mnemuron-confirmation-intent-v0.1",
    ...parsed,
    session_id: sessionId,
    turn_id: typeof payload.turn_id === "string" ? payload.turn_id : null,
    status: "observed",
    created_at: now,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  writeTaskScope(target, record);
  return record;
}

function confirmationIntentSessionId(dataDir, resumeId, previewVersion) {
  const directory = confirmationIntentDir(ensureDataDir(dataDir));
  if (!existsSync(directory)) return null;
  const prefix = `${resumeId}-v${previewVersion}-`;
  const now = new Date().toISOString();
  const sessionIds = new Set(
    readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")))
      .filter((record) => record.status === "observed" && record.expires_at > now)
      .map((record) => record.session_id),
  );
  return sessionIds.size === 1 ? [...sessionIds][0] : null;
}

function createTaskScope(dataDir, packet, targetSessionId, env = process.env) {
  const resumeId = packet?.resume_id || null;
  const bootstrapId = packet?.bootstrap_id || null;
  const bindingKind = bootstrapId ? "task_bootstrap" : "resume";
  const bindingId = bootstrapId || resumeId;
  const previewVersion = packet?.preview_version;
  const projectId = packet?.project?.project_id;
  const taskId = packet?.task?.task_id;
  const runtimeEnv = loadRuntimeEnv(env);
  const workstreamId = runtimeEnv.MNEMURON_DEFAULT_WORKSTREAM_ID
    || packet?.workstream?.workstream_id
    || packet?.selected_workstreams?.[0]?.workstream_id;
  assertSafeId(bindingId);
  assertScopeId(projectId, "project_id");
  assertScopeId(taskId, "task_id");
  assertScopeId(workstreamId, "workstream_id");
  assertScopeId(targetSessionId, "target_session_id");
  if (!Number.isInteger(previewVersion) || previewVersion < 1) {
    throw new Error("preview_version is invalid.");
  }
  const directory = taskScopeDir(ensureDataDir(dataDir));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const target = path.join(directory, `${bindingId}-v${previewVersion}.json`);
  if (existsSync(target)) {
    const existing = JSON.parse(readFileSync(target, "utf8"));
    if (existing.target_session_id !== targetSessionId) {
      throw new Error("Task binding is already staged for a different ChatGPT session.");
    }
    return existing;
  }
  const now = new Date().toISOString();
  const record = {
    schema_version: "mnemuron-task-scope-v0.1",
    binding_kind: bindingKind,
    binding_id: bindingId,
    resume_id: resumeId,
    bootstrap_id: bootstrapId,
    preview_version: previewVersion,
    project_id: projectId,
    task_id: taskId,
    workstream_id: workstreamId,
    target_session_id: targetSessionId,
    active_session_id: null,
    status: "pending",
    created_at: now,
    updated_at: now,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  writeTaskScope(target, record);
  return record;
}

export function stageTaskScope(dataDir, packet, env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  const [environmentSessionId] = taskScopeSessionIds(runtimeEnv);
  const targetSessionId = environmentSessionId
    || confirmationIntentSessionId(dataDir, packet?.resume_id, packet?.preview_version);
  if (!targetSessionId) return null;
  return createTaskScope(dataDir, packet, targetSessionId, runtimeEnv);
}

export function stageTaskScopeForSession(
  dataDir,
  packet,
  targetSessionId,
  env = process.env,
) {
  return createTaskScope(dataDir, packet, targetSessionId, loadRuntimeEnv(env));
}

function pendingResumeFiles(dataDir) {
  const directory = pendingResumeDir(ensureDataDir(dataDir));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return readdirSync(directory)
    .filter((name) => /^[a-zA-Z0-9_-]+-v[0-9]+\.json$/.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

function mcpDeliveryAckIntentFiles(dataDir) {
  const directory = mcpDeliveryAckIntentDir(ensureDataDir(dataDir));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return readdirSync(directory)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

export function queueResumeInjection(
  dataDir,
  packet,
  targetSessionId,
  workstreamId,
  {
    injectionMethod = "codex-hook-additional-context",
    confirmationTurnId = null,
    armed = true,
  } = {},
) {
  assertSafeId(packet?.resume_id);
  assertScopeId(targetSessionId, "target_session_id");
  assertScopeId(workstreamId, "workstream_id");
  const previewVersion = packet?.preview_version;
  if (!Number.isInteger(previewVersion) || previewVersion < 1) {
    throw new Error("preview_version is invalid.");
  }
  const directory = pendingResumeDir(ensureDataDir(dataDir));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const target = path.join(directory, `${packet.resume_id}-v${previewVersion}.json`);
  if (existsSync(target)) {
    const existing = JSON.parse(readFileSync(target, "utf8"));
    if (existing.status === "pending"
        && confirmationTurnId
        && !existing.confirmation_turn_id) {
      const updated = {
        ...existing,
        confirmation_turn_id: confirmationTurnId,
        updated_at: new Date().toISOString(),
      };
      writeTaskScope(target, updated);
      return updated;
    }
    return existing;
  }
  const now = new Date().toISOString();
  const record = {
    schema_version: "mnemuron-pending-resume-v0.1",
    resume_id: packet.resume_id,
    preview_version: previewVersion,
    attempt_id: randomUUID(),
    receipt_id: randomUUID(),
    injection_event_id: randomUUID(),
    delivery_receipt_event_id: randomUUID(),
    injection_method: injectionMethod,
    text: buildResumeInjectionText(packet),
    target_session_id: targetSessionId,
    confirmation_turn_id: confirmationTurnId,
    armed,
    armed_at: armed ? now : null,
    workstream_id: workstreamId,
    status: "pending",
    created_at: now,
    updated_at: now,
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  };
  writeTaskScope(target, record);
  return record;
}

export function armPendingResumeDeliveries(dataDir, sessionId, turnId) {
  assertScopeId(sessionId, "session_id");
  assertScopeId(turnId, "turn_id");
  const armed = [];
  const now = new Date().toISOString();
  for (const filePath of pendingResumeFiles(dataDir)) {
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    if (record.status !== "pending"
        || record.armed !== false
        || record.target_session_id !== sessionId
        || record.expires_at <= now) continue;
    const updated = {
      ...record,
      armed: true,
      armed_at: now,
      confirmation_turn_id: turnId,
      updated_at: now,
    };
    writeTaskScope(filePath, updated);
    armed.push(updated);
  }
  return armed;
}

export function claimMcpResumeDelivery(dataDir, sessionId) {
  requireMcpSessionAuthorization(dataDir, sessionId);
  const now = new Date().toISOString();
  const entries = pendingResumeFiles(dataDir).map((filePath) => ({
    filePath,
    record: JSON.parse(readFileSync(filePath, "utf8")),
  }));
  const compareDeliveryOrder = (left, right) => {
    const leftRecord = left.record;
    const rightRecord = right.record;
    const leftOrder = leftRecord.delivery_declared_at
      || leftRecord.armed_at
      || leftRecord.created_at
      || "";
    const rightOrder = rightRecord.delivery_declared_at
      || rightRecord.armed_at
      || rightRecord.created_at
      || "";
    return leftOrder.localeCompare(rightOrder)
      || String(leftRecord.created_at || "").localeCompare(String(rightRecord.created_at || ""))
      || String(leftRecord.resume_id).localeCompare(String(rightRecord.resume_id))
      || Number(leftRecord.preview_version) - Number(rightRecord.preview_version);
  };
  const inFlight = entries
    .filter(({ record }) => record.status === "in_flight"
      && record.claimed_session_id === sessionId
      && record.injection_method === "codex-mcp-delivery-receipt"
      && record.expires_at > now)
    .sort(compareDeliveryOrder)[0];
  if (inFlight) return inFlight.record;
  const pending = entries
    .filter(({ record }) => record.status === "pending"
      && record.armed === true
      && record.target_session_id === sessionId
      && record.expires_at > now)
    .sort(compareDeliveryOrder)[0];
  if (pending) {
    const claimed = {
      ...pending.record,
      schema_version: "mnemuron-pending-resume-v0.1.4",
      injection_method: "codex-mcp-delivery-receipt",
      status: "in_flight",
      claimed_session_id: sessionId,
      claimed_turn_id: null,
      delivery_declared_at: now,
      updated_at: now,
    };
    writeTaskScope(pending.filePath, claimed);
    return claimed;
  }
  return null;
}

export function hasUnreturnedMcpResumeDelivery(dataDir, sessionId) {
  assertScopeId(sessionId, "session_id");
  const now = new Date().toISOString();
  return pendingResumeFiles(dataDir).some((filePath) => {
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    if (record.expires_at <= now
        || record.injection_method !== "codex-mcp-delivery-receipt"
        || record.context_returned_at) return false;
    return (record.status === "pending" && record.target_session_id === sessionId)
      || (record.status === "in_flight" && record.claimed_session_id === sessionId);
  });
}

export function returnedMcpResumeDeliveryForSession(dataDir, sessionId) {
  assertScopeId(sessionId, "session_id");
  return pendingResumeFiles(dataDir)
    .map((filePath) => JSON.parse(readFileSync(filePath, "utf8")))
    .filter((record) => record.status === "in_flight"
      && record.injection_method === "codex-mcp-delivery-receipt"
      && record.claimed_session_id === sessionId
      && Boolean(record.context_returned_at))
    .sort((left, right) => String(left.delivery_declared_at || "").localeCompare(
      String(right.delivery_declared_at || ""),
    ) || String(left.resume_id).localeCompare(String(right.resume_id)))[0] || null;
}

export function markMcpResumeContextReturned(dataDir, receiptId) {
  const now = new Date().toISOString();
  for (const filePath of pendingResumeFiles(dataDir)) {
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    if (record.receipt_id !== receiptId || record.status !== "in_flight") continue;
    if (record.context_returned_at) return record;
    const updated = { ...record, context_returned_at: now, updated_at: now };
    writeTaskScope(filePath, updated);
    return updated;
  }
  return null;
}

export function finishMcpResumeDelivery(dataDir, sessionId, turnId, receiptId = null) {
  assertScopeId(sessionId, "session_id");
  assertScopeId(turnId, "turn_id");
  if (receiptId !== null) assertSafeId(receiptId);
  const finished = [];
  const now = new Date().toISOString();
  for (const filePath of pendingResumeFiles(dataDir)) {
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    if (record.status !== "in_flight"
        || record.injection_method !== "codex-mcp-delivery-receipt"
        || record.claimed_session_id !== sessionId
        || (receiptId !== null && record.receipt_id !== receiptId)
        || !record.context_returned_at) continue;
    const deliveredAt = now;
    const delivered = {
      ...record,
      status: "delivered",
      claimed_turn_id: turnId,
      delivery_ack_event_id: record.delivery_ack_event_id || randomUUID(),
      delivered_at: deliveredAt,
      updated_at: now,
    };
    const journaled = {
      ...delivered,
      delivery_ack_pending: true,
      delivery_ack_payload: deliveryReceiptPayload(delivered, "acknowledged", {
        turnId,
        occurredAt: deliveredAt,
      }),
      delivery_ack_reported_at: null,
    };
    writeTaskScope(filePath, journaled);
    finished.push(journaled);
  }
  return finished;
}

export function recordMcpDeliveryAcknowledgementIntent(
  dataDir,
  sessionId,
  turnId,
  occurredAt = new Date().toISOString(),
) {
  assertScopeId(sessionId, "session_id");
  assertScopeId(turnId, "turn_id");
  const delivery = returnedMcpResumeDeliveryForSession(dataDir, sessionId);
  if (!delivery) return null;
  assertSafeId(delivery.receipt_id);
  assertSafeId(delivery.resume_id);
  assertSafeId(delivery.attempt_id);
  assertScopeId(delivery.workstream_id, "workstream_id");
  const intentId = createHash("sha256")
    .update(`${sessionId}\0${delivery.attempt_id}\0${delivery.receipt_id}`)
    .digest("hex");
  const directory = mcpDeliveryAckIntentDir(ensureDataDir(dataDir));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const target = path.join(directory, `${intentId}.json`);
  if (existsSync(target)) {
    const existing = JSON.parse(readFileSync(target, "utf8"));
    if (existing.intent_id !== intentId
        || existing.session_id !== sessionId
        || existing.receipt_id !== delivery.receipt_id
        || existing.attempt_id !== delivery.attempt_id) {
      throw new Error("Mnemuron Delivery Receipt ACK intent collision.");
    }
    if (existing.turn_id !== turnId) {
      throw new Error("Mnemuron Delivery Receipt ACK intent already belongs to a different Stop turn.");
    }
    return existing;
  }
  const record = {
    schema_version: "mnemuron-mcp-delivery-ack-intent-v0.1",
    intent_id: intentId,
    session_id: sessionId,
    turn_id: turnId,
    receipt_id: delivery.receipt_id,
    resume_id: delivery.resume_id,
    preview_version: delivery.preview_version,
    attempt_id: delivery.attempt_id,
    workstream_id: delivery.workstream_id,
    status: "pending",
    created_at: occurredAt,
    applied_at: null,
    delivery_ack_event_id: null,
  };
  writeTaskScope(target, record);
  return record;
}

export function applyMcpDeliveryAcknowledgementIntents(dataDir, sessionId) {
  assertScopeId(sessionId, "session_id");
  const pending = mcpDeliveryAckIntentFiles(dataDir)
    .map((filePath) => ({
      filePath,
      record: JSON.parse(readFileSync(filePath, "utf8")),
    }))
    .filter(({ record }) => record.status === "pending" && record.session_id === sessionId)
    .sort((left, right) => String(left.record.created_at).localeCompare(
      String(right.record.created_at),
    ) || left.record.intent_id.localeCompare(right.record.intent_id));
  const applied = [];
  for (const intent of pending) {
    const entry = pendingResumeFiles(dataDir)
      .map((filePath) => ({
        filePath,
        record: JSON.parse(readFileSync(filePath, "utf8")),
      }))
      .find(({ record }) => record.receipt_id === intent.record.receipt_id);
    if (!entry
        || entry.record.resume_id !== intent.record.resume_id
        || entry.record.preview_version !== intent.record.preview_version
        || entry.record.attempt_id !== intent.record.attempt_id
        || entry.record.claimed_session_id !== sessionId
        || entry.record.workstream_id !== intent.record.workstream_id
        || entry.record.injection_method !== "codex-mcp-delivery-receipt") continue;
    let delivery = null;
    if (entry.record.status === "in_flight" && entry.record.context_returned_at) {
      [delivery] = finishMcpResumeDelivery(
        dataDir,
        sessionId,
        intent.record.turn_id,
        intent.record.receipt_id,
      );
    } else if (entry.record.status === "delivered"
        && entry.record.delivery_ack_payload?.session_id === sessionId
        && entry.record.delivery_ack_payload?.turn_id === intent.record.turn_id
        && entry.record.delivery_ack_payload?.workstream_id === intent.record.workstream_id
        && entry.record.delivery_ack_payload?.phase === "acknowledged") {
      delivery = entry.record;
    }
    if (!delivery) continue;
    const appliedAt = new Date().toISOString();
    writeTaskScope(intent.filePath, {
      ...intent.record,
      status: "applied",
      applied_at: appliedAt,
      delivery_ack_event_id: delivery.delivery_ack_payload.receipt_event_id,
    });
    applied.push(delivery);
  }
  return applied;
}

export function pendingMcpDeliveryAcknowledgementIntents(dataDir, sessionId = null) {
  if (sessionId !== null) assertScopeId(sessionId, "session_id");
  return mcpDeliveryAckIntentFiles(dataDir)
    .map((filePath) => JSON.parse(readFileSync(filePath, "utf8")))
    .filter((record) => record.status === "pending"
      && (sessionId === null || record.session_id === sessionId));
}

export function deliveryReceiptPayload(record, phase, {
  turnId = null,
  occurredAt = new Date().toISOString(),
} = {}) {
  const eventId = phase === "delivered"
    ? record.delivery_receipt_event_id
    : phase === "acknowledged"
      ? record.delivery_ack_event_id
      : record.delivery_failed_event_id || randomUUID();
  return {
    receipt_event_id: eventId,
    receipt_id: record.receipt_id,
    preview_version: record.preview_version,
    phase,
    session_id: record.claimed_session_id || record.target_session_id,
    turn_id: turnId,
    workstream_id: record.workstream_id,
    delivery_method: "codex-mcp-tool-result",
    occurred_at: occurredAt,
    ...(phase === "failed" ? {
      error_code: record.error_code || "adapter_turn_failed",
      error_message: record.error_message || null,
    } : {}),
  };
}

export function pendingMcpDeliveryAcknowledgements(dataDir) {
  return pendingResumeFiles(dataDir)
    .map((filePath) => ({
      filePath,
      record: JSON.parse(readFileSync(filePath, "utf8")),
    }))
    .filter(({ record }) => record.status === "delivered"
      && record.injection_method === "codex-mcp-delivery-receipt"
      && record.delivery_ack_pending === true
      && !record.delivery_ack_reported_at
      && record.delivery_ack_payload?.receipt_event_id
      && record.delivery_ack_payload?.phase === "acknowledged")
    .map(({ record }) => ({
      resume_id: record.resume_id,
      receipt_id: record.receipt_id,
      payload: record.delivery_ack_payload,
    }));
}

export function markMcpDeliveryAcknowledgementReported(
  dataDir,
  receiptEventId,
  reportedAt = new Date().toISOString(),
) {
  assertSafeId(receiptEventId);
  for (const filePath of pendingResumeFiles(dataDir)) {
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    if (record.delivery_ack_payload?.receipt_event_id !== receiptEventId) continue;
    if (record.delivery_ack_reported_at) return record;
    const reported = {
      ...record,
      delivery_ack_pending: false,
      delivery_ack_reported_at: reportedAt,
      updated_at: reportedAt,
    };
    writeTaskScope(filePath, reported);
    return reported;
  }
  return null;
}

export function claimResumeInjection(
  dataDir,
  sessionId,
  turnId,
  env = process.env,
  injectionMethod = null,
) {
  assertScopeId(sessionId, "session_id");
  assertScopeId(turnId, "turn_id");
  const sessionIds = new Set(taskScopeSessionIds(loadRuntimeEnv(env), sessionId));
  const now = new Date().toISOString();
  for (const filePath of pendingResumeFiles(dataDir)) {
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    if (record.status === "delivered" || record.expires_at <= now) continue;
    if (record.injection_method === "codex-mcp-delivery-receipt") continue;
    if (record.status === "in_flight"
        && record.claimed_session_id === sessionId
        && record.claimed_turn_id === turnId) return record;
    if (record.status !== "pending" || !sessionIds.has(record.target_session_id)) continue;
    if (record.confirmation_turn_id === turnId) continue;
    const claimed = {
      ...record,
      injection_method: injectionMethod || record.injection_method,
      status: "in_flight",
      claimed_session_id: sessionId,
      claimed_turn_id: turnId,
      injected_at: now,
      updated_at: now,
    };
    writeTaskScope(filePath, claimed);
    return claimed;
  }
  return null;
}

export function hasPendingResumeInjection(dataDir, sessionId, env = process.env) {
  assertScopeId(sessionId, "session_id");
  const sessionIds = new Set(taskScopeSessionIds(loadRuntimeEnv(env), sessionId));
  const now = new Date().toISOString();
  return pendingResumeFiles(dataDir).some((filePath) => {
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    return record.status === "pending"
      && record.expires_at > now
      && sessionIds.has(record.target_session_id);
  });
}

export function releaseResumeInjection(dataDir, attemptId) {
  for (const filePath of pendingResumeFiles(dataDir)) {
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    if (record.attempt_id !== attemptId || record.status !== "in_flight") continue;
    const released = {
      ...record,
      status: "pending",
      claimed_session_id: null,
      claimed_turn_id: null,
      injected_at: null,
      updated_at: new Date().toISOString(),
    };
    writeTaskScope(filePath, released);
    return released;
  }
  return null;
}

export function failResumeInjection(dataDir, attemptId, {
  errorCode = "central_attestation_unavailable",
  errorMessage = "central server did not confirm the injection declaration before context handoff.",
} = {}) {
  const now = new Date().toISOString();
  for (const filePath of pendingResumeFiles(dataDir)) {
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    if (record.attempt_id !== attemptId || record.status !== "in_flight") continue;
    const failed = {
      ...record,
      failed_event_id: record.failed_event_id || randomUUID(),
      failed_at: now,
      error_code: errorCode,
      error_message: errorMessage,
    };
    writeTaskScope(filePath, {
      ...record,
      attempt_id: randomUUID(),
      injection_event_id: randomUUID(),
      acknowledged_event_id: null,
      failed_event_id: null,
      status: "pending",
      claimed_session_id: null,
      claimed_turn_id: null,
      injected_at: null,
      updated_at: now,
    });
    return failed;
  }
  return null;
}

export function finishResumeInjection(dataDir, sessionId, turnId) {
  const finished = [];
  const now = new Date().toISOString();
  for (const filePath of pendingResumeFiles(dataDir)) {
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    if (record.status !== "in_flight"
        || record.claimed_session_id !== sessionId
        || record.claimed_turn_id !== turnId) continue;
    const delivered = {
      ...record,
      status: "delivered",
      acknowledged_event_id: record.acknowledged_event_id || randomUUID(),
      delivered_at: now,
      updated_at: now,
    };
    writeTaskScope(filePath, delivered);
    finished.push(delivered);
  }
  return finished;
}

export function recoverResumeInjections(dataDir, sessionId) {
  assertScopeId(sessionId, "session_id");
  const recovered = [];
  const now = new Date().toISOString();
  for (const filePath of pendingResumeFiles(dataDir)) {
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    if (record.status !== "in_flight"
        || record.injection_method === "codex-mcp-delivery-receipt"
        || record.claimed_session_id !== sessionId) continue;
    const failed = {
      ...record,
      failed_event_id: record.failed_event_id || randomUUID(),
      failed_at: now,
      error_code: "adapter_restarted",
      error_message: "ChatGPT restarted before the matching Stop hook acknowledged this attempt.",
    };
    writeTaskScope(filePath, {
      ...record,
      attempt_id: randomUUID(),
      injection_event_id: randomUUID(),
      acknowledged_event_id: null,
      failed_event_id: null,
      status: "pending",
      claimed_session_id: null,
      claimed_turn_id: null,
      injected_at: null,
      updated_at: now,
    });
    recovered.push(failed);
  }
  return recovered;
}

export function recoverMcpResumeDeliveries(dataDir, sessionId) {
  assertScopeId(sessionId, "session_id");
  const recovered = [];
  const now = new Date().toISOString();
  for (const filePath of pendingResumeFiles(dataDir)) {
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    if (record.status !== "in_flight"
        || record.injection_method !== "codex-mcp-delivery-receipt"
        || record.claimed_session_id !== sessionId) continue;
    const failed = {
      ...record,
      delivery_failed_event_id: record.delivery_failed_event_id || randomUUID(),
      failed_at: now,
      error_code: "adapter_restarted",
      error_message: "ChatGPT restarted before the matching Stop hook acknowledged this MCP delivery.",
    };
    writeTaskScope(filePath, {
      ...record,
      attempt_id: randomUUID(),
      receipt_id: randomUUID(),
      delivery_receipt_event_id: randomUUID(),
      delivery_ack_event_id: null,
      delivery_failed_event_id: null,
      delivery_ack_pending: false,
      delivery_ack_payload: null,
      delivery_ack_reported_at: null,
      status: "pending",
      claimed_session_id: null,
      claimed_turn_id: null,
      delivery_declared_at: null,
      context_returned_at: null,
      updated_at: now,
    });
    recovered.push(failed);
  }
  return recovered;
}

export function injectionEventPayload(record, phase, occurredAt = new Date().toISOString()) {
  const eventId = phase === "injected"
    ? record.injection_event_id
    : phase === "acknowledged"
      ? record.acknowledged_event_id
      : record.failed_event_id || randomUUID();
  return {
    event_id: eventId,
    attempt_id: record.attempt_id,
    preview_version: record.preview_version,
    phase,
    session_id: record.claimed_session_id,
    turn_id: record.claimed_turn_id,
    workstream_id: record.workstream_id,
    injection_method: record.injection_method,
    occurred_at: occurredAt,
    ...(phase === "failed" ? {
      error_code: record.error_code || "adapter_turn_failed",
      error_message: record.error_message || null,
    } : {}),
  };
}

export function pendingResumeCounts(dataDir) {
  const counts = { pending: 0, in_flight: 0, delivered: 0 };
  for (const filePath of pendingResumeFiles(dataDir)) {
    const status = JSON.parse(readFileSync(filePath, "utf8")).status;
    if (Object.hasOwn(counts, status)) counts[status] += 1;
  }
  return counts;
}

export function enqueueInjectionEvent(dataDir, resumeId, payload) {
  assertSafeId(payload?.event_id);
  assertSafeId(resumeId);
  const directory = injectionEventOutboxDir(ensureDataDir(dataDir));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const target = path.join(directory, `${payload.event_id}.json`);
  if (!existsSync(target)) writeTaskScope(target, { resume_id: resumeId, payload });
  return target;
}

export function listInjectionEventOutbox(dataDir) {
  const directory = injectionEventOutboxDir(dataDir);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name))
    .map((name) => {
      const filePath = path.join(directory, name);
      return { filePath, ...JSON.parse(readFileSync(filePath, "utf8")) };
    })
    .sort((left, right) => left.payload.occurred_at.localeCompare(right.payload.occurred_at));
}

export function enqueueDeliveryReceipt(dataDir, resumeId, payload) {
  assertSafeId(payload?.receipt_event_id);
  assertSafeId(resumeId);
  const directory = deliveryReceiptOutboxDir(ensureDataDir(dataDir));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const target = path.join(directory, `${payload.receipt_event_id}.json`);
  if (!existsSync(target)) writeTaskScope(target, { resume_id: resumeId, payload });
  return target;
}

export function listDeliveryReceiptOutbox(dataDir) {
  const directory = deliveryReceiptOutboxDir(dataDir);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name))
    .map((name) => {
      const filePath = path.join(directory, name);
      return { filePath, ...JSON.parse(readFileSync(filePath, "utf8")) };
    })
    .sort((left, right) => left.payload.occurred_at.localeCompare(right.payload.occurred_at));
}

function activateMatchingTaskScope(
  dataDir,
  sessionId,
  env,
  matches,
  {
    fallbackToActive = true,
    supersedePending = () => false,
  } = {},
) {
  const sessionIds = new Set(taskScopeSessionIds(loadRuntimeEnv(env), sessionId));
  if (!sessionIds.size) return null;
  const entries = taskScopeFiles(dataDir).map((filePath) => ({
    filePath,
    record: JSON.parse(readFileSync(filePath, "utf8")),
  }));
  const now = new Date().toISOString();
  const pending = entries
    .filter(({ record }) => record.status === "pending"
      && record.expires_at > now
      && sessionIds.has(record.target_session_id)
      && matches(record))
    .sort((left, right) => right.record.created_at.localeCompare(left.record.created_at)
      || String(left.record.binding_id || "").localeCompare(
        String(right.record.binding_id || ""),
      ))[0];
  if (!pending) {
    const matchingActive = entries
      .map(({ record }) => record)
      .filter((record) => record.status === "active"
        && matches(record)
        && (sessionIds.has(record.active_session_id)
          || sessionIds.has(record.target_session_id)))
      .sort((left, right) => String(right.activated_at || "").localeCompare(
        String(left.activated_at || ""),
      ))[0] || null;
    if (!matchingActive) {
      return fallbackToActive ? resolveTaskScope(dataDir, sessionId, env) : null;
    }
    const supersededBy = matchingActive.binding_id
      || matchingActive.bootstrap_id
      || matchingActive.resume_id;
    for (const entry of entries) {
      if (entry.record.status !== "pending"
          || !sessionIds.has(entry.record.target_session_id)
          || !supersedePending(entry.record)) continue;
      writeTaskScope(entry.filePath, {
        ...entry.record,
        status: "superseded",
        superseded_by: supersededBy,
        updated_at: now,
      });
    }
    return matchingActive;
  }
  const supersededBy = pending.record.binding_id
    || pending.record.bootstrap_id
    || pending.record.resume_id;
  for (const entry of entries) {
    const sameActiveSession = entry.record.status === "active"
      && (sessionIds.has(entry.record.active_session_id)
        || sessionIds.has(entry.record.target_session_id));
    const samePendingSession = entry.filePath !== pending.filePath
      && entry.record.status === "pending"
      && sessionIds.has(entry.record.target_session_id)
      && supersedePending(entry.record);
    if (!sameActiveSession && !samePendingSession) continue;
    writeTaskScope(entry.filePath, {
      ...entry.record,
      status: "superseded",
      superseded_by: supersededBy,
      updated_at: now,
    });
  }
  const active = {
    ...pending.record,
    status: "active",
    active_session_id: sessionId || pending.record.target_session_id,
    activated_at: now,
    updated_at: now,
  };
  writeTaskScope(pending.filePath, active);
  return active;
}

export function activateTaskScope(dataDir, sessionId, env = process.env) {
  return activateMatchingTaskScope(dataDir, sessionId, env, () => true);
}

export function activateTaskBootstrapScope(dataDir, sessionId, env = process.env) {
  return activateMatchingTaskScope(
    dataDir,
    sessionId,
    env,
    (record) => record.binding_kind === "task_bootstrap",
    { supersedePending: (record) => record.binding_kind === "task_bootstrap" },
  );
}

export function activateTaskScopeForResume(
  dataDir,
  sessionId,
  resumeId,
  previewVersion,
  env = process.env,
) {
  assertSafeId(resumeId);
  if (!Number.isInteger(previewVersion) || previewVersion < 1) {
    throw new Error("preview_version is invalid.");
  }
  return activateMatchingTaskScope(
    dataDir,
    sessionId,
    env,
    (record) => (record.binding_kind === undefined || record.binding_kind === "resume")
      && record.resume_id === resumeId
      && record.preview_version === previewVersion,
    {
      fallbackToActive: false,
      supersedePending: (record) => record.binding_kind === "task_bootstrap",
    },
  );
}

export function resolveTaskScope(dataDir, sessionId, env = process.env) {
  const sessionIds = new Set(taskScopeSessionIds(loadRuntimeEnv(env), sessionId));
  if (!sessionIds.size) return null;
  return taskScopeFiles(dataDir)
    .map((filePath) => JSON.parse(readFileSync(filePath, "utf8")))
    .filter((record) => record.status === "active"
      && (sessionIds.has(record.active_session_id) || sessionIds.has(record.target_session_id)))
    .sort((left, right) => right.activated_at.localeCompare(left.activated_at))[0] || null;
}

export function taskScopeCounts(dataDir) {
  const counts = { pending: 0, active: 0, superseded: 0 };
  for (const filePath of taskScopeFiles(dataDir)) {
    const status = JSON.parse(readFileSync(filePath, "utf8")).status;
    if (Object.hasOwn(counts, status)) counts[status] += 1;
  }
  return counts;
}

export function readPreview(dataDir, resumeId) {
  assertSafeId(resumeId);
  const target = path.join(dataDir, "previews", `${resumeId}.json`);
  if (!existsSync(target)) {
    return null;
  }
  return JSON.parse(readFileSync(target, "utf8"));
}

export function writePreview(dataDir, preview) {
  assertSafeId(preview.resume_id);
  const previewDir = path.join(ensureDataDir(dataDir), "previews");
  mkdirSync(previewDir, { recursive: true });
  const target = path.join(previewDir, `${preview.resume_id}.json`);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(preview, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

export function listPreviews(dataDir) {
  const previewDir = path.join(dataDir, "previews");
  if (!existsSync(previewDir)) {
    return [];
  }
  const indexPath = path.join(dataDir, "preview-index.jsonl");
  return existsSync(indexPath) ? readJsonLines(dataDir, "preview-index.jsonl") : [];
}

export function appendPreviewIndex(dataDir, preview) {
  appendJsonLine(dataDir, "preview-index.jsonl", {
    resume_id: preview.resume_id,
    preview_version: preview.preview_version,
    status: preview.status,
    task_id: preview.task.task_id,
    created_at: preview.created_at,
  });
}

function outboxDir(dataDir) {
  return path.join(dataDir, "outbox");
}

function outboxQuarantineDir(dataDir) {
  return path.join(dataDir, "outbox-quarantine");
}

export function enqueueOutbox(dataDir, payload) {
  const directory = outboxDir(ensureDataDir(dataDir));
  mkdirSync(directory, { recursive: true });
  const eventId = payload?.event?.event_id;
  assertSafeId(eventId);
  const target = path.join(directory, `${eventId}.json`);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload)}\n`, "utf8");
  renameSync(temporary, target);
  return target;
}

export function listOutbox(dataDir) {
  const directory = outboxDir(dataDir);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name))
    .sort()
    .map((name) => {
      const filePath = path.join(directory, name);
      return { filePath, payload: JSON.parse(readFileSync(filePath, "utf8")) };
    });
}

export function listOutboxQuarantine(dataDir) {
  const directory = outboxQuarantineDir(dataDir);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".terminal.json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")));
}

export function quarantineOutboxItem(dataDir, filePath, error) {
  const directory = outboxQuarantineDir(ensureDataDir(dataDir));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  const original = readFileSync(filePath);
  const originalName = path.basename(filePath);
  const eventId = path.basename(originalName, ".json");
  const target = path.join(directory, originalName);
  if (existsSync(target)) {
    if (!readFileSync(target).equals(original)) {
      throw new Error(`Mnemuron quarantine collision for ${eventId}.`);
    }
    unlinkSync(filePath);
  } else {
    renameSync(filePath, target);
  }
  chmodSync(target, 0o600);

  const terminal = {
    schema_version: "mnemuron-outbox-terminal-v0.1",
    event_id: eventId,
    terminal_status: "quarantined",
    reason: "permanent_http_413",
    http_status: 413,
    error: error.message,
    quarantined_at: new Date().toISOString(),
    original_file: originalName,
    original_bytes: original.length,
    original_sha256: createHash("sha256").update(original).digest("hex"),
  };
  const metadataPath = path.join(directory, `${eventId}.terminal.json`);
  if (!existsSync(metadataPath)) {
    const temporary = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(terminal, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, metadataPath);
    chmodSync(metadataPath, 0o600);
  }
  return terminal;
}

export function removeOutboxItem(filePath) {
  unlinkSync(filePath);
}

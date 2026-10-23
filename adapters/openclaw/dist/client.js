import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { RESPONSE_LIMIT, decodeResponse, protocolError, queueItems, queueSummary, flushQueue, validateAcceptance, immutableEnvelope } from './sync-protocol.mjs';

const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const HOOK_EVENT_TYPES = {
  message_received: "user_message",
  after_tool_call: "tool_result",
  agent_end: "assistant_message",
  message_sent: "delivery_result",
  session_start: "session_start",
  session_end: "session_end",
  before_compaction: "pre_compact",
  after_compaction: "post_compact",
};

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function normalizedRetention(value) {
  if (String(value ?? "30").toLowerCase() === "permanent") return "permanent";
  const days = Number(value ?? 30);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error("rawRetentionDays must be an integer >= 1 or permanent.");
  }
  return days;
}

export function resolveAdapterConfig(input = {}) {
  for (const key of [
    "serverUrl",
    "apiKeyFile",
    "outboxDir",
    "deviceId",
    "agentId",
    "agentInstanceId",
    "projectId",
    "taskId",
    "workstreamId",
  ]) {
    if (typeof input[key] !== "string" || !input[key].trim()) {
      throw new Error(`Mnemuron plugin config requires ${key}.`);
    }
  }
  const serverUrl = new URL(input.serverUrl);
  if (!input.allowInsecureHttp && serverUrl.protocol !== "https:") {
    throw new Error("Mnemuron OpenClaw adapter requires HTTPS.");
  }
  if (!['http:', 'https:'].includes(serverUrl.protocol)) {
    throw new Error("Mnemuron serverUrl must use http or https.");
  }
  for (const [key, label] of [
    ["deviceId", "deviceId"],
    ["agentId", "agentId"],
    ["agentInstanceId", "agentInstanceId"],
    ["projectId", "projectId"],
    ["taskId", "taskId"],
    ["workstreamId", "workstreamId"],
  ]) assertIdentifier(input[key], label);
  const requestTimeoutMs = Number(input.requestTimeoutMs ?? 5000);
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 250 || requestTimeoutMs > 60000) {
    throw new Error("requestTimeoutMs must be an integer from 250 to 60000.");
  }
  return {
    serverUrl,
    apiKeyFile: path.resolve(input.apiKeyFile),
    outboxDir: path.resolve(input.outboxDir),
    outboxQuarantineDir: path.resolve(
      input.outboxQuarantineDir || path.join(path.dirname(input.outboxDir), "outbox-quarantine"),
    ),
    pendingResumeDir: path.resolve(
      input.pendingResumeDir || path.join(path.dirname(input.outboxDir), "pending-resume"),
    ),
    taskScopeDir: path.resolve(
      input.taskScopeDir
        || path.join(path.dirname(input.pendingResumeDir || input.outboxDir), "task-scopes"),
    ),
    injectionEventOutboxDir: path.resolve(
      input.injectionEventOutboxDir
        || path.join(path.dirname(input.pendingResumeDir || input.outboxDir), "injection-event-outbox"),
    ),
    deviceId: input.deviceId,
    agentId: input.agentId,
    agentInstanceId: input.agentInstanceId,
    projectId: input.projectId,
    taskId: input.taskId,
    workstreamId: input.workstreamId,
    rawRetentionDays: normalizedRetention(input.rawRetentionDays),
    requestTimeoutMs,
  };
}

function jsonSafe(value) {
  const seen = new WeakSet();
  return JSON.parse(JSON.stringify(value, (_key, candidate) => {
    if (typeof candidate === "bigint") return candidate.toString();
    if (typeof candidate === "function" || typeof candidate === "symbol") return undefined;
    if (candidate && typeof candidate === "object") {
      if (seen.has(candidate)) return "[Circular]";
      seen.add(candidate);
    }
    return candidate;
  }));
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(contentText).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") return "";
  for (const key of ["text", "output_text", "content", "message"]) {
    const text = contentText(value[key]);
    if (text) return text;
  }
  return "";
}

export function formatRawAvailabilityLine(status = {}) {
  const raw = status.raw_availability;
  if (!raw) return "Raw：中心暂未提供可用性分类";
  return [
    `Raw：${raw.raw_events_available ?? 0} 可用`,
    `${raw.expired_events ?? 0} 已过期`,
    `${raw.unexplained_raw_unavailable ?? 0} 无法解释`,
    `状态 ${raw.status ?? "unknown"}`,
  ].join(" / ");
}

function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      const text = contentText(message.content ?? message);
      if (text) return text;
    }
  }
  return "";
}

function clippedText(value, limit = 800) {
  const text = contentText(value) || (typeof value === "string" ? value : "");
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 18))}…[truncated]`;
}

function compactTextItems(values, { limit = 20, textLimit = 800 } = {}) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, limit).map((value) => {
    if (typeof value === "string") return clippedText(value, textLimit);
    if (!value || typeof value !== "object") return value;
    return {
      text: clippedText(value, textLimit),
      source_event_id: value.source_event_id ?? undefined,
      source_status: value.source_status ?? undefined,
    };
  });
}

function compactCheckpoint(checkpoint) {
  return {
    checkpoint_id: checkpoint?.checkpoint_id,
    version: checkpoint?.version,
    workstream_id: checkpoint?.workstream_id,
    session_id: checkpoint?.session_id,
    created_at: checkpoint?.created_at,
    goal: clippedText(checkpoint?.goal, 1_200),
    active_request: compactTextItems([checkpoint?.active_request], { limit: 1, textLimit: 1_200 })[0],
    latest_outcome: compactTextItems([checkpoint?.latest_outcome], { limit: 1, textLimit: 1_600 })[0],
    completed_items: compactTextItems(checkpoint?.completed_items, { limit: 10, textLimit: 500 }),
    decisions: compactTextItems(checkpoint?.decisions, { limit: 10, textLimit: 500 }),
    blockers: compactTextItems(checkpoint?.blockers, { limit: 10, textLimit: 500 }),
    unfinished_items: compactTextItems(checkpoint?.unfinished_items, { limit: 10, textLimit: 500 }),
    recommended_next_steps: compactTextItems(checkpoint?.recommended_next_steps, { limit: 10, textLimit: 500 }),
    conflicts: compactTextItems(checkpoint?.conflicts, { limit: 10, textLimit: 500 }),
    source_event_ids: Array.isArray(checkpoint?.source_event_ids)
      ? checkpoint.source_event_ids.slice(0, 50)
      : [],
    provenance: checkpoint?.provenance,
    generation: checkpoint?.generation,
  };
}

function compactActivity(activity) {
  return {
    event_id: activity?.event_id,
    event_type: activity?.event_type,
    captured_at: activity?.captured_at,
    workstream_id: activity?.workstream_id,
    content: clippedText(activity?.content, 700),
    provenance: activity?.provenance,
  };
}

export function buildResumeInjectionText(packet, maxChars = 30 * 1024) {
  if (!packet || typeof packet !== "object") throw new Error("Resume Packet is invalid.");
  const context = packet.context || {};
  const summary = {
    schema_version: "mnemuron-resume-injection-v0.1",
    resume_id: packet.resume_id,
    preview_version: packet.preview_version,
    project: packet.project,
    task: packet.task,
    selected_workstreams: packet.selected_workstreams,
    branch_selection: packet.branch_selection,
    context: {
      goal: clippedText(context.goal, 2_000),
      progress: compactTextItems(context.progress, { limit: 24, textLimit: 900 }),
      decisions: compactTextItems(context.decisions, { limit: 24, textLimit: 900 }),
      blockers: compactTextItems(context.blockers, { limit: 16, textLimit: 900 }),
      next_steps: compactTextItems(context.next_steps, { limit: 24, textLimit: 900 }),
      resources: compactTextItems(context.resources, { limit: 30, textLimit: 600 }),
      conflicts: compactTextItems(context.conflicts, { limit: 16, textLimit: 900 }),
      latest_checkpoints: Array.isArray(context.latest_checkpoints)
        ? context.latest_checkpoints.slice(0, 4).map(compactCheckpoint)
        : [],
      structured_memories: Array.isArray(context.structured_memories)
        ? context.structured_memories.slice(0, 10).map((memory) => ({
          memory_id: memory?.memory_id,
          scope: memory?.scope,
          content: clippedText(memory?.content, 800),
          provenance: memory?.provenance,
        }))
        : [],
      recent_activity: Array.isArray(context.recent_activity)
        ? context.recent_activity.slice(-12).map(compactActivity)
        : [],
    },
    provenance: packet.provenance,
    injection_authorized_at: packet.injection_authorized_at,
    compaction: {
      source_packet_chars: JSON.stringify(packet).length,
      selective_context: true,
      raw_records_remain_in_mnemuron: true,
    },
  };
  const render = () => [
    "Mnemuron Resume Packet（用户已确认；选择性上下文）",
    "该 Packet 已经过 Preview 和用户显式确认，是本轮恢复的权威上下文。",
    "请直接基于它继续任务；不要为同一任务再次调用 mnemuron_preview_resume 或 mnemuron_confirm_resume。",
    JSON.stringify(summary, null, 2),
  ].join("\n");
  let rendered = render();
  if (rendered.length > maxChars) {
    summary.context.recent_activity = [];
    summary.compaction.recent_activity_omitted = true;
    rendered = render();
  }
  if (rendered.length > maxChars) {
    summary.context.structured_memories = [];
    for (const checkpoint of summary.context.latest_checkpoints) {
      checkpoint.completed_items = [];
      checkpoint.decisions = [];
      checkpoint.source_event_ids = [];
    }
    summary.compaction.checkpoint_details_reduced = true;
    rendered = render();
  }
  if (rendered.length > maxChars) {
    summary.context.progress = summary.context.progress.slice(0, 8);
    summary.context.decisions = summary.context.decisions.slice(0, 8);
    summary.context.resources = summary.context.resources.slice(0, 8);
    summary.context.latest_checkpoints = summary.context.latest_checkpoints.map((checkpoint) => ({
      checkpoint_id: checkpoint.checkpoint_id,
      version: checkpoint.version,
      workstream_id: checkpoint.workstream_id,
      session_id: checkpoint.session_id,
      created_at: checkpoint.created_at,
      latest_outcome: checkpoint.latest_outcome,
      blockers: checkpoint.blockers,
      unfinished_items: checkpoint.unfinished_items,
      recommended_next_steps: checkpoint.recommended_next_steps,
      provenance: checkpoint.provenance,
      generation: checkpoint.generation,
    }));
    summary.compaction.canonical_lists_reduced = true;
    rendered = render();
  }
  if (rendered.length > maxChars) {
    throw new Error(`Selective Resume Packet still exceeds ${maxChars} characters.`);
  }
  return rendered;
}

function stringValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function sessionKeyDetails(value) {
  const raw = stringValue(value);
  if (!raw) return { kind: "missing", raw: null };
  const parts = raw.split(":");
  if (parts[0] !== "agent" || !parts[1]) return { kind: "invalid", raw };
  if (parts.length >= 6
      && parts[2]
      && parts[3]
      && parts[4]
      && parts.slice(5).join(":")) {
    return {
      kind: "routed",
      raw,
      agent_id: parts[1],
      channel: parts[2],
      account_id: parts[3],
      peer_type: parts[4],
      peer_id: parts.slice(5).join(":"),
    };
  }
  if (parts.length === 3 && parts[2] === "main") {
    return { kind: "generic", raw, agent_id: parts[1] };
  }
  return { kind: "invalid", raw, agent_id: parts[1] };
}

function sessionKeyContext(context = {}) {
  const details = sessionKeyDetails(context.sessionKey);
  if (details.kind !== "routed") return {};
  return {
    channel: details.channel,
    account_id: details.account_id,
    peer_type: details.peer_type,
    peer_id: details.peer_id,
  };
}

function providerValue(value) {
  const text = stringValue(value)?.toLowerCase() || null;
  if (!text || /^[+-]?\d+$/u.test(text)) return null;
  const separator = text.indexOf(":");
  return separator === -1 ? text : text.slice(0, separator) || null;
}

function routeIdentity(value, provider = null) {
  const text = stringValue(value);
  if (!text) return null;
  const separator = text.indexOf(":");
  if (separator === -1) return text;
  const prefix = text.slice(0, separator).toLowerCase();
  const suffix = text.slice(separator + 1);
  if (!suffix) return text;
  if (prefix === provider || [
    "channel",
    "chat",
    "direct",
    "dm",
    "group",
    "thread",
    "user",
  ].includes(prefix)) return suffix;
  return text;
}

function recordRoute(record = {}) {
  const session = sessionKeyDetails(record.session_key);
  const provider = session.kind === "routed"
    ? session.channel
    : providerValue(record.channel);
  let senderId = routeIdentity(record.sender_id, provider);
  if (!senderId && session.kind === "routed" && session.peer_type === "direct") {
    senderId = session.peer_id;
  }
  const from = routeIdentity(record.from, provider);
  const to = routeIdentity(record.to, provider);
  let chatId = session.kind === "routed"
    ? session.peer_id
    : routeIdentity(record.chat_id || record.conversation_id, provider);
  if (!chatId && from && to && from === to) chatId = from;
  if (!chatId && senderId && to && to !== senderId) chatId = to;
  if (!chatId && senderId
      && (!from || from === senderId)
      && (!to || to === senderId)) chatId = senderId;
  return {
    provider,
    account_id: session.kind === "routed"
      ? session.account_id
      : stringValue(record.account_id) || (provider ? "default" : null),
    chat_id: chatId,
    sender_id: senderId,
    peer_type: session.kind === "routed"
      ? session.peer_type
      : stringValue(record.peer_type)
        || (chatId && senderId ? (chatId === senderId ? "direct" : "group") : null),
    thread_id: stringValue(record.message_thread_id),
  };
}

function contextRoute(context = {}) {
  const session = sessionKeyDetails(context.sessionKey);
  const provider = session.kind === "routed"
    ? session.channel
    : providerValue(context.messageProvider)
      || providerValue(context.channel)
      || providerValue(context.channelId);
  let senderId = routeIdentity(
    context.senderId || context.channelContext?.sender?.id,
    provider,
  );
  if (!senderId && session.kind === "routed" && session.peer_type === "direct") {
    senderId = session.peer_id;
  }
  let chatId = session.kind === "routed"
    ? session.peer_id
    : routeIdentity(
      context.chatId || context.channelContext?.chat?.id,
      provider,
    );
  if (!chatId) {
    const channelId = routeIdentity(context.channelId, provider);
    if (channelId && providerValue(context.channelId) !== provider) chatId = channelId;
  }
  return {
    provider,
    account_id: session.kind === "routed"
      ? session.account_id
      : stringValue(context.accountId) || (provider ? "default" : null),
    chat_id: chatId,
    sender_id: senderId,
    peer_type: session.kind === "routed"
      ? session.peer_type
      : stringValue(context.peerType || context.channelContext?.chat?.type)
        || (chatId && senderId ? (chatId === senderId ? "direct" : "group") : null),
    thread_id: stringValue(
      context.messageThreadId
        ?? context.threadId
        ?? context.channelContext?.chat?.threadId,
    ),
  };
}

function routesConflict(left, right) {
  for (const key of ["provider", "account_id", "chat_id", "sender_id", "peer_type"]) {
    if (left[key] && right[key] && left[key] !== right[key]) return true;
  }
  if ((left.thread_id || right.thread_id) && left.thread_id !== right.thread_id) return true;
  return false;
}

function routesMatch(record, context, { requireSender = false } = {}) {
  if (!record.provider || !record.account_id || !record.chat_id) return false;
  if (!context.provider || !context.account_id || !context.chat_id) return false;
  if (record.provider !== context.provider
      || record.account_id !== context.account_id
      || record.chat_id !== context.chat_id) return false;
  if (requireSender && (!record.sender_id || !context.sender_id)) return false;
  if (record.sender_id && !context.sender_id) return false;
  if (record.sender_id && record.sender_id !== context.sender_id) return false;
  if (record.peer_type && context.peer_type && record.peer_type !== context.peer_type) return false;
  if ((record.thread_id || context.thread_id) && record.thread_id !== context.thread_id) return false;
  return true;
}

function isHostUserTurn(context = {}) {
  return Boolean(
    context.trigger === "user"
      && stringValue(context.runId)
      && stringValue(context.sessionId),
  );
}

function canonicalAgentSessionKey(context = {}) {
  const session = sessionKeyDetails(context.sessionKey);
  if (!["routed", "generic"].includes(session.kind)) return null;
  if (session.kind === "generic" && !isHostUserTurn(context)) return null;
  const route = contextRoute(context);
  if (!route.provider || !route.account_id || !route.chat_id || !route.sender_id) return null;
  const peerType = route.peer_type || (route.chat_id === route.sender_id ? "direct" : "group");
  const parts = [
    "agent",
    session.agent_id || context.agentId,
    route.provider,
    route.account_id,
    peerType,
    route.chat_id,
  ];
  if (peerType !== "direct") parts.push("sender", route.sender_id);
  if (route.thread_id) parts.push("thread", route.thread_id);
  const candidate = parts.join(":");
  if (IDENTIFIER_PATTERN.test(candidate)) return candidate;
  return `agent-route:${createHash("sha256").update(candidate).digest("hex").slice(0, 32)}`;
}

function canonicalSessionIdentifier(context = {}) {
  const sessionKey = canonicalAgentSessionKey(context);
  if (!sessionKey) return null;
  const prefixed = `oc:${sessionKey}`;
  if (IDENTIFIER_PATTERN.test(prefixed)) return prefixed;
  return `oc-session:${createHash("sha256").update(sessionKey).digest("hex").slice(0, 32)}`;
}

function contextFields(context = {}) {
  const route = contextRoute(context);
  return {
    session_key: context.sessionKey || null,
    host_session_id: context.sessionId || null,
    canonical_session_id: canonicalSessionIdentifier(context),
    trigger: context.trigger || null,
    channel: route.provider,
    chat_id: route.chat_id,
    sender_id: route.sender_id,
    account_id: route.account_id,
    peer_type: route.peer_type,
    from: context.from || null,
    to: context.to || null,
    message_thread_id: route.thread_id,
  };
}

function matchesContext(record, context = {}) {
  const recordSession = sessionKeyDetails(record.session_key);
  const contextSession = sessionKeyDetails(context.sessionKey);
  const sameSessionKey = Boolean(
    recordSession.raw && contextSession.raw && recordSession.raw === contextSession.raw,
  );
  const sameRun = Boolean(record.run_id && context.runId && record.run_id === context.runId);
  const storedRoute = recordRoute(record);
  const currentRoute = contextRoute(context);

  if (sameRun) {
    return !routesConflict(storedRoute, currentRoute);
  }
  if (sameSessionKey
      && recordSession.kind === "routed"
      && contextSession.kind === "routed") {
    return !routesConflict(storedRoute, currentRoute);
  }
  if (contextSession.kind === "routed") {
    return routesMatch(storedRoute, currentRoute);
  }
  if (contextSession.kind !== "generic"
      || recordSession.kind === "invalid"
      || recordSession.kind === "missing"
      || (recordSession.kind === "generic" && !sameSessionKey)
      || !isHostUserTurn(context)) return false;
  return routesMatch(storedRoute, currentRoute, { requireSender: true });
}

export class PendingResumeStore {
  constructor(directory, {
    workstreamId = "workstream-openclaw",
    injectionMethod = "openclaw-before-prompt-build",
  } = {}) {
    this.directory = path.resolve(directory);
    this.workstreamId = workstreamId;
    this.injectionMethod = injectionMethod;
    assertIdentifier(this.workstreamId, "workstream_id");
    assertIdentifier(this.injectionMethod, "injection_method");
  }

  ensure() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  files() {
    this.ensure();
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(this.directory, name));
  }

  read(file) {
    return JSON.parse(readFileSync(file, "utf8"));
  }

  write(file, record) {
    this.ensure();
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  }

  target(resumeId, previewVersion) {
    assertIdentifier(resumeId, "resume_id");
    if (!Number.isInteger(previewVersion) || previewVersion < 1) {
      throw new Error("preview_version is invalid.");
    }
    return path.join(this.directory, `${resumeId}-v${previewVersion}.json`);
  }

  queue({ packet, text, context = {} }) {
    const target = this.target(packet.resume_id, packet.preview_version);
    if (existsSync(target)) {
      const existing = this.read(target);
      if (existing.status === "delivered") return existing;
    }
    const now = new Date().toISOString();
    const record = {
      schema_version: "mnemuron-pending-resume-v0.1",
      resume_id: packet.resume_id,
      preview_version: packet.preview_version,
      idempotency_key: `resume:${packet.resume_id}:v${packet.preview_version}`,
      attempt_id: randomUUID(),
      injection_event_id: randomUUID(),
      injection_method: this.injectionMethod,
      workstream_id: this.workstreamId,
      text,
      status: "pending",
      ...contextFields(context),
      created_at: now,
      updated_at: now,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    this.write(target, record);
    return record;
  }

  matches(record, context) {
    return matchesContext(record, context);
  }

  claim(context = {}) {
    if (!isHostUserTurn(context) || !canonicalAgentSessionKey(context)) return null;
    const now = new Date().toISOString();
    for (const file of this.files()) {
      const record = this.read(file);
      if (record.status === "delivered" || record.expires_at <= now) continue;
      if (record.status === "in_flight" && record.run_id === context.runId) return record;
      if (record.status !== "pending" || !this.matches(record, context)) continue;
      const claimed = {
        ...record,
        attempt_id: record.attempt_id || randomUUID(),
        injection_event_id: record.injection_event_id || randomUUID(),
        injection_method: record.injection_method || this.injectionMethod,
        workstream_id: record.workstream_id || this.workstreamId,
        status: "in_flight",
        run_id: context.runId || null,
        claimed_session_key: canonicalAgentSessionKey(context) || context.sessionKey || null,
        claimed_host_session_id: context.sessionId || null,
        claimed_session_id: canonicalSessionIdentifier(context) || sessionIdentifier({}, context),
        claimed_turn_id: turnIdentifier(context),
        injected_at: now,
        claimed_at: now,
        updated_at: now,
      };
      this.write(file, claimed);
      return claimed;
    }
    return null;
  }

  release(attemptId) {
    for (const file of this.files()) {
      const record = this.read(file);
      if (record.status !== "in_flight" || record.attempt_id !== attemptId) continue;
      const released = {
        ...record,
        status: "pending",
        run_id: null,
        claimed_session_key: null,
        claimed_host_session_id: null,
        claimed_session_id: null,
        claimed_turn_id: null,
        injected_at: null,
        claimed_at: null,
        updated_at: new Date().toISOString(),
      };
      this.write(file, released);
      return released;
    }
    return null;
  }

  fail(attemptId, {
    errorCode = "central_attestation_unavailable",
    errorMessage = "The Mnemuron server did not confirm the injection declaration before context handoff.",
  } = {}) {
    const now = new Date().toISOString();
    for (const file of this.files()) {
      const record = this.read(file);
      if (record.status !== "in_flight" || record.attempt_id !== attemptId) continue;
      const failed = {
        ...record,
        failed_event_id: record.failed_event_id || randomUUID(),
        failed_at: now,
        error_code: errorCode,
        error_message: errorMessage,
      };
      this.write(file, this.retryRecord(record, now));
      return { phase: "failed", record: failed };
    }
    return null;
  }

  finish(context = {}, success = true) {
    const now = new Date().toISOString();
    const finished = [];
    for (const file of this.files()) {
      const record = this.read(file);
      if (record.status !== "in_flight") continue;
      const sameRun = record.run_id && context.runId && record.run_id === context.runId;
      const currentCanonicalKey = canonicalAgentSessionKey(context);
      const sameCanonicalSession = record.claimed_session_key
        && currentCanonicalKey
        && record.claimed_session_key === currentCanonicalKey;
      const sameHostSession = record.claimed_host_session_id
        && context.sessionId
        && record.claimed_host_session_id === context.sessionId;
      if (!sameRun && !(sameCanonicalSession && sameHostSession)) continue;
      if (success) {
        const delivered = {
          ...record,
          status: "delivered",
          acknowledged_event_id: record.acknowledged_event_id || randomUUID(),
          delivered_at: now,
          updated_at: now,
        };
        this.write(file, delivered);
        finished.push({ phase: "acknowledged", record: delivered });
      } else {
        const failed = {
          ...record,
          failed_event_id: record.failed_event_id || randomUUID(),
          failed_at: now,
          error_code: "agent_turn_failed",
          error_message: "OpenClaw reported that the Agent turn did not complete successfully.",
        };
        this.write(file, this.retryRecord(record, now));
        finished.push({ phase: "failed", record: failed });
      }
    }
    return finished;
  }

  recoverInFlight() {
    const now = new Date().toISOString();
    const recovered = [];
    for (const file of this.files()) {
      const record = this.read(file);
      if (record.status !== "in_flight") continue;
      const failed = {
        ...record,
        failed_event_id: record.failed_event_id || randomUUID(),
        failed_at: now,
        error_code: "adapter_restarted",
        error_message: "OpenClaw restarted before the matching Agent end hook acknowledged this attempt.",
      };
      this.write(file, this.retryRecord(record, now));
      recovered.push({ phase: "failed", record: failed });
    }
    return recovered;
  }

  retryRecord(record, now = new Date().toISOString()) {
    return {
      ...record,
      attempt_id: randomUUID(),
      injection_event_id: randomUUID(),
      acknowledged_event_id: null,
      failed_event_id: null,
      status: "pending",
      run_id: null,
      claimed_session_key: null,
      claimed_host_session_id: null,
      claimed_session_id: null,
      claimed_turn_id: null,
      injected_at: null,
      claimed_at: null,
      updated_at: now,
    };
  }

  counts() {
    const result = { pending: 0, in_flight: 0, delivered: 0 };
    for (const file of this.files()) {
      const status = this.read(file).status;
      if (Object.hasOwn(result, status)) result[status] += 1;
    }
    return result;
  }
}

export class TaskScopeStore {
  constructor(directory) {
    this.directory = path.resolve(directory);
  }

  ensure() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  files() {
    this.ensure();
    return readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(this.directory, name));
  }

  read(file) {
    return JSON.parse(readFileSync(file, "utf8"));
  }

  write(file, record) {
    this.ensure();
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  }

  target(resumeId, previewVersion) {
    assertIdentifier(resumeId, "resume_id");
    if (!Number.isInteger(previewVersion) || previewVersion < 1) {
      throw new Error("preview_version is invalid.");
    }
    return path.join(this.directory, `${resumeId}-v${previewVersion}.json`);
  }

  stage({ packet, context = {}, workstreamId }) {
    const resumeId = packet?.resume_id;
    const previewVersion = packet?.preview_version;
    const projectId = packet?.project?.project_id;
    const taskId = packet?.task?.task_id;
    assertIdentifier(resumeId, "resume_id");
    assertIdentifier(projectId, "project_id");
    assertIdentifier(taskId, "task_id");
    assertIdentifier(workstreamId, "workstream_id");
    const target = this.target(resumeId, previewVersion);
    if (existsSync(target)) return this.read(target);
    const now = new Date().toISOString();
    const record = {
      schema_version: "mnemuron-task-scope-v0.1",
      resume_id: resumeId,
      preview_version: previewVersion,
      project_id: projectId,
      task_id: taskId,
      workstream_id: workstreamId,
      status: "pending",
      ...contextFields(context),
      created_at: now,
      updated_at: now,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    this.write(target, record);
    return record;
  }

  records() {
    return this.files().map((file) => ({ file, record: this.read(file) }));
  }

  activate(context = {}) {
    const now = new Date().toISOString();
    const records = this.records();
    const pending = records
      .filter(({ record }) => record.status === "pending"
        && record.expires_at > now
        && matchesContext(record, context))
      .sort((left, right) => right.record.created_at.localeCompare(left.record.created_at))[0];
    if (!pending) {
      const current = records
        .filter(({ record }) => record.status === "active" && matchesContext(record, context))
        .sort((left, right) => right.record.activated_at.localeCompare(left.record.activated_at))[0];
      if (!current) return null;
      if (!isHostUserTurn(context)
          || !context.runId
          || current.record.run_id === context.runId) return current.record;
      const rebound = {
        ...current.record,
        ...contextFields(context),
        run_id: context.runId,
        run_bound_at: now,
        updated_at: now,
      };
      this.write(current.file, rebound);
      return rebound;
    }
    for (const candidate of records) {
      if (candidate.record.status !== "active" || !matchesContext(candidate.record, context)) continue;
      this.write(candidate.file, {
        ...candidate.record,
        status: "superseded",
        superseded_by: pending.record.resume_id,
        updated_at: now,
      });
    }
    const active = {
      ...pending.record,
      ...contextFields(context),
      status: "active",
      run_id: context.runId || null,
      activated_at: now,
      updated_at: now,
    };
    this.write(pending.file, active);
    return active;
  }

  resolve(context = {}) {
    return this.records()
      .map(({ record }) => record)
      .filter((record) => record.status === "active" && matchesContext(record, context))
      .sort((left, right) => right.activated_at.localeCompare(left.activated_at))[0] || null;
  }

  counts() {
    const counts = { pending: 0, active: 0, superseded: 0 };
    for (const { record } of this.records()) {
      if (Object.hasOwn(counts, record.status)) counts[record.status] += 1;
    }
    return counts;
  }
}

function eventTimestamp(event) {
  const raw = Number(event?.timestamp);
  if (!Number.isFinite(raw)) return new Date().toISOString();
  const milliseconds = raw < 10_000_000_000 ? raw * 1000 : raw;
  return new Date(milliseconds).toISOString();
}

function sessionIdentifier(event, context) {
  const canonical = canonicalSessionIdentifier(context);
  if (canonical) return canonical;
  const raw = event?.sessionKey || context?.sessionKey || event?.sessionId || context?.sessionId;
  if (!raw) return `oc-session:${randomUUID()}`;
  const prefixed = `oc:${String(raw)}`;
  if (IDENTIFIER_PATTERN.test(prefixed)) return prefixed;
  return `oc-session:${createHash("sha256").update(String(raw)).digest("hex").slice(0, 32)}`;
}

function turnIdentifier(context = {}) {
  const raw = context.runId || context.turnId || context.sessionKey || context.sessionId;
  if (!raw) return `oc-turn:${randomUUID()}`;
  const text = String(raw);
  if (IDENTIFIER_PATTERN.test(text)) return text;
  return `oc-turn:${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
}

export function injectionEventPayload(record, phase) {
  const eventId = phase === "injected"
    ? record.injection_event_id
    : phase === "acknowledged"
      ? record.acknowledged_event_id
      : record.failed_event_id;
  return {
    event_id: eventId,
    attempt_id: record.attempt_id,
    preview_version: record.preview_version,
    phase,
    session_id: record.claimed_session_id,
    turn_id: record.claimed_turn_id,
    workstream_id: record.workstream_id,
    injection_method: record.injection_method,
    occurred_at: phase === "injected"
      ? record.injected_at
      : phase === "acknowledged"
        ? record.delivered_at
        : record.failed_at,
    ...(phase === "failed" ? {
      error_code: record.error_code || "agent_turn_failed",
      error_message: record.error_message || null,
    } : {}),
  };
}

function hookContent(name, event) {
  if (name === "message_received") return event?.content ?? null;
  if (name === "agent_end") {
    return lastAssistantText(event?.messages) || (event?.error ? `OpenClaw agent failed: ${event.error}` : null);
  }
  if (name === "after_tool_call") {
    return {
      tool_name: event?.toolName ?? null,
      params: event?.params ?? null,
      result: event?.result ?? null,
      error: event?.error ?? null,
      duration_ms: event?.durationMs ?? null,
    };
  }
  if (name === "message_sent") {
    return {
      content: event?.content ?? null,
      success: Boolean(event?.success),
      error: event?.error ?? null,
    };
  }
  if (name === "session_end") {
    return {
      reason: event?.reason ?? "unknown",
      message_count: event?.messageCount ?? null,
      transcript_archived: event?.transcriptArchived ?? null,
    };
  }
  return event ?? null;
}

export function buildHookEvent(name, event = {}, context = {}, inputConfig = {}, taskScope = null) {
  const config = inputConfig.serverUrl instanceof URL ? inputConfig : resolveAdapterConfig(inputConfig);
  if (!HOOK_EVENT_TYPES[name]) throw new Error(`Unsupported OpenClaw hook: ${name}`);
  const model = [context.modelProviderId, context.modelId].filter(Boolean).join("/") || null;
  return {
    schema_version: "0.1.0",
    event_id: randomUUID(),
    event_type: HOOK_EVENT_TYPES[name],
    hook_event_name: `OpenClaw:${name}`,
    captured_at: eventTimestamp(event),
    project_id: taskScope?.project_id || config.projectId,
    task_id: taskScope?.task_id || config.taskId,
    workstream_id: taskScope?.workstream_id || config.workstreamId,
    session_id: taskScope?.canonical_session_id || sessionIdentifier(event, context),
    turn_id: event.runId || context.runId || null,
    cwd: context.workspaceDir || null,
    model,
    tool_name: event.toolName || null,
    tool_use_id: event.toolCallId || null,
    content: hookContent(name, event),
    provenance: {
      device_id: config.deviceId,
      agent_id: config.agentId,
      agent_instance_id: config.agentInstanceId,
      identity_status: "configured",
    },
    capture_capability: {
      user_messages: true,
      assistant_messages: true,
      tool_events: true,
      session_lifecycle: true,
      transcript_parser_used: false,
      source: "openclaw-native-plugin-hooks",
    },
    raw_hook_payload: jsonSafe({
      event,
      context: {
        runId: context.runId,
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        sessionId: context.sessionId,
        workspaceDir: context.workspaceDir,
        modelProviderId: context.modelProviderId,
        modelId: context.modelId,
        messageProvider: context.messageProvider,
        channelId: context.channelId,
        chatId: context.chatId,
        senderId: context.senderId,
        mnemuron_task_scope: taskScope ? {
          schema_version: taskScope.schema_version,
          source: "confirmed-resume",
          resume_id: taskScope.resume_id,
          preview_version: taskScope.preview_version,
          project_id: taskScope.project_id,
          task_id: taskScope.task_id,
          workstream_id: taskScope.workstream_id,
          activated_at: taskScope.activated_at,
        } : { source: "adapter-default" },
      },
    }),
  };
}

export class MnemuronClient {
  constructor(inputConfig, retryOptions = {}) {
    this.config = inputConfig.serverUrl instanceof URL ? inputConfig : resolveAdapterConfig(inputConfig);
    this.retryOptions = retryOptions;
  }

  readApiKey() {
    const stats = statSync(this.config.apiKeyFile);
    if ((stats.mode & 0o077) !== 0) {
      throw new Error("Mnemuron API key file must not be readable by group or others.");
    }
    const apiKey = readFileSync(this.config.apiKeyFile, "utf8").trim();
    if (!apiKey.startsWith("mnm_")) throw new Error("Mnemuron API key file is invalid.");
    return apiKey;
  }

  async request(method, endpoint, body = undefined, signal = undefined) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      const target = new URL(endpoint, this.config.serverUrl);
      if (target.origin !== this.config.serverUrl.origin) throw protocolError('REDIRECT_BLOCKED');
      const response = await fetch(target, {
        method,
        redirect: 'manual',
        signal: combinedSignal,
        headers: {
          authorization: `Bearer ${this.readApiKey()}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let size=0;const chunks=[];
      for await (const chunk of response.body || []) {
        size+=chunk.length;
        if(size>RESPONSE_LIMIT){controller.abort();throw protocolError('RESPONSE_TOO_LARGE',response.status);}
        chunks.push(chunk);
      }
      return decodeResponse(response.status,Buffer.concat(chunks).toString('utf8'),response.headers.get('retry-after'));
    } finally {
      clearTimeout(timeout);
    }
  }

  async remember(body, signal = undefined) {
    const operationId = body.operation_id === undefined ? randomUUID() : body.operation_id;
    if (typeof operationId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(operationId)) {
      throw new Error("operation_id must be a non-empty ASCII identifier of at most 128 characters.");
    }
    const payload = { ...body, operation_id: operationId };
    try {
      return await this.request("POST", "/v1/memories", payload, signal);
    } catch (error) {
      throw Object.assign(new Error(
        `Memory save not confirmed; retry the same payload with operation_id=${operationId}. ${error.message}`,
        { cause: error },
      ), { operation_id: operationId, statusCode: error.statusCode, responseData: error.responseData });
    }
  }

  ensureOutbox() {
    mkdirSync(this.config.outboxDir, { recursive: true, mode: 0o700 });
    chmodSync(this.config.outboxDir, 0o700);
  }

  outboxFiles() {
    this.ensureOutbox();
    return readdirSync(this.config.outboxDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(this.config.outboxDir, name));
  }

  queueEnvelope(envelope) {
    this.ensureOutbox();
    assertIdentifier(envelope.event.event_id, 'event_id');
    const target = path.join(this.config.outboxDir, `${envelope.event.event_id}.json`);
    return immutableEnvelope(target, envelope);
  }

  ensureOutboxQuarantine() {
    mkdirSync(this.config.outboxQuarantineDir, { recursive: true, mode: 0o700 });
    chmodSync(this.config.outboxQuarantineDir, 0o700);
  }

  outboxQuarantineFiles() {
    this.ensureOutboxQuarantine();
    return readdirSync(this.config.outboxQuarantineDir)
      .sort()
      .map((name) => path.join(this.config.outboxQuarantineDir, name));
  }

  quarantinedOutboxItems() {
    return this.outboxQuarantineFiles()
      .filter((file) => file.endsWith(".terminal.json"))
      .map((file) => JSON.parse(readFileSync(file, "utf8")));
  }

  quarantineOutboxItem(file, error) {
    this.ensureOutboxQuarantine();
    const original = readFileSync(file);
    const originalName = path.basename(file);
    const eventId = path.basename(originalName, ".json");
    const target = path.join(this.config.outboxQuarantineDir, originalName);
    if (existsSync(target)) {
      if (!readFileSync(target).equals(original)) {
        throw new Error(`Mnemuron quarantine collision for ${eventId}.`);
      }
      unlinkSync(file);
    } else {
      renameSync(file, target);
    }
    chmodSync(target, 0o600);

    const terminal = {
      schema_version: "mnemuron-outbox-terminal-v0.1",
      event_id: eventId,
      terminal_status: "quarantined",
      reason: `permanent_http_${error.statusCode}`,
      http_status: error.statusCode,
      error: error.errorCode || `HTTP_${error.statusCode}`,
      quarantined_at: new Date().toISOString(),
      original_file: originalName,
      original_bytes: original.length,
      original_sha256: createHash("sha256").update(original).digest("hex"),
    };
    const metadataPath = path.join(this.config.outboxQuarantineDir, `${eventId}.terminal.json`);
    if (!existsSync(metadataPath)) {
      const temporary = `${metadataPath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(terminal, null, 2)}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, metadataPath);
      chmodSync(metadataPath, 0o600);
    }
    return terminal;
  }

  async flushOutbox(signal = undefined) {
    return flushQueue(queueItems(this.config.outboxDir,'event'),{...this.retryOptions,root:path.dirname(this.config.outboxDir),credential:this.config.serverUrl.href+'|'+this.readApiKey(),predecessors:queueItems(this.config.injectionEventOutboxDir,'injection'),send:item=>this.request('POST','/v1/events',item.payload,signal),quarantine:(item,error)=>this.quarantineOutboxItem(item.filePath,error)});
  }

  ensureInjectionEventOutbox() {
    mkdirSync(this.config.injectionEventOutboxDir, { recursive: true, mode: 0o700 });
    chmodSync(this.config.injectionEventOutboxDir, 0o700);
  }

  injectionEventOutboxFiles() {
    this.ensureInjectionEventOutbox();
    return readdirSync(this.config.injectionEventOutboxDir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => path.join(this.config.injectionEventOutboxDir, name));
  }

  queueInjectionEvent(resumeId, payload) {
    assertIdentifier(resumeId, "resume_id");
    assertIdentifier(payload?.event_id, "event_id");
    this.ensureInjectionEventOutbox();
    const target = path.join(this.config.injectionEventOutboxDir, `${payload.event_id}.json`);
    return immutableEnvelope(target, {resume_id: resumeId, payload});
  }

  async flushInjectionEventOutbox(signal = undefined) {
    return flushQueue(queueItems(this.config.injectionEventOutboxDir,'injection'),{...this.retryOptions,root:path.dirname(this.config.outboxDir),credential:this.config.serverUrl.href+'|'+this.readApiKey(),predecessors:queueItems(this.config.outboxDir,'event'),send:item=>this.request('POST',`/v1/resume/${encodeURIComponent(item.resume_id)}/injection-events`,item.payload,signal)});
  }

  async submitInjectionRecord(record, phase, signal = undefined) {
    const payload = injectionEventPayload(record, phase);
    const result = await this.request(
      "POST",
      `/v1/resume/${encodeURIComponent(record.resume_id)}/injection-events`,
      payload,
      signal,
    );
    validateAcceptance('injection', {resume_id:record.resume_id, payload}, result);
    return result;
  }

  queueInjectionRecord(record, phase) {
    return this.queueInjectionEvent(
      record.resume_id,
      injectionEventPayload(record, phase),
    );
  }

  async submitEvent(event, signal = undefined) {
    const envelope = { event, raw_retention_days: this.config.rawRetentionDays };
    this.queueEnvelope(envelope);
    try {
      const result=await this.flushOutbox(signal);
      const quarantined=existsSync(path.join(this.config.outboxQuarantineDir,`${event.event_id}.json`));
      return {delivery:quarantined?'quarantined':existsSync(path.join(this.config.outboxDir,`${event.event_id}.json`))?'queued':'synchronized',result:result.last_response,flush:result};
    } catch (error) {
      this.queueEnvelope(envelope);
      return { delivery: "queued", error: error.message };
    }
  }

  async status(signal = undefined) {
    const lastFlush={status:'not_run_read_only'},lastInjectionEventFlush=lastFlush;
    const queuedEvents = this.outboxFiles().length;
    const quarantinedEvents = this.quarantinedOutboxItems().length;
    const queuedInjectionEvents = this.injectionEventOutboxFiles().length;
    const status = await this.request("GET", "/v1/status", undefined, signal);
    const pendingResumeInjections = new PendingResumeStore(this.config.pendingResumeDir).counts();
    const taskScopeBindings = new TaskScopeStore(this.config.taskScopeDir).counts();
    return {
      ...status,
      server_reachable: true,
      adapter: {
        mode: "openclaw-native-v0.1",
        queued_events: queuedEvents,
        quarantined_events: quarantinedEvents,
        queued_injection_events: queuedInjectionEvents,
        sync_status: queuedEvents || queuedInjectionEvents
          ? "pending"
          : quarantinedEvents ? "degraded" : "synchronized",
        injection_event_sync_status: queuedInjectionEvents ? "pending" : "synchronized",
        last_flush: lastFlush,
        sync_state:queueSummary([...queueItems(this.config.outboxDir,'event'),...queueItems(this.config.injectionEventOutboxDir,'injection')],Date.now(),path.dirname(this.config.outboxDir)),
        last_injection_event_flush: lastInjectionEventFlush,
        local_identity: {
          device_id: this.config.deviceId,
          agent_id: this.config.agentId,
          agent_instance_id: this.config.agentInstanceId,
        },
        pending_resume_injections: pendingResumeInjections,
        task_scope_bindings: taskScopeBindings,
      },
    };
  }
}

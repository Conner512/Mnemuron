import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  RESOLVER_VERSION,
  normalizeResolverText,
  resolveProjectCandidates,
  resolveTaskCandidates,
} from "./resolver.mjs";
import {
  RECONCILIATION_SCHEMA_VERSION,
  applyOperations,
  buildDerivedOperations,
  buildRequestedOperations,
  canonicalTaskHash,
  canonicalTaskSnapshot,
  detectOperationConflicts,
  mergeOperations,
  reconciliationFingerprint,
} from "./reconciliation.mjs";

const DEFAULT_USER_ID = "user-local";
const DEFAULT_AGENT_SCOPES = [
  "capture:write",
  "memory:read",
  "memory:write",
  "resume:read",
  "resume:confirm",
  "task:bootstrap:preview",
  "task:bootstrap:confirm",
  "task:reconcile:read",
  "task:reconcile:confirm",
];
const ADMIN_SCOPES = [
  "audit:read",
  "admin:devices",
  "admin:retention",
  "admin:tasks",
  "project:bootstrap:preview",
  "project:bootstrap:confirm",
  "task:bootstrap:preview",
  "task:bootstrap:confirm",
  "task:reconcile:read",
  "task:reconcile:confirm",
];

function asJson(value) {
  return JSON.stringify(value ?? null);
}

function fromJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  return JSON.parse(value);
}

function nowIso() {
  return new Date().toISOString();
}

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const CHECKPOINT_TRIGGER_TYPES = new Set(["assistant_message", "session_end"]);
const CHECKPOINT_EVENT_LIMIT = 50;
const CHECKPOINT_TEXT_LIMIT = 1_200;
const RESUME_PREVIEW_TTL_MS = 30 * 60_000;
const TASK_BOOTSTRAP_SCHEMA_VERSION = "task-bootstrap-binding-v0.1";
const TASK_BOOTSTRAP_PREVIEW_TTL_MS = 30 * 60_000;
const PROJECT_BOOTSTRAP_SCHEMA_VERSION = "project-bootstrap-initial-task-v0.1";
const PROJECT_CONTEXT_SCHEMA_VERSION = "project-memory-preview-v0.1";
const TASK_BRANCHES_SCHEMA_VERSION = "task-branches-preview-v0.1";
const READ_PREVIEW_RESPONSE_BUDGET_BYTES = 128 * 1024;
const PROJECT_CONTEXT_TASK_LIMIT = 10;
const PROJECT_CONTEXT_MEMORY_LIMIT = 10;
const PROJECT_CONTEXT_ACTIVITY_LIMIT = 20;
const RESUME_INJECTION_PHASES = new Set(["injected", "acknowledged", "failed"]);
const RESUME_DELIVERY_RECEIPT_PHASES = new Set(["delivered", "acknowledged", "failed"]);
const STRUCTURED_MEMORY_GENERATION_METHOD = "strict-labeled-statements-v0.1";
const STRUCTURED_MEMORY_RETRIEVAL_SCHEMA_VERSION = "structured-memory-retrieval-v0.1";
const STRUCTURED_MEMORY_LIFECYCLE_SCHEMA_VERSION = "structured-memory-lifecycle-v0.1";
const STRUCTURED_MEMORY_RETRIEVAL_CANDIDATE_LIMIT = 500;
const STRUCTURED_MEMORY_RETRIEVAL_RESULT_LIMIT = 20;
const STRUCTURED_MEMORY_TYPES = new Set([
  "goal",
  "fact",
  "constraint",
  "decision",
  "completed",
  "blocker",
  "remaining",
  "next_step",
]);
const STRUCTURED_MEMORY_STATUSES = new Set(["active", "superseded", "retracted"]);

function textContent(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    for (const key of ["text", "content", "message", "summary", "output"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }
  }
  return "";
}

function compactText(value, limit = CHECKPOINT_TEXT_LIMIT) {
  const text = textContent(value).replace(/\s+/gu, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function boundedStrings(values, { limit = 4, textLimit = 240 } = {}) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, limit).map((value) => {
    if (typeof value === "string") return compactText(value, textLimit);
    return JSON.parse(JSON.stringify(value, (_key, nested) =>
      typeof nested === "string" ? compactText(nested, textLimit) : nested));
  });
}

function compactCheckpointPreview(checkpoint) {
  if (!checkpoint) return null;
  const item = (value) => {
    if (!value) return value;
    if (typeof value === "string") return compactText(value, 300);
    return {
      ...value,
      ...(typeof value.text === "string" ? { text: compactText(value.text, 300) } : {}),
    };
  };
  return {
    checkpoint_id: checkpoint.checkpoint_id,
    task_id: checkpoint.task_id,
    project_id: checkpoint.project_id,
    workstream_id: checkpoint.workstream_id,
    session_id: checkpoint.session_id,
    version: checkpoint.version,
    status: checkpoint.status,
    goal: compactText(checkpoint.goal, 400),
    active_request: item(checkpoint.active_request),
    latest_outcome: item(checkpoint.latest_outcome),
    completed_items: boundedStrings(checkpoint.completed_items, { limit: 3, textLimit: 240 }),
    decisions: boundedStrings(checkpoint.decisions, { limit: 3, textLimit: 240 }),
    blockers: boundedStrings(checkpoint.blockers, { limit: 3, textLimit: 240 }),
    unfinished_items: boundedStrings(checkpoint.unfinished_items, { limit: 3, textLimit: 240 }),
    recommended_next_steps: boundedStrings(checkpoint.recommended_next_steps, {
      limit: 3,
      textLimit: 240,
    }),
    source_event_ids: (checkpoint.source_event_ids || []).slice(0, 20),
    provenance: checkpoint.provenance,
    generation: {
      method: checkpoint.generation?.method,
      confidence: checkpoint.generation?.confidence,
      confidence_label: checkpoint.generation?.confidence_label,
      trigger_type: checkpoint.generation?.trigger_type,
      warnings: boundedStrings(checkpoint.generation?.warnings, { limit: 5, textLimit: 240 }),
    },
    created_at: checkpoint.created_at,
  };
}

function compactWorkstream(workstream) {
  if (typeof workstream === "string") {
    return { workstream_id: compactText(workstream, 160), name: compactText(workstream, 160) };
  }
  return {
    workstream_id: workstream?.workstream_id,
    name: compactText(workstream?.name, 200),
    status: workstream?.status,
    description: compactText(workstream?.description, 300),
    agent_id: workstream?.agent_id,
    device_id: workstream?.device_id,
    agent_instance_id: workstream?.agent_instance_id,
    updated_at: workstream?.updated_at,
  };
}

function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

function finalizeReadPreview(preview, projection) {
  preview.projection = {
    response_budget_bytes: READ_PREVIEW_RESPONSE_BUDGET_BYTES,
    ...projection,
    fallback_compaction_applied: false,
    serialized_bytes: 0,
  };
  let bytes = serializedBytes(preview);
  if (bytes > READ_PREVIEW_RESPONSE_BUDGET_BYTES) {
    preview.recent_activity = preview.recent_activity.slice(0, 10).map((activity) => ({
      ...activity,
      content: activity.content === null ? null : compactText(activity.content, 120),
      content_truncated: activity.content !== null,
    }));
    preview.structured_memories = preview.structured_memories.slice(0, 5).map((memory) => ({
      ...memory,
      content: compactText(memory.content, 160),
      content_truncated: true,
    }));
    if (Array.isArray(preview.tasks)) {
      preview.tasks = preview.tasks.map((task) => ({
        ...task,
        goal: compactText(task.goal, 240),
        progress: boundedStrings(task.progress, { limit: 2, textLimit: 120 }),
        decisions: boundedStrings(task.decisions, { limit: 2, textLimit: 120 }),
        blockers: boundedStrings(task.blockers, { limit: 2, textLimit: 120 }),
        next_steps: boundedStrings(task.next_steps, { limit: 2, textLimit: 120 }),
        resources: boundedStrings(task.resources, { limit: 2, textLimit: 120 }),
        workstreams: (task.workstreams || []).slice(0, 4),
        conflicts: boundedStrings(task.conflicts, { limit: 2, textLimit: 160 }),
        latest_checkpoints: (task.latest_checkpoints || []).slice(0, 2).map((checkpoint) => ({
          checkpoint_id: checkpoint.checkpoint_id,
          workstream_id: checkpoint.workstream_id,
          session_id: checkpoint.session_id,
          version: checkpoint.version,
          status: checkpoint.status,
          latest_outcome: checkpoint.latest_outcome,
          provenance: checkpoint.provenance,
          created_at: checkpoint.created_at,
        })),
      }));
    }
    if (Array.isArray(preview.branches)) {
      preview.branches = preview.branches.slice(0, 12).map((branch) => ({
        ...branch,
        latest_checkpoint: branch.latest_checkpoint
          ? {
              checkpoint_id: branch.latest_checkpoint.checkpoint_id,
              workstream_id: branch.latest_checkpoint.workstream_id,
              session_id: branch.latest_checkpoint.session_id,
              version: branch.latest_checkpoint.version,
              status: branch.latest_checkpoint.status,
              latest_outcome: branch.latest_checkpoint.latest_outcome,
              provenance: branch.latest_checkpoint.provenance,
              created_at: branch.latest_checkpoint.created_at,
            }
          : null,
      }));
    }
    preview.projection.fallback_compaction_applied = true;
    bytes = serializedBytes(preview);
  }
  if (bytes > READ_PREVIEW_RESPONSE_BUDGET_BYTES) {
    throw new Error("Read preview exceeded its response budget after bounded compaction.");
  }
  for (let index = 0; index < 3; index += 1) {
    const measured = serializedBytes(preview);
    if (preview.projection.serialized_bytes === measured) break;
    preview.projection.serialized_bytes = measured;
  }
  return preview;
}

function uniqueByText(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normalize(typeof item === "string" ? item : item?.text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function statements(value) {
  return textContent(value)
    .split(/(?:\r?\n)+|(?<=[。！？!?;；])\s*/u)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, "").trim())
    .filter(Boolean)
    .slice(0, 40);
}

function derivedItem(text, eventId, category, confidence = "medium") {
  return {
    text: compactText(text, 500),
    source: "derived_from_event",
    source_event_id: eventId,
    category,
    confidence,
  };
}

function canonicalItems(values, category) {
  return (Array.isArray(values) ? values : []).map((value) => ({
    text: typeof value === "string" ? value : JSON.stringify(value),
    source: "task_snapshot",
    source_event_id: null,
    category,
    confidence: "high",
  }));
}

function classifyCheckpointStatements(events) {
  const completed = [];
  const decisions = [];
  const blockers = [];
  const nextSteps = [];
  const decisionPattern = /(?:决定|确认采用|选择采用|确定使用|必须|不再|decision|decided|selected|must\b)/iu;
  const completedPattern = /(?:已完成|完成了|已通过|通过验证|验证成功|已部署|部署完成|已配置|配置完成|已修复|成功完成|completed|verified|deployed|configured|fixed|passed)/iu;
  const blockerPattern = /(?:阻塞|失败|无法|报错|错误|未通过|blocked|failed|cannot|error|unavailable)/iu;
  const blockerNegationPattern = /(?:无阻塞|没有阻塞|未发现阻塞|0\s*blockers?|no\s+blockers?|not\s+blocked|没有失败|均通过)/iu;
  const nextPattern = /(?:下一步|接下来|待完成|仍需|还需要|需要继续|TODO|next\s+steps?|remaining|remains?\s+to)/iu;

  for (const event of events) {
    const content = event.expired_at ? null : fromJson(event.content, null);
    for (const line of statements(content)) {
      if (completedPattern.test(line)) completed.push(derivedItem(line, event.event_id, "completed"));
      if (decisionPattern.test(line)) decisions.push(derivedItem(line, event.event_id, "decision"));
      if (blockerPattern.test(line) && !blockerNegationPattern.test(line)) {
        blockers.push(derivedItem(line, event.event_id, "blocker"));
      }
      if (nextPattern.test(line)) nextSteps.push(derivedItem(line, event.event_id, "next_step"));
    }
  }
  return {
    completed: uniqueByText(completed).slice(0, 12),
    decisions: uniqueByText(decisions).slice(0, 12),
    blockers: uniqueByText(blockers).slice(0, 12),
    nextSteps: uniqueByText(nextSteps).slice(0, 12),
  };
}

function checkpointConfidence({ activeRequest, latestOutcome, classified }) {
  let score = 0.35;
  if (activeRequest) score += 0.12;
  if (latestOutcome) score += 0.18;
  if (classified.completed.length || classified.decisions.length ||
      classified.blockers.length || classified.nextSteps.length) score += 0.1;
  const bounded = Math.min(Number(score.toFixed(2)), 0.75);
  return {
    score: bounded,
    label: bounded >= 0.7 ? "medium" : "low",
  };
}

function structuredMemoryStatements(events) {
  const typeByLabel = new Map([
    ["目标", "goal"],
    ["goal", "goal"],
    ["事实", "fact"],
    ["fact", "fact"],
    ["结论", "fact"],
    ["约束", "constraint"],
    ["constraint", "constraint"],
    ["决定", "decision"],
    ["决策", "decision"],
    ["decision", "decision"],
    ["已完成", "completed"],
    ["完成", "completed"],
    ["completed", "completed"],
    ["阻塞", "blocker"],
    ["blocker", "blocker"],
    ["未完成", "remaining"],
    ["remaining", "remaining"],
    ["todo", "remaining"],
    ["下一步", "next_step"],
    ["next step", "next_step"],
    ["next steps", "next_step"],
  ]);
  const labelPattern = /^(目标|goal|事实|fact|结论|约束|constraint|决定|决策|decision|已完成|完成|completed|阻塞|blocker|未完成|remaining|todo|下一步|next\s+steps?)(?:\s*[\[（(]([^\]）)]{1,120})[\]）)])?\s*[:：]\s*(.+)$/iu;
  const emptyBlockerPattern = /^(?:无|没有|无阻塞|none|no|nil|n\/a|-)$/iu;
  const extracted = [];
  for (const event of events) {
    if (!["user_message", "assistant_message"].includes(event.event_type)) continue;
    if (event.expired_at) continue;
    const decoded = event.decoded_content === undefined
      ? fromJson(event.content, null)
      : event.decoded_content;
    for (const line of statements(decoded)) {
      const match = line.match(labelPattern);
      if (!match) continue;
      const memoryType = typeByLabel.get(match[1].toLocaleLowerCase());
      const topic = match[2] ? compactText(match[2], 120) : null;
      const content = compactText(match[3], 1_000);
      if (!memoryType || !content) continue;
      if (memoryType === "blocker" && emptyBlockerPattern.test(content)) continue;
      const fromUser = event.event_type === "user_message";
      extracted.push({
        memory_type: memoryType,
        topic,
        topic_key: topic ? normalize(topic) : null,
        content,
        source_event_ids: [event.event_id],
        generation_method: STRUCTURED_MEMORY_GENERATION_METHOD,
        confidence: fromUser ? 0.95 : 0.75,
        confidence_label: fromUser ? "high" : "medium",
        warnings: fromUser
          ? []
          : ["Assistant-authored memory has not been promoted to canonical Task state."],
      });
    }
  }
  return extracted;
}

function structuredMemoryFingerprint({
  userId,
  scope,
  projectId,
  taskId,
  workstreamId,
  sessionId,
  memoryType,
  topicKey,
  content,
}) {
  return createHash("sha256").update(asJson({
    schema: "automatic-structured-memory-v0.1",
    user_id: userId,
    scope,
    project_id: projectId || null,
    task_id: taskId || null,
    workstream_id: workstreamId || null,
    session_id: sessionId || null,
    memory_type: memoryType,
    topic_key: topicKey || null,
    content: normalize(content),
  })).digest("hex");
}

function memorySearchUnits(value) {
  const normalized = normalize(value);
  const units = new Set(normalized.split(/\s+/u).filter((part) => part.length >= 2));
  for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) || []) {
    const characters = [...run];
    for (const character of characters) units.add(character);
    for (let index = 0; index < characters.length - 1; index += 1) {
      units.add(`${characters[index]}${characters[index + 1]}`);
    }
  }
  return { normalized, units };
}

function memoryLexicalScore(query, memory) {
  const queryParts = memorySearchUnits(query);
  const contentParts = memorySearchUnits(`${memory.topic || ""} ${memory.content}`);
  if (!queryParts.normalized || !contentParts.normalized) return 0;
  if (queryParts.normalized === contentParts.normalized) return 1;
  if (contentParts.normalized.includes(queryParts.normalized)) return 0.92;
  if (queryParts.normalized.includes(contentParts.normalized)) return 0.82;
  if (!queryParts.units.size) return 0;
  let matched = 0;
  for (const unit of queryParts.units) {
    if (contentParts.units.has(unit)) matched += 1;
  }
  return matched / queryParts.units.size;
}

function memoryScopeScore(memory) {
  return {
    session: 1,
    workstream: 0.9,
    task: 0.8,
    project: 0.7,
    user: 0.6,
  }[memory.scope] || 0.5;
}

function memoryRecencyScore(memory, currentTime = Date.now()) {
  const timestamp = Date.parse(memory.updated_at || memory.created_at);
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (currentTime - timestamp) / 86_400_000);
  return Math.max(0, 1 - (ageDays / 365));
}

function hashKey(apiKey) {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

function makeApiKey() {
  return `mnm_${randomBytes(32).toString("base64url")}`;
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new ValidationError(`${label} is invalid.`);
  }
}

function assertStringArray(value, label, { maxItems = 50, maxLength = 2_048 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems
      || value.some((item) => typeof item !== "string" || !item.trim() || item.length > maxLength)) {
    throw new ValidationError(`${label} must be an array of non-empty strings.`);
  }
}

function requiredBoundedString(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new ValidationError(`${label} is required and must be at most ${maxLength} characters.`);
  }
  return value.trim();
}

function taskBootstrapIdentifier(userId, projectId, title) {
  const slug = normalizeResolverText(title)
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);
  const digest = createHash("sha256")
    .update(`${userId}\n${projectId}\n${normalizeResolverText(title)}`, "utf8")
    .digest("hex")
    .slice(0, 10);
  return `task-${slug || "new"}-${digest}`;
}

function projectBootstrapIdentifier(userId, name) {
  const slug = normalizeResolverText(name)
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72);
  const digest = createHash("sha256")
    .update(`${userId}\n${normalizeResolverText(name)}`, "utf8")
    .digest("hex")
    .slice(0, 10);
  return `project-${slug || "new"}-${digest}`;
}

function taskBootstrapSimilarity(title, task) {
  const proposed = normalizeResolverText(title);
  const names = [task.title, ...(task.aliases || [])]
    .map(normalizeResolverText)
    .filter(Boolean);
  if (names.includes(proposed)) return 1;
  if (proposed.length >= 4 && names.some((name) =>
    name.includes(proposed) || proposed.includes(name))) return 0.9;
  const proposedTokens = new Set(proposed.split(" ").filter(Boolean));
  let best = 0;
  for (const name of names) {
    const nameTokens = new Set(name.split(" ").filter(Boolean));
    const union = new Set([...proposedTokens, ...nameTokens]);
    if (!union.size) continue;
    const intersection = [...proposedTokens].filter((token) => nameTokens.has(token)).length;
    best = Math.max(best, intersection / union.size);
  }
  return Number(best.toFixed(4));
}

function normalizedUniqueStrings(values) {
  return [...new Set(values.map((value) => value.trim()))];
}

function sanitizeGitRemote(value) {
  const remote = value.trim().replace(/[?#].*$/u, "");
  const scpLike = remote.match(/^(?:[^/@:\s]+@)?(\[[^\]]+\]|[^/:@\s]+):(.+)$/u);
  if (scpLike && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(remote)) {
    const host = scpLike[1].toLowerCase();
    const repositoryPath = scpLike[2].replace(/^\/+|\/+$/gu, "");
    return `ssh://${host}/${repositoryPath}`;
  }
  try {
    const parsed = new URL(remote);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/u, "");
  } catch {
    return remote;
  }
}

function canonicalGitRemote(value) {
  const sanitized = sanitizeGitRemote(String(value ?? ""));
  try {
    const parsed = new URL(sanitized);
    const supportedTransport = new Set(["git:", "git+ssh:", "http:", "https:", "ssh:"]);
    const hostname = parsed.hostname.toLowerCase();
    if (supportedTransport.has(parsed.protocol) && hostname) {
      const defaultPort = (parsed.protocol === "http:" && parsed.port === "80")
        || (parsed.protocol === "https:" && parsed.port === "443")
        || (parsed.protocol === "ssh:" && parsed.port === "22");
      const authority = `${hostname}${parsed.port && !defaultPort ? `:${parsed.port}` : ""}`;
      const repositoryPath = parsed.pathname
        .replace(/^\/+|\/+$/gu, "")
        .replace(/\.git$/iu, "")
        .toLowerCase();
      return `${authority}/${repositoryPath}`.replace(/\/$/u, "");
    }
  } catch {
    // Fall through to an exact, metadata-free representation for non-URL remotes.
  }
  return sanitized
    .toLowerCase()
    .replace(/\.git$/iu, "")
    .replace(/\/+$/u, "");
}

function projectBootstrapSimilarity(project, candidate) {
  const candidateNames = { title: candidate.name, aliases: candidate.aliases || [] };
  const nameSimilarity = Math.max(
    ...[project.name, ...(project.aliases || [])]
      .map((name) => taskBootstrapSimilarity(name, candidateNames)),
  );
  const exactIntersection = (left, right, normalizer) => {
    const normalizedRight = new Set((right || []).map(normalizer).filter(Boolean));
    return (left || []).some((value) => normalizedRight.has(normalizer(value)));
  };
  if (exactIntersection(project.git_remotes, candidate.git_remotes, canonicalGitRemote)
      || exactIntersection(
        project.repo_fingerprints,
        candidate.repo_fingerprints,
        normalizeResolverText,
      )) {
    return 1;
  }
  return nameSimilarity;
}

function projectBootstrapCandidates(project, projects) {
  return projects
    .map((candidate) => ({
      project_id: candidate.project_id,
      name: candidate.name,
      aliases: candidate.aliases || [],
      similarity: projectBootstrapSimilarity(project, candidate),
    }))
    .filter((candidate) => candidate.similarity >= 0.6)
    .sort((left, right) => right.similarity - left.similarity
      || left.project_id.localeCompare(right.project_id));
}

function resolverRequest(payload, { requireQuery = false } = {}) {
  const request = typeof payload === "string" ? { query: payload } : payload;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new ValidationError("Resolver request must be an object.");
  }
  const query = request.query === undefined ? "" : request.query;
  if (typeof query !== "string" || query.length > 4_096 || (requireQuery && !query.trim())) {
    throw new ValidationError(requireQuery
      ? "query is required and must be at most 4096 characters."
      : "query must be a string of at most 4096 characters.");
  }
  const signals = request.signals ?? {};
  if (!signals || typeof signals !== "object" || Array.isArray(signals)) {
    throw new ValidationError("signals must be an object.");
  }
  const allowed = new Set([
    "project_id",
    "task_id",
    "git_remote",
    "repo_fingerprint",
    "cwd",
    "device_id",
    "agent_id",
    "agent_instance_id",
    "session_id",
  ]);
  for (const [key, value] of Object.entries(signals)) {
    if (!allowed.has(key)) throw new ValidationError(`Unsupported resolver signal: ${key}.`);
    if (typeof value !== "string" || !value.trim() || value.length > 4_096) {
      throw new ValidationError(`Resolver signal ${key} must be a non-empty string.`);
    }
  }
  for (const key of ["project_id", "task_id", "device_id", "agent_id", "agent_instance_id", "session_id"]) {
    if (signals[key] !== undefined) assertIdentifier(signals[key], `signals.${key}`);
  }
  if (!query.trim() && !Object.keys(signals).length) {
    throw new ValidationError("query or at least one resolver signal is required.");
  }
  return { query: query.trim(), signals: { ...signals } };
}

function requestedSourceWorkstreamIds(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || payload.source_workstream_ids === undefined) {
    return null;
  }
  assertStringArray(payload.source_workstream_ids, "source_workstream_ids", {
    maxItems: 20,
    maxLength: 128,
  });
  if (!payload.source_workstream_ids.length) {
    throw new ValidationError("source_workstream_ids must contain at least one Workstream.");
  }
  const workstreamIds = [...new Set(
    payload.source_workstream_ids.map((value) => value.trim()),
  )];
  for (const workstreamId of workstreamIds) {
    assertIdentifier(workstreamId, "source_workstream_ids item");
  }
  return workstreamIds;
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ValidationError(`${label} must be an ISO timestamp.`);
  }
}

function parseRetention(value, fallback = 30) {
  const candidate = value ?? fallback;
  if (candidate === null || ["permanent", "forever", "infinite"].includes(String(candidate).toLowerCase())) {
    return null;
  }
  const days = Number(candidate);
  if (!Number.isInteger(days) || days < 1) {
    throw new ValidationError("raw_retention_days must be an integer >= 1 or 'permanent'.");
  }
  return days;
}

function retentionExpiry(capturedAt, days) {
  if (days === null) return null;
  return new Date(Date.parse(capturedAt) + days * 86_400_000).toISOString();
}

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
  }
}

export class AuthenticationError extends Error {
  constructor(message = "Invalid or revoked API credential.") {
    super(message);
    this.name = "AuthenticationError";
    this.statusCode = 401;
  }
}

export class AuthorizationError extends Error {
  constructor(scope) {
    super(`Credential lacks required scope: ${scope}.`);
    this.name = "AuthorizationError";
    this.statusCode = 403;
  }
}

export class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = 404;
  }
}

export class ConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConflictError";
    this.statusCode = 409;
  }
}

export class MnemuronStore {
  constructor(databasePath, options = {}) {
    this.databasePath = path.resolve(databasePath);
    this.defaultRetentionDays = parseRetention(options.defaultRetentionDays ?? 30);
    mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    this.db.prepare(`
      INSERT OR IGNORE INTO settings (key, value_json, updated_at)
      VALUES ('raw_retention_days', ?, ?)
    `).run(asJson(this.defaultRetentionDays), nowIso());
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        credential_id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        expires_at TEXT,
        rotated_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS credentials_instance_idx
        ON credentials(user_id, agent_instance_id, revoked_at);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        git_remotes_json TEXT NOT NULL,
        repo_fingerprints_json TEXT NOT NULL,
        path_hints_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_user_name_idx
        ON projects(user_id, name);

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        title TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        progress_json TEXT NOT NULL,
        decisions_json TEXT NOT NULL,
        blockers_json TEXT NOT NULL,
        next_steps_json TEXT NOT NULL,
        resources_json TEXT NOT NULL,
        workstreams_json TEXT NOT NULL,
        conflicts_json TEXT NOT NULL,
        canonical_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_user_activity_idx
        ON tasks(user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        workstream_id TEXT,
        session_id TEXT,
        turn_id TEXT,
        event_type TEXT NOT NULL,
        hook_event_name TEXT,
        captured_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        expires_at TEXT,
        expired_at TEXT,
        content TEXT,
        raw_payload_json TEXT,
        capture_capability_json TEXT,
        cwd TEXT,
        model TEXT,
        tool_name TEXT,
        tool_use_id TEXT,
        FOREIGN KEY(credential_id) REFERENCES credentials(credential_id)
      );
      CREATE INDEX IF NOT EXISTS events_task_activity_idx
        ON events(user_id, task_id, captured_at DESC);
      CREATE INDEX IF NOT EXISTS events_expiry_idx
        ON events(expires_at, expired_at);

      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        content TEXT NOT NULL,
        scope TEXT NOT NULL,
        project_id TEXT,
        task_id TEXT,
        workstream_id TEXT,
        session_id TEXT,
        source TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'fact',
        status TEXT NOT NULL DEFAULT 'active',
        source_event_ids_json TEXT NOT NULL DEFAULT '[]',
        source_checkpoint_id TEXT,
        generation_method TEXT,
        confidence REAL,
        confidence_label TEXT,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        content_fingerprint TEXT,
        topic TEXT,
        topic_key TEXT,
        supersedes_memory_id TEXT,
        superseded_by_memory_id TEXT,
        lifecycle_reason TEXT,
        retracted_at TEXT,
        lifecycle_actor_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT,
        FOREIGN KEY(credential_id) REFERENCES credentials(credential_id)
      );
      CREATE INDEX IF NOT EXISTS memories_task_idx
        ON memories(user_id, task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        workstream_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        trigger_event_id TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        content_json TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        generation_method TEXT NOT NULL,
        confidence REAL NOT NULL,
        confidence_label TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(trigger_event_id) REFERENCES events(event_id),
        UNIQUE(user_id, task_id, workstream_id, version),
        UNIQUE(user_id, source_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS checkpoints_task_version_idx
        ON checkpoints(user_id, task_id, workstream_id, version DESC);
      CREATE INDEX IF NOT EXISTS checkpoints_session_idx
        ON checkpoints(user_id, session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS task_reconciliation_proposals (
        proposal_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        proposal_version INTEGER NOT NULL,
        base_canonical_version INTEGER NOT NULL,
        requested_by_credential_id TEXT,
        source_checkpoint_ids_json TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        source_workstreams_json TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        conflicts_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by_credential_id TEXT,
        FOREIGN KEY(requested_by_credential_id) REFERENCES credentials(credential_id),
        FOREIGN KEY(resolved_by_credential_id) REFERENCES credentials(credential_id),
        UNIQUE(user_id, source_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS task_reconciliation_task_idx
        ON task_reconciliation_proposals(user_id, task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS task_reconciliation_status_idx
        ON task_reconciliation_proposals(user_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS task_canonical_revisions (
        revision_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        canonical_version_before INTEGER NOT NULL,
        canonical_version_after INTEGER NOT NULL,
        proposal_id TEXT,
        operations_json TEXT NOT NULL,
        before_hash TEXT,
        after_hash TEXT NOT NULL,
        source_checkpoint_ids_json TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        decision TEXT NOT NULL,
        credential_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(proposal_id) REFERENCES task_reconciliation_proposals(proposal_id),
        FOREIGN KEY(credential_id) REFERENCES credentials(credential_id),
        UNIQUE(user_id, task_id, canonical_version_after)
      );
      CREATE INDEX IF NOT EXISTS task_canonical_revision_task_idx
        ON task_canonical_revisions(user_id, task_id, canonical_version_after DESC);

      CREATE TABLE IF NOT EXISTS task_bootstrap_previews (
        bootstrap_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        requested_by_credential_id TEXT NOT NULL,
        bootstrap_kind TEXT NOT NULL DEFAULT 'task',
        project_id TEXT NOT NULL,
        proposed_task_id TEXT NOT NULL,
        preview_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        binding_packet_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        confirmed_at TEXT,
        cancelled_at TEXT,
        FOREIGN KEY(requested_by_credential_id) REFERENCES credentials(credential_id),
        UNIQUE(user_id, bootstrap_id, preview_version)
      );
      CREATE INDEX IF NOT EXISTS task_bootstrap_user_created_idx
        ON task_bootstrap_previews(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS task_bootstrap_status_idx
        ON task_bootstrap_previews(user_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS resumes (
        resume_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        requested_by_credential_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        preview_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        packet_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        confirmed_at TEXT,
        cancelled_at TEXT,
        FOREIGN KEY(requested_by_credential_id) REFERENCES credentials(credential_id)
      );
      CREATE INDEX IF NOT EXISTS resumes_user_created_idx
        ON resumes(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS resolver_selections (
        selection_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        resume_id TEXT NOT NULL,
        preview_version INTEGER NOT NULL,
        query TEXT NOT NULL,
        query_fingerprint TEXT NOT NULL,
        project_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        signals_json TEXT NOT NULL,
        candidate_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(credential_id) REFERENCES credentials(credential_id),
        FOREIGN KEY(resume_id) REFERENCES resumes(resume_id),
        UNIQUE(user_id, resume_id, preview_version)
      );
      CREATE INDEX IF NOT EXISTS resolver_selection_query_idx
        ON resolver_selections(user_id, query_fingerprint, created_at DESC);
      CREATE INDEX IF NOT EXISTS resolver_selection_task_idx
        ON resolver_selections(user_id, task_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS resume_injection_events (
        event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        resume_id TEXT NOT NULL,
        preview_version INTEGER NOT NULL,
        attempt_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        workstream_id TEXT NOT NULL,
        injection_method TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        FOREIGN KEY(resume_id) REFERENCES resumes(resume_id),
        FOREIGN KEY(credential_id) REFERENCES credentials(credential_id),
        UNIQUE(user_id, resume_id, attempt_id, phase)
      );
      CREATE INDEX IF NOT EXISTS resume_injection_resume_idx
        ON resume_injection_events(user_id, resume_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS resume_injection_attempt_idx
        ON resume_injection_events(user_id, resume_id, attempt_id, occurred_at ASC);

      CREATE TABLE IF NOT EXISTS resume_delivery_receipts (
        receipt_event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        resume_id TEXT NOT NULL,
        preview_version INTEGER NOT NULL,
        receipt_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        credential_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_instance_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        workstream_id TEXT NOT NULL,
        delivery_method TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT,
        FOREIGN KEY(resume_id) REFERENCES resumes(resume_id),
        FOREIGN KEY(credential_id) REFERENCES credentials(credential_id),
        UNIQUE(user_id, resume_id, receipt_id, phase)
      );
      CREATE INDEX IF NOT EXISTS resume_delivery_receipt_resume_idx
        ON resume_delivery_receipts(user_id, resume_id, occurred_at DESC);
      CREATE INDEX IF NOT EXISTS resume_delivery_receipt_attempt_idx
        ON resume_delivery_receipts(user_id, resume_id, receipt_id, occurred_at ASC);

      CREATE TABLE IF NOT EXISTS audit_events (
        audit_id TEXT PRIMARY KEY,
        user_id TEXT,
        credential_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        outcome TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_created_idx
        ON audit_events(created_at DESC);
    `);
    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all();
    if (!taskColumns.some((column) => column.name === "canonical_version")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN canonical_version INTEGER NOT NULL DEFAULT 1");
    }
    const memoryColumns = new Set(
      this.db.prepare("PRAGMA table_info(memories)").all().map((column) => column.name),
    );
    const memoryMigrations = [
      ["memory_type", "ALTER TABLE memories ADD COLUMN memory_type TEXT NOT NULL DEFAULT 'fact'"],
      ["status", "ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"],
      ["source_event_ids_json", "ALTER TABLE memories ADD COLUMN source_event_ids_json TEXT NOT NULL DEFAULT '[]'"],
      ["source_checkpoint_id", "ALTER TABLE memories ADD COLUMN source_checkpoint_id TEXT"],
      ["generation_method", "ALTER TABLE memories ADD COLUMN generation_method TEXT"],
      ["confidence", "ALTER TABLE memories ADD COLUMN confidence REAL"],
      ["confidence_label", "ALTER TABLE memories ADD COLUMN confidence_label TEXT"],
      ["warnings_json", "ALTER TABLE memories ADD COLUMN warnings_json TEXT NOT NULL DEFAULT '[]'"],
      ["content_fingerprint", "ALTER TABLE memories ADD COLUMN content_fingerprint TEXT"],
      ["topic", "ALTER TABLE memories ADD COLUMN topic TEXT"],
      ["topic_key", "ALTER TABLE memories ADD COLUMN topic_key TEXT"],
      ["supersedes_memory_id", "ALTER TABLE memories ADD COLUMN supersedes_memory_id TEXT"],
      ["superseded_by_memory_id", "ALTER TABLE memories ADD COLUMN superseded_by_memory_id TEXT"],
      ["lifecycle_reason", "ALTER TABLE memories ADD COLUMN lifecycle_reason TEXT"],
      ["retracted_at", "ALTER TABLE memories ADD COLUMN retracted_at TEXT"],
      ["lifecycle_actor_json", "ALTER TABLE memories ADD COLUMN lifecycle_actor_json TEXT NOT NULL DEFAULT '{}'"],
      ["updated_at", "ALTER TABLE memories ADD COLUMN updated_at TEXT"],
    ];
    for (const [column, sql] of memoryMigrations) {
      if (!memoryColumns.has(column)) this.db.exec(sql);
    }
    const taskBootstrapColumns = new Set(
      this.db.prepare("PRAGMA table_info(task_bootstrap_previews)")
        .all().map((column) => column.name),
    );
    if (!taskBootstrapColumns.has("bootstrap_kind")) {
      this.db.exec(
        "ALTER TABLE task_bootstrap_previews ADD COLUMN bootstrap_kind TEXT NOT NULL DEFAULT 'task'",
      );
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS memories_content_fingerprint_idx
        ON memories(user_id, content_fingerprint)
        WHERE content_fingerprint IS NOT NULL;
      CREATE INDEX IF NOT EXISTS memories_status_idx
        ON memories(user_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS memories_topic_idx
        ON memories(user_id, task_id, topic_key, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS memories_lineage_idx
        ON memories(user_id, superseded_by_memory_id, supersedes_memory_id);
      CREATE INDEX IF NOT EXISTS task_bootstrap_kind_status_idx
        ON task_bootstrap_previews(user_id, bootstrap_kind, status, created_at DESC);
    `);
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT OR IGNORE INTO projects (
        project_id, user_id, name, aliases_json, git_remotes_json,
        repo_fingerprints_json, path_hints_json, created_at, updated_at
      )
      SELECT project_id, user_id, project_name, '[]', '[]', '[]', '[]', ?, ?
      FROM tasks
      GROUP BY project_id, user_id, project_name
    `).run(timestamp, timestamp);
    const baselineInsert = this.db.prepare(`
      INSERT OR IGNORE INTO task_canonical_revisions (
        revision_id, user_id, task_id, project_id, canonical_version_before,
        canonical_version_after, proposal_id, operations_json, before_hash,
        after_hash, source_checkpoint_ids_json, source_event_ids_json,
        decision, credential_id, created_at
      ) VALUES (?, ?, ?, ?, 0, ?, NULL, ?, NULL, ?, '[]', '[]',
                'migration_baseline', NULL, ?)
    `);
    for (const row of this.db.prepare("SELECT * FROM tasks").all()) {
      const task = this.taskFromRow(row);
      baselineInsert.run(
        randomUUID(),
        row.user_id,
        row.task_id,
        row.project_id,
        task.canonical_version,
        asJson([{ op: "migration_baseline" }]),
        canonicalTaskHash(task),
        timestamp,
      );
    }
  }

  close() {
    this.db.close();
  }

  audit({ auth = null, action, targetType = null, targetId = null, outcome = "success", metadata = null }) {
    this.db.prepare(`
      INSERT INTO audit_events (
        audit_id, user_id, credential_id, action, target_type, target_id,
        outcome, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      auth?.user_id ?? null,
      auth?.credential_id ?? null,
      action,
      targetType,
      targetId,
      outcome,
      metadata === null ? null : asJson(metadata),
      nowIso(),
    );
  }

  issueCredential({
    label,
    userId = DEFAULT_USER_ID,
    deviceId,
    agentId,
    agentInstanceId,
    scopes = DEFAULT_AGENT_SCOPES,
    expiresAt = null,
  }) {
    assertIdentifier(userId, "user_id");
    assertIdentifier(deviceId, "device_id");
    assertIdentifier(agentId, "agent_id");
    assertIdentifier(agentInstanceId, "agent_instance_id");
    if (!Array.isArray(scopes) || !scopes.length || scopes.some((scope) => typeof scope !== "string")) {
      throw new ValidationError("scopes must be a non-empty string array.");
    }
    const apiKey = makeApiKey();
    const credentialId = randomUUID();
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO credentials (
        credential_id, label, user_id, device_id, agent_id, agent_instance_id,
        key_hash, scopes_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      credentialId,
      label || agentInstanceId,
      userId,
      deviceId,
      agentId,
      agentInstanceId,
      hashKey(apiKey),
      asJson([...new Set(scopes)]),
      createdAt,
      expiresAt,
    );
    const auth = {
      credential_id: credentialId,
      user_id: userId,
      device_id: deviceId,
      agent_id: agentId,
      agent_instance_id: agentInstanceId,
      scopes: [...new Set(scopes)],
    };
    this.audit({ auth, action: "credential.issue", targetType: "credential", targetId: credentialId });
    return { api_key: apiKey, credential: { ...auth, label: label || agentInstanceId, created_at: createdAt, expires_at: expiresAt } };
  }

  bootstrapAdmin({ label = "Mnemuron admin", userId = DEFAULT_USER_ID } = {}) {
    const activeAdmin = this.db.prepare(`
      SELECT credential_id FROM credentials
      WHERE user_id = ? AND revoked_at IS NULL AND scopes_json LIKE '%admin:devices%'
      LIMIT 1
    `).get(userId);
    if (activeAdmin) {
      throw new ConflictError("An active admin credential already exists.");
    }
    return this.issueCredential({
      label,
      userId,
      deviceId: "mnemuron-admin",
      agentId: "mnemuron",
      agentInstanceId: "mnemuron-admin",
      scopes: ADMIN_SCOPES,
    });
  }

  authenticate(apiKey, requiredScope = null) {
    if (typeof apiKey !== "string" || !apiKey.startsWith("mnm_")) {
      throw new AuthenticationError();
    }
    const row = this.db.prepare(`
      SELECT * FROM credentials WHERE key_hash = ? LIMIT 1
    `).get(hashKey(apiKey));
    if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
      throw new AuthenticationError();
    }
    const auth = {
      credential_id: row.credential_id,
      label: row.label,
      user_id: row.user_id,
      device_id: row.device_id,
      agent_id: row.agent_id,
      agent_instance_id: row.agent_instance_id,
      scopes: fromJson(row.scopes_json, []),
    };
    if (requiredScope && !auth.scopes.includes(requiredScope)) {
      throw new AuthorizationError(requiredScope);
    }
    this.db.prepare("UPDATE credentials SET last_used_at = ? WHERE credential_id = ?")
      .run(nowIso(), row.credential_id);
    return auth;
  }

  registerAgent(auth, payload) {
    this.requireScope(auth, "admin:devices");
    const result = this.issueCredential({
      label: payload.label,
      userId: payload.user_id || auth.user_id,
      deviceId: payload.device_id,
      agentId: payload.agent_id,
      agentInstanceId: payload.agent_instance_id,
      scopes: payload.scopes || DEFAULT_AGENT_SCOPES,
      expiresAt: payload.expires_at || null,
    });
    this.audit({ auth, action: "agent_instance.register", targetType: "agent_instance", targetId: payload.agent_instance_id });
    return result;
  }

  rotateAgentKey(auth, agentInstanceId) {
    this.requireScope(auth, "admin:devices");
    const current = this.db.prepare(`
      SELECT * FROM credentials
      WHERE user_id = ? AND agent_instance_id = ? AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(auth.user_id, agentInstanceId);
    if (!current) throw new NotFoundError("Agent instance credential not found.");
    const rotatedAt = nowIso();
    this.db.prepare(`
      UPDATE credentials SET revoked_at = ?, rotated_at = ?
      WHERE user_id = ? AND agent_instance_id = ? AND revoked_at IS NULL
    `).run(rotatedAt, rotatedAt, auth.user_id, agentInstanceId);
    const result = this.issueCredential({
      label: current.label,
      userId: current.user_id,
      deviceId: current.device_id,
      agentId: current.agent_id,
      agentInstanceId: current.agent_instance_id,
      scopes: fromJson(current.scopes_json, DEFAULT_AGENT_SCOPES),
      expiresAt: current.expires_at,
    });
    this.audit({ auth, action: "credential.rotate", targetType: "agent_instance", targetId: agentInstanceId });
    return result;
  }

  revokeAgent(auth, agentInstanceId) {
    this.requireScope(auth, "admin:devices");
    const revokedAt = nowIso();
    const result = this.db.prepare(`
      UPDATE credentials SET revoked_at = ?
      WHERE user_id = ? AND agent_instance_id = ? AND revoked_at IS NULL
    `).run(revokedAt, auth.user_id, agentInstanceId);
    if (!result.changes) throw new NotFoundError("Active agent instance credential not found.");
    this.audit({ auth, action: "agent_instance.revoke", targetType: "agent_instance", targetId: agentInstanceId, metadata: { revoked_credentials: result.changes } });
    return { status: "revoked", agent_instance_id: agentInstanceId, revoked_at: revokedAt, revoked_credentials: result.changes };
  }

  updateReconciliationScopes(auth, agentInstanceId, { apply = false } = {}) {
    this.requireScope(auth, "admin:devices");
    assertIdentifier(agentInstanceId, "agent_instance_id");
    const rows = this.db.prepare(`
      SELECT credential_id, scopes_json
      FROM credentials
      WHERE user_id = ? AND agent_instance_id = ? AND revoked_at IS NULL
      ORDER BY created_at ASC
    `).all(auth.user_id, agentInstanceId);
    if (!rows.length) throw new NotFoundError("Active agent instance credential not found.");
    const requiredScopes = ["task:reconcile:read", "task:reconcile:confirm"];
    const updates = rows.map((row) => {
      const currentScopes = fromJson(row.scopes_json, []);
      const missingScopes = requiredScopes.filter((scope) => !currentScopes.includes(scope));
      return {
        credential_id: row.credential_id,
        missing_scopes: missingScopes,
        next_scopes: [...new Set([...currentScopes, ...requiredScopes])],
      };
    });
    const pending = updates.filter((entry) => entry.missing_scopes.length > 0);
    if (!apply || !pending.length) {
      return {
        status: pending.length ? "preview" : "unchanged",
        agent_instance_id: agentInstanceId,
        active_credentials: rows.length,
        credentials_to_update: pending.length,
        required_scopes: requiredScopes,
        applied: false,
      };
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare(
        "UPDATE credentials SET scopes_json = ? WHERE credential_id = ? AND revoked_at IS NULL",
      );
      let changed = 0;
      for (const entry of pending) {
        const result = update.run(asJson(entry.next_scopes), entry.credential_id);
        changed += Number(result.changes);
      }
      this.audit({
        auth,
        action: "credential.reconciliation_scopes.update",
        targetType: "agent_instance",
        targetId: agentInstanceId,
        metadata: {
          active_credentials: rows.length,
          updated_credentials: changed,
          added_scopes: requiredScopes,
        },
      });
      this.db.exec("COMMIT");
      return {
        status: "updated",
        agent_instance_id: agentInstanceId,
        active_credentials: rows.length,
        credentials_to_update: pending.length,
        updated_credentials: changed,
        required_scopes: requiredScopes,
        applied: true,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateTaskBootstrapScopes(auth, agentInstanceId, { apply = false } = {}) {
    this.requireScope(auth, "admin:devices");
    assertIdentifier(agentInstanceId, "agent_instance_id");
    const rows = this.db.prepare(`
      SELECT credential_id, scopes_json
      FROM credentials
      WHERE user_id = ? AND agent_instance_id = ? AND revoked_at IS NULL
      ORDER BY created_at ASC
    `).all(auth.user_id, agentInstanceId);
    if (!rows.length) throw new NotFoundError("Active agent instance credential not found.");
    const requiredScopes = ["task:bootstrap:preview", "task:bootstrap:confirm"];
    const updates = rows.map((row) => {
      const currentScopes = fromJson(row.scopes_json, []);
      const missingScopes = requiredScopes.filter((scope) => !currentScopes.includes(scope));
      return {
        credential_id: row.credential_id,
        missing_scopes: missingScopes,
        next_scopes: [...new Set([...currentScopes, ...requiredScopes])],
      };
    });
    const pending = updates.filter((entry) => entry.missing_scopes.length > 0);
    if (!apply || !pending.length) {
      return {
        status: pending.length ? "preview" : "unchanged",
        agent_instance_id: agentInstanceId,
        active_credentials: rows.length,
        credentials_to_update: pending.length,
        required_scopes: requiredScopes,
        applied: false,
      };
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare(
        "UPDATE credentials SET scopes_json = ? WHERE credential_id = ? AND revoked_at IS NULL",
      );
      let changed = 0;
      for (const entry of pending) {
        const result = update.run(asJson(entry.next_scopes), entry.credential_id);
        changed += Number(result.changes);
      }
      this.audit({
        auth,
        action: "credential.task_bootstrap_scopes.update",
        targetType: "agent_instance",
        targetId: agentInstanceId,
        metadata: {
          active_credentials: rows.length,
          updated_credentials: changed,
          added_scopes: requiredScopes,
        },
      });
      this.db.exec("COMMIT");
      return {
        status: "updated",
        agent_instance_id: agentInstanceId,
        active_credentials: rows.length,
        credentials_to_update: pending.length,
        updated_credentials: changed,
        required_scopes: requiredScopes,
        applied: true,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateProjectBootstrapScopes(auth, agentInstanceId, { apply = false } = {}) {
    this.requireScope(auth, "admin:devices");
    assertIdentifier(agentInstanceId, "agent_instance_id");
    const rows = this.db.prepare(`
      SELECT credential_id, scopes_json
      FROM credentials
      WHERE user_id = ? AND agent_instance_id = ? AND revoked_at IS NULL
      ORDER BY created_at ASC
    `).all(auth.user_id, agentInstanceId);
    if (!rows.length) throw new NotFoundError("Active agent instance credential not found.");
    const requiredScopes = ["project:bootstrap:preview", "project:bootstrap:confirm"];
    const updates = rows.map((row) => {
      const currentScopes = fromJson(row.scopes_json, []);
      const missingScopes = requiredScopes.filter((scope) => !currentScopes.includes(scope));
      return {
        credential_id: row.credential_id,
        missing_scopes: missingScopes,
        next_scopes: [...new Set([...currentScopes, ...requiredScopes])],
      };
    });
    const pending = updates.filter((entry) => entry.missing_scopes.length > 0);
    if (!apply || !pending.length) {
      return {
        status: pending.length ? "preview" : "unchanged",
        agent_instance_id: agentInstanceId,
        active_credentials: rows.length,
        credentials_to_update: pending.length,
        required_scopes: requiredScopes,
        applied: false,
      };
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const update = this.db.prepare(
        "UPDATE credentials SET scopes_json = ? WHERE credential_id = ? AND revoked_at IS NULL",
      );
      let changed = 0;
      for (const entry of pending) {
        const result = update.run(asJson(entry.next_scopes), entry.credential_id);
        changed += Number(result.changes);
      }
      this.audit({
        auth,
        action: "credential.project_bootstrap_scopes.update",
        targetType: "agent_instance",
        targetId: agentInstanceId,
        metadata: {
          active_credentials: rows.length,
          updated_credentials: changed,
          added_scopes: requiredScopes,
        },
      });
      this.db.exec("COMMIT");
      return {
        status: "updated",
        agent_instance_id: agentInstanceId,
        active_credentials: rows.length,
        credentials_to_update: pending.length,
        updated_credentials: changed,
        required_scopes: requiredScopes,
        applied: true,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  requireScope(auth, scope) {
    if (!auth?.scopes?.includes(scope)) throw new AuthorizationError(scope);
  }

  projectFromRow(row) {
    return {
      project_id: row.project_id,
      name: row.name,
      aliases: fromJson(row.aliases_json, []),
      git_remotes: fromJson(row.git_remotes_json, []),
      repo_fingerprints: fromJson(row.repo_fingerprints_json, []),
      path_hints: fromJson(row.path_hints_json, []),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  listProjects(userId) {
    return this.db.prepare("SELECT * FROM projects WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId)
      .map((row) => this.projectFromRow(row));
  }

  ensureProject(auth, projectId, name) {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO projects (
        project_id, user_id, name, aliases_json, git_remotes_json,
        repo_fingerprints_json, path_hints_json, created_at, updated_at
      ) VALUES (?, ?, ?, '[]', '[]', '[]', '[]', ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        name = excluded.name,
        updated_at = excluded.updated_at
    `).run(projectId, auth.user_id, name, timestamp, timestamp);
  }

  upsertProject(auth, project) {
    this.requireScope(auth, "admin:tasks");
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw new ValidationError("project payload is required.");
    }
    assertIdentifier(project.project_id, "project_id");
    const existingRow = this.db.prepare(
      "SELECT * FROM projects WHERE project_id = ? AND user_id = ?",
    ).get(project.project_id, auth.user_id);
    const existing = existingRow ? this.projectFromRow(existingRow) : null;
    const name = project.name ?? existing?.name;
    if (typeof name !== "string" || !name.trim() || name.length > 200) {
      throw new ValidationError("project name is required and must be at most 200 characters.");
    }
    const aliases = project.aliases ?? existing?.aliases ?? [];
    const gitRemotes = project.git_remotes ?? existing?.git_remotes ?? [];
    const repoFingerprints = project.repo_fingerprints ?? existing?.repo_fingerprints ?? [];
    const pathHints = project.path_hints ?? existing?.path_hints ?? [];
    assertStringArray(aliases, "aliases");
    assertStringArray(gitRemotes, "git_remotes");
    assertStringArray(repoFingerprints, "repo_fingerprints");
    assertStringArray(pathHints, "path_hints");
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO projects (
        project_id, user_id, name, aliases_json, git_remotes_json,
        repo_fingerprints_json, path_hints_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        name = excluded.name,
        aliases_json = excluded.aliases_json,
        git_remotes_json = excluded.git_remotes_json,
        repo_fingerprints_json = excluded.repo_fingerprints_json,
        path_hints_json = excluded.path_hints_json,
        updated_at = excluded.updated_at
    `).run(
      project.project_id,
      auth.user_id,
      name.trim(),
      asJson([...new Set(aliases)]),
      asJson([...new Set(gitRemotes)]),
      asJson([...new Set(repoFingerprints)]),
      asJson([...new Set(pathHints)]),
      existing?.created_at || timestamp,
      timestamp,
    );
    this.audit({ auth, action: "project.upsert", targetType: "project", targetId: project.project_id });
    return {
      status: "saved",
      project: this.projectFromRow(this.db.prepare(
        "SELECT * FROM projects WHERE project_id = ? AND user_id = ?",
      ).get(project.project_id, auth.user_id)),
    };
  }

  upsertTask(auth, task) {
    this.requireScope(auth, "admin:tasks");
    assertIdentifier(task.task_id, "task_id");
    assertIdentifier(task.project_id, "project_id");
    if (!task.title || !task.project_name || !task.goal) {
      throw new ValidationError("task title, project_name, and goal are required.");
    }
    this.ensureProject(auth, task.project_id, task.project_name);
    const timestamp = nowIso();
    const existingRow = this.db.prepare(
      "SELECT * FROM tasks WHERE task_id = ? AND user_id = ?",
    ).get(task.task_id, auth.user_id);
    const existing = existingRow ? this.taskFromRow(existingRow) : null;
    const candidate = {
      task_id: task.task_id,
      project_id: task.project_id,
      project_name: task.project_name,
      title: task.title,
      aliases: task.aliases || [],
      goal: task.goal,
      status: task.status || "active",
      progress: task.progress || [],
      decisions: task.decisions || [],
      blockers: task.blockers || [],
      next_steps: task.next_steps || [],
      resources: task.resources || [],
      workstreams: task.workstreams || [],
      conflicts: task.conflicts || [],
    };
    const beforeHash = existing ? canonicalTaskHash(existing) : null;
    const afterHash = canonicalTaskHash(candidate);
    if (beforeHash === afterHash) {
      return {
        status: "unchanged",
        task_id: task.task_id,
        canonical_version: existing.canonical_version,
        updated_at: existing.updated_at,
      };
    }

    const beforeVersion = existing?.canonical_version || 0;
    const afterVersion = beforeVersion + 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (existing) {
        const result = this.db.prepare(`
          UPDATE tasks SET
            project_id = ?, project_name = ?, title = ?, aliases_json = ?,
            goal = ?, status = ?, progress_json = ?, decisions_json = ?,
            blockers_json = ?, next_steps_json = ?, resources_json = ?,
            workstreams_json = ?, conflicts_json = ?, canonical_version = ?,
            updated_at = ?
          WHERE task_id = ? AND user_id = ? AND canonical_version = ?
        `).run(
          candidate.project_id,
          candidate.project_name,
          candidate.title,
          asJson(candidate.aliases),
          candidate.goal,
          candidate.status,
          asJson(candidate.progress),
          asJson(candidate.decisions),
          asJson(candidate.blockers),
          asJson(candidate.next_steps),
          asJson(candidate.resources),
          asJson(candidate.workstreams),
          asJson(candidate.conflicts),
          afterVersion,
          timestamp,
          candidate.task_id,
          auth.user_id,
          beforeVersion,
        );
        if (result.changes !== 1) throw new ConflictError("Canonical Task changed during update.");
      } else {
        this.db.prepare(`
          INSERT INTO tasks (
            task_id, user_id, project_id, project_name, title, aliases_json,
            goal, status, progress_json, decisions_json, blockers_json,
            next_steps_json, resources_json, workstreams_json, conflicts_json,
            canonical_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          candidate.task_id,
          auth.user_id,
          candidate.project_id,
          candidate.project_name,
          candidate.title,
          asJson(candidate.aliases),
          candidate.goal,
          candidate.status,
          asJson(candidate.progress),
          asJson(candidate.decisions),
          asJson(candidate.blockers),
          asJson(candidate.next_steps),
          asJson(candidate.resources),
          asJson(candidate.workstreams),
          asJson(candidate.conflicts),
          afterVersion,
          timestamp,
          timestamp,
        );
      }
      const changedFields = Object.keys(canonicalTaskSnapshot(candidate)).filter((field) =>
        JSON.stringify(existing?.[field]) !== JSON.stringify(candidate[field]));
      this.insertCanonicalRevision({
        auth,
        task: candidate,
        canonicalVersionBefore: beforeVersion,
        canonicalVersionAfter: afterVersion,
        proposalId: null,
        operations: [{ op: existing ? "admin_upsert" : "task_create", fields: changedFields }],
        beforeHash,
        afterHash,
        sourceCheckpointIds: [],
        sourceEventIds: [],
        decision: existing ? "admin_upsert" : "task_create",
        createdAt: timestamp,
      });
      this.db.prepare(`
        UPDATE task_reconciliation_proposals
        SET status = 'stale', resolved_at = ?
        WHERE user_id = ? AND task_id = ? AND status = 'awaiting_confirmation'
          AND base_canonical_version <> ?
      `).run(timestamp, auth.user_id, task.task_id, afterVersion);
      this.audit({
        auth,
        action: "task.upsert",
        targetType: "task",
        targetId: task.task_id,
        metadata: { canonical_version_before: beforeVersion, canonical_version_after: afterVersion },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      status: "saved",
      task_id: task.task_id,
      canonical_version: afterVersion,
      updated_at: timestamp,
    };
  }

  createProjectBootstrapPreview(auth, payload) {
    this.requireScope(auth, "project:bootstrap:preview");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ValidationError("Project Bootstrap payload is required.");
    }
    const projectName = requiredBoundedString(payload.project_name, "project_name", 200);
    const taskTitle = requiredBoundedString(payload.task_title, "task_title", 200);
    const taskGoal = requiredBoundedString(payload.task_goal, "task_goal", 4_096);
    const sessionId = requiredBoundedString(payload.session_id, "session_id", 128);
    const workstreamId = requiredBoundedString(payload.workstream_id, "workstream_id", 128);
    const workstreamName = payload.workstream_name === undefined
      ? workstreamId
      : requiredBoundedString(payload.workstream_name, "workstream_name", 200);
    assertIdentifier(sessionId, "session_id");
    assertIdentifier(workstreamId, "workstream_id");
    const projectAliases = payload.project_aliases ?? [];
    const gitRemotes = payload.git_remotes ?? [];
    const repoFingerprints = payload.repo_fingerprints ?? [];
    const pathHints = payload.path_hints ?? [];
    const taskAliases = payload.task_aliases ?? [];
    assertStringArray(projectAliases, "project_aliases", { maxItems: 20, maxLength: 200 });
    assertStringArray(gitRemotes, "git_remotes", { maxItems: 20, maxLength: 2_048 });
    assertStringArray(repoFingerprints, "repo_fingerprints", {
      maxItems: 20,
      maxLength: 512,
    });
    assertStringArray(pathHints, "path_hints", { maxItems: 20, maxLength: 4_096 });
    assertStringArray(taskAliases, "task_aliases", { maxItems: 20, maxLength: 200 });

    const project = {
      project_id: projectBootstrapIdentifier(auth.user_id, projectName),
      name: projectName,
      aliases: normalizedUniqueStrings(projectAliases),
      git_remotes: normalizedUniqueStrings(gitRemotes.map(sanitizeGitRemote)),
      repo_fingerprints: normalizedUniqueStrings(repoFingerprints),
      path_hints: normalizedUniqueStrings(pathHints),
    };
    const task = {
      task_id: taskBootstrapIdentifier(auth.user_id, project.project_id, taskTitle),
      title: taskTitle,
      aliases: normalizedUniqueStrings(taskAliases),
      goal: taskGoal,
      status: "active",
      canonical_version: 1,
    };
    const workstream = {
      workstream_id: workstreamId,
      name: workstreamName,
      status: "active",
      agent_id: auth.agent_id,
      device_id: auth.device_id,
      agent_instance_id: auth.agent_instance_id,
    };
    const existingCandidates = projectBootstrapCandidates(
      project,
      this.listProjects(auth.user_id),
    );
    if (existingCandidates.length) {
      return {
        schema_version: PROJECT_BOOTSTRAP_SCHEMA_VERSION,
        status: "existing_project_selection_required",
        requires_confirmation: false,
        selection_required: true,
        proposed: { project, task },
        candidates: existingCandidates.slice(0, 10),
        resolver_version: RESOLVER_VERSION,
        safety: {
          bootstrap_preview_created: false,
          project_created: false,
          canonical_task_created: false,
          task_scope_changed: false,
          resume_created: false,
          context_injected: false,
          historical_events_rebound: false,
        },
      };
    }
    const projectIdentifierOwner = this.db.prepare(`
      SELECT user_id FROM projects WHERE project_id = ?
    `).get(project.project_id);
    const taskIdentifierOwner = this.db.prepare(`
      SELECT user_id FROM tasks WHERE task_id = ?
    `).get(task.task_id);
    if (projectIdentifierOwner || taskIdentifierOwner) {
      return {
        schema_version: PROJECT_BOOTSTRAP_SCHEMA_VERSION,
        status: "identifier_collision",
        requires_confirmation: false,
        selection_required: true,
        proposed: { project, task },
        candidates: [],
        safety: {
          bootstrap_preview_created: false,
          project_created: false,
          canonical_task_created: false,
          task_scope_changed: false,
          resume_created: false,
          context_injected: false,
          historical_events_rebound: false,
        },
      };
    }

    const now = nowIso();
    const pendingRows = this.db.prepare(`
      SELECT * FROM task_bootstrap_previews
      WHERE user_id = ? AND bootstrap_kind = 'project_and_initial_task'
        AND status = 'pending_confirmation' AND expires_at > ?
      ORDER BY created_at DESC
    `).all(auth.user_id, now);
    const pending = pendingRows.map((row) => ({ row, preview: fromJson(row.preview_json) }));
    const exactPending = pending.find(({ row, preview }) =>
      row.requested_by_credential_id === auth.credential_id
      && preview.target_session_id === sessionId
      && JSON.stringify(preview.project) === JSON.stringify(project)
      && JSON.stringify(preview.task) === JSON.stringify(task)
      && preview.workstream.workstream_id === workstreamId
      && preview.workstream.name === workstreamName);
    if (exactPending) return { ...exactPending.preview, idempotent: true };
    const pendingCandidates = pending
      .map(({ preview }) => ({
        preview,
        similarity: projectBootstrapSimilarity(project, preview.project),
      }))
      .filter(({ similarity }) => similarity >= 0.6)
      .sort((left, right) => right.similarity - left.similarity
        || left.preview.bootstrap_id.localeCompare(right.preview.bootstrap_id));
    if (pendingCandidates.length) {
      return {
        schema_version: PROJECT_BOOTSTRAP_SCHEMA_VERSION,
        status: "pending_project_bootstrap_selection_required",
        requires_confirmation: false,
        selection_required: true,
        proposed: { project, task },
        candidates: pendingCandidates.slice(0, 10).map(({ preview, similarity }) => ({
          bootstrap_id: preview.bootstrap_id,
          preview_version: preview.preview_version,
          project_id: preview.project.project_id,
          project_name: preview.project.name,
          task_id: preview.task.task_id,
          task_title: preview.task.title,
          workstream_id: preview.workstream.workstream_id,
          expires_at: preview.expires_at,
          similarity,
          provenance: preview.provenance,
        })),
        safety: {
          bootstrap_preview_created: false,
          project_created: false,
          canonical_task_created: false,
          task_scope_changed: false,
          resume_created: false,
          context_injected: false,
          historical_events_rebound: false,
        },
      };
    }

    const bootstrapId = randomUUID();
    const preview = {
      schema_version: PROJECT_BOOTSTRAP_SCHEMA_VERSION,
      bootstrap_id: bootstrapId,
      bootstrap_kind: "project_and_initial_task",
      preview_version: 1,
      status: "pending_confirmation",
      requires_confirmation: true,
      created_at: now,
      expires_at: new Date(Date.parse(now) + TASK_BOOTSTRAP_PREVIEW_TTL_MS).toISOString(),
      project,
      task,
      workstream,
      target_session_id: sessionId,
      provenance: this.publicIdentity(auth),
      safety: {
        bootstrap_preview_created: true,
        project_created: false,
        canonical_task_created: false,
        canonical_revision_created: false,
        task_scope_changed: false,
        resume_created: false,
        context_injected: false,
        historical_events_rebound: false,
      },
    };
    this.db.prepare(`
      INSERT INTO task_bootstrap_previews (
        bootstrap_id, user_id, requested_by_credential_id, bootstrap_kind,
        project_id, proposed_task_id, preview_version, status, preview_json,
        created_at, expires_at
      ) VALUES (?, ?, ?, 'project_and_initial_task', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bootstrapId,
      auth.user_id,
      auth.credential_id,
      project.project_id,
      task.task_id,
      preview.preview_version,
      preview.status,
      asJson(preview),
      preview.created_at,
      preview.expires_at,
    );
    this.audit({
      auth,
      action: "project.bootstrap.preview",
      targetType: "project_bootstrap",
      targetId: bootstrapId,
      metadata: {
        proposed_project_id: project.project_id,
        proposed_task_id: task.task_id,
        workstream_id: workstreamId,
        target_session_id: sessionId,
      },
    });
    return preview;
  }

  confirmProjectBootstrap(auth, bootstrapId, previewVersion, confirmed, sessionId) {
    this.requireScope(auth, "project:bootstrap:confirm");
    assertIdentifier(bootstrapId, "bootstrap_id");
    assertIdentifier(sessionId, "session_id");
    if (!Number.isInteger(previewVersion) || previewVersion < 1
        || typeof confirmed !== "boolean") {
      throw new ValidationError("preview_version and confirmed are required.");
    }
    const row = this.db.prepare(`
      SELECT * FROM task_bootstrap_previews
      WHERE bootstrap_id = ? AND user_id = ? AND requested_by_credential_id = ?
        AND bootstrap_kind = 'project_and_initial_task'
    `).get(bootstrapId, auth.user_id, auth.credential_id);
    if (!row) throw new NotFoundError("Project Bootstrap Preview not found.");
    if (row.preview_version !== previewVersion) {
      throw new ConflictError("Project Bootstrap Preview version changed; create and show a fresh preview.");
    }
    const preview = fromJson(row.preview_json);
    if (preview.target_session_id !== sessionId) {
      throw new ConflictError("Project Bootstrap Preview belongs to a different session.");
    }
    if (row.status === "confirmed" && confirmed) {
      return {
        status: "confirmed",
        idempotent: true,
        binding_packet: fromJson(row.binding_packet_json),
      };
    }
    if (row.status === "cancelled" && !confirmed) {
      return { status: "cancelled", bootstrap_id: bootstrapId, idempotent: true };
    }
    if (row.status !== "pending_confirmation") {
      throw new ConflictError(`Project Bootstrap Preview is already ${row.status}.`);
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      const expiredAt = nowIso();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const update = this.db.prepare(`
          UPDATE task_bootstrap_previews SET status = 'expired'
          WHERE bootstrap_id = ? AND user_id = ? AND requested_by_credential_id = ?
            AND bootstrap_kind = 'project_and_initial_task'
            AND status = 'pending_confirmation' AND preview_version = ?
            AND expires_at <= ?
        `).run(
          bootstrapId,
          auth.user_id,
          auth.credential_id,
          previewVersion,
          expiredAt,
        );
        if (update.changes !== 1) {
          throw new ConflictError("Project Bootstrap Preview changed during expiry.");
        }
        this.audit({
          auth,
          action: "project.bootstrap.expire",
          targetType: "project_bootstrap",
          targetId: bootstrapId,
        });
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      throw new ConflictError("Project Bootstrap Preview expired; create and show a fresh preview.");
    }
    if (!confirmed) {
      const cancelledAt = nowIso();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const update = this.db.prepare(`
          UPDATE task_bootstrap_previews
          SET status = 'cancelled', cancelled_at = ?
          WHERE bootstrap_id = ? AND user_id = ? AND requested_by_credential_id = ?
            AND bootstrap_kind = 'project_and_initial_task'
            AND status = 'pending_confirmation' AND preview_version = ?
            AND expires_at > ?
        `).run(
          cancelledAt,
          bootstrapId,
          auth.user_id,
          auth.credential_id,
          previewVersion,
          cancelledAt,
        );
        if (update.changes !== 1) {
          throw new ConflictError("Project Bootstrap Preview changed during cancellation.");
        }
        this.audit({
          auth,
          action: "project.bootstrap.cancel",
          targetType: "project_bootstrap",
          targetId: bootstrapId,
          metadata: { preview_version: previewVersion },
        });
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return { status: "cancelled", bootstrap_id: bootstrapId, idempotent: false };
    }

    const task = {
      task_id: preview.task.task_id,
      project_id: preview.project.project_id,
      project_name: preview.project.name,
      title: preview.task.title,
      aliases: preview.task.aliases,
      goal: preview.task.goal,
      status: "active",
      progress: [],
      decisions: [],
      blockers: [],
      next_steps: [],
      resources: [],
      workstreams: [preview.workstream],
      conflicts: [],
    };
    const confirmedAt = nowIso();
    const bindingPacket = {
      schema_version: PROJECT_BOOTSTRAP_SCHEMA_VERSION,
      bootstrap_id: bootstrapId,
      bootstrap_kind: "project_and_initial_task",
      preview_version: previewVersion,
      project: preview.project,
      task: {
        task_id: task.task_id,
        title: task.title,
        goal: task.goal,
        status: task.status,
        canonical_version: 1,
      },
      workstream: preview.workstream,
      target_session_id: sessionId,
      binding_authorized_at: confirmedAt,
      provenance: this.publicIdentity(auth),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const projectCollision = projectBootstrapCandidates(
        preview.project,
        this.listProjects(auth.user_id),
      );
      if (projectCollision.length) {
        throw new ConflictError(
          "A matching or ambiguous Project was created after this preview; select it or create a fresh preview.",
        );
      }
      const existingProjectId = this.db.prepare("SELECT user_id FROM projects WHERE project_id = ?")
        .get(preview.project.project_id);
      if (existingProjectId) {
        throw new ConflictError("Proposed Project ID already exists; create and show a fresh preview.");
      }
      const existingTask = this.db.prepare("SELECT user_id FROM tasks WHERE task_id = ?")
        .get(task.task_id);
      if (existingTask) {
        throw new ConflictError("Proposed Task ID already exists; create and show a fresh preview.");
      }
      this.db.prepare(`
        INSERT INTO projects (
          project_id, user_id, name, aliases_json, git_remotes_json,
          repo_fingerprints_json, path_hints_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        preview.project.project_id,
        auth.user_id,
        preview.project.name,
        asJson(preview.project.aliases),
        asJson(preview.project.git_remotes),
        asJson(preview.project.repo_fingerprints),
        asJson(preview.project.path_hints),
        confirmedAt,
        confirmedAt,
      );
      this.db.prepare(`
        INSERT INTO tasks (
          task_id, user_id, project_id, project_name, title, aliases_json,
          goal, status, progress_json, decisions_json, blockers_json,
          next_steps_json, resources_json, workstreams_json, conflicts_json,
          canonical_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', ?, '[]', 1, ?, ?)
      `).run(
        task.task_id,
        auth.user_id,
        task.project_id,
        task.project_name,
        task.title,
        asJson(task.aliases),
        task.goal,
        task.status,
        asJson(task.workstreams),
        confirmedAt,
        confirmedAt,
      );
      this.insertCanonicalRevision({
        auth,
        task,
        canonicalVersionBefore: 0,
        canonicalVersionAfter: 1,
        proposalId: null,
        operations: [{
          op: "project_bootstrap_initial_task",
          fields: Object.keys(canonicalTaskSnapshot(task)),
          bootstrap_id: bootstrapId,
          project_id: preview.project.project_id,
        }],
        beforeHash: null,
        afterHash: canonicalTaskHash(task),
        sourceCheckpointIds: [],
        sourceEventIds: [],
        decision: "project_bootstrap_confirmed",
        createdAt: confirmedAt,
      });
      const update = this.db.prepare(`
        UPDATE task_bootstrap_previews
        SET status = 'confirmed', binding_packet_json = ?, confirmed_at = ?
        WHERE bootstrap_id = ? AND user_id = ? AND requested_by_credential_id = ?
          AND bootstrap_kind = 'project_and_initial_task' AND status = 'pending_confirmation'
          AND preview_version = ? AND expires_at > ?
      `).run(
        asJson(bindingPacket),
        confirmedAt,
        bootstrapId,
        auth.user_id,
        auth.credential_id,
        previewVersion,
        confirmedAt,
      );
      if (update.changes !== 1) {
        throw new ConflictError("Project Bootstrap Preview changed during confirmation.");
      }
      this.audit({
        auth,
        action: "project.bootstrap.confirm",
        targetType: "project_bootstrap",
        targetId: bootstrapId,
        metadata: {
          project_id: preview.project.project_id,
          task_id: task.task_id,
          canonical_version: 1,
          workstream_id: preview.workstream.workstream_id,
          target_session_id: sessionId,
          historical_events_rebound: false,
          resume_created: false,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { status: "confirmed", idempotent: false, binding_packet: bindingPacket };
  }

  createTaskBootstrapPreview(auth, payload) {
    this.requireScope(auth, "task:bootstrap:preview");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ValidationError("Task Bootstrap payload is required.");
    }
    const projectQuery = requiredBoundedString(payload.project_query, "project_query", 4_096);
    const title = requiredBoundedString(payload.title, "title", 200);
    const goal = requiredBoundedString(payload.goal, "goal", 4_096);
    const sessionId = requiredBoundedString(payload.session_id, "session_id", 128);
    const workstreamId = requiredBoundedString(payload.workstream_id, "workstream_id", 128);
    const workstreamName = payload.workstream_name === undefined
      ? workstreamId
      : requiredBoundedString(payload.workstream_name, "workstream_name", 200);
    assertIdentifier(sessionId, "session_id");
    assertIdentifier(workstreamId, "workstream_id");
    const aliases = payload.aliases ?? [];
    assertStringArray(aliases, "aliases", { maxItems: 20, maxLength: 200 });
    const signals = payload.signals ?? {};
    const request = resolverRequest({ query: projectQuery, signals }, { requireQuery: true });
    const history = this.resolverHistory(auth.user_id, request.query);
    const resolution = resolveProjectCandidates({
      projects: this.listProjects(auth.user_id),
      query: request.query,
      signals: request.signals,
      historyByProject: history.historyByProject,
    });
    if (resolution.status !== "resolved") {
      return {
        schema_version: TASK_BOOTSTRAP_SCHEMA_VERSION,
        status: "project_selection_required",
        requires_confirmation: false,
        selection_required: true,
        project_resolution: resolution,
        safety: {
          bootstrap_preview_created: false,
          canonical_task_created: false,
          task_scope_changed: false,
          resume_created: false,
          context_injected: false,
        },
      };
    }
    const project = this.listProjects(auth.user_id)
      .find((candidate) => candidate.project_id === resolution.match.project_id);
    if (!project) throw new NotFoundError("Resolved Project no longer exists.");

    const similarTasks = this.listTasks(auth.user_id)
      .filter((task) => task.project_id === project.project_id)
      .map((task) => ({ task, similarity: taskBootstrapSimilarity(title, task) }))
      .filter(({ similarity }) => similarity >= 0.6)
      .sort((left, right) => right.similarity - left.similarity
        || left.task.task_id.localeCompare(right.task.task_id));
    if (similarTasks.length) {
      return {
        schema_version: TASK_BOOTSTRAP_SCHEMA_VERSION,
        status: "existing_task_selection_required",
        requires_confirmation: false,
        selection_required: true,
        project: { project_id: project.project_id, name: project.name },
        proposed: { title, goal, aliases: [...new Set(aliases.map((value) => value.trim()))] },
        candidates: similarTasks.slice(0, 10).map(({ task, similarity }) => ({
          task_id: task.task_id,
          title: task.title,
          status: task.status,
          canonical_version: task.canonical_version,
          similarity,
        })),
        safety: {
          bootstrap_preview_created: false,
          canonical_task_created: false,
          task_scope_changed: false,
          resume_created: false,
          context_injected: false,
        },
      };
    }

    const normalizedAliases = [...new Set(aliases.map((value) => value.trim()))];
    const pendingBootstrapRows = this.db.prepare(`
      SELECT * FROM task_bootstrap_previews
      WHERE user_id = ? AND bootstrap_kind = 'task'
        AND project_id = ? AND status = 'pending_confirmation'
        AND expires_at > ?
      ORDER BY created_at DESC
    `).all(auth.user_id, project.project_id, nowIso());
    const pendingMatches = pendingBootstrapRows
      .map((row) => ({ row, preview: fromJson(row.preview_json) }))
      .map((entry) => ({
        ...entry,
        similarity: taskBootstrapSimilarity(title, entry.preview.task),
      }))
      .filter(({ similarity }) => similarity >= 0.6);
    const exactPending = pendingMatches.find(({ row, preview }) =>
      row.requested_by_credential_id === auth.credential_id
      && preview.target_session_id === sessionId
      && normalizeResolverText(preview.task.title) === normalizeResolverText(title)
      && preview.task.goal === goal
      && JSON.stringify(preview.task.aliases) === JSON.stringify(normalizedAliases)
      && preview.workstream.workstream_id === workstreamId
      && preview.workstream.name === workstreamName);
    if (exactPending) {
      return { ...exactPending.preview, idempotent: true };
    }
    if (pendingMatches.length) {
      return {
        schema_version: TASK_BOOTSTRAP_SCHEMA_VERSION,
        status: "pending_bootstrap_selection_required",
        requires_confirmation: false,
        selection_required: true,
        project: { project_id: project.project_id, name: project.name },
        proposed: { title, goal, aliases: normalizedAliases },
        candidates: pendingMatches.slice(0, 10).map(({ preview, similarity }) => ({
          bootstrap_id: preview.bootstrap_id,
          preview_version: preview.preview_version,
          task_id: preview.task.task_id,
          title: preview.task.title,
          goal: preview.task.goal,
          workstream_id: preview.workstream.workstream_id,
          expires_at: preview.expires_at,
          similarity,
          provenance: preview.provenance,
        })),
        safety: {
          bootstrap_preview_created: false,
          canonical_task_created: false,
          task_scope_changed: false,
          resume_created: false,
          context_injected: false,
        },
      };
    }

    const createdAt = nowIso();
    const bootstrapId = randomUUID();
    const taskId = taskBootstrapIdentifier(auth.user_id, project.project_id, title);
    const workstream = {
      workstream_id: workstreamId,
      name: workstreamName,
      status: "active",
      agent_id: auth.agent_id,
      device_id: auth.device_id,
      agent_instance_id: auth.agent_instance_id,
    };
    const preview = {
      schema_version: TASK_BOOTSTRAP_SCHEMA_VERSION,
      bootstrap_id: bootstrapId,
      preview_version: 1,
      status: "pending_confirmation",
      requires_confirmation: true,
      created_at: createdAt,
      expires_at: new Date(
        Date.parse(createdAt) + TASK_BOOTSTRAP_PREVIEW_TTL_MS,
      ).toISOString(),
      project: {
        project_id: project.project_id,
        name: project.name,
      },
      task: {
        task_id: taskId,
        title,
        aliases: normalizedAliases,
        goal,
        status: "active",
        canonical_version: 1,
      },
      workstream,
      target_session_id: sessionId,
      provenance: this.publicIdentity(auth),
      safety: {
        bootstrap_preview_created: true,
        canonical_task_created: false,
        task_scope_changed: false,
        resume_created: false,
        context_injected: false,
        historical_events_rebound: false,
      },
    };
    this.db.prepare(`
      INSERT INTO task_bootstrap_previews (
        bootstrap_id, user_id, requested_by_credential_id, bootstrap_kind, project_id,
        proposed_task_id, preview_version, status, preview_json,
        created_at, expires_at
      ) VALUES (?, ?, ?, 'task', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bootstrapId,
      auth.user_id,
      auth.credential_id,
      project.project_id,
      taskId,
      preview.preview_version,
      preview.status,
      asJson(preview),
      preview.created_at,
      preview.expires_at,
    );
    this.audit({
      auth,
      action: "task.bootstrap.preview",
      targetType: "task_bootstrap",
      targetId: bootstrapId,
      metadata: {
        project_id: project.project_id,
        proposed_task_id: taskId,
        workstream_id: workstreamId,
        target_session_id: sessionId,
      },
    });
    return preview;
  }

  confirmTaskBootstrap(auth, bootstrapId, previewVersion, confirmed, sessionId) {
    this.requireScope(auth, "task:bootstrap:confirm");
    assertIdentifier(bootstrapId, "bootstrap_id");
    assertIdentifier(sessionId, "session_id");
    if (!Number.isInteger(previewVersion) || previewVersion < 1
        || typeof confirmed !== "boolean") {
      throw new ValidationError("preview_version and confirmed are required.");
    }
    const row = this.db.prepare(`
      SELECT * FROM task_bootstrap_previews
      WHERE bootstrap_id = ? AND user_id = ? AND requested_by_credential_id = ?
        AND bootstrap_kind = 'task'
    `).get(bootstrapId, auth.user_id, auth.credential_id);
    if (!row) throw new NotFoundError("Task Bootstrap Preview not found.");
    if (row.preview_version !== previewVersion) {
      throw new ConflictError("Task Bootstrap Preview version changed; create and show a fresh preview.");
    }
    const preview = fromJson(row.preview_json);
    if (preview.target_session_id !== sessionId) {
      throw new ConflictError("Task Bootstrap Preview belongs to a different session.");
    }
    if (row.status === "confirmed" && confirmed) {
      return {
        status: "confirmed",
        idempotent: true,
        binding_packet: fromJson(row.binding_packet_json),
      };
    }
    if (row.status === "cancelled" && !confirmed) {
      return { status: "cancelled", bootstrap_id: bootstrapId, idempotent: true };
    }
    if (row.status !== "pending_confirmation") {
      throw new ConflictError(`Task Bootstrap Preview is already ${row.status}.`);
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.db.prepare(`
        UPDATE task_bootstrap_previews SET status = 'expired'
        WHERE bootstrap_id = ? AND bootstrap_kind = 'task'
          AND status = 'pending_confirmation'
      `).run(bootstrapId);
      this.audit({
        auth,
        action: "task.bootstrap.expire",
        targetType: "task_bootstrap",
        targetId: bootstrapId,
      });
      throw new ConflictError("Task Bootstrap Preview expired; create and show a fresh preview.");
    }
    if (!confirmed) {
      const cancelledAt = nowIso();
      this.db.prepare(`
        UPDATE task_bootstrap_previews
        SET status = 'cancelled', cancelled_at = ?
        WHERE bootstrap_id = ? AND bootstrap_kind = 'task'
          AND status = 'pending_confirmation'
      `).run(cancelledAt, bootstrapId);
      this.audit({
        auth,
        action: "task.bootstrap.cancel",
        targetType: "task_bootstrap",
        targetId: bootstrapId,
        metadata: { preview_version: previewVersion },
      });
      return {
        status: "cancelled",
        bootstrap_id: bootstrapId,
        idempotent: false,
      };
    }

    const task = {
      task_id: preview.task.task_id,
      project_id: preview.project.project_id,
      project_name: preview.project.name,
      title: preview.task.title,
      aliases: preview.task.aliases,
      goal: preview.task.goal,
      status: "active",
      progress: [],
      decisions: [],
      blockers: [],
      next_steps: [],
      resources: [],
      workstreams: [preview.workstream],
      conflicts: [],
    };
    const confirmedAt = nowIso();
    const bindingPacket = {
      schema_version: TASK_BOOTSTRAP_SCHEMA_VERSION,
      bootstrap_id: bootstrapId,
      preview_version: previewVersion,
      project: preview.project,
      task: {
        task_id: task.task_id,
        title: task.title,
        goal: task.goal,
        status: task.status,
        canonical_version: 1,
      },
      workstream: preview.workstream,
      target_session_id: sessionId,
      binding_authorized_at: confirmedAt,
      provenance: this.publicIdentity(auth),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const projectRow = this.db.prepare(`
        SELECT project_id, name FROM projects WHERE project_id = ? AND user_id = ?
      `).get(task.project_id, auth.user_id);
      if (!projectRow) throw new ConflictError("Resolved Project no longer exists.");
      if (projectRow.name !== preview.project.name) {
        throw new ConflictError("Resolved Project changed; create and show a fresh preview.");
      }
      const existingTask = this.db.prepare("SELECT user_id FROM tasks WHERE task_id = ?")
        .get(task.task_id);
      if (existingTask) {
        throw new ConflictError("Proposed Task ID already exists; create and show a fresh preview.");
      }
      const similarTask = this.listTasks(auth.user_id).find((candidate) =>
        candidate.project_id === task.project_id
        && taskBootstrapSimilarity(task.title, candidate) >= 0.6);
      if (similarTask) {
        throw new ConflictError(
          "A similar Canonical Task was created after this preview; select it or create a fresh preview.",
        );
      }
      this.db.prepare(`
        INSERT INTO tasks (
          task_id, user_id, project_id, project_name, title, aliases_json,
          goal, status, progress_json, decisions_json, blockers_json,
          next_steps_json, resources_json, workstreams_json, conflicts_json,
          canonical_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', '[]', '[]', ?, '[]', 1, ?, ?)
      `).run(
        task.task_id,
        auth.user_id,
        task.project_id,
        task.project_name,
        task.title,
        asJson(task.aliases),
        task.goal,
        task.status,
        asJson(task.workstreams),
        confirmedAt,
        confirmedAt,
      );
      this.insertCanonicalRevision({
        auth,
        task,
        canonicalVersionBefore: 0,
        canonicalVersionAfter: 1,
        proposalId: null,
        operations: [{
          op: "task_bootstrap",
          fields: Object.keys(canonicalTaskSnapshot(task)),
          bootstrap_id: bootstrapId,
        }],
        beforeHash: null,
        afterHash: canonicalTaskHash(task),
        sourceCheckpointIds: [],
        sourceEventIds: [],
        decision: "bootstrap_confirmed",
        createdAt: confirmedAt,
      });
      const update = this.db.prepare(`
        UPDATE task_bootstrap_previews
        SET status = 'confirmed', binding_packet_json = ?, confirmed_at = ?
        WHERE bootstrap_id = ? AND user_id = ? AND requested_by_credential_id = ?
          AND bootstrap_kind = 'task' AND status = 'pending_confirmation'
          AND preview_version = ?
      `).run(
        asJson(bindingPacket),
        confirmedAt,
        bootstrapId,
        auth.user_id,
        auth.credential_id,
        previewVersion,
      );
      if (update.changes !== 1) {
        throw new ConflictError("Task Bootstrap Preview changed during confirmation.");
      }
      this.audit({
        auth,
        action: "task.bootstrap.confirm",
        targetType: "task_bootstrap",
        targetId: bootstrapId,
        metadata: {
          task_id: task.task_id,
          canonical_version: 1,
          workstream_id: preview.workstream.workstream_id,
          target_session_id: sessionId,
          historical_events_rebound: false,
          resume_created: false,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      status: "confirmed",
      idempotent: false,
      binding_packet: bindingPacket,
    };
  }

  listTasks(userId) {
    return this.db.prepare("SELECT * FROM tasks WHERE user_id = ? ORDER BY updated_at DESC")
      .all(userId)
      .map((row) => this.taskFromRow(row));
  }

  taskFromRow(row) {
    return {
      task_id: row.task_id,
      project_id: row.project_id,
      project_name: row.project_name,
      title: row.title,
      aliases: fromJson(row.aliases_json, []),
      goal: row.goal,
      status: row.status,
      progress: fromJson(row.progress_json, []),
      decisions: fromJson(row.decisions_json, []),
      blockers: fromJson(row.blockers_json, []),
      next_steps: fromJson(row.next_steps_json, []),
      resources: fromJson(row.resources_json, []),
      workstreams: fromJson(row.workstreams_json, []),
      conflicts: fromJson(row.conflicts_json, []),
      canonical_version: Number(row.canonical_version || 1),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  insertCanonicalRevision({
    auth,
    task,
    canonicalVersionBefore,
    canonicalVersionAfter,
    proposalId,
    operations,
    beforeHash,
    afterHash,
    sourceCheckpointIds,
    sourceEventIds,
    decision,
    createdAt = nowIso(),
  }) {
    const revisionId = randomUUID();
    this.db.prepare(`
      INSERT INTO task_canonical_revisions (
        revision_id, user_id, task_id, project_id, canonical_version_before,
        canonical_version_after, proposal_id, operations_json, before_hash,
        after_hash, source_checkpoint_ids_json, source_event_ids_json,
        decision, credential_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revisionId,
      auth.user_id,
      task.task_id,
      task.project_id,
      canonicalVersionBefore,
      canonicalVersionAfter,
      proposalId,
      asJson(operations),
      beforeHash,
      afterHash,
      asJson(sourceCheckpointIds),
      asJson(sourceEventIds),
      decision,
      auth.credential_id || null,
      createdAt,
    );
    return revisionId;
  }

  checkpointFromRow(row) {
    const content = fromJson(row.content_json, {});
    return {
      checkpoint_id: row.checkpoint_id,
      task_id: row.task_id,
      project_id: row.project_id,
      workstream_id: row.workstream_id,
      session_id: row.session_id,
      version: row.version,
      status: row.status,
      ...content,
      source_event_ids: fromJson(row.source_event_ids_json, []),
      provenance: {
        device_id: row.device_id,
        agent_id: row.agent_id,
        agent_instance_id: row.agent_instance_id,
      },
      generation: {
        ...(content.generation || {}),
        method: row.generation_method,
        confidence: row.confidence,
        confidence_label: row.confidence_label,
        warnings: fromJson(row.warnings_json, []),
        trigger_type: row.trigger_type,
        trigger_event_id: row.trigger_event_id,
      },
      created_at: row.created_at,
    };
  }

  memoryFromRow(row) {
    return {
      memory_id: row.memory_id,
      content: row.content,
      scope: row.scope,
      project_id: row.project_id,
      task_id: row.task_id,
      workstream_id: row.workstream_id,
      session_id: row.session_id,
      memory_type: row.memory_type || "fact",
      status: row.status || "active",
      topic: row.topic || null,
      topic_key: row.topic_key || null,
      source: row.source,
      source_event_ids: fromJson(row.source_event_ids_json, []),
      source_checkpoint_id: row.source_checkpoint_id || null,
      generation: {
        method: row.generation_method || null,
        confidence: row.confidence === null || row.confidence === undefined
          ? null
          : Number(row.confidence),
        confidence_label: row.confidence_label || null,
        warnings: fromJson(row.warnings_json, []),
      },
      created_at: row.created_at,
      updated_at: row.updated_at || row.created_at,
      lifecycle: {
        schema_version: STRUCTURED_MEMORY_LIFECYCLE_SCHEMA_VERSION,
        supersedes_memory_id: row.supersedes_memory_id || null,
        superseded_by_memory_id: row.superseded_by_memory_id || null,
        reason: row.lifecycle_reason || null,
        retracted_at: row.retracted_at || null,
        actor: fromJson(row.lifecycle_actor_json, {}),
      },
      provenance: {
        device_id: row.device_id,
        agent_id: row.agent_id,
        agent_instance_id: row.agent_instance_id,
      },
    };
  }

  listCheckpoints(auth, taskId, workstreamId = null, limit = 20) {
    this.requireScope(auth, "memory:read");
    assertIdentifier(taskId, "task_id");
    if (workstreamId !== null) assertIdentifier(workstreamId, "workstream_id");
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const rows = workstreamId === null
      ? this.db.prepare(`
          SELECT * FROM checkpoints
          WHERE user_id = ? AND task_id = ?
          ORDER BY created_at DESC LIMIT ?
        `).all(auth.user_id, taskId, safeLimit)
      : this.db.prepare(`
          SELECT * FROM checkpoints
          WHERE user_id = ? AND task_id = ? AND workstream_id = ?
          ORDER BY version DESC LIMIT ?
        `).all(auth.user_id, taskId, workstreamId, safeLimit);
    return rows.map((row) => this.checkpointFromRow(row));
  }

  latestCheckpoints(userId, taskId) {
    const rows = this.db.prepare(`
      SELECT * FROM checkpoints
      WHERE user_id = ? AND task_id = ?
      ORDER BY created_at DESC
    `).all(userId, taskId);
    const seen = new Set();
    return rows.filter((row) => {
      if (seen.has(row.workstream_id)) return false;
      seen.add(row.workstream_id);
      return true;
    }).map((row) => this.checkpointFromRow(row));
  }

  reconciliationProposalFromRow(row) {
    return {
      proposal_id: row.proposal_id,
      proposal_version: row.proposal_version,
      task_id: row.task_id,
      project_id: row.project_id,
      base_canonical_version: row.base_canonical_version,
      requested_by_credential_id: row.requested_by_credential_id,
      source_checkpoint_ids: fromJson(row.source_checkpoint_ids_json, []),
      source_event_ids: fromJson(row.source_event_ids_json, []),
      source_workstreams: fromJson(row.source_workstreams_json, []),
      operations: fromJson(row.operations_json, []),
      conflicts: fromJson(row.conflicts_json, []),
      policy: fromJson(row.policy_json, {}),
      source_fingerprint: row.source_fingerprint,
      status: row.status,
      created_at: row.created_at,
      resolved_at: row.resolved_at,
      resolved_by_credential_id: row.resolved_by_credential_id,
    };
  }

  canonicalRevisionFromRow(row) {
    return {
      revision_id: row.revision_id,
      task_id: row.task_id,
      project_id: row.project_id,
      canonical_version_before: row.canonical_version_before,
      canonical_version_after: row.canonical_version_after,
      proposal_id: row.proposal_id,
      operations: fromJson(row.operations_json, []),
      before_hash: row.before_hash,
      after_hash: row.after_hash,
      source_checkpoint_ids: fromJson(row.source_checkpoint_ids_json, []),
      source_event_ids: fromJson(row.source_event_ids_json, []),
      decision: row.decision,
      credential_id: row.credential_id,
      created_at: row.created_at,
    };
  }

  reconciliationCheckpoints(auth, taskId, sourceCheckpointIds = null) {
    if (sourceCheckpointIds === null) return this.latestCheckpoints(auth.user_id, taskId);
    if (!Array.isArray(sourceCheckpointIds) || sourceCheckpointIds.length > 50) {
      throw new ValidationError("source_checkpoint_ids must be an array with at most 50 items.");
    }
    const checkpoints = [];
    for (const checkpointId of [...new Set(sourceCheckpointIds)]) {
      assertIdentifier(checkpointId, "source_checkpoint_id");
      const row = this.db.prepare(`
        SELECT * FROM checkpoints
        WHERE user_id = ? AND task_id = ? AND checkpoint_id = ?
      `).get(auth.user_id, taskId, checkpointId);
      if (!row) throw new NotFoundError(`Checkpoint not found for Task: ${checkpointId}.`);
      checkpoints.push(this.checkpointFromRow(row));
    }
    return checkpoints;
  }

  reconciliationDeferredCheckpointIds(userId, proposal, until = proposal.resolved_at) {
    const params = [userId, proposal.task_id, proposal.created_at];
    const upperBound = until ? "AND created_at <= ?" : "";
    if (until) params.push(until);
    const sourceCheckpointIds = new Set(proposal.source_checkpoint_ids || []);
    return this.db.prepare(`
      SELECT checkpoint_id FROM checkpoints
      WHERE user_id = ? AND task_id = ? AND created_at > ? ${upperBound}
      ORDER BY created_at ASC, checkpoint_id ASC
    `).all(...params)
      .map((row) => row.checkpoint_id)
      .filter((checkpointId) => !sourceCheckpointIds.has(checkpointId));
  }

  runReconciliation(auth, taskId, payload = {}, { internal = false } = {}) {
    if (!internal) this.requireScope(auth, "task:reconcile:read");
    assertIdentifier(taskId, "task_id");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ValidationError("reconciliation payload must be an object.");
    }
    const taskRow = this.db.prepare(
      "SELECT * FROM tasks WHERE user_id = ? AND task_id = ?",
    ).get(auth.user_id, taskId);
    if (!taskRow) throw new NotFoundError("Task not found.");
    const task = this.taskFromRow(taskRow);
    const requestedOperations = payload.operations ?? [];
    if (!Array.isArray(requestedOperations) || requestedOperations.length > 50) {
      throw new ValidationError("operations must be an array with at most 50 items.");
    }
    const deriveCheckpointOperations = payload.derive_checkpoint_operations ?? true;
    if (typeof deriveCheckpointOperations !== "boolean") {
      throw new ValidationError("derive_checkpoint_operations must be a boolean.");
    }
    if (requestedOperations.length && !internal) {
      this.requireScope(auth, "task:reconcile:confirm");
    }
    const checkpoints = this.reconciliationCheckpoints(
      auth,
      taskId,
      payload.source_checkpoint_ids ?? (requestedOperations.length ? [] : null),
    );
    if (!deriveCheckpointOperations
        && (!requestedOperations.length
          || !Array.isArray(payload.source_checkpoint_ids)
          || checkpoints.length === 0)) {
      throw new ValidationError(
        "derive_checkpoint_operations=false requires explicit operations and source_checkpoint_ids.",
      );
    }
    if (!requestedOperations.length && payload.source_checkpoint_ids !== undefined
        && checkpoints.length > 0) {
      const requestedCheckpointIds = new Set(checkpoints.map((checkpoint) => checkpoint.checkpoint_id));
      const priorRows = this.db.prepare(`
        SELECT * FROM task_reconciliation_proposals
        WHERE user_id = ? AND task_id = ?
        ORDER BY created_at DESC
      `).all(auth.user_id, taskId);
      const prior = priorRows.find((row) => {
        const ids = new Set(fromJson(row.source_checkpoint_ids_json, []));
        return [...requestedCheckpointIds].every((checkpointId) => ids.has(checkpointId));
      });
      if (prior) {
        return { status: "existing", proposal: this.reconciliationProposalFromRow(prior) };
      }
    }
    let manualOperations;
    try {
      manualOperations = buildRequestedOperations(task, requestedOperations, auth);
    } catch (error) {
      throw new ValidationError(error.message);
    }
    const pendingRows = this.db.prepare(`
      SELECT * FROM task_reconciliation_proposals
      WHERE user_id = ? AND task_id = ? AND base_canonical_version = ?
        AND status = 'awaiting_confirmation'
      ORDER BY created_at ASC
    `).all(auth.user_id, taskId, task.canonical_version);
    const pending = pendingRows.map((row) => this.reconciliationProposalFromRow(row));
    if (!deriveCheckpointOperations && pending.length) {
      throw new ConflictError(
        "Resolve the pending reconciliation proposal before creating a curated checkpoint proposal.",
      );
    }
    if (!requestedOperations.length && pending.length) {
      const proposal = pending[0];
      const deferredCheckpointIds = this.reconciliationDeferredCheckpointIds(
        auth.user_id,
        proposal,
      );
      return {
        status: deferredCheckpointIds.length
          ? "deferred_pending_confirmation"
          : "existing",
        proposal,
        deferred_checkpoint_ids: deferredCheckpointIds,
        pending_proposal_count: pending.length,
        reason: deferredCheckpointIds.length
          ? "A displayed reconciliation proposal is frozen until its exact confirmation or rejection."
          : "An exact reconciliation proposal is already awaiting confirmation.",
      };
    }
    const operations = mergeOperations(
      pending.flatMap((proposal) => proposal.operations),
      deriveCheckpointOperations ? buildDerivedOperations(task, checkpoints) : [],
      manualOperations,
    );
    const conflicts = [
      ...new Map([
        ...pending.flatMap((proposal) => proposal.conflicts),
        ...detectOperationConflicts(operations),
      ].map((conflict) => [conflict.conflict_id, conflict])).values(),
    ];
    const sourceCheckpointIds = [...new Set([
      ...pending.flatMap((proposal) => proposal.source_checkpoint_ids),
      ...checkpoints.map((checkpoint) => checkpoint.checkpoint_id),
    ])].sort();
    const sourceEventIds = [...new Set([
      ...pending.flatMap((proposal) => proposal.source_event_ids),
      ...checkpoints.flatMap((checkpoint) => checkpoint.source_event_ids || []),
    ])].sort();
    const workstreamMap = new Map();
    for (const proposal of pending) {
      for (const workstream of proposal.source_workstreams) {
        workstreamMap.set(`${workstream.workstream_id}:${workstream.checkpoint_id}`, workstream);
      }
    }
    for (const checkpoint of checkpoints) {
      workstreamMap.set(`${checkpoint.workstream_id}:${checkpoint.checkpoint_id}`, {
        workstream_id: checkpoint.workstream_id,
        checkpoint_id: checkpoint.checkpoint_id,
        checkpoint_version: checkpoint.version,
        session_id: checkpoint.session_id,
        provenance: checkpoint.provenance,
      });
    }
    const sourceFingerprint = reconciliationFingerprint({
      userId: auth.user_id,
      taskId,
      baseCanonicalVersion: task.canonical_version,
      sourceCheckpointIds,
      operations,
    });
    const existing = this.db.prepare(`
      SELECT * FROM task_reconciliation_proposals
      WHERE user_id = ? AND source_fingerprint = ?
    `).get(auth.user_id, sourceFingerprint);
    if (existing) {
      return { status: "existing", proposal: this.reconciliationProposalFromRow(existing) };
    }

    const proposalId = randomUUID();
    const createdAt = nowIso();
    const allSafe = operations.length > 0
      && conflicts.length === 0
      && operations.every((operation) => operation.automatic_eligible === true);
    const initialStatus = operations.length ? "awaiting_confirmation" : "no_effect";
    const policy = {
      schema_version: RECONCILIATION_SCHEMA_VERSION,
      automatic_application_eligible: allSafe,
      automatic_application_performed: false,
      canonical_snapshot_items_ignored: true,
      derived_resource_telemetry_ignored: true,
      checkpoint_operations_derived: deriveCheckpointOperations,
      material_changes_require_confirmation: true,
      conflict_auto_resolution_performed: false,
    };
    this.db.prepare(`
      INSERT INTO task_reconciliation_proposals (
        proposal_id, user_id, task_id, project_id, proposal_version,
        base_canonical_version, requested_by_credential_id,
        source_checkpoint_ids_json, source_event_ids_json,
        source_workstreams_json, operations_json, conflicts_json, policy_json,
        source_fingerprint, status, created_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposalId,
      auth.user_id,
      taskId,
      task.project_id,
      task.canonical_version,
      auth.credential_id || null,
      asJson(sourceCheckpointIds),
      asJson(sourceEventIds),
      asJson([...workstreamMap.values()]),
      asJson(operations),
      asJson(conflicts),
      asJson(policy),
      sourceFingerprint,
      initialStatus,
      createdAt,
    );
    if (initialStatus === "awaiting_confirmation") {
      this.db.prepare(`
        UPDATE task_reconciliation_proposals
        SET status = 'superseded', resolved_at = ?
        WHERE user_id = ? AND task_id = ? AND base_canonical_version = ?
          AND status = 'awaiting_confirmation' AND proposal_id <> ?
      `).run(createdAt, auth.user_id, taskId, task.canonical_version, proposalId);
    }
    this.audit({
      auth,
      action: "task.reconciliation.generate",
      targetType: "task_reconciliation",
      targetId: proposalId,
      metadata: {
        task_id: taskId,
        base_canonical_version: task.canonical_version,
          operation_count: operations.length,
          conflict_count: conflicts.length,
          checkpoint_operations_derived: deriveCheckpointOperations,
          automatic_application_eligible: allSafe,
        },
    });
    let proposal = this.reconciliationProposalFromRow(this.db.prepare(
      "SELECT * FROM task_reconciliation_proposals WHERE proposal_id = ?",
    ).get(proposalId));
    if (allSafe) {
      const applied = this.applyReconciliationProposal(auth, proposal, {
        decision: "automatic",
        automatic: true,
      });
      proposal = applied.proposal;
      return { status: "auto_applied", ...applied, proposal };
    }
    return { status: initialStatus, proposal };
  }

  applyReconciliationProposal(auth, proposal, { decision, automatic = false } = {}) {
    if (!automatic) this.requireScope(auth, "task:reconcile:confirm");
    if (proposal.status !== "awaiting_confirmation") {
      throw new ConflictError(`Reconciliation proposal is already ${proposal.status}.`);
    }
    const taskRow = this.db.prepare(
      "SELECT * FROM tasks WHERE user_id = ? AND task_id = ?",
    ).get(auth.user_id, proposal.task_id);
    if (!taskRow) throw new NotFoundError("Task not found.");
    const task = this.taskFromRow(taskRow);
    if (task.canonical_version !== proposal.base_canonical_version) {
      this.db.prepare(`
        UPDATE task_reconciliation_proposals
        SET status = 'stale', resolved_at = ?
        WHERE proposal_id = ? AND status = 'awaiting_confirmation'
      `).run(nowIso(), proposal.proposal_id);
      throw new ConflictError("Canonical Task changed; generate a fresh reconciliation proposal.");
    }
    if (proposal.conflicts.length) {
      throw new ConflictError("Reconciliation proposal contains unresolved conflicts.");
    }
    const next = applyOperations(task, proposal.operations);
    const beforeHash = canonicalTaskHash(task);
    const afterHash = canonicalTaskHash(next);
    if (beforeHash === afterHash) {
      const resolvedAt = nowIso();
      this.db.prepare(`
        UPDATE task_reconciliation_proposals
        SET status = 'no_effect', resolved_at = ?, resolved_by_credential_id = ?
        WHERE proposal_id = ? AND status = 'awaiting_confirmation'
      `).run(resolvedAt, automatic ? null : auth.credential_id, proposal.proposal_id);
      return {
        status: "no_effect",
        proposal: this.reconciliationProposalFromRow(this.db.prepare(
          "SELECT * FROM task_reconciliation_proposals WHERE proposal_id = ?",
        ).get(proposal.proposal_id)),
        revision: null,
      };
    }

    const nextVersion = task.canonical_version + 1;
    const resolvedAt = nowIso();
    const deferredCheckpointIds = this.reconciliationDeferredCheckpointIds(
      auth.user_id,
      proposal,
      resolvedAt,
    );
    let revisionId;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`
        UPDATE tasks SET
          title = ?, goal = ?, status = ?, progress_json = ?, decisions_json = ?,
          blockers_json = ?, next_steps_json = ?, resources_json = ?,
          workstreams_json = ?, conflicts_json = ?, canonical_version = ?,
          updated_at = ?
        WHERE user_id = ? AND task_id = ? AND canonical_version = ?
      `).run(
        next.title,
        next.goal,
        next.status,
        asJson(next.progress),
        asJson(next.decisions),
        asJson(next.blockers),
        asJson(next.next_steps),
        asJson(next.resources),
        asJson(next.workstreams),
        asJson(next.conflicts),
        nextVersion,
        resolvedAt,
        auth.user_id,
        task.task_id,
        task.canonical_version,
      );
      if (result.changes !== 1) throw new ConflictError("Canonical Task changed during reconciliation.");
      revisionId = this.insertCanonicalRevision({
        auth,
        task: next,
        canonicalVersionBefore: task.canonical_version,
        canonicalVersionAfter: nextVersion,
        proposalId: proposal.proposal_id,
        operations: proposal.operations,
        beforeHash,
        afterHash,
        sourceCheckpointIds: proposal.source_checkpoint_ids,
        sourceEventIds: proposal.source_event_ids,
        decision,
        createdAt: resolvedAt,
      });
      const updated = this.db.prepare(`
        UPDATE task_reconciliation_proposals
        SET status = ?, resolved_at = ?, resolved_by_credential_id = ?,
            policy_json = ?
        WHERE proposal_id = ? AND status = 'awaiting_confirmation'
      `).run(
        automatic ? "auto_applied" : "applied",
        resolvedAt,
        automatic ? null : auth.credential_id,
        asJson({
          ...proposal.policy,
          automatic_application_performed: automatic,
        }),
        proposal.proposal_id,
      );
      if (updated.changes !== 1) throw new ConflictError("Reconciliation proposal changed during apply.");
      this.db.prepare(`
        UPDATE task_reconciliation_proposals
        SET status = 'stale', resolved_at = ?
        WHERE user_id = ? AND task_id = ? AND status = 'awaiting_confirmation'
          AND proposal_id <> ?
      `).run(resolvedAt, auth.user_id, task.task_id, proposal.proposal_id);
      this.audit({
        auth,
        action: "task.reconciliation.apply",
        targetType: "task_reconciliation",
        targetId: proposal.proposal_id,
        metadata: {
          task_id: task.task_id,
          revision_id: revisionId,
          decision,
          canonical_version_before: task.canonical_version,
          canonical_version_after: nextVersion,
        },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      status: automatic ? "auto_applied" : "applied",
      proposal: this.reconciliationProposalFromRow(this.db.prepare(
        "SELECT * FROM task_reconciliation_proposals WHERE proposal_id = ?",
      ).get(proposal.proposal_id)),
      revision: this.canonicalRevisionFromRow(this.db.prepare(
        "SELECT * FROM task_canonical_revisions WHERE revision_id = ?",
      ).get(revisionId)),
      task: this.taskFromRow(this.db.prepare(
        "SELECT * FROM tasks WHERE user_id = ? AND task_id = ?",
      ).get(auth.user_id, task.task_id)),
      deferred_checkpoint_ids: deferredCheckpointIds,
    };
  }

  resolveReconciliation(auth, proposalId, payload = {}) {
    this.requireScope(auth, "task:reconcile:confirm");
    assertIdentifier(proposalId, "proposal_id");
    if (!Number.isInteger(payload.proposal_version)
        || !Number.isInteger(payload.base_canonical_version)
        || !["confirm", "reject"].includes(payload.decision)) {
      throw new ValidationError(
        "proposal_version, base_canonical_version, and decision=confirm|reject are required.",
      );
    }
    const row = this.db.prepare(`
      SELECT * FROM task_reconciliation_proposals
      WHERE user_id = ? AND proposal_id = ?
    `).get(auth.user_id, proposalId);
    if (!row) throw new NotFoundError("Reconciliation proposal not found.");
    const proposal = this.reconciliationProposalFromRow(row);
    if (proposal.proposal_version !== payload.proposal_version
        || proposal.base_canonical_version !== payload.base_canonical_version) {
      throw new ConflictError("Reconciliation proposal version changed; show a fresh proposal.");
    }
    if (proposal.status === "applied" && payload.decision === "confirm") {
      const revisionRow = this.db.prepare(`
        SELECT * FROM task_canonical_revisions
        WHERE user_id = ? AND proposal_id = ?
      `).get(auth.user_id, proposalId);
      return {
        status: "applied",
        proposal,
        revision: revisionRow ? this.canonicalRevisionFromRow(revisionRow) : null,
        deferred_checkpoint_ids: this.reconciliationDeferredCheckpointIds(
          auth.user_id,
          proposal,
        ),
      };
    }
    if (proposal.status === "rejected" && payload.decision === "reject") {
      return {
        status: "rejected",
        proposal,
        deferred_checkpoint_ids: this.reconciliationDeferredCheckpointIds(
          auth.user_id,
          proposal,
        ),
      };
    }
    if (proposal.status !== "awaiting_confirmation") {
      throw new ConflictError(`Reconciliation proposal is already ${proposal.status}.`);
    }
    if (payload.decision === "reject") {
      const resolvedAt = nowIso();
      const deferredCheckpointIds = this.reconciliationDeferredCheckpointIds(
        auth.user_id,
        proposal,
        resolvedAt,
      );
      this.db.prepare(`
        UPDATE task_reconciliation_proposals
        SET status = 'rejected', resolved_at = ?, resolved_by_credential_id = ?
        WHERE proposal_id = ? AND status = 'awaiting_confirmation'
      `).run(resolvedAt, auth.credential_id, proposalId);
      this.audit({
        auth,
        action: "task.reconciliation.reject",
        targetType: "task_reconciliation",
        targetId: proposalId,
        metadata: { task_id: proposal.task_id, base_canonical_version: proposal.base_canonical_version },
      });
      return {
        status: "rejected",
        proposal: this.reconciliationProposalFromRow(this.db.prepare(
          "SELECT * FROM task_reconciliation_proposals WHERE proposal_id = ?",
        ).get(proposalId)),
        deferred_checkpoint_ids: deferredCheckpointIds,
      };
    }
    return this.applyReconciliationProposal(auth, proposal, {
      decision: "user_confirmed",
      automatic: false,
    });
  }

  reconciliationState(auth, taskId, { includeProposals = true, internal = false } = {}) {
    if (!internal) this.requireScope(auth, "task:reconcile:read");
    assertIdentifier(taskId, "task_id");
    const taskRow = this.db.prepare(
      "SELECT * FROM tasks WHERE user_id = ? AND task_id = ?",
    ).get(auth.user_id, taskId);
    if (!taskRow) throw new NotFoundError("Task not found.");
    const task = this.taskFromRow(taskRow);
    const rows = this.db.prepare(`
      SELECT * FROM task_reconciliation_proposals
      WHERE user_id = ? AND task_id = ?
      ORDER BY created_at DESC LIMIT 50
    `).all(auth.user_id, taskId);
    const proposals = rows.map((row) => this.reconciliationProposalFromRow(row));
    const pending = proposals.filter((proposal) => proposal.status === "awaiting_confirmation");
    const conflictCount = pending.reduce((sum, proposal) => sum + proposal.conflicts.length, 0);
    const deferredCheckpointIds = [...new Set(pending.flatMap((proposal) =>
      this.reconciliationDeferredCheckpointIds(auth.user_id, proposal)))];
    const latestRevisionRow = this.db.prepare(`
      SELECT * FROM task_canonical_revisions
      WHERE user_id = ? AND task_id = ?
      ORDER BY canonical_version_after DESC LIMIT 1
    `).get(auth.user_id, taskId);
    return {
      schema_version: RECONCILIATION_SCHEMA_VERSION,
      task_id: taskId,
      canonical_version: task.canonical_version,
      canonical_freshness: conflictCount
        ? "conflict_pending"
        : pending.length
          ? "updates_pending"
          : "fresh",
      summary: {
        pending: pending.length,
        conflicts: conflictCount,
        auto_applied: proposals.filter((proposal) =>
          proposal.status === "auto_applied"
          && proposal.policy.automatic_application_performed).length,
        stale: proposals.filter((proposal) => proposal.status === "stale").length,
        deferred_checkpoints: deferredCheckpointIds.length,
        oldest_pending_at: pending.length
          ? [...pending].sort((left, right) => left.created_at.localeCompare(right.created_at))[0].created_at
          : null,
      },
      latest_revision: latestRevisionRow
        ? this.canonicalRevisionFromRow(latestRevisionRow)
        : null,
      deferred_checkpoint_ids: deferredCheckpointIds,
      ...(includeProposals ? { proposals } : {}),
    };
  }

  listCanonicalRevisions(auth, taskId, limit = 50) {
    this.requireScope(auth, "task:reconcile:read");
    assertIdentifier(taskId, "task_id");
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    return this.db.prepare(`
      SELECT * FROM task_canonical_revisions
      WHERE user_id = ? AND task_id = ?
      ORDER BY canonical_version_after DESC LIMIT ?
    `).all(auth.user_id, taskId, safeLimit).map((row) => this.canonicalRevisionFromRow(row));
  }

  createCheckpoint(auth, sessionId, payload = {}) {
    this.requireScope(auth, "capture:write");
    assertIdentifier(sessionId, "session_id");
    if (payload.task_id) assertIdentifier(payload.task_id, "task_id");
    if (payload.workstream_id) assertIdentifier(payload.workstream_id, "workstream_id");
    const conditions = ["user_id = ?", "session_id = ?"];
    const params = [auth.user_id, sessionId];
    if (payload.task_id) {
      conditions.push("task_id = ?");
      params.push(payload.task_id);
    }
    if (payload.workstream_id) {
      conditions.push("workstream_id = ?");
      params.push(payload.workstream_id);
    }
    const trigger = this.db.prepare(`
      SELECT rowid AS event_rowid, * FROM events
      WHERE ${conditions.join(" AND ")}
      ORDER BY rowid DESC LIMIT 1
    `).get(...params);
    if (!trigger) throw new NotFoundError("No captured events found for this session and scope.");
    return this.createCheckpointFromTrigger(auth, trigger.event_id, {
      automatic: false,
      triggerType: "manual_request",
    });
  }

  createCheckpointFromTrigger(auth, eventId, { automatic = true, triggerType = null } = {}) {
    const trigger = this.db.prepare(`
      SELECT rowid AS event_rowid, * FROM events
      WHERE user_id = ? AND event_id = ?
    `).get(auth.user_id, eventId);
    if (!trigger) throw new NotFoundError("Checkpoint trigger event not found.");
    if (!trigger.task_id || !trigger.workstream_id || !trigger.session_id || !trigger.project_id) {
      return {
        status: "skipped",
        reason: "missing_project_task_workstream_or_session_scope",
        trigger_event_id: eventId,
      };
    }
    const existingForTrigger = this.db.prepare(`
      SELECT * FROM checkpoints
      WHERE user_id = ? AND trigger_event_id = ?
      ORDER BY version DESC LIMIT 1
    `).get(auth.user_id, eventId);
    if (existingForTrigger) {
      const checkpoint = this.checkpointFromRow(existingForTrigger);
      const structuredMemories = this.deriveStructuredMemories(
        auth,
        checkpoint,
        this.checkpointSourceEvents(auth.user_id, checkpoint),
      );
      let reconciliation;
      try {
        reconciliation = this.runReconciliation(auth, checkpoint.task_id, {
          source_checkpoint_ids: [checkpoint.checkpoint_id],
        }, { internal: true });
      } catch (error) {
        reconciliation = { status: "failed", error: error.message };
      }
      return { status: "existing", checkpoint, structured_memories: structuredMemories, reconciliation };
    }

    const taskRow = this.db.prepare(`
      SELECT * FROM tasks WHERE user_id = ? AND task_id = ?
    `).get(auth.user_id, trigger.task_id);
    if (!taskRow) {
      return { status: "skipped", reason: "task_not_found", trigger_event_id: eventId };
    }
    const task = this.taskFromRow(taskRow);
    const previous = this.db.prepare(`
      SELECT c.*, e.rowid AS trigger_rowid
      FROM checkpoints c
      LEFT JOIN events e ON e.event_id = c.trigger_event_id
      WHERE c.user_id = ? AND c.task_id = ? AND c.workstream_id = ?
        AND c.session_id = ?
      ORDER BY c.version DESC LIMIT 1
    `).get(auth.user_id, trigger.task_id, trigger.workstream_id, trigger.session_id);
    const lowerRowId = previous?.trigger_rowid || 0;
    const events = this.db.prepare(`
      SELECT rowid AS event_rowid, event_id, event_type, hook_event_name,
             captured_at, received_at, expired_at, content, cwd, tool_name,
             device_id, agent_id, agent_instance_id
      FROM events
      WHERE user_id = ? AND task_id = ? AND workstream_id = ? AND session_id = ?
        AND rowid > ? AND rowid <= ?
      ORDER BY rowid DESC LIMIT ?
    `).all(
      auth.user_id,
      trigger.task_id,
      trigger.workstream_id,
      trigger.session_id,
      lowerRowId,
      trigger.event_rowid,
      CHECKPOINT_EVENT_LIMIT,
    ).reverse();
    const meaningfulEvents = events.filter((event) =>
      (event.content && !event.expired_at) || event.cwd || event.tool_name ||
      !["session_end", "session_start"].includes(event.event_type),
    );
    if (!meaningfulEvents.length) {
      return { status: "skipped", reason: "no_new_meaningful_events", trigger_event_id: eventId };
    }

    const sourceEventIds = events.map((event) => event.event_id);
    const sourceFingerprint = createHash("sha256").update(asJson({
      method: "deterministic-rules-v0.1",
      user_id: auth.user_id,
      task_id: trigger.task_id,
      workstream_id: trigger.workstream_id,
      session_id: trigger.session_id,
      source_event_ids: sourceEventIds,
    })).digest("hex");
    const existingFingerprint = this.db.prepare(`
      SELECT * FROM checkpoints WHERE user_id = ? AND source_fingerprint = ?
    `).get(auth.user_id, sourceFingerprint);
    if (existingFingerprint) {
      const checkpoint = this.checkpointFromRow(existingFingerprint);
      return {
        status: "existing",
        checkpoint,
        structured_memories: this.deriveStructuredMemories(
          auth,
          checkpoint,
          this.checkpointSourceEvents(auth.user_id, checkpoint),
        ),
      };
    }

    const contentEvents = events.map((event) => ({
      ...event,
      decoded_content: event.expired_at ? null : fromJson(event.content, null),
    }));
    const lastUser = [...contentEvents].reverse().find((event) =>
      event.event_type === "user_message" && textContent(event.decoded_content));
    const lastAssistant = [...contentEvents].reverse().find((event) =>
      event.event_type === "assistant_message" && textContent(event.decoded_content));
    const activeRequest = lastUser ? {
      text: compactText(lastUser.decoded_content),
      source_event_id: lastUser.event_id,
    } : null;
    const latestOutcome = lastAssistant ? {
      text: compactText(lastAssistant.decoded_content),
      source_event_id: lastAssistant.event_id,
    } : null;
    const classified = classifyCheckpointStatements(events);
    const resources = uniqueByText([
      ...canonicalItems(task.resources, "resource"),
      ...events.flatMap((event) => [
        event.cwd ? derivedItem(event.cwd, event.event_id, "working_directory", "high") : null,
        event.tool_name ? derivedItem(event.tool_name, event.event_id, "tool", "high") : null,
      ]).filter(Boolean),
    ]).slice(0, 30);
    const completedItems = uniqueByText([
      ...canonicalItems(task.progress, "completed"),
      ...classified.completed,
    ]).slice(0, 20);
    const decisions = uniqueByText([
      ...canonicalItems(task.decisions, "decision"),
      ...classified.decisions,
    ]).slice(0, 20);
    const blockers = uniqueByText([
      ...canonicalItems(task.blockers, "blocker"),
      ...classified.blockers,
    ]).slice(0, 20);
    const nextSteps = uniqueByText([
      ...canonicalItems(task.next_steps, "next_step"),
      ...classified.nextSteps,
    ]).slice(0, 20);
    const confidence = checkpointConfidence({ activeRequest, latestOutcome, classified });
    const warnings = [];
    if (!activeRequest) warnings.push("No user message was available in this checkpoint window.");
    if (!latestOutcome) warnings.push("No assistant outcome was available in this checkpoint window.");
    if (events.some((event) => event.expired_at)) {
      warnings.push("At least one source event had expired raw content before derivation.");
    }
    if (events.length === CHECKPOINT_EVENT_LIMIT) {
      warnings.push(`Source window was limited to the latest ${CHECKPOINT_EVENT_LIMIT} events.`);
    }
    warnings.push("Rule-based extraction may omit implicit decisions, blockers, or next steps.");

    const version = Number(this.db.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version FROM checkpoints
      WHERE user_id = ? AND task_id = ? AND workstream_id = ?
    `).get(auth.user_id, trigger.task_id, trigger.workstream_id).version) + 1;
    const checkpointId = randomUUID();
    const createdAt = nowIso();
    const content = {
      goal: task.goal,
      active_request: activeRequest,
      latest_outcome: latestOutcome,
      completed_items: completedItems,
      decisions,
      resources,
      blockers,
      unfinished_items: nextSteps,
      recommended_next_steps: nextSteps,
      conflicts: task.conflicts,
      recent_activity: contentEvents.map((event) => ({
        event_id: event.event_id,
        event_type: event.event_type,
        captured_at: event.captured_at,
        summary: event.expired_at
          ? null
          : compactText(event.decoded_content || event.tool_name || event.hook_event_name, 240) || null,
        source_status: event.expired_at ? "raw_expired" : "available",
        provenance: {
          device_id: event.device_id,
          agent_id: event.agent_id,
          agent_instance_id: event.agent_instance_id,
        },
      })),
      source_identities: [...new Map(events.map((event) => [
        `${event.agent_instance_id}@${event.device_id}`,
        {
          device_id: event.device_id,
          agent_id: event.agent_id,
          agent_instance_id: event.agent_instance_id,
        },
      ])).values()],
      generation: {
        automatic,
        policy: "immutable-derived-snapshot",
        canonical_task_state_overwritten: false,
      },
    };
    this.db.prepare(`
      INSERT INTO checkpoints (
        checkpoint_id, user_id, task_id, project_id, workstream_id, session_id,
        version, status, trigger_type, trigger_event_id, source_fingerprint,
        content_json, source_event_ids_json, device_id, agent_id,
        agent_instance_id, generation_method, confidence, confidence_label,
        warnings_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      checkpointId,
      auth.user_id,
      trigger.task_id,
      trigger.project_id,
      trigger.workstream_id,
      trigger.session_id,
      version,
      "derived",
      triggerType || trigger.hook_event_name || trigger.event_type,
      trigger.event_id,
      sourceFingerprint,
      asJson(content),
      asJson(sourceEventIds),
      trigger.device_id,
      trigger.agent_id,
      trigger.agent_instance_id,
      "deterministic-rules-v0.1",
      confidence.score,
      confidence.label,
      asJson(warnings),
      createdAt,
    );
    this.audit({
      auth,
      action: "checkpoint.create",
      targetType: "checkpoint",
      targetId: checkpointId,
      metadata: {
        automatic,
        task_id: trigger.task_id,
        workstream_id: trigger.workstream_id,
        session_id: trigger.session_id,
        version,
        source_event_count: sourceEventIds.length,
        confidence: confidence.score,
      },
    });
    const row = this.db.prepare("SELECT * FROM checkpoints WHERE checkpoint_id = ?")
      .get(checkpointId);
    const checkpoint = this.checkpointFromRow(row);
    const structuredMemories = this.deriveStructuredMemories(auth, checkpoint, contentEvents);
    let reconciliation;
    try {
      reconciliation = this.runReconciliation(auth, checkpoint.task_id, {
        source_checkpoint_ids: [checkpoint.checkpoint_id],
      }, { internal: true });
    } catch (error) {
      this.audit({
        auth,
        action: "task.reconciliation.generate",
        targetType: "checkpoint",
        targetId: checkpointId,
        outcome: "failed",
        metadata: { error: error.message },
      });
      reconciliation = { status: "failed", error: error.message };
    }
    return { status: "created", checkpoint, structured_memories: structuredMemories, reconciliation };
  }

  checkpointSourceEvents(userId, checkpoint) {
    const sourceEventIds = checkpoint.source_event_ids || [];
    if (!sourceEventIds.length) return [];
    const placeholders = sourceEventIds.map(() => "?").join(", ");
    return this.db.prepare(`
      SELECT rowid AS event_rowid, event_id, event_type, hook_event_name,
             captured_at, received_at, expired_at, content, cwd, tool_name,
             device_id, agent_id, agent_instance_id
      FROM events
      WHERE user_id = ? AND event_id IN (${placeholders})
      ORDER BY rowid ASC
    `).all(userId, ...sourceEventIds).map((event) => ({
      ...event,
      decoded_content: event.expired_at ? null : fromJson(event.content, null),
    }));
  }

  deriveStructuredMemories(auth, checkpoint, events) {
    const candidates = structuredMemoryStatements(events);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO memories (
        memory_id, user_id, credential_id, device_id, agent_id, agent_instance_id,
        content, scope, project_id, task_id, workstream_id, session_id, source,
        memory_type, status, source_event_ids_json, source_checkpoint_id,
        generation_method, confidence, confidence_label, warnings_json,
        content_fingerprint, topic, topic_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'workstream', ?, ?, ?, ?, 'checkpoint_derived',
                ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const created = [];
    const existing = [];
    for (const candidate of candidates) {
      const fingerprint = structuredMemoryFingerprint({
        userId: auth.user_id,
        scope: "workstream",
        projectId: checkpoint.project_id,
        taskId: checkpoint.task_id,
        workstreamId: checkpoint.workstream_id,
        sessionId: null,
        memoryType: candidate.memory_type,
        topicKey: candidate.topic_key,
        content: candidate.content,
      });
      const memoryId = randomUUID();
      const timestamp = nowIso();
      const result = insert.run(
        memoryId,
        auth.user_id,
        auth.credential_id,
        checkpoint.provenance.device_id,
        checkpoint.provenance.agent_id,
        checkpoint.provenance.agent_instance_id,
        candidate.content,
        checkpoint.project_id,
        checkpoint.task_id,
        checkpoint.workstream_id,
        checkpoint.session_id,
        candidate.memory_type,
        asJson(candidate.source_event_ids),
        checkpoint.checkpoint_id,
        candidate.generation_method,
        candidate.confidence,
        candidate.confidence_label,
        asJson(candidate.warnings),
        fingerprint,
        candidate.topic,
        candidate.topic_key,
        timestamp,
        timestamp,
      );
      const row = this.db.prepare(
        "SELECT * FROM memories WHERE user_id = ? AND content_fingerprint = ?",
      ).get(auth.user_id, fingerprint);
      const memory = this.memoryFromRow(row);
      if (result.changes) {
        created.push(memory);
        this.audit({
          auth,
          action: "memory.derive",
          targetType: "memory",
          targetId: memory.memory_id,
          metadata: {
            source_checkpoint_id: checkpoint.checkpoint_id,
            source_event_ids: candidate.source_event_ids,
            memory_type: candidate.memory_type,
            workstream_id: checkpoint.workstream_id,
            generation_method: candidate.generation_method,
          },
        });
      } else {
        existing.push(memory);
      }
    }
    return {
      schema_version: "automatic-structured-memory-v0.1",
      extracted: candidates.length,
      created: created.length,
      existing: existing.length,
      memories: created,
      canonical_task_state_overwritten: false,
      automatic_merge_performed: false,
    };
  }

  appendEvents(auth, input) {
    this.requireScope(auth, "capture:write");
    const events = Array.isArray(input.events) ? input.events : [input.event || input];
    if (!events.length || events.length > 100) {
      throw new ValidationError("events must contain between 1 and 100 items.");
    }
    const retentionDays = parseRetention(
      input.raw_retention_days,
      this.getRetention().raw_retention_days,
    );
    const receivedAt = nowIso();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO events (
        event_id, user_id, credential_id, device_id, agent_id, agent_instance_id,
        project_id, task_id, workstream_id, session_id, turn_id, event_type,
        hook_event_name, captured_at, received_at, expires_at, content,
        raw_payload_json, capture_capability_json, cwd, model, tool_name, tool_use_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let inserted = 0;
    const checkpointTriggers = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        assertIdentifier(event.event_id, "event_id");
        if (!event.event_type) throw new ValidationError("event_type is required.");
        const capturedAt = Number.isFinite(Date.parse(event.captured_at))
          ? new Date(event.captured_at).toISOString()
          : receivedAt;
        const result = insert.run(
          event.event_id,
          auth.user_id,
          auth.credential_id,
          auth.device_id,
          auth.agent_id,
          auth.agent_instance_id,
          event.project_id || null,
          event.task_id || null,
          event.workstream_id || null,
          event.session_id || null,
          event.turn_id || null,
          event.event_type,
          event.hook_event_name || null,
          capturedAt,
          receivedAt,
          retentionExpiry(capturedAt, retentionDays),
          event.content === undefined ? null : asJson(event.content),
          asJson(event.raw_hook_payload ?? event.raw_payload ?? event),
          asJson(event.capture_capability || null),
          event.cwd || null,
          event.model || null,
          event.tool_name || null,
          event.tool_use_id || null,
        );
        inserted += Number(result.changes);
        if (CHECKPOINT_TRIGGER_TYPES.has(event.event_type)) {
          checkpointTriggers.push(event.event_id);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const checkpoints = checkpointTriggers.map((eventId) => {
      try {
        return this.createCheckpointFromTrigger(auth, eventId, { automatic: true });
      } catch (error) {
        this.audit({
          auth,
          action: "checkpoint.create",
          targetType: "event",
          targetId: eventId,
          outcome: "failed",
          metadata: { error: error.message },
        });
        return { status: "failed", trigger_event_id: eventId, error: error.message };
      }
    });
    this.audit({ auth, action: "events.append", targetType: "event", outcome: "success", metadata: { received: events.length, inserted, checkpoint_results: checkpoints.map(({ status }) => status) } });
    return {
      status: "accepted",
      received: events.length,
      inserted,
      duplicate: events.length - inserted,
      checkpoints,
    };
  }

  saveMemory(auth, payload) {
    this.requireScope(auth, "memory:write");
    if (typeof payload.content !== "string" || !payload.content.trim()) {
      throw new ValidationError("content is required.");
    }
    const allowedScopes = new Set(["user", "project", "task", "workstream", "session"]);
    if (!allowedScopes.has(payload.scope)) {
      throw new ValidationError("scope must be user, project, task, workstream, or session.");
    }
    const memoryType = payload.memory_type || "fact";
    if (!STRUCTURED_MEMORY_TYPES.has(memoryType)) {
      throw new ValidationError("memory_type is invalid.");
    }
    const topic = payload.topic === undefined || payload.topic === null
      ? null
      : compactText(payload.topic, 120);
    if (payload.topic !== undefined && payload.topic !== null
        && (typeof payload.topic !== "string" || !topic)) {
      throw new ValidationError("topic must be a non-empty string of at most 120 characters.");
    }
    const memoryId = randomUUID();
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO memories (
        memory_id, user_id, credential_id, device_id, agent_id, agent_instance_id,
        content, scope, project_id, task_id, workstream_id, session_id, source,
        memory_type, status, source_event_ids_json, source_checkpoint_id,
        generation_method, confidence, confidence_label, warnings_json,
        content_fingerprint, topic, topic_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '[]', NULL,
                'explicit-user-save-v0.1', 1.0, 'high', '[]', NULL, ?, ?, ?, ?)
    `).run(
      memoryId,
      auth.user_id,
      auth.credential_id,
      auth.device_id,
      auth.agent_id,
      auth.agent_instance_id,
      payload.content.trim(),
      payload.scope,
      payload.project_id || null,
      payload.task_id || null,
      payload.workstream_id || null,
      payload.session_id || null,
      payload.source || "explicit",
      memoryType,
      topic,
      topic ? normalize(topic) : null,
      createdAt,
      createdAt,
    );
    this.audit({ auth, action: "memory.create", targetType: "memory", targetId: memoryId });
    return {
      status: "saved",
      memory: {
        memory_id: memoryId,
        content: payload.content.trim(),
        scope: payload.scope,
        project_id: payload.project_id || null,
        task_id: payload.task_id || null,
        workstream_id: payload.workstream_id || null,
        session_id: payload.session_id || null,
        memory_type: memoryType,
        status: "active",
        topic,
        topic_key: topic ? normalize(topic) : null,
        source_event_ids: [],
        source_checkpoint_id: null,
        generation: {
          method: "explicit-user-save-v0.1",
          confidence: 1,
          confidence_label: "high",
          warnings: [],
        },
        created_at: createdAt,
        updated_at: createdAt,
        lifecycle: {
          schema_version: STRUCTURED_MEMORY_LIFECYCLE_SCHEMA_VERSION,
          supersedes_memory_id: null,
          superseded_by_memory_id: null,
          reason: null,
          retracted_at: null,
          actor: {},
        },
        provenance: this.publicIdentity(auth),
        source: payload.source || "explicit",
      },
    };
  }

  queryMemories(auth, payload) {
    this.requireScope(auth, "memory:read");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new ValidationError("Memory query must be an object.");
    }
    if (typeof payload.query !== "string" || !payload.query.trim()
        || payload.query.length > 4_096) {
      throw new ValidationError("query is required and must be at most 4096 characters.");
    }
    for (const key of ["project_id", "task_id", "session_id"]) {
      if (payload[key] !== undefined) assertIdentifier(payload[key], key);
    }
    const workstreamIds = requestedSourceWorkstreamIds(payload);
    const statuses = payload.statuses === undefined ? ["active"] : payload.statuses;
    assertStringArray(statuses, "statuses", { maxItems: 3, maxLength: 32 });
    if (!statuses.length) throw new ValidationError("statuses must not be empty.");
    if (statuses.some((status) => !STRUCTURED_MEMORY_STATUSES.has(status))) {
      throw new ValidationError("statuses contains an invalid memory status.");
    }
    const memoryTypes = payload.memory_types === undefined
      ? [...STRUCTURED_MEMORY_TYPES]
      : payload.memory_types;
    assertStringArray(memoryTypes, "memory_types", { maxItems: 8, maxLength: 32 });
    if (!memoryTypes.length) throw new ValidationError("memory_types must not be empty.");
    if (memoryTypes.some((memoryType) => !STRUCTURED_MEMORY_TYPES.has(memoryType))) {
      throw new ValidationError("memory_types contains an invalid memory type.");
    }
    if (payload.limit !== undefined
        && (!Number.isInteger(payload.limit) || payload.limit < 1)) {
      throw new ValidationError("limit must be a positive integer.");
    }
    if (payload.include_shared !== undefined && typeof payload.include_shared !== "boolean") {
      throw new ValidationError("include_shared must be boolean.");
    }
    const limit = Math.min(payload.limit || 10, STRUCTURED_MEMORY_RETRIEVAL_RESULT_LIMIT);
    const includeShared = payload.include_shared !== false;
    const statusPlaceholders = statuses.map(() => "?").join(", ");
    const typePlaceholders = memoryTypes.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT *
      FROM memories
      WHERE user_id = ?
        AND status IN (${statusPlaceholders})
        AND memory_type IN (${typePlaceholders})
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT ?
    `).all(
      auth.user_id,
      ...statuses,
      ...memoryTypes,
      STRUCTURED_MEMORY_RETRIEVAL_CANDIDATE_LIMIT,
    );
    const workstreamSet = workstreamIds ? new Set(workstreamIds) : null;
    const currentTime = Date.now();
    const candidates = rows
      .map((row) => this.memoryFromRow(row))
      .filter((memory) => {
        if (payload.project_id
            && memory.scope !== "user"
            && memory.project_id !== payload.project_id) return false;
        if (payload.task_id
            && !["user", "project"].includes(memory.scope)
            && memory.task_id !== payload.task_id) return false;
        if (payload.session_id
            && memory.scope === "session"
            && memory.session_id !== payload.session_id) return false;
        if (workstreamSet && memory.workstream_id !== null
            && !workstreamSet.has(memory.workstream_id)) return false;
        if (!includeShared && workstreamSet && memory.workstream_id === null) return false;
        return true;
      })
      .map((memory) => {
        const lexical = memoryLexicalScore(payload.query, memory);
        if (lexical <= 0) return null;
        const confidence = Number.isFinite(memory.generation.confidence)
          ? memory.generation.confidence
          : 0.5;
        const scope = memoryScopeScore(memory);
        const recency = memoryRecencyScore(memory, currentTime);
        const score = Number((
          lexical * 0.72
          + confidence * 0.12
          + scope * 0.1
          + recency * 0.06
        ).toFixed(6));
        return {
          ...memory,
          ranking: {
            score,
            lexical_score: Number(lexical.toFixed(6)),
            confidence_score: Number(confidence.toFixed(6)),
            scope_score: Number(scope.toFixed(6)),
            recency_score: Number(recency.toFixed(6)),
            method: "deterministic-lexical-scope-confidence-recency-v0.1",
          },
        };
      })
      .filter(Boolean)
      .sort((left, right) =>
        right.ranking.score - left.ranking.score
        || right.updated_at.localeCompare(left.updated_at)
        || left.memory_id.localeCompare(right.memory_id));
    const topicGroups = new Map();
    for (const memory of candidates.filter((candidate) =>
      candidate.status === "active" && candidate.topic_key && candidate.workstream_id)) {
      const key = [memory.project_id, memory.task_id, memory.memory_type, memory.topic_key]
        .map((value) => value || "").join("\u0000");
      const group = topicGroups.get(key) || [];
      group.push(memory);
      topicGroups.set(key, group);
    }
    const potentialConflicts = [...topicGroups.entries()].flatMap(([key, group]) => {
      const contents = new Set(group.map((memory) => normalize(memory.content)));
      const workstreams = new Set(group.map((memory) => memory.workstream_id));
      if (contents.size < 2 || workstreams.size < 2) return [];
      return [{
        conflict_id: `memory-divergence:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
        classification: "potential_conflict",
        memory_type: group[0].memory_type,
        topic: group[0].topic,
        topic_key: group[0].topic_key,
        memory_ids: group.map((memory) => memory.memory_id),
        workstream_ids: [...workstreams].sort(),
        variants: group.map((memory) => ({
          memory_id: memory.memory_id,
          content: compactText(memory.content, 600),
          workstream_id: memory.workstream_id,
          source_event_ids: memory.source_event_ids,
          source_checkpoint_id: memory.source_checkpoint_id,
          provenance: memory.provenance,
        })),
        source_preserved: true,
        automatic_resolution_performed: false,
      }];
    });
    const task = payload.task_id
      ? this.listTasks(auth.user_id).find((candidate) => candidate.task_id === payload.task_id)
      : null;
    const result = {
      schema_version: STRUCTURED_MEMORY_RETRIEVAL_SCHEMA_VERSION,
      read_only: true,
      query: payload.query.trim(),
      filters: {
        project_id: payload.project_id || null,
        task_id: payload.task_id || null,
        source_workstream_ids: workstreamIds || [],
        session_id: payload.session_id || null,
        memory_types: memoryTypes,
        statuses,
        include_shared: includeShared,
      },
      results: candidates.slice(0, limit).map((memory) => ({
        ...memory,
        content: compactText(memory.content, 1_000),
      })),
      result_count: Math.min(candidates.length, limit),
      matched_candidate_count: candidates.length,
      candidate_limit: STRUCTURED_MEMORY_RETRIEVAL_CANDIDATE_LIMIT,
      result_limit: limit,
      truncated: candidates.length > limit,
      conflict_presentation: {
        potential_conflicts: potentialConflicts.slice(0, 20),
        recorded_task_conflicts: boundedStrings(task?.conflicts || [], {
          limit: 20,
          textLimit: 600,
        }),
        unscoped_differences_classified_as_conflicts: false,
        automatic_merge_performed: false,
        automatic_resolution_performed: false,
      },
      safety: {
        resume_created: false,
        task_scope_changed: false,
        context_injected: false,
        canonical_task_state_overwritten: false,
        memory_lifecycle_changed: false,
      },
    };
    if (serializedBytes(result) > READ_PREVIEW_RESPONSE_BUDGET_BYTES) {
      throw new Error("Memory query exceeded its response budget.");
    }
    this.audit({
      auth,
      action: "memory.query",
      targetType: "memory",
      metadata: {
        result_count: result.result_count,
        matched_candidate_count: result.matched_candidate_count,
        potential_conflict_count: potentialConflicts.length,
      },
    });
    return result;
  }

  supersedeMemory(auth, memoryId, payload) {
    this.requireScope(auth, "memory:write");
    assertIdentifier(memoryId, "memory_id");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
        || typeof payload.content !== "string" || !payload.content.trim()) {
      throw new ValidationError("content is required.");
    }
    if (payload.content.length > 4_096) {
      throw new ValidationError("content must be at most 4096 characters.");
    }
    const reason = payload.reason === undefined
      ? "Explicit user correction."
      : compactText(payload.reason, 1_000);
    if (payload.reason !== undefined
        && (typeof payload.reason !== "string" || !reason)) {
      throw new ValidationError("reason must be a non-empty string.");
    }
    const targetRow = this.db.prepare(
      "SELECT * FROM memories WHERE user_id = ? AND memory_id = ?",
    ).get(auth.user_id, memoryId);
    if (!targetRow) throw new NotFoundError("Memory not found.");
    const memoryType = payload.memory_type || targetRow.memory_type || "fact";
    if (!STRUCTURED_MEMORY_TYPES.has(memoryType)) {
      throw new ValidationError("memory_type is invalid.");
    }
    const topic = payload.topic === undefined
      ? targetRow.topic || null
      : payload.topic === null ? null : compactText(payload.topic, 120);
    if (payload.topic !== undefined && payload.topic !== null
        && (typeof payload.topic !== "string" || !topic)) {
      throw new ValidationError("topic must be null or a non-empty string.");
    }
    if (targetRow.status === "superseded" && targetRow.superseded_by_memory_id) {
      const existingRow = this.db.prepare(
        "SELECT * FROM memories WHERE user_id = ? AND memory_id = ?",
      ).get(auth.user_id, targetRow.superseded_by_memory_id);
      if (existingRow
          && normalize(existingRow.content) === normalize(payload.content)
          && existingRow.memory_type === memoryType
          && (existingRow.topic_key || null) === (topic ? normalize(topic) : null)) {
        return {
          schema_version: STRUCTURED_MEMORY_LIFECYCLE_SCHEMA_VERSION,
          status: "existing",
          previous_memory: this.memoryFromRow(targetRow),
          replacement_memory: this.memoryFromRow(existingRow),
          idempotent: true,
        };
      }
      throw new ConflictError("Memory was already superseded by a different replacement.");
    }
    if (targetRow.status !== "active") {
      throw new ConflictError(`Memory is ${targetRow.status} and cannot be superseded.`);
    }
    const replacementId = randomUUID();
    const timestamp = nowIso();
    const actor = this.publicIdentity(auth);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO memories (
          memory_id, user_id, credential_id, device_id, agent_id, agent_instance_id,
          content, scope, project_id, task_id, workstream_id, session_id, source,
          memory_type, status, source_event_ids_json, source_checkpoint_id,
          generation_method, confidence, confidence_label, warnings_json,
          content_fingerprint, topic, topic_key, supersedes_memory_id,
          lifecycle_reason, lifecycle_actor_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'explicit_correction', ?,
                  'active', '[]', NULL, 'explicit-user-correction-v0.1', 1.0,
                  'high', '[]', NULL, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        replacementId,
        auth.user_id,
        auth.credential_id,
        auth.device_id,
        auth.agent_id,
        auth.agent_instance_id,
        payload.content.trim(),
        targetRow.scope,
        targetRow.project_id,
        targetRow.task_id,
        targetRow.workstream_id,
        targetRow.session_id,
        memoryType,
        topic,
        topic ? normalize(topic) : null,
        memoryId,
        reason,
        asJson(actor),
        timestamp,
        timestamp,
      );
      this.db.prepare(`
        UPDATE memories
        SET status = 'superseded', superseded_by_memory_id = ?,
            lifecycle_reason = ?, lifecycle_actor_json = ?, updated_at = ?
        WHERE user_id = ? AND memory_id = ? AND status = 'active'
      `).run(replacementId, reason, asJson(actor), timestamp, auth.user_id, memoryId);
      this.audit({
        auth,
        action: "memory.supersede",
        targetType: "memory",
        targetId: memoryId,
        metadata: { replacement_memory_id: replacementId, reason },
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      schema_version: STRUCTURED_MEMORY_LIFECYCLE_SCHEMA_VERSION,
      status: "superseded",
      previous_memory: this.memoryFromRow(this.db.prepare(
        "SELECT * FROM memories WHERE user_id = ? AND memory_id = ?",
      ).get(auth.user_id, memoryId)),
      replacement_memory: this.memoryFromRow(this.db.prepare(
        "SELECT * FROM memories WHERE user_id = ? AND memory_id = ?",
      ).get(auth.user_id, replacementId)),
      idempotent: false,
      canonical_task_state_overwritten: false,
    };
  }

  retractMemory(auth, memoryId, payload = {}) {
    this.requireScope(auth, "memory:write");
    assertIdentifier(memoryId, "memory_id");
    const reason = payload.reason === undefined
      ? "Explicit user retraction."
      : compactText(payload.reason, 1_000);
    if (payload.reason !== undefined
        && (typeof payload.reason !== "string" || !reason)) {
      throw new ValidationError("reason must be a non-empty string.");
    }
    const row = this.db.prepare(
      "SELECT * FROM memories WHERE user_id = ? AND memory_id = ?",
    ).get(auth.user_id, memoryId);
    if (!row) throw new NotFoundError("Memory not found.");
    if (row.status === "retracted") {
      return {
        schema_version: STRUCTURED_MEMORY_LIFECYCLE_SCHEMA_VERSION,
        status: "existing",
        memory: this.memoryFromRow(row),
        idempotent: true,
      };
    }
    if (row.status !== "active") {
      throw new ConflictError(`Memory is ${row.status} and cannot be retracted.`);
    }
    const timestamp = nowIso();
    const actor = this.publicIdentity(auth);
    this.db.prepare(`
      UPDATE memories
      SET status = 'retracted', lifecycle_reason = ?, retracted_at = ?,
          lifecycle_actor_json = ?, updated_at = ?
      WHERE user_id = ? AND memory_id = ? AND status = 'active'
    `).run(reason, timestamp, asJson(actor), timestamp, auth.user_id, memoryId);
    this.audit({
      auth,
      action: "memory.retract",
      targetType: "memory",
      targetId: memoryId,
      metadata: { reason },
    });
    return {
      schema_version: STRUCTURED_MEMORY_LIFECYCLE_SCHEMA_VERSION,
      status: "retracted",
      memory: this.memoryFromRow(this.db.prepare(
        "SELECT * FROM memories WHERE user_id = ? AND memory_id = ?",
      ).get(auth.user_id, memoryId)),
      idempotent: false,
      physically_deleted: false,
      canonical_task_state_overwritten: false,
    };
  }

  resolverFingerprint(query) {
    return createHash("sha256").update(normalizeResolverText(query), "utf8").digest("hex");
  }

  resolverHistory(userId, query) {
    const fingerprint = this.resolverFingerprint(query);
    const rows = this.db.prepare(`
      SELECT project_id, task_id, COUNT(*) AS confirmations
      FROM resolver_selections
      WHERE user_id = ? AND query_fingerprint = ?
      GROUP BY project_id, task_id
    `).all(userId, fingerprint);
    const historyByProject = new Map();
    const historyByTask = new Map();
    for (const row of rows) {
      historyByProject.set(
        row.project_id,
        Number(historyByProject.get(row.project_id) || 0) + Number(row.confirmations),
      );
      historyByTask.set(row.task_id, Number(row.confirmations));
    }
    return { fingerprint, historyByProject, historyByTask };
  }

  taskAssociations(auth, signals) {
    const agentInstanceId = signals.agent_instance_id || auth.agent_instance_id;
    const deviceId = signals.device_id || auth.device_id;
    const agentId = signals.agent_id || auth.agent_id;
    const rows = this.db.prepare(`
      SELECT task_id,
             SUM(CASE WHEN agent_instance_id = ? THEN 1 ELSE 0 END) AS agent_instance_hits,
             SUM(CASE WHEN device_id = ? THEN 1 ELSE 0 END) AS device_hits,
             SUM(CASE WHEN agent_id = ? THEN 1 ELSE 0 END) AS agent_hits,
             MAX(captured_at) AS recent_activity_at
      FROM events
      WHERE user_id = ? AND task_id IS NOT NULL
      GROUP BY task_id
    `).all(agentInstanceId, deviceId, agentId, auth.user_id);
    return new Map(rows.map((row) => [row.task_id, {
      agent_instance_hits: Number(row.agent_instance_hits || 0),
      device_hits: Number(row.device_hits || 0),
      agent_hits: Number(row.agent_hits || 0),
      recent_activity_at: row.recent_activity_at,
    }]));
  }

  resolveProject(auth, payload) {
    this.requireScope(auth, "resume:read");
    const request = resolverRequest(payload);
    const history = this.resolverHistory(auth.user_id, request.query);
    return resolveProjectCandidates({
      projects: this.listProjects(auth.user_id),
      query: request.query,
      signals: request.signals,
      historyByProject: history.historyByProject,
    });
  }

  previewProjectContext(auth, payload) {
    this.requireScope(auth, "resume:read");
    this.pruneExpired();
    const request = resolverRequest(payload, { requireQuery: true });
    const resolution = this.resolveProject(auth, request);
    if (resolution.status !== "resolved") return resolution;
    const project = this.listProjects(auth.user_id)
      .find((candidate) => candidate.project_id === resolution.match.project_id);
    if (!project) throw new NotFoundError("Resolved Project no longer exists.");

    const allTasks = this.listTasks(auth.user_id)
      .filter((task) => task.project_id === project.project_id);
    const tasks = allTasks.slice(0, PROJECT_CONTEXT_TASK_LIMIT);
    let sourceCheckpointCount = 0;
    const taskContexts = tasks.map((task) => {
      const reconciliation = this.reconciliationState(auth, task.task_id, {
        includeProposals: false,
        internal: true,
      });
      const checkpoints = this.latestCheckpoints(auth.user_id, task.task_id);
      sourceCheckpointCount += checkpoints.length;
      return {
        task_id: task.task_id,
        title: task.title,
        aliases: boundedStrings(task.aliases, { limit: 5, textLimit: 120 }),
        goal: compactText(task.goal, 600),
        status: task.status,
        canonical_version: task.canonical_version,
        canonical_freshness: reconciliation.canonical_freshness,
        reconciliation_summary: reconciliation.summary,
        progress: boundedStrings(task.progress),
        decisions: boundedStrings(task.decisions),
        blockers: boundedStrings(task.blockers),
        next_steps: boundedStrings(task.next_steps),
        resources: boundedStrings(task.resources),
        workstreams: task.workstreams.slice(0, 10).map(compactWorkstream),
        conflicts: boundedStrings(task.conflicts, { limit: 5, textLimit: 400 }),
        latest_checkpoints: checkpoints.slice(0, 5).map(compactCheckpointPreview),
        updated_at: task.updated_at,
      };
    });
    const memories = this.db.prepare(`
      SELECT *
      FROM memories
      WHERE user_id = ? AND project_id = ? AND status = 'active'
      ORDER BY created_at DESC LIMIT ?
    `).all(auth.user_id, project.project_id, PROJECT_CONTEXT_MEMORY_LIMIT)
      .map((memory) => this.memoryFromRow(memory));
    const events = this.db.prepare(`
      SELECT event_id, task_id, workstream_id, session_id, event_type,
             captured_at, expired_at, content, device_id, agent_id, agent_instance_id
      FROM events
      WHERE user_id = ? AND project_id = ?
      ORDER BY captured_at DESC LIMIT ?
    `).all(auth.user_id, project.project_id, PROJECT_CONTEXT_ACTIVITY_LIMIT);
    const checkpoints = taskContexts
      .flatMap((task) => task.latest_checkpoints)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, 100);
    const identities = [...new Set([
      ...events.map((event) => `${event.agent_instance_id}@${event.device_id}`),
      ...memories.map((memory) =>
        `${memory.provenance?.agent_instance_id}@${memory.provenance?.device_id}`),
      ...checkpoints.map((checkpoint) =>
        `${checkpoint.provenance?.agent_instance_id}@${checkpoint.provenance?.device_id}`),
    ].filter((value) => value && !value.startsWith("undefined@")))];

    const preview = {
      schema_version: PROJECT_CONTEXT_SCHEMA_VERSION,
      status: "project_context_preview",
      read_only: true,
      created_at: nowIso(),
      query: request.query,
      resolver_request: request,
      resolution,
      project: {
        project_id: project.project_id,
        name: compactText(project.name, 200),
        aliases: boundedStrings(project.aliases, { limit: 10, textLimit: 120 }),
        updated_at: project.updated_at,
      },
      tasks: taskContexts,
      structured_memories: memories.map((memory) => ({
        ...memory,
        content: compactText(memory.content, 600),
        content_truncated: textContent(memory.content).length > 600,
      })),
      recent_activity: events.map((event) => {
        const content = event.expired_at ? null : fromJson(event.content, null);
        const text = content === null ? null : textContent(content);
        return {
          event_id: event.event_id,
          task_id: event.task_id,
          workstream_id: event.workstream_id,
          session_id: event.session_id,
          event_type: event.event_type,
          captured_at: event.captured_at,
          content: text === null ? null : compactText(text, 400),
          content_truncated: typeof text === "string" && text.length > 400,
          source_status: event.expired_at ? "raw_expired" : "available",
          provenance: {
            device_id: event.device_id,
            agent_id: event.agent_id,
            agent_instance_id: event.agent_instance_id,
          },
        };
      }),
      source_summary: {
        task_count: allTasks.length,
        included_task_count: tasks.length,
        active_task_count: allTasks.filter((task) => task.status === "active").length,
        structured_memory_count: memories.length,
        latest_checkpoint_count: sourceCheckpointCount,
        included_latest_checkpoint_count: checkpoints.length,
        recent_activity_count: events.length,
        identities,
      },
      safety: {
        resume_created: false,
        task_scope_changed: false,
        context_injected: false,
        task_selection_required_before_resume: tasks.length !== 1,
      },
      next_action: tasks.length
        ? {
            type: "select_task_for_resume_preview",
            task_ids: tasks.map((task) => task.task_id),
          }
        : { type: "no_task_in_project", task_ids: [] },
    };
    return finalizeReadPreview(preview, {
      task_limit: PROJECT_CONTEXT_TASK_LIMIT,
      memory_limit: PROJECT_CONTEXT_MEMORY_LIMIT,
      activity_limit: PROJECT_CONTEXT_ACTIVITY_LIMIT,
      tasks_truncated: allTasks.length > tasks.length,
      checkpoints_truncated: sourceCheckpointCount > checkpoints.length,
      raw_payload_included: false,
    });
  }

  previewTaskBranches(auth, payload) {
    this.requireScope(auth, "resume:read");
    this.pruneExpired();
    const request = resolverRequest(payload, { requireQuery: true });
    const resolution = this.resolveTask(auth, request);
    if (resolution.status !== "resolved") return resolution;
    const task = this.listTasks(auth.user_id)
      .find((candidate) => candidate.task_id === resolution.match.task_id);
    if (!task) throw new NotFoundError("Resolved Task no longer exists.");

    const checkpoints = this.latestCheckpoints(auth.user_id, task.task_id);
    const checkpointsByWorkstream = new Map(
      checkpoints.map((checkpoint) => [checkpoint.workstream_id, checkpoint]),
    );
    const activityRows = this.db.prepare(`
      SELECT workstream_id, session_id, captured_at, device_id, agent_id, agent_instance_id
      FROM events
      WHERE user_id = ? AND task_id = ? AND workstream_id IS NOT NULL
      ORDER BY captured_at DESC LIMIT 500
    `).all(auth.user_id, task.task_id);
    const activityByWorkstream = new Map();
    for (const row of activityRows) {
      const current = activityByWorkstream.get(row.workstream_id) || {
        latest_activity_at: row.captured_at,
        event_count: 0,
        sessions: [],
        source_identities: [],
      };
      current.event_count += 1;
      if (row.session_id && !current.sessions.includes(row.session_id) && current.sessions.length < 5) {
        current.sessions.push(row.session_id);
      }
      const identity = {
        device_id: row.device_id,
        agent_id: row.agent_id,
        agent_instance_id: row.agent_instance_id,
      };
      const identityKey = `${row.agent_instance_id}@${row.device_id}`;
      if (!current.source_identities.some((candidate) =>
        `${candidate.agent_instance_id}@${candidate.device_id}` === identityKey)
          && current.source_identities.length < 10) {
        current.source_identities.push(identity);
      }
      activityByWorkstream.set(row.workstream_id, current);
    }

    const canonicalWorkstreams = new Map(task.workstreams.map((workstream) => {
      const compact = compactWorkstream(workstream);
      return [compact.workstream_id, compact];
    }).filter(([workstreamId]) => Boolean(workstreamId)));
    const workstreamIds = [...new Set([
      ...canonicalWorkstreams.keys(),
      ...checkpointsByWorkstream.keys(),
      ...activityByWorkstream.keys(),
    ])].sort();
    const branches = workstreamIds.slice(0, 20).map((workstreamId) => {
      const canonical = canonicalWorkstreams.get(workstreamId) || null;
      const checkpoint = checkpointsByWorkstream.get(workstreamId) || null;
      const activity = activityByWorkstream.get(workstreamId) || null;
      return {
        workstream_id: workstreamId,
        name: canonical?.name || workstreamId,
        status: canonical?.status || checkpoint?.status || "observed",
        canonical_declared: Boolean(canonical),
        canonical,
        latest_checkpoint: compactCheckpointPreview(checkpoint),
        latest_activity_at: activity?.latest_activity_at || checkpoint?.created_at || null,
        sampled_event_count: activity?.event_count || 0,
        recent_sessions: activity?.sessions || (checkpoint?.session_id ? [checkpoint.session_id] : []),
        source_identities: activity?.source_identities || (checkpoint?.provenance
          ? [checkpoint.provenance]
          : []),
      };
    });
    const conflicts = boundedStrings(task.conflicts, { limit: 20, textLimit: 600 });
    const reconciliation = this.reconciliationState(auth, task.task_id, {
      includeProposals: true,
      internal: true,
    });
    const preview = {
      schema_version: TASK_BRANCHES_SCHEMA_VERSION,
      status: "task_branches_preview",
      read_only: true,
      created_at: nowIso(),
      query: request.query,
      resolver_request: request,
      resolution,
      project: { project_id: task.project_id, name: compactText(task.project_name, 200) },
      task: {
        task_id: task.task_id,
        title: compactText(task.title, 240),
        goal: compactText(task.goal, 600),
        status: task.status,
        canonical_version: task.canonical_version,
        canonical_freshness: reconciliation.canonical_freshness,
        updated_at: task.updated_at,
      },
      branches,
      conflicts,
      conflict_summary: {
        count: task.conflicts.length,
        included_count: conflicts.length,
        source_preserved: true,
        automatic_merge_performed: false,
        reconciliation_pending: reconciliation.summary.pending,
        reconciliation_conflicts: reconciliation.summary.conflicts,
      },
      source_summary: {
        canonical_workstream_count: task.workstreams.length,
        observed_workstream_count: workstreamIds.length,
        included_branch_count: branches.length,
        latest_checkpoint_count: checkpoints.length,
        sampled_event_count: activityRows.length,
      },
      safety: {
        resume_created: false,
        resolver_selection_recorded: false,
        task_scope_changed: false,
        context_injected: false,
        canonical_task_changed: false,
        automatic_merge_performed: false,
      },
      next_action: conflicts.length
        ? {
            type: "review_conflicts_before_resume",
            task_id: task.task_id,
            options: ["inspect_source_branches", "run_reconciliation_preview", "create_resume_preview_later"],
          }
        : {
            type: "create_resume_preview_later",
            task_id: task.task_id,
            options: ["inspect_source_branches", "create_resume_preview_later"],
          },
    };
    return finalizeReadPreview(preview, {
      branch_limit: 20,
      branches_truncated: workstreamIds.length > branches.length,
      conflict_limit: 20,
      conflicts_truncated: task.conflicts.length > conflicts.length,
      activity_sample_limit: 500,
      raw_payload_included: false,
    });
  }

  resolveTask(auth, payload) {
    this.requireScope(auth, "resume:read");
    const request = resolverRequest(payload);
    const projects = this.listProjects(auth.user_id);
    const projectResolution = resolveProjectCandidates({
      projects,
      query: request.query,
      signals: request.signals,
      historyByProject: this.resolverHistory(auth.user_id, request.query).historyByProject,
    });
    if (request.signals.project_id && projectResolution.status !== "resolved") {
      return {
        status: "no_match",
        resolver_version: RESOLVER_VERSION,
        query: request.query,
        selection_required: true,
        reason: "explicit_project_identifier_not_found",
        project_resolution: projectResolution,
        candidates: [],
      };
    }
    const selectedProjectId = projectResolution.status === "resolved"
      ? projectResolution.match.project_id
      : null;
    const history = this.resolverHistory(auth.user_id, request.query);
    const tasks = this.listTasks(auth.user_id);
    const taskResolution = resolveTaskCandidates({
      tasks,
      projectsById: new Map(projects.map((project) => [project.project_id, project])),
      query: request.query,
      signals: request.signals,
      selectedProjectId,
      historyByTask: history.historyByTask,
      associationsByTask: this.taskAssociations(auth, request.signals),
    });
    const tasksById = new Map(tasks.map((task) => [task.task_id, task]));
    const publicCandidate = (candidate) => ({
      ...candidate,
      conflicts: tasksById.get(candidate.task_id)?.conflicts || [],
    });
    const candidates = taskResolution.candidates.map(publicCandidate);
    const match = taskResolution.match ? publicCandidate(taskResolution.match) : undefined;
    const selectedProject = match
      ? projects.find((project) => project.project_id === match.project_id) || null
      : selectedProjectId
        ? projects.find((project) => project.project_id === selectedProjectId) || null
        : null;
    return {
      ...taskResolution,
      candidates,
      ...(match ? { match } : {}),
      project_resolution: projectResolution,
      selected_project: selectedProject,
      resolver_request: request,
    };
  }

  recordResolverSelection(auth, preview) {
    const query = preview.query || "";
    const request = preview.resolver_request || { query, signals: {} };
    const candidates = preview.resolution?.candidates || [{
      task_id: preview.task.task_id,
      title: preview.task.title,
      project_id: preview.project.project_id,
      project_name: preview.project.name,
      score: preview.match?.score ?? null,
    }];
    this.db.prepare(`
      INSERT OR IGNORE INTO resolver_selections (
        selection_id, user_id, credential_id, resume_id, preview_version,
        query, query_fingerprint, project_id, task_id, signals_json,
        candidate_snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      auth.user_id,
      auth.credential_id,
      preview.resume_id,
      preview.preview_version,
      query,
      this.resolverFingerprint(query),
      preview.project.project_id,
      preview.task.task_id,
      asJson(request.signals || {}),
      asJson(candidates),
      nowIso(),
    );
  }

  createPreview(auth, payload) {
    this.requireScope(auth, "resume:read");
    this.pruneExpired();
    const requestedWorkstreamIds = requestedSourceWorkstreamIds(payload);
    const request = resolverRequest(payload, { requireQuery: true });
    const resolution = this.resolveTask(auth, request);
    if (resolution.status !== "resolved") return resolution;
    const task = this.listTasks(auth.user_id)
      .find((candidate) => candidate.task_id === resolution.match.task_id);
    if (!task) throw new NotFoundError("Resolved Task no longer exists.");
    const checkpoints = this.latestCheckpoints(auth.user_id, task.task_id);
    const observedWorkstreamRows = this.db.prepare(`
      SELECT DISTINCT workstream_id
      FROM events
      WHERE user_id = ? AND task_id = ? AND workstream_id IS NOT NULL
      UNION
      SELECT DISTINCT workstream_id
      FROM memories
      WHERE user_id = ? AND task_id = ? AND workstream_id IS NOT NULL
    `).all(auth.user_id, task.task_id, auth.user_id, task.task_id);
    const availableWorkstreamIds = [...new Set([
      ...task.workstreams.map((workstream) => workstream.workstream_id).filter(Boolean),
      ...checkpoints.map((checkpoint) => checkpoint.workstream_id).filter(Boolean),
      ...observedWorkstreamRows.map((row) => row.workstream_id).filter(Boolean),
    ])].sort();
    if (requestedWorkstreamIds) {
      const unavailable = requestedWorkstreamIds
        .filter((workstreamId) => !availableWorkstreamIds.includes(workstreamId));
      if (unavailable.length) {
        throw new ValidationError(`Unknown source Workstream: ${unavailable.join(", ")}.`);
      }
    }
    const selectedWorkstreamIds = requestedWorkstreamIds || availableWorkstreamIds;
    const selectedWorkstreamSet = new Set(selectedWorkstreamIds);
    const selectedWorkstreams = selectedWorkstreamIds.map((workstreamId) => {
      const canonical = task.workstreams.find((workstream) =>
        workstream.workstream_id === workstreamId);
      return canonical || {
        workstream_id: workstreamId,
        name: workstreamId,
        status: "observed",
      };
    });
    const workstreamPlaceholders = requestedWorkstreamIds
      ? requestedWorkstreamIds.map(() => "?").join(", ")
      : null;
    const eventSql = requestedWorkstreamIds
      ? `
        SELECT event_id, event_type, captured_at, expired_at, content,
               device_id, agent_id, agent_instance_id, workstream_id
        FROM events
        WHERE user_id = ? AND task_id = ? AND workstream_id IN (${workstreamPlaceholders})
        ORDER BY captured_at DESC LIMIT 20
      `
      : `
      SELECT event_id, event_type, captured_at, expired_at, content,
             device_id, agent_id, agent_instance_id, workstream_id
      FROM events
      WHERE user_id = ? AND task_id = ?
      ORDER BY captured_at DESC LIMIT 20
    `;
    const events = this.db.prepare(eventSql)
      .all(auth.user_id, task.task_id, ...(requestedWorkstreamIds || []))
      .reverse();
    const memorySql = requestedWorkstreamIds
      ? `
        SELECT *
        FROM memories
        WHERE user_id = ?
          AND (task_id = ? OR (scope = 'project' AND project_id = ?))
          AND status = 'active'
          AND (workstream_id IS NULL OR workstream_id IN (${workstreamPlaceholders}))
        ORDER BY created_at DESC LIMIT 20
      `
      : `
      SELECT *
      FROM memories
      WHERE user_id = ? AND status = 'active'
        AND (task_id = ? OR (scope = 'project' AND project_id = ?))
      ORDER BY created_at DESC LIMIT 20
    `;
    const memories = this.db.prepare(memorySql)
      .all(auth.user_id, task.task_id, task.project_id, ...(requestedWorkstreamIds || []))
      .reverse()
      .map((memory) => this.memoryFromRow(memory));
    const selectedCheckpoints = checkpoints.filter((checkpoint) =>
      selectedWorkstreamSet.has(checkpoint.workstream_id));
    const canonicalReconciliation = this.reconciliationState(auth, task.task_id, {
      includeProposals: true,
      internal: true,
    });
    const createdAt = nowIso();
    const preview = {
      resume_id: randomUUID(),
      preview_version: 1,
      status: "pending_confirmation",
      requires_confirmation: true,
      created_at: createdAt,
      expires_at: new Date(Date.parse(createdAt) + RESUME_PREVIEW_TTL_MS).toISOString(),
      query: request.query,
      resolver_request: request,
      resolution,
      match: {
        score: resolution.match.score,
        reason: "versioned combination Resolver",
        resolver_version: RESOLVER_VERSION,
        reasons: resolution.match.reasons,
      },
      project: { project_id: task.project_id, name: task.project_name },
      task: {
        task_id: task.task_id,
        title: task.title,
        goal: task.goal,
        status: task.status,
        canonical_version: task.canonical_version,
      },
      canonical_version: task.canonical_version,
      canonical_freshness: canonicalReconciliation.canonical_freshness,
      canonical_reconciliation: {
        schema_version: canonicalReconciliation.schema_version,
        summary: canonicalReconciliation.summary,
        latest_revision: canonicalReconciliation.latest_revision,
        pending_proposals: canonicalReconciliation.proposals
          .filter((proposal) => proposal.status === "awaiting_confirmation")
          .map((proposal) => ({
            proposal_id: proposal.proposal_id,
            proposal_version: proposal.proposal_version,
            base_canonical_version: proposal.base_canonical_version,
            operation_count: proposal.operations.length,
            conflict_count: proposal.conflicts.length,
            operations: proposal.operations.map((operation) => ({
              operation_id: operation.operation_id,
              op: operation.op,
              field: operation.field,
              before: operation.before,
              after: operation.after,
              source_checkpoint_ids: [...new Set(
                operation.sources.map((source) => source.checkpoint_id).filter(Boolean),
              )],
            })),
          })),
      },
      progress: task.progress,
      decisions: task.decisions,
      blockers: task.blockers,
      next_steps: task.next_steps,
      resources: task.resources,
      workstreams: selectedWorkstreams,
      branch_selection: {
        schema_version: "resume-branch-selection-v0.1",
        explicit: Boolean(requestedWorkstreamIds),
        mode: requestedWorkstreamIds
          ? requestedWorkstreamIds.length === 1 ? "single" : "combined_view"
          : "all",
        selected_workstream_ids: selectedWorkstreamIds,
        available_workstream_ids: availableWorkstreamIds,
        source_preserved: true,
        automatic_merge_performed: false,
      },
      conflicts: task.conflicts,
      conflict_summary: {
        count: task.conflicts.length,
        source_preserved: true,
        automatic_merge_performed: false,
      },
      latest_checkpoints: selectedCheckpoints,
      structured_memories: memories.map((memory) => ({
        ...memory,
      })),
      recent_activity: events.map((event) => ({
        event_id: event.event_id,
        event_type: event.event_type,
        captured_at: event.captured_at,
        content: event.expired_at ? null : fromJson(event.content, null),
        source_status: event.expired_at ? "raw_expired" : "available",
        workstream_id: event.workstream_id,
        provenance: {
          device_id: event.device_id,
          agent_id: event.agent_id,
          agent_instance_id: event.agent_instance_id,
        },
      })),
      source_summary: {
        captured_event_count: events.length,
        structured_memory_count: memories.length,
        checkpoint_count: selectedCheckpoints.length,
        identities: [...new Set([
          ...events.map((event) => `${event.agent_instance_id}@${event.device_id}`),
          ...selectedCheckpoints.flatMap((checkpoint) => checkpoint.source_identities || [])
            .map((identity) => `${identity.agent_instance_id}@${identity.device_id}`),
        ])],
      },
    };
    this.db.prepare(`
      INSERT INTO resumes (
        resume_id, user_id, requested_by_credential_id, task_id, preview_version,
        status, preview_json, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      preview.resume_id,
      auth.user_id,
      auth.credential_id,
      task.task_id,
      preview.preview_version,
      preview.status,
      asJson(preview),
      preview.created_at,
      preview.expires_at,
    );
    this.audit({ auth, action: "resume.preview", targetType: "resume", targetId: preview.resume_id, metadata: { task_id: task.task_id } });
    return preview;
  }

  confirmPreview(auth, resumeId, previewVersion, confirmed) {
    this.requireScope(auth, "resume:confirm");
    assertIdentifier(resumeId, "resume_id");
    if (!Number.isInteger(previewVersion) || typeof confirmed !== "boolean") {
      throw new ValidationError("preview_version and confirmed are required.");
    }
    const row = this.db.prepare("SELECT * FROM resumes WHERE resume_id = ? AND user_id = ?")
      .get(resumeId, auth.user_id);
    if (!row) throw new NotFoundError("Resume Preview not found.");
    if (row.preview_version !== previewVersion) {
      throw new ConflictError("Resume Preview version changed; create and show a fresh preview.");
    }
    if (row.status === "confirmed" && confirmed) {
      const confirmedPreview = fromJson(row.preview_json);
      if (confirmedPreview?.project?.project_id && confirmedPreview?.task?.task_id) {
        this.recordResolverSelection(auth, confirmedPreview);
      }
      return { status: "confirmed", resume_packet: fromJson(row.packet_json) };
    }
    if (row.status !== "pending_confirmation") {
      throw new ConflictError(`Resume Preview is already ${row.status}.`);
    }
    if (Date.parse(row.expires_at) <= Date.now()) {
      throw new ConflictError("Resume Preview expired; create and show a fresh preview.");
    }
    if (!confirmed) {
      const cancelledAt = nowIso();
      this.db.prepare("UPDATE resumes SET status = 'cancelled', cancelled_at = ? WHERE resume_id = ?")
        .run(cancelledAt, resumeId);
      this.audit({ auth, action: "resume.cancel", targetType: "resume", targetId: resumeId });
      return { status: "cancelled", resume_id: resumeId };
    }
    const preview = fromJson(row.preview_json);
    const packet = {
      resume_id: preview.resume_id,
      preview_version: preview.preview_version,
      project: preview.project,
      task: preview.task,
      selected_workstreams: preview.workstreams,
      branch_selection: preview.branch_selection,
      context: {
        goal: preview.task.goal,
        progress: preview.progress,
        decisions: preview.decisions,
        blockers: preview.blockers,
        next_steps: preview.next_steps,
        resources: preview.resources,
        conflicts: preview.conflicts,
        latest_checkpoints: preview.latest_checkpoints,
        structured_memories: preview.structured_memories,
        recent_activity: preview.recent_activity,
      },
      provenance: preview.source_summary,
      injection_authorized_at: nowIso(),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE resumes SET status = 'confirmed', packet_json = ?, confirmed_at = ?
        WHERE resume_id = ?
      `).run(asJson(packet), packet.injection_authorized_at, resumeId);
      this.recordResolverSelection(auth, preview);
      this.audit({ auth, action: "resume.confirm", targetType: "resume", targetId: resumeId, metadata: { preview_version: previewVersion } });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { status: "confirmed", resume_packet: packet };
  }

  injectionStatus(auth, resumeId) {
    this.requireScope(auth, "resume:read");
    assertIdentifier(resumeId, "resume_id");
    const resume = this.db.prepare(`
      SELECT resume_id, preview_version, status, task_id, confirmed_at
      FROM resumes WHERE resume_id = ? AND user_id = ?
    `).get(resumeId, auth.user_id);
    if (!resume) throw new NotFoundError("Resume not found.");
    const rows = this.db.prepare(`
      SELECT event_id, attempt_id, phase, device_id, agent_id, agent_instance_id,
             session_id, turn_id, workstream_id, injection_method, occurred_at,
             received_at, error_code, error_message
      FROM resume_injection_events
      WHERE user_id = ? AND resume_id = ?
      ORDER BY occurred_at ASC, received_at ASC
    `).all(auth.user_id, resumeId);
    const attempts = new Map();
    for (const row of rows) {
      const attempt = attempts.get(row.attempt_id) || {
        attempt_id: row.attempt_id,
        status: "unreported",
        ack_complete: false,
        injected_at: null,
        acknowledged_at: null,
        failed_at: null,
        provenance: {
          device_id: row.device_id,
          agent_id: row.agent_id,
          agent_instance_id: row.agent_instance_id,
        },
        session_id: row.session_id,
        turn_id: row.turn_id,
        workstream_id: row.workstream_id,
        injection_method: row.injection_method,
        error: null,
        event_ids: [],
      };
      attempt.event_ids.push(row.event_id);
      if (row.phase === "injected") attempt.injected_at = row.occurred_at;
      if (row.phase === "acknowledged") attempt.acknowledged_at = row.occurred_at;
      if (row.phase === "failed") {
        attempt.failed_at = row.occurred_at;
        attempt.error = row.error_code || row.error_message
          ? { code: row.error_code, message: row.error_message }
          : null;
      }
      attempt.ack_complete = Boolean(attempt.injected_at && attempt.acknowledged_at);
      attempt.status = attempt.ack_complete
        ? "acknowledged"
        : attempt.failed_at
          ? "failed"
          : attempt.injected_at
            ? "in_flight"
            : attempt.acknowledged_at
              ? "acknowledged_unpaired"
              : "unreported";
      attempts.set(row.attempt_id, attempt);
    }
    const orderedAttempts = [...attempts.values()].sort((left, right) => {
      const leftAt = left.acknowledged_at || left.failed_at || left.injected_at || "";
      const rightAt = right.acknowledged_at || right.failed_at || right.injected_at || "";
      return rightAt.localeCompare(leftAt);
    });
    const acknowledged = orderedAttempts.find((attempt) => attempt.ack_complete);
    const latest = acknowledged || orderedAttempts[0] || null;
    return {
      resume_id: resume.resume_id,
      preview_version: resume.preview_version,
      resume_status: resume.status,
      task_id: resume.task_id,
      confirmed_at: resume.confirmed_at,
      status: latest?.status || "unreported",
      ack_complete: Boolean(acknowledged),
      latest_attempt: latest,
      attempts: orderedAttempts.slice(0, 20),
    };
  }

  recordInjectionEvent(auth, resumeId, payload) {
    this.requireScope(auth, "resume:confirm");
    assertIdentifier(resumeId, "resume_id");
    if (!payload || typeof payload !== "object") {
      throw new ValidationError("Injection event payload is required.");
    }
    const previewVersion = payload.preview_version;
    if (!Number.isInteger(previewVersion) || previewVersion < 1) {
      throw new ValidationError("preview_version is invalid.");
    }
    for (const [value, label] of [
      [payload.event_id, "event_id"],
      [payload.attempt_id, "attempt_id"],
      [payload.session_id, "session_id"],
      [payload.turn_id, "turn_id"],
      [payload.workstream_id, "workstream_id"],
      [payload.injection_method, "injection_method"],
    ]) assertIdentifier(value, label);
    if (!RESUME_INJECTION_PHASES.has(payload.phase)) {
      throw new ValidationError("phase must be injected, acknowledged, or failed.");
    }
    assertIsoTimestamp(payload.occurred_at, "occurred_at");
    if (payload.error_code !== undefined && payload.error_code !== null) {
      assertIdentifier(payload.error_code, "error_code");
    }
    if (payload.error_message !== undefined && payload.error_message !== null
        && (typeof payload.error_message !== "string" || payload.error_message.length > 500)) {
      throw new ValidationError("error_message must be a string of at most 500 characters.");
    }
    const resume = this.db.prepare(`
      SELECT resume_id, preview_version, status
      FROM resumes WHERE resume_id = ? AND user_id = ?
    `).get(resumeId, auth.user_id);
    if (!resume) throw new NotFoundError("Resume not found.");
    if (resume.preview_version !== previewVersion) {
      throw new ConflictError("Resume Preview version changed.");
    }
    if (resume.status !== "confirmed") {
      throw new ConflictError("Resume must be confirmed before injection can be acknowledged.");
    }

    const existingAttempt = this.db.prepare(`
      SELECT preview_version, credential_id, device_id, agent_id, agent_instance_id,
             session_id, turn_id, workstream_id, injection_method
      FROM resume_injection_events
      WHERE user_id = ? AND resume_id = ? AND attempt_id = ?
      ORDER BY received_at ASC LIMIT 1
    `).get(auth.user_id, resumeId, payload.attempt_id);
    if (existingAttempt && (
      existingAttempt.preview_version !== previewVersion
      || existingAttempt.credential_id !== auth.credential_id
      || existingAttempt.device_id !== auth.device_id
      || existingAttempt.agent_id !== auth.agent_id
      || existingAttempt.agent_instance_id !== auth.agent_instance_id
      || existingAttempt.session_id !== payload.session_id
      || existingAttempt.turn_id !== payload.turn_id
      || existingAttempt.workstream_id !== payload.workstream_id
      || existingAttempt.injection_method !== payload.injection_method
    )) {
      throw new ConflictError("Injection attempt provenance or scope changed.");
    }
    const duplicate = this.db.prepare(`
      SELECT event_id FROM resume_injection_events
      WHERE user_id = ? AND resume_id = ? AND attempt_id = ? AND phase = ?
    `).get(auth.user_id, resumeId, payload.attempt_id, payload.phase);
    if (duplicate) {
      return {
        inserted: 0,
        duplicate: 1,
        event_id: duplicate.event_id,
        delivery: this.injectionStatus(auth, resumeId),
      };
    }
    if (payload.phase === "injected") {
      const completed = this.db.prepare(`
        SELECT acknowledged.attempt_id
        FROM resume_injection_events AS acknowledged
        WHERE acknowledged.user_id = ? AND acknowledged.resume_id = ?
          AND acknowledged.phase = 'acknowledged'
          AND EXISTS (
            SELECT 1 FROM resume_injection_events AS injected
            WHERE injected.user_id = acknowledged.user_id
              AND injected.resume_id = acknowledged.resume_id
              AND injected.attempt_id = acknowledged.attempt_id
              AND injected.phase = 'injected'
          )
        LIMIT 1
      `).get(auth.user_id, resumeId);
      if (completed && completed.attempt_id !== payload.attempt_id) {
        throw new ConflictError("Resume injection was already acknowledged by another attempt.");
      }
      const active = this.db.prepare(`
        SELECT injected.attempt_id
        FROM resume_injection_events AS injected
        WHERE injected.user_id = ? AND injected.resume_id = ?
          AND injected.phase = 'injected' AND injected.attempt_id <> ?
          AND NOT EXISTS (
            SELECT 1 FROM resume_injection_events AS terminal
            WHERE terminal.user_id = injected.user_id
              AND terminal.resume_id = injected.resume_id
              AND terminal.attempt_id = injected.attempt_id
              AND terminal.phase IN ('acknowledged', 'failed')
          )
        LIMIT 1
      `).get(auth.user_id, resumeId, payload.attempt_id);
      if (active) throw new ConflictError("Resume injection is already in flight in another attempt.");
    }

    const receivedAt = nowIso();
    this.db.prepare(`
      INSERT INTO resume_injection_events (
        event_id, user_id, resume_id, preview_version, attempt_id, phase,
        credential_id, device_id, agent_id, agent_instance_id, session_id,
        turn_id, workstream_id, injection_method, occurred_at, received_at,
        error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.event_id,
      auth.user_id,
      resumeId,
      previewVersion,
      payload.attempt_id,
      payload.phase,
      auth.credential_id,
      auth.device_id,
      auth.agent_id,
      auth.agent_instance_id,
      payload.session_id,
      payload.turn_id,
      payload.workstream_id,
      payload.injection_method,
      payload.occurred_at,
      receivedAt,
      payload.error_code ?? null,
      payload.error_message ?? null,
    );
    this.audit({
      auth,
      action: `resume.injection.${payload.phase}`,
      targetType: "resume",
      targetId: resumeId,
      metadata: {
        preview_version: previewVersion,
        attempt_id: payload.attempt_id,
        session_id: payload.session_id,
        turn_id: payload.turn_id,
        workstream_id: payload.workstream_id,
        injection_method: payload.injection_method,
      },
    });
    return {
      inserted: 1,
      duplicate: 0,
      event_id: payload.event_id,
      delivery: this.injectionStatus(auth, resumeId),
    };
  }

  deliveryReceiptStatus(auth, resumeId) {
    this.requireScope(auth, "resume:read");
    assertIdentifier(resumeId, "resume_id");
    const resume = this.db.prepare(`
      SELECT resume_id, preview_version, status, task_id, confirmed_at
      FROM resumes WHERE resume_id = ? AND user_id = ?
    `).get(resumeId, auth.user_id);
    if (!resume) throw new NotFoundError("Resume not found.");
    const rows = this.db.prepare(`
      SELECT receipt_event_id, receipt_id, phase, device_id, agent_id,
             agent_instance_id, session_id, turn_id, workstream_id,
             delivery_method, occurred_at, received_at, error_code, error_message
      FROM resume_delivery_receipts
      WHERE user_id = ? AND resume_id = ?
      ORDER BY occurred_at ASC, received_at ASC
    `).all(auth.user_id, resumeId);
    const attempts = new Map();
    for (const row of rows) {
      const attempt = attempts.get(row.receipt_id) || {
        receipt_id: row.receipt_id,
        status: "unreported",
        ack_complete: false,
        delivered_at: null,
        acknowledged_at: null,
        failed_at: null,
        latest_received_at: null,
        provenance: {
          device_id: row.device_id,
          agent_id: row.agent_id,
          agent_instance_id: row.agent_instance_id,
        },
        session_id: row.session_id,
        turn_id: null,
        workstream_id: row.workstream_id,
        delivery_method: row.delivery_method,
        error: null,
        receipt_event_ids: [],
      };
      attempt.receipt_event_ids.push(row.receipt_event_id);
      if (!attempt.latest_received_at || row.received_at > attempt.latest_received_at) {
        attempt.latest_received_at = row.received_at;
      }
      if (row.phase === "delivered") attempt.delivered_at = row.occurred_at;
      if (row.phase === "acknowledged") {
        attempt.acknowledged_at = row.occurred_at;
        attempt.turn_id = row.turn_id;
      }
      if (row.phase === "failed") {
        attempt.failed_at = row.occurred_at;
        attempt.turn_id = row.turn_id || attempt.turn_id;
        attempt.error = row.error_code || row.error_message
          ? { code: row.error_code, message: row.error_message }
          : null;
      }
      attempt.ack_complete = Boolean(attempt.delivered_at && attempt.acknowledged_at);
      attempt.status = attempt.ack_complete
        ? "acknowledged"
        : attempt.failed_at
          ? "failed"
          : attempt.delivered_at
            ? "in_flight"
            : attempt.acknowledged_at
              ? "acknowledged_unpaired"
              : "unreported";
      attempts.set(row.receipt_id, attempt);
    }
    const orderedAttempts = [...attempts.values()].sort((left, right) => {
      const leftAt = left.acknowledged_at || left.failed_at || left.delivered_at || "";
      const rightAt = right.acknowledged_at || right.failed_at || right.delivered_at || "";
      return rightAt.localeCompare(leftAt)
        || String(right.latest_received_at || "").localeCompare(
          String(left.latest_received_at || ""),
        )
        || String(right.receipt_id).localeCompare(String(left.receipt_id));
    });
    const acknowledged = orderedAttempts.find((attempt) => attempt.ack_complete);
    const latest = acknowledged || orderedAttempts[0] || null;
    return {
      protocol: "chatgpt-mcp-delivery-receipt-v0.1.4",
      resume_id: resume.resume_id,
      preview_version: resume.preview_version,
      resume_status: resume.status,
      task_id: resume.task_id,
      confirmed_at: resume.confirmed_at,
      status: latest?.status || "unreported",
      ack_complete: Boolean(acknowledged),
      latest_receipt: latest,
      receipts: orderedAttempts.slice(0, 20),
    };
  }

  recordDeliveryReceipt(auth, resumeId, payload) {
    this.requireScope(auth, "resume:confirm");
    assertIdentifier(resumeId, "resume_id");
    if (!payload || typeof payload !== "object") {
      throw new ValidationError("Delivery receipt payload is required.");
    }
    const previewVersion = payload.preview_version;
    if (!Number.isInteger(previewVersion) || previewVersion < 1) {
      throw new ValidationError("preview_version is invalid.");
    }
    for (const [value, label] of [
      [payload.receipt_event_id, "receipt_event_id"],
      [payload.receipt_id, "receipt_id"],
      [payload.session_id, "session_id"],
      [payload.workstream_id, "workstream_id"],
      [payload.delivery_method, "delivery_method"],
    ]) assertIdentifier(value, label);
    if (!RESUME_DELIVERY_RECEIPT_PHASES.has(payload.phase)) {
      throw new ValidationError("phase must be delivered, acknowledged, or failed.");
    }
    if (payload.turn_id !== undefined && payload.turn_id !== null) {
      assertIdentifier(payload.turn_id, "turn_id");
    }
    if (payload.phase === "delivered" && payload.turn_id !== null && payload.turn_id !== undefined) {
      throw new ValidationError("delivered receipts must not claim a host turn_id.");
    }
    if (payload.phase === "acknowledged" && !payload.turn_id) {
      throw new ValidationError("acknowledged receipts require the real host turn_id.");
    }
    assertIsoTimestamp(payload.occurred_at, "occurred_at");
    if (payload.error_code !== undefined && payload.error_code !== null) {
      assertIdentifier(payload.error_code, "error_code");
    }
    if (payload.error_message !== undefined && payload.error_message !== null
        && (typeof payload.error_message !== "string" || payload.error_message.length > 500)) {
      throw new ValidationError("error_message must be a string of at most 500 characters.");
    }
    const resume = this.db.prepare(`
      SELECT resume_id, preview_version, status
      FROM resumes WHERE resume_id = ? AND user_id = ?
    `).get(resumeId, auth.user_id);
    if (!resume) throw new NotFoundError("Resume not found.");
    if (resume.preview_version !== previewVersion) {
      throw new ConflictError("Resume Preview version changed.");
    }
    if (resume.status !== "confirmed") {
      throw new ConflictError("Resume must be confirmed before delivery can be receipted.");
    }

    const existingReceipt = this.db.prepare(`
      SELECT preview_version, credential_id, device_id, agent_id, agent_instance_id,
             session_id, workstream_id, delivery_method
      FROM resume_delivery_receipts
      WHERE user_id = ? AND resume_id = ? AND receipt_id = ?
      ORDER BY received_at ASC LIMIT 1
    `).get(auth.user_id, resumeId, payload.receipt_id);
    if (existingReceipt && (
      existingReceipt.preview_version !== previewVersion
      || existingReceipt.credential_id !== auth.credential_id
      || existingReceipt.device_id !== auth.device_id
      || existingReceipt.agent_id !== auth.agent_id
      || existingReceipt.agent_instance_id !== auth.agent_instance_id
      || existingReceipt.session_id !== payload.session_id
      || existingReceipt.workstream_id !== payload.workstream_id
      || existingReceipt.delivery_method !== payload.delivery_method
    )) {
      throw new ConflictError("Delivery receipt provenance or scope changed.");
    }
    const duplicate = this.db.prepare(`
      SELECT receipt_event_id FROM resume_delivery_receipts
      WHERE user_id = ? AND resume_id = ? AND receipt_id = ? AND phase = ?
    `).get(auth.user_id, resumeId, payload.receipt_id, payload.phase);
    if (duplicate) {
      return {
        inserted: 0,
        duplicate: 1,
        receipt_event_id: duplicate.receipt_event_id,
        delivery: this.deliveryReceiptStatus(auth, resumeId),
      };
    }
    if (payload.phase === "delivered") {
      const completed = this.db.prepare(`
        SELECT acknowledged.receipt_id
        FROM resume_delivery_receipts AS acknowledged
        WHERE acknowledged.user_id = ? AND acknowledged.resume_id = ?
          AND acknowledged.phase = 'acknowledged'
          AND EXISTS (
            SELECT 1 FROM resume_delivery_receipts AS delivered
            WHERE delivered.user_id = acknowledged.user_id
              AND delivered.resume_id = acknowledged.resume_id
              AND delivered.receipt_id = acknowledged.receipt_id
              AND delivered.phase = 'delivered'
          )
        LIMIT 1
      `).get(auth.user_id, resumeId);
      if (completed && completed.receipt_id !== payload.receipt_id) {
        throw new ConflictError("Resume delivery was already acknowledged by another receipt.");
      }
      const active = this.db.prepare(`
        SELECT delivered.receipt_id
        FROM resume_delivery_receipts AS delivered
        WHERE delivered.user_id = ? AND delivered.resume_id = ?
          AND delivered.phase = 'delivered' AND delivered.receipt_id <> ?
          AND NOT EXISTS (
            SELECT 1 FROM resume_delivery_receipts AS terminal
            WHERE terminal.user_id = delivered.user_id
              AND terminal.resume_id = delivered.resume_id
              AND terminal.receipt_id = delivered.receipt_id
              AND terminal.phase IN ('acknowledged', 'failed')
          )
        LIMIT 1
      `).get(auth.user_id, resumeId, payload.receipt_id);
      if (active) throw new ConflictError("Resume delivery is already in flight in another receipt.");
    }
    if (payload.phase === "acknowledged") {
      const delivered = this.db.prepare(`
        SELECT receipt_event_id FROM resume_delivery_receipts
        WHERE user_id = ? AND resume_id = ? AND receipt_id = ? AND phase = 'delivered'
      `).get(auth.user_id, resumeId, payload.receipt_id);
      if (!delivered) throw new ConflictError("Delivery must be recorded before acknowledgement.");
    }

    const latestReceived = this.db.prepare(`
      SELECT received_at
      FROM resume_delivery_receipts
      WHERE user_id = ? AND resume_id = ?
      ORDER BY received_at DESC
      LIMIT 1
    `).get(auth.user_id, resumeId);
    let receivedAt = nowIso();
    if (latestReceived?.received_at && receivedAt <= latestReceived.received_at) {
      receivedAt = new Date(Date.parse(latestReceived.received_at) + 1).toISOString();
    }
    this.db.prepare(`
      INSERT INTO resume_delivery_receipts (
        receipt_event_id, user_id, resume_id, preview_version, receipt_id, phase,
        credential_id, device_id, agent_id, agent_instance_id, session_id,
        turn_id, workstream_id, delivery_method, occurred_at, received_at,
        error_code, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      payload.receipt_event_id,
      auth.user_id,
      resumeId,
      previewVersion,
      payload.receipt_id,
      payload.phase,
      auth.credential_id,
      auth.device_id,
      auth.agent_id,
      auth.agent_instance_id,
      payload.session_id,
      payload.turn_id ?? null,
      payload.workstream_id,
      payload.delivery_method,
      payload.occurred_at,
      receivedAt,
      payload.error_code ?? null,
      payload.error_message ?? null,
    );
    this.audit({
      auth,
      action: `resume.delivery-receipt.${payload.phase}`,
      targetType: "resume",
      targetId: resumeId,
      metadata: {
        preview_version: previewVersion,
        receipt_id: payload.receipt_id,
        session_id: payload.session_id,
        turn_id: payload.turn_id ?? null,
        workstream_id: payload.workstream_id,
        delivery_method: payload.delivery_method,
      },
    });
    return {
      inserted: 1,
      duplicate: 0,
      receipt_event_id: payload.receipt_event_id,
      delivery: this.deliveryReceiptStatus(auth, resumeId),
    };
  }

  deliveryReceiptSummary(auth) {
    this.requireScope(auth, "memory:read");
    const confirmed = this.db.prepare(`
      SELECT resume_id FROM resumes
      WHERE user_id = ? AND status = 'confirmed'
    `).all(auth.user_id);
    const summary = {
      protocol: "chatgpt-mcp-delivery-receipt-v0.1.4",
      confirmed: confirmed.length,
      unreported: 0,
      in_flight: 0,
      acknowledged: 0,
      failed: 0,
      acknowledged_unpaired: 0,
    };
    for (const { resume_id: resumeId } of confirmed) {
      const status = this.deliveryReceiptStatus(auth, resumeId).status;
      if (Object.hasOwn(summary, status)) summary[status] += 1;
    }
    return summary;
  }

  injectionSummary(auth) {
    this.requireScope(auth, "memory:read");
    const confirmed = this.db.prepare(`
      SELECT resume_id FROM resumes
      WHERE user_id = ? AND status = 'confirmed'
    `).all(auth.user_id);
    const summary = {
      confirmed: confirmed.length,
      unreported: 0,
      in_flight: 0,
      acknowledged: 0,
      failed: 0,
      acknowledged_unpaired: 0,
    };
    for (const { resume_id: resumeId } of confirmed) {
      const status = this.injectionStatus(auth, resumeId).status;
      if (Object.hasOwn(summary, status)) summary[status] += 1;
    }
    return summary;
  }

  status(auth) {
    this.requireScope(auth, "memory:read");
    const statusNow = nowIso();
    const count = (table, clause = "", params = []) => this.db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ? ${clause}`)
      .get(auth.user_id, ...params).count;
    const rawAvailabilityRow = this.db.prepare(`
      SELECT
        COUNT(*) AS total_events,
        COALESCE(SUM(CASE WHEN raw_payload_json IS NOT NULL THEN 1 ELSE 0 END), 0)
          AS raw_events_available,
        COALESCE(SUM(CASE WHEN expired_at IS NOT NULL THEN 1 ELSE 0 END), 0)
          AS expired_events,
        COALESCE(SUM(CASE
          WHEN raw_payload_json IS NULL AND expired_at IS NULL THEN 1 ELSE 0
        END), 0) AS unexplained_raw_unavailable
      FROM events
      WHERE user_id = ?
    `).get(auth.user_id);
    const rawAvailability = {
      schema_version: "mnemuron-raw-availability-status-v0.1",
      total_events: rawAvailabilityRow.total_events,
      raw_events_available: rawAvailabilityRow.raw_events_available,
      expired_events: rawAvailabilityRow.expired_events,
      unexplained_raw_unavailable: rawAvailabilityRow.unexplained_raw_unavailable,
    };
    rawAvailability.status = (
      rawAvailability.unexplained_raw_unavailable === 0
      && rawAvailability.total_events
        === rawAvailability.raw_events_available + rawAvailability.expired_events
    ) ? "accounted" : "degraded";
    const tasks = this.listTasks(auth.user_id);
    const reconciliationRows = this.db.prepare(`
      SELECT status, conflicts_json, policy_json, created_at
      FROM task_reconciliation_proposals
      WHERE user_id = ?
    `).all(auth.user_id);
    const pendingReconciliations = reconciliationRows.filter((row) =>
      row.status === "awaiting_confirmation");
    const reconciliationConflicts = pendingReconciliations.reduce((sum, row) =>
      sum + fromJson(row.conflicts_json, []).length, 0);
    const deferredReconciliationCheckpointIds = [...new Set(
      this.db.prepare(`
        SELECT * FROM task_reconciliation_proposals
        WHERE user_id = ? AND status = 'awaiting_confirmation'
      `).all(auth.user_id).flatMap((row) => this.reconciliationDeferredCheckpointIds(
        auth.user_id,
        this.reconciliationProposalFromRow(row),
      )),
    )];
    const memoryRows = this.db.prepare(`
      SELECT memory_type, status, source, COUNT(*) AS count
      FROM memories
      WHERE user_id = ?
      GROUP BY memory_type, status, source
    `).all(auth.user_id);
    const memorySummary = {
      schema_version: STRUCTURED_MEMORY_LIFECYCLE_SCHEMA_VERSION,
      active: memoryRows
        .filter((row) => row.status === "active")
        .reduce((sum, row) => sum + Number(row.count), 0),
      checkpoint_derived: memoryRows
        .filter((row) => row.source === "checkpoint_derived")
        .reduce((sum, row) => sum + Number(row.count), 0),
      explicit: memoryRows
        .filter((row) => row.source !== "checkpoint_derived")
        .reduce((sum, row) => sum + Number(row.count), 0),
      superseded: memoryRows
        .filter((row) => row.status === "superseded")
        .reduce((sum, row) => sum + Number(row.count), 0),
      retracted: memoryRows
        .filter((row) => row.status === "retracted")
        .reduce((sum, row) => sum + Number(row.count), 0),
      by_type: Object.fromEntries([...STRUCTURED_MEMORY_TYPES].map((memoryType) => [
        memoryType,
        memoryRows
          .filter((row) => row.memory_type === memoryType && row.status === "active")
          .reduce((sum, row) => sum + Number(row.count), 0),
      ])),
      automatic_merge_performed: false,
      canonical_task_state_overwritten: false,
    };
    return {
      mode: "remote-v0.1",
      production_ready: false,
      cross_device_ready: true,
      identity: this.publicIdentity(auth),
      counts: {
        events: rawAvailability.total_events,
        raw_events_available: rawAvailability.raw_events_available,
        expired_events: rawAvailability.expired_events,
        unexplained_raw_unavailable: rawAvailability.unexplained_raw_unavailable,
        memories: count("memories"),
        checkpoints: count("checkpoints"),
        projects: count("projects"),
        tasks: count("tasks"),
        previews: count("resumes"),
        resolver_selections: count("resolver_selections"),
        reconciliation_proposals: count("task_reconciliation_proposals"),
        canonical_revisions: count("task_canonical_revisions"),
        task_bootstrap_previews: count(
          "task_bootstrap_previews",
          "AND bootstrap_kind = ?",
          ["task"],
        ),
        project_bootstrap_previews: count(
          "task_bootstrap_previews",
          "AND bootstrap_kind = ?",
          ["project_and_initial_task"],
        ),
      },
      resolver: {
        schema_version: RESOLVER_VERSION,
        project_path_is_sufficient_alone: false,
        ambiguous_preview_created: false,
        source_conflicts_auto_merged: false,
      },
      raw_availability: rawAvailability,
      structured_memory: memorySummary,
      canonical_reconciliation: {
        schema_version: RECONCILIATION_SCHEMA_VERSION,
        pending: pendingReconciliations.length,
        conflicts: reconciliationConflicts,
        auto_applied: reconciliationRows.filter((row) =>
          row.status === "auto_applied"
          && fromJson(row.policy_json, {}).automatic_application_performed === true).length,
        stale: reconciliationRows.filter((row) => row.status === "stale").length,
        deferred_checkpoints: deferredReconciliationCheckpointIds.length,
        oldest_pending_at: pendingReconciliations.length
          ? pendingReconciliations
            .map((row) => row.created_at)
            .sort()[0]
          : null,
      },
      task_bootstrap: {
        schema_version: TASK_BOOTSTRAP_SCHEMA_VERSION,
        pending_confirmation: count(
          "task_bootstrap_previews",
          "AND bootstrap_kind = ? AND status = ? AND expires_at > ?",
          ["task", "pending_confirmation", statusNow],
        ),
        confirmed: count(
          "task_bootstrap_previews",
          "AND bootstrap_kind = ? AND status = ?",
          ["task", "confirmed"],
        ),
        cancelled: count(
          "task_bootstrap_previews",
          "AND bootstrap_kind = ? AND status = ?",
          ["task", "cancelled"],
        ),
        expired: count(
          "task_bootstrap_previews",
          "AND bootstrap_kind = ? AND (status = ? OR (status = ? AND expires_at <= ?))",
          ["task", "expired", "pending_confirmation", statusNow],
        ),
        historical_events_rebound: false,
        resume_created_by_bootstrap: false,
      },
      project_bootstrap: {
        schema_version: PROJECT_BOOTSTRAP_SCHEMA_VERSION,
        pending_confirmation: count(
          "task_bootstrap_previews",
          "AND bootstrap_kind = ? AND status = ? AND expires_at > ?",
          ["project_and_initial_task", "pending_confirmation", statusNow],
        ),
        confirmed: count(
          "task_bootstrap_previews",
          "AND bootstrap_kind = ? AND status = ?",
          ["project_and_initial_task", "confirmed"],
        ),
        cancelled: count(
          "task_bootstrap_previews",
          "AND bootstrap_kind = ? AND status = ?",
          ["project_and_initial_task", "cancelled"],
        ),
        expired: count(
          "task_bootstrap_previews",
          "AND bootstrap_kind = ? AND (status = ? OR (status = ? AND expires_at <= ?))",
          [
            "project_and_initial_task",
            "expired",
            "pending_confirmation",
            statusNow,
          ],
        ),
        project_and_initial_task_atomic: true,
        historical_events_rebound: false,
        resume_created_by_bootstrap: false,
      },
      resume_injection_acks: this.injectionSummary(auth),
      resume_delivery_receipts: this.deliveryReceiptSummary(auth),
      retention: this.getRetention(),
      tasks: tasks.map(({
        task_id,
        project_name,
        title,
        status,
        canonical_version,
        updated_at,
      }) => ({ task_id, project_name, title, status, canonical_version, updated_at })),
    };
  }

  publicIdentity(auth) {
    return {
      user_id: auth.user_id,
      device_id: auth.device_id,
      agent_id: auth.agent_id,
      agent_instance_id: auth.agent_instance_id,
      identity_status: "server_verified",
    };
  }

  pruneExpired(auth = null) {
    if (auth) this.requireScope(auth, "admin:retention");
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE events
      SET content = NULL, raw_payload_json = NULL, expired_at = ?
      WHERE expires_at IS NOT NULL AND expires_at <= ? AND expired_at IS NULL
    `).run(timestamp, timestamp);
    if (auth || result.changes) {
      this.audit({ auth, action: "retention.prune", targetType: "event", metadata: { expired_events: result.changes } });
    }
    return { status: "completed", expired_events: result.changes, completed_at: timestamp };
  }

  getRetention() {
    const row = this.db.prepare("SELECT value_json, updated_at FROM settings WHERE key = 'raw_retention_days'")
      .get();
    const value = row ? fromJson(row.value_json, this.defaultRetentionDays) : this.defaultRetentionDays;
    return {
      raw_retention_days: value === null ? "permanent" : value,
      updated_at: row?.updated_at ?? null,
      applies_to_existing_events: false,
    };
  }

  setRetention(auth, value) {
    this.requireScope(auth, "admin:retention");
    const parsed = parseRetention(value, this.defaultRetentionDays);
    const updatedAt = nowIso();
    this.db.prepare(`
      INSERT INTO settings (key, value_json, updated_at)
      VALUES ('raw_retention_days', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(asJson(parsed), updatedAt);
    this.audit({
      auth,
      action: "retention.update",
      targetType: "setting",
      targetId: "raw_retention_days",
      metadata: { raw_retention_days: parsed === null ? "permanent" : parsed, applies_to_existing_events: false },
    });
    return this.getRetention();
  }

  listAudit(auth, limit = 100) {
    this.requireScope(auth, "audit:read");
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.db.prepare(`
      SELECT audit_id, user_id, credential_id, action, target_type, target_id,
             outcome, metadata_json, created_at
      FROM audit_events ORDER BY created_at DESC LIMIT ?
    `).all(safeLimit).map((row) => ({
      ...row,
      metadata: fromJson(row.metadata_json, null),
      metadata_json: undefined,
    }));
  }
}

export const SCOPE_DEFAULTS = {
  agent: DEFAULT_AGENT_SCOPES,
  admin: ADMIN_SCOPES,
};

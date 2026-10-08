// Pure helpers shared by MnemuronStore: identifiers, JSON, checkpoint text,
// bootstrap similarity and resolver request validation. No database access.
import { createHash, randomBytes } from "node:crypto";
import { ValidationError } from "../errors.mjs";
import { normalizeResolverText } from "../resolver.mjs";
import { taskFieldAvailability } from "../../../shared/task-read-contract.mjs";

export const DEFAULT_USER_ID = "user-local";
export const DEFAULT_AGENT_SCOPES = [
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
export const ADMIN_SCOPES = [
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

export function asJson(value) {
  return JSON.stringify(value ?? null);
}

export function fromJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  return JSON.parse(value);
}

export function nowIso() {
  return new Date().toISOString();
}

export function rawExpired(event) {
  return Boolean(event.expired_at || (event.expires_at && Date.parse(event.expires_at) <= Date.now()));
}

export function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export const CHECKPOINT_TRIGGER_TYPES = new Set(["assistant_message", "session_end"]);
export const CHECKPOINT_EVENT_LIMIT = 50;
export const CHECKPOINT_TEXT_LIMIT = 1_200;
export const RESUME_PREVIEW_TTL_MS = 30 * 60_000;
export const TASK_BOOTSTRAP_SCHEMA_VERSION = "task-bootstrap-binding-v0.1";
export const TASK_BOOTSTRAP_PREVIEW_TTL_MS = 30 * 60_000;
export const PROJECT_BOOTSTRAP_SCHEMA_VERSION = "project-bootstrap-initial-task-v0.1";
export const PROJECT_CONTEXT_SCHEMA_VERSION = "project-memory-preview-v0.1";
export const TASK_BRANCHES_SCHEMA_VERSION = "task-branches-preview-v0.1";
export const READ_PREVIEW_RESPONSE_BUDGET_BYTES = 128 * 1024;
export const PROJECT_CONTEXT_TASK_LIMIT = 10;
export const PROJECT_CONTEXT_MEMORY_LIMIT = 10;
export const PROJECT_CONTEXT_ACTIVITY_LIMIT = 20;
export const RESUME_INJECTION_PHASES = new Set(["injected", "acknowledged", "failed"]);
export const RESUME_DELIVERY_RECEIPT_PHASES = new Set(["delivered", "acknowledged", "failed"]);
export const STRUCTURED_MEMORY_RETRIEVAL_SCHEMA_VERSION = "structured-memory-retrieval-v0.1";
export const STRUCTURED_MEMORY_LIFECYCLE_SCHEMA_VERSION = "structured-memory-lifecycle-v0.1";
export const STRUCTURED_MEMORY_RETRIEVAL_CANDIDATE_LIMIT = 500;
export const STRUCTURED_MEMORY_RETRIEVAL_RESULT_LIMIT = 20;
export const STRUCTURED_MEMORY_STATUSES = new Set(["active", "superseded", "retracted"]);

export function textContent(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    for (const key of ["text", "content", "message", "summary", "output"]) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }
  }
  return "";
}

export function compactText(value, limit = CHECKPOINT_TEXT_LIMIT) {
  const text = textContent(value).replace(/\s+/gu, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function boundedStrings(values, { limit = 4, textLimit = 240 } = {}) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, limit).map((value) => {
    if (typeof value === "string") return compactText(value, textLimit);
    return JSON.parse(JSON.stringify(value, (_key, nested) =>
      typeof nested === "string" ? compactText(nested, textLimit) : nested));
  });
}

export function compactCheckpointPreview(checkpoint) {
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

export function compactWorkstream(workstream) {
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

export function serializedBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

export function finalizeReadPreview(preview, projection) {
  preview.projection = {
    response_budget_bytes: READ_PREVIEW_RESPONSE_BUDGET_BYTES,
    ...projection,
    fallback_compaction_applied: false,
    serialized_bytes: 0,
  };
  let bytes = serializedBytes(preview);
  if (bytes > READ_PREVIEW_RESPONSE_BUDGET_BYTES) {
    // Not every preview kind carries every section (a branch preview has no recent activity or memories).
    if (Array.isArray(preview.recent_activity)) preview.recent_activity = preview.recent_activity.slice(0, 10).map((activity) => ({
      ...activity,
      content: activity.content === null ? null : compactText(activity.content, 120),
      content_truncated: activity.content !== null,
    }));
    if (Array.isArray(preview.structured_memories)) preview.structured_memories = preview.structured_memories.slice(0, 5).map((memory) => ({
      ...memory,
      content: compactText(memory.content, 160),
      content_truncated: true,
    }));
    if (Array.isArray(preview.tasks)) {
      preview.tasks = preview.tasks.map((task) => {
        const projected = {
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
        };
        if (task.field_availability) projected.field_availability = taskFieldAvailability(task, projected);
        return projected;
      });
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

export function uniqueByText(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = normalize(typeof item === "string" ? item : item?.text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function statements(value) {
  return textContent(value)
    .split(/(?:\r?\n)+|(?<=[。！？!?;；])\s*/u)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/u, "").trim())
    .filter(Boolean)
    .slice(0, 40);
}

export function derivedItem(text, eventId, category, confidence = "medium") {
  return {
    text: compactText(text, 500),
    source: "derived_from_event",
    source_event_id: eventId,
    category,
    confidence,
  };
}

export function canonicalItems(values, category) {
  return (Array.isArray(values) ? values : []).map((value) => ({
    text: typeof value === "string" ? value : JSON.stringify(value),
    source: "task_snapshot",
    source_event_id: null,
    category,
    confidence: "high",
  }));
}

export function classifyCheckpointStatements(events) {
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
    const content = rawExpired(event) ? null : fromJson(event.content, null);
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

export function checkpointConfidence({ activeRequest, latestOutcome, classified }) {
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

export function memoryScopeScore(memory) {
  return {
    session: 1,
    workstream: 0.9,
    task: 0.8,
    project: 0.7,
    user: 0.6,
  }[memory.scope] || 0.5;
}

export function memoryRecencyScore(memory, currentTime = Date.now()) {
  const timestamp = Date.parse(memory.updated_at || memory.created_at);
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (currentTime - timestamp) / 86_400_000);
  return Math.max(0, 1 - (ageDays / 365));
}

export function hashKey(apiKey) {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}

export function makeApiKey() {
  return `mnm_${randomBytes(32).toString("base64url")}`;
}

export function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)) {
    throw new ValidationError(`${label} is invalid.`);
  }
}

export function assertStringArray(value, label, { maxItems = 50, maxLength = 2_048 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems
      || value.some((item) => typeof item !== "string" || !item.trim() || item.length > maxLength)) {
    throw new ValidationError(`${label} must be an array of non-empty strings.`);
  }
}

export function requiredBoundedString(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new ValidationError(`${label} is required and must be at most ${maxLength} characters.`);
  }
  return value.trim();
}

export function taskBootstrapIdentifier(userId, projectId, title) {
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

export function projectBootstrapIdentifier(userId, name) {
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

export function taskBootstrapSimilarity(title, task) {
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

export function normalizedUniqueStrings(values) {
  return [...new Set(values.map((value) => value.trim()))];
}

export function sanitizeGitRemote(value) {
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

export function canonicalGitRemote(value) {
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

export function projectBootstrapSimilarity(project, candidate) {
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

export function projectBootstrapCandidates(project, projects) {
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

export function resolverRequest(payload, { requireQuery = false, allowProjectId = false } = {}) {
  const request = typeof payload === "string" ? { query: payload } : payload;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new ValidationError("Resolver request must be an object.");
  }
  const query = request.query === undefined ? "" : request.query;
  if (typeof query !== "string" || query.length > 4_096) {
    throw new ValidationError(requireQuery
      ? "query is required and must be at most 4096 characters."
      : "query must be a string of at most 4096 characters.");
  }
  let signals = request.signals ?? {};
  if (!signals || typeof signals !== "object" || Array.isArray(signals)) {
    throw new ValidationError("signals must be an object.");
  }
  signals = { ...signals };
  if (allowProjectId && Object.hasOwn(request, "project_id")) {
    assertIdentifier(request.project_id, "project_id");
    if (signals.project_id !== undefined && signals.project_id !== request.project_id) {
      throw new ValidationError("project_id conflicts with signals.project_id.", "CONFLICTING_PROJECT_ID");
    }
    signals.project_id = request.project_id;
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
  if (requireQuery && !query.trim() && !(allowProjectId && signals.project_id)) {
    throw new ValidationError(allowProjectId ? "query or project_id is required." : "query is required.");
  }
  if (!query.trim() && !Object.keys(signals).length) {
    throw new ValidationError("query or at least one resolver signal is required.");
  }
  return { query: query.trim(), signals: { ...signals } };
}

export function requestedSourceWorkstreamIds(payload) {
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

export function assertIsoTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new ValidationError(`${label} must be an ISO timestamp.`);
  }
}

export function parseRetention(value, fallback = 30) {
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

export function retentionExpiry(capturedAt, days) {
  if (days === null) return null;
  return new Date(Date.parse(capturedAt) + days * 86_400_000).toISOString();
}

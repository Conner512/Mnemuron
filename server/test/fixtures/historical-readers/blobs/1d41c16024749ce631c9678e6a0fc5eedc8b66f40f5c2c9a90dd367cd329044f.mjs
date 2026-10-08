import { createHash } from "node:crypto";

export const RECONCILIATION_SCHEMA_VERSION = "canonical-task-reconciliation-v0.1";

const ARRAY_FIELDS = new Set([
  "progress",
  "decisions",
  "blockers",
  "next_steps",
  "resources",
]);
const APPEND_FIELDS = new Set(ARRAY_FIELDS);
const REMOVE_FIELDS = new Set(["blockers", "next_steps"]);
const SCALAR_FIELDS = new Set(["title", "goal", "status"]);
const TASK_STATUSES = new Set(["active", "paused", "completed", "archived"]);
const WORKSTREAM_STATUSES = new Set(["active", "paused", "completed", "merged"]);
const TELEMETRY_RESOURCE_CATEGORIES = new Set(["tool", "working_directory"]);
const COMPLETION_PATTERN = /(?:已完成|完成了|已通过|通过验证|验证成功|已部署|部署完成|已配置|配置完成|已修复|成功完成|completed|verified|deployed|configured|fixed|passed)/iu;
const COMPLETION_NEGATION_PATTERN = /(?:未完成|没有完成|尚未完成|未通过|没有通过|失败|无法|not\s+(?:completed|verified|deployed|configured|fixed|passed)|failed|cannot)/iu;

export function normalizeReconciliationText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalTaskSnapshot(task) {
  return {
    task_id: task.task_id,
    project_id: task.project_id,
    project_name: task.project_name,
    title: task.title,
    aliases: task.aliases || [],
    goal: task.goal,
    status: task.status,
    progress: task.progress || [],
    decisions: task.decisions || [],
    blockers: task.blockers || [],
    next_steps: task.next_steps || [],
    resources: task.resources || [],
    workstreams: task.workstreams || [],
    conflicts: task.conflicts || [],
  };
}

export function canonicalTaskHash(task) {
  return digest(canonicalValue(canonicalTaskSnapshot(task)));
}

function stringValue(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) {
    throw new Error(`${label} must be a non-empty string of at most 2048 characters.`);
  }
  return value.trim();
}

function operationIdentity(operation) {
  return {
    op: operation.op,
    field: operation.field,
    workstream_id: operation.workstream_id || null,
    value_fingerprint: operation.value_fingerprint || null,
    expected_fingerprint: operation.expected_fingerprint || null,
  };
}

function finalizeOperation(operation) {
  return {
    operation_id: `op-${digest(operationIdentity(operation)).slice(0, 24)}`,
    ...operation,
  };
}

function arrayFingerprints(task, field) {
  return new Set((task[field] || []).map((item) => normalizeReconciliationText(
    typeof item === "string" ? item : JSON.stringify(item),
  )).filter(Boolean));
}

function sourceForCheckpoint(checkpoint, eventId) {
  return {
    source_type: "checkpoint",
    checkpoint_id: checkpoint.checkpoint_id,
    checkpoint_version: checkpoint.version,
    event_id: eventId,
    workstream_id: checkpoint.workstream_id,
    session_id: checkpoint.session_id,
    provenance: checkpoint.provenance,
    confidence: checkpoint.generation?.confidence ?? 0,
    confidence_label: checkpoint.generation?.confidence_label || "low",
    warnings: checkpoint.generation?.warnings || [],
  };
}

function safeProgressItem(checkpoint, item) {
  const text = String(item.text || "").trim();
  return checkpoint.generation?.confidence_label === "medium"
    && Number(checkpoint.generation?.confidence || 0) >= 0.65
    && item.source_event_id === checkpoint.latest_outcome?.source_event_id
    && text.length >= 12
    && text.length <= 500
    && COMPLETION_PATTERN.test(text)
    && !COMPLETION_NEGATION_PATTERN.test(text);
}

export function buildDerivedOperations(task, checkpoints) {
  const mappings = [
    ["completed_items", "progress"],
    ["decisions", "decisions"],
    ["blockers", "blockers"],
    ["recommended_next_steps", "next_steps"],
    ["resources", "resources"],
  ];
  const existing = new Map([...ARRAY_FIELDS].map((field) => [field, arrayFingerprints(task, field)]));
  const operations = new Map();

  for (const checkpoint of checkpoints) {
    for (const [checkpointField, taskField] of mappings) {
      for (const item of Array.isArray(checkpoint[checkpointField]) ? checkpoint[checkpointField] : []) {
        if (!item || item.source !== "derived_from_event") continue;
        if (taskField === "resources" && TELEMETRY_RESOURCE_CATEGORIES.has(item.category)) continue;
        const value = typeof item.text === "string" ? item.text.trim() : "";
        const valueFingerprint = normalizeReconciliationText(value);
        if (!valueFingerprint || existing.get(taskField).has(valueFingerprint)) continue;
        const key = `append_unique:${taskField}:${valueFingerprint}`;
        const source = sourceForCheckpoint(checkpoint, item.source_event_id);
        const automaticEligible = taskField === "progress" && safeProgressItem(checkpoint, item);
        const current = operations.get(key);
        if (current) {
          current.sources.push(source);
          current.automatic_eligible = current.automatic_eligible && automaticEligible;
          continue;
        }
        operations.set(key, finalizeOperation({
          op: "append_unique",
          field: taskField,
          value,
          before: null,
          after: value,
          value_fingerprint: valueFingerprint,
          automatic_eligible: automaticEligible,
          policy_reason: automaticEligible
            ? "source_backed_additive_progress"
            : "material_or_uncertain_checkpoint_claim",
          sources: [source],
        }));
      }
    }
  }
  return [...operations.values()];
}

export function buildRequestedOperations(task, requestedOperations, requestedBy) {
  if (!Array.isArray(requestedOperations) || requestedOperations.length > 50) {
    throw new Error("operations must be an array with at most 50 items.");
  }
  const operations = [];
  for (const requested of requestedOperations) {
    if (!requested || typeof requested !== "object" || Array.isArray(requested)) {
      throw new Error("each reconciliation operation must be an object.");
    }
    const op = requested.op;
    const field = requested.field;
    let operation;
    if (op === "append_unique" && APPEND_FIELDS.has(field)) {
      const value = stringValue(requested.value, "operation.value");
      const valueFingerprint = normalizeReconciliationText(value);
      if (arrayFingerprints(task, field).has(valueFingerprint)) continue;
      operation = {
        op,
        field,
        value,
        before: null,
        after: value,
        value_fingerprint: valueFingerprint,
      };
    } else if (op === "remove_exact" && REMOVE_FIELDS.has(field)) {
      const value = stringValue(requested.value, "operation.value");
      const valueFingerprint = normalizeReconciliationText(value);
      const matched = (task[field] || []).find((item) =>
        normalizeReconciliationText(typeof item === "string" ? item : JSON.stringify(item))
          === valueFingerprint);
      if (matched === undefined) continue;
      operation = {
        op,
        field,
        value,
        before: matched,
        after: null,
        value_fingerprint: valueFingerprint,
      };
    } else if (op === "replace_scalar" && SCALAR_FIELDS.has(field)) {
      const value = stringValue(requested.value, "operation.value");
      if (field === "status" && !TASK_STATUSES.has(value)) {
        throw new Error("task status must be active, paused, completed, or archived.");
      }
      if (task[field] === value) continue;
      operation = {
        op,
        field,
        value,
        before: task[field],
        after: value,
        value_fingerprint: normalizeReconciliationText(value),
        expected_fingerprint: normalizeReconciliationText(task[field]),
      };
    } else if (op === "replace_workstream_status" && field === "workstreams") {
      const workstreamId = stringValue(requested.workstream_id, "operation.workstream_id");
      const value = stringValue(requested.value, "operation.value");
      if (!WORKSTREAM_STATUSES.has(value)) {
        throw new Error("workstream status must be active, paused, completed, or merged.");
      }
      const workstream = (task.workstreams || []).find((item) => item.workstream_id === workstreamId);
      if (!workstream) throw new Error(`workstream not found: ${workstreamId}.`);
      if (workstream.status === value) continue;
      operation = {
        op,
        field,
        workstream_id: workstreamId,
        value,
        before: workstream.status,
        after: value,
        value_fingerprint: normalizeReconciliationText(value),
        expected_fingerprint: normalizeReconciliationText(workstream.status),
      };
    } else if (op === "record_conflict" && field === "conflicts") {
      if (!requested.value || typeof requested.value !== "object" || Array.isArray(requested.value)) {
        throw new Error("record_conflict value must be an object.");
      }
      const value = canonicalValue(requested.value);
      const valueFingerprint = digest(value);
      if ((task.conflicts || []).some((item) => digest(canonicalValue(item)) === valueFingerprint)) continue;
      operation = {
        op,
        field,
        value,
        before: null,
        after: value,
        value_fingerprint: valueFingerprint,
      };
    } else {
      throw new Error(`unsupported reconciliation operation: ${String(op)} on ${String(field)}.`);
    }
    operations.push(finalizeOperation({
      ...operation,
      automatic_eligible: false,
      policy_reason: "explicit_confirmation_required",
      sources: [{
        source_type: "user_requested",
        credential_id: requestedBy?.credential_id || null,
        device_id: requestedBy?.device_id || null,
        agent_id: requestedBy?.agent_id || null,
        agent_instance_id: requestedBy?.agent_instance_id || null,
      }],
    }));
  }
  return operations;
}

export function mergeOperations(...groups) {
  const merged = new Map();
  for (const operation of groups.flat()) {
    const key = JSON.stringify(operationIdentity(operation));
    const current = merged.get(key);
    if (!current) {
      merged.set(key, structuredClone(operation));
      continue;
    }
    const sourceKeys = new Set(current.sources.map((source) => JSON.stringify(source)));
    for (const source of operation.sources || []) {
      const sourceKey = JSON.stringify(source);
      if (!sourceKeys.has(sourceKey)) {
        current.sources.push(source);
        sourceKeys.add(sourceKey);
      }
    }
    current.automatic_eligible = current.automatic_eligible && operation.automatic_eligible;
  }
  return [...merged.values()].sort((left, right) =>
    JSON.stringify(operationIdentity(left)).localeCompare(JSON.stringify(operationIdentity(right))));
}

export function detectOperationConflicts(operations) {
  const buckets = new Map();
  for (const operation of operations) {
    let key = null;
    if (operation.op === "replace_scalar") key = `scalar:${operation.field}`;
    if (operation.op === "replace_workstream_status") {
      key = `workstream:${operation.workstream_id}:status`;
    }
    if (operation.op === "append_unique" || operation.op === "remove_exact") {
      key = `item:${operation.field}:${operation.value_fingerprint}`;
    }
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(operation);
  }
  const conflicts = [];
  for (const [controlledKey, bucket] of buckets) {
    const outcomes = new Set(bucket.map((operation) => JSON.stringify({
      op: operation.op,
      after: operation.after,
    })));
    if (outcomes.size <= 1) continue;
    conflicts.push({
      conflict_id: `conflict-${digest({ controlledKey, outcomes: [...outcomes].sort() }).slice(0, 24)}`,
      type: "structural",
      controlled_key: controlledKey,
      operation_ids: bucket.map((operation) => operation.operation_id),
      claims: bucket.map((operation) => ({
        operation_id: operation.operation_id,
        op: operation.op,
        before: operation.before,
        after: operation.after,
        sources: operation.sources,
      })),
      automatic_resolution_performed: false,
    });
  }
  return conflicts;
}

export function applyOperations(task, operations) {
  const next = structuredClone(canonicalTaskSnapshot(task));
  for (const operation of operations) {
    if (operation.op === "append_unique") {
      const fingerprints = arrayFingerprints(next, operation.field);
      if (!fingerprints.has(operation.value_fingerprint)) next[operation.field].push(operation.value);
    } else if (operation.op === "remove_exact") {
      next[operation.field] = next[operation.field].filter((item) =>
        normalizeReconciliationText(typeof item === "string" ? item : JSON.stringify(item))
          !== operation.value_fingerprint);
    } else if (operation.op === "replace_scalar") {
      next[operation.field] = operation.value;
    } else if (operation.op === "replace_workstream_status") {
      next.workstreams = next.workstreams.map((workstream) =>
        workstream.workstream_id === operation.workstream_id
          ? { ...workstream, status: operation.value }
          : workstream);
    } else if (operation.op === "record_conflict") {
      const fingerprint = operation.value_fingerprint;
      if (!next.conflicts.some((item) => digest(canonicalValue(item)) === fingerprint)) {
        next.conflicts.push(operation.value);
      }
    } else {
      throw new Error(`unsupported stored reconciliation operation: ${operation.op}.`);
    }
  }
  return next;
}

export function reconciliationFingerprint({
  userId,
  taskId,
  baseCanonicalVersion,
  sourceCheckpointIds,
  operations,
}) {
  return digest({
    schema_version: RECONCILIATION_SCHEMA_VERSION,
    user_id: userId,
    task_id: taskId,
    base_canonical_version: baseCanonicalVersion,
    source_checkpoint_ids: [...sourceCheckpointIds].sort(),
    operations: operations.map(operationIdentity),
  });
}

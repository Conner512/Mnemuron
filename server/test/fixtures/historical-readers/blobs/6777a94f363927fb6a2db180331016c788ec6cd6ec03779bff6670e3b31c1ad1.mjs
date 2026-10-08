import { ValidationError } from "./errors.mjs";

export const MEMORY_TYPES = new Set(["goal", "fact", "constraint", "decision", "completed", "blocker", "remaining", "next_step"]);
const SCOPES = new Set(["user", "project", "task", "workstream", "session"]);
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export function memoryPayload(payload, auth) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || ![null, Object.prototype].includes(Object.getPrototypeOf(payload))) {
    throw new ValidationError("Memory payload must be an object.");
  }
  for (const field of ["user_id", "credential_id", "device_id", "agent_id", "agent_instance_id"]) {
    if (Object.hasOwn(payload, field) && payload[field] !== auth[field]) {
      throw new ValidationError("Submitted identity does not match the credential.", "IDENTITY_MISMATCH");
    }
  }
  return payload;
}

export function memoryContent(content) {
  if (typeof content !== "string" || !content.trim()) throw new ValidationError("content is required.", "INVALID_CONTENT");
  if (content.length > 4_096) throw new ValidationError("content must be at most 4096 UTF-16 code units.", "CONTENT_TOO_LONG");
  return content.trim();
}

export function memoryType(value = "fact") {
  if (!MEMORY_TYPES.has(value)) throw new ValidationError("memory_type is invalid.", "INVALID_MEMORY_TYPE");
  return value;
}

export function memoryTopic(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 120) {
    throw new ValidationError("topic must be null or a non-empty string of at most 120 UTF-16 code units.", "INVALID_TOPIC");
  }
  return value.trim();
}

export function memoryTargets(payload) {
  return Object.fromEntries(["project_id", "task_id", "workstream_id", "session_id"].map(field => {
    const value = payload[field] ?? null;
    if (value !== null && (typeof value !== "string" || !IDENTIFIER.test(value))) {
      throw new ValidationError(`${field} is invalid.`, "INVALID_IDENTIFIER");
    }
    return [field, value];
  }));
}

export function memoryOperationId(payload, headerKey) {
  for (const key of [payload.operation_id, headerKey]) {
    if (key !== undefined && (typeof key !== "string" || !IDENTIFIER.test(key))) {
      throw new ValidationError("operation_id must be a non-empty ASCII identifier of at most 128 characters.", "INVALID_OPERATION_ID");
    }
  }
  if (payload.operation_id !== undefined && headerKey !== undefined && payload.operation_id !== headerKey) {
    throw new ValidationError("Idempotency-Key and operation_id disagree.", "IDEMPOTENCY_KEY_MISMATCH");
  }
  return payload.operation_id ?? headerKey ?? null;
}

export function memoryIntent(payload, auth) {
  memoryPayload(payload, auth);
  if (!SCOPES.has(payload.scope)) throw new ValidationError("scope must be user, project, task, workstream, or session.", "INVALID_MEMORY_SCOPE");
  const source = payload.source ?? "explicit";
  if (typeof source !== "string" || !source.trim() || source.length > 2_048) throw new ValidationError("source must be a non-empty label of at most 2048 characters.", "INVALID_SOURCE");
  return {
    content: memoryContent(payload.content),
    scope: payload.scope,
    ...memoryTargets(payload),
    memory_type: memoryType(payload.memory_type ?? "fact"),
    topic: memoryTopic(payload.topic),
    source: source.trim(),
  };
}

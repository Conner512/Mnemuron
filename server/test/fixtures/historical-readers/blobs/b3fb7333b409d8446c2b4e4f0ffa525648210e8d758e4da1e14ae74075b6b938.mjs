import { createHash } from 'node:crypto';
import { ValidationError, NotFoundError, ConflictError } from './errors.mjs';
import { TASK_READ_FIELDS, TASK_READ_OPTIONS, TASK_FIELD_NOTE, taskFieldAvailability } from '../../shared/task-read-contract.mjs';

export function readTaskContext(store, auth, payload) {
  store.requireScope(auth, 'resume:read');
  const allowed = new Set(['project_id', 'query', 'task_id', ...TASK_READ_OPTIONS]);
  for (const key of Object.keys(payload)) if (!allowed.has(key)) throw new ValidationError('Unsupported Task read argument.');
  for (const key of ['project_id', 'task_id']) {
    if (typeof payload[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(payload[key])) {
      throw new ValidationError('Exact project_id and task_id are required.');
    }
  }
  if (payload.query !== undefined && (typeof payload.query !== 'string' || !payload.query.trim() || payload.query.length > 4096)) {
    throw new ValidationError('Invalid query.');
  }
  const field = payload.task_field ?? 'goal';
  if (!TASK_READ_FIELDS.includes(field) || payload.task_field === null) throw new ValidationError('Invalid task_field.');
  const integer = (key, fallback, min, max) => {
    const value = payload[key] === undefined ? fallback : payload[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new ValidationError(`Invalid ${key}.`);
    return value;
  };
  const index = integer('item_offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const offset = integer('content_offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer('content_limit', 4096, 1, 8192);
  const expectedVersion = payload.canonical_version === undefined ? null : integer('canonical_version', 1, 1, Number.MAX_SAFE_INTEGER);
  if ((index > 0 || offset > 0) && expectedVersion === null) throw new ValidationError('Continuation requires canonical_version.', 'TASK_VERSION_REQUIRED');
  const row = store.db.prepare(`SELECT t.* FROM tasks t JOIN projects p ON p.project_id=t.project_id AND p.user_id=t.user_id
    WHERE t.user_id=? AND t.project_id=? AND t.task_id=?`).get(auth.user_id, payload.project_id, payload.task_id);
  if (!row) throw new NotFoundError('Task context not found.', 'TASK_CONTEXT_NOT_FOUND');
  const task = store.taskFromRow(row);
  if (expectedVersion !== null && expectedVersion !== task.canonical_version) {
    throw new ConflictError('Canonical Task changed; restart the read instead of combining versions.', 'TASK_VERSION_CHANGED');
  }
  const value = task[field];
  const values = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
  if (index >= Math.max(values.length, 1)) throw new ValidationError('item_offset exceeds field length.');
  const item = values[index];
  const format = item === undefined || typeof item === 'string' ? 'text' : 'json';
  const text = item === undefined ? '' : format === 'text' ? item : JSON.stringify(item);
  const points = Array.from(text);
  if (offset > points.length) throw new ValidationError('content_offset exceeds item length.');
  const end = Math.min(offset + limit, points.length);
  const content = points.slice(offset, end).join('');
  const nextPosition = end < points.length ? { item_offset: index, content_offset: end }
    : index + 1 < values.length ? { item_offset: index + 1, content_offset: 0 } : null;
  const identity = { project_id: task.project_id, task_id: task.task_id, canonical_version: task.canonical_version };
  const availability = taskFieldAvailability(task, {});
  availability[field].returned = nextPosition === null && index === 0 && offset === 0 ? 'full' : 'partial';
  const result = {
    schema_version: 'task-context-read-v0.1', status: 'task_context_detail', read_only: true,
    task: { ...identity, status: task.status, updated_at: task.updated_at },
    source: { kind: 'canonical_task', ...identity, updated_at: task.updated_at },
    field_availability: availability, interpretation: TASK_FIELD_NOTE,
    task_field: field, field_type: Array.isArray(value) ? 'array' : 'scalar', item_offset: index, item_count: values.length,
    content_format: format, content, content_offset: offset, content_length: points.length,
    content_length_unit: 'unicode_code_points', content_complete: end === points.length,
    field_complete: nextPosition === null,
    field_hash: createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex'),
    next_request: nextPosition ? { ...identity, task_field: field, content_limit: limit, ...nextPosition } : null,
    safety: { resume_created: false, task_scope_changed: false, context_injected: false },
    production_ready: false,
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) {
    throw Object.assign(new Error('Task detail exceeds response budget; reduce content_limit.'), { statusCode: 422, errorCode: 'TASK_DETAIL_TOO_LARGE' });
  }
  return result;
}

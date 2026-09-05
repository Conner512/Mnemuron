import { NotFoundError, ValidationError } from "./errors.mjs";
import { memoryTargets } from "./memory-validation.mjs";

function branchTasks(db, userId, workstreamId) {
  return db.prepare(`
    SELECT t.task_id, t.project_id FROM tasks t
    WHERE t.user_id = ? AND (
      EXISTS (SELECT 1 FROM json_each(t.workstreams_json) w WHERE json_extract(w.value, '$.workstream_id') = ?)
      OR EXISTS (SELECT 1 FROM events e WHERE e.user_id = t.user_id AND e.task_id = t.task_id
        AND e.project_id = t.project_id AND e.workstream_id = ?)
      OR EXISTS (SELECT 1 FROM checkpoints c WHERE c.user_id = t.user_id AND c.task_id = t.task_id
        AND c.project_id = t.project_id AND c.workstream_id = ?)
      OR EXISTS (SELECT 1 FROM memories m WHERE m.user_id = t.user_id AND m.task_id = t.task_id
        AND m.project_id = t.project_id AND m.workstream_id = ?)
    )
  `).all(userId, workstreamId, workstreamId, workstreamId, workstreamId);
}

export function resolveMemoryScope(db, userId, payload, { write = false, workstreamIds = null } = {}) {
  const scope = memoryTargets(payload);
  let projectDerivedFrom = scope.project_id ? "explicit" : null;
  const branches = workstreamIds || (scope.workstream_id ? [scope.workstream_id] : []);
  const branchOwners = branches.map(id => ({ id, tasks: branchTasks(db, userId, id) }));
  if (write && !scope.task_id && scope.workstream_id) {
    const owners = branchOwners[0].tasks.filter(t => !scope.project_id || t.project_id === scope.project_id);
    if (owners.length > 1) throw new ValidationError("Workstream is ambiguous; supply an exact Task.", "SCOPE_AMBIGUOUS");
    if (owners.length === 1) scope.task_id = owners[0].task_id;
  }
  if (scope.task_id) {
    const task = db.prepare("SELECT project_id FROM tasks WHERE user_id = ? AND task_id = ?").get(userId, scope.task_id);
    if (!task) throw new NotFoundError("Task not found.", "TASK_NOT_FOUND");
    if (scope.project_id && scope.project_id !== task.project_id) throw new ValidationError("Task and Project disagree.", "SCOPE_MISMATCH");
    if (!scope.project_id) projectDerivedFrom = "task";
    scope.project_id = task.project_id;
  }
  if (scope.project_id && !db.prepare("SELECT 1 FROM projects WHERE user_id = ? AND project_id = ?").get(userId, scope.project_id)) {
    throw new NotFoundError("Project not found.", "PROJECT_NOT_FOUND");
  }
  for (const {tasks} of branchOwners) {
    if (tasks.length && !tasks.some(t => (!scope.task_id || t.task_id === scope.task_id) && (!scope.project_id || t.project_id === scope.project_id))) {
      throw new ValidationError("Workstream and requested scope disagree.", "SCOPE_MISMATCH");
    }
    if (!tasks.length && (!write || !scope.task_id)) throw new NotFoundError("Workstream not found.", "WORKSTREAM_NOT_FOUND");
    if (!scope.task_id && tasks.filter(t => !scope.project_id || t.project_id === scope.project_id).length > 1) {
      throw new ValidationError("Workstream is ambiguous; supply an exact Task.", "SCOPE_AMBIGUOUS");
    }
  }
  if (write) {
    const required = { project: ["project_id"], task: ["task_id"], workstream: ["task_id", "workstream_id"], session: ["session_id"] }[payload.scope] || [];
    const missing = required.find(field => !scope[field]);
    if (missing) throw new ValidationError(`${missing} is required for ${payload.scope}-scoped memory.`, "INVALID_MEMORY_SCOPE");
  }
  // Session is provenance, not a permanent Task owner; first sessions need no synthetic Event.
  return { ...scope, project_derived_from: projectDerivedFrom };
}

export function memoryScopeSql(scope, { workstreamIds = null, includeShared = true } = {}) {
  const clauses = [], params = [];
  if (scope.project_id) { clauses.push("(m.scope = 'user' OR m.project_id = ?)"); params.push(scope.project_id); }
  if (scope.task_id) { clauses.push("(m.scope IN ('user','project') OR m.task_id = ?)"); params.push(scope.task_id); }
  if (scope.session_id) { clauses.push("(m.scope != 'session' OR m.session_id = ?)"); params.push(scope.session_id); }
  if (workstreamIds) {
    clauses.push(`(${includeShared ? 'm.workstream_id IS NULL OR ' : ''}m.workstream_id IN (${workstreamIds.map(() => '?').join(',')}))`);
    params.push(...workstreamIds);
  }
  return { sql: clauses.length ? clauses.join(' AND ') : '1', params };
}

// Project profile: what a project's own memories are about, at a glance. Counts by type, the most used keywords, the
// strongest preferences / architecture / workflows and the latest problems. Read-only; the same owner, live-project
// (deleted projects refused, merged members included) and Web-visibility rules as search. Account-wide memories
// (scope user) belong to every project and are left out, so the profile describes the project itself.
import { ValidationError } from '../errors.mjs';
import { resolveMemoryScope, memoryScopeSql } from '../memory-scope.mjs';
import { webMemorySql } from './web-visibility.mjs';
import { memoryPresentation } from '../../../shared/memory-display.mjs';

export const PROFILE_CONCEPTS = 12, PROFILE_KEY = 6, PROFILE_PROBLEMS = 5, PREVIEW_CHARS = 160;
const KEY_KINDS = ['preference', 'architecture', 'workflow'];

const item = row => ({ memory_id: row.memory_id, title: memoryPresentation(row).title,
  preview: row.content.length > PREVIEW_CHARS ? row.content.slice(0, PREVIEW_CHARS - 1) + '…' : row.content,
  kind: row.kind || null, strength: row.strength ?? null, created_at: row.created_at });

export function projectProfile(store, auth, projectId) {
  store.requireScope(auth, 'memory:read');
  if (typeof projectId !== 'string' || !projectId) throw new ValidationError('project_id is required.', 'INVALID_PROJECT');
  const scope = resolveMemoryScope(store.db, auth.user_id, { project_id: projectId }, { lifecycle: store.lifecycle });
  const filter = memoryScopeSql(scope), where = `m.user_id=? AND m.status='active' AND m.scope<>'user' AND ${filter.sql} AND ${webMemorySql(auth)}`;
  const params = [auth.user_id, ...filter.params], db = store.db;
  const from = `FROM memories m LEFT JOIN memory_traits t ON t.user_id=m.user_id AND t.memory_id=m.memory_id WHERE ${where}`;
  const totals = db.prepare(`SELECT count(*) n, max(coalesce(m.updated_at,m.created_at)) last FROM memories m WHERE ${where}`).get(...params);
  const kinds = Object.fromEntries(db.prepare(`SELECT coalesce(t.kind,'none') kind, count(*) n ${from} GROUP BY 1 ORDER BY 2 DESC`).all(...params).map(r => [r.kind, r.n]));
  const concepts = db.prepare(`SELECT min(c.value) concept, count(DISTINCT m.memory_id) n ${from.replace('LEFT JOIN memory_traits t', 'JOIN memory_traits t')
    .replace(' WHERE ', ', json_each(t.concepts_json) c WHERE ')} GROUP BY memory_concept_key(c.value) ORDER BY n DESC, concept LIMIT ?`).all(...params, PROFILE_CONCEPTS);
  const key = db.prepare(`SELECT m.memory_id,m.content,m.topic,m.created_at,t.kind,t.strength ${from} AND t.kind IN (${KEY_KINDS.map(() => '?').join(',')})
    ORDER BY coalesce(t.strength,5) DESC, coalesce(m.updated_at,m.created_at) DESC LIMIT ?`).all(...params, ...KEY_KINDS, PROFILE_KEY).map(item);
  const problems = db.prepare(`SELECT m.memory_id,m.content,m.topic,m.created_at,t.kind,t.strength ${from} AND t.kind='bug'
    ORDER BY m.created_at DESC LIMIT ?`).all(...params, PROFILE_PROBLEMS).map(item);
  const project = db.prepare('SELECT project_id,name FROM projects WHERE user_id=? AND project_id=?').get(auth.user_id, scope.project_id);
  store.audit({ auth, action: 'memory.profile', targetType: 'project', targetId: scope.project_id,
    metadata: { memory_count: totals.n, result_refs: [...key, ...problems].map(m => m.memory_id) } });
  return { project: { project_id: scope.project_id, name: project?.name || null }, memory_count: totals.n, last_activity: totals.last || null,
    kinds, concepts: concepts.map(r => ({ concept: r.concept, count: r.n })), key_memories: key, recent_problems: problems };
}

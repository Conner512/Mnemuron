import assert from 'node:assert/strict';
import { memoryFixture, businessSnapshot } from './core-memory-fixture.mjs';

export const PROJECT_MARKER = 'CASE-20400101-05';
export const PROJECT_NAME = 'Aster Memory';
export const MEMORY_TYPES = ['goal', 'fact', 'constraint', 'decision', 'completed', 'blocker', 'remaining', 'next_step'];

export async function projectMemoryFixture(t) {
  const f = await memoryFixture(t);
  const save = async (owner, payload) => {
    const result = await f.request('POST', '/v1/memories', payload, owner);
    assert.equal(result.status, 201);
    return result.body.memory;
  };
  const userMemory = await save(f.a, { scope: 'user', content: `${PROJECT_MARKER}：Synthetic user read marker` });
  const task = { ...f.alpha, project_name: PROJECT_NAME,
    goal: 'Canonical synthetic goal', progress: ['Canonical completed step'],
    decisions: ['Canonical decision'], blockers: ['Canonical blocker'], next_steps: ['Canonical next step'] };
  f.store.upsertTask(f.a.auth, task);
  f.store.upsertProject(f.a.auth, { project_id: f.alpha.project_id, name: PROJECT_NAME, aliases: [PROJECT_MARKER, '星图记忆'] });
  // Identical names in another owner must not become resolver candidates or content.
  f.store.upsertProject(f.other.auth, { project_id: f.foreign.project_id, name: PROJECT_NAME, aliases: [PROJECT_MARKER] });
  const memories = [];
  for (const [index, memory_type] of MEMORY_TYPES.entries()) {
    const scope = index % 2 ? { scope: 'task', task_id: f.alpha.task_id } : { scope: 'project', project_id: f.alpha.project_id };
    memories.push(await save(index % 2 ? f.b : f.a, { ...scope, memory_type,
      content: `${PROJECT_MARKER}：Synthetic ${memory_type} statement`, topic: 'Synthetic project acceptance' }));
  }
  const unrelated = await save(f.a, { scope: 'project', project_id: f.beta.project_id, content: `${PROJECT_MARKER}：Other project` });
  const foreign = await save(f.other, { scope: 'project', project_id: f.foreign.project_id, content: `${PROJECT_MARKER}：Foreign owner` });
  const readers = [f.a, f.b].map((owner, index) => f.store.issueCredential({
    label: `project-reader-${index}`, userId: owner.auth.user_id, deviceId: `device-reader-${index}`,
    agentId: 'test', agentInstanceId: `project-reader-${index}`, scopes: ['memory:read', 'resume:read'],
  }));
  return { ...f, save, userMemory, task, memories, unrelated, foreign, readers,
    preview: (args, reader = readers[0]) => f.request('POST', '/v1/project-context/preview', args, reader) };
}

export function projectBusinessSnapshot(store) {
  return { ...businessSnapshot(store), ...Object.fromEntries([
    'projects', 'checkpoints', 'resolver_selections', 'resume_injection_events',
    'task_bootstrap_previews', 'task_reconciliation_proposals', 'memory_create_operations',
    'memory_revisions', 'memory_sources', 'memory_source_links', 'memory_processing_outbox', 'memory_index_outbox',
  ].map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])) };
}

export function assertProjectContext(preview, f, memories = f.memories) {
  assert.equal(preview.status, 'project_context_preview');
  assert.equal(preview.read_only, true);
  assert.equal(preview.project.project_id, f.alpha.project_id);
  assert.deepEqual(preview.structured_memories.map(m => m.memory_id).sort(), memories.map(m => m.memory_id).sort());
  for (const expected of memories) {
    const actual = preview.structured_memories.find(m => m.memory_id === expected.memory_id);
    for (const key of ['content', 'scope', 'project_id', 'task_id', 'memory_type', 'status', 'source', 'provenance']) {
      assert.deepEqual(actual[key], expected[key]);
    }
  }
  assert.deepEqual(preview.tasks.map(task => task.task_id), [f.alpha.task_id]);
  for (const key of ['goal', 'progress', 'decisions', 'blockers', 'next_steps']) {
    assert.deepEqual(preview.tasks[0][key], f.task[key]);
  }
  for (const key of ['resume_created', 'task_scope_changed', 'context_injected']) assert.equal(preview.safety[key], false);
}

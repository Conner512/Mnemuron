import test from 'node:test';
import assert from 'node:assert/strict';
import { projectMemoryFixture, projectBusinessSnapshot, assertProjectContext, PROJECT_MARKER, PROJECT_NAME, MEMORY_TYPES } from './helpers/project-memory-fixture.mjs';

test('project context combines explicit project and derived task ownership across two read-only clients', async t => {
  const f = await projectMemoryFixture(t), before = projectBusinessSnapshot(f.store);
  for (const memory of f.memories) {
    assert.equal(memory.project_id, f.alpha.project_id);
    assert.equal(memory.task_id, memory.scope === 'task' ? f.alpha.task_id : null);
  }
  for (const reader of f.readers) for (const query of [PROJECT_NAME, PROJECT_MARKER, '星图记忆']) {
    const result = await f.preview({ query }, reader);
    assert.equal(result.status, 200);
    assertProjectContext(result.body, f);
    assert.equal(result.body.resolution.confidence, 'high');
    assert.deepEqual(result.body.structured_memories.map(m => m.memory_type).sort(), [...MEMORY_TYPES].sort());
  }
  assert.deepEqual(projectBusinessSnapshot(f.store), before);
});

test('a registered alias does not relabel an earlier user memory or become a canonical project ID', async t => {
  const f = await projectMemoryFixture(t), before = projectBusinessSnapshot(f.store);
  const rejected = await f.preview({ project_id: PROJECT_MARKER, query: PROJECT_NAME });
  assert.equal(rejected.body.status, 'no_match');
  assert.equal(rejected.body.reason, 'explicit_identifier_not_found');
  const preview = await f.preview({ project_id: f.alpha.project_id });
  assertProjectContext(preview.body, f);
  const search = await f.request('POST', '/v1/memories/query', { query: PROJECT_MARKER, project_id: f.alpha.project_id, limit: 20 }, f.readers[1]);
  assert.equal(search.status, 200);
  const expectedIds = [f.userMemory, ...f.memories].map(m => m.memory_id).sort();
  assert.deepEqual(search.body.results.map(m => m.memory_id).sort(), expectedIds);
  const detail = await f.request('GET', `/v1/memories/${f.userMemory.memory_id}`, undefined, f.readers[1]);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.memory, f.userMemory);
  for (const key of ['project_id', 'task_id', 'workstream_id', 'session_id']) assert.equal(detail.body.memory[key], null);
  assert.deepEqual(projectBusinessSnapshot(f.store), before);
});

test('project-only memory requires no Task and does not fabricate canonical progress or remaining work', async t => {
  const f = await projectMemoryFixture(t);
  const project_id = 'project-aster-empty';
  f.store.upsertProject(f.a.auth, { project_id, name: 'Empty Synthetic Project' });
  const emptySnapshot = projectBusinessSnapshot(f.store);
  const empty = await f.preview({ project_id });
  assert.equal(empty.body.status, 'project_context_preview');
  assert.deepEqual(empty.body.tasks, []);
  assert.deepEqual(empty.body.structured_memories, []);
  assert.deepEqual(projectBusinessSnapshot(f.store), emptySnapshot);
  const memory = await f.save(f.a, { scope: 'project', project_id, memory_type: 'fact', content: 'One synthetic fact is not a project plan.' });
  const before = projectBusinessSnapshot(f.store);
  const result = await f.preview({ project_id }, f.readers[1]);
  assert.equal(result.body.project.project_id, project_id);
  assert.deepEqual(result.body.tasks, []);
  assert.deepEqual(result.body.structured_memories.map(m => m.memory_id), [memory.memory_id]);
  assert.equal(result.body.structured_memories[0].memory_type, 'fact');
  assert.deepEqual(projectBusinessSnapshot(f.store), before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gatewayFixture } from './fixture.mjs';
import { projectMemoryFixture, projectBusinessSnapshot, assertProjectContext, PROJECT_MARKER } from '../../../server/test/helpers/project-memory-fixture.mjs';

async function fixture(t) {
  const core = await projectMemoryFixture(t);
  const f = await gatewayFixture(t, { profile: 'readonly', coreFixture: core, sharedOrigin: true, loopbackAuth: true });
  const token = (await f.exchange(await f.authorize())).data.access_token;
  assert.ok(token);
  const call = (name, args) => f.mcp('tools/call', { name, arguments: args }, token);
  return { core, f, token, call };
}

test('OAuth project context, search and full reads preserve two writers and distinguish shared user memory', async t => {
  const { core, f, token, call } = await fixture(t);
  const before = projectBusinessSnapshot(core.store);
  const list = await f.mcp('tools/list', undefined, token);
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.result.tools.map(tool => tool.name).sort(), [
    'mnemuron_auth_status', 'mnemuron_get_memory', 'mnemuron_preview_project_context', 'mnemuron_search_memories',
  ]);
  assert.ok(list.data.result.tools.every(tool => tool.annotations.readOnlyHint));
  for (const args of [{ project_id: core.alpha.project_id }, { query: PROJECT_MARKER }]) {
    const preview = await call('mnemuron_preview_project_context', args);
    assert.equal(preview.status, 200);
    assertProjectContext(preview.data.result.structuredContent, core);
  }
  const search = await call('mnemuron_search_memories', { query: PROJECT_MARKER, project_id: core.alpha.project_id, limit: 20 });
  assert.equal(search.status, 200);
  const expected = [core.userMemory, ...core.memories];
  assert.deepEqual(search.data.result.structuredContent.results.map(m => m.memory_id).sort(), expected.map(m => m.memory_id).sort());
  for (const memory of expected) {
    const detail = await call('mnemuron_get_memory', { memory_id: memory.memory_id });
    assert.equal(detail.status, 200);
    const body = detail.data.result.structuredContent;
    assert.deepEqual(body.memory, memory);
    assert.equal(body.content_complete, true);
    assert.equal(body.source_manifest.revision, 1);
    assert.equal(body.source_manifest.content_hash, createHash('sha256').update(memory.content).digest('hex'));
    assert.equal(body.source_manifest.sources.length, 1);
    assert.equal(body.source_manifest.sources[0].source_id, `explicit:${memory.memory_id}`);
    assert.equal(body.source_manifest.independently_fact_checked, false);
  }
  assert.equal((await call('mnemuron_get_memory', { memory_id: core.foreign.memory_id })).status, 404);
  const denied = await core.request('POST', '/v1/memories', { scope: 'user', content: 'Forbidden synthetic write' }, f.coreCredential);
  assert.equal(denied.status, 403);
  assert.deepEqual(projectBusinessSnapshot(core.store), before);
  const logs = JSON.stringify(f.gatewayLogs);
  assert.ok(!logs.includes(token));
  assert.ok(expected.every(memory => !logs.includes(memory.content)));
});

test('OAuth project previews follow corrections and retractions without losing history or changing Task state', async t => {
  const { core, call } = await fixture(t);
  const old = core.memories.find(m => m.memory_type === 'decision');
  const retracted = core.memories.find(m => m.memory_type === 'blocker');
  const taskBefore = core.store.db.prepare('SELECT * FROM tasks ORDER BY task_id').all();
  const correction = core.store.supersedeMemory(core.a.auth, old.memory_id, { content: `${PROJECT_MARKER}：Corrected synthetic decision` });
  core.store.retractMemory(core.b.auth, retracted.memory_id, { reason: 'Synthetic retraction' });
  const active = [...core.memories.filter(m => ![old.memory_id, retracted.memory_id].includes(m.memory_id)), correction.replacement_memory];
  const before = projectBusinessSnapshot(core.store);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await call('mnemuron_preview_project_context', { project_id: core.alpha.project_id });
    assert.equal(result.status, 200);
    assertProjectContext(result.data.result.structuredContent, core, active);
  }
  const search = await call('mnemuron_search_memories', { query: PROJECT_MARKER, project_id: core.alpha.project_id, limit: 20 });
  assert.equal(search.status, 200);
  assert.deepEqual(search.data.result.structuredContent.results.map(m => m.memory_id).sort(), [core.userMemory, ...active].map(m => m.memory_id).sort());
  for (const memory of [old, retracted]) {
    assert.equal((await call('mnemuron_get_memory', { memory_id: memory.memory_id })).status, 404);
    const history = await call('mnemuron_get_memory', { memory_id: memory.memory_id, include_history: true });
    assert.equal(history.status, 200);
    const body = history.data.result.structuredContent;
    assert.equal(body.memory.content, memory.content);
    assert.deepEqual(body.memory.provenance, memory.provenance);
    assert.equal(body.memory.status, memory === old ? 'superseded' : 'retracted');
    assert.equal(body.source_manifest.revision, 2);
    assert.equal(body.source_manifest.sources[0].source_id, `explicit:${memory.memory_id}`);
  }
  assert.deepEqual(core.store.db.prepare('SELECT * FROM tasks ORDER BY task_id').all(), taskBefore);
  assert.deepEqual(projectBusinessSnapshot(core.store), before);
});

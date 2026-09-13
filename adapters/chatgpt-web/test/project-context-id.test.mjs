import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayFixture } from './fixture.mjs';
import { memoryFixture, businessSnapshot } from '../../../server/test/helpers/core-memory-fixture.mjs';

test('OAuth project preview honors explicit IDs through the actual MCP and Core boundary', async t => {
  const core = await memoryFixture(t);
  const f = await gatewayFixture(t, { profile: 'readonly', coreFixture: core });
  const token = (await f.exchange(await f.authorize())).data.access_token;
  const before = businessSnapshot(core.store);
  const list = await f.mcp('tools/list', undefined, token);
  assert.equal(list.status, 200);
  assert.equal(list.data.result.tools.length, 4);
  const definition = list.data.result.tools.find(tool => tool.name === 'mnemuron_preview_project_context');
  assert.equal(definition.annotations.readOnlyHint, true);
  assert.equal(definition.inputSchema.required?.includes('query') ?? false, false);
  for (const args of [{ project_id: core.alpha.project_id }, { project_id: core.alpha.project_id, query: core.beta.project_id },
    { project_id: core.alpha.project_id, query: 'unrelated synthetic query' }, { query: core.alpha.project_id }]) {
    const result = await f.mcp('tools/call', { name: definition.name, arguments: args }, token);
    assert.equal(result.status, 200);
    const preview = result.data.result.structuredContent;
    assert.equal(preview.status, 'project_context_preview');
    assert.equal(preview.project.project_id, core.alpha.project_id);
    assert.equal(preview.read_only, true);
    for (const field of ['resume_created', 'task_scope_changed', 'context_injected']) assert.equal(preview.safety[field], false);
  }
  for (const project_id of [core.foreign.project_id, 'project-unknown']) {
    const result = await f.mcp('tools/call', { name: definition.name, arguments: { project_id, query: core.alpha.project_id } }, token);
    assert.equal(result.status, 200);
    assert.equal(result.data.result.structuredContent.status, 'no_match');
    assert.deepEqual(result.data.result.structuredContent.candidates, []);
  }
  for (const args of [{}, { query: ' ' }, { project_id: '' }, { project_id: null }, { project_id: core.alpha.project_id, user_id: core.other.auth.user_id }]) {
    assert.equal((await f.mcp('tools/call', { name: definition.name, arguments: args }, token)).status, 400);
  }
  assert.deepEqual(businessSnapshot(core.store), before);
});

test('OAuth searches a bare synthetic marker and reads its full memory without business writes', async t => {
  const core = await memoryFixture(t);
  const f = await gatewayFixture(t, { profile: 'readonly', coreFixture: core });
  const token = (await f.exchange(await f.authorize())).data.access_token;
  const marker = 'CASE-20400101-04';
  const memory = core.store.saveMemory(core.a.auth, { scope: 'project', project_id: core.alpha.project_id,
    content: `${marker}：Memory synthetic cross-client read check` }).memory;
  core.store.saveMemory(core.other.auth, { scope: 'project', project_id: core.foreign.project_id, content: `${marker}：Memory foreign` });
  const before = businessSnapshot(core.store);
  const search = await f.mcp('tools/call', { name: 'mnemuron_search_memories', arguments: { query: marker, project_id: core.alpha.project_id } }, token);
  assert.equal(search.status, 200);
  assert.deepEqual(search.data.result.structuredContent.results.map(item => item.memory_id), [memory.memory_id]);
  const detail = await f.mcp('tools/call', { name: 'mnemuron_get_memory', arguments: { memory_id: memory.memory_id } }, token);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.result.structuredContent.memory.content, memory.content);
  assert.equal(detail.data.result.structuredContent.content_complete, true);
  assert.deepEqual(businessSnapshot(core.store), before);
});

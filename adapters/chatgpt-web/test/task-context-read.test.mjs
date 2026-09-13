import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayFixture } from './fixture.mjs';
import { memoryFixture } from '../../../server/test/helpers/core-memory-fixture.mjs';
import { projectBusinessSnapshot } from '../../../server/test/helpers/project-memory-fixture.mjs';
import { prepareTool } from '../src/tools.mjs';

async function fixture(t) {
  const core = await memoryFixture(t);
  const task = { ...core.alpha, goal: '已记录🙂\n'.repeat(180), progress: Array.from({ length: 9 }, (_, i) => `${i}: ${'Synthetic step '.repeat(80)}`),
    decisions: Array(6).fill('Synthetic decision '.repeat(100)), next_steps: ['Next recorded step'], blockers: [] };
  core.store.upsertTask(core.a.auth, task);
  const f = await gatewayFixture(t, { profile: 'readonly', coreFixture: core, sharedOrigin: true, loopbackAuth: true,
    mutate: config => { config.limits.tool_response_bytes = 8192; } });
  const token = (await f.exchange(await f.authorize())).data.access_token;
  const call = args => f.mcp('tools/call', { name: 'mnemuron_preview_project_context', arguments: args }, token);
  return { core, task, f, token, call };
}

test('OAuth summary discloses omitted canonical fields and reads exact Task pages through the same four tools', async t => {
  const { core, task, f, token, call } = await fixture(t);
  const before = projectBusinessSnapshot(core.store);
  const list = await f.mcp('tools/list', undefined, token);
  assert.equal(list.data.result.tools.length, 4);
  const definition = list.data.result.tools.find(tool => tool.name === 'mnemuron_preview_project_context');
  assert.equal(definition.annotations.readOnlyHint, true);
  assert.deepEqual(definition._meta.securitySchemes, [{ type: 'oauth2', scopes: ['project:read'] }]);
  assert.ok(definition.inputSchema.properties.task_id);
  const summary = await call({ project_id: core.alpha.project_id });
  assert.equal(summary.status, 200);
  const preview = summary.data.result.structuredContent;
  assert.equal(preview.projection.gateway_summary_only, true);
  const entry = preview.tasks[0];
  assert.deepEqual(entry.field_availability.goal, { recorded: true, item_count: 1, returned: 'omitted' });
  assert.deepEqual(entry.field_availability.blockers, { recorded: false, item_count: 0, returned: 'omitted' });
  assert.equal(preview.task_detail_action.tool, 'mnemuron_preview_project_context');
  let args = { ...entry.detail_request, task_field: 'goal', content_limit: 64 }, body = '', calls = 0;
  do {
    const response = await call(args);
    assert.equal(response.status, 200);
    assert.ok(Buffer.byteLength(JSON.stringify(response.data)) <= 8192);
    const detail = response.data.result.structuredContent;
    body += detail.content; args = detail.next_request;
    assert.equal(detail.source.kind, 'canonical_task');
    assert.equal(detail.source.canonical_version, entry.canonical_version);
    assert.ok(++calls < 40);
  } while (args);
  assert.equal(body, task.goal);
  const omittedListItem = await call({ ...entry.detail_request, task_field: 'progress', item_offset: 8, content_limit: 8192 });
  assert.equal(omittedListItem.status, 200);
  assert.equal(omittedListItem.data.result.structuredContent.content, task.progress[8]);
  const empty = await call({ ...entry.detail_request, task_field: 'blockers' });
  assert.equal(empty.data.result.structuredContent.field_availability.blockers.recorded, false);
  assert.equal(empty.data.result.structuredContent.item_count, 0);
  assert.equal(empty.data.result.structuredContent.next_request, null);
  assert.deepEqual(projectBusinessSnapshot(core.store), before);
  const logs = JSON.stringify(f.gatewayLogs);
  assert.ok(!logs.includes(token) && !logs.includes(task.goal));
});

test('OAuth Task reads preserve version errors, exact ownership, validation and no writes', async t => {
  const { core, task, f, call } = await fixture(t);
  const target = { project_id: core.alpha.project_id, task_id: core.alpha.task_id };
  const first = await call({ ...target, content_limit: 10 });
  core.store.upsertTask(core.a.auth, { ...task, goal: 'New canonical goal' });
  const before = projectBusinessSnapshot(core.store);
  const stale = await call(first.data.result.structuredContent.next_request);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error_code, 'TASK_VERSION_CHANGED');
  for (const patch of [{ project_id: core.foreign.project_id, task_id: core.foreign.task_id }, { task_id: core.beta.task_id }, { task_id: 'task-missing' }]) {
    const response = await call({ ...target, ...patch });
    assert.equal(response.status, 404);
    assert.equal(response.data.error_code, 'TASK_CONTEXT_NOT_FOUND');
  }
  for (const args of [{ ...target, user_id: core.other.auth.user_id }, { ...target, content_offset: 1 },
    { project_id: core.alpha.project_id, task_field: 'goal' }, { query: core.alpha.project_id, task_id: core.alpha.task_id },
    { ...target, task_field: 'checkpoint_details' }, { ...target, content_limit: 8193 }]) assert.equal((await call(args)).status, 400);
  assert.equal((await core.request('POST', '/v1/tasks', task, f.coreCredential)).status, 403);
  assert.deepEqual(projectBusinessSnapshot(core.store), before);
});

test('new gateway does not mislabel an old Core project response as Task details', async () => {
  const context = { config: { tool_profile: 'readonly', limits: { tool_response_bytes: 8192 } }, auth: { scopes: new Set(['project:read']) },
    core: { call: async () => ({ status: 'project_context_preview', read_only: true, tasks: [] }) }, id: 1 };
  await assert.rejects(prepareTool('mnemuron_preview_project_context', { project_id: 'project-example', task_id: 'task-example' }, context),
    error => error.status === 503 && error.code === 'TASK_DETAIL_UNAVAILABLE');
});

test('Task detail rejects a mismatched Core target and cannot silently fall back to a summary on size overflow', async () => {
  const args = { project_id: 'project-example', task_id: 'task-example', canonical_version: 2 };
  const result = { status: 'task_context_detail', read_only: true, task: { ...args, canonical_version: 2 }, content: 'x'.repeat(20000) };
  const context = { config: { tool_profile: 'readonly', limits: { tool_response_bytes: 8192 } }, auth: { scopes: new Set(['project:read']) },
    core: { call: async () => result }, id: 1 };
  await assert.rejects(prepareTool('mnemuron_preview_project_context', args, context), error => error.code === 'TOOL_RESPONSE_TOO_LARGE');
  for (const patch of [{ project_id: 'project-other' }, { task_id: 'task-other' }, { canonical_version: 3 }]) {
    context.core.call = async () => ({ ...result, task: { ...result.task, ...patch } });
    await assert.rejects(prepareTool('mnemuron_preview_project_context', args, context), error => error.code === 'CORE_RESPONSE_INVALID');
  }
});

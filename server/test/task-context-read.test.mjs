import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectMemoryFixture, projectBusinessSnapshot } from './helpers/project-memory-fixture.mjs';
import { TASK_READ_FIELDS, taskFieldAvailability } from '../../shared/task-read-contract.mjs';
import { HandoffPolicy } from '../lib/handoff-policy.mjs';

const request = (f, extra = {}) => ({ project_id: f.alpha.project_id, task_id: f.alpha.task_id, ...extra });

test('Task field metadata distinguishes absent, truncated, omitted and unknown records', async t => {
  const f = await projectMemoryFixture(t);
  const task = { ...f.task, goal: 'Synthetic long goal '.repeat(80), progress: Array.from({ length: 7 }, (_, i) => `Step ${i}`), blockers: [] };
  f.store.upsertTask(f.a.auth, task);
  const before = projectBusinessSnapshot(f.store);
  const result = await f.preview({ project_id: f.alpha.project_id });
  const data = result.body.tasks[0];
  assert.deepEqual(data.field_availability.goal, { recorded: true, item_count: 1, returned: 'partial' });
  assert.deepEqual(data.field_availability.progress, { recorded: true, item_count: 7, returned: 'partial' });
  assert.deepEqual(data.field_availability.blockers, { recorded: false, item_count: 0, returned: 'full' });
  const summary = taskFieldAvailability(data, {});
  assert.deepEqual(summary.goal, { recorded: true, item_count: 1, returned: 'omitted' });
  assert.deepEqual(summary.blockers, { recorded: false, item_count: 0, returned: 'omitted' });
  assert.deepEqual(taskFieldAvailability({}, {}).goal, { recorded: null, item_count: null, returned: 'omitted' });
  assert.equal(result.body.read_capabilities.task_field_details, true);
  assert.deepEqual(data.detail_request, request(f, { canonical_version: data.canonical_version }));
  assert.deepEqual(projectBusinessSnapshot(f.store), before);
});

test('Task field pages preserve exact Unicode, all list items, JSON values and canonical provenance', async t => {
  const f = await projectMemoryFixture(t);
  const task = { ...f.task, goal: '  精确🙂\n目标\t'.repeat(50), progress: ['first\n🙂'.repeat(30), '', { text: '结构化条目', refs: ['synthetic'] }, ...Array.from({ length: 6 }, (_, i) => `Step ${i}`)], blockers: [], resources: [], conflicts: [] };
  f.store.upsertTask(f.a.auth, task);
  const before = projectBusinessSnapshot(f.store);
  for (const field of TASK_READ_FIELDS) {
    let args = request(f, { task_field: field, content_limit: 19 }), pages = 0, version;
    const items = [], formats = [];
    do {
      const result = await f.preview(args, f.readers[1]);
      assert.equal(result.status, 200);
      const data = result.body;
      assert.equal(data.status, 'task_context_detail');
      assert.equal(data.source.kind, 'canonical_task');
      version ??= data.task.canonical_version;
      assert.equal(data.source.canonical_version, version);
      assert.equal(data.content_length_unit, 'unicode_code_points');
      assert.ok(Array.from(data.content).length <= 19);
      assert.equal(data.field_hash, createHash('sha256').update(JSON.stringify(task[field] ?? null)).digest('hex'));
      if (data.item_count) {
        items[data.item_offset] = (items[data.item_offset] || '') + data.content;
        formats[data.item_offset] = data.content_format;
      }
      args = data.next_request;
      assert.equal(data.field_complete, args === null);
      assert.ok(++pages < 200);
    } while (args);
    const decoded = items.map((text, i) => formats[i] === 'json' ? JSON.parse(text) : text);
    assert.deepEqual(Array.isArray(task[field]) ? decoded : decoded[0], task[field]);
  }
  assert.deepEqual(projectBusinessSnapshot(f.store), before);
});

test('Task continuation pins canonical version and rejects mixed-version reassembly', async t => {
  const f = await projectMemoryFixture(t);
  const first = await f.preview(request(f, { content_limit: 2 }));
  assert.ok(first.body.next_request);
  const unpinned = { ...first.body.next_request }; delete unpinned.canonical_version;
  assert.equal((await f.preview(unpinned)).body.error_code, 'TASK_VERSION_REQUIRED');
  f.store.upsertTask(f.a.auth, { ...f.task, goal: 'Updated synthetic goal' });
  const before = projectBusinessSnapshot(f.store);
  const stale = await f.preview(first.body.next_request);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error_code, 'TASK_VERSION_CHANGED');
  const fresh = await f.preview(request(f));
  assert.equal(fresh.body.content, 'Updated synthetic goal');
  assert.equal(fresh.body.task.canonical_version, first.body.task.canonical_version + 1);
  assert.deepEqual(projectBusinessSnapshot(f.store), before);
});

test('Task detail fails closed for wrong project, foreign owner, malformed paging and unauthorized readers', async t => {
  const f = await projectMemoryFixture(t), before = projectBusinessSnapshot(f.store);
  const foreignTask = f.store.listTasks(f.other.auth.user_id)[0];
  for (const args of [request(f, { project_id: f.beta.project_id }), request(f, { task_id: f.beta.task_id }),
    { project_id: foreignTask.project_id, task_id: foreignTask.task_id }, request(f, { task_id: 'task-unknown', query: f.alpha.project_id })]) {
    const response = await f.preview(args);
    assert.equal(response.status, 404);
    assert.equal(response.body.error_code, 'TASK_CONTEXT_NOT_FOUND');
  }
  for (const extra of [{ item_offset: -1 }, { item_offset: 999, canonical_version: 2 }, { content_offset: 9999, canonical_version: 2 },
    { content_limit: 8193 }, { content_limit: 0 }, { content_limit: null }, { canonical_version: 0 },
    { canonical_version: null }, { task_field: 'raw_payload' }, { task_field: null }, { user_id: f.other.auth.user_id },
    { project_id: null }, { task_id: [] }, { task_id: '../task' }, { signals: { project_id: f.beta.project_id } }]) {
    assert.equal((await f.preview(request(f, extra))).status, 400, JSON.stringify(extra));
  }
  for (const args of [{ project_id: f.alpha.project_id, task_field: 'goal' }, { query: f.alpha.project_id, task_id: f.alpha.task_id }]) {
    assert.equal((await f.preview(args)).status, 400);
  }
  assert.equal((await f.request('POST', '/v1/project-context/preview', request(f), f.a)).status, 403);
  assert.deepEqual(projectBusinessSnapshot(f.store), before);
});

test('Task details stay read-only when new handoff operations are disabled', async t => {
  const f = await projectMemoryFixture(t);
  new HandoffPolicy(f.store.db, { legacy: false, handoff: false });
  assert.equal(f.store.handoffPolicy.enabled(), false);
  const before = projectBusinessSnapshot(f.store);
  assert.equal((await f.preview(request(f))).body.content, f.task.goal);
  assert.deepEqual(projectBusinessSnapshot(f.store), before);
  assert.equal(f.store.handoffPolicy.enabled(), false);
});

test('Core second-stage compaction retains authoritative field presence and offers unabridged reads', async t => {
  const f = await projectMemoryFixture(t);
  for (let n = 0; n < 4; n++) f.store.upsertTask(f.a.auth, { ...f.task, task_id: `task-compaction-${n}`,
    goal: 'Synthetic goal '.repeat(100), progress: Array(8).fill('Synthetic progress '.repeat(30)) });
  const original = f.store.latestCheckpoints;
  f.store.latestCheckpoints = () => Array.from({ length: 5 }, (_, i) => ({
    checkpoint_id: `checkpoint-synthetic-${i}`, workstream_id: 'synthetic-branch', created_at: '2040-01-01T00:00:00Z',
    completed_items: Array(3).fill('x'.repeat(240)), decisions: Array(3).fill('y'.repeat(240)),
    blockers: Array(3).fill('z'.repeat(240)), unfinished_items: Array(3).fill('u'.repeat(240)),
    recommended_next_steps: Array(3).fill('n'.repeat(240)),
    generation: { warnings: Array(5).fill('w'.repeat(240)) }, source_event_ids: Array(20).fill('s'.repeat(120)),
  }));
  t.after(() => { f.store.latestCheckpoints = original; });
  const before = projectBusinessSnapshot(f.store);
  const response = await f.preview({ project_id: f.alpha.project_id });
  assert.equal(response.status, 200);
  assert.equal(response.body.projection.fallback_compaction_applied, true);
  const task = response.body.tasks.find(task => task.task_id === 'task-compaction-0');
  assert.deepEqual(task.field_availability.progress, { recorded: true, item_count: 8, returned: 'partial' });
  assert.ok(Buffer.byteLength(JSON.stringify(response.body)) <= 128 * 1024);
  assert.equal((await f.preview({ ...task.detail_request, task_field: 'progress', item_offset: 7 })).body.content, 'Synthetic progress '.repeat(30));
  assert.deepEqual(projectBusinessSnapshot(f.store), before);
});

test('Task detail enforces a response ceiling for legacy oversized metadata', async t => {
  const f = await projectMemoryFixture(t);
  f.store.upsertTask(f.a.auth, { ...f.task, status: 'x'.repeat(70000) });
  const before = projectBusinessSnapshot(f.store);
  const response = await f.preview(request(f));
  assert.equal(response.status, 422);
  assert.equal(response.body.error_code, 'TASK_DETAIL_TOO_LARGE');
  assert.deepEqual(projectBusinessSnapshot(f.store), before);
});

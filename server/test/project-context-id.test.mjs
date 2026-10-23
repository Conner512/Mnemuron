import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryFixture, businessSnapshot } from './helpers/core-memory-fixture.mjs';

async function fixture(t) {
  const f = await memoryFixture(t);
  const reader = f.store.issueCredential({ label: 'synthetic-project-reader', userId: f.a.auth.user_id,
    deviceId: 'device-reader', agentId: 'test', agentInstanceId: 'agent-reader', scopes: ['resume:read'] });
  return { ...f, preview: body => f.request('POST', '/v1/project-context/preview', body, reader) };
}

test('project preview locks an explicit ID independently of query and preserves legacy signals', async t => {
  const f = await fixture(t), before = businessSnapshot(f.store);
  for (const body of [
    { project_id: f.alpha.project_id, query: 'unrelated-synthetic-query' },
    { project_id: f.alpha.project_id, query: f.beta.project_id },
    { project_id: f.alpha.project_id },
    { signals: { project_id: f.alpha.project_id }, query: f.beta.project_id },
    { signals: { project_id: f.alpha.project_id } },
    { project_id: f.alpha.project_id, signals: { project_id: f.alpha.project_id } },
  ]) {
    const original = structuredClone(body), result = await f.preview(body);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'project_context_preview');
    assert.equal(result.body.project.project_id, f.alpha.project_id);
    assert.equal(result.body.resolution.confidence, 'high');
    assert.equal(result.body.read_only, true);
    for (const field of ['resume_created', 'task_scope_changed', 'context_injected']) assert.equal(result.body.safety[field], false);
    assert.deepEqual(body, original);
  }
  assert.deepEqual(businessSnapshot(f.store), before);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM resolver_selections').get().n, 0);
});

test('project preview rejects conflicting or malformed IDs and never falls back from foreign or unknown IDs', async t => {
  const f = await fixture(t);
  const conflict = await f.preview({ project_id: f.alpha.project_id, signals: { project_id: f.beta.project_id }, query: f.alpha.project_id });
  assert.equal(conflict.status, 400);
  assert.equal(conflict.body.error_code, 'CONFLICTING_PROJECT_ID');
  for (const project_id of ['', ' ', null, [], {}, 1, 'project/invalid', 'a'.repeat(129)]) {
    assert.equal((await f.preview({ project_id, query: f.alpha.project_id })).status, 400);
  }
  for (const body of [{}, { query: '' }, { signals: { cwd: '/synthetic/project' } }, { project_id: f.alpha.project_id, query: 42 }]) {
    assert.equal((await f.preview(body)).status, 400);
  }
  for (const project_id of [f.foreign.project_id, 'project-unknown']) {
    for (const body of [{ project_id }, { project_id, query: f.alpha.project_id }, { signals: { project_id }, query: f.alpha.project_id }]) {
      const result = await f.preview(body);
      assert.equal(result.status, 200);
      assert.equal(result.body.status, 'no_match');
      assert.equal(result.body.reason, 'explicit_identifier_not_found');
      assert.equal(result.body.project, undefined);
      assert.deepEqual(result.body.candidates, []);
    }
  }
});

test('query-only project previews keep exact-name confidence and ambiguous phrase thresholds', async t => {
  const f = await fixture(t);
  f.store.upsertProject(f.a.auth, { project_id: f.alpha.project_id, name: 'Aster Synthetic', aliases: ['星图测试'] });
  for (const query of ['Aster Synthetic', '星图测试', f.alpha.project_id]) {
    const result = await f.preview({ query });
    assert.equal(result.body.status, 'project_context_preview');
    assert.equal(result.body.project.project_id, f.alpha.project_id);
  }
  const phrase = await f.preview({ query: 'check Aster Synthetic project' });
  assert.equal(phrase.body.status, 'ambiguous');
  assert.equal(phrase.body.reason, 'candidate_confidence_too_low');
});

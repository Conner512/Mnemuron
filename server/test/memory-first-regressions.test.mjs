import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryFixture } from './helpers/core-memory-fixture.mjs';
import { scanPublicationFile } from '../../scripts/check-publication.mjs';

test('P-09..11: publication rejects synthetic project/model secrets and ordinary memory exports', () => {
  for (const [file, content] of [
    ['config/runtime.example.json', JSON.stringify({ api_key: 'mnm_' + 'x'.repeat(43) })],
    ['config/runtime.example.json', JSON.stringify({ api_key: 'sk-' + 'x'.repeat(48) })],
    ['exports/memories.json', JSON.stringify({ memories: [{ content: 'Synthetic fixture only.' }] })],
    ['vectors/data.snapshot', 'synthetic snapshot'],
  ]) assert.ok(scanPublicationFile(file, content).length, file);
});

test('D-03: punctuation-distinct version facts survive full ingestion and legacy checkpoint replay', async t => {
  const f = await memoryFixture(t);
  const events = ['1.2.3', '1-2-3'].map((version, i) => ({
    event_id: 'version-fact-' + i, event_type: 'assistant_message',
    project_id: f.alpha.project_id, task_id: f.alpha.task_id,
    workstream_id: f.alpha.task_id + '-one', session_id: 'session-version-test',
    content: '事实：设备版本：' + version,
  }));
  f.store.appendEvents(f.a.auth, { events });
  const rows = f.store.db.prepare('SELECT content FROM memories ORDER BY content').all();
  assert.deepEqual(rows.map(r => r.content), ['设备版本：1-2-3', '设备版本：1.2.3']);
  f.store.appendEvents(f.a.auth, { events });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 2);
});

test('D-03: correction retry cannot silently equate different punctuation', async t => {
  const f = await memoryFixture(t);
  const saved = f.store.saveMemory(f.a.auth, { content: 'initial version', scope: 'user' });
  f.store.supersedeMemory(f.a.auth, saved.memory.memory_id, { content: 'version 1.2.3' });
  assert.throws(() => f.store.supersedeMemory(f.a.auth, saved.memory.memory_id, { content: 'version 1-2-3' }), e => e.statusCode === 409);
});

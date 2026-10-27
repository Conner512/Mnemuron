import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { memoryFixture } from '../../../server/test/helpers/core-memory-fixture.mjs';
import { callTool, TOOLS } from '../scripts/mcp-core.mjs';

function remoteEnv(f, owner = f.a) {
  return {
    MNEMURON_MODE: 'remote', MNEMURON_SERVER_URL: f.baseUrl, MNEMURON_ALLOW_INSECURE_HTTP: 'true',
    MNEMURON_API_KEY: owner.api_key, MNEMURON_CONFIG_PATH: path.join(f.root, 'no-config.json'),
    MNEMURON_SPIKE_DATA_DIR: path.join(f.root, owner.auth.agent_instance_id),
    MNEMURON_DEVICE_ID: owner.auth.device_id, MNEMURON_AGENT_ID: owner.auth.agent_id,
    MNEMURON_AGENT_INSTANCE_ID: owner.auth.agent_instance_id,
  };
}

test('post-save hint guidance preserves the original and retracts only the explicitly selected redundant save', async t => {
  const f = await memoryFixture(t), env = remoteEnv(f);
  const guidance = TOOLS.find(tool => tool.name === 'mnemuron_remember').description;
  assert.match(guidance, /successful save is already committed/);
  assert.match(guidance, /current user explicitly requests cleanup/);
  assert.match(guidance, /retract the newly saved memory\.memory_id/);
  assert.match(guidance, /Do not supersede a hinted memory/);

  const input = { scope: 'user', content: 'Synthetic duplicate: backups run nightly.', kind: 'workflow', concepts: ['backups'], strength: 8 };
  const first = await callTool('mnemuron_remember', { ...input, operation_id: 'original-save' }, env);
  const original = f.store.memoryDetail(f.a.auth, first.memory.memory_id);
  const second = await callTool('mnemuron_remember', { ...input, operation_id: 'redundant-save' }, env);
  assert.equal(second.similar_memories[0].memory_id, first.memory.memory_id);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM memories WHERE status='active'").get().n, 2,
    'an advisory hint alone does not mutate either committed save');

  // A different account cannot perform the cleanup, even when it knows the returned ID.
  await assert.rejects(callTool('mnemuron_retract_memory', {
    memory_id: second.memory.memory_id, reason: 'Synthetic explicit duplicate cleanup',
  }, remoteEnv(f, f.other)), /MEMORY_NOT_FOUND/);
  assert.equal(f.store.memoryDetail(f.a.auth, second.memory.memory_id).memory.status, 'active');

  const cleaned = await callTool('mnemuron_retract_memory', {
    memory_id: second.memory.memory_id, reason: 'Synthetic explicit duplicate cleanup',
  }, env);
  assert.equal(cleaned.status, 'retracted');
  assert.equal(cleaned.physically_deleted, false);
  assert.deepEqual(f.store.memoryDetail(f.a.auth, first.memory.memory_id).memory, original.memory,
    'the existing record and its traits/provenance are unchanged');
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM memories WHERE status='active'").get().n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM memories').get().n, 2, 'cleanup never creates a third record');

  const retry = await callTool('mnemuron_remember', { ...input, operation_id: 'redundant-save' }, env);
  assert.equal(retry.idempotent, true);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM memories WHERE status='active'").get().n, 1,
    'an uncertain-save retry cannot resurrect the retracted duplicate');
});

test('the advised correction workflow searches then supersedes without an extra save', async t => {
  const f = await memoryFixture(t), env = remoteEnv(f);
  const first = await callTool('mnemuron_remember', {
    scope: 'user', content: 'Synthetic correction: backups run at 03:00.', operation_id: 'correction-original',
  }, env);
  const found = await callTool('mnemuron_search_memories', { query: 'Synthetic correction backups', mode: 'lexical' }, env);
  assert.equal(found.results[0].memory_id, first.memory.memory_id);
  const corrected = await callTool('mnemuron_supersede_memory', {
    memory_id: found.results[0].memory_id, content: 'Synthetic correction: backups run at 04:00.', reason: 'Synthetic explicit correction',
  }, env);
  assert.equal(corrected.replacement_memory.lifecycle.supersedes_memory_id, first.memory.memory_id);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM memories WHERE status='active'").get().n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM memories').get().n, 2);
});

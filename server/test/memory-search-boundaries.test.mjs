import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryFixture, businessSnapshot } from './helpers/core-memory-fixture.mjs';
import { INDEX_VERSION, MemorySearch, normalizeSearch, searchTokens } from '../lib/memory-retrieval.mjs';

// Frozen v2 projection for upgrade coverage, not a second production tokenizer.
function v2Tokens(value) {
  const tokens = new Set();
  for (const segment of normalizeSearch(value).split(/(\p{Script=Han}+)/u)) {
    if (/^\p{Script=Han}/u.test(segment)) {
      const chars = Array.from(segment);
      chars.forEach((char, i) => { tokens.add(char); if (chars[i + 1]) tokens.add(char + chars[i + 1]); });
    } else for (const word of segment.match(/[\p{L}\p{N}]+(?:[._:/-][\p{L}\p{N}]+)*/gu) || []) tokens.add(word);
  }
  for (const symbol of normalizeSearch(value).match(/\p{S}/gu) || []) tokens.add(symbol);
  return [...tokens].map(token => 't' + Buffer.from(token).toString('hex')).join(' ');
}

test('colon boundaries expose standalone markers without discarding compound engineering tokens', () => {
  for (const colon of [':', '：']) {
    const tokens = searchTokens(`CASE-20400101-01${colon}Memory`);
    assert.ok(tokens.includes('case-20400101-01'));
    assert.ok(tokens.includes('memory'));
    assert.ok(tokens.includes('case-20400101-01:memory'));
  }
  for (const identifier of ['1.2.3', '1-2-3', '192.0.2.10', 'C9800-CL', 'module/file.mjs', '2001:db8::1']) {
    for (const token of v2Tokens(identifier).split(' ')) {
      assert.ok(searchTokens(identifier).some(value => 't' + Buffer.from(value).toString('hex') === token), identifier);
    }
  }
  assert.notDeepEqual(searchTokens('1.2.3'), searchTokens('1-2-3'));
});

test('bare markers adjacent to colons are retrievable with owner, project and lifecycle isolation', async t => {
  const f = await memoryFixture(t);
  for (const [index, colon] of [':', '：'].entries()) {
    const marker = `CASE-20400101-0${index + 1}`;
    const saved = f.store.saveMemory(f.a.auth, { scope: 'project', project_id: f.alpha.project_id, content: `${marker}${colon}Memory synthetic read check` }).memory;
    f.store.saveMemory(f.other.auth, { scope: 'project', project_id: f.foreign.project_id, content: `${marker}${colon}Memory foreign record` });
    const result = f.store.queryMemories(f.b.auth, { query: marker, project_id: f.alpha.project_id });
    assert.deepEqual(result.results.map(item => item.memory_id), [saved.memory_id]);
    assert.equal(f.store.memoryDetail(f.b.auth, saved.memory_id).memory.content, saved.content);
    assert.equal(f.store.queryMemories(f.b.auth, { query: marker, project_id: f.beta.project_id }).results.length, 0);
    f.store.retractMemory(f.a.auth, saved.memory_id, {});
    assert.equal(f.store.queryMemories(f.b.auth, { query: marker }).results.length, 0);
    assert.equal(f.store.queryMemories(f.b.auth, { query: marker, statuses: ['retracted'] }).results[0].memory_id, saved.memory_id);
  }
});

test('v2 token projection upgrades to v3 without changing source records, revisions or document IDs', async t => {
  const f = await memoryFixture(t);
  const memory = f.store.saveMemory(f.a.auth, { scope: 'user', content: 'CASE-20400101-03：Memory synthetic migration' }).memory;
  f.store.db.function('memory_search_tokens', { deterministic: true }, v2Tokens);
  f.store.db.exec("UPDATE memories SET content=content; UPDATE memory_search_state SET version='memory-search-v2',state='ready'");
  const before = businessSnapshot(f.store);
  const sourceSnapshot = () => Object.fromEntries(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'memory_%' OR name LIKE 'source_%') AND name NOT LIKE 'memory_search_%' ORDER BY name").all()
    .map(({ name }) => [name, f.store.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  const sources = sourceSnapshot();
  const docs = f.store.db.prepare('SELECT doc_id,memory_id FROM memory_search_docs ORDER BY doc_id').all();
  const old = f.store.db.prepare('SELECT tokens FROM memory_search_docs WHERE memory_id=?').get(memory.memory_id).tokens;
  assert.equal(old.includes('t' + Buffer.from('case-20400101-03').toString('hex') + ' '), false);
  f.store.memorySearch = new MemorySearch(f.store.db);
  assert.equal(INDEX_VERSION, 'memory-search-v3');
  assert.equal(f.store.memorySearch.status().state, 'ready');
  assert.equal(f.store.queryMemories(f.a.auth, { query: 'CASE-20400101-03' }).results[0]?.memory_id, memory.memory_id);
  assert.deepEqual(businessSnapshot(f.store), before);
  assert.deepEqual(sourceSnapshot(), sources);
  assert.deepEqual(f.store.db.prepare('SELECT doc_id,memory_id FROM memory_search_docs ORDER BY doc_id').all(), docs);
  const current = f.store.db.prepare('SELECT * FROM memory_search_docs ORDER BY doc_id').all();
  f.store.memorySearch = new MemorySearch(f.store.db);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM memory_search_docs ORDER BY doc_id').all(), current);
});

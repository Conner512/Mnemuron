import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryFixture, businessSnapshot, assertCode } from './helpers/core-memory-fixture.mjs';
import { INDEX_VERSION, MemorySearch, normalizeSearch } from '../lib/memory-retrieval.mjs';
import { MnemuronStore } from '../lib/store.mjs';

const pairs = [
  ['设备型号为C9800-CL', 'C9800-CL'], ['设备型号为 C9800-CL', 'C9800-CL'],
  ['数据库使用SQLite', 'SQLite'], ['数据库使用 SQLite', 'SQLite'], ['当前版本是17.9.8', '17.9.8'],
  ['当前版本是17.98', '17.98'], ['序列号FDO1234ABCD', 'FDO1234ABCD'],
  ['序列号FDO1234ABCE', 'FDO1234ABCE'], ['部署CUCM语音系统', 'CUCM'],
  ['管理地址为192.0.2.10', '192.0.2.10'], ['管理地址为192.0.2.11', '192.0.2.11'],
  ['授权许可已启用', '许可'], ['部署语音系统', '语音'], ['部署语音系统', '音'], ['序列号ＦＤＯ１２３４ＡＢＣＤ', 'FDO1234ABCD'],
];

test('REV-01/02 mixed-script Store and REST recall survives newer noise and excludes foreign scope', async t => {
  const f = await memoryFixture(t);
  const targets = pairs.map(([content, query]) => ({query, memory: f.store.saveMemory(f.a.auth, {content, scope:'task', task_id:f.alpha.task_id}).memory}));
  const forbidden = [f.store.saveMemory(f.a.auth, {content:pairs.map(p=>p[0]).join('；'),scope:'task',task_id:f.beta.task_id}).memory.memory_id,
    f.store.saveMemory(f.other.auth, {content:pairs.map(p=>p[0]).join('；'),scope:'task',task_id:f.foreign.task_id}).memory.memory_id];
  f.store.db.exec('BEGIN');
  for (let i=0;i<650;i++) f.store.saveMemory(f.a.auth,{content:`更新噪声noise-${i}`,scope:'task',task_id:f.alpha.task_id});
  f.store.db.exec('COMMIT');
  const before = businessSnapshot(f.store);
  for (const {query,memory} of targets) {
    for (const scope of [{task_id:f.alpha.task_id},{project_id:f.alpha.project_id}]) {
      const spec = {query, ...scope, limit:20};
      const local = f.store.queryMemories(f.b.auth,spec);
      const remote = await f.request('POST','/v1/memories/query',spec,f.b);
      assert.equal(remote.status,200);
      for (const result of [local,remote.body]) {
        assert.ok(result.results.some(m=>m.memory_id===memory.memory_id), `${query}: missing ${memory.content}`);
        assert.ok(result.results.every(m=>!forbidden.includes(m.memory_id)));
        assert.ok(result.results.every(m=>m.content.normalize('NFKC').toLowerCase().includes(query.toLowerCase())), `${query}: near identifier matched`);
        assert.equal(result.retrieval.index_version,INDEX_VERSION);
      }
    }
    assert.equal(f.store.memoryDetail(f.a.auth,memory.memory_id).memory.content,memory.content);
  }
  assert.deepEqual(businessSnapshot(f.store),before);
});

test('REV-01 mixed-script derived memories retain provenance and lifecycle search behavior', async t => {
  const f = await memoryFixture(t);
  const base = {project_id:f.alpha.project_id,task_id:f.alpha.task_id,workstream_id:f.alpha.workstreams[0].workstream_id,session_id:'review-derived'};
  const events = [
    {...base,event_id:'review-derived-user',event_type:'user_message',captured_at:'2026-09-01T00:00:00Z',content:'决定：数据库使用SQLite'},
    {...base,event_id:'review-derived-stop',event_type:'assistant_message',hook_event_name:'Stop',captured_at:'2026-09-01T00:01:00Z',content:'已完成：部署CUCM语音系统'},
  ];
  const result = f.store.appendEvents(f.a.auth,{events});
  assert.ok(result.checkpoints[0].structured_memories.created > 0);
  for (const query of ['SQLite','CUCM']) {
    const remote = await f.request('POST','/v1/memories/query',{query,task_id:f.alpha.task_id});
    assert.equal(remote.status,200);
    assert.ok(remote.body.results.some(m=>m.source==='checkpoint_derived'),query);
  }
  const original = f.store.db.prepare("SELECT * FROM memories WHERE source='checkpoint_derived'").all();
  assert.ok(original.every(m=>m.source_checkpoint_id && m.workstream_id===base.workstream_id));
  f.store.appendEvents(f.a.auth,{events});
  assert.deepEqual(f.store.db.prepare("SELECT * FROM memories WHERE source='checkpoint_derived'").all(),original);
  const old = f.store.saveMemory(f.a.auth,{scope:'user',content:'当前版本是17.9.8'}).memory;
  const next = f.store.supersedeMemory(f.a.auth,old.memory_id,{content:'当前版本是17.98'}).replacement_memory;
  assert.equal(f.store.queryMemories(f.a.auth,{query:'17.9.8'}).results.length,0);
  assert.equal(f.store.queryMemories(f.a.auth,{query:'17.98'}).results[0].memory_id,next.memory_id);
  f.store.retractMemory(f.a.auth,next.memory_id,{});
  assert.equal(f.store.queryMemories(f.a.auth,{query:'17.98'}).results.length,0);
});

// Frozen v1 token projection, not a second production tokenizer.
function legacyIndexText(value) {
  const text = normalizeSearch(value), tokens = new Set();
  for (const word of text.match(/[\p{L}\p{N}]+(?:[._:/-][\p{L}\p{N}]+)*/gu) || []) {
    if (/\p{Script=Han}/u.test(word)) Array.from(word).forEach((c,i,chars)=>{tokens.add(c);if(chars[i+1])tokens.add(c+chars[i+1]);});
    else tokens.add(word);
  }
  for (const symbol of text.match(/\p{S}/gu) || []) tokens.add(symbol);
  return [...tokens].map(token=>'t'+Buffer.from(token).toString('hex')).join(' ');
}

test('REV-03 v1 projection upgrades and interrupted rebuild recovers without changing original records', async t => {
  const f = await memoryFixture(t);
  const memory = f.store.saveMemory(f.a.auth,{scope:'user',content:'设备型号为C9800-CL'}).memory;
  f.store.db.exec('BEGIN');
  for (let i=0;i<600;i++) f.store.saveMemory(f.a.auth,{scope:'user',content:`测试噪声noise-${i}`});
  f.store.db.exec('COMMIT');
  f.store.db.function('memory_search_tokens',{deterministic:true},legacyIndexText);
  f.store.db.exec("UPDATE memories SET content=content; UPDATE memory_search_state SET version='memory-search-v1',state='ready'");
  const oldTokens = f.store.db.prepare('SELECT tokens FROM memory_search_docs WHERE memory_id=?').get(memory.memory_id).tokens;
  assert.ok(!oldTokens.split(' ').includes('t'+Buffer.from('c9800-cl').toString('hex')));
  const before = businessSnapshot(f.store);
  const ids = f.store.db.prepare('SELECT memory_id,doc_id FROM memory_search_docs ORDER BY doc_id').all();
  f.store.memorySearch = new MemorySearch(f.store.db);
  assert.equal(INDEX_VERSION,'memory-search-v2');
  assert.equal(f.store.memorySearch.status().state,'ready');
  assert.equal(f.store.db.prepare('SELECT version FROM memory_search_state').get().version,INDEX_VERSION);
  assert.equal(f.store.queryMemories(f.a.auth,{query:'C9800-CL'}).results[0].memory_id,memory.memory_id);
  assert.deepEqual(f.store.db.prepare('SELECT memory_id,doc_id FROM memory_search_docs ORDER BY doc_id').all(),ids);
  assert.deepEqual(businessSnapshot(f.store),before);
  assert.throws(()=>f.store.memorySearch.rebuild({afterBatch:()=>{throw Error('isolated rebuild interruption');}}));
  assertCode(()=>f.store.queryMemories(f.a.auth,{query:'C9800-CL'}),'SEARCH_UNAVAILABLE',503);
  assert.equal(f.store.db.prepare('SELECT state FROM memory_search_state').get().state,'building');
  const reopened = new MnemuronStore(f.databasePath);
  try {
    assert.equal(reopened.memorySearch.status().state,'ready');
    assert.equal(reopened.queryMemories(f.a.auth,{query:'C9800-CL'}).results[0].memory_id,memory.memory_id);
    assert.deepEqual(businessSnapshot(reopened),before);
    assert.deepEqual(reopened.db.prepare('SELECT memory_id,doc_id FROM memory_search_docs ORDER BY doc_id').all(),ids);
  } finally { reopened.close(); }
});

test('REV-04 private search readiness is cheap, fail-closed and independent from DB liveness', async t => {
  const f = await memoryFixture(t);
  const noScope = f.store.issueCredential({label:'capture-only',userId:'readiness-user',deviceId:'readiness-device',agentId:'test',agentInstanceId:'readiness-agent',scopes:['capture:write']});
  assert.equal((await fetch(f.baseUrl+'/readyz/search')).status,401);
  assert.equal((await f.request('GET','/readyz/search',undefined,noScope)).status,403);
  const before = businessSnapshot(f.store);
  for (const method of ['rebuild','validate']) t.mock.method(f.store.memorySearch,method,()=>assert.fail(`health must not call ${method}`));
  const candidates = t.mock.method(f.store.memorySearch,'candidates',()=>assert.fail('health must not query FTS'));
  t.mock.method(f.store,'pruneExpired',()=>assert.fail('health must not prune'));
  const prepared = [], prepare = f.store.db.prepare.bind(f.store.db);
  const spy = t.mock.method(f.store.db,'prepare',sql=>{prepared.push(sql);return prepare(sql);});
  const check = async expected => {
    const result = await f.request('GET','/readyz/search');
    assert.equal(result.status,expected);
    assert.equal(result.body.ready,expected===200);
    assert.equal(result.body.component,'memory_search');
    assert.equal(result.body.index_version,INDEX_VERSION);
    if (expected===503) assert.equal(result.body.error_code,'SEARCH_UNAVAILABLE');
    assert.ok(Buffer.byteLength(JSON.stringify(result.body))<1024);
    assert.equal((await f.request('GET','/livez')).status,200);
    assert.deepEqual(await f.request('GET','/readyz'),{status:200,body:{status:'ready'}});
  };
  await check(200);
  f.store.memorySearch.enabled=false; await check(503); f.store.memorySearch.enabled=true;
  f.store.memorySearch.state='building'; await check(503); f.store.memorySearch.state='ready';
  f.store.db.exec("UPDATE memory_search_state SET state='building'"); await check(503);
  f.store.db.exec("UPDATE memory_search_state SET state='ready',version='memory-search-v0'"); await check(503);
  f.store.db.prepare('UPDATE memory_search_state SET version=?').run(INDEX_VERSION); await check(200);
  f.store.db.exec('DROP TABLE memory_search_fts'); await check(503);
  spy.mock.restore();
  assert.ok(prepared.every(sql=>!/(?:FROM|JOIN)\s+(?:memories|events|memory_search_fts|memory_search_docs)\b/i.test(sql)), 'health scanned business or FTS documents');
  candidates.mock.restore();
  const unavailable = await f.request('POST','/v1/memories/query',{query:'SQLite'});
  assert.equal(unavailable.status,503);
  assert.equal(unavailable.body.error_code,'SEARCH_UNAVAILABLE');
  assert.deepEqual(businessSnapshot(f.store),before);
});

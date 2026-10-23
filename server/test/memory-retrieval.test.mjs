import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryFixture, assertCode } from './helpers/core-memory-fixture.mjs';
import { MemorySearch } from '../lib/memory-retrieval.mjs';
import { MnemuronStore } from '../lib/store.mjs';
import { businessSnapshot } from './helpers/core-memory-fixture.mjs';

test('R-01..03 old exact targets survive cross-project, same-task and global noise', async t => {
  const f = await memoryFixture(t);
  const save = (content, task_id) => f.store.saveMemory(f.a.auth, {content, task_id, scope:'task'}).memory.memory_id;
  const target = save('alpha-exact-restore-2026', f.alpha.task_id);
  f.store.db.exec('BEGIN');
  for(let i=0;i<1200;i++) save(`unrelated-noise-${i}`, i%2 ? f.alpha.task_id : f.beta.task_id);
  f.store.db.exec('COMMIT');
  for(const filter of [{task_id:f.alpha.task_id}, {}]) {
    const result = f.store.queryMemories(f.a.auth, {query:'alpha-exact-restore-2026', ...filter});
    assert.equal(result.results[0]?.memory_id, target);
    assert.equal(result.retrieval.execution_complete, true);
  }
});

test('R-04..08 literal multilingual terms and exact engineering identifiers rank ahead of near matches', async t => {
  const f=await memoryFixture(t);
  for(const query of ['语音','许可','音','C9800-CL','17.9.8','17.98','FDO1234ABCD','FDO1234ABCE','192.0.2.10','ＦＤＯ１２３４ＡＢＣＤ','😀','" OR NOT : ( ) % _']) {
    const memory=f.store.saveMemory(f.a.auth,{scope:'user',content:`验证 ${query} 保留原文`}).memory;
    const result=f.store.queryMemories(f.a.auth,{query,limit:20});
    assert.ok(result.results.some(m=>m.memory_id===memory.memory_id),query);
    assert.equal(f.store.memoryDetail(f.a.auth,memory.memory_id).memory.content,memory.content);
    if(['17.9.8','17.98','FDO1234ABCD','FDO1234ABCE'].includes(query)) assert.equal(result.results[0].memory_id,memory.memory_id);
    assert.ok(result.results.every(m=>m.provenance.agent_instance_id==='agent-a'));
  }
  assertCode(()=>f.store.queryMemories(f.a.auth,{query:Array.from({length:80},(_,i)=>`word${i}`).join(' ')}),'QUERY_TOO_COMPLEX');
  assertCode(()=>f.store.queryMemories(f.a.auth,{query:'a'.repeat(4097)}),'INVALID_PAYLOAD');
});

test('R-09..13 E-02 projection migration, interrupted rebuild, reopen and explicit unavailable',async t=>{
  const f=await memoryFixture(t);
  const old=f.store.saveMemory(f.a.auth,{scope:'user',content:'old-index-record'}).memory;
  const before=businessSnapshot(f.store);
  f.store.memorySearch.rebuild();
  assert.deepEqual(businessSnapshot(f.store),before);
  const doc=f.store.db.prepare('SELECT * FROM memory_search_docs WHERE memory_id=?').get(old.memory_id);
  f.store.memorySearch.rebuild();
  assert.deepEqual(f.store.db.prepare('SELECT * FROM memory_search_docs WHERE memory_id=?').get(old.memory_id),doc);
  assert.throws(()=>f.store.memorySearch.rebuild({afterBatch:()=>{throw Error('test interruption');}}));
  assertCode(()=>f.store.queryMemories(f.a.auth,{query:'old-index-record'}),'SEARCH_UNAVAILABLE',503);
  const second=new MnemuronStore(f.databasePath);
  assert.equal(second.memorySearch.status().state,'ready');
  second.close();
  f.store.memorySearch=new MemorySearch(f.store.db);
  assert.equal(f.store.queryMemories(f.a.auth,{query:'old-index-record'}).results[0].memory_id,old.memory_id);
  f.store.memorySearch.enabled=false;
  assertCode(()=>f.store.queryMemories(f.a.auth,{query:'old-index-record'}),'SEARCH_UNAVAILABLE',503);
  f.store.memorySearch.enabled=true;
  f.store.db.exec('DROP TABLE memory_search_fts');
  assertCode(()=>f.store.queryMemories(f.a.auth,{query:'old-index-record'}),'SEARCH_UNAVAILABLE',503);
  f.store.memorySearch=new MemorySearch(f.store.db);
  assert.equal(f.store.memorySearch.validate(),true);
  assert.deepEqual(businessSnapshot(f.store),before);
});

test('R-10..11 E-05 all SQL write paths and lifecycle remain atomic with projection',async t=>{
  const f=await memoryFixture(t);
  const a=f.store.saveMemory(f.a.auth,{scope:'user',content:'original-fact',operation_id:'lifecycle-key'}).memory;
  const revised=f.store.supersedeMemory(f.b.auth,a.memory_id,{content:'replacement-fact'}).replacement_memory;
  assert.equal(f.store.queryMemories(f.b.auth,{query:'original-fact'}).results.length,0);
  assert.equal(f.store.queryMemories(f.b.auth,{query:'replacement-fact'}).results[0].memory_id,revised.memory_id);
  f.store.retractMemory(f.a.auth,revised.memory_id,{});
  assert.equal(f.store.queryMemories(f.a.auth,{query:'replacement-fact'}).results.length,0);
  assert.equal(f.store.queryMemories(f.a.auth,{query:'replacement-fact',statuses:['retracted']}).results[0].status,'retracted');
  assert.equal(f.store.saveMemory(f.a.auth,{scope:'user',content:'original-fact',operation_id:'lifecycle-key'}).memory.status,'superseded');
  const count=f.store.db.prepare('SELECT count(*) n FROM memory_search_docs').get().n;
  f.store.db.exec(`CREATE TEMP TRIGGER fail_projection BEFORE INSERT ON memory_search_docs BEGIN SELECT RAISE(ABORT,'synthetic'); END`);
  assert.throws(()=>f.store.saveMemory(f.a.auth,{scope:'user',content:'must-rollback',operation_id:'rollback-index'}));
  f.store.db.exec('DROP TRIGGER fail_projection');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM memories').get().n,count);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_create_operations WHERE operation_id=?').get('rollback-index').n,0);
  assert.equal(f.store.memorySearch.validate(),true);
});

test('R-14 D-07 independent candidate/result/conflict truncation under the total byte budget',async t=>{
  const f=await memoryFixture(t);
  f.store.db.exec('BEGIN');
  for(let i=0;i<620;i++) f.store.saveMemory(f.a.auth,{scope:'workstream',task_id:f.alpha.task_id,workstream_id:f.alpha.workstreams[i%2].workstream_id,topic:'同一主题',content:`容量 ${i} `+'😀中文'.repeat(600)});
  f.store.db.exec('COMMIT');
  const q=f.store.queryMemories(f.a.auth,{query:'容量',task_id:f.alpha.task_id,limit:20});
  assert.equal(q.retrieval.candidate_truncated,true);
  assert.equal(q.retrieval.result_truncated,true);
  assert.equal(q.retrieval.conflict_truncated,true);
  assert.equal(q.retrieval.total_matching_count,null);
  assert.ok(Buffer.byteLength(JSON.stringify(q))<=128*1024);
  assert.ok(q.conflict_presentation.potential_conflicts.every(c=>c.variants.length<=20));
  assert.ok(q.results.every(m=>m.content.isWellFormed() && m.content_truncated));
  f.store.db.prepare('UPDATE tasks SET conflicts_json=? WHERE task_id=?').run(JSON.stringify([{legacy_fields:Array.from({length:600},()=> 'x'.repeat(800))}]),f.alpha.task_id);
  const legacy=f.store.queryMemories(f.a.auth,{query:'容量',task_id:f.alpha.task_id,limit:20});
  assert.ok(Buffer.byteLength(JSON.stringify(legacy))<=128*1024);
  assert.ok(legacy.retrieval.budget_reasons.includes('recorded_conflict_byte_budget'));
});

test('D-05..06 D-08..09 Unicode legacy detail pagination, expired sources and business-read-only',async t=>{
  const f=await memoryFixture(t);
  const memory=f.store.saveMemory(f.a.auth,{scope:'user',content:'legacy-page'}).memory;
  const content='中文😀e\u0301'.repeat(26000);
  f.store.db.prepare('UPDATE memories SET content=?,source_event_ids_json=? WHERE memory_id=?').run(content,JSON.stringify(['expired-source']),memory.memory_id);
  f.store.appendEvents(f.a.auth,{event:{event_id:'expired-source',event_type:'tool_result',captured_at:'2020-01-01T00:00:00Z',content:'not to expose'},raw_retention_days:1});
  const before=businessSnapshot(f.store);
  let offset=0,full='';
  do {
    const d=f.store.memoryDetail(f.b.auth,memory.memory_id,{content_offset:offset,content_limit:8191});
    assert.ok(Buffer.byteLength(JSON.stringify(d))<=128*1024);
    assert.ok(d.memory.content.isWellFormed());
    assert.equal(d.sources[0].raw_availability,'expired');
    full+=d.memory.content;
    assert.equal(d.next_offset,null === d.next_offset ? null : offset+Array.from(d.memory.content).length);
    offset=d.next_offset;
  } while(offset!==null);
  assert.equal(full,content);
  f.store.queryMemories(f.a.auth,{query:'中文'});
  assert.deepEqual(businessSnapshot(f.store),before);
});

test('D-01..04 controlled full detail, sharing, invisible foreign ID and explicit history', async t => {
  const f = await memoryFixture(t);
  const content = '语音许可😀e\u0301'.repeat(240);
  const memory = f.store.saveMemory(f.a.auth, {content,scope:'user'}).memory;
  const result = await f.request('GET', `/v1/memories/${memory.memory_id}`, undefined, f.b);
  assert.equal(result.status,200);
  assert.equal(result.body.memory.content,content);
  assert.equal(result.body.content_complete,true);
  const q=f.store.queryMemories(f.a.auth,{query:'许可'});
  assert.equal(q.results[0].content_truncated,true);
  assert.equal((await f.request('GET',`/v1/memories/${memory.memory_id}`,undefined,f.other)).status,404);
  assert.equal((await f.request('GET','/v1/memories/unknown')).status,404);
  f.store.retractMemory(f.a.auth,memory.memory_id,{});
  assert.equal((await f.request('GET',`/v1/memories/${memory.memory_id}`)).status,404);
  assert.equal((await f.request('GET',`/v1/memories/${memory.memory_id}?include_history=true`)).body.memory.status,'retracted');
});

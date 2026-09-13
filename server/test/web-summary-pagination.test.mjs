import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/memory-models.mjs';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';

export function summaries(t,count=4,quote='x'.repeat(40000)) {
  const f=fixture(t),memory=f.save('Synthetic summary provenance.');
  const source=f.s.derivedMemory.currentSource(f.auth.user_id,memory.memory_id);
  const jobs=new MemoryJobs(f.s);
  for(let n=0;n<count;n++) {
    const id=jobs.enqueue({type:'summary',userId:f.auth.user_id,scope:source.scope_key,profile:'synthetic',metadata:{taxonomy:{version:'synthetic'},category:'uncategorized',window:{day:n}},items:[source]});
    f.s.derivedMemory.publishSummary(jobs.get(id),[source],[{memory_id:memory.memory_id,revision:source.revision,start:0,end:quote.length,quote}],1000+n);
  }
  return {...f,memory};
}

test('WEB-MEM-02: budget-trimmed summaries are continued, not silently skipped',t=>{
  const f=summaries(t),seen=[];let request={scope:'user',limit:20};
  for(let page=0;request && page<30;page++) {
    const response=f.s.memorySummaries(f.auth,request);
    for(const row of response.results)seen.push(row.summary_id);
    request=response.next_request;
  }
  assert.equal(new Set(seen).size,4);
  assert.equal(request,null);
});

test('WEB-MEM-02: legacy local offsets and keyset cursors both skip stale rows without skipping valid records',t=>{
  const f=summaries(t,4,'Synthetic small claim');
  const rows=f.s.db.prepare('SELECT summary_id FROM memory_summaries ORDER BY rowid').all();
  f.s.db.prepare("UPDATE memory_summaries SET status='stale' WHERE summary_id=?").run(rows[2].summary_id);
  const first=f.s.memorySummaries(f.auth,{scope:'user',limit:2});assert.equal(first.next_offset,2);
  const old=f.s.memorySummaries(f.auth,{scope:'user',limit:2,offset:first.next_offset});
  const next=f.s.memorySummaries(f.auth,first.next_request);
  assert.deepEqual(old.results.map(s=>s.summary_id),[rows[0].summary_id]);assert.deepEqual(next.results,old.results);
});

test('WEB-MEM-02: stable cursor traverses 20 large summaries without duplicates and rejects tampering',t=>{
  const f=summaries(t,20),ids=[];let args={scope:'user',limit:20},first;
  for(let n=0;args && n<100;n++) {
    const r=f.s.memorySummaries(f.auth,args);first ||= r.next_request;
    ids.push(...r.results.map(s=>s.summary_id));assert.ok(Buffer.byteLength(JSON.stringify(r))<=128*1024);args=r.next_request;
  }
  assert.equal(args,null);assert.equal(ids.length,20);assert.equal(new Set(ids).size,20);
  for(const patch of [{cursor:first.cursor+'x'},{limit:1},{scope:'session',session_id:'foreign'}])assert.throws(()=>f.s.memorySummaries(f.auth,{...first,...patch}));
  assert.throws(()=>f.s.memorySummaries({...f.auth,credential_id:'foreign'},first),e=>e.errorCode==='INVALID_CURSOR');
  f.s.derivedMemory.pagination.clock=()=>Date.now()+16*60000;
  assert.throws(()=>f.s.memorySummaries(f.auth,first),e=>e.errorCode==='CURSOR_EXPIRED');
});

test('WEB-MEM-02: a single oversized Unicode claim continues exactly and source invalidation aborts partial reads',t=>{
  const quote='🙂字段'.repeat(40000),f=summaries(t,1,quote);let args={scope:'user'},joined='',pages=0,continuation;
  do {const r=f.s.memorySummaries(f.auth,args);joined+=r.results[0].claims[0].quote;args=r.next_request;continuation ||=args;pages++;assert.ok(pages<30);}while(args);
  assert.equal(joined,quote);assert.ok(pages>1);
  f.s.retractMemory(f.auth,f.memory.memory_id);
  assert.throws(()=>f.s.memorySummaries(f.auth,continuation),e=>e.errorCode==='SUMMARY_VERSION_CHANGED');
});

test('WEB-MEM-02: exact page allowance, one-byte overflow and empty pages have honest continuation',t=>{
  const quote='🙂边界'.repeat(1000),f=summaries(t,1,quote);
  const scope=f.s.derivedMemory.currentSource(f.auth.user_id,f.memory.memory_id).scope_key;
  const pager=f.s.derivedMemory.pagination,whole=pager.page(f.auth.user_id,scope,{auth:f.auth});
  const {content_complete,...item}=whole.results[0];
  const allowance=Buffer.byteLength(JSON.stringify({read_only:true,results:[item],next_cursor:null,next_offset:null,production_ready:false}))+2048;
  const exact=pager.page(f.auth.user_id,scope,{auth:f.auth,budget:allowance});
  assert.equal(exact.results[0].content_complete,true);assert.equal(exact.next_cursor,null);
  let cursor,joined='',pages=0;
  do {
    const result=pager.page(f.auth.user_id,scope,{auth:f.auth,budget:allowance-1,cursor});
    assert.ok(Buffer.byteLength(JSON.stringify(result))<=allowance-1);
    joined+=result.results[0].claims[0].quote;cursor=result.next_cursor;assert.ok(++pages<10);
  }while(cursor);
  assert.equal(joined,quote);assert.ok(pages>1);
  const empty=f.s.memorySummaries(f.auth,{scope:'user',category:'no_matching_category'});
  assert.deepEqual(empty.results,[]);assert.equal(empty.complete,true);assert.equal(empty.next_request,null);
});

test('WEB-MEM-02: stale filtering plus byte trim excludes concurrent inserts without missing valid snapshot rows',t=>{
  const f=summaries(t,20),rows=f.s.db.prepare('SELECT summary_id FROM memory_summaries ORDER BY rowid').all();
  const stale=rows.filter((_,n)=>n%4===0).map(r=>r.summary_id);
  for(const id of stale)f.s.db.prepare("UPDATE memory_summaries SET status='stale' WHERE summary_id=?").run(id);
  const first=f.s.memorySummaries(f.auth,{scope:'user',limit:20}),ids=first.results.map(r=>r.summary_id);
  assert.ok(first.next_request);
  const source=f.s.derivedMemory.currentSource(f.auth.user_id,f.memory.memory_id),jobs=new MemoryJobs(f.s);
  const job=jobs.enqueue({type:'summary',userId:f.auth.user_id,scope:source.scope_key,profile:'synthetic',metadata:{taxonomy:{version:'synthetic'},category:'uncategorized',window:{day:99}},items:[source]});
  f.s.derivedMemory.publishSummary(jobs.get(job),[source],[{memory_id:f.memory.memory_id,revision:source.revision,start:0,end:4,quote:'test'}],9999);
  let args=first.next_request,pages=0;
  while(args){const result=f.s.memorySummaries(f.auth,args);ids.push(...result.results.map(r=>r.summary_id));args=result.next_request;assert.ok(++pages<20);}
  assert.deepEqual(ids,rows.filter(r=>!stale.includes(r.summary_id)).reverse().map(r=>r.summary_id));
});

test('WEB-MEM-01: summary read requires every leaf grant, including omitted sources, without metadata leaks',t=>{
  const f=summaries(t,1,'Synthetic claim'),extra=f.save('Synthetic omitted secret source');
  const web=f.s.authenticate(f.s.issueCredential({userId:f.auth.user_id,deviceId:'web',agentId:'chatgpt-web',agentInstanceId:'web',scopes:['memory:read']}).api_key);
  const admin={...f.auth,scopes:[...f.auth.scopes,'admin:tasks']};
  const grant=m=>{const {revision,state_hash}=f.s.revisions.latest(f.auth.user_id,m.memory_id);f.s.webVisibility.set(admin,m.memory_id,{allow:true,revision,state_hash});};
  grant(f.memory);assert.equal(f.s.memorySummaries(web,{scope:'user'}).results.length,1);
  const summary=f.s.db.prepare('SELECT summary_id FROM memory_summaries').get(),source=f.s.derivedMemory.currentSource(f.auth.user_id,extra.memory_id);
  f.s.db.prepare('INSERT INTO memory_summary_dependencies VALUES (?,?,?,?,?,?)').run(summary.summary_id,source.user_id,source.memory_id,source.revision,source.state_hash,source.scope_key);
  const hidden=f.s.memorySummaries(web,{scope:'user'});assert.equal(hidden.results.length,0);assert.ok(!JSON.stringify(hidden).includes(extra.memory_id));
  grant(extra);const result=f.s.memorySummaries(web,{scope:'user'}).results[0];
  assert.equal(result.coverage_status,'partial');assert.equal(result.omitted_source_count,1);assert.equal(result.profile,undefined);assert.equal(result.scope_key,undefined);
  f.s.db.prepare('INSERT INTO memory_privacy VALUES (?,?,?)').run(f.auth.user_id,extra.memory_id,'secret');
  assert.equal(f.s.memorySummaries(web,{scope:'user'}).results.length,0);
});

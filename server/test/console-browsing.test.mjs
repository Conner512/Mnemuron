import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';

async function setup(t){
 const f=await memoryFixture(t);
 const reader=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:'browse-A',scopes:['memory:read','resume:read','console:read']});
 const get=async(view,params={})=>f.request('GET',`/v1/console/${view}?${new URLSearchParams(params)}`,undefined,reader);
 return {...f,reader,get};
}
test('BROWSE-01: lexical search pages beyond twenty within an explicit bounded candidate window',async t=>{
 const f=await setup(t),ids=[];
 for(let n=0;n<31;n++)ids.push(f.store.saveMemory(f.a.auth,{scope:'user',content:`Synthetic browse marker ${n}`}).memory.memory_id);
 const foreign=f.store.saveMemory(f.other.auth,{scope:'user',content:'Synthetic browse marker foreign'}).memory.memory_id;
 const first=await f.get('memories',{query:'browse marker',mode:'lexical',limit:25});assert.equal(first.status,200);assert.equal(first.body.results.length,25);assert.equal(first.body.next_offset,25);
 const second=await f.get('memories',{query:'browse marker',mode:'lexical',limit:25,offset:25});assert.equal(second.status,200);assert.equal(second.body.results.length,6);assert.equal(second.body.next_offset,null);
 const found=[...first.body.results,...second.body.results].map(m=>m.memory_id);assert.equal(new Set(found).size,31);assert.deepEqual(found.sort(),ids.sort());assert.ok(!found.includes(foreign));
 assert.equal(first.body.retrieval.candidate_limit,500);assert.equal(first.body.retrieval.degraded,false);
});
test('BROWSE-02: category and lifecycle filters apply before paging for lists and lexical queries',async t=>{
 const f=await setup(t),own=f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic filter marker technical'}).memory;
 const other=f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic filter marker unclassified'}).memory;
 const organizer=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-organizer',agentId:'test',agentInstanceId:'browse-category',scopes:['memory:organize']});
 f.store.derivedMemory.setCategory(f.store.authenticate(organizer.api_key),own.memory_id,'technical',f.store.consoleService.taxonomy());
 for(const query of ['', 'filter marker']){
  const result=await f.get('memories',{category:'technical',query});assert.equal(result.status,200);assert.deepEqual(result.body.results.map(m=>m.memory_id),[own.memory_id]);
 }
 f.store.retractMemory(f.a.auth,own.memory_id);
 const retracted=await f.get('memories',{status:'retracted',category:'technical',query:'filter marker'});assert.equal(retracted.status,200);assert.deepEqual(retracted.body.results.map(m=>m.memory_id),[own.memory_id]);
 const active=await f.get('memories',{status:'active'});assert.deepEqual(active.body.results.map(m=>m.memory_id),[other.memory_id]);
 for(const params of [{status:'anything'},{category:'../private'},{limit:0},{offset:-1},{query:'marker',offset:'NaN'},{user_id:f.other.auth.user_id}])assert.equal((await f.get('memories',params)).status,400);
});
test('BROWSE-03: read-only model metadata is owner bound and never exposes the secret field',async t=>{
 const f=await setup(t),now=Date.now();
 f.store.db.prepare('INSERT INTO console_models VALUES(?,?,?,?,?,?)').run(f.a.auth.user_id,'organizer',1,JSON.stringify({enabled:false,model:'synthetic-own-model'}),'synthetic-cipher-A',now);
 f.store.db.prepare('INSERT INTO console_models VALUES(?,?,?,?,?,?)').run(f.other.auth.user_id,'organizer',1,JSON.stringify({enabled:true,model:'synthetic-foreign-model'}),'synthetic-cipher-B',now);
 const r=await f.get('models');assert.equal(r.status,200);assert.equal(r.body.writable,false);assert.equal(r.body.models[0].has_key,true);
 assert.match(JSON.stringify(r.body),/synthetic-own-model/);assert.doesNotMatch(JSON.stringify(r.body),/synthetic-foreign|synthetic-cipher|secret_cipher/);
});
test('BROWSE-04: jobs and summaries reject invalid pagination rather than silently repeating page one',async t=>{
 const f=await setup(t);
 for(const view of ['jobs','summaries']){
  const r=await f.get(view,{offset:0,limit:1});assert.equal(r.status,200,view);assert.equal(r.body.next_offset,null);
  assert.equal((await f.get(view,{offset:-1})).status,400);assert.equal((await f.get(view,{limit:0})).status,400);
 }
});
test('BROWSE-05: hybrid search awaits the result and never borrows a deployment-wide model',async t=>{
 const f=await setup(t);f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic hybrid marker'});
 let borrowed=false;f.store.vectorIndex={search(){borrowed=true;throw new Error('must not borrow global model');}};
 const r=await f.get('memories',{query:'hybrid marker',mode:'hybrid'});
 assert.equal(r.status,200);assert.equal(r.body.results.length,1);assert.equal(r.body.retrieval.degraded,true);assert.equal(r.body.retrieval.window_limited,true);assert.equal(borrowed,false);
 const semantic=await f.get('memories',{query:'hybrid marker',mode:'semantic'});assert.notEqual(semantic.status,200);assert.equal(borrowed,false);
});
test('BROWSE-06: a bounded search advertises truncation rather than hiding matches past the window',async t=>{
 const f=await setup(t);
 for(let n=0;n<502;n++)f.store.saveMemory(f.a.auth,{scope:'user',content:`Synthetic bounded window marker ${n}`});
 const r=await f.get('memories',{query:'bounded window marker',mode:'lexical',offset:475,limit:25});
 assert.equal(r.status,200);assert.equal(r.body.results.length,25);assert.equal(r.body.truncated,true);assert.equal(r.body.next_offset,null);assert.equal(r.body.retrieval.candidate_limit,500);
});
test('BROWSE-07: stable jobs/summary pagination and job detail never return a foreign record',async t=>{
 const f=await setup(t),db=f.store.db,ids=[];
 const own=f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic job source'}).memory;
 const source=f.store.derivedMemory.currentSource(f.a.auth.user_id,own.memory_id);
 for(let n=0;n<28;n++){
  const job=f.store.memoryJobs.enqueue({type:'summary',userId:source.user_id,scope:source.scope_key,profile:'synthetic',metadata:{n},items:[source]});ids.push(job);
  db.prepare('INSERT INTO memory_summaries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(`summary-${n}`,`group-${n}`,1,source.user_id,source.scope_key,'technical','{}','current','synthetic',job,1,0,'2020-01-01T00:00:00Z');
 }
 const foreign=f.store.saveMemory(f.other.auth,{scope:'user',content:'Foreign synthetic job source'}).memory,foreignSource=f.store.derivedMemory.currentSource(f.other.auth.user_id,foreign.memory_id);
 const foreignJob=f.store.memoryJobs.enqueue({type:'summary',userId:foreignSource.user_id,scope:foreignSource.scope_key,profile:'synthetic',metadata:{},items:[foreignSource]});
 for(const view of ['jobs','summaries']){
  const a=(await f.get(view,{limit:25})).body,b=(await f.get(view,{offset:25,limit:25})).body;
  assert.equal(a[view].length,25);assert.equal(b[view].length,3);assert.equal(a.next_offset,25);assert.equal(b.next_offset,null);
  assert.equal(new Set([...a[view],...b[view]].map(r=>r.job_id||r.summary_id)).size,28);assert.ok(!JSON.stringify(a).includes(foreignJob));
 }
 assert.equal((await f.get('jobs',{job_id:ids[0]})).body.job.job_id,ids[0]);
 assert.equal((await f.get('jobs',{job_id:foreignJob})).status,404);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {VectorIndex} from '../lib/vector-stores/index.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {embedder} from './helpers/memory-models.mjs';

function reader(f) {return f.store.authenticate(f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'web',agentId:'chatgpt-web',agentInstanceId:'web',scopes:['memory:read','resume:read']}).api_key);}
function grant(f,m,allow=true) {const {revision,state_hash}=f.store.revisions.latest(f.a.auth.user_id,m.memory_id);return f.store.webVisibility.set(f.a.auth,m.memory_id,{allow,revision,state_hash});}

test('Web conflict variants preserve exact revisions even outside the main result limit',async t=>{
  const f=await memoryFixture(t),web=reader(f),memories=[];
  for(const [i,workstream] of f.alpha.workstreams.entries()) {
    const memory=f.store.saveMemory(f.a.auth,{scope:'workstream',project_id:f.alpha.project_id,task_id:f.alpha.task_id,
      workstream_id:workstream.workstream_id,topic:'Synthetic audit alternatives',content:'Synthetic audit alternative '+i}).memory;
    grant(f,memory);memories.push(memory);
  }
  const result=f.store.queryMemories(web,{query:'Synthetic audit alternative',task_id:f.alpha.task_id,limit:1});
  assert.equal(result.result_count,1);
  const variants=result.conflict_presentation.potential_conflicts.flatMap(c=>c.variants);
  assert.equal(variants.length,2);
  assert.deepEqual(variants.map(v=>v.memory_id).sort(),memories.map(m=>m.memory_id).sort());
  assert.ok(variants.every(v=>v.revision===1 && v.provenance.details_omitted));
  assert.ok(variants.every(v=>v.workstream_id===undefined));
});

test('WEB-MEM-01: Web destination cannot read secret/default-sensitive memories; local reads stay intact', async t => {
  const f = await memoryFixture(t);
  const web = f.store.authenticate(f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'test-web',agentId:'chatgpt-web',agentInstanceId:'test-web',scopes:['memory:read','resume:read']}).api_key);
  const sensitive = f.store.saveMemory(f.a.auth,{content:'Synthetic privacy marker sensitive',scope:'user'}).memory;
  const secret = f.store.saveMemory(f.a.auth,{content:'Synthetic privacy marker secret',scope:'user'}).memory;
  f.store.db.prepare('INSERT INTO memory_privacy VALUES (?,?,?)').run(web.user_id,secret.memory_id,'secret');
  assert.equal(f.store.queryMemories(f.a.auth,{query:'privacy marker'}).result_count,2);
  assert.equal(f.store.queryMemories(web,{query:'privacy marker',destination:'local'}).result_count,0);
  for(const memory of [sensitive,secret])assert.throws(()=>f.store.memoryDetail(web,memory.memory_id,{include_history:true}),e=>e.errorCode==='MEMORY_NOT_FOUND');
  const taskScoped=f.store.queryMemories(web,{query:'privacy marker',task_id:f.alpha.task_id});
  assert.equal(taskScoped.effective_scope.project_id,null);
  assert.ok(!JSON.stringify(taskScoped).includes(f.alpha.project_id));
});

test('WEB-MEM-01: current grants, public classification, lifecycle and Core route boundaries',async t=>{
  const f=await memoryFixture(t),web=reader(f);
  const m=f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic allowed route marker'}).memory;
  const secret=f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic denied route marker'}).memory;
  f.store.db.prepare('INSERT INTO memory_privacy VALUES (?,?,?)').run(web.user_id,secret.memory_id,'secret');
  assert.throws(()=>grant(f,secret),e=>e.errorCode==='WEB_VISIBILITY_DENIED');
  assert.throws(()=>f.store.webVisibility.set(web,m.memory_id,{allow:true}),e=>e.statusCode===403);
  grant(f,m);assert.equal(f.store.memoryDetail(web,m.memory_id).memory.content,m.content);
  const original=f.store.revisions.latest(web.user_id,m.memory_id);
  assert.throws(()=>f.store.webVisibility.set(f.a.auth,m.memory_id,{allow:true,revision:original.revision,state_hash:'stale'}),e=>e.errorCode==='MEMORY_VERSION_CHANGED');
  f.store.db.prepare('UPDATE memories SET warnings_json=?,lifecycle_reason=?,superseded_by_memory_id=? WHERE memory_id=?')
    .run(JSON.stringify(['synthetic-private-path']),'synthetic-private-path',secret.memory_id,m.memory_id);
  assert.throws(()=>f.store.memoryDetail(web,m.memory_id),e=>e.errorCode==='MEMORY_NOT_FOUND');
  grant(f,m);const body=JSON.stringify(f.store.memoryDetail(web,m.memory_id));
  assert.ok(!body.includes('synthetic-private-path') && !body.includes(secret.memory_id));
  grant(f,m,false);assert.equal(f.store.queryMemories(web,{query:'route marker',include_shared:true,statuses:['active','retracted','superseded']}).matched_candidate_count,0);
  f.store.db.prepare('INSERT INTO memory_privacy VALUES (?,?,?)').run(web.user_id,m.memory_id,'public');
  assert.equal(f.store.queryMemories(web,{query:'route marker'}).result_count,1);
  f.store.db.prepare("UPDATE memory_privacy SET sensitivity='secret' WHERE memory_id=?").run(m.memory_id);
  assert.equal(f.store.queryMemories(web,{query:'route marker'}).result_count,0);
  assert.equal(f.store.queryMemories(f.a.auth,{query:'route marker'}).result_count,2);
});

test('WEB-MEM-02: 45 sources page 20/20/5 independently of Unicode body, with a pinned revision',async t=>{
  const f=await memoryFixture(t),web=reader(f),content='中文🙂abc'.repeat(10);
  const m=f.store.saveMemory(f.a.auth,{scope:'user',content}).memory;
  f.store.db.prepare('DELETE FROM memory_source_links WHERE memory_id=?').run(m.memory_id);
  for(let n=0;n<45;n++) {
    const id='synthetic-source-'+String(n).padStart(2,'0');
    f.store.db.prepare('INSERT INTO memory_sources VALUES (?,?,?,?,?,?,?,?,?,?)').run(web.user_id,id,'explicit_memory',null,'synthetic-hash',10,'available','user','2040-01-01','synthetic-private-path');
    f.store.db.prepare('INSERT INTO memory_source_links VALUES (?,?,?,?,?,?,?,?,?)').run(web.user_id,m.memory_id,1,id,0,10,'synthetic','synthetic-private-path','utf16_code_units');
  }
  grant(f,m);let args={memory_id:m.memory_id,content_limit:7},parts='',sourceArgs;const ids=[];
  for(let n=0;args && n<30;n++) {
    const {memory_id,...opts}=args,r=f.store.memoryDetail(web,memory_id,opts);parts+=r.memory.content;args=r.next_request;
    if(n===0){sourceArgs=r.next_source_request;ids.push(...r.source_manifest.sources.map(s=>s.source_id));}
    assert.ok(!JSON.stringify(r).includes('synthetic-private-path'));
  }
  assert.equal(args,null);assert.equal(parts,content);
  const sizes=[20];while(sourceArgs) {
    const {memory_id,...opts}=sourceArgs,r=f.store.memoryDetail(web,memory_id,opts);
    sizes.push(r.source_manifest.sources.length);ids.push(...r.source_manifest.sources.map(s=>s.source_id));sourceArgs=r.next_source_request;
  }
  assert.deepEqual(sizes,[20,20,5]);assert.equal(new Set(ids).size,45);
  assert.throws(()=>f.store.memoryDetail(web,m.memory_id,{source_offset:20}),e=>e.statusCode===400);
  assert.throws(()=>f.store.memoryDetail(web,m.memory_id,{revision:99}),e=>e.errorCode==='MEMORY_VERSION_CHANGED');
  f.store.retractMemory(f.a.auth,m.memory_id);grant(f,m);
  assert.throws(()=>f.store.memoryDetail(web,m.memory_id,{revision:1,include_history:true,content_offset:7}),e=>e.errorCode==='MEMORY_VERSION_CHANGED');
});

test('WEB-MEM-02: replay changes the source manifest without changing memory revision; restart source pages',async t=>{
  const f=await memoryFixture(t),web=reader(f);
  const append=n=>f.store.appendEvents(f.a.auth,{event:{event_id:'source-'+String(n).padStart(2,'0'),
    event_type:'user_message',content:'事实：Synthetic source replay pagination'}});
  for(let n=1;n<=21;n++)append(n);
  const memory=f.store.queryMemories(f.a.auth,{query:'Synthetic source replay pagination'}).results[0];
  assert.ok(memory);grant(f,memory);
  const first=f.store.memoryDetail(web,memory.memory_id);
  assert.equal(first.source_manifest.sources.length,20);
  append(0);
  assert.equal(f.store.revisions.latest(web.user_id,memory.memory_id).revision,first.revision);
  assert.equal(f.store.webVisibility.visible(web,memory.memory_id),true);
  const {memory_id,...continuation}=first.next_source_request;
  assert.throws(()=>f.store.memoryDetail(web,memory_id,continuation),e=>e.errorCode==='SOURCE_MANIFEST_CHANGED');
  let args={memory_id},ids=[];
  while(args){const {memory_id,...options}=args,result=f.store.memoryDetail(web,memory_id,options);
    ids.push(...result.source_manifest.sources.map(s=>s.source_id));args=result.next_source_request;}
  assert.equal(ids.length,22);assert.equal(new Set(ids).size,22);
});

test('WEB-MEM-01/03: hybrid and semantic recheck Web grants after awaited embedding; no fallback leak',async t=>{
  const f=await memoryFixture(t),web=reader(f),model=embedder(),backend=new MockVectorStore();
  const index=new VectorIndex(f.store,backend,new Map([[model.profile.fingerprint,model]]));f.store.vectorIndex=index;
  const m=f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic network router denied after await'}).memory;
  grant(f,m);const generation=index.begin(model.profile.fingerprint);await index.sync(generation);index.activate(generation);
  let calls=0;const mock=model.mock;model.mock=async(...args)=>{calls++;grant(f,m,false);return mock(...args);};
  const lexical=await f.store.searchMemories(web,{query:'network',mode:'lexical'});
  assert.equal(lexical.result_count,1);assert.equal(calls,0);
  for(const mode of ['hybrid','semantic']) {
    grant(f,m);const result=await f.store.searchMemories(web,{query:'network',mode});
    assert.equal(result.result_count,0);assert.equal(result.conflict_presentation.potential_conflicts.length,0);
    assert.ok(!JSON.stringify(result).includes(m.memory_id));
  }
  grant(f,m);model.mock=async()=>{grant(f,m,false);throw new Error('synthetic-private-provider-diagnostic');};
  const degraded=await f.store.searchMemories(web,{query:'network',mode:'hybrid'});
  assert.equal(degraded.result_count,0);assert.equal(degraded.retrieval.effective_mode,'lexical');assert.equal(degraded.retrieval.degraded,true);
});

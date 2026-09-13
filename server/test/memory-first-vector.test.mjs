import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {VectorIndex,surrogate,splitDocument} from '../lib/vector-stores/index.mjs';
import {QdrantStore,vectorConfig,QDRANT_PROTOCOL} from '../lib/vector-stores/qdrant.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {fixture,embedder,profile} from './helpers/memory-models.mjs';
import {organizer,taxonomy} from './helpers/memory-models.mjs';
import {scheduleLibrary,MemoryWorker} from '../lib/memory-jobs/worker.mjs';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {createMemoryBackup,restoreIsolatedBackup} from '../lib/memory/backup.mjs';
import {DatabaseSync} from 'node:sqlite';
test('V-09: authenticated Qdrant root health works through the real transport without allowing escaped routes',async t=>{
  const calls=[],server=http.createServer((req,res)=>{calls.push(req.url);res.setHeader('content-type','application/json');res.end(JSON.stringify({version:'1.19.0'}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const origin='http://127.0.0.1:'+server.address().port;
  const backend=new QdrantStore({enabled:true,protocol:QDRANT_PROTOCOL,base_url:origin,collection_prefix:'synthetic',auth:{env:'SYNTHETIC_VECTOR_KEY'},
    egress:{approved:true,origins:[origin],addresses:['127.0.0.1'],allow_private:true},timeouts:{request_ms:1000},limits:{input_bytes:10000,output_bytes:10000}},
    {env:{SYNTHETIC_VECTOR_KEY:'synthetic-only-key'}});
  assert.deepEqual(await backend.health(),{state:'ready',protocol:QDRANT_PROTOCOL,version:'1.19.0'});
  for(const route of ['', '//other.example', '/..', '/collections/../', '/%2e%2e/'])await assert.rejects(backend.call(route,undefined,'GET'),e=>e.code==='INVALID_ROUTE');
  assert.deepEqual(calls,['/']);
});
async function indexed(t){const f=fixture(t),e=embedder(),backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]));
  const a=f.save('Network router version 17.9.8 must not be changed.'),b=f.save('Disk storage space is 200 GB.');
  const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);return {...f,e,backend,index,generation,a,b};}
test('V-01 V-02 V-03: authoritative outbox survives failure, points contain no source body; retries idempotent',async t=>{
  const f=await indexed(t),snapshot=f.index.snapshot(),points=f.backend.collections.get(snapshot.collection_name).points;
  assert.equal(points.size,2);for(const p of points.values()){assert.deepEqual(Object.keys(p.payload).sort(),['content_hash','document','lifecycle','owner','profile','revision','scope']);assert.ok(!JSON.stringify(p.payload).includes('router'));}
  await f.index.sync(f.generation);assert.equal(points.size,2);
  f.backend.down=true;const c=f.save('New synthetic memory');await assert.rejects(f.index.sync(f.generation));
  assert.equal(f.s.queryMemories(f.auth,{query:'synthetic'}).results[0].memory_id,c.memory_id);
  assert.equal(f.s.db.prepare('SELECT state FROM memory_index_outbox WHERE memory_id=?').get(c.memory_id).state,'disabled');
  f.backend.down=false;await f.index.sync(f.generation);assert.equal(points.size,3);
});
test('V-04 V-08 V-10 R-08: stale/foreign/future/orphan points never hydrate after lifecycle changes',async t=>{
  const f=await indexed(t),snap=f.index.snapshot(),points=f.backend.collections.get(snap.collection_name).points;
  const before=[...points.values()].find(p=>p.payload.document===surrogate([f.auth.user_id,f.a.memory_id]));
  f.s.retractMemory(f.auth,f.a.memory_id);await f.backend.upsert(snap.collection_name,[before]);
  const future={...before,id:'future-point',payload:{...before.payload,revision:999}};await f.backend.upsert(snap.collection_name,[future]);
  const result=await f.index.search(f.auth,{query:'网络路由',mode:'semantic'});assert.ok(!result.results.some(r=>r.memory_id===f.a.memory_id));
  assert.equal((await f.index.reconcile(f.generation)).removed,2);assert.equal(points.size,1);
});
test('V-05 V-06 V-07: same dimensions new model gets a new generation; catchup and atomic request snapshots',async t=>{
  const f=await indexed(t),next=embedder(undefined,{model:'new-synthetic-model'});f.index.embedders.set(next.profile.fingerprint,next);
  const second=f.index.begin(next.profile.fingerprint);await f.index.sync(second);f.save('Network newly saved during generation rebuild.');
  assert.throws(()=>f.index.activate(second),e=>e.code==='VECTOR_CATCHUP_REQUIRED');await f.index.sync(second);
  const old=f.index.snapshot(),original=f.e.mock;f.e.mock=async(...args)=>{f.index.activate(second);return original(...args);};
  await f.index.search(f.auth,{query:'网络',mode:'semantic'});
  assert.equal(f.backend.searchCalls.at(-1).name,old.collection_name);assert.notEqual(f.index.snapshot().collection_name,old.collection_name);
});
test('R-02 R-04 R-05 R-06 R-07: scope prefilter + hydration, exact version, semantic synonyms and degraded fallback',async t=>{
  const f=await indexed(t);
  const query=await f.index.search(f.auth,{query:'网络设备',mode:'hybrid'});assert.equal(query.results[0].memory_id,f.a.memory_id);assert.ok(query.results[0].ranking.matched_by.includes('semantic'));
  const exact=await f.index.search(f.auth,{query:'17.9.8',mode:'hybrid'});assert.equal(exact.results[0].memory_id,f.a.memory_id);
  const filter=f.backend.searchCalls.at(-1).filter;assert.equal(filter.must[0].match.value,surrogate(f.auth.user_id));assert.ok(filter.must.some(c=>c.key==='scope'));
  f.backend.down=true;const fallback=await f.index.search(f.auth,{query:'17.9.8',mode:'hybrid'});assert.equal(fallback.retrieval.degraded,true);assert.equal(fallback.results[0].memory_id,f.a.memory_id);
  await assert.rejects(f.index.search(f.auth,{query:'network',mode:'semantic'}),e=>e.code==='SEMANTIC_UNAVAILABLE');
});
test('V-09 L-03: Qdrant REST contract uses private explicit authenticated target and fixed protocol',async t=>{
  const calls=[],server=http.createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;calls.push({url:req.url,method:req.method,body:raw?JSON.parse(raw):null,key:!!req.headers['api-key']});
    res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',result:req.url.endsWith('/exists')?{exists:false}:req.url.endsWith('/query')?{points:[]}:{status:'completed'}}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const origin='http://127.0.0.1:'+server.address().port,config={enabled:true,protocol:QDRANT_PROTOCOL,base_url:origin,collection_prefix:'synthetic',auth:{env:'SYNTHETIC_VECTOR_KEY'},
    egress:{approved:true,origins:[origin],addresses:['127.0.0.1'],allow_private:true},timeouts:{request_ms:1000},limits:{input_bytes:1000000,output_bytes:1000000}};
  const backend=new QdrantStore(config,{env:{SYNTHETIC_VECTOR_KEY:'synthetic-only-credential'}});
  await backend.ensureCollection('synthetic_one',{dimensions:3,distance:'Cosine'});await backend.upsert('synthetic_one',[]);assert.deepEqual(await backend.search('synthetic_one',[1,0,0],{must:[]},10),[]);
  assert.ok(calls.every(c=>c.key));assert.equal(calls[1].method,'PUT');assert.equal(calls[1].body.vectors.size,3);assert.match(calls[2].url,/ordering=strong/);
  assert.throws(()=>vectorConfig({...config,auth:{none:true}}));assert.throws(()=>vectorConfig({...config,egress:{...config.egress,addresses:['8.8.8.8']}}));
});
test('C-03: Unicode document chunks preserve the exact full body without truncation',()=>{
  const source='```code\n'+('字段🙂 network=1.2.3\n'.repeat(500))+'```',chunks=splitDocument(source,1024);
  assert.equal(chunks.join(''),source);assert.ok(chunks.every(c=>Buffer.byteLength(c)<=1024));
});
test('R-02 S-03 Q-03: fixed expected/forbidden owners and projects apply before ranking and again at hydrate',async t=>{
  const f=await indexed(t);f.s.ensureProject(f.auth,'synthetic-project-a','Synthetic A');f.s.ensureProject(f.auth,'synthetic-project-b','Synthetic B');
  const a=f.save('Network router version 17.9.8 is approved.',{scope:'project',project_id:'synthetic-project-a'});
  const b=f.save('Network router version 17.9.8 is NOT approved.',{scope:'project',project_id:'synthetic-project-b'});
  const other=f.s.issueCredential({label:'Synthetic other',userId:'other-owner',deviceId:'other-device',agentId:'synthetic',agentInstanceId:'other-agent',scopes:['memory:read','memory:write']});
  const otherAuth=f.s.authenticate(other.api_key),foreign=f.s.saveMemory(otherAuth,{scope:'user',content:'Network router version 17.9.8 private other owner'}).memory;
  await f.index.sync(f.generation);
  const tests=[{query:'17.9.8',mode:'lexical'},{query:'网络设备',mode:'semantic'},{query:'网络设备',mode:'hybrid'}];
  for(const query of tests){const result=await f.index.search(f.auth,{...query,project_id:'synthetic-project-a'}),ids=result.results.map(r=>r.memory_id);
    assert.ok(ids.includes(a.memory_id));assert.ok(!ids.includes(b.memory_id));assert.ok(!ids.includes(foreign.memory_id));}
  const backendSearch=f.backend.search.bind(f.backend),snap=f.index.snapshot();
  const wrong=[...f.backend.collections.get(snap.collection_name).points.values()].filter(p=>[surrogate([f.auth.user_id,b.memory_id]),surrogate([otherAuth.user_id,foreign.memory_id])].includes(p.payload.document));
  f.backend.search=async(...args)=>[...wrong,...await backendSearch(...args)];
  const protectedRead=await f.index.search(f.auth,{query:'网络',project_id:'synthetic-project-a',mode:'semantic'});assert.ok(protectedRead.results.every(r=>![b.memory_id,foreign.memory_id].includes(r.memory_id)));
  const model=organizer(),jobs=new MemoryJobs(f.s);scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy,type:'summary',includeOpen:true});await new MemoryWorker(f.s,jobs,model).drain();
  const summaries=f.s.memorySummaries(f.auth,{scope:'project',project_id:'synthetic-project-a'});assert.ok(summaries.results.length);assert.ok(summaries.results.every(s=>s.claims.every(c=>c.memory_id===a.memory_id)));
});
test('V-08 C-05: restored SQLite disables future vector generation even if external points survive',async t=>{
  const f=await indexed(t),filename=f.root+'/synthetic-backup.sqlite3';await createMemoryBackup(f.s,filename);
  f.save('Future network fact not in snapshot');await f.index.sync(f.generation);const points=f.backend.collections.get(f.index.snapshot().collection_name).points.size;
  const restored=f.root+'/restored-future.sqlite3';await restoreIsolatedBackup(filename,restored);const db=new DatabaseSync(restored,{readOnly:true});
  try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_vector_active').get().n,0);assert.equal(db.prepare('SELECT state FROM memory_vector_generations').get().state,'restore_invalidated');assert.equal(points,3);}finally{db.close();}
});
test('R-04: exact identifiers beat longer prefixes even when semantic rank prefers a near version',async t=>{
  const f=await indexed(t),near=f.save('Network router version 17.9.80 is NOT the requested release.');await f.index.sync(f.generation);
  const rows=[...f.backend.collections.get(f.index.snapshot().collection_name).points.values()];
  const point=m=>rows.find(p=>p.payload.document===surrogate([f.auth.user_id,m.memory_id]));
  f.backend.search=async()=>[point(near),point(f.a)];
  const result=await f.index.search(f.auth,{query:'17.9.8',mode:'semantic'});
  assert.equal(result.results[0].memory_id,f.a.memory_id);
});
test('R-04 R-08: exact prioritization reads the authoritative source, not its truncated result preview',async t=>{
  const f=await indexed(t),late=f.save('Synthetic network filler '.repeat(65)+'Pinned release 28.4.2.'),near=f.save('Network release 28.4.20 is different.');await f.index.sync(f.generation);
  const rows=[...f.backend.collections.get(f.index.snapshot().collection_name).points.values()];
  const point=m=>rows.find(p=>p.payload.document===surrogate([f.auth.user_id,m.memory_id]));f.backend.search=async()=>[point(near),point(late)];
  const result=await f.index.search(f.auth,{query:'28.4.2',mode:'semantic'});assert.equal(result.results[0].memory_id,late.memory_id);assert.equal(result.results[0].content_truncated,true);
});

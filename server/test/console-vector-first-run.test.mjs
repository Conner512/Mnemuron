import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {fail} from '../lib/model-providers/contracts.mjs';
import {QdrantStore,vectorConfig,QDRANT_PROTOCOL} from '../lib/vector-stores/qdrant.mjs';
import {manifestDigest} from '../lib/console/service.mjs';

// FIRST-RUN: synthetic embedder (loopback HTTP) and a synthetic pre-created vector store only.
// No real model, Qdrant, credential, memory or database is used.
class PrecreatedStore extends MockVectorStore {
  constructor(names,{dimensions=3}={}){super();this.precreated=names;this.created=0;this.expired=false;
    for(const name of names)this.collections.set(name,{config:{dimensions,distance:'Cosine'},points:new Map()});}
  available(){if(this.expired)fail('VECTOR_AUTH_FAILED');super.available();}
  async ensureCollection(name,config){this.available();if(!this.precreated.includes(name)||!this.collections.has(name))fail('VECTOR_COLLECTION_MISSING');
    if(JSON.stringify(this.collections.get(name).config)!==JSON.stringify(config))fail('VECTOR_PROFILE_MISMATCH');}
  points(){return [...this.collections.values()].reduce((n,c)=>n+c.points.size,0);}
}

async function setup(t,{names=['synthetic_first_v1','synthetic_second_v1'],dims=3}={}){
  const f=await memoryFixture(t),key=f.root+'/vector-test.key';fs.writeFileSync(key,randomBytes(32).toString('base64url'),{mode:0o600});
  const calls=[];let outputDims=dims;
  const model=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push(body);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({data:body.input.map((text,index)=>({index,embedding:/network|router/i.test(text)?[1,0,0].slice(0,outputDims).concat(Array(Math.max(0,outputDims-3)).fill(0)):[0,0,1].slice(0,outputDims).concat(Array(Math.max(0,outputDims-3)).fill(0))}))}));
  });await new Promise(r=>model.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>model.close(r)));
  const origin=`http://127.0.0.1:${model.address().port}`;
  f.store.memoryConfig.console={key_file:key,worker_enabled:true,allowed_private_origins:[origin]};
  f.store.memoryConfig.vector_store={enabled:true,collection_prefix:'synthetic'};
  const backend=new PrecreatedStore(names);f.store.consoleService.vectorBackend=()=>backend;
  const issue=user=>{const c=f.store.issueCredential({userId:user,deviceId:'synthetic-vector',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES});return {...c,auth:f.store.authenticate(c.api_key)};};
  const a=issue(f.a.auth.user_id),b=issue(f.other.auth.user_id),service=f.store.consoleService;
  const config={enabled:true,protocol:'openai_compatible',base_url:origin,model:'synthetic-embedding',profile_revision:'1',daily_requests:100,output_tokens:4096,batch_size:5,sensitivities:['public','internal','sensitive'],egress_approved:true,query_approved:true,dimensions:dims};
  const act=(action,payload,owner=a,operation_id=randomUUID())=>service.execute(owner.auth,{action,payload,operation_id});
  const save=(overrides={},revision=0,owner=a)=>act('models.save',{kind:'embedder',expected_revision:revision,config:{...config,...overrides}},owner);
  const status=(owner=a)=>service.processing(owner.auth.user_id).vector;
  const drain=async()=>{for(let n=0;n<40;n++){await service.tick();const s=status().first_run;if(!['pending'].includes(s?.build))return s;}throw new Error('build did not settle');};
  const create=(content,extra={},owner=a)=>act('memory.create',{scope:'user',content,...extra},owner).then(r=>r.memory_id);
  return {...f,calls,backend,a,b,service,act,save,status,drain,create,outputDims:n=>{outputDims=n;}};
}
// Five eligible records, one secret, one retracted, one superseded (its replacement is active), one foreign.
async function seed(f){
  const ids={};
  ids.network=await f.create('Synthetic network router decision.');
  ids.publicNote=await f.create('Synthetic public note.',{sensitivity:'public'});
  ids.internal=await f.create('Synthetic internal note.',{sensitivity:'internal'});
  ids.secret=await f.create('Synthetic SECRET must never be sent.',{sensitivity:'secret'});
  ids.retracted=await f.create('Synthetic HISTORY retracted text.');
  await f.act('memory.retract',{memory_id:ids.retracted,revision:1});
  ids.old=await f.create('Synthetic OLDVERSION text.');
  ids.replacement=(await f.act('memory.correct',{memory_id:ids.old,revision:1,content:'Synthetic corrected text.'})).memory_id;
  ids.plain=await f.create('Synthetic plain note.');
  ids.foreign=await f.create('Synthetic FOREIGN account text.',{},f.b);
  return ids;
}
const sentText=f=>JSON.stringify(f.calls);

test('FIRST-RUN-01: prepare → probe → confirmed build of exactly the manifest → explicit activation → no catch-up → deactivate/reactivate',async t=>{
  const f=await setup(t),ids=await seed(f);await f.save();
  const prepared=await f.act('vector.prepare',{budget_calls:20});
  assert.equal(prepared.status,'prepared');assert.equal(prepared.collection,'synthetic_first_v1','an operator pre-created collection inside the prefix');
  assert.equal(prepared.manifest.count,5);assert.deepEqual(prepared.manifest.excluded,{inactive:2,secret_or_unavailable:1,sensitivity_not_approved:0});
  assert.equal(prepared.probe_required,true);assert.deepEqual([prepared.budget.total,prepared.budget.used],[20,0]);assert.equal(prepared.catch_up,false);
  assert.equal(f.calls.length,0,'prepare sends nothing');
  const confirm={generation:prepared.generation,expected_count:5,expected_digest:prepared.manifest.digest};
  await assert.rejects(()=>f.act('vector.schedule',confirm),e=>e.errorCode==='PROBE_REQUIRED');
  // Synthetic dimension probe: 2 calls, counted in the first-run budget.
  const probe=await f.act('models.test',{kind:'embedder',mode:'capabilities'});
  assert.equal(probe.dimensions,3);assert.equal(probe.real_memory_sent,false);assert.equal(f.calls.length,2);assert.equal(f.status().first_run.budget.used,2);
  await assert.rejects(()=>f.act('vector.schedule',{...confirm,expected_count:4}),e=>e.errorCode==='MANIFEST_CHANGED');
  await assert.rejects(()=>f.act('vector.schedule',{...confirm,expected_digest:'0'.repeat(64)}),e=>e.errorCode==='MANIFEST_CHANGED');
  assert.equal((await f.act('vector.schedule',confirm)).activation,'explicit');
  const built=await f.drain();
  assert.equal(built.build,'built');assert.deepEqual([built.manifest.indexed,built.manifest.pending,built.manifest.stale],[5,0,0]);
  assert.equal(f.calls.length,7,'2 probe + exactly one call per manifest record');assert.equal(built.budget.used,7);
  for(const forbidden of ['SECRET','HISTORY','OLDVERSION','FOREIGN'])assert.ok(!sentText(f).includes(forbidden),forbidden);
  assert.equal(f.backend.created,0,'never creates a collection');
  // Built, but not serving until explicitly activated.
  assert.equal(built.serving,false);assert.ok(f.status().search_blockers.includes('VECTOR_NOT_READY'));
  await assert.rejects(()=>f.store.searchMemories(f.a.auth,{query:'network',mode:'semantic',personal_model_only:true}),e=>e.code==='SEMANTIC_UNAVAILABLE');
  const activated=await f.act('vector.activate',{generation:prepared.generation});assert.equal(activated.status,'activated');
  assert.equal(f.status().search_ready,true);assert.equal(f.status().first_run.serving,true);
  const found=await f.store.searchMemories(f.a.auth,{query:'network',mode:'semantic',personal_model_only:true});
  assert.equal(found.results[0].memory_id,ids.network);assert.equal(f.status().first_run.budget.used,8,'a query counts too');
  // No automatic catch-up: a new memory is not indexed and no call is made, however long the worker runs.
  const later=await f.create('Synthetic network added after activation.');const before=f.calls.length;
  for(let n=0;n<5;n++)await f.service.tick();
  assert.equal(f.calls.length,before);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_vector_documents WHERE memory_id=?').get(later).n,0);
  await assert.rejects(()=>f.act('vector.schedule',{}),e=>e.errorCode==='FIRST_RUN_ACTIVE','the ordinary full rebuild cannot bypass first-run mode');
  // Hybrid still finds the new record lexically.
  assert.ok((await f.store.searchMemories(f.a.auth,{query:'added after activation',mode:'hybrid',personal_model_only:true})).results.some(r=>r.memory_id===later));
  // Rollback: deactivate stops serving (lexical fallback); nothing is deleted; reactivation needs no new embedding.
  const points=f.backend.points();
  assert.equal((await f.act('vector.deactivate',{generation:prepared.generation})).status,'deactivated');
  const degraded=await f.store.searchMemories(f.a.auth,{query:'network',mode:'hybrid',personal_model_only:true});
  assert.equal(degraded.retrieval.effective_mode,'lexical');assert.equal(degraded.retrieval.degradation_code,'VECTOR_NOT_READY');
  assert.equal(f.backend.points(),points);assert.equal(f.status().first_run.serving,false);
  const callsBefore=f.calls.length;await f.act('vector.activate',{generation:prepared.generation});assert.equal(f.calls.length,callsBefore);
  // Another account cannot see or act on this generation.
  for(const action of ['vector.activate','vector.deactivate'])await assert.rejects(()=>f.act(action,{generation:prepared.generation},f.b),e=>e.errorCode==='VECTOR_NOT_FOUND');
  assert.equal(f.status(f.b).first_run.generation,undefined);
});

test('FIRST-RUN-02: the total budget is hard (probe, build, retries and queries); build calls replace the daily cap, nothing else does',async t=>{
  const f=await setup(t);await seed(f);await f.save({daily_requests:4});
  // A budget that cannot cover the probe plus one call per record is refused before anything opens.
  await assert.rejects(()=>f.act('vector.prepare',{budget_calls:6}),e=>e.errorCode==='MANIFEST_EXCEEDS_BUDGET');assert.equal(f.status().first_run.budget,null);
  const prepared=await f.act('vector.prepare',{budget_calls:7});
  // Two probes use 4 units and the whole daily cap (4); build calls still proceed, but only up to the total.
  for(let n=0;n<2;n++)await f.act('models.test',{kind:'embedder',mode:'capabilities'});assert.equal(f.calls.length,4);
  await f.act('vector.schedule',{generation:prepared.generation,expected_count:5,expected_digest:prepared.manifest.digest});
  const stopped=await f.drain();
  assert.equal(stopped.build,'failed');assert.equal(stopped.error_code,'BUDGET_EXHAUSTED');
  assert.equal(f.calls.length,7,'never more than the total; build calls passed the exhausted daily cap');
  assert.deepEqual([stopped.budget.used,stopped.budget.remaining],[7,0]);assert.equal(stopped.manifest.indexed,3);
  for(let n=0;n<5;n++)await f.service.tick();assert.equal(f.calls.length,7,'a failed build is never retried automatically');
  // A retry is an explicit schedule, and it still cannot pass the total.
  await f.act('vector.schedule',{generation:prepared.generation,expected_count:5,expected_digest:prepared.manifest.digest});await f.drain();assert.equal(f.calls.length,7);
  await assert.rejects(()=>f.act('models.test',{kind:'embedder',mode:'capabilities'}),e=>e.code==='BUDGET_EXHAUSTED');assert.equal(f.calls.length,7);
  // The budget is never raised or reset from the console, and a started build cannot be re-prepared.
  await assert.rejects(()=>f.act('vector.prepare',{budget_calls:150}),e=>e.errorCode==='BUDGET_ALREADY_SET');
  await assert.rejects(()=>f.act('vector.prepare',{budget_calls:7}),e=>e.errorCode==='FIRST_RUN_IN_PROGRESS');
  for(const value of [0,151,'150'])await assert.rejects(()=>f.act('vector.prepare',{budget_calls:value}),e=>e.statusCode===400);
});

test('FIRST-RUN-03: a manifest record changed after freezing is skipped as stale, never re-read; activation reports it',async t=>{
  const f=await setup(t),ids=await seed(f);await f.save();
  const prepared=await f.act('vector.prepare',{budget_calls:20});await f.act('models.test',{kind:'embedder',mode:'capabilities'});
  await f.act('memory.correct',{memory_id:ids.plain,revision:1,content:'Synthetic CHANGED after the manifest.'});
  await f.act('vector.schedule',{generation:prepared.generation,expected_count:5,expected_digest:prepared.manifest.digest});
  const built=await f.drain();assert.deepEqual([built.manifest.indexed,built.manifest.stale],[4,1]);
  assert.ok(!sentText(f).includes('CHANGED'));assert.equal(f.calls.length,6);
  await f.act('vector.activate',{generation:prepared.generation});assert.equal(f.status().search_ready,true);
});

test('FIRST-RUN-04: pre-created collections are validated, never created; an expired vector key fails before any embedding call',async t=>{
  const f=await setup(t,{names:['synthetic_only_v1']});await seed(f);await f.save();
  let prepared=await f.act('vector.prepare',{budget_calls:20});
  // Re-preparing an untouched generation frees its collection instead of consuming another.
  prepared=await f.act('vector.prepare',{budget_calls:20});assert.equal(prepared.collection,'synthetic_only_v1');
  await f.act('models.test',{kind:'embedder',mode:'capabilities'});const confirm={generation:prepared.generation,expected_count:5,expected_digest:prepared.manifest.digest};
  f.backend.expired=true;await f.act('vector.schedule',confirm);let s=await f.drain();
  assert.deepEqual([s.build,s.error_code,s.budget.used,f.calls.length],['failed','VECTOR_AUTH_FAILED',2,2],'no embedding is spent against an unusable store');
  assert.notEqual(f.store.db.prepare("SELECT state FROM memory_profile_state WHERE profile LIKE 'console-%'").get()?.state,'blocked_auth','a vector key failure never blocks the embedding model');
  f.backend.expired=false;f.backend.collections.delete('synthetic_only_v1');
  await f.act('vector.schedule',confirm);s=await f.drain();assert.deepEqual([s.error_code,f.calls.length],['VECTOR_COLLECTION_MISSING',2]);
  f.backend.collections.set('synthetic_only_v1',{config:{dimensions:4,distance:'Cosine'},points:new Map()});
  await f.act('vector.schedule',confirm);s=await f.drain();assert.deepEqual([s.error_code,f.calls.length],['VECTOR_PROFILE_MISMATCH',2]);
  f.backend.collections.set('synthetic_only_v1',{config:{dimensions:3,distance:'Cosine'},points:new Map()});
  await f.act('vector.schedule',confirm);s=await f.drain();assert.equal(s.build,'built');await f.act('vector.activate',{generation:prepared.generation});
  assert.equal(f.backend.created,0);
  // The scoped key expires after activation: search degrades to lexical and says why.
  f.backend.expired=true;const r=await f.store.searchMemories(f.a.auth,{query:'network',mode:'hybrid',personal_model_only:true});
  assert.deepEqual([r.retrieval.effective_mode,r.retrieval.degradation_code],['lexical','VECTOR_AUTH_FAILED']);
  // Every pre-created collection is in use: a further build is refused rather than created.
  f.backend.expired=false;const profile=f.store.db.prepare('SELECT profile FROM memory_vector_generations WHERE generation=?').get(prepared.generation).profile;
  assert.throws(()=>f.store.consoleService.vector(f.a.auth.user_id).begin(profile),e=>e.code==='VECTOR_COLLECTION_UNAVAILABLE');
});

test('FIRST-RUN-05: the probe must return the configured dimensions before any real indexing',async t=>{
  const f=await setup(t);await seed(f);await f.save();f.outputDims(4);
  const prepared=await f.act('vector.prepare',{budget_calls:20});
  await assert.rejects(()=>f.act('models.test',{kind:'embedder',mode:'capabilities'}),e=>e.code==='INVALID_EMBEDDING');
  await assert.rejects(()=>f.act('vector.schedule',{generation:prepared.generation,expected_count:5,expected_digest:prepared.manifest.digest}),e=>e.errorCode==='PROBE_REQUIRED');
  assert.equal(f.calls.length,1,'the failed probe stops after its first call');
});

test('FIRST-RUN-06: a later model change does not silently break the serving index; disabling the model stops it',async t=>{
  const f=await setup(t),ids=await seed(f);await f.save();
  const prepared=await f.act('vector.prepare',{budget_calls:30});await f.act('models.test',{kind:'embedder',mode:'capabilities'});
  await f.act('vector.schedule',{generation:prepared.generation,expected_count:5,expected_digest:prepared.manifest.digest});await f.drain();
  await f.act('vector.activate',{generation:prepared.generation});
  await f.save({model:'synthetic-embedding-next',profile_revision:'2'},1);
  const s=f.status();assert.equal(s.search_ready,true);assert.equal(s.serving_profile_differs,true);assert.ok(!s.search_blockers.includes('VECTOR_PROFILE_MISMATCH'));
  const r=await f.store.searchMemories(f.a.auth,{query:'network',mode:'semantic',personal_model_only:true});
  assert.equal(r.results[0].memory_id,ids.network);assert.equal(f.calls.at(-1).model,'synthetic-embedding','queries use the profile the index was built with');
  // Consent is current: disabling the embedder stops the retained profile as well.
  await f.act('models.disable',{kind:'embedder',expected_revision:2});
  const off=await f.store.searchMemories(f.a.auth,{query:'network',mode:'hybrid',personal_model_only:true});
  assert.equal(off.retrieval.effective_mode,'lexical');assert.equal(f.calls.at(-1).model,'synthetic-embedding');
});

test('FIRST-RUN-07: runtime config honours the prefix and pre-created names; the Qdrant client never creates them and maps an expired key',async()=>{
  const base={enabled:true,protocol:QDRANT_PROTOCOL,base_url:'http://127.0.0.1:6333',collection_prefix:'mnemuron_vec',auth:{env:'SYNTHETIC_VECTOR_KEY'},
    egress:{approved:true,origins:['http://127.0.0.1:6333'],addresses:['127.0.0.1'],allow_private:true},timeouts:{request_ms:1000},limits:{input_bytes:100000,output_bytes:100000}};
  assert.deepEqual(vectorConfig({...base,precreated_collections:['mnemuron_vec_embed768_v1']}).precreated_collections,['mnemuron_vec_embed768_v1']);
  for(const names of [[],['other_prefix_v1'],['mnemuron_vec_a','mnemuron_vec_a'],['Mnemuron_vec_upper'],'mnemuron_vec_x'])
    assert.throws(()=>vectorConfig({...base,precreated_collections:names}),String(names));
  const requests=[];let mode='ok';
  const transport=async(_p,route,body,{method})=>{requests.push([method,route]);
    if(mode==='expired'){const e=new Error('auth');e.code='AUTH_FAILED';throw e;}
    if(route.endsWith('/exists'))return {result:{exists:mode!=='missing'}};
    return {result:{config:{params:{vectors:{size:mode==='mismatch'?3:768,distance:'Cosine'}}}}};};
  const store=new QdrantStore({...base,precreated_collections:['mnemuron_vec_embed768_v1']},{transport,env:{SYNTHETIC_VECTOR_KEY:'synthetic-only'}});
  await store.ensureCollection('mnemuron_vec_embed768_v1',{dimensions:768,distance:'Cosine'});
  for(const [m,code] of [['missing','VECTOR_COLLECTION_MISSING'],['mismatch','VECTOR_PROFILE_MISMATCH'],['expired','VECTOR_AUTH_FAILED']]){mode=m;
    await assert.rejects(()=>store.ensureCollection('mnemuron_vec_embed768_v1',{dimensions:768,distance:'Cosine'}),e=>e.code===code,m);}
  await assert.rejects(()=>store.ensureCollection('mnemuron_vec_unlisted',{dimensions:768,distance:'Cosine'}),e=>e.code==='VECTOR_COLLECTION_MISSING');
  assert.ok(requests.every(([method])=>method==='GET'),'a pre-created deployment only reads collection metadata');
  await assert.rejects(()=>new QdrantStore(base,{transport,env:{}}).health(),e=>e.code==='VECTOR_AUTH_FAILED','a missing key is a vector auth failure');
});

test('FIRST-RUN-08: the manifest digest is order independent and bound to exact revisions',()=>{
  const items=[{memory_id:'b',revision:1,state_hash:'x'},{memory_id:'a',revision:2,state_hash:'y'}];
  assert.equal(manifestDigest(items),manifestDigest([...items].reverse()));
  assert.notEqual(manifestDigest(items),manifestDigest([{...items[0],revision:2},items[1]]));
  assert.match(manifestDigest(items),/^[a-f0-9]{64}$/);
});

test('FIRST-RUN-09: after rollback a new first run is refused clearly; a provider (origin) change stops the retained profile',async t=>{
  const f=await setup(t),ids=await seed(f);await f.save();
  const prepared=await f.act('vector.prepare',{budget_calls:30});await f.act('models.test',{kind:'embedder',mode:'capabilities'});
  await f.act('vector.schedule',{generation:prepared.generation,expected_count:5,expected_digest:prepared.manifest.digest});await f.drain();
  await f.act('vector.activate',{generation:prepared.generation});await f.act('vector.deactivate',{generation:prepared.generation});
  await assert.rejects(()=>f.act('vector.prepare',{budget_calls:30}),e=>e.errorCode==='FIRST_RUN_EXISTS');
  await f.act('vector.activate',{generation:prepared.generation});
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM console_vector_profiles WHERE secret_cipher IS NOT NULL').get().n,0,'keys are never copied into retained profiles');
  // Moving the embedder to another origin drops its key by design; the old profile must not keep receiving queries.
  const other='http://127.0.0.2:9';f.store.memoryConfig.console.allowed_private_origins.push(other);
  await f.save({base_url:other},1);const before=f.calls.length;
  const s=f.status();assert.equal(s.search_ready,false);assert.ok(s.search_blockers.includes('VECTOR_PROFILE_MISMATCH'));
  const r=await f.store.searchMemories(f.a.auth,{query:'network',mode:'hybrid',personal_model_only:true});
  assert.equal(r.retrieval.effective_mode,'lexical');assert.equal(f.calls.length,before,'no query reaches the previous provider');
  assert.ok(r.results.some(m=>m.memory_id===ids.network));
});

const embedderUsage=f=>{const {used,limit,remaining,first_run_build_calls,total_requests}=f.service.features.read(f.a.auth,'model-usage',{}).models.find(m=>m.kind==='embedder');
  return {used,limit,remaining,first_run_build_calls,total_requests};};
const hybrid=(f,query='synthetic network')=>f.store.searchMemories(f.a.auth,{query,mode:'hybrid',personal_model_only:true});
const firstRunBuild=async(f,budget)=>{const p=await f.act('vector.prepare',{budget_calls:budget});await f.act('models.test',{kind:'embedder',mode:'capabilities'});
  await f.act('vector.schedule',{generation:p.generation,expected_count:p.manifest.count,expected_digest:p.manifest.digest});
  const built=await f.drain();assert.equal(built.build,'built');await f.act('vector.activate',{generation:p.generation});return p;};

test('FIRST-RUN-11: manifest build calls draw on the first-run total, not the daily query/probe allowance; readiness reports daily exhaustion',async t=>{
  const f=await setup(t),ids=await seed(f);await f.save({daily_requests:4});
  await firstRunBuild(f,20);assert.equal(f.calls.length,7,'2 probe + 5 build');
  assert.equal(f.status().search_ready,true,'two probe calls leave two of four daily calls');
  assert.deepEqual(embedderUsage(f),{used:2,limit:4,remaining:2,first_run_build_calls:5,total_requests:7});
  for(let n=0;n<2;n++){const r=await hybrid(f);assert.equal(r.retrieval.effective_mode,'hybrid');assert.equal(r.results[0].memory_id,ids.network);}
  assert.equal(f.calls.length,9);
  // Daily allowance used up: readiness says so, a query falls back without a model call, a probe is refused, and the
  // refused calls are not charged to the total.
  const s=f.status();assert.equal(s.search_ready,false);assert.deepEqual(s.search_blockers,['DAILY_BUDGET_EXHAUSTED']);
  const r=await hybrid(f);assert.deepEqual([r.retrieval.effective_mode,r.retrieval.degradation_code],['lexical','BUDGET_EXHAUSTED']);
  await assert.rejects(()=>f.act('models.test',{kind:'embedder',mode:'capabilities'}),e=>e.code==='BUDGET_EXHAUSTED');
  assert.equal(f.calls.length,9);assert.deepEqual([f.status().first_run.budget.used,f.status().first_run.budget.remaining],[9,11],'the total counts every request made');
  assert.deepEqual(embedderUsage(f),{used:4,limit:4,remaining:0,first_run_build_calls:5,total_requests:9});
  // Existing accounting tables keep their meaning: daily vector counters hold queries only; build calls are kept apart.
  const db=f.store.db,sum=table=>db.prepare(`SELECT COALESCE(SUM(count),0) n FROM ${table}`).get().n;
  assert.deepEqual([sum('memory_vector_calls'),sum('memory_owner_vector_usage'),sum('memory_owner_vector_build_usage')],[2,2,5]);
});

test('FIRST-RUN-12: a 103-record build with daily limit 25 leaves same-day semantic queries their daily allowance, then exhausts it',async t=>{
  const f=await setup(t);const network=await f.create('Synthetic network router decision.');
  for(let n=1;n<103;n++)await f.create(`Synthetic acceptance note ${n}.`);
  await f.save({daily_requests:25});
  const p=await firstRunBuild(f,150);assert.equal(p.manifest.count,103);assert.equal(f.calls.length,105);
  assert.equal(f.status().search_ready,true);assert.deepEqual(f.status().first_run.budget.remaining,45);
  // 25 daily - 2 probes = 23 same-day semantic queries.
  for(let n=0;n<23;n++){const r=await hybrid(f);assert.equal(r.retrieval.effective_mode,'hybrid',`query ${n+1}`);assert.equal(r.results[0].memory_id,network);}
  assert.equal(f.calls.length,128);
  const s=f.status();assert.equal(s.search_ready,false);assert.deepEqual(s.search_blockers,['DAILY_BUDGET_EXHAUSTED']);
  const r=await hybrid(f);assert.deepEqual([r.retrieval.effective_mode,r.retrieval.degradation_code],['lexical','BUDGET_EXHAUSTED']);
  assert.equal(f.calls.length,128);assert.deepEqual([s.first_run.budget.used,s.first_run.budget.remaining],[128,22]);
  assert.deepEqual(embedderUsage(f),{used:25,limit:25,remaining:0,first_run_build_calls:103,total_requests:128});
});

test('FIRST-RUN-13: an exhausted first-run total stops queries and probes, is reported by readiness, and is never reset',async t=>{
  const f=await setup(t);await seed(f);await f.save();
  const p=await firstRunBuild(f,9);
  for(let n=0;n<2;n++)assert.equal((await hybrid(f)).retrieval.effective_mode,'hybrid');
  assert.equal(f.calls.length,9);
  let s=f.status();assert.equal(s.search_ready,false);assert.deepEqual(s.search_blockers,['FIRST_RUN_BUDGET_EXHAUSTED'],'the daily allowance (100) is not the cause');
  assert.deepEqual([s.first_run.budget.used,s.first_run.budget.remaining],[9,0]);
  const r=await hybrid(f);assert.deepEqual([r.retrieval.effective_mode,r.retrieval.degradation_code],['lexical','BUDGET_EXHAUSTED']);
  await assert.rejects(()=>f.act('models.test',{kind:'embedder',mode:'capabilities'}),e=>e.code==='BUDGET_EXHAUSTED');
  await assert.rejects(()=>f.act('vector.prepare',{budget_calls:150}),e=>e.errorCode==='BUDGET_ALREADY_SET');
  await assert.rejects(()=>f.act('vector.prepare',{budget_calls:9}),e=>e.errorCode==='MANIFEST_EXCEEDS_BUDGET');
  await assert.rejects(()=>f.act('vector.schedule',{}),e=>e.errorCode==='FIRST_RUN_ACTIVE');
  assert.equal(f.calls.length,9);s=f.status();assert.deepEqual([s.first_run.budget.total,s.first_run.budget.used],[9,9]);
  // Rollback keeps reporting the exhausted total next to the inactive index.
  await f.act('vector.deactivate',{generation:p.generation});
  assert.deepEqual(f.status().search_blockers,['VECTOR_NOT_READY','FIRST_RUN_BUDGET_EXHAUSTED']);
});

test('FIRST-RUN-10: the read scope reports a legacy account read-all and the operator inspection uses the configured policy',async t=>{
  const f=await setup(t),m=await f.create('Synthetic sensitive record without a grant.');
  const caps=()=>f.service.capabilities(f.a.auth).read_policy;
  assert.equal(caps().legacy_read_all,false);
  f.store.webVisibility.setPolicy(f.a.auth,{read_all:true,expected_revision:0});assert.equal(caps().legacy_read_all,true);
  f.store.webVisibility.setPolicy(f.a.auth,{read_all:false,expected_revision:1});
  const admin={...f.a.auth,scopes:[...f.a.auth.scopes,'admin:tasks']};
  assert.deepEqual([f.store.webVisibility.inspect(admin,m).allowed,f.store.webVisibility.inspect(admin,m).policy],[false,'web-memory-visibility-v1']);
  f.store.runtime.agentReadPolicy='active_uniform_v1';
  assert.deepEqual([f.store.webVisibility.inspect(admin,m).allowed,f.store.webVisibility.inspect(admin,m).policy],[true,'web-memory-active-uniform-v1']);
});

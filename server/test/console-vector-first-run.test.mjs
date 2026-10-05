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
  const f=await setup(t);await seed(f);await f.save({daily_requests:2});
  const prepared=await f.act('vector.prepare',{budget_calls:4});
  await f.act('models.test',{kind:'embedder',mode:'capabilities'});assert.equal(f.calls.length,2);
  await f.act('vector.schedule',{generation:prepared.generation,expected_count:5,expected_digest:prepared.manifest.digest});
  const stopped=await f.drain();
  assert.equal(stopped.build,'failed');assert.equal(stopped.error_code,'BUDGET_EXHAUSTED');
  assert.equal(f.calls.length,4,'never more than the total, although the daily cap (2) was already used by the probe');
  assert.deepEqual([stopped.budget.used,stopped.budget.remaining],[4,0]);assert.equal(stopped.manifest.indexed,2);
  for(let n=0;n<5;n++)await f.service.tick();assert.equal(f.calls.length,4,'a failed build is never retried automatically');
  // A retry is an explicit schedule, and it still cannot pass the total.
  await f.act('vector.schedule',{generation:prepared.generation,expected_count:5,expected_digest:prepared.manifest.digest});await f.drain();assert.equal(f.calls.length,4);
  await assert.rejects(()=>f.act('models.test',{kind:'embedder',mode:'capabilities'}),e=>e.code==='BUDGET_EXHAUSTED');assert.equal(f.calls.length,4);
  // The budget is never raised or reset from the console, and a started build cannot be re-prepared.
  await assert.rejects(()=>f.act('vector.prepare',{budget_calls:150}),e=>e.errorCode==='BUDGET_ALREADY_SET');
  await assert.rejects(()=>f.act('vector.prepare',{budget_calls:4}),e=>e.errorCode==='FIRST_RUN_IN_PROGRESS');
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
  const base={enabled:true,protocol:QDRANT_PROTOCOL,base_url:'http://127.0.0.1:6333',collection_prefix:'mnemuron_ct',auth:{env:'SYNTHETIC_VECTOR_KEY'},
    egress:{approved:true,origins:['http://127.0.0.1:6333'],addresses:['127.0.0.1'],allow_private:true},timeouts:{request_ms:1000},limits:{input_bytes:100000,output_bytes:100000}};
  assert.deepEqual(vectorConfig({...base,precreated_collections:['mnemuron_ct_gemini768_v1']}).precreated_collections,['mnemuron_ct_gemini768_v1']);
  for(const names of [[],['other_prefix_v1'],['mnemuron_ct_a','mnemuron_ct_a'],['Mnemuron_ct_upper'],'mnemuron_ct_x'])
    assert.throws(()=>vectorConfig({...base,precreated_collections:names}),String(names));
  const requests=[];let mode='ok';
  const transport=async(_p,route,body,{method})=>{requests.push([method,route]);
    if(mode==='expired'){const e=new Error('auth');e.code='AUTH_FAILED';throw e;}
    if(route.endsWith('/exists'))return {result:{exists:mode!=='missing'}};
    return {result:{config:{params:{vectors:{size:mode==='mismatch'?3:768,distance:'Cosine'}}}}};};
  const store=new QdrantStore({...base,precreated_collections:['mnemuron_ct_gemini768_v1']},{transport,env:{SYNTHETIC_VECTOR_KEY:'synthetic-only'}});
  await store.ensureCollection('mnemuron_ct_gemini768_v1',{dimensions:768,distance:'Cosine'});
  for(const [m,code] of [['missing','VECTOR_COLLECTION_MISSING'],['mismatch','VECTOR_PROFILE_MISMATCH'],['expired','VECTOR_AUTH_FAILED']]){mode=m;
    await assert.rejects(()=>store.ensureCollection('mnemuron_ct_gemini768_v1',{dimensions:768,distance:'Cosine'}),e=>e.code===code,m);}
  await assert.rejects(()=>store.ensureCollection('mnemuron_ct_unlisted',{dimensions:768,distance:'Cosine'}),e=>e.code==='VECTOR_COLLECTION_MISSING');
  assert.ok(requests.every(([method])=>method==='GET'),'a pre-created deployment only reads collection metadata');
  await assert.rejects(()=>new QdrantStore(base,{transport,env:{}}).health(),e=>e.code==='VECTOR_AUTH_FAILED','a missing key is a vector auth failure');
});

test('FIRST-RUN-08: the manifest digest is order independent and bound to exact revisions',()=>{
  const items=[{memory_id:'b',revision:1,state_hash:'x'},{memory_id:'a',revision:2,state_hash:'y'}];
  assert.equal(manifestDigest(items),manifestDigest([...items].reverse()));
  assert.notEqual(manifestDigest(items),manifestDigest([{...items[0],revision:2},items[1]]));
  assert.match(manifestDigest(items),/^[a-f0-9]{64}$/);
});

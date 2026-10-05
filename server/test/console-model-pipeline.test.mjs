import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {VectorIndex} from '../lib/vector-stores/index.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {ConsoleState} from '../lib/console/state.mjs';

async function setup(t){
 const f=await memoryFixture(t),key=f.root+'/model-test.key';fs.writeFileSync(key,randomBytes(32).toString('base64url'),{mode:0o600});
 const calls=[];let invalid=false,release=null,remoteStatus=200;
 const model=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push(body);if(release)await release;
  const input=body.messages?JSON.parse(body.messages[1].content).input:null;
  if(remoteStatus!==200){res.writeHead(remoteStatus,{'content-type':'application/json'});res.end(JSON.stringify({error:'Synthetic upstream-private-error-body'}));return;}
  const data=input?.sources?{results:input.sources.map(s=>input.operation==='classification'?{memory_id:s.memory_id,category:'technical',tags:['synthetic']}:{memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:invalid?'Invented quote':s.content})}:{ok:true};
  res.setHeader('content-type','application/json');res.end(JSON.stringify(body.input?{data:body.input.map((_,index)=>({index,embedding:invalid?[1,0]:[1,0,0]}))}:{choices:[{finish_reason:'stop',message:{content:JSON.stringify(data)}}]}));
 });await new Promise(r=>model.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>model.close(r)));
 const origin=`http://127.0.0.1:${model.address().port}`;f.store.memoryConfig.console={key_file:key,worker_enabled:false,allowed_private_origins:[origin]};
 const issue=user=>{const c=f.store.issueCredential({userId:user,deviceId:'synthetic-model-test',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES});return {...c,auth:f.store.authenticate(c.api_key)};};
 const a=issue(f.a.auth.user_id),b=issue(f.other.auth.user_id),service=f.store.consoleService;
 const config={enabled:true,protocol:'openai_compatible',base_url:origin,model:'synthetic-model',profile_revision:'1',daily_requests:100,output_tokens:4096,batch_size:5,sensitivities:['public','internal','sensitive'],egress_approved:true,query_approved:true};
 const act=(action,payload,owner=a,operation_id=randomUUID())=>service.execute(owner.auth,{action,payload,operation_id});
 const save=(kind,overrides={},revision=0,owner=a)=>act('models.save',{kind,expected_revision:revision,config:{...config,...(kind==='embedder'?{dimensions:3}:{}),...overrides}},owner);
 const read=(owner=a)=>f.request('GET','/v1/console/models',undefined,owner).then(r=>{assert.equal(r.status,200);return r.body;});
 return {...f,a,b,service,config,calls,act,save,read,invalid:()=>{invalid=true;},remoteStatus:value=>{remoteStatus=value;},hold:()=>{release=new Promise(r=>{f.release=r;});return ()=>{f.release();release=null;};}};
}

test('MOD-01: readiness is owner scoped, read-only and distinguishes configuration from execution',async t=>{
 const f=await setup(t),before=f.calls.length;let p=(await f.read()).processing;
 assert.ok(p.classification.blockers.includes('NOT_CONFIGURED'));assert.ok(p.classification.blockers.includes('WORKER_DISABLED'));
 await f.save('organizer');await f.save('embedder');p=(await f.read()).processing;
 assert.deepEqual(p.classification.blockers,['WORKER_DISABLED']);assert.ok(p.vector.blockers.includes('VECTOR_DISABLED'));
 assert.equal(p.vector.search_ready,false);assert.equal((await f.read(f.b)).models[0].revision,0);assert.equal(f.calls.length,before);
});

test('MOD-02: capability probe checks real classification and grounded summary protocols with synthetic input only',async t=>{
 const f=await setup(t);await f.save('organizer');await f.act('memory.create',{scope:'user',content:'Private sentinel must not enter a probe'});
 const op=randomUUID(),r=await f.act('models.test',{kind:'organizer',mode:'capabilities'},f.a,op);
 assert.deepEqual(r.checks,['classification','summary']);assert.equal(r.real_memory_sent,false);assert.equal(f.calls.length,2);
 assert.ok(!JSON.stringify(f.calls).includes('Private sentinel'));assert.equal((await f.read()).models[0].verification.state,'verified');
 new ConsoleState(f.store);assert.equal((await f.read()).models[0].verification.state,'verified','schema initialization preserves persisted evidence');
 assert.equal((await f.read(f.b)).models[0].verification,null);
 await f.act('models.test',{kind:'organizer',mode:'capabilities'},f.a,op);assert.equal(f.calls.length,2);
 await f.save('organizer',{model:'synthetic-updated'},1);assert.equal((await f.read()).models[0].verification,null);
});

test('MOD-03: fabricated summary citations fail and diagnostics never persist source text',async t=>{
 const f=await setup(t);await f.save('organizer');f.invalid();
 await assert.rejects(()=>f.act('models.test',{kind:'organizer',mode:'capabilities'}),e=>e.code==='INVALID_SOURCE_SET');
 const v=(await f.read()).models[0].verification;assert.equal(v.state,'failed');assert.equal(v.error_code,'INVALID_SOURCE_SET');assert.ok(!JSON.stringify(v).includes('Invented'));
});

test('MOD-04: embedder probes verify document and query vectors, dimensions and explicit query consent',async t=>{
 const f=await setup(t);await f.save('embedder');const r=await f.act('models.test',{kind:'embedder',mode:'capabilities'});
 assert.deepEqual(r.checks,['document_embedding','query_embedding']);assert.equal(r.dimensions,3);
 assert.ok(f.calls.every(c=>c.dimensions===3));
 await f.save('embedder',{query_approved:false},1);const documentOnly=await f.act('models.test',{kind:'embedder',mode:'capabilities'});
 assert.deepEqual(documentOnly.checks,['document_embedding']);assert.deepEqual(documentOnly.skipped,['query_embedding']);
 f.invalid();await assert.rejects(()=>f.act('models.test',{kind:'embedder',mode:'capabilities'}),e=>e.code==='INVALID_EMBEDDING');
});

test('MOD-05: changing configuration during a probe cannot mark the new revision verified',async t=>{
 const f=await setup(t);await f.save('organizer');const release=f.hold(),pending=f.act('models.test',{kind:'organizer',mode:'capabilities'});
 let earlyError;pending.catch(e=>{earlyError=e;});
 for(let n=0;!f.calls.length&&!earlyError&&n<200;n++)await new Promise(r=>setTimeout(r,5));
 if(earlyError){release();throw earlyError;}assert.ok(f.calls.length,'probe reaches the synthetic endpoint');
 await f.save('organizer',{model:'synthetic-new'},1);release();await assert.rejects(()=>pending,e=>e.code==='STALE_INPUT');
 assert.equal((await f.read()).models[0].verification,null);
});

test('MOD-06: configured HTTP LLM classifies and summarizes, embeddings index only authorized sources',async t=>{
 const f=await setup(t);await f.save('organizer');await f.save('embedder');
 const own=await f.act('memory.create',{scope:'user',content:'Synthetic local network decision.'});
 await f.act('memory.create',{scope:'user',content:'Synthetic SECRET exclusion',sensitivity:'secret'});
 await f.act('memory.create',{scope:'user',content:'Synthetic FOREIGN exclusion'},f.b);
 f.store.memoryConfig.console.worker_enabled=true;
 const schedule=type=>f.act('jobs.schedule',{type,timezone:'UTC',periods:['daily'],include_open:true});
 const jobs=await schedule('classification');await f.service.tick();assert.equal(f.store.memoryJobs.get(jobs.jobs[0]).state,'succeeded');
 assert.equal(f.service.meta(f.a.auth,{memory_id:own.memory_id}).category,'technical');
 const summary=await schedule('summary');await f.service.tick();assert.equal(f.store.memoryJobs.get(summary.jobs[0]).state,'succeeded');
 const backend=new MockVectorStore();f.store.memoryConfig.vector_store={enabled:true};
 f.service.vector=user=>{const e=f.service.models.provider(user,'embedder');return new VectorIndex(f.store,backend,new Map([[e.profile.fingerprint,e]]),{ownerId:user});};
 await f.act('vector.schedule',{});await f.service.tick();const p=(await f.read()).processing;
 assert.equal(p.vector.state,'succeeded');assert.equal(p.vector.search_ready,true);assert.equal(p.vector.indexed_documents,1);
 const found=await f.store.searchMemories(f.a.auth,{query:'network',mode:'semantic',personal_model_only:true});assert.equal(found.results[0].memory_id,own.memory_id);
 assert.ok(!JSON.stringify(f.calls).match(/SECRET exclusion|FOREIGN exclusion/));
 // A model change no longer silently breaks the serving index: the generation keeps the profile it was built with.
 await f.save('embedder',{model:'synthetic-next'},1);const after=(await f.read()).processing.vector;
 assert.equal(after.search_ready,true);assert.equal(after.serving_profile_differs,true);assert.ok(!after.search_blockers.includes('VECTOR_PROFILE_MISMATCH'));
 // A generation without a retained profile (built before this change) still reports the mismatch truthfully.
 f.store.db.prepare('DELETE FROM console_vector_profiles').run();
 assert.ok((await f.read()).processing.vector.search_blockers.includes('VECTOR_PROFILE_MISMATCH'));
});

test('MOD-07: all probe calls share budget and a failed second call is not reported as verified',async t=>{
 const f=await setup(t);await f.save('organizer',{daily_requests:1});
 await assert.rejects(()=>f.act('models.test',{kind:'organizer',mode:'capabilities'}),e=>e.code==='BUDGET_EXHAUSTED');
 assert.equal(f.calls.length,1);assert.equal((await f.read()).models[0].verification.state,'failed');
});

test('MOD-08: abandoned probe is never presented as a verified or indefinitely running model',async t=>{
 const f=await setup(t);await f.save('organizer');
 f.store.db.prepare("INSERT INTO console_model_tests VALUES(?,?,1,?,'running',NULL,NULL,?)").run(f.a.auth.user_id,'organizer',randomUUID(),Date.now()-100000);
 const verification=(await f.read()).models[0].verification;assert.equal(verification.state,'interrupted');assert.equal(verification.error_code,'MODEL_TEST_INTERRUPTED');
 assert.equal(f.calls.length,0);
});

test('MOD-09: remote failures surface a fixed diagnostic, never upstream content',async t=>{
 const f=await setup(t);await f.save('organizer');f.remoteStatus(503);
 const r=await f.request('POST','/v1/console/action',{action:'models.test',payload:{kind:'organizer',mode:'capabilities'},operation_id:randomUUID()},f.a);
 assert.equal(r.status,409);assert.equal(r.body.error_code,'REMOTE_UNAVAILABLE');assert.ok(!JSON.stringify(r.body).includes('upstream-private'));
 assert.equal((await f.read()).models[0].verification.error_code,'REMOTE_UNAVAILABLE');
});

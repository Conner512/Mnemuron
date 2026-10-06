import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {randomBytes,randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';

// QUOTA: owner call limits. Synthetic loopback organizer/embedder and a synthetic pre-created vector store only.
// No real model, Qdrant, credential, memory or database is used.
class PrecreatedStore extends MockVectorStore {
  constructor(names){super();this.precreated=names;this.created=0;for(const name of names)this.collections.set(name,{config:{dimensions:3,distance:'Cosine'},points:new Map()});}
  async ensureCollection(name,config){this.available();if(!this.precreated.includes(name))throw Object.assign(new Error('missing'),{code:'VECTOR_COLLECTION_MISSING'});
    if(JSON.stringify(this.collections.get(name).config)!==JSON.stringify(config))throw Object.assign(new Error('mismatch'),{code:'VECTOR_PROFILE_MISMATCH'});}
}

async function setup(t){
  const f=await memoryFixture(t),key=f.root+'/quota-test.key';fs.writeFileSync(key,randomBytes(32).toString('base64url'),{mode:0o600});
  const calls=[];let release=null;
  const model=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push(body);if(release)await release;
    res.setHeader('content-type','application/json');
    if(body.input){res.end(JSON.stringify({data:body.input.map((text,index)=>({index,embedding:/network/i.test(text)?[1,0,0]:[0,0,1]}))}));return;}
    const input=JSON.parse(body.messages[1].content).input;
    const data=input?.sources?{results:input.sources.map(s=>input.operation==='classification'?{memory_id:s.memory_id,category:'technical',tags:['synthetic']}:{memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content})}:{ok:true};
    res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(data)}}]}));
  });await new Promise(r=>model.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>model.close(r)));
  const origin=`http://127.0.0.1:${model.address().port}`;
  f.store.memoryConfig.console={key_file:key,worker_enabled:true,allowed_private_origins:[origin]};
  f.store.memoryConfig.vector_store={enabled:true,collection_prefix:'synthetic'};
  const backend=new PrecreatedStore(['synthetic_quota_v1']);f.store.consoleService.vectorBackend=()=>backend;
  const issue=user=>{const c=f.store.issueCredential({userId:user,deviceId:'synthetic-quota',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES});return {...c,auth:f.store.authenticate(c.api_key)};};
  const a=issue(f.a.auth.user_id),b=issue(f.other.auth.user_id),service=f.store.consoleService;
  const base={enabled:true,protocol:'openai_compatible',base_url:origin,model:'synthetic-model',profile_revision:'1',daily_requests:100,output_tokens:4096,batch_size:1,sensitivities:['public','internal','sensitive'],egress_approved:true,query_approved:true};
  const act=(action,payload,owner=a,operation_id=randomUUID())=>service.execute(owner.auth,{action,payload,operation_id});
  const save=(kind,overrides={},revision=0,owner=a)=>act('models.save',{kind,expected_revision:revision,config:{...base,...(kind==='embedder'?{dimensions:3}:{}),...overrides}},owner);
  const quota=(kind,daily_limit,total_limit,owner=a)=>{const q=service.processing(owner.auth.user_id).quotas[kind];
    return act('models.quota',{kind,expected_revision:q.mode==='manual'?q.revision:0,daily_limit,total_limit},owner);};
  const view=(kind,owner=a)=>service.processing(owner.auth.user_id).quotas[kind];
  const status=(owner=a)=>service.processing(owner.auth.user_id).vector;
  const create=(content,owner=a)=>act('memory.create',{scope:'user',content},owner).then(r=>r.memory_id);
  const hybrid=()=>f.store.searchMemories(a.auth,{query:'synthetic network',mode:'hybrid',personal_model_only:true});
  const drain=async()=>{for(let n=0;n<40;n++){await service.tick();const s=status().first_run;if(s?.build!=='pending')return s;}throw new Error('build did not settle');};
  const firstRun=async(budget,{activate=true}={})=>{const p=await act('vector.prepare',{budget_calls:budget});await act('models.test',{kind:'embedder',mode:'capabilities'});
    await act('vector.schedule',{generation:p.generation,expected_count:p.manifest.count,expected_digest:p.manifest.digest});
    const built=await drain();assert.equal(built.build,'built');if(activate)await act('vector.activate',{generation:p.generation});return p;};
  return {...f,calls,a,b,service,act,save,quota,view,status,create,hybrid,firstRun,backend,
    hold:()=>{let open;release=new Promise(r=>{open=r;});return ()=>{release=null;open();};}};
}
// Rows that a limit change must never touch: model configuration and probe evidence, jobs, index and first-run state.
const sideState=db=>Object.fromEntries(['console_models','console_model_tests','memory_jobs','memory_vector_generations','memory_vector_owner_active','console_vector_requests',
  'console_vector_budget','memory_vector_manifest','memory_vector_documents','console_vector_profiles','memory_model_budget','memory_vector_calls','memory_owner_vector_build_usage','console_settings']
  .map(table=>[table,db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all():null]));

test('QUOTA-01: limits must be an explicit null (no limit) or a safe whole number; zero is a real cap; malformed input is refused',async t=>{
  const f=await setup(t);await f.save('organizer');
  assert.equal(f.view('organizer').mode,'legacy');
  const bad=[{daily_limit:'5',total_limit:null},{daily_limit:5.5,total_limit:null},{daily_limit:-1,total_limit:null},{daily_limit:NaN,total_limit:null},
    {daily_limit:Infinity,total_limit:null},{daily_limit:true,total_limit:null},{daily_limit:1000001,total_limit:null},{daily_limit:null,total_limit:1000000001},
    {daily_limit:null,total_limit:2**53},{daily_limit:null},{total_limit:null},{daily_limit:'',total_limit:null},{daily_limit:'unlimited',total_limit:null}];
  for(const p of bad)await assert.rejects(()=>f.act('models.quota',{kind:'organizer',expected_revision:0,...p}),e=>e.errorCode==='QUOTA_INVALID',JSON.stringify(p));
  await assert.rejects(()=>f.act('models.quota',{kind:'other',expected_revision:0,daily_limit:null,total_limit:null}),e=>e.errorCode==='INVALID_CONSOLE_INPUT');
  await assert.rejects(()=>f.act('models.quota',{kind:'organizer',expected_revision:0,daily_limit:null,total_limit:null,reset:true}),e=>e.errorCode==='INVALID_CONSOLE_INPUT');
  await assert.rejects(()=>f.act('models.quota',{kind:'organizer',expected_revision:3,daily_limit:null,total_limit:null}),e=>e.errorCode==='QUOTA_VERSION_CHANGED');
  assert.equal(f.view('organizer').mode,'legacy','nothing malformed was stored');
  // Through the HTTP API, JSON null stays an explicit "no limit" and 0 stays a cap.
  const http=await f.request('POST','/v1/console/action',{action:'models.quota',operation_id:randomUUID(),payload:{kind:'organizer',expected_revision:0,daily_limit:null,total_limit:0}},f.a);
  assert.equal(http.status,200);assert.equal(http.body.status,'saved');
  let q=f.view('organizer');assert.deepEqual([q.mode,q.daily.limit,q.daily.remaining,q.total.limit,q.total.remaining,q.exhausted],['manual',null,null,0,0,['TOTAL_BUDGET_EXHAUSTED']]);
  assert.ok(f.service.processing(f.a.auth.user_id).classification.blockers.includes('TOTAL_BUDGET_EXHAUSTED'),'readiness reports the zero cap');
  await assert.rejects(()=>f.act('models.test',{kind:'organizer'}),e=>e.code==='BUDGET_EXHAUSTED');assert.equal(f.calls.length,0,'zero allows no call');
  await f.quota('organizer',null,null);q=f.view('organizer');assert.deepEqual([q.daily.limit,q.total.limit,q.exhausted],[null,null,[]]);
  await f.act('models.test',{kind:'organizer'});assert.equal(f.calls.length,1);
  // Upper bounds are accepted exactly.
  await f.quota('organizer',1000000,1000000000);assert.deepEqual([f.view('organizer').daily.limit,f.view('organizer').total.limit],[1000000,1000000000]);
  // Another account is untouched and cannot see this one's setting.
  assert.equal(f.view('organizer',f.b).mode,'legacy');assert.equal(f.view('organizer',f.b).total.used,0);
  const audit=f.store.db.prepare("SELECT metadata_json FROM audit_events WHERE action='console.models.quota.change' ORDER BY rowid").all().map(r=>JSON.parse(r.metadata_json));
  assert.equal(audit.length,3);assert.equal(audit[0].previous,'legacy');assert.deepEqual([audit[1].previous.total_limit,audit[1].total_limit],[0,null]);
});

test('QUOTA-02: the deployed shape (103 manifest, 105 used of 150, daily 25, not active) goes unlimited without resets, activation, rebuild, catch-up or calls',async t=>{
  const f=await setup(t);const network=await f.create('Synthetic network router decision.');
  for(let n=1;n<103;n++)await f.create(`Synthetic acceptance note ${n}.`);
  await f.save('embedder',{daily_requests:25});const p=await f.firstRun(150,{activate:false});
  assert.equal(p.manifest.count,103);assert.equal(f.calls.length,105);
  let q=f.view('embedder');assert.deepEqual([q.mode,q.daily.limit,q.total.limit,q.total.used],['legacy',25,150,105]);
  const before=sideState(f.store.db),calls=f.calls.length;
  await f.quota('embedder',null,null);
  q=f.view('embedder');assert.deepEqual([q.mode,q.daily.limit,q.total.limit,q.total.used,q.total.remaining,q.exhausted],['manual',null,null,105,null,[]],'the 105 already used carry over');
  // The setting change itself touched nothing else and sent nothing.
  assert.deepEqual(sideState(f.store.db),before);assert.equal(f.calls.length,calls);
  const fr=f.status().first_run;assert.deepEqual([fr.build,fr.serving,fr.manifest.count,fr.manifest.digest,fr.budget.total,fr.budget.used],['built',false,103,p.manifest.digest,150,105]);
  assert.ok(f.status().search_blockers.includes('VECTOR_NOT_READY'),'still not activated');
  // The worker neither catches up nor rebuilds after the change.
  const later=await f.create('Synthetic network written after the change.');for(let n=0;n<5;n++)await f.service.tick();
  assert.equal(f.calls.length,calls);assert.deepEqual(sideState(f.store.db).console_vector_requests,before.console_vector_requests);
  await assert.rejects(()=>f.act('vector.schedule',{}),e=>e.errorCode==='FIRST_RUN_ACTIVE','first-run mode is unchanged');
  // Only an explicit activation (a separate step) serves the index; then neither 25/day nor 150 total is enforced, and every call is counted.
  await f.act('vector.activate',{generation:p.generation});
  for(let n=0;n<50;n++){const r=await f.hybrid();assert.equal(r.retrieval.effective_mode,'hybrid',`query ${n+1}`);assert.equal(r.results[0].memory_id,network);}
  assert.equal(f.calls.length,155);q=f.view('embedder');assert.equal(q.total.used,155);assert.equal(q.daily.used,52,'2 probes + 50 queries; build calls stay outside the daily count');
  assert.deepEqual([f.status().first_run.budget.used,f.status().first_run.budget.remaining],[155,0],'the first-run record keeps counting past its old total; remaining never goes negative');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_vector_documents WHERE memory_id=?').get(later).n,0,'new record not indexed: no catch-up');
  const usage=f.service.features.read(f.a.auth,'model-usage',{}).models.find(m=>m.kind==='embedder');
  assert.deepEqual([usage.limit_mode,usage.limit,usage.remaining,usage.total.used,usage.total.limit,usage.first_run_build_calls],['manual',null,null,155,null,103]);
});

test('QUOTA-03: enable, lower below usage, disable and re-enable keep every count; a reached cap refuses before sending',async t=>{
  const f=await setup(t);await f.create('Synthetic network router decision.');await f.create('Synthetic plain note.');
  await f.save('embedder',{daily_requests:3});await f.firstRun(20);assert.equal(f.calls.length,4,'2 probes + 2 records');
  // Enabling a total of 6 counts the 4 already used.
  await f.quota('embedder',null,6);
  for(let n=0;n<2;n++)assert.equal((await f.hybrid()).retrieval.effective_mode,'hybrid');
  assert.equal(f.calls.length,6);assert.deepEqual(f.status().search_blockers,['TOTAL_BUDGET_EXHAUSTED']);
  let r=await f.hybrid();assert.deepEqual([r.retrieval.effective_mode,r.retrieval.degradation_code],['lexical','BUDGET_EXHAUSTED']);assert.equal(f.calls.length,6,'refused before sending');
  // Lowering below usage is accepted and reported; nothing is reset.
  const lowered=await f.quota('embedder',null,2);assert.deepEqual([lowered.quota.total.used,lowered.quota.total.remaining,lowered.quota.exhausted],[6,0,['TOTAL_BUDGET_EXHAUSTED']]);
  await assert.rejects(()=>f.act('models.test',{kind:'embedder'}),e=>e.code==='BUDGET_EXHAUSTED');assert.equal(f.calls.length,6);
  // Disabled: calls flow (the model's daily 3 no longer applies either) and are still counted.
  await f.quota('embedder',null,null);
  for(let n=0;n<4;n++)assert.equal((await f.hybrid()).retrieval.effective_mode,'hybrid');
  assert.equal(f.calls.length,10);assert.equal(f.view('embedder').total.used,10);
  // Re-enabling the old cap: the calls made while unlimited count, so it is already reached.
  await f.quota('embedder',null,6);assert.deepEqual(f.view('embedder').exhausted,['TOTAL_BUDGET_EXHAUSTED']);
  r=await f.hybrid();assert.equal(r.retrieval.degradation_code,'BUDGET_EXHAUSTED');assert.equal(f.calls.length,10);
  // Daily limit: today's count includes everything before it was set; raising it lets exactly the difference through.
  await f.quota('embedder',9,null);assert.deepEqual([f.view('embedder').daily.used,f.view('embedder').daily.remaining],[8,1]);
  assert.equal((await f.hybrid()).retrieval.effective_mode,'hybrid');assert.deepEqual(f.status().search_blockers,['DAILY_BUDGET_EXHAUSTED']);
  assert.equal((await f.hybrid()).retrieval.degradation_code,'BUDGET_EXHAUSTED');assert.equal(f.calls.length,11);
  const v=f.view('embedder');assert.deepEqual([v.daily.used,v.total.used],[9,11]);assert.equal(f.status().first_run.budget.used,11);
});

test('QUOTA-04: organizer limits replace the model daily ceiling; a blocked job stays blocked until an explicit retry',async t=>{
  const f=await setup(t);await f.save('organizer',{daily_requests:1});
  // Legacy daily 1 refuses the second probe call; an explicit "no limit" allows it.
  await assert.rejects(()=>f.act('models.test',{kind:'organizer',mode:'capabilities'}),e=>e.code==='BUDGET_EXHAUSTED');assert.equal(f.calls.length,1);
  assert.ok(f.service.processing(f.a.auth.user_id).classification.blockers.includes('DAILY_BUDGET_EXHAUSTED'),'legacy exhaustion is reported too');
  await f.quota('organizer',null,null);assert.equal(f.view('organizer').daily.used,1,'today\'s legacy calls are carried into the daily count');
  assert.equal((await f.act('models.test',{kind:'organizer',mode:'capabilities'})).status,'verified');assert.equal(f.calls.length,3);
  for(const n of [1,2,3])await f.create(`Synthetic organizer note ${n}.`);
  await f.quota('organizer',4,null);
  const {jobs:[job]}=await f.act('jobs.schedule',{type:'classification',timezone:'UTC',periods:['daily'],include_open:true});
  for(let n=0;n<3;n++)await f.service.tick();
  assert.equal(f.store.memoryJobs.get(job).state,'blocked_budget');assert.equal(f.calls.length,4,'one batch call fit; the next was refused before sending');
  assert.deepEqual(f.view('organizer').exhausted,['DAILY_BUDGET_EXHAUSTED']);
  // Raising the limit schedules nothing: the job waits for the owner.
  await f.quota('organizer',null,null);for(let n=0;n<3;n++)await f.service.tick();
  assert.equal(f.store.memoryJobs.get(job).state,'blocked_budget');assert.equal(f.calls.length,4);
  await f.act('jobs.retry',{job_id:job});for(let n=0;n<3;n++)await f.service.tick();
  assert.equal(f.store.memoryJobs.get(job).state,'succeeded');assert.equal(f.calls.length,6,'the retry sends only the two remaining items');assert.equal(f.view('organizer').total.used,6);
  // A total cap stops the worker too.
  await f.quota('organizer',null,6);const {jobs:[next]}=await f.act('jobs.schedule',{type:'summary',timezone:'UTC',periods:['daily'],include_open:true});
  await f.service.tick();assert.equal(f.store.memoryJobs.get(next).state,'blocked_budget');assert.equal(f.calls.length,6);
  assert.ok(f.service.processing(f.a.auth.user_id).summary.blockers.includes('TOTAL_BUDGET_EXHAUSTED'));
});

test('QUOTA-05: overlapping in-flight queries are reserved before sending, so they cannot overshoot an enabled daily or total cap',async t=>{
  const f=await setup(t);await f.create('Synthetic network router decision.');
  await f.save('embedder');await f.firstRun(20);const start=f.calls.length;
  await f.quota('embedder',null,start+3);
  const open=f.hold();const pending=Array.from({length:10},()=>f.hybrid());
  await new Promise(r=>setTimeout(r,100));open();const results=await Promise.all(pending);
  assert.equal(results.filter(r=>r.retrieval.effective_mode==='hybrid').length,3);assert.equal(f.calls.length,start+3);
  assert.equal(f.view('embedder').total.used,start+3);
  await f.quota('embedder',f.view('embedder').daily.used+2,null);
  const open2=f.hold();const second=Array.from({length:8},()=>f.hybrid());
  await new Promise(r=>setTimeout(r,100));open2();
  assert.equal((await Promise.all(second)).filter(r=>r.retrieval.effective_mode==='hybrid').length,2);assert.equal(f.calls.length,start+5);
});

test('QUOTA-06: separate SQLite connections reserving at once grant exactly the daily and total caps',async t=>{
  const f=await setup(t),user=f.a.auth.user_id,databasePath=path.join(f.root,'test.sqlite3');
  assert.ok(fs.existsSync(databasePath));
  const run=()=>Promise.all(Array.from({length:4},()=>new Promise((resolve,reject)=>{
    const w=new Worker(new URL('./helpers/quota-reserve-worker.mjs',import.meta.url),{workerData:{databasePath,user,kind:'organizer',attempts:30}});
    w.once('message',resolve);w.once('error',reject);})));
  await f.quota('organizer',null,37);
  let results=await run();
  assert.deepEqual(results.flatMap(r=>r.other),[]);assert.equal(results.reduce((n,r)=>n+r.granted,0),37);assert.equal(results.reduce((n,r)=>n+r.refused,0),120-37);
  assert.equal(f.view('organizer').total.used,37);
  await f.quota('organizer',50,null);
  results=await run();
  assert.deepEqual(results.flatMap(r=>r.other),[]);assert.equal(results.reduce((n,r)=>n+r.granted,0),13,'daily 50 minus the 37 already used today');
  assert.deepEqual([f.view('organizer').daily.used,f.view('organizer').total.used],[50,50]);
  assert.equal(f.view('organizer',f.b).total.used,0,'another account is never charged');
});

test('QUOTA-07: with a manual embedder total, prepare checks that total instead of the first-run budget figure',async t=>{
  const f=await setup(t);for(const n of [1,2,3,4,5])await f.create(`Synthetic note ${n}.`);await f.save('embedder');
  await assert.rejects(()=>f.act('vector.prepare',{budget_calls:3}),e=>e.errorCode==='MANIFEST_EXCEEDS_BUDGET');
  await f.quota('embedder',null,4);
  await assert.rejects(()=>f.act('vector.prepare',{budget_calls:150}),e=>e.errorCode==='MANIFEST_EXCEEDS_BUDGET','the manual total of 4 cannot cover 2 + 5');
  await f.quota('embedder',null,null);
  const p=await f.act('vector.prepare',{budget_calls:3});assert.equal(p.status,'prepared');assert.equal(p.manifest.count,5);
  assert.equal(f.calls.length,0);assert.equal(f.status().first_run.state,'building');assert.equal(f.status().first_run.serving,false);
});

test('QUOTA-08: upgrading a database that already has 105 of 150 first-run calls seeds 105 and today\'s calls once, without double counting',async t=>{
  const f=await setup(t);for(let n=0;n<103;n++)await f.create(`Synthetic acceptance note ${n}.`);
  await f.save('embedder',{daily_requests:25});await f.firstRun(150,{activate:false});assert.equal(f.calls.length,105);
  // The deployed state before this change: the first-run record exists, the new counters do not.
  for(const table of ['console_model_usage','console_model_usage_daily'])f.store.db.prepare(`DELETE FROM ${table}`).run();
  let q=f.view('embedder');assert.deepEqual([q.mode,q.total.used,q.total.limit],['legacy',105,150]);
  const before=sideState(f.store.db);await f.quota('embedder',null,null);assert.deepEqual(sideState(f.store.db),before);
  q=f.view('embedder');assert.deepEqual([q.total.used,q.daily.used],[105,2],'105 in total; today only the 2 probes (build calls stay outside the daily count)');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM console_model_usage').get().n,0,'reading never creates or seeds a counter');
  // The first real call seeds once and counts once.
  await f.act('models.test',{kind:'embedder'});q=f.view('embedder');
  assert.deepEqual([q.total.used,q.daily.used,f.status().first_run.budget.used,f.calls.length],[106,3,106,106]);
});

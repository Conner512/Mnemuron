import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {memoryFixture,businessSnapshot} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_READ_SCOPES,CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {organizer,embedder,taxonomy} from './helpers/memory-models.mjs';
import {MemoryWorker} from '../lib/memory-jobs/worker.mjs';
import {VectorIndex} from '../lib/vector-stores/index.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';

async function setup(t){const f=await memoryFixture(t);const secret=f.root+'/console.key';fs.writeFileSync(secret,randomBytes(32).toString('base64url'),{mode:0o600});f.store.memoryConfig.console={key_file:secret,worker_enabled:false};
  const issue=(user,write)=>{const c=f.store.issueCredential({userId:user,label:'Synthetic console',deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:write?CONSOLE_WRITE_SCOPES:CONSOLE_READ_SCOPES});return {...c,auth:f.store.authenticate(c.api_key)};};
  const a=issue(f.a.auth.user_id,true),b=issue(f.other.auth.user_id,true),read=issue(a.auth.user_id,false);
  const act=(action,payload,owner=a,operation_id=randomUUID())=>f.request('POST','/v1/console/action',{action,payload,operation_id},owner);
  const get=(view,p={},owner=a)=>f.request('GET','/v1/console/'+view+'?'+new URLSearchParams(p),undefined,owner);
  return {...f,a,b,read,act,get};}
const config={enabled:true,protocol:'openai_compatible',base_url:'https://model.example.invalid/v1',model:'synthetic-model',profile_revision:'1',daily_requests:10,output_tokens:4096,batch_size:5,sensitivities:['public','internal','sensitive'],egress_approved:true,query_approved:true};
const create=(f,owner=f.a,text='Synthetic console memory')=>f.act('memory.create',{content:text,scope:'user',memory_type:'fact',sensitivity:'sensitive'},owner);

test('CON-01: old readers, other agents and MCP credentials cannot call console mutations',async t=>{
  const f=await setup(t),before=businessSnapshot(f.store);
  assert.equal((await f.act('memory.create',{scope:'user',content:'denied'},f.read)).status,403);
  const web=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'web',agentId:'chatgpt-web',agentInstanceId:'web',scopes:['memory:read','resume:read']});
  assert.equal((await f.act('memory.create',{scope:'user',content:'denied'},web)).status,404);
  assert.equal((await f.request('POST','/v1/memories',{scope:'user',content:'no generic bypass'},f.a)).status,404);
  assert.deepEqual(businessSnapshot(f.store),before);
});
test('CON-02: own-memory create is persisted and repeated operations do not duplicate writes',async t=>{
  const f=await setup(t),op=randomUUID(),input={content:'合成网络型号C9800-CL 😀',scope:'user',memory_type:'fact',sensitivity:'sensitive'};
  const first=await f.act('memory.create',input,f.a,op);assert.equal(first.status,200,JSON.stringify(first.body));
  for(let i=0;i<20;i++)assert.equal((await f.act('memory.create',input,f.a,op)).body.memory_id,first.body.memory_id);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories WHERE user_id=?').get(f.a.auth.user_id).n,1);
  assert.equal((await f.act('memory.create',{...input,content:'different'},f.a,op)).status,409);
  assert.equal((await f.get('memory-meta',{memory_id:first.body.memory_id},f.b)).status,404);
  assert.equal((await f.get('memories',{},f.b)).body.results.length,0);
  assert.equal((await f.get('operation',{operation_id:op},f.b)).status,404);
});
test('CON-03: correction/retraction use exact revisions and leave task/handoff state intact',async t=>{
  const f=await setup(t),before=f.store.db.prepare('SELECT * FROM tasks').all(),m=(await create(f)).body.memory_id;
  const meta=(await f.get('memory-meta',{memory_id:m})).body;
  assert.equal((await f.act('memory.correct',{memory_id:m,revision:99,content:'stale'})).status,409);
  const corrected=await f.act('memory.correct',{memory_id:m,revision:meta.revision,content:'Corrected synthetic content',reason:'Synthetic correction'});
  assert.equal(corrected.status,200,JSON.stringify(corrected.body));assert.notEqual(corrected.body.memory_id,m);
  assert.equal(f.store.revisions.latest(f.a.auth.user_id,m).status,'superseded');
  const newId=corrected.body.memory_id,newMeta=(await f.get('memory-meta',{memory_id:newId})).body;
  assert.equal((await f.act('memory.retract',{memory_id:newId,revision:newMeta.revision})).status,200);
  assert.equal(f.store.revisions.latest(f.a.auth.user_id,newId).status,'retracted');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM tasks').all(),before);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM resumes').get().n,0);
});
test('CON-04: privacy and grants stay version-pinned, secret records cannot be granted',async t=>{
  const f=await setup(t),m=(await create(f)).body.memory_id;let meta=(await f.get('memory-meta',{memory_id:m})).body;
  assert.equal(meta.web_allowed,false);
  assert.equal((await f.act('memory.visibility',{memory_id:m,revision:meta.revision,state_hash:'bad',allow:true})).status,409);
  assert.equal((await f.act('memory.visibility',{memory_id:m,revision:meta.revision,state_hash:meta.state_hash,allow:true})).status,200);
  assert.equal((await f.get('memory-meta',{memory_id:m})).body.web_allowed,true);
  assert.equal((await f.act('memory.sensitivity',{memory_id:m,revision:meta.revision,sensitivity:'secret'})).status,200);
  meta=(await f.get('memory-meta',{memory_id:m})).body;assert.equal(meta.web_allowed,false);
  assert.equal((await f.act('memory.visibility',{memory_id:m,revision:meta.revision,state_hash:meta.state_hash,allow:true})).status,400);
});
test('CON-05: manual categories validate taxonomy and foreign ownership',async t=>{
  const f=await setup(t),m=(await create(f)).body.memory_id,revision=1;
  assert.equal((await f.act('memory.classify',{memory_id:m,revision,category:'technical'})).status,200);
  assert.equal((await f.act('memory.classify',{memory_id:m,revision,category:'not-in-taxonomy'})).status,400);
  assert.equal((await f.act('memory.classify',{memory_id:m,revision,category:'technical'},f.b)).status,404);
});
test('CON-06: portable export is owner-scoped; import is append-only, repeatable and transactional',async t=>{
  const f=await setup(t);await create(f,f.b,'Foreign sentinel');for(let i=0;i<23;i++)await create(f,f.a,`Synthetic portable ${i}`);
  let request={},records=[];do{const page=await f.get('export',request);assert.equal(page.status,200);records.push(...page.body.records);request=page.body.next_request;}while(request);
  assert.equal(records.length,23);assert.ok(!JSON.stringify(records).includes('Foreign sentinel'));assert.ok(!JSON.stringify(records).includes('mnm_'));
  const payload={format:'mnemuron-personal-portable-v1',records:records.slice(0,2),confirm_personal_scope:true};
  assert.equal((await f.act('storage.import',payload)).body.created,2);assert.equal((await f.act('storage.import',payload)).body.existing,2);
  const count=f.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n;
  const bad={...payload,records:[records[2],{...records[3],content:'x'.repeat(4097)}]};assert.equal((await f.act('storage.import',bad)).status,400);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n,count);
  const replay=await f.act('storage.import',{...payload,records:[{...records[0],content:'changed'}]});assert.equal(replay.status,409);
  assert.equal((await f.get('export',{},f.read)).status,403);
});
test('CON-07: connection keys use encrypted operation receipts and exact account ownership',async t=>{
  const f=await setup(t),op=randomUUID(),p={label:'Synthetic local agent',agent_id:'synthetic-client',device_id:'synthetic-device',access:'read'};
  const r=await f.act('connections.create',p,f.a,op);assert.equal(r.status,200,JSON.stringify(r.body));assert.ok(r.body.api_key.startsWith('mnm_'));
  assert.equal((await f.act('connections.create',p,f.a,op)).body.api_key,r.body.api_key);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM console_operations').all()).includes(r.body.api_key));
  assert.deepEqual(f.store.authenticate(r.body.api_key).scopes,['memory:read']);
  assert.equal((await f.act('connections.rotate',{credential_id:r.body.credential.credential_id},f.b)).status,404);
  const rotated=await f.act('connections.rotate',{credential_id:r.body.credential.credential_id});assert.equal(rotated.status,200);
  assert.throws(()=>f.store.authenticate(r.body.api_key));
  assert.equal((await f.act('connections.revoke',{credential_id:rotated.body.credential.credential_id})).status,200);
  assert.throws(()=>f.store.authenticate(rotated.body.api_key));
  assert.equal((await f.act('connections.revoke',{credential_id:f.a.credential.credential_id})).status,409);
  assert.equal((await f.act('connections.create',{...p,access:'admin'})).status,400);
});
test('CON-08: model settings are per-account, write-only secrets, no caller-supplied env/file credentials',async t=>{
  const f=await setup(t),key='synthetic-model-secret-'+randomUUID();
  let r=await f.act('models.save',{kind:'organizer',expected_revision:0,config,api_key:key});assert.equal(r.status,200,JSON.stringify(r.body));
  const result=JSON.stringify((await f.get('models')).body);assert.ok(!result.includes(key));assert.ok(!fs.readFileSync(f.databasePath).includes(Buffer.from(key)));
  assert.equal((await f.get('models',{},f.b)).body.models[0].has_key,false);
  assert.equal((await f.act('models.save',{kind:'organizer',expected_revision:0,config})).status,409);
  assert.equal((await f.act('models.save',{kind:'organizer',expected_revision:1,config:{...config,auth:{env:'SECRET'}}})).status,400);
  assert.equal((await f.act('models.save',{kind:'organizer',expected_revision:1,config:{...config,base_url:'http://169.254.169.254'}})).status,400);
  r=await f.act('models.save',{kind:'organizer',expected_revision:1,config:{...config,base_url:'https://different.example.invalid/v1'}});assert.equal(r.status,200);assert.equal(r.body.model.has_key,false);
});
test('CON-09: actual loopback model probe is budgeted, uses synthetic input and replay does not re-call',async t=>{
  const f=await setup(t);let calls=0,text='';const server=http.createServer(async(req,res)=>{calls++;for await(const c of req)text+=c;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;f.store.memoryConfig.console.allowed_private_origins=[origin];
  assert.equal((await f.act('models.save',{kind:'organizer',expected_revision:0,config:{...config,base_url:origin,daily_requests:1}})).status,200);
  await create(f,f.a,'Never send this private memory in a connection test');
  const operation=randomUUID(),r=await f.act('models.test',{kind:'organizer'},f.a,operation);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(calls,1);assert.ok(!text.includes('Never send'));
  assert.equal((await f.act('models.test',{kind:'organizer'},f.a,operation)).status,200);assert.equal(calls,1);
  assert.notEqual((await f.act('models.test',{kind:'organizer'})).status,200);assert.equal(calls,1);
});
test('CON-10: organizer jobs use existing persistent worker and cannot consume another owner/profile',async t=>{
  const f=await setup(t);f.store.memoryConfig.memory={taxonomy};for(const owner of [f.a,f.b])await create(f,owner);
  const model=organizer();model.profile=Object.freeze({...model.profile,fingerprint:'console-synthetic-profile'});
  f.store.consoleService.models.provider=()=>model;
  const p={type:'classification',timezone:'UTC',periods:['daily'],include_open:true},a=await f.act('jobs.schedule',p),b=await f.act('jobs.schedule',p,f.b);
  assert.equal(a.status,200,JSON.stringify(a.body));assert.equal(b.status,200);assert.notEqual(a.body.jobs[0],b.body.jobs[0]);
  assert.equal(f.store.memoryJobs.claim('legacy-worker',{userId:f.a.auth.user_id}),null);
  await new MemoryWorker(f.store,f.store.memoryJobs,model,{workerId:'synthetic-console',userId:f.a.auth.user_id,profileFilter:model.profile.fingerprint}).drain({maxJobs:10});
  assert.equal(f.store.memoryJobs.get(a.body.jobs[0]).state,'succeeded');assert.equal(f.store.memoryJobs.get(b.body.jobs[0]).state,'pending');
  assert.equal((await f.act('jobs.cancel',{job_id:b.body.jobs[0]})).status,404);
  assert.equal((await f.act('jobs.cancel',{job_id:b.body.jobs[0]},f.b)).status,200);
  assert.equal((await f.act('jobs.retry',{job_id:b.body.jobs[0]},f.b)).status,200);
});
test('CON-11: per-owner vector rebuilds never embed foreign memories or replace legacy activation',async t=>{
  const f=await setup(t),seen=[];await create(f,f.a,'Synthetic own network');await create(f,f.b,'Synthetic FOREIGN storage');
  const model=embedder(texts=>{seen.push(...texts);return texts.map(()=>[1,0,0]);}),backend=new MockVectorStore();
  const a=new VectorIndex(f.store,backend,new Map([[model.profile.fingerprint,model]]),{ownerId:f.a.auth.user_id});
  const b=new VectorIndex(f.store,backend,new Map([[model.profile.fingerprint,model]]),{ownerId:f.b.auth.user_id});
  const generation=a.begin(model.profile.fingerprint);assert.equal((await a.sync(generation)).complete,true);a.activate(generation);
  assert.ok(seen.every(s=>!s.includes('FOREIGN')));assert.throws(()=>b.snapshot());assert.throws(()=>b.activate(generation));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_vector_active').get().n,0);
  const search=await a.search(f.a.auth,{query:'network',mode:'semantic'});assert.equal(search.results.length,1);
  await assert.rejects(()=>a.search(f.b.auth,{query:'network',mode:'semantic'}));
});
test('CON-12: malformed identities, stale operation IDs and oversized input fail before mutation',async t=>{
  const f=await setup(t);for(const p of [{scope:'user',content:'x',user_id:f.b.auth.user_id},{scope:'user',content:'x',source:'made-up proof'},{scope:'project',project_id:'project-foreign',content:'x'}])assert.notEqual((await f.act('memory.create',p)).status,200);
  assert.equal((await f.act('memory.create',{scope:'user',content:'x'},f.a,'../invalid')).status,400);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n,0);
});

test('CON-13: every memory mutation requires a reviewed revision, and audit failure rolls the entire operation back',async t=>{
 const f=await setup(t),s=f.store.consoleService;const action=(action,payload)=>s.execute(f.a.auth,{action,payload,operation_id:randomUUID()});
 const created=await action('memory.create',{scope:'user',content:'Synthetic atomic operation'}),mid=created.memory_id;
 for(const action of ['memory.correct','memory.retract','memory.classify','memory.sensitivity','memory.visibility'])
   await assert.rejects(()=>s.execute(f.a.auth,{action,payload:{memory_id:mid},operation_id:randomUUID()}),/Invalid number/);
 const audit=f.store.audit.bind(f.store),before=f.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n;
 f.store.audit=args=>{if(args.action==='console.memory.create')throw new Error('Synthetic audit failure');return audit(args);};
 await assert.rejects(()=>action('memory.create',{scope:'user',content:'Must roll back'}),/Synthetic audit failure/);
 f.store.audit=audit;assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n,before);
});
test('CON-14: private model allocation is pinned and never inherits a shared model after removal',async t=>{
 const f=await setup(t),service=f.store.consoleService;let globalCalls=0,ownCalls=0;
 f.store.vectorIndex={search:async()=>{globalCalls++;return {results:[],retrieval:{effective_mode:'hybrid'}};}};
 await create(f);
 const denied=await f.store.searchMemories(f.a.auth,{query:'Synthetic',mode:'hybrid',personal_model_only:true});
 assert.equal(denied.retrieval.effective_mode,'lexical');assert.equal(globalCalls,0);
 await assert.rejects(()=>f.store.searchMemories(f.a.auth,{query:'Synthetic',mode:'semantic',personal_model_only:true}),e=>e.code==='SEMANTIC_UNAVAILABLE');
 await f.act('models.save',{kind:'embedder',expected_revision:0,config:{...config,dimensions:3}});
 service.vector=user=>({search:async(auth,payload)=>{assert.equal(user,f.a.auth.user_id);assert.equal(auth.user_id,user);assert.equal(payload.personal_model_only,true);ownCalls++;return {results:[],retrieval:{effective_mode:payload.mode}};}});
 assert.equal((await f.store.searchMemories(f.a.auth,{query:'Synthetic',mode:'semantic',personal_model_only:true})).retrieval.effective_mode,'semantic');
 assert.equal(ownCalls,1);assert.equal(globalCalls,0);
 await f.store.searchMemories(f.b.auth,{query:'Synthetic',mode:'hybrid'});assert.equal(globalCalls,1,'legacy operator-approved selection is unchanged');
 const metadata=await f.request('GET','/v1/identity',undefined,f.a);assert.equal(metadata.body.personal_retrieval.configured,true);
 assert.equal((await f.request('GET','/v1/identity',undefined,f.b)).body.personal_retrieval.configured,false);
});
test('CON-15: replay identifies current lifecycle; category counts include current manual overrides',async t=>{
 const f=await setup(t),op=randomUUID(),payload={content:'Synthetic replay lifecycle',scope:'user'};
 const created=await f.act('memory.create',payload,f.a,op),memory_id=created.body.memory_id;
 const meta=(await f.get('memory-meta',{memory_id})).body;
 await f.act('memory.classify',{memory_id,revision:meta.revision,category:'technical'});
 assert.equal((await f.get('summaries')).body.categories.find(c=>c.category==='technical').count,1);
 await f.act('memory.retract',{memory_id,revision:meta.revision});
 assert.equal((await f.act('memory.create',payload,f.a,op)).body.current_status,'retracted');
 assert.equal((await f.get('summaries')).body.categories.length,0);
});

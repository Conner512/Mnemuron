import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {fail} from '../lib/model-providers/contracts.mjs';
import {OwnerControls,migrateOwner} from '../lib/console/owner.mjs';

// Incremental catch-up of a serving first-run index. Synthetic embedder (loopback HTTP) and vector store only.
class PrecreatedStore extends MockVectorStore {
  constructor(names){super();this.precreated=names;this.expired=false;for(const name of names)this.collections.set(name,{config:{dimensions:3,distance:'Cosine'},points:new Map()});}
  available(){if(this.expired)fail('VECTOR_AUTH_FAILED');super.available();}
  async ensureCollection(name,config){this.available();if(!this.precreated.includes(name))fail('VECTOR_COLLECTION_MISSING');
    if(JSON.stringify(this.collections.get(name).config)!==JSON.stringify(config))fail('VECTOR_PROFILE_MISMATCH');}
  points(){return [...this.collections.values()].reduce((n,c)=>n+c.points.size,0);}
}

async function servingIndex(t){
  const f=await memoryFixture(t),key=f.root+'/vector-test.key';fs.writeFileSync(key,randomBytes(32).toString('base64url'),{mode:0o600});
  const calls=[];
  const model=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);calls.push(body);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({data:body.input.map((text,index)=>({index,embedding:/router/i.test(text)?[1,0,0]:[0,0,1]}))}));});
  await new Promise(r=>model.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>model.close(r)));
  const origin=`http://127.0.0.1:${model.address().port}`;
  f.store.memoryConfig.console={key_file:key,worker_enabled:true,allowed_private_origins:[origin]};
  f.store.memoryConfig.vector_store={enabled:true,collection_prefix:'synthetic'};
  const backend=new PrecreatedStore(['synthetic_first_v1']);f.store.consoleService.vectorBackend=()=>backend;
  const c=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-vector',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES});
  const owner={...c,auth:f.store.authenticate(c.api_key)},service=f.store.consoleService,user=owner.auth.user_id;
  const act=(action,payload)=>service.execute(owner.auth,{action,payload,operation_id:randomUUID()});
  const create=content=>act('memory.create',{scope:'user',content}).then(r=>r.memory_id);
  await act('models.save',{kind:'embedder',expected_revision:0,config:{enabled:true,protocol:'openai_compatible',base_url:origin,model:'synthetic-embedding',profile_revision:'1',
    daily_requests:100,output_tokens:4096,batch_size:5,egress_approved:true,query_approved:true,dimensions:3}});
  const ids={router:await create('Synthetic router decision.'),note:await create('Synthetic note.'),gone:await create('Synthetic soon retracted.')};
  const prepared=await act('vector.prepare',{budget_calls:40});
  await act('models.test',{kind:'embedder',mode:'capabilities'});
  await act('vector.schedule',{generation:prepared.generation,expected_count:prepared.manifest.count,expected_digest:prepared.manifest.digest});
  for(let n=0;n<20&&service.processing(user).vector.first_run.build==='pending';n++)await service.tick();
  await act('vector.activate',{generation:prepared.generation});
  return {...f,calls,backend,service,act,create,ids,user,generation:prepared.generation,index:()=>service.vector(user)};
}
const manifest=f=>f.store.db.prepare('SELECT memory_id,revision,state_hash,state FROM memory_vector_manifest WHERE generation=? ORDER BY memory_id').all(f.generation);
const docState=(f,id)=>f.store.db.prepare('SELECT state FROM memory_vector_documents WHERE generation=? AND memory_id=?').get(f.generation,id)?.state;

test('catch-up: new and corrected records join the serving index, stale ones are hidden, the frozen manifest is untouched',async t=>{
  const f=await servingIndex(t),frozen=manifest(f),builtCalls=f.calls.length,points=f.backend.points();
  assert.equal(f.index().catchUpPending(f.generation).length,0,'a fresh first run has nothing to catch up');
  const added=await f.create('Synthetic new router note.');
  const corrected=(await f.act('memory.correct',{memory_id:f.ids.note,revision:1,content:'Synthetic corrected note.'})).memory_id;
  await f.act('memory.retract',{memory_id:f.ids.gone,revision:1});
  const pending=f.index().catchUpPending(f.generation).map(p=>p.memory_id).sort();
  assert.deepEqual(pending,[added,corrected,f.ids.note,f.ids.gone].sort());
  const first=await f.index().catchUp(f.generation,{maxDocuments:2});assert.equal(first.processed,2);assert.equal(first.complete,false);assert.equal(first.remaining,2);
  const second=await f.index().catchUp(f.generation,{maxDocuments:2});assert.equal(second.complete,true);
  assert.equal(f.calls.length-builtCalls,2,'only the two new active records are embedded');
  assert.equal(docState(f,added),'indexed');assert.equal(docState(f,corrected),'indexed');
  assert.equal(docState(f,f.ids.note),'hidden');assert.equal(docState(f,f.ids.gone),'hidden');
  assert.equal(f.backend.points(),points,'two points added, two removed');
  assert.deepEqual(manifest(f),frozen,'the first-run manifest is never changed');
  const again=await f.index().catchUp(f.generation);assert.deepEqual([again.processed,again.complete],[0,true]);assert.equal(f.calls.length-builtCalls,2);
  const hit=await f.store.searchMemories(f.a.auth,{query:'router',mode:'semantic',limit:5});
  assert.ok(hit.results.some(r=>r.memory_id===added),'a caught-up record is found by semantic search');
});

test('catch-up in owner mode: opt-in flag, gated by the same blockers, bounded per tick, and backs off on failure',async t=>{
  const f=await servingIndex(t),{service,user}=f;
  f.store.memoryConfig={...f.store.memoryConfig,console:{...f.store.memoryConfig.console,owner_user_id:user,worker_enabled:false}};
  f.store.memoryTransaction(()=>migrateOwner(f.store.db,user,{memory:true,capture:false,handoff:false,connections:true}));service.owner=new OwnerControls(service);
  const owner=service.owner,added=await f.create('Synthetic router added later.'),before=f.calls.length;
  await service.tick();assert.equal(f.calls.length,before,'off by default');
  assert.ok(owner.view(user).effective.vector_catch_up.blockers.includes('FEATURE_DISABLED'));assert.equal(owner.view(user).vector_catch_up.pending,1);
  await f.act('features.save',{expected_revision:owner.policy().revision,flags:{vector_catch_up:true}});
  await service.tick();assert.equal(f.calls.length,before,'background processing paused still blocks it');
  assert.ok(service.owner.view(user).effective.vector_catch_up.blockers.includes('PROCESSING_PAUSED'));
  await f.act('features.save',{expected_revision:service.owner.policy().revision,flags:{processing:true,vector_catch_up:true}});
  assert.equal(service.owner.view(user).effective.vector_catch_up.effective,true);
  for(let n=0;n<3;n++){await f.create(`Synthetic extra ${n}.`);}
  await service.tick();assert.equal(f.calls.length-before,2,'at most two records per tick');
  service.catchUp.next_at=0;await service.tick();assert.equal(f.calls.length-before,4);assert.equal(docState(f,added),'indexed');
  assert.equal(service.owner.view(user).vector_catch_up.pending,0);
  f.backend.expired=true;await f.create('Synthetic while key rejected.');service.catchUp.next_at=0;const calls=f.calls.length;
  await service.tick();assert.equal(f.calls.length,calls,'a rejected vector-store key fails before any embedding call');
  assert.equal(service.catchUp.error_code,'VECTOR_AUTH_FAILED');assert.ok(service.catchUp.next_at>Date.now());
  f.backend.expired=false;await service.tick();assert.equal(f.calls.length,calls,'backoff holds until it expires');
  service.catchUp.next_at=0;await service.tick();assert.equal(f.calls.length,calls+1);assert.equal(service.catchUp.error_code,null);
  await f.act('features.save',{expected_revision:service.owner.policy().revision,flags:{processing:true,vector_catch_up:false}});
  const provider=service.models.provider(user,'embedder',{catchUp:true});
  await assert.rejects(provider.embed(['Synthetic text'],'document',{reserve:()=>{}}),e=>e.code==='EXECUTION_GRANT_REQUIRED','the grant ends with the flag');
  assert.equal(f.calls.length,calls+1);
});

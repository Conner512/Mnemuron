import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers/memory-models.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {OwnerControls,migrateOwner} from '../lib/console/owner.mjs';
import {CONSOLE_READ_SCOPES,CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {consoleRead} from '../lib/console-read.mjs';

const model={enabled:true,protocol:'openai_compatible',base_url:'https://synthetic.example.invalid/v1',model:'synthetic-only',profile_revision:'1',daily_requests:100,
  output_tokens:4096,batch_size:2,egress_approved:true,query_approved:true};
const code=value=>e=>(e.errorCode||e.code)===value;
function setup(t){
  const f=fixture(t),{s}=f,user=f.auth.user_id;
  const auth=s.authenticate(s.issueCredential({userId:user,label:'Synthetic owner',deviceId:'synthetic',agentId:'mnemuron-console',agentInstanceId:'synthetic',scopes:CONSOLE_WRITE_SCOPES}).api_key);
  s.memoryConfig={...s.memoryConfig,console:{owner_user_id:user,worker_enabled:false},vector_store:{enabled:true,collection_prefix:'synthetic_selected'}};
  s.memoryTransaction(()=>migrateOwner(s.db,user,{memory:true,capture:false,handoff:false,connections:true}));
  const service=s.consoleService;service.owner=new OwnerControls(service);const backend=new MockVectorStore();service.vectorBackend=()=>backend;service.probeVerified=()=>true;
  for(const kind of ['organizer','embedder'])s.db.prepare('INSERT INTO console_models VALUES(?,?,1,?,NULL,?)').run(user,kind,JSON.stringify({...model,...(kind==='embedder'?{dimensions:3}:{})}),Date.now());
  const real=service.models.provider.bind(service.models),sent=[];
  service.models.provider=(...args)=>{const p=real(...args);
    p.generateStructured=async(input,schema,{reserve})=>{reserve();sent.push({kind:'organizer',ids:input.sources.map(i=>i.memory_id)});
      return {data:{results:input.sources.map(m=>input.operation==='traits'?{memory_id:m.memory_id,revision:m.revision,kind:'fact',concepts:['Synthetic'],strength:5}
        :{memory_id:m.memory_id,revision:m.revision,start:0,end:m.content.length,quote:m.content})}};};
    p.embed=async(texts,type,{reserve})=>{reserve();sent.push({kind:'embedder',texts});return {vectors:texts.map(()=>[1,0,0])};};return p;};
  const act=(action,payload,operation_id=randomUUID())=>service.execute(auth,{action,payload,operation_id});
  const pinned=m=>({memory_id:m.memory_id,revision:s.revisions.latest(user,m.memory_id).revision});
  return {...f,user,auth,service,owner:service.owner,backend,sent,act,pinned,
    enable:()=>act('features.save',{expected_revision:service.owner.policy().revision,flags:{processing:true,summary:true,traits:true,vector_build:true}}),
    preview:(kind,memories,budget=20)=>act('processing.preview',{kind,limit:memories.length,budget,items:memories.map(pinned)}),
    read:m=>consoleRead(s,auth,'memory-processing',pinned(m))};
}
async function serving(f){
  f.save('Synthetic already indexed seed');await f.enable();
  const p=await f.act('processing.preview',{kind:'vector',limit:1,budget:5});await f.act('processing.start',{run_id:p.run_id,digest:p.digest});
  await f.service.tick();await f.service.tick();const run=f.owner.run(f.user,p.run_id);
  assert.equal(run.state,'completed');await f.act('vector.activate',{generation:run.generation});return run.generation;
}

test('processing evidence is local, version pinned, read-only and owner scoped',async t=>{
  const f=setup(t),m=f.save('Synthetic complete manual memory',{kind:'workflow',concepts:['Manual'],strength:9});
  const data=await f.read(m);assert.equal(data.revision,1);assert.equal(data.source.status,'available');assert.equal(data.traits.status,'complete');
  assert.equal(data.summary.status,'missing');assert.equal(data.vector.status,'not_ready');assert.equal(data.production_content_sent,false);assert.equal(f.sent.length,0);
  const other=f.s.authenticate(f.s.issueCredential({userId:'synthetic-other',label:'Other',deviceId:'other',agentId:'mnemuron-console',agentInstanceId:'other',scopes:CONSOLE_READ_SCOPES}).api_key);
  await assert.rejects(consoleRead(f.s,other,'memory-processing',f.pinned(m)),code('INSUFFICIENT_SCOPE'));
  await assert.rejects(consoleRead(f.s,f.auth,'memory-processing',{memory_id:m.memory_id,revision:9}),code('MEMORY_VERSION_CHANGED'));
  f.s.retractMemory(f.auth,m.memory_id);const withdrawn=await f.read(m);assert.equal(withdrawn.source.status,'inactive');assert.equal(f.sent.length,0);
});

test('selected keyword fill skips complete records and preserves every manually supplied trait',async t=>{
  const f=setup(t),manual=f.save('Synthetic complete',{kind:'workflow',concepts:['Manual'],strength:9}),partial=f.save('Synthetic missing strength',{kind:'preference',concepts:['Manual']}),outside=f.save('Synthetic unselected');
  await f.enable();const p=await f.preview('traits',[manual,partial]);assert.equal(p.selection,'explicit');assert.equal(p.count,1);assert.equal(p.already_complete,1);assert.equal(f.sent.length,0);
  assert.deepEqual(p.items.map(i=>[i.memory_id,i.revision]),[[partial.memory_id,1]]);
  await f.act('processing.start',{run_id:p.run_id,digest:p.digest});await f.service.tick();
  assert.deepEqual(f.sent[0].ids,[partial.memory_id]);assert.deepEqual(f.s.traits.get(f.user,partial.memory_id),{kind:'preference',concepts:['Manual'],strength:5});
  assert.equal(f.s.traits.get(f.user,manual.memory_id).strength,9);assert.equal(f.s.traits.get(f.user,outside.memory_id).kind,null);
  const status=await f.read(partial);assert.equal(status.traits.status,'complete');assert.equal(status.runs.items[0].state,'completed');assert.equal(status.jobs.items[0].item_state,'done');
  await assert.rejects(f.preview('traits',[partial]),code('MANIFEST_EMPTY'));
});

test('selected summary repair only reads missing revisions and does not resend earlier successful summaries',async t=>{
  const f=setup(t),first=f.save('Synthetic summary first'),outside=f.save('Synthetic not authorized');await f.enable();
  const p=await f.preview('summary',[first]);await f.act('processing.start',{run_id:p.run_id,digest:p.digest});await f.service.tick();
  assert.equal((await f.read(first)).summary.status,'covered');assert.equal((await f.read(outside)).summary.status,'missing');
  const second=f.save('Synthetic summary second'),next=await f.preview('summary',[first,second]);assert.equal(next.count,1);assert.equal(next.already_complete,1);
  await f.act('processing.start',{run_id:next.run_id,digest:next.digest});await f.service.tick();assert.deepEqual(f.sent.map(s=>s.ids),[[first.memory_id],[second.memory_id]]);
  assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM memory_summaries WHERE status='current'").get().n,2);
});

test('selected previews reject duplicate, oversized, foreign, inactive and stale inputs before freezing or replaying',async t=>{
  const f=setup(t),m=f.save('Synthetic pinned');await f.enable();const item=f.pinned(m),before=f.s.db.prepare('SELECT COUNT(*) n FROM owner_processing_runs').get().n;
  for(const items of [[],[item,item],Array.from({length:51},()=>item)])await assert.rejects(f.act('processing.preview',{kind:'summary',limit:items.length||1,budget:2,items}));
  await assert.rejects(f.act('processing.preview',{kind:'summary',limit:1,budget:2,items:[{...item,revision:9}]}),code('MEMORY_VERSION_CHANGED'));
  await assert.rejects(f.act('processing.preview',{kind:'summary',limit:1,budget:2,items:[{memory_id:'synthetic-foreign',revision:1}]}),code('MEMORY_NOT_FOUND'));
  assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM owner_processing_runs').get().n,before);
  const operation=randomUUID(),payload={kind:'summary',limit:1,budget:2,items:[item]},p=await f.act('processing.preview',payload,operation);
  assert.equal((await f.act('processing.preview',payload,operation)).run_id,p.run_id);
  f.s.retractMemory(f.auth,m.memory_id);
  await assert.rejects(f.act('processing.preview',payload,operation),code('MEMORY_VERSION_CHANGED'));
  await assert.rejects(f.act('processing.start',{run_id:p.run_id,digest:p.digest}),code('STALE_INPUT'));assert.equal(f.sent.length,0);
});

test('selected vector repair uses the serving index and leaves other pending records, manifest and build request unchanged',async t=>{
  const f=setup(t),generation=await serving(f),selected=f.save('Synthetic selected vector'),outside=f.save('Synthetic outside vector');
  const manifest=f.s.db.prepare('SELECT * FROM memory_vector_manifest WHERE generation=?').all(generation),request=f.s.db.prepare('SELECT * FROM console_vector_requests WHERE user_id=?').get(f.user);
  const calls=f.sent.length,p=await f.preview('vector',[selected]);assert.equal(p.serving_generation,generation);
  await f.act('processing.start',{run_id:p.run_id,digest:p.digest});await f.service.tick();
  assert.equal(f.sent.length,calls+1);assert.deepEqual(f.sent.at(-1).texts,[selected.content]);assert.equal((await f.read(selected)).vector.status,'indexed');assert.equal((await f.read(outside)).vector.status,'missing');
  assert.equal(f.owner.run(f.user,p.run_id).state,'completed');assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM memory_vector_generations').get().n,1);
  assert.equal(f.s.db.prepare('SELECT generation FROM memory_vector_owner_active WHERE user_id=?').get(f.user).generation,generation);
  assert.deepEqual(f.s.db.prepare('SELECT * FROM console_vector_requests WHERE user_id=?').get(f.user),request);
  assert.deepEqual(f.s.db.prepare('SELECT * FROM memory_vector_manifest WHERE generation=?').all(generation),manifest);
  await assert.rejects(f.preview('vector',[selected]),code('MANIFEST_EMPTY'));
});

test('selected preview replay fences same-revision state changes and run lists withhold changed source titles',async t=>{
  const f=setup(t),m=f.save('Synthetic original frozen title');await f.enable();const item=f.pinned(m),op=randomUUID(),payload={kind:'summary',limit:1,budget:5,items:[item]};
  const p=await f.act('processing.preview',payload,op);assert.equal(f.owner.previewItems(f.user,p.run_id)[0].stale,false);
  f.s.derivedMemory.setCategory(f.auth,m.memory_id,'uncategorized',f.service.taxonomy(f.user));
  assert.equal(f.s.revisions.latest(f.user,m.memory_id).revision,item.revision);
  await assert.rejects(f.act('processing.preview',payload,op),code('STALE_INPUT'));
  const stale=f.owner.previewItems(f.user,p.run_id)[0];assert.equal(stale.stale,true);assert.equal(stale.content_withheld,true);assert.equal(stale.title,undefined);
  const fresh=await f.preview('summary',[m]);f.s.db.prepare('UPDATE memories SET content=? WHERE memory_id=? AND user_id=?').run('Synthetic newer title never authorized by the old preview',m.memory_id,f.user);
  f.s.revisions.record(f.s.db.prepare('SELECT * FROM memories WHERE user_id=? AND memory_id=?').get(f.user,m.memory_id),'synthetic_import');
  const shown=f.owner.view(f.user).runs.find(r=>r.run_id===fresh.run_id).items[0];assert.equal(shown.revision,item.revision);assert.equal(shown.stale,true);assert.equal(shown.title,undefined);
  assert.equal(JSON.stringify(shown).includes('newer title'),false);assert.equal(f.sent.length,0);
});

test('project deletion and restoration invalidate old selected preview receipts without reviving their titles',async t=>{
  const f=setup(t),project='synthetic-processing-restored';f.s.handoffPolicy.setEnabled(true);
  const admin=f.s.authenticate(f.s.issueCredential({userId:f.user,deviceId:'synthetic-admin',agentId:'synthetic-admin',agentInstanceId:randomUUID(),scopes:['admin:tasks']}).api_key);
  f.s.upsertProject(admin,{project_id:project,name:'Synthetic Processing Project'});
  const m=f.save('Synthetic project preview',{scope:'project',project_id:project});await f.enable();const payload={kind:'summary',limit:1,budget:5,items:[f.pinned(m)]},op=randomUUID();
  const p=await f.act('processing.preview',payload,op),deletion=await f.act('projects.lifecycle_preview',{action:'delete',project_id:project});
  await f.act('projects.lifecycle_delete',{preview_id:deletion.preview_id,confirm_name:'Synthetic Processing Project'});
  assert.equal(f.owner.previewItems(f.user,p.run_id)[0].title,undefined);
  const restoration=await f.act('projects.lifecycle_preview',{action:'restore',project_id:project});await f.act('projects.lifecycle_restore',{preview_id:restoration.preview_id});
  assert.ok(f.s.derivedMemory.currentSource(f.user,m.memory_id));
  await assert.rejects(f.act('processing.preview',payload,op),code('STALE_INPUT'));
  assert.equal(f.owner.previewItems(f.user,p.run_id)[0].stale,true);assert.equal(f.sent.length,0);
});

test('selected vector repair retries a lost publish acknowledgement without repeating confirmed embeddings',async t=>{
  const f=setup(t);await serving(f);const m=f.save('Synthetic publication retry'),p=await f.preview('vector',[m]),publish=f.backend.publishBuild.bind(f.backend);let once=true;
  f.backend.publishBuild=async(...args)=>{await publish(...args);if(once){once=false;throw Object.assign(new Error('synthetic lost acknowledgement'),{code:'NETWORK_ERROR'});}};
  await f.act('processing.start',{run_id:p.run_id,digest:p.digest});await f.service.tick();assert.equal(f.owner.run(f.user,p.run_id).state,'blocked');
  const partial=await f.read(m);assert.equal(partial.vector.status,'partial');assert.equal(partial.vector.confirmed_chunks,1);const calls=f.sent.length;
  await f.act('processing.resume',{run_id:p.run_id,digest:p.digest});await f.service.tick();assert.equal(f.sent.length,calls);assert.equal((await f.read(m)).vector.status,'indexed');
});

test('serving generation changes and in-flight source withdrawal fence targeted vector publication',async t=>{
  const f=setup(t),generation=await serving(f),m=f.save('Synthetic frozen vector'),p=await f.preview('vector',[m]);
  await f.act('vector.deactivate',{generation});await assert.rejects(f.act('processing.start',{run_id:p.run_id,digest:p.digest}),code('VECTOR_GENERATION_CHANGED'));
  await f.act('vector.activate',{generation});const next=await f.preview('vector',[m]);await f.act('processing.start',{run_id:next.run_id,digest:next.digest});
  const base=f.service.models.provider;let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  f.service.models.provider=(...args)=>{const provider=base(...args),embed=provider.embed;provider.embed=async(...a)=>{const result=await embed(...a);enter();await gate;return result;};return provider;};
  const tick=f.service.tick();await entered;f.s.retractMemory(f.auth,m.memory_id);release();await tick;
  assert.equal(f.owner.run(f.user,next.run_id).state,'blocked');
  assert.equal(f.s.db.prepare("SELECT COUNT(*) n FROM memory_vector_documents WHERE user_id=? AND memory_id=? AND state='indexed'").get(f.user,m.memory_id).n,0);
});

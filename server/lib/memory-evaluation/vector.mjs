import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {MnemuronStore} from '../store.mjs';
import {VectorIndex,surrogate} from '../vector-stores/index.mjs';
import {QdrantStore,vectorConfig} from '../vector-stores/qdrant.mjs';
import {Embedder} from '../model-providers/providers.mjs';
import {ModelError,fail,digest} from '../model-providers/contracts.mjs';
import {requestJSON} from '../model-providers/transport.mjs';
import {storageDoctor,realDestination} from '../storage-policy.mjs';

const write=(run,name,data)=>writeFileSync(path.join(run,name),JSON.stringify(data,null,2),{flag:'wx',mode:0o600});
const runtime={config_version:'mnemuron-memory-first-v1',deployment_mode:'test',development:{synthetic_data:true},modules:{memory:{enabled:true},handoff:{enabled:false,existing_inflight_policy:'drain_before_disable'}},memory:{capture_extraction:{enabled:false}}};
const basis=(axis=0)=>Array.from({length:768},(_,n)=>Number(n===axis));
const embedding=text=>text==='8.4.1'?basis(0):text.includes('version 8.4.1 is')?basis(0).map((v,n)=>n===0?0.8:n===3?0.6:v):
  /网络|network|router|packet/i.test(text)?basis(0):/storage|disk|磁盘/i.test(text)?basis(1):basis(2);
const model=revision=>new Embedder({enabled:true,provider_id:'synthetic-qdrant-contract',protocol:'mock',model:'deterministic-basis',profile_revision:revision,auth:{none:true},
  timeouts:{request_ms:1000},limits:{input_bytes:1000000,input_tokens:4096,output_bytes:1000000,output_tokens:10000,batch_size:8,concurrency:1,daily_requests:10000},
  retry:{max_attempts:1,base_ms:100,max_ms:100,repair_once:false},capabilities:{native_schema:true},
  egress:{approved:true,origins:[],addresses:[],allow_private:false,sensitivities:['public','internal','sensitive'],query_approved:true},
  dimensions:768,distance:'Cosine',query_prefix:'',document_prefix:'',normalization:'l2',chunker_version:'utf8-chunks-v1'},
  {synthetic:true,mock:async texts=>texts.map(embedding)});

export function vectorAcceptanceTarget(input){
  const config=vectorConfig(input);
  if(!config.enabled || new URL(config.base_url).hostname!=='127.0.0.1' || config.egress.addresses.length!==1 || config.egress.addresses[0]!=='127.0.0.1' ||
    config.egress.origins.length!==1 || config.egress.origins[0]!==config.base_url)fail('LOOPBACK_ACCEPTANCE_REQUIRED');
  return config;
}

// This harness never opens configured databases, calls a model or starts a service.
// Lifecycle callbacks are optional operator-owned actions on an already isolated backend.
export async function evaluateVector(options={}){
  if(options.allowNetwork!==true)fail('NETWORK_NOT_ALLOWED');
  const {output,config,lifecycle=null,onProgress=()=>{}}=options;
  const target=vectorAcceptanceTarget(config);
  storageDoctor({evidence_dir:output});const destination=realDestination(output),permissions=statSync(destination);
  if(!permissions.isDirectory() || permissions.mode & 0o077)fail('PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');
  const run=mkdtempSync(path.join(destination,'synthetic-vector-')),prefix='acceptance_'+randomUUID().replaceAll('-','').slice(0,16);
  const expected=['authenticated_health','unauthenticated_denied','wrong_key_denied','collection_dimensions','rest_upsert_query_scroll_delete',
    'memory_backfill_payload_privacy','owner_project_session_isolation','sql_hydration_backstop','hybrid_exact_and_dedup','identifier_prefix_boundary','upsert_response_loss_retry',
    'sqlite_reopen_persistence','source_invalidation_late_points','generation_catchup_and_switch','late_worker_fencing','orphan_scroll_cleanup',
    'backend_stop_fallback_restart','no_handoff_state'];
  write(run,'preflight.json',{version:'synthetic-qdrant-acceptance-v1',at:new Date().toISOString(),expected_cases:expected,thresholds:{required_case_pass_rate:1,scope_leaks:0,duplicate_atoms:0,source_body_in_payload:0},
    backend_protocol:target.protocol,collection_prefix:prefix,embedding:{protocol:'mock',dimensions:768,method:'deterministic-basis',semantic_quality_accepted:false},
    synthetic_only:true,configured_database_opened:false,model_network_calls:0,service_started:false,lifecycle_callbacks:!!lifecycle,environment:{node:process.version,platform:process.platform,arch:process.arch}});
  const result={synthetic_only:true,production_ready:false,model_network_calls:0,semantic_quality:'not_run',cases:[],collections:[],at:new Date().toISOString()};
  const check=async(name,fn)=>{
    const started=Date.now();try{const detail=await fn();result.cases.push({name,status:'passed',duration_ms:Date.now()-started,...(detail?{detail}:{})});}
    catch(error){result.cases.push({name,status:'failed',error_code:error instanceof ModelError?error.code:error?.code==='ERR_ASSERTION'?'ASSERTION_FAILED':'ACCEPTANCE_FAILED'});}
    onProgress(result.cases.at(-1));
  };
  const backend=new QdrantStore(target),scroll=async name=>{let offset=null,rows=[];do{const page=await backend.scroll(name,offset);rows.push(...page.points);offset=page.next_page_offset ?? null;}while(offset!==null);return rows;};
  let s=new MnemuronStore(run+'/synthetic.sqlite3',{memoryConfig:runtime}),e=model('v1'),index=new VectorIndex(s,backend,new Map([[e.profile.fingerprint,e]]),{prefix});
  const authFor=userId=>s.authenticate(s.issueCredential({userId,label:'Synthetic vector acceptance',deviceId:'synthetic-device',agentId:'synthetic',agentInstanceId:'synthetic-vector',scopes:['memory:read','memory:write','memory:retention']}).api_key);
  const auth=authFor('synthetic-owner'),other=authFor('synthetic-other-owner');
  const save=(content,extras={})=>s.saveMemory(auth,{scope:'user',content,...extras}).memory;
  const memories={},bindings={project_id:'synthetic-project-a',session_id:'synthetic-session-a'};
  let generation,second;
  try{
    await check('authenticated_health',async()=>{const health=await backend.health();assert.equal(health.version,'1.19.0');return health;});
    await check('unauthenticated_denied',async()=>{await assert.rejects(requestJSON({...target,auth:{none:true}},'/collections',undefined,{method:'GET'}),error=>error.code==='AUTH_FAILED');});
    await check('wrong_key_denied',async()=>{const wrong=new QdrantStore({...target,auth:{env:'SYNTHETIC_INVALID_KEY'}},{env:{SYNTHETIC_INVALID_KEY:'synthetic-deliberately-invalid'}});
      await assert.rejects(wrong.call('/collections',undefined,'GET'),error=>error.code==='AUTH_FAILED');});
    const contract=prefix+'_contract';result.collections.push(contract);
    await check('collection_dimensions',async()=>{await backend.ensureCollection(contract,{dimensions:768,distance:'Cosine'});await backend.ensureCollection(contract,{dimensions:768,distance:'Cosine'});
      await assert.rejects(backend.ensureCollection(contract,{dimensions:3,distance:'Cosine'}),error=>error.code==='VECTOR_PROFILE_MISMATCH');});
    await check('rest_upsert_query_scroll_delete',async()=>{
      const points=Array.from({length:205},(_,i)=>({id:randomUUID(),vector:basis(i%3),payload:{ordinal:i}}));
      for(let n=0;n<points.length;n+=64)await backend.upsert(contract,points.slice(n,n+64));
      await backend.upsert(contract,points.slice(0,3));const rows=await scroll(contract);assert.equal(rows.length,205);assert.equal(new Set(rows.map(p=>p.id)).size,205);
      const hits=await backend.search(contract,basis(0),{must:[{key:'ordinal',match:{value:3}}]},10);assert.deepEqual(hits.map(p=>p.id),[points[3].id]);
      await backend.deleteByDocumentRevision(contract,{must:[{has_id:[points[3].id]}]});assert.equal((await scroll(contract)).length,204);
      return {upserts:208,unique_points:205,pages:Math.ceil(rows.length/100),filtered_hits:1,deleted:1};
    });
    await check('memory_backfill_payload_privacy',async()=>{
      s.ensureProject(auth,bindings.project_id,'Synthetic A');s.ensureProject(auth,'synthetic-project-b','Synthetic B');
      memories.router=save('Synthetic router version 8.4.1 is approved.');memories.near=save('Synthetic router version 8.4.10 is rejected.');
      memories.disk=save('Synthetic disk storage has 200 GB.');
      memories.long=save('Synthetic network unicode body: '+('字段🙂 payload only belongs in SQLite. '.repeat(75)));
      memories.project=save('Synthetic network project A',{scope:'project',project_id:bindings.project_id});
      memories.wrongProject=save('Synthetic network project B',{scope:'project',project_id:'synthetic-project-b'});
      memories.session=save('Synthetic network session A',{scope:'session',project_id:bindings.project_id,session_id:bindings.session_id});
      memories.wrongSession=save('Synthetic network session B',{scope:'session',project_id:bindings.project_id,session_id:'synthetic-session-b'});
      memories.foreign=s.saveMemory(other,{scope:'user',content:'Synthetic network other owner'}).memory;
      generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);result.collections.push(index.snapshot().collection_name);
      const points=await scroll(index.snapshot().collection_name);assert.ok(points.length>9);
      for(const point of points){assert.deepEqual(Object.keys(point.payload).sort(),['content_hash','document','lifecycle','owner','profile','revision','scope']);
        assert.doesNotMatch(JSON.stringify(point.payload),/Synthetic|字段|router|synthetic-owner|synthetic-project/);assert.equal(Object.hasOwn(point,'vector'),false);}
      assert.equal((await index.sync(generation)).processed,0);assert.equal((await scroll(index.snapshot().collection_name)).length,points.length);
      return {memories:9,points:points.length,repeat_processed:0,payload_body_fields:0};
    });
    const forbidden=()=>[memories.foreign,memories.wrongProject,memories.wrongSession].map(m=>m.memory_id);
    await check('owner_project_session_isolation',async()=>{
      for(const mode of ['lexical','semantic','hybrid']){
        const r=await index.search(auth,{query:'network',mode,...bindings,limit:20}),ids=r.results.map(m=>m.memory_id);
        assert.ok(ids.includes(memories.project.memory_id));assert.ok(ids.includes(memories.session.memory_id));assert.ok(ids.every(id=>!forbidden().includes(id)));
      }
      const rows=await scroll(index.snapshot().collection_name),wrong=rows.filter(p=>forbidden().some(id=>p.payload.document===surrogate([id===memories.foreign.memory_id?other.user_id:auth.user_id,id])));
      const original=backend.search.bind(backend);let inspected=false;
      backend.search=async(...args)=>{const hits=await original(...args);assert.ok(hits.every(p=>!wrong.some(w=>w.id===p.id)));inspected=true;return hits;};
      try{await index.search(auth,{query:'network',mode:'semantic',...bindings});assert.ok(inspected);}finally{backend.search=original;}
      return {modes:3,forbidden_owners_projects_sessions:3,leaks:0};
    });
    await check('sql_hydration_backstop',async()=>{
      const snap=index.snapshot(),rows=await scroll(snap.collection_name),original=backend.search.bind(backend);
      backend.search=async(...args)=>[...rows,...await original(...args)];
      try{const r=await index.search(auth,{query:'network',mode:'semantic',...bindings,limit:20});assert.ok(r.results.length);assert.ok(r.results.every(m=>!forbidden().includes(m.memory_id)));}
      finally{backend.search=original;}
    });
    await check('hybrid_exact_and_dedup',async()=>{
      const exact=await index.search(auth,{query:'8.4.1',mode:'hybrid',...bindings});assert.equal(exact.results[0].memory_id,memories.router.memory_id);
      const r=await index.search(auth,{query:'network',mode:'hybrid',...bindings,limit:20});assert.equal(new Set(r.results.map(m=>m.memory_id)).size,r.results.length);
      assert.equal(r.results.filter(m=>m.memory_id===memories.long.memory_id).length,1);assert.ok(r.results.every(m=>m.ranking.method==='rrf-v1'));
      assert.equal(s.memoryDetail(auth,memories.long.memory_id).memory.content,memories.long.content);
    });
    await check('identifier_prefix_boundary',async()=>{
      const result=await index.search(auth,{query:'8.4.1',mode:'semantic',...bindings});assert.equal(result.results[0].memory_id,memories.router.memory_id);
      assert.deepEqual(result.results[0].ranking.matched_by,['semantic']);
      return {query:'8.4.1',forbidden_exact_prefix:'8.4.10',semantic_vector_rank_deliberately_prefers_near_version:true};
    });
    await check('upsert_response_loss_retry',async()=>{
      const pending=save('Synthetic network pending after committed write response loss.');let lost=false;
      index.backend=new QdrantStore(target,{transport:async(...args)=>{const result=await requestJSON(...args);if(!lost && args[1].includes('/points?')){lost=true;throw new ModelError('NETWORK_ERROR');}return result;}});
      try{await assert.rejects(index.sync(generation),error=>error.code==='NETWORK_ERROR');assert.ok(lost);
        assert.notEqual(s.db.prepare('SELECT state FROM memory_index_outbox WHERE memory_id=?').get(pending.memory_id).state,'indexed');
      }finally{index.backend=backend;}
      await index.sync(generation);assert.equal((await index.sync(generation)).processed,0);
      const rows=(await scroll(index.snapshot().collection_name)).filter(p=>p.payload.document===surrogate([auth.user_id,pending.memory_id]));assert.equal(rows.length,1);
      return {committed_response_lost:true,retry_points:1,duplicate_points:0};
    });
    await check('sqlite_reopen_persistence',async()=>{
      const before=index.snapshot();s.close();s=new MnemuronStore(run+'/synthetic.sqlite3',{memoryConfig:runtime});index=new VectorIndex(s,backend,new Map([[e.profile.fingerprint,e]]),{prefix});
      assert.deepEqual(index.snapshot(),before);assert.equal((await index.sync(generation)).processed,0);
      assert.equal((await index.search(auth,{query:'8.4.1',mode:'hybrid',...bindings})).results[0].memory_id,memories.router.memory_id);
    });
    await check('source_invalidation_late_points',async()=>{
      const snap=index.snapshot(),before=(await scroll(snap.collection_name)).find(p=>p.payload.document===surrogate([auth.user_id,memories.disk.memory_id]));
      s.retractMemory(auth,memories.disk.memory_id);await backend.upsert(snap.collection_name,[{...before,vector:basis(1)}]);
      assert.ok(!(await index.search(auth,{query:'disk',mode:'semantic',...bindings})).results.some(m=>m.memory_id===memories.disk.memory_id));
      s.memorySources.setSensitivity(auth,memories.long.memory_id,'secret');
      assert.ok(!(await index.search(auth,{query:'network',mode:'semantic',...bindings,limit:20})).results.some(m=>m.memory_id===memories.long.memory_id));
      await index.sync(generation);const rows=await scroll(snap.collection_name);assert.ok(rows.every(p=>![memories.disk,memories.long].some(m=>p.payload.document===surrogate([auth.user_id,m.memory_id]))));
    });
    await check('generation_catchup_and_switch',async()=>{
      const next=model('v2');index.embedders.set(next.profile.fingerprint,next);second=index.begin(next.profile.fingerprint);await index.sync(second);
      save('Synthetic network created during rebuild.');assert.throws(()=>index.activate(second),error=>error.code==='VECTOR_CATCHUP_REQUIRED');await index.sync(second);
      const old=index.snapshot(),original=e.mock,originalSearch=backend.search.bind(backend);let collection;
      e.mock=async(...args)=>{index.activate(second);return original(...args);};backend.search=async(...args)=>{collection=args[0];return originalSearch(...args);};
      try{const result=await index.search(auth,{query:'network',mode:'semantic',...bindings});assert.equal(result.retrieval.generation,old.generation);assert.equal(collection,old.collection_name);}
      finally{e.mock=original;backend.search=originalSearch;}
      const current=index.snapshot();assert.notEqual(current.profile,old.profile);assert.notEqual(current.collection_name,old.collection_name);assert.equal(next.profile.dimensions,e.profile.dimensions);
      generation=second;e=next;result.collections.push(current.collection_name);
    });
    await check('late_worker_fencing',async()=>{
      const pending=save('Synthetic network fenced late worker.'),original=e.mock;
      e.mock=async(...args)=>{s.db.prepare('UPDATE memory_vector_generations SET fence=fence+1,lease_owner=NULL,lease_expires=NULL WHERE generation=?').run(generation);return original(...args);};
      try{await assert.rejects(index.sync(generation),error=>error.code==='STALE_INPUT');}finally{e.mock=original;}
      assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM memory_vector_points WHERE memory_id=? AND generation=?').get(pending.memory_id,generation).n,0);
      await index.sync(generation);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM memory_vector_points WHERE memory_id=? AND generation=?').get(pending.memory_id,generation).n,1);
    });
    await check('orphan_scroll_cleanup',async()=>{
      const snap=index.snapshot(),before=(await scroll(snap.collection_name)).length;
      const points=Array.from({length:105},()=>({id:randomUUID(),vector:basis(0),payload:{owner:surrogate(auth.user_id),scope:surrogate('synthetic-orphan'),document:surrogate(randomUUID()),revision:999,profile:snap.profile,content_hash:digest('synthetic'),lifecycle:'active'}}));
      for(let n=0;n<points.length;n+=64)await backend.upsert(snap.collection_name,points.slice(n,n+64));
      assert.equal((await index.reconcile(generation)).removed,105);assert.equal((await scroll(snap.collection_name)).length,before);
      assert.equal((await index.reconcile(generation)).removed,0);return {orphans_removed:105,repeat_removed:0};
    });
    if(lifecycle){await check('backend_stop_fallback_restart',async()=>{
      const snap=index.snapshot(),before=(await scroll(snap.collection_name)).length;await lifecycle.stop();
      try{const pending=save('Synthetic network saved while vector backend is stopped.');
        await assert.rejects(index.sync(generation));const fallback=await index.search(auth,{query:'8.4.1',mode:'hybrid',...bindings});
        assert.equal(fallback.retrieval.degraded,true);assert.equal(fallback.results[0].memory_id,memories.router.memory_id);
        await assert.rejects(index.search(auth,{query:'network',mode:'semantic',...bindings}),error=>error.code==='SEMANTIC_UNAVAILABLE');
        assert.notEqual(s.db.prepare('SELECT state FROM memory_index_outbox WHERE memory_id=?').get(pending.memory_id).state,'indexed');
      }finally{await lifecycle.start();}
      assert.equal((await scroll(snap.collection_name)).length,before);await index.sync(generation);assert.equal((await scroll(snap.collection_name)).length,before+1);
      assert.equal((await index.search(auth,{query:'8.4.1',mode:'hybrid',...bindings})).retrieval.degraded,false);
    });}else{result.cases.push({name:'backend_stop_fallback_restart',status:'not_run',reason:'OPERATOR_LIFECYCLE_NOT_PROVIDED'});}
    await check('no_handoff_state',async()=>{for(const table of ['tasks','resumes','resume_delivery_receipts'])assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);});
  }finally{s.close();}
  result.status=result.cases.length!==expected.length || result.cases.some(c=>c.status==='failed')?'failed':result.cases.some(c=>c.status==='not_run')?'partial':'passed';
  result.finished_at=new Date().toISOString();write(run,'results.json',result);return {run,...result};
}

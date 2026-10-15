import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,statSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {MnemuronStore} from '../store.mjs';
import {MemoryJobs} from '../memory-jobs/store.mjs';
import {MemoryWorker,scheduleLibrary} from '../memory-jobs/worker.mjs';
import {Organizer,Embedder} from '../model-providers/providers.mjs';
import {requestJSON} from '../model-providers/transport.mjs';
import {ModelError,fail,digest,strictObject,validateProfile} from '../model-providers/contracts.mjs';
import {VectorIndex,surrogate} from '../vector-stores/index.mjs';
import {QdrantStore} from '../vector-stores/qdrant.mjs';
import {storageDoctor,realDestination} from '../storage-policy.mjs';
import {vectorAcceptanceTarget} from './vector.mjs';
import {summaryMetrics,rankMetrics} from './quality.mjs';

export function jointFixture(){
  return {version:'synthetic-memory-joint-v1',documents:[
    {id:'release',content:'Synthetic router release 17.9.8 is approved; 17.9.9 is NOT approved.',category:'engineering'},
    {id:'disk',content:'合成实验的磁盘容量是 200 GB，不是 2 TB。',category:'engineering'},
    {id:'replicas',content:'Synthetic engineering decision: keep exactly 3 service replicas.',category:'engineering'},
    {id:'suggestion',content:'For the synthetic network, the assistant suggested opening a port; the user has not approved that suggestion.',category:'engineering'},
    {id:'near-release',content:'Synthetic router release 17.9.80 is rejected for the laboratory network.',category:'engineering'},
  ],guards:[
    {id:'other-owner',content:'Synthetic other owner: disk capacity is 900 GB.',kind:'owner'},
    {id:'other-session',content:'Synthetic other session: keep exactly 99 replicas.',kind:'session'},
    {id:'other-project',content:'Synthetic other project: router release 17.9.8 is approved.',kind:'project'},
    {id:'secret',content:'FORBIDDEN_SYNTHETIC_DATA secret source must not leave SQLite.',kind:'secret'},
  ],queries:[
    {id:'exact-release',kind:'exact',mode:'hybrid',query:'17.9.8',expected:['release']},
    {id:'semantic-disk',kind:'semantic',mode:'semantic',query:'How much disk space is available in the experiment?',expected:['disk']},
    {id:'semantic-replicas',kind:'semantic',mode:'semantic',query:'服务应保留几份副本？',expected:['replicas']},
  ],retraction_query:'Which synthetic router release is approved?',taxonomy:{version:'synthetic-joint-taxonomy-v1',categories:['uncategorized','engineering']},
  call_limits:{organizer:2,embedder:12},thresholds:{top1:1,scope_leaks:0,summary_coverage:1,critical_source_retention:1,source_mutations:0}};
}

export function jointConfig(input){
  strictObject(input,['providers','vector_store']);strictObject(input.providers,['organizer','embedder']);
  const fixture=jointFixture();
  for(const kind of ['organizer','embedder']){
    const p=validateProfile(input.providers[kind],{kind});
    if(!p.enabled || p.protocol==='mock')fail('REAL_PROVIDER_REQUIRED');
    if(p.retry.max_attempts!==1 || p.retry.repair_once || p.limits.daily_requests<fixture.call_limits[kind] ||
      p.limits.batch_size<fixture.documents.length || !p.egress.sensitivities.includes('public'))fail('JOINT_BUDGET_OR_POLICY_INVALID');
    if(kind==='embedder' && (!p.egress.query_approved || !p.egress.sensitivities.includes('sensitive')))fail('QUERY_EGRESS_NOT_APPROVED');
  }
  return {...input,vector_store:vectorAcceptanceTarget(input.vector_store)};
}
const write=(run,name,value)=>writeFileSync(path.join(run,name),JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
const runtime={config_version:'mnemuron-memory-first-v1',deployment_mode:'test',development:{synthetic_data:true},modules:{memory:{enabled:true},handoff:{enabled:false,existing_inflight_policy:'drain_before_disable'}},memory:{capture_extraction:{enabled:false}}};
const code=error=>error instanceof ModelError?error.code:error?.code==='ERR_ASSERTION'?'ASSERTION_FAILED':'JOINT_ACCEPTANCE_FAILED';

// Model and vector transports can be replaced only for offline contract tests; their evidence is labelled simulated.
export async function evaluateJoint(options={}){
  if(options.allowNetwork!==true)fail('NETWORK_NOT_ALLOWED');
  const {output,modelTransport=requestJSON,vectorTransport=requestJSON,onProgress=()=>{}}=options,config=jointConfig(options.config);
  storageDoctor({evidence_dir:output});const destination=realDestination(output),info=statSync(destination);
  if(!info.isDirectory() || info.mode & 0o077)fail('PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');
  const fixture=jointFixture(),run=mkdtempSync(path.join(destination,'synthetic-joint-')),prefix='joint_'+randomUUID().replaceAll('-','').slice(0,16);
  const calls={organizer:0,embedder:0},durations={organizer:[],embedder:[]},rankings={},memories=new Map(),byId=new Map();
  const qualification=modelTransport===requestJSON && vectorTransport===requestJSON?'live_model_and_qdrant':'protocol_simulated';
  const expected=['backend_health','classification','grounded_summary','summary_idempotence','vector_backfill','vector_payload_privacy','vector_idempotence',
    'sqlite_reopen','retrieval_and_detail','source_body_unchanged','retraction_sql_summary_vector','vector_reconciliation','read_did_not_run_organizer','no_handoff_state'];
  const result={fixture_version:fixture.version,fixture_digest:digest(fixture),qualification,synthetic_only:true,production_ready:false,configured_database_opened:false,
    service_started:false,human_review:'not_run',scope:'Small joint acceptance, not the full quality corpus or production acceptance.',cases:[],call_limits:fixture.call_limits};
  write(run,'preflight.json',{...result,fixture,expected_cases:expected,thresholds_frozen:true,collection_prefix:prefix,started_at:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch}});
  const remote=kind=>async(p,route,body)=>{
    if(calls[kind]>=fixture.call_limits[kind])fail('BUDGET_EXHAUSTED');
    if(kind==='organizer'){
      const sources=JSON.parse(body.messages[1].content).input.sources;
      if(sources.some(s=>!fixture.documents.some(d=>d.content===s.content && memories.get(d.id)?.memory_id===s.memory_id)))fail('SYNTHETIC_EGRESS_VIOLATION');
    }else{
      const allowed=[...fixture.documents,...fixture.guards.filter(d=>d.kind!=='secret')].map(d=>p.document_prefix+d.content)
        .concat([...fixture.queries.map(q=>q.query),fixture.retraction_query].map(q=>p.query_prefix+q));
      if(body.input.some(text=>!allowed.includes(text)))fail('SYNTHETIC_EGRESS_VIOLATION');
    }
    calls[kind]++;const ordinal=calls[kind],started=Date.now();
    // Append before sending. Failed and interrupted requests consume the frozen run budget too.
    write(run,`call-${kind}-${ordinal}.json`,{reserved_at:new Date().toISOString(),kind,ordinal,profile:p.fingerprint});
    onProgress({phase:'model-request',component:kind,ordinal,limit:fixture.call_limits[kind]});
    try{return await modelTransport(p,route,body);}finally{durations[kind].push(Date.now()-started);}
  };
  const check=async(name,fn)=>{const started=Date.now();try{const detail=await fn();result.cases.push({name,status:'passed',duration_ms:Date.now()-started,...(detail?{detail}:{})});}
    catch(error){result.cases.push({name,status:'failed',error_code:code(error)});}onProgress(result.cases.at(-1));};
  let s=new MnemuronStore(run+'/synthetic.sqlite3',{memoryConfig:runtime});
  const authFor=userId=>s.authenticate(s.issueCredential({userId,label:'Synthetic joint fixture',deviceId:'synthetic-device',agentId:'synthetic',agentInstanceId:'synthetic-joint',scopes:['memory:read','memory:write','memory:retention']}).api_key);
  const auth=authFor('synthetic-joint-owner'),other=authFor('synthetic-joint-other'),bindings={project_id:'synthetic-project-a',session_id:'synthetic-session-a'};
  const save=(d,owner=auth,extras={})=>{const memory=s.saveMemory(owner,{scope:'user',content:d.content,...extras}).memory;
    memories.set(d.id,memory);byId.set(memory.memory_id,d.id);s.memorySources.setSensitivity(owner,memory.memory_id,d.kind==='secret'?'secret':'public');return memory;};
  const organizer=new Organizer(config.providers.organizer,{transport:remote('organizer')}),embedder=new Embedder(config.providers.embedder,{transport:remote('embedder')});
  const backend=new QdrantStore(config.vector_store,{transport:vectorTransport});
  let index=new VectorIndex(s,backend,new Map([[embedder.profile.fingerprint,embedder]]),{prefix}),generation,summaryBefore=[],baseline=[];
  const scroll=async()=>{let offset=null,points=[];do{const page=await backend.scroll(index.snapshot().collection_name,offset);points.push(...page.points);offset=page.next_page_offset ?? null;}while(offset!==null);return points;};
  try{
    await check('backend_health',async()=>{const health=await backend.health();assert.equal(health.state,'ready');return health;});
    fixture.documents.forEach(d=>save(d));baseline=s.db.prepare('SELECT memory_id,content,status FROM memories ORDER BY memory_id').all();
    const jobs=new MemoryJobs(s,{batchSize:8,leaseMs:300000}),worker=new MemoryWorker(s,jobs,organizer,{userId:auth.user_id});
    const schedule=type=>scheduleLibrary(s,jobs,{userId:auth.user_id,organizer,taxonomy:fixture.taxonomy,type,periods:['daily'],includeOpen:true});
    await check('classification',async()=>{
      assert.equal(schedule('classification').jobs.length,1);const drained=await worker.drain({maxJobs:1});assert.equal(drained[0]?.state,'succeeded');
      const categories=fixture.documents.map(d=>({id:d.id,expected:d.category,actual:s.derivedMemory.category(s.derivedMemory.currentSource(auth.user_id,memories.get(d.id).memory_id),fixture.taxonomy.version)}));
      result.classification=categories;assert.ok(categories.every(d=>d.expected===d.actual));return {correct:categories.length,total:categories.length};
    });
    await check('grounded_summary',async()=>{
      assert.equal(schedule('summary').jobs.length,1);assert.equal((await worker.drain({maxJobs:1}))[0]?.state,'succeeded');
      summaryBefore=s.memorySummaries(auth,{scope:'user'}).results;
      const claims=summaryBefore.flatMap(view=>view.claims),metrics=summaryMetrics(fixture.documents,claims,byId);result.summary=metrics;
      write(run,'summary-review.json',{sources:fixture.documents,claims:claims.map(c=>({...c,fixture_id:byId.get(c.memory_id)})),metrics,human_review:'not_run'});
      assert.equal(metrics.leaf_coverage,1);assert.equal(metrics.critical_source_retention,1);assert.equal(metrics.unsupported_claims,0);
      assert.equal(metrics.automatic_fact_verifications,0);assert.equal(metrics.scope_leaks,0);
      assert.ok(summaryBefore.every(v=>v.coverage_status==='complete'));return metrics;
    });
    await check('summary_idempotence',async()=>{const before=calls.organizer;schedule('summary');assert.equal((await worker.drain({maxJobs:1})).length,0);assert.equal(calls.organizer,before);});
    s.ensureProject(auth,bindings.project_id,'Synthetic A');s.ensureProject(auth,'synthetic-project-b','Synthetic B');
    for(const d of fixture.guards){
      const extras=d.kind==='session'?{scope:'session',project_id:bindings.project_id,session_id:'synthetic-session-b'}:d.kind==='project'?{scope:'project',project_id:'synthetic-project-b'}:{};
      save(d,d.kind==='owner'?other:auth,extras);
    }
    await check('vector_backfill',async()=>{
      generation=index.begin(embedder.profile.fingerprint);const synced=await index.sync(generation);assert.equal(synced.complete,true);index.activate(generation);
      assert.equal(calls.embedder,8);assert.equal((await scroll()).length,8);result.vector_profile={fingerprint:embedder.profile.fingerprint,dimensions:embedder.profile.dimensions,collection:index.snapshot().collection_name};
      return {embedded_sources:8,secret_sources_excluded:1,dimensions:embedder.profile.dimensions};
    });
    await check('vector_payload_privacy',async()=>{for(const point of await scroll()){
      assert.deepEqual(Object.keys(point.payload).sort(),['content_hash','document','lifecycle','owner','profile','revision','scope']);
      assert.doesNotMatch(JSON.stringify(point.payload),/Synthetic|合成|synthetic-joint-owner|FORBIDDEN/);assert.equal(Object.hasOwn(point,'vector'),false);
    }});
    await check('vector_idempotence',async()=>{const before=calls.embedder;assert.equal((await index.sync(generation)).processed,0);assert.equal(calls.embedder,before);assert.equal((await scroll()).length,8);});
    await check('sqlite_reopen',async()=>{const before=index.snapshot();s.close();s=new MnemuronStore(run+'/synthetic.sqlite3',{memoryConfig:runtime});
      index=new VectorIndex(s,backend,new Map([[embedder.profile.fingerprint,embedder]]),{prefix});assert.deepEqual(index.snapshot(),before);});
    const organizerBeforeRead=calls.organizer;
    await check('retrieval_and_detail',async()=>{
      for(const q of fixture.queries){
        const response=await index.search(auth,{query:q.query,mode:q.mode,...bindings,limit:20});assert.equal(response.retrieval.degraded,false);
        const ids=response.results.map(m=>byId.get(m.memory_id));rankings[q.id]=ids;
        assert.ok(ids.every(id=>fixture.documents.some(d=>d.id===id)));assert.equal(new Set(ids).size,ids.length);
        for(const memory of response.results){const original=fixture.documents.find(d=>d.id===byId.get(memory.memory_id));assert.equal(s.memoryDetail(auth,memory.memory_id).memory.content,original.content);}
      }
      result.retrieval=rankMetrics(fixture.queries,rankings,fixture.guards.map(d=>d.id));
      assert.equal(result.retrieval.top1,1);assert.equal(result.retrieval.scope_leaks,0);return result.retrieval;
    });
    await check('source_body_unchanged',async()=>{for(const row of baseline){const now=s.db.prepare('SELECT content,status FROM memories WHERE memory_id=?').get(row.memory_id);assert.equal(now.content,row.content);assert.equal(now.status,row.status);}});
    await check('retraction_sql_summary_vector',async()=>{
      const target=memories.get('release').memory_id,opaque=surrogate([auth.user_id,target]);
      assert.ok(summaryBefore.some(v=>v.claims.some(c=>c.memory_id===target)));assert.ok((await scroll()).some(p=>p.payload.document===opaque));
      s.retractMemory(auth,target);
      assert.ok((await scroll()).some(p=>p.payload.document===opaque),'stale vector must still exist to exercise SQL filtering');
      assert.ok(s.memorySummaries(auth,{scope:'user'}).results.every(v=>v.claims.every(c=>c.memory_id!==target)));
      assert.equal(s.queryMemories(auth,{query:'17.9.8',...bindings}).results.some(m=>m.memory_id===target),false);
      assert.throws(()=>s.memoryDetail(auth,target));
      const response=await index.search(auth,{query:fixture.retraction_query,mode:'semantic',...bindings,limit:20});
      assert.equal(response.retrieval.degraded,false);assert.ok(response.results.every(m=>m.memory_id!==target && fixture.documents.some(d=>d.id===byId.get(m.memory_id))));
      return {stale_vector_present_at_query:true,retracted_results:0};
    });
    await check('vector_reconciliation',async()=>{assert.equal((await index.reconcile(generation)).removed,1);assert.equal((await index.reconcile(generation)).removed,0);assert.equal((await scroll()).length,7);});
    await check('read_did_not_run_organizer',async()=>{assert.equal(calls.organizer,organizerBeforeRead);assert.equal(calls.organizer,2);assert.equal(calls.embedder,12);});
    await check('no_handoff_state',async()=>{for(const table of ['tasks','resumes','resume_delivery_receipts'])assert.equal(s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);});
  }catch(error){result.error_code=code(error);}finally{s.close();}
  result.calls=calls;result.request_durations_ms=durations;result.finished_at=new Date().toISOString();
  result.status=!result.error_code && result.cases.length===expected.length && result.cases.every(c=>c.status==='passed')?'passed':'failed';
  write(run,'results.json',result);return {run,...result};
}

import {mkdtempSync,writeFileSync,statSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {MnemuronStore} from '../store.mjs';
import {MemoryJobs} from '../memory-jobs/store.mjs';
import {MemoryWorker,scheduleLibrary} from '../memory-jobs/worker.mjs';
import {Organizer,Embedder} from '../model-providers/providers.mjs';
import {requestJSON} from '../model-providers/transport.mjs';
import {digest,fail,ModelError} from '../model-providers/contracts.mjs';
import {storageDoctor,realDestination} from '../storage-policy.mjs';
import {qualityFixture,qualityFixtureV2,qualityFixtureV3} from './fixture.mjs';
import {evaluateQualityProjection} from './quality-projection.mjs';
import {vectorAcceptanceTarget} from './vector.mjs';

const write=(run,name,value)=>writeFileSync(path.join(run,name),JSON.stringify(value,null,2),{flag:'wx',mode:0o600});
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:0;
export function rankMetrics(queries,rankings,forbidden=[]) {
  const rows=queries.map(query=>{
    const ids=rankings[query.id] || [],rank=ids.findIndex(id=>query.expected.includes(id));
    return {id:query.id,kind:query.kind,expected:query.expected,top_ids:ids.slice(0,5),top1:query.expected.includes(ids[0])?1:0,
      reciprocal_rank:rank<0?0:1/(rank+1),recall_at_5:query.expected.filter(id=>ids.slice(0,5).includes(id)).length/query.expected.length,
      forbidden_hits:ids.filter(id=>forbidden.includes(id)).length};
  });
  return {count:rows.length,top1:mean(rows.map(r=>r.top1)),mrr:mean(rows.map(r=>r.reciprocal_rank)),recall_at_5:mean(rows.map(r=>r.recall_at_5)),
    scope_leaks:rows.reduce((n,r)=>n+r.forbidden_hits,0),rows};
}
export function summaryMetrics(documents,claims,byMemoryId) {
  const byId=new Map(documents.map(d=>[d.id,d]));
  const sourceUnits=documents.reduce((total,d)=>total+d.content.length,0),selectedUnits=claims.reduce((total,c)=>total+c.quote.length,0);
  const critical=documents.map(d=>{
    const selected=claims.filter(c=>byMemoryId.get(c.memory_id)===d.id),text=selected.map(c=>c.quote).join('\n');
    return {id:d.id,present:selected.length>0,critical_preserved:(d.critical || [d.content]).every(fragment=>text.includes(fragment)),
      selected_to_source_ratio:d.content.length?selected.reduce((n,c)=>n+c.quote.length,0)/d.content.length:0,source_utf16_units:d.content.length};
  });
  return {scope_leaks:claims.filter(c=>!byId.has(byMemoryId.get(c.memory_id))).length,
    unsupported_claims:claims.filter(c=>{const d=byId.get(byMemoryId.get(c.memory_id));return !d || c.revision!==1 || d.content.slice(c.start,c.end)!==c.quote;}).length,
    automatic_fact_verifications:claims.filter(c=>c.independently_fact_checked!==false).length,
    critical_source_retention:mean(critical.map(c=>Number(c.critical_preserved))),leaf_coverage:mean(critical.map(c=>Number(c.present))),
    source_utf16_units:sourceUnits,selected_utf16_units:selectedUnits,selected_to_source_ratio:sourceUnits?selectedUnits/sourceUnits:0,
    full_source_quotes:claims.filter(c=>byId.get(byMemoryId.get(c.memory_id))?.content===c.quote).length,abstractive_summary:false,cases:critical};
}
const profileEvidence=p=>({enabled:p?.enabled===true,protocol:p?.protocol || null,fingerprint:p?.fingerprint || null,dimensions:p?.dimensions || null});
const safeCode=error=>error instanceof ModelError?error.code:'EVALUATION_FAILED';

// Always create a new synthetic database. Configured storage, services and live owners are never opened.
export async function evaluateQuality({output,config=null,allowNetwork=false,transport=requestJSON,edition='v1',vectorConfig=null,vectorTransport=requestJSON,onProgress=()=>{}}={}) {
  if(!['v1','v2','v3'].includes(edition) || vectorConfig && (edition==='v1' || !allowNetwork))fail('INVALID_QUALITY_MODE');
  if(vectorConfig){
    vectorConfig=vectorAcceptanceTarget(vectorConfig);
    if(!config?.providers?.embedder?.enabled || !config.providers.embedder.egress.query_approved || !config.providers.embedder.egress.sensitivities.includes('sensitive'))fail('QUERY_EGRESS_NOT_APPROVED');
    storageDoctor({vector_secret_file:vectorConfig.auth.secret_file});
  }
  storageDoctor({evidence_dir:output});
  const destination=realDestination(output);
  if(!statSync(destination).isDirectory() || (statSync(destination).mode & 0o077))fail('PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');
  const fixture=edition==='v3'?qualityFixtureV3():edition==='v2'?qualityFixtureV2():qualityFixture(),calls={organizer:0,embedder:0},durations={organizer:[],embedder:[]};
  const classificationIds=fixture.classification_ids || fixture.summary_ids;
  const countBatch=(total,size)=>Math.ceil(total/size);
  const organizerEnabled=config?.providers?.organizer?.enabled===true,embedderEnabled=config?.providers?.embedder?.enabled===true;
  const limits={organizer:organizerEnabled?countBatch(fixture.summary_ids.length,config.providers.organizer.limits.batch_size)+countBatch(classificationIds.length,config.providers.organizer.limits.batch_size):0,
    embedder:embedderEnabled?countBatch(fixture.documents.length,config.providers.embedder.limits.batch_size)+countBatch(fixture.queries.length,config.providers.embedder.limits.batch_size)+(vectorConfig?fixture.documents.length+2+fixture.queries.length:0):0};
  const run=mkdtempSync(path.join(destination,'synthetic-quality-'));chmodSync(run,0o700);
  write(run,'preflight.json',{started_at:new Date().toISOString(),fixture,fixture_digest:digest(fixture),allow_network:allowNetwork,call_limits:limits,
    providers:{organizer:profileEvidence(config?.providers?.organizer),embedder:profileEvidence(config?.providers?.embedder)},
    thresholds_frozen:true,environment:{node:process.version,platform:process.platform,arch:process.arch},configured_database_opened:false,qdrant_started:false,vector_projection_requested:!!vectorConfig,
    reference_retrieval:'Exact SQLite FTS; model embeddings ranked in local memory, not Qdrant or full semantic service.'});
  const remote=kind=>async(profile,route,body)=>{
    if(!allowNetwork)fail('EGRESS_DENIED');
    if(calls[kind]>=limits[kind])fail('BUDGET_EXHAUSTED');
    if(kind==='organizer'){
      const {input}=JSON.parse(body.messages[1].content);
      if(input.sources.some(source=>!fixture.documents.some(d=>d.content===source.content && memories.get(d.id)?.memory_id===source.memory_id)))fail('SCOPE_LEAK');
    }else{
      const allowed=fixture.documents.map(d=>profile.document_prefix+d.content).concat(fixture.queries.map(q=>profile.query_prefix+q.query));
      if(vectorConfig)allowed.push(profile.document_prefix+'FORBIDDEN_SYNTHETIC_DATA '+fixture.documents[0].content);
      if(body.input.some(text=>!allowed.includes(text)))fail('SCOPE_LEAK');
    }
    calls[kind]++;
    write(run,`call-${kind}-${calls[kind]}.json`,{reserved_at:new Date().toISOString(),kind,ordinal:calls[kind],profile:profile.fingerprint});
    onProgress({phase:'model-request',component:kind,ordinal:calls[kind],limit:limits[kind]});
    const start=performance.now();try{return await transport(profile,route,body);}finally{durations[kind].push(performance.now()-start);}
  };
  const s=new MnemuronStore(run+'/synthetic.sqlite3',{memoryConfig:{config_version:'mnemuron-memory-first-v1',modules:{memory:{enabled:true},handoff:{enabled:false,existing_inflight_policy:'drain_before_disable'}},memory:{capture_extraction:{enabled:false}}}});
  const authFor=userId=>s.authenticate(s.issueCredential({userId,label:'Synthetic quality fixture',deviceId:'synthetic-device',agentId:'synthetic',agentInstanceId:'synthetic-quality',scopes:['memory:read','memory:write','memory:retention']}).api_key);
  const auth=authFor('synthetic-quality-owner'),memories=new Map(),byMemoryId=new Map(),summaryDocs=fixture.documents.filter(d=>fixture.summary_ids.includes(d.id));
  const save=d=>{const m=s.saveMemory(auth,{content:d.content,scope:'user'}).memory;memories.set(d.id,m);byMemoryId.set(m.memory_id,d.id);s.memorySources.setSensitivity(auth,m.memory_id,'public');return m;};
  const result={fixture_version:fixture.version,fixture_digest:digest(fixture),synthetic_only:true,production_ready:false,configured_database_opened:false,
    qdrant:'not_run',human_review:'not_run',vector_values_saved:false,qualification:transport===requestJSON && vectorTransport===requestJSON?'live_providers':'protocol_simulated',components:{},hard_gates:{},quality_gates:{}};
  try {
    summaryDocs.forEach(save);
    const baseline=s.db.prepare('SELECT memory_id,content,status FROM memories ORDER BY memory_id').all();
    const foreign=s.saveMemory(authFor('synthetic-quality-other-owner'),{content:'FORBIDDEN_SYNTHETIC_DATA '+fixture.documents[0].content,scope:'user'}).memory;
    byMemoryId.set(foreign.memory_id,'foreign-owner');
    if(!allowNetwork || !organizerEnabled)result.components.organizer={status:'not_run',reason:allowNetwork?'NOT_CONFIGURED':'NETWORK_NOT_ALLOWED'};
    else {
      try {
        if(config.providers.organizer.protocol==='mock')fail('REAL_PROVIDER_REQUIRED');
        const model=new Organizer(config.providers.organizer,{transport:remote('organizer')}),jobs=new MemoryJobs(s,{batchSize:128,leaseMs:300000}),worker=new MemoryWorker(s,jobs,model,{userId:auth.user_id});
        const schedule=type=>scheduleLibrary(s,jobs,{userId:auth.user_id,organizer:model,taxonomy:fixture.taxonomy,type,periods:['daily'],includeOpen:true});
        // Summarize first: one uncategorized window, unaffected by classification quality.
        schedule('summary');const summaryJobs=await worker.drain({maxJobs:1});
        const summaries=s.memorySummaries(auth,{scope:'user'}).results,claims=summaries.flatMap(row=>row.claims);
        write(run,'summary-review.json',{sources:summaryDocs,claims:claims.map(c=>({...c,fixture_id:byMemoryId.get(c.memory_id)})),human_review:'not_run'});
        const summary=summaryMetrics(summaryDocs,claims,byMemoryId);
        const repeatedSummary=schedule('summary'),repeatJobs=await worker.drain({maxJobs:1});
        fixture.documents.filter(d=>classificationIds.includes(d.id) && !memories.has(d.id)).forEach(save);
        schedule('classification');const classificationJobs=await worker.drain({maxJobs:1});
        const categories=fixture.documents.filter(d=>classificationIds.includes(d.id)).map(d=>({id:d.id,expected:d.category,actual:s.derivedMemory.category(s.derivedMemory.currentSource(auth.user_id,memories.get(d.id).memory_id),fixture.taxonomy.version)}));
        const classificationAccuracy=mean(categories.map(c=>Number(c.expected===c.actual)));
        const beforeRepeat=s.db.prepare('SELECT COUNT(*) AS n FROM memory_jobs').get().n;schedule('classification');
        const newJobs=s.db.prepare('SELECT COUNT(*) AS n FROM memory_jobs').get().n-beforeRepeat;
        const jobStates=s.db.prepare('SELECT job_type,state,last_error_code,total,processed FROM memory_jobs').all();
        result.components.organizer={status:jobStates.every(j=>j.state==='succeeded')?'passed':'failed',summary,
          summary_views:summaries.map(view=>({coverage_status:view.coverage_status,selected_source_count:view.selected_source_count,omitted_source_count:view.omitted_source_count})),
          classification_accuracy:classificationAccuracy,categories,job_states:jobStates};
        Object.assign(result.hard_gates,{unsupported_claims:summary.unsupported_claims===0,summary_scope_isolation:summary.scope_leaks===0,
          automatic_fact_verifications:summary.automatic_fact_verifications===0,idempotent_scheduling:newJobs===0 && repeatJobs.length===0 && repeatedSummary.jobs.length===summaryJobs.length,
          job_completion:summaryJobs.length===1 && classificationJobs.length===1 && jobStates.every(j=>j.state==='succeeded')});
        Object.assign(result.quality_gates,{critical_source_retention:summary.critical_source_retention>=fixture.thresholds.critical_source_retention,
          leaf_coverage:summary.leaf_coverage>=fixture.thresholds.leaf_coverage,classification_accuracy:classificationAccuracy>=fixture.thresholds.classification_accuracy});
        if(edition!=='v1')Object.assign(result.quality_gates,{
          long_source_compression:summary.cases.filter(c=>c.source_utf16_units>1024).every(c=>c.present && c.critical_preserved && c.selected_to_source_ratio<=fixture.thresholds.long_selected_to_source_ratio),
          quoted_instructions_not_preferences:categories.filter(c=>['quoted-command','quoted-preference'].includes(c.id)).every(c=>c.actual===c.expected)});
      }catch(error){result.components.organizer={status:'failed',error_code:safeCode(error)};result.hard_gates.organizer_completed=false;}
    }
    result.hard_gates.atomic_body_unchanged=baseline.every(row=>{const now=s.db.prepare('SELECT content,status FROM memories WHERE memory_id=?').get(row.memory_id);return now.content===row.content && now.status===row.status;});
    fixture.documents.filter(d=>!memories.has(d.id)).forEach(save);
    const session=s.saveMemory(auth,{content:'FORBIDDEN_SYNTHETIC_DATA '+fixture.documents[0].content,scope:'session',session_id:'synthetic-other-session'}).memory;
    byMemoryId.set(session.memory_id,'foreign-session');
    const rankings=Object.fromEntries(fixture.queries.map(q=>[q.id,s.queryMemories(auth,{query:q.query,limit:10,session_id:'synthetic-evaluation-session'}).results.map(m=>byMemoryId.get(m.memory_id))]));
    const lexical=rankMetrics(fixture.queries.filter(q=>q.kind==='exact'),rankings,fixture.forbidden_ids);
    result.components.lexical={status:lexical.scope_leaks===0 && lexical.top1>=fixture.thresholds.exact_top1?'passed':'failed',...lexical};
    result.hard_gates.lexical_scope_isolation=rankMetrics(fixture.queries,rankings,fixture.forbidden_ids).scope_leaks===0;
    result.hard_gates.exact_identifiers=lexical.top1>=fixture.thresholds.exact_top1;
    if(!allowNetwork || !embedderEnabled)result.components.embedder={status:'not_run',reason:allowNetwork?'NOT_CONFIGURED':'NETWORK_NOT_ALLOWED'};
    else {
      try {
        if(config.providers.embedder.protocol==='mock')fail('REAL_PROVIDER_REQUIRED');
        const embedder=new Embedder(config.providers.embedder,{transport:remote('embedder')}),batch=embedder.profile.limits.batch_size;
        const embed=async(texts,type)=>{const vectors=[];for(let start=0;start<texts.length;start+=batch)vectors.push(...(await embedder.embed(texts.slice(start,start+batch),type,{sensitivity:'public'})).vectors);return vectors;};
        const documents=await embed(fixture.documents.map(d=>d.content),'document'),queries=await embed(fixture.queries.map(q=>q.query),'query');
        const cosine=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0)/(Math.hypot(...a)*Math.hypot(...b));
        const ranks=Object.fromEntries(fixture.queries.map((q,n)=>[q.id,documents.map((v,i)=>({id:fixture.documents[i].id,score:cosine(queries[n],v)})).sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id)).map(r=>r.id)]));
        const semantic=rankMetrics(fixture.queries.filter(q=>q.kind==='semantic'),ranks),exact=rankMetrics(fixture.queries.filter(q=>q.kind==='exact'),ranks);
        result.components.embedder={status:'passed',dimensions:embedder.profile.dimensions,reference_only:true,semantic,exact,profile:embedder.profile.fingerprint};
        Object.assign(result.quality_gates,{semantic_top1:semantic.top1>=fixture.thresholds.semantic_top1,semantic_recall_at_5:semantic.recall_at_5>=fixture.thresholds.semantic_recall_at_5,semantic_mrr:semantic.mrr>=fixture.thresholds.semantic_mrr});
      }catch(error){result.components.embedder={status:'failed',error_code:safeCode(error)};result.hard_gates.embedder_completed=false;}
    }
    if(vectorConfig && embedderEnabled){
      const projection=await evaluateQualityProjection({store:s,auth,byMemoryId,fixture,config:vectorConfig,embedder:new Embedder(config.providers.embedder,{transport:remote('embedder')}),vectorTransport,onProgress});
      result.components.projection=projection;result.qdrant=projection.status;result.vector_values_saved='temporary_projection_deleted_if_cleanup_passed';
      result.hard_gates.projection_correctness=projection.hard_correctness==='passed';result.quality_gates.projection_quality=projection.quality==='passed';
      write(run,'projection.json',projection);
    }
    const detail=fixture.documents.every(d=>s.memoryDetail(auth,memories.get(d.id).memory_id).memory.content===d.content);
    const target=memories.get('release'),visibleBefore=s.memorySummaries(auth,{scope:'user'}).results.filter(summary=>summary.claims.some(c=>c.memory_id===target.memory_id));
    s.retractMemory(auth,target.memory_id);
    result.hard_gates.atomic_detail_complete=detail;
    result.hard_gates.atomic_retraction_hidden=!s.queryMemories(auth,{query:fixture.documents[0].content,session_id:'synthetic-evaluation-session'}).results.some(m=>m.memory_id===target.memory_id);
    // Classification can invalidate the earlier uncategorized view; absence alone is not a retraction proof.
    result.summary_retraction=visibleBefore.length?s.memorySummaries(auth,{scope:'user'}).results.every(summary=>!summary.claims.some(c=>c.memory_id===target.memory_id))?'passed':'failed':'not_run_no_current_target_summary';
    if(visibleBefore.length)result.hard_gates.summary_retraction_hidden=result.summary_retraction==='passed';
    result.hard_gates.no_handoff_state=['tasks','resumes','resume_delivery_receipts'].every(table=>s.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n===0);
  }catch(error){result.error_code=safeCode(error);result.hard_gates.evaluation_completed=false;}
  finally{s.close();}
  result.calls=calls;result.request_durations_ms=durations;result.finished_at=new Date().toISOString();
  result.hard_correctness=Object.values(result.hard_gates).every(Boolean)?'passed':'failed';
  result.model_quality=!allowNetwork || !organizerEnabled || !embedderEnabled?'not_run':Object.values(result.quality_gates).every(Boolean) && result.components.organizer?.status==='passed' && result.components.embedder?.status==='passed'?'passed':'failed';
  result.status=result.hard_correctness==='failed' || result.model_quality==='failed'?'failed':result.model_quality==='not_run'?'partial':'passed';
  write(run,'results.json',result);return {run,...result};
}

import {object,number} from './state.mjs';

// Read evidence, not a new processing state machine. All projections are pinned to the current owned revision;
// absence of a local checkpoint is not proof that a remote model/vector service is healthy or unhealthy.
export function indexedDocument(store,user,generation,source){
  if(!generation||!source)return null;
  const row=store.db.prepare('SELECT * FROM memory_vector_documents WHERE generation=? AND user_id=? AND memory_id=?').get(generation,user,source.memory_id);
  return row?.state==='indexed'&&row.revision===source.revision&&row.state_hash===source.state_hash&&row.scope_key===source.scope_key?row:null;
}

export function summaryEvidence(store,user,memoryId,source){
  const rows=store.db.prepare(`SELECT s.summary_id,s.revision,s.status,s.created_at,d.revision source_revision,d.state_hash,
    (SELECT COUNT(*) FROM memory_summary_claims c WHERE c.summary_id=s.summary_id AND json_extract(c.claim_json,'$.memory_id')=d.memory_id) claims
    FROM memory_summary_dependencies d JOIN memory_summaries s ON s.summary_id=d.summary_id AND s.user_id=d.user_id
    WHERE d.user_id=? AND d.memory_id=? ORDER BY s.created_at DESC,s.rowid DESC LIMIT 21`).all(user,memoryId);
  const items=rows.slice(0,20).map(row=>{
    // A retained 'current' status can outlive a captured event. Revalidate the whole dependency set as the reader does.
    const dependencies=row.status==='current'&&source&&row.source_revision===source.revision&&row.state_hash===source.state_hash
      ?store.db.prepare('SELECT * FROM memory_summary_dependencies WHERE summary_id=? AND user_id=?').all(row.summary_id,user):[];
    const current=dependencies.length>0&&dependencies.every(item=>store.derivedMemory.validateItem(item));
    return {summary_id:row.summary_id,revision:row.revision,source_revision:row.source_revision,created_at:row.created_at,
      status:current?(row.claims?'covered':'omitted'):'stale',claims:current?row.claims:0};
  });
  return {status:items.some(i=>i.status==='covered')?'covered':items.some(i=>i.status==='omitted')?'omitted':items.length?'stale':'missing',
    items,truncated:rows.length>20,limit:20};
}

export function processingEvidence(service,auth,p){
  object(p,['memory_id','revision']);const {store,db}=service,user=auth.user_id;
  const revision=p.revision===undefined?undefined:number(Number(p.revision),1,2147483647);
  const {row,current}=service.memory(auth,p.memory_id,revision),source=store.derivedMemory.currentSource(user,row.memory_id);
  const traits=store.traits.get(user,row.memory_id),missing=[...(!traits.kind?['kind']:[]),...(traits.strength==null?['strength']:[])];
  const sources=db.prepare('SELECT COUNT(*) n FROM memory_source_links WHERE user_id=? AND memory_id=? AND revision=?').get(user,row.memory_id,current.revision).n;
  const hasVectors=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_vector_documents'").get();
  const active=hasVectors?db.prepare('SELECT generation,profile FROM memory_vector_owner_active WHERE user_id=?').get(user):null;
  const document=active?db.prepare('SELECT revision,state,state_hash,scope_key FROM memory_vector_documents WHERE generation=? AND user_id=? AND memory_id=?').get(active.generation,user,row.memory_id):null;
  const indexed=active&&indexedDocument(store,user,active.generation,source);
  const currentDocument=source&&document?.revision===source.revision&&document.state_hash===source.state_hash&&document.scope_key===source.scope_key;
  const chunks=active&&currentDocument?db.prepare('SELECT COUNT(*) n FROM memory_vector_points WHERE generation=? AND user_id=? AND memory_id=? AND revision=?').get(active.generation,user,row.memory_id,current.revision).n:0;
  const configured=service.models.raw(user,'embedder');let configuredProfile=null;
  if(configured){const config=JSON.parse(configured.config_json);if(config.enabled)configuredProfile=service.models.profile(user,'embedder',config).fingerprint;}
  const summary=summaryEvidence(store,user,row.memory_id,source);
  const jobs=db.prepare(`SELECT j.job_id,j.job_type,j.state,j.last_error_code,j.attempt_count,j.updated_at,
    i.revision,i.state item_state,CASE WHEN i.state='partial' THEN i.result_json END checkpoint_json
    FROM memory_job_items i JOIN memory_jobs j ON j.job_id=i.job_id AND j.user_id=i.user_id
    WHERE i.user_id=? AND i.memory_id=? ORDER BY j.created_at DESC,j.rowid DESC LIMIT 21`).all(user,row.memory_id).map(({checkpoint_json,...job})=>{
      let value;try{value=JSON.parse(checkpoint_json);}catch{}
      if(value?.schema==='summary-segments-v1'&&Array.isArray(value.segments)&&value.segments.length>=2&&value.segments.length<=64&&Array.isArray(value.completed)&&value.completed.length<=value.segments.length)
        return {...job,segment_processed:value.completed.length,segment_total:value.segments.length,segment_results_published:false};
      return job;
    });
  const runs=service.owner.user===user?db.prepare(`SELECT r.run_id,r.kind,r.state,r.used,r.budget,r.error_code,r.created_at,i.revision
    FROM owner_processing_items i JOIN owner_processing_runs r ON r.run_id=i.run_id
    WHERE r.user_id=? AND i.memory_id=? ORDER BY r.created_at DESC,r.rowid DESC LIMIT 21`).all(user,row.memory_id):[];
  return {schema:'memory-processing-v1',read_only:true,production_content_sent:false,memory_id:row.memory_id,revision:current.revision,
    source:{status:row.status!=='active'?'inactive':source?'available':'unavailable',evidence_kind:current.evidence_kind,linked_sources:sources,
      full_read_request:{memory_id:row.memory_id,revision:current.revision,content_offset:0,content_limit:8192}},
    traits:{status:missing.length?'missing':'complete',missing_fields:missing,concept_count:traits.concepts.length,manual_fields_preserved:true},summary,
    vector:{status:!active?'not_ready':!source?'unavailable':indexed?'indexed':currentDocument&&document.state==='building'?'partial':document?'stale':'missing',
      generation:active?.generation||null,profile:active?.profile||null,configured_profile:configuredProfile,document_revision:document?.revision||null,
      confirmed_chunks:chunks,remote_health:'not_probed',repair_blockers:[...(!active?['VECTOR_NOT_READY']:[]),
        ...(active&&configuredProfile!==active.profile?['VECTOR_PROFILE_MISMATCH']:[])]},
    jobs:{items:jobs.slice(0,20),truncated:jobs.length>20,limit:20},runs:{items:runs.slice(0,20),truncated:runs.length>20,limit:20}};
}

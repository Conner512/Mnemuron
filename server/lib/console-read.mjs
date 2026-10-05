import {ValidationError,NotFoundError,ConflictError} from './errors.mjs';
import {credentialView} from './console/credentials.mjs';
import {FEATURE_VIEWS,featureParams} from './console/features.mjs';
import {auditQuery} from '../../shared/console-queries.mjs';
import {splitLeadingPath} from '../../shared/memory-display.mjs';
export const isConsoleReader=auth=>auth.agent_id==='mnemuron-console';
function pagination(params,maximum=50){
  const offset=Number(params.offset??0),limit=Number(params.limit??25);
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000000||!Number.isSafeInteger(limit)||limit<1||limit>maximum)throw new ValidationError('Invalid pagination.');
  return {offset,limit};
}
// A leading file path is returned separately (display only; content stays the stored text's first 160 chars),
// so the list can show the path on its own line and the body beneath it instead of 160 chars of path.
const displayParts=m=>{const parts=splitLeadingPath(m.content);return parts?{path:[...parts.path].slice(0,512).join(''),body:[...parts.body].slice(0,240).join('')}:{};};
const snippet=m=>({memory_id:m.memory_id,content:[...String(m.content??'')].slice(0,160).join(''),...displayParts(m),memory_type:m.memory_type,status:m.status,created_at:m.created_at,...(m.category?{category:m.category}:{}),
  ...(m.topic?{topic:m.topic}:{}),...(m.imported?{imported:true,original_created_at:m.original_created_at||null}:{})});
const jobView=job=>({job_id:job.job_id,job_type:job.job_type,state:job.state,total:job.total,processed:job.processed,attempt_count:job.attempt_count,last_error_code:job.last_error_code,created_at:job.created_at,updated_at:job.updated_at,result_ref:job.result_ref});
// Owner-scoped aggregates for overview charts. Counts only: no content, IDs or other accounts.
function overviewInsights(store,user){
  const db=store.db,since=new Date(Date.now()-29*86400000).toISOString().slice(0,10);
  const byDay=new Map(db.prepare("SELECT substr(created_at,1,10) day,COUNT(*) n FROM memories WHERE user_id=? AND created_at>=? GROUP BY day").all(user,since).map(r=>[r.day,r.n]));
  const activity=Array.from({length:30},(_,i)=>{const day=new Date(Date.parse(since)+i*86400000).toISOString().slice(0,10);return {day,count:byDay.get(day)||0};});
  const group=column=>db.prepare(`SELECT ${column} value,COUNT(*) count FROM memories WHERE user_id=?${column==='memory_type'?" AND status='active'":''} GROUP BY ${column} ORDER BY count DESC,value LIMIT 12`).all(user);
  const categories=db.prepare(`SELECT COALESCE(o.category,a.category,'uncategorized') value,COUNT(*) count FROM memories m
    LEFT JOIN memory_category_overrides o ON o.user_id=m.user_id AND o.memory_id=m.memory_id AND o.locked=1
    LEFT JOIN memory_annotations a ON a.user_id=m.user_id AND a.memory_id=m.memory_id AND a.taxonomy_version=?
      AND a.revision=(SELECT MAX(revision) FROM memory_revisions WHERE user_id=m.user_id AND memory_id=m.memory_id)
    WHERE m.user_id=? AND m.status='active' GROUP BY value ORDER BY count DESC,value`).all(store.consoleService.taxonomy(user).version,user);
  return {window_days:30,activity,types:group('memory_type'),statuses:group('status'),categories};
}
export async function consoleRead(store,auth,view,params={}) {
  store.requireScope(auth,'console:read');
  if(!isConsoleReader(auth))throw new NotFoundError('Console route not available.');
  const allowed={memories:['offset','limit','query','mode','status','category','topic','origin','part','target','memory_ids','all'],summaries:['offset','limit'],jobs:['offset','limit','job_id'],summary:['summary_id','revision','cursor'],job:['job_id'],'memory-meta':['memory_id'],export:['after','highwater','limit'],operation:['operation_id'],audit:['offset','limit']}[view]||[];
  if(Object.keys(params).some(key=>!(view==='audit'?['offset','limit','action','outcome','from','to']:featureParams[view]||allowed).includes(key)))throw new ValidationError('Unknown console query parameter.');
  if(FEATURE_VIEWS.includes(view))return store.consoleService.features.read(auth,view,params);
  const db=store.db,user=auth.user_id;
  const count=table=>db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(user).n;
  switch(view) {
    case 'capabilities':return store.consoleService.capabilities(auth);
    case 'models':return {models:store.consoleService.models.list(user),processing:store.consoleService.processing(user),...store.consoleService.capabilities(auth)};
    case 'memory-meta':return store.consoleService.meta(auth,params);
    case 'export':return store.consoleService.export(auth,params);
    case 'operation':return store.consoleService.state.inspect(user,params.operation_id);
    case 'job':return {read_only:true,job:jobView(store.consoleService.job(auth,params.job_id))};
    case 'projects':return {projects:db.prepare('SELECT project_id,name FROM projects WHERE user_id=? ORDER BY name LIMIT 200').all(user)};

    case 'overview':return {read_only:true,production_ready:false,counts:{memories:count('memories'),sources:count('memory_sources'),summaries:count('memory_summaries'),jobs:count('memory_jobs')},
      recent:db.prepare('SELECT memory_id,content,memory_type,status,created_at FROM memories WHERE user_id=? ORDER BY created_at DESC,memory_id LIMIT 5').all(user).map(m=>({...m,...displayParts(m),content:[...m.content].slice(0,160).join('')})),
      insights:overviewInsights(store,user)};
    case 'memories': {
      const organizer=store.consoleService.organizer;
      // Sub-reads of the library share its filter: facets for browsing, and the exact organize preview.
      if(params.part==='facets'){if(Object.keys(params).length!==1)throw new ValidationError('Unknown console query parameter.');return {...organizer.facets(auth),recent_batches:organizer.batches(auth,{}).batches};}
      if(params.part==='preview'){const {part,target,category,offset:_o,limit:_l,mode:_m,status:_s,...rest}=params;
        if(_o!==undefined||_l!==undefined||_m!==undefined||_s!==undefined)throw new ValidationError('Unknown console query parameter.');
        return organizer.preview(auth,{category:target,...(category?{filter_category:category}:{}),...rest});}
      if(params.part!==undefined&&params.part!=='list')throw new ValidationError('Invalid library part.');
      if(params.target!==undefined||params.memory_ids!==undefined||params.all!==undefined)throw new ValidationError('Unknown console query parameter.');
      const {offset,limit}=pagination(params);
      if(params.mode!==undefined&&!['lexical','hybrid','semantic'].includes(params.mode))throw new ValidationError('Invalid retrieval mode.');
      const f=organizer.filter(user,params);
      if(f.query&&params.mode&&params.mode!=='lexical'){
        const statuses=f.status?[f.status]:['active','superseded','retracted'];
        const found=await store.searchMemories(auth,{query:f.query,limit:20,mode:params.mode,statuses,personal_model_only:true});
        const {query,...rest}=f,rows=organizer.rows(auth,rest,{ranked:found.results.map(r=>r.memory_id),limit:limit+1,offset}).rows;
        return {read_only:true,results:rows.slice(0,limit).map(snippet),offset,limit,next_offset:rows.length>limit?offset+limit:null,truncated:found.truncated===true,retrieval:{...found.retrieval,window_limited:true,candidate_limit:20}};
      }
      // Filters apply inside the owner-scoped (and, for a search, bounded) candidate set before paging.
      const {rows,truncated}=organizer.rows(auth,f,{limit:limit+1,offset});
      return {read_only:true,results:rows.slice(0,limit).map(snippet),offset,limit,next_offset:rows.length>limit?offset+limit:null,
        ...(f.query?{truncated,retrieval:{mode:'lexical',candidate_limit:500,degraded:false}}:{})};
    }
    case 'summaries':{const {offset,limit}=pagination(params);const rows=db.prepare('SELECT summary_id,category,status,revision,coverage,omitted,created_at FROM memory_summaries WHERE user_id=? ORDER BY created_at DESC,summary_id LIMIT ? OFFSET ?').all(user,limit+1,offset);return {read_only:true,
      categories:db.prepare(`SELECT COALESCE(o.category,a.category,'uncategorized') category,COUNT(*) count FROM memories m
        LEFT JOIN memory_category_overrides o ON o.user_id=m.user_id AND o.memory_id=m.memory_id AND o.locked=1
        LEFT JOIN memory_annotations a ON a.user_id=m.user_id AND a.memory_id=m.memory_id AND a.taxonomy_version=?
          AND a.revision=(SELECT MAX(revision) FROM memory_revisions WHERE user_id=m.user_id AND memory_id=m.memory_id)
        WHERE m.user_id=? AND m.status='active' GROUP BY COALESCE(o.category,a.category,'uncategorized')`).all(store.consoleService.taxonomy(user).version,user),
      summaries:rows.slice(0,limit),offset,limit,next_offset:rows.length>limit?offset+limit:null};}
    case 'summary': {
      const row=db.prepare('SELECT rowid AS row,* FROM memory_summaries WHERE user_id=? AND summary_id=?').get(user,params.summary_id||'');
      if(!row)throw new NotFoundError('Summary not found.');
      if(row.status!=='current'||params.revision!==undefined&&Number(params.revision)!==row.revision)throw new ConflictError('Summary changed; restart reading.','SUMMARY_VERSION_CHANGED');
      const offset=params.cursor?0:db.prepare("SELECT COUNT(*) n FROM memory_summaries WHERE user_id=? AND scope_key=? AND category=? AND status='current' AND rowid>?").get(user,row.scope_key,row.category,row.row).n;
      const result=store.derivedMemory.summaries(user,row.scope_key,{auth,category:row.category,limit:1,offset,cursor:params.cursor,budget:48*1024});
      if(result.results[0]?.summary_id!==row.summary_id)throw new ConflictError('Summary changed; restart reading.','SUMMARY_VERSION_CHANGED');
      const next=result.results[0].content_complete?null:{summary_id:row.summary_id,revision:row.revision,cursor:result.next_cursor};
      return {...result,next_request:next,next_cursor:next?.cursor||null,next_offset:null,complete:!next};
    }
    case 'jobs':{const {offset,limit}=pagination(params);if(params.job_id)return {read_only:true,job:jobView(store.consoleService.job(auth,params.job_id))};
      // stale_taxonomy: the job was planned with a category list the account has since changed.
      const version=store.consoleService.taxonomy(user).version;
      const rows=db.prepare('SELECT job_id,job_type,state,total,processed,attempt_count,last_error_code,created_at,updated_at,json_extract(metadata_json,\'$.taxonomy.version\') taxonomy_version FROM memory_jobs WHERE user_id=? ORDER BY created_at DESC,job_id LIMIT ? OFFSET ?').all(user,limit+1,offset)
        .map(({taxonomy_version,...job})=>({...job,stale_taxonomy:!!taxonomy_version&&taxonomy_version!==version}));
      return {read_only:true,worker_enabled:store.memoryConfig.console?.worker_enabled===true,settings:store.consoleService.settings(user),vector:db.prepare('SELECT generation,state,error_code,updated_at FROM console_vector_requests WHERE user_id=?').get(user)||null,jobs:rows.slice(0,limit),offset,limit,next_offset:rows.length>limit?offset+limit:null,processing:{classification:store.consoleService.processing(user).classification},operations:store.consoleService.capabilities(auth).writable?'available':'blocked_policy'};}
    case 'connections':return {read_only:true,connections:db.prepare('SELECT credential_id,label,device_id,agent_id,agent_instance_id,created_at,last_used_at,revoked_at,expires_at,scopes_json FROM credentials WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user).map(row=>credentialView(row)),operations:store.consoleService.capabilities(auth).writable?'available':'blocked_policy'};
    case 'audit':{let q;try{q=auditQuery(params);}catch{throw new ValidationError('Invalid audit query.');}const {offset,limit}=q;
      const conditions=['user_id=?'],values=[user];
      for(const key of ['action','outcome'])if(q[key]){conditions.push(`${key}=?`);values.push(q[key]);}
      if(q.from){conditions.push('created_at>=?');values.push(new Date(q.from).toISOString());}if(q.to){conditions.push('created_at<=?');values.push(new Date(q.to).toISOString());}
      const rows=db.prepare(`SELECT audit_id,action,target_type,target_id,outcome,created_at FROM audit_events WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,audit_id LIMIT ? OFFSET ?`).all(...values,limit+1,offset);
      return {read_only:true,entries:rows.slice(0,limit),next_offset:rows.length>limit?offset+limit:null};}
    case 'storage':return {read_only:true,counts:{memories:count('memories'),sources:count('memory_sources'),events:count('events'),revisions:count('memory_revisions')},export:'blocked_policy',restore:'blocked_policy'};
    default:throw new NotFoundError('Console view not found.');
  }
}

import {ValidationError,NotFoundError,ConflictError} from './errors.mjs';
export const isConsoleReader=auth=>auth.agent_id==='mnemuron-console';
export function consoleRead(store,auth,view,params={}) {
  store.requireScope(auth,'console:read');
  if(!isConsoleReader(auth))throw new NotFoundError('Console route not available.');
  const allowed={memories:['offset','limit','query','mode','status'],summary:['summary_id','revision','cursor'],job:['job_id'],'memory-meta':['memory_id'],export:['after','highwater','limit'],operation:['operation_id'],audit:['offset','limit']}[view]||[];
  if(Object.keys(params).some(key=>!allowed.includes(key)))throw new ValidationError('Unknown console query parameter.');
  const db=store.db,user=auth.user_id;
  const count=table=>db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(user).n;
  switch(view) {
    case 'capabilities':return store.consoleService.capabilities(auth);
    case 'models':return {models:store.consoleService.models.list(user),...store.consoleService.capabilities(auth)};
    case 'memory-meta':return store.consoleService.meta(auth,params);
    case 'export':return store.consoleService.export(auth,params);
    case 'operation':return store.consoleService.state.inspect(user,params.operation_id);
    case 'job':{const job=store.consoleService.job(auth,params.job_id);return {job:{job_id:job.job_id,job_type:job.job_type,state:job.state,total:job.total,processed:job.processed,attempt_count:job.attempt_count,last_error_code:job.last_error_code,created_at:job.created_at,updated_at:job.updated_at,result_ref:job.result_ref}};}
    case 'projects':return {projects:db.prepare('SELECT project_id,name FROM projects WHERE user_id=? ORDER BY name LIMIT 200').all(user)};

    case 'overview':return {read_only:true,production_ready:false,counts:{memories:count('memories'),sources:count('memory_sources'),summaries:count('memory_summaries'),jobs:count('memory_jobs')},
      recent:db.prepare('SELECT memory_id,content,memory_type,status,created_at FROM memories WHERE user_id=? ORDER BY created_at DESC,memory_id LIMIT 5').all(user).map(m=>({...m,content:[...m.content].slice(0,160).join('')}))};
    case 'memories': {
      if(params.query) {
        if(params.query.length>2000)throw new ValidationError('Query too long.');
        return store.searchMemories(auth,{query:params.query,limit:20,mode:params.mode||'lexical'});
      }
      if(params.mode!==undefined&&!['lexical','hybrid','semantic'].includes(params.mode))throw new ValidationError('Invalid retrieval mode.');
      const offset=Number(params.offset??0),limit=Number(params.limit??25);
      if(params.status!==undefined&&!['active','superseded','retracted'].includes(params.status))throw new ValidationError('Invalid status.');
      if(!Number.isInteger(offset)||offset<0||offset>1000000||!Number.isInteger(limit)||limit<1||limit>50)throw new ValidationError('Invalid pagination.');
      const rows=db.prepare('SELECT memory_id,content,memory_type,status,created_at FROM memories WHERE user_id=? AND (? IS NULL OR status=?) ORDER BY created_at DESC,memory_id LIMIT ? OFFSET ?').all(user,params.status||null,params.status||null,limit+1,offset);
      return {read_only:true,results:rows.slice(0,limit).map(m=>({...m,content:[...m.content].slice(0,160).join('')})),next_offset:rows.length>limit?offset+limit:null};
    }
    case 'summaries':return {read_only:true,
      categories:db.prepare(`SELECT COALESCE(o.category,a.category,'uncategorized') category,COUNT(*) count FROM memories m
        LEFT JOIN memory_category_overrides o ON o.user_id=m.user_id AND o.memory_id=m.memory_id AND o.locked=1
        LEFT JOIN memory_annotations a ON a.user_id=m.user_id AND a.memory_id=m.memory_id AND a.taxonomy_version=?
          AND a.revision=(SELECT MAX(revision) FROM memory_revisions WHERE user_id=m.user_id AND memory_id=m.memory_id)
        WHERE m.user_id=? AND m.status='active' GROUP BY COALESCE(o.category,a.category,'uncategorized')`).all(store.consoleService.taxonomy().version,user),
      summaries:db.prepare('SELECT summary_id,category,status,revision,coverage,omitted,created_at FROM memory_summaries WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user)};
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
    case 'jobs':return {read_only:true,worker_enabled:store.memoryConfig.console?.worker_enabled===true,settings:store.consoleService.settings(user),vector:db.prepare('SELECT generation,state,error_code,updated_at FROM console_vector_requests WHERE user_id=?').get(user)||null,jobs:db.prepare('SELECT job_id,job_type,state,total,processed,attempt_count,last_error_code,created_at,updated_at FROM memory_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user),operations:store.consoleService.capabilities(auth).writable?'available':'blocked_policy'};
    case 'connections':return {read_only:true,connections:db.prepare('SELECT credential_id,label,device_id,agent_id,agent_instance_id,created_at,last_used_at,revoked_at,expires_at,scopes_json FROM credentials WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user),operations:store.consoleService.capabilities(auth).writable?'available':'blocked_policy'};
    case 'audit':{const offset=Number(params.offset||0),limit=Number(params.limit||50);if(!Number.isSafeInteger(offset)||offset<0||offset>1000000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new ValidationError('Invalid pagination.');
      const rows=db.prepare('SELECT audit_id,action,target_type,target_id,outcome,created_at FROM audit_events WHERE user_id=? ORDER BY created_at DESC,audit_id LIMIT ? OFFSET ?').all(user,limit+1,offset);
      return {read_only:true,entries:rows.slice(0,limit),next_offset:rows.length>limit?offset+limit:null};}
    case 'storage':return {read_only:true,counts:{memories:count('memories'),sources:count('memory_sources'),events:count('events'),revisions:count('memory_revisions')},export:'blocked_policy',restore:'blocked_policy'};
    default:throw new NotFoundError('Console view not found.');
  }
}

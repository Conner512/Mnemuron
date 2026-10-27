import {consoleActionWritable} from '../../shared/console-contract.mjs';
import {ValidationError,NotFoundError,ConflictError} from './errors.mjs';
import {credentialView} from './console/credentials.mjs';
import {FEATURE_VIEWS,featureParams} from './console/features.mjs';
import {auditQuery} from '../../shared/console-queries.mjs';
import {auditPage} from './console/audit.mjs';
import {splitLeadingPath,memoryPresentation} from '../../shared/memory-display.mjs';
import {projectProfile} from './memory/profile.mjs';
import {CONFIG_KEYS} from './config/center.mjs';
import {MEMORY_SEARCH_CONTEXT} from './memory/search-context.mjs';
export const isConsoleReader=auth=>auth.agent_id==='mnemuron-console';
function pagination(params,maximum=50){
  const offset=Number(params.offset??0),limit=Number(params.limit??25);
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000000||!Number.isSafeInteger(limit)||limit<1||limit>maximum)throw new ValidationError('Invalid pagination.');
  return {offset,limit};
}
// A leading file path is returned separately (display only; content stays the stored text's first 160 chars),
// so the list can show the path on its own line and the body beneath it instead of 160 chars of path.
const displayParts=m=>{const parts=splitLeadingPath(m.content);return parts?{path:[...parts.path].slice(0,512).join(''),body:[...parts.body].slice(0,240).join('')}:{};};
// title/title_source/tag are display-only (derived on read from the full stored text and topic, never written).
const snippet=m=>({memory_id:m.memory_id,content:[...String(m.content??'')].slice(0,160).join(''),...displayParts(m),...memoryPresentation(m),...(m.ranking?{ranking:m.ranking}:{}),memory_type:m.memory_type,status:m.status,created_at:m.created_at,...(m.category?{category:m.category}:{}),
  ...('kind' in m?{kind:m.kind||null,concepts:m.concepts||[],strength:m.strength??null,updated_at:[m.created_at,m.traits_updated_at].filter(Boolean).sort().pop()||null}:{}),
  ...(m.project_id?{project_id:m.project_id,project_name:typeof m.project_name==='string'?m.project_name:null}:{}),
  ...(m.topic?{topic:m.topic}:{}),...(m.imported?{imported:true,original_created_at:m.original_created_at||null}:{}),...(m.review?{review:m.review}:{})});
const jobView=job=>({job_id:job.job_id,job_type:job.job_type,state:job.state,total:job.total,processed:job.processed,attempt_count:job.attempt_count,last_error_code:job.last_error_code,created_at:job.created_at,updated_at:job.updated_at,result_ref:job.result_ref});
// What tells same-category summaries apart, read from the stored scope key and window (never rewritten).
// Names come from the owner's own projects/tasks; a name that is missing stays null rather than guessed.
// The key is exactly scopeKey(): [user_id, scope, project_id, task_id, workstream_id, session_id]. Every ID
// slot must be null or a bounded string before it is bound to SQL, and each scope needs its own slots;
// anything else is reported as an unknown scope with no IDs or names rather than partly trusted.
const SUMMARY_SCOPES={user:[],project:[2],task:[3],workstream:[3,4],session:[5]};
const scopeId=value=>value===null||typeof value==='string'&&value.length>0&&value.length<=200;
function parsedScopeKey(raw,user){
  let key;try{key=JSON.parse(raw);}catch{return null;}
  // The kind must already be a string: an array or object would be coerced (or throw) as a property key.
  if(!Array.isArray(key)||key.length!==6||key[0]!==user||typeof key[1]!=='string'||!Object.hasOwn(SUMMARY_SCOPES,key[1]))return null;
  if(!key.slice(2).every(scopeId)||SUMMARY_SCOPES[key[1]].some(slot=>key[slot]===null))return null;
  return {kind:key[1],project_id:key[2],task_id:key[3],workstream_id:key[4],session_id:key[5]};
}
const windowText=(value,max)=>typeof value==='string'&&value.length<=max?value:null;
function parsedWindow(raw){
  let window;try{window=JSON.parse(raw);}catch{return null;}
  if(!window||typeof window!=='object'||Array.isArray(window)||!['daily','weekly'].includes(window.period))return null;
  const local=windowText(window.local_start,10);
  return {period:window.period,timezone:windowText(window.timezone,64),local_start:local&&/^\d{4}-\d{2}-\d{2}$/.test(local)?local:null,
    start:windowText(window.start,40),end:windowText(window.end,40)};
}
function summaryContext(db,user,row){
  const key=parsedScopeKey(row.scope_key,user);
  if(!key)return {scope:{kind:'unknown'},window:parsedWindow(row.window_json)};
  const project=key.project_id?db.prepare('SELECT name FROM projects WHERE user_id=? AND project_id=?').get(user,key.project_id):null;
  const task=key.task_id?db.prepare('SELECT title,workstreams_json FROM tasks WHERE user_id=? AND task_id=?').get(user,key.task_id):null;
  let workstream=null;
  if(task&&key.workstream_id){try{const found=JSON.parse(task.workstreams_json).find(w=>w?.workstream_id===key.workstream_id)?.name;workstream=typeof found==='string'?found:null;}catch{}}
  return {
    scope:{...key,project_name:typeof project?.name==='string'?project.name:null,task_title:typeof task?.title==='string'?task.title:null,workstream_name:workstream},
    window:parsedWindow(row.window_json),
  };
}
// Owner-scoped aggregates for overview charts. Counts only: no content, IDs or other accounts. Normal Console views
// are live-only: records of deleted projects are not counted (retained history is a separate owner view).
function overviewInsights(store,user,live){
  const db=store.db,since=new Date(Date.now()-29*86400000).toISOString().slice(0,10),own=live.sql('project_id'),aliased=live.sql('m.project_id');
  const byDay=new Map(db.prepare(`SELECT substr(created_at,1,10) day,COUNT(*) n FROM memories WHERE user_id=? AND created_at>=? AND ${own.sql} GROUP BY day`).all(user,since,...own.params).map(r=>[r.day,r.n]));
  const activity=Array.from({length:30},(_,i)=>{const day=new Date(Date.parse(since)+i*86400000).toISOString().slice(0,10);return {day,count:byDay.get(day)||0};});
  const group=column=>db.prepare(`SELECT ${column} value,COUNT(*) count FROM memories WHERE user_id=?${column==='memory_type'?" AND status='active'":''} AND ${own.sql} GROUP BY ${column} ORDER BY count DESC,value LIMIT 12`).all(user,...own.params);
  const categories=db.prepare(`SELECT COALESCE(o.category,a.category,'uncategorized') value,COUNT(*) count FROM memories m
    LEFT JOIN memory_category_overrides o ON o.user_id=m.user_id AND o.memory_id=m.memory_id AND o.locked=1
    LEFT JOIN memory_annotations a ON a.user_id=m.user_id AND a.memory_id=m.memory_id AND a.taxonomy_version=?
      AND a.revision=(SELECT MAX(revision) FROM memory_revisions WHERE user_id=m.user_id AND memory_id=m.memory_id)
    WHERE m.user_id=? AND m.status='active' AND ${aliased.sql} GROUP BY value ORDER BY count DESC,value`).all(store.consoleService.taxonomy(user).version,user,...aliased.params);
  // Writer-chosen kinds of active memories; 'none' counts records saved before kinds (or without one).
  const kinds=db.prepare(`SELECT COALESCE(t.kind,'none') value,COUNT(*) count FROM memories m LEFT JOIN memory_traits t ON t.user_id=m.user_id AND t.memory_id=m.memory_id
    WHERE m.user_id=? AND m.status='active' AND ${aliased.sql} GROUP BY value ORDER BY count DESC,value`).all(user,...aliased.params);
  return {window_days:30,activity,types:group('memory_type'),statuses:group('status'),categories,kinds};
}
// List preview of a current summary: its first claims, read through the same validated path as the detail (claims whose
// sources changed or were withdrawn never appear) under a small read budget (the metadata alone needs a few KB). The detail still shows every claim with its source.
function summaryPreview(store,auth,user,row){
  if(row.status!=='current')return null;
  try{
    const offset=store.db.prepare("SELECT COUNT(*) n FROM memory_summaries WHERE user_id=? AND scope_key=? AND category=? AND status='current' AND rowid>?").get(user,row.scope_key,row.category,row.row).n;
    const s=store.derivedMemory.summaries(user,row.scope_key,{auth,category:row.category,limit:1,offset,budget:8192}).results[0];
    if(s?.summary_id!==row.summary_id)return null;
    const quotes=(s.claims||[]).map(c=>String(c.quote||'').replace(/\s+/g,' ').trim()).filter(Boolean);
    if(!quotes.length)return null;
    const text=quotes.slice(0,3).join(' · ');
    return {text:text.length>240?text.slice(0,239)+'…':text,claims:quotes.length,more:quotes.length>3||text.length>240||s.content_complete===false};
  }catch{return null;}
}
export async function consoleRead(store,auth,view,params={}) {
  store.requireScope(auth,'console:read');if(store.consoleService.owner.user)store.consoleService.owner.require(auth.user_id);
  if(!isConsoleReader(auth))throw new NotFoundError('Console route not available.');
  const allowed={entities:['entity_id','memory_id','query','status','offset','limit'],memories:['offset','limit','query','mode','status','kind','concept','topic','origin','review','part'],summaries:['offset','limit'],jobs:['offset','limit','job_id','group','batch_id'],summary:['summary_id','revision','cursor'],job:['job_id'],'memory-meta':['memory_id'],export:['after','highwater','limit'],operation:['operation_id'],audit:['offset','limit'],
    projects:['offset','limit','archived','query'],'metadata-values':['kind','id','field','offset','limit'],'task-detail':['task_id'],'project-profile':['project_id'],tunnel:[],config:['after','limit'],'lifecycle-preview-check':['preview_id','action','confirm_name','operation_id']}[view]||[];
  if(Object.keys(params).some(key=>!(view==='audit'?['offset','limit','action','outcome','from','to','group']:featureParams[view]||allowed).includes(key)))throw new ValidationError('Unknown console query parameter.');
  if(FEATURE_VIEWS.includes(view))return store.consoleService.features.read(auth,view,params);
  const db=store.db,user=auth.user_id;
  const count=table=>db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(user).n;
  switch(view) {
    case 'entities':return store.consoleService.entities.read(auth,params);
    case 'capabilities':return store.consoleService.capabilities(auth);
    case 'models':return {models:store.consoleService.models.list(user),...(({records,system,apply})=>({hosts:records,system_hosts:system,hosts_apply:apply}))(store.consoleService.models.hosts.view(user)),processing:store.consoleService.processing(user),...store.consoleService.capabilities(auth)};
    case 'memory-meta':return store.consoleService.meta(auth,params);
    case 'export':return store.consoleService.export(auth,params);
    case 'operation':return store.consoleService.state.inspect(user,params.operation_id);
    // Lifecycle confirm pre-check (read-only; full Console write credentials only, like the confirm itself).
    case 'lifecycle-preview-check':store.consoleService.require(auth,'projects.lifecycle_preview');return store.consoleService.lifecycleMutations.check(auth,params);
    case 'job':return {read_only:true,job:jobView(store.consoleService.job(auth,params.job_id))};
    // Owner-bound, paged and bounded: full list values come from metadata-values, never from this list.
    // Deleted projects (and their count) are owner-only lifecycle truth: shown only to full Console write credentials.
    case 'projects':return store.consoleService.projects.list(user,params,{lifecycle:consoleActionWritable(auth,'projects.lifecycle_restore')});
    case 'metadata-values':return store.consoleService.projects.values(user,params);
    case 'task-detail':return store.consoleService.projects.taskDetail(user,params);
    // Owner settings: the tunnel (token, state, live routes) and the config center (fingerprint, change log).
    case 'tunnel':{store.consoleService.owner.require(user);return {read_only:true,...await store.tunnel.view()};}
    case 'config':{store.consoleService.owner.require(user);const after=Number(params.after||0),limit=Number(params.limit||30);
      if(!Number.isSafeInteger(after)||after<0||!Number.isInteger(limit)||limit<1||limit>200)throw new ValidationError('Invalid config query.');
      return {read_only:true,...store.config.state(user),history:store.config.history(user,{limit,after}),snapshot:store.config.snapshot(user),editable:CONFIG_KEYS.map(k=>k.key)};}
    case 'project-profile':return projectProfile(store,{...auth,scopes:[...auth.scopes,'memory:read']},params.project_id);

    case 'overview':{const live=store.lifecycle.live(user),own=live.sql('project_id');
      return {read_only:true,production_ready:false,counts:{memories:db.prepare(`SELECT COUNT(*) n FROM memories WHERE user_id=? AND ${own.sql}`).get(user,...own.params).n,
        sources:count('memory_sources'),summaries:count('memory_summaries'),jobs:count('memory_jobs')},
      recent:db.prepare(`SELECT memory_id,content,memory_type,status,topic,created_at FROM memories WHERE user_id=? AND ${own.sql} ORDER BY created_at DESC,memory_id LIMIT 5`).all(user,...own.params).map(({topic,...m})=>({...m,...displayParts(m),...memoryPresentation({...m,topic}),content:[...m.content].slice(0,160).join('')})),
      insights:overviewInsights(store,user,live)};}
    case 'memories': {
      const organizer=store.consoleService.organizer;
      // Sub-read of the library: counts for browsing (types, topics, statuses, origins).
      if(params.part==='facets'){if(Object.keys(params).length!==1)throw new ValidationError('Unknown console query parameter.');return organizer.facets(auth);}
      if(params.part!==undefined&&params.part!=='list')throw new ValidationError('Invalid library part.');
      const {offset,limit}=pagination(params);
      if(params.mode!==undefined&&!['lexical','hybrid','semantic'].includes(params.mode))throw new ValidationError('Invalid retrieval mode.');
      const f=organizer.filter(user,params);
      if(f.query&&params.mode!=='lexical'){
        const statuses=f.status?[f.status]:['active','superseded','retracted'];
        const found=await store.searchMemories(auth,{query:f.query,limit:20,...(params.mode?{mode:params.mode}:{}),statuses,personal_model_only:true,[MEMORY_SEARCH_CONTEXT]:{filter:f}});
        if(found.retrieval.effective_mode==='lexical'){
          const {rows,truncated,aliases,plan,total}=organizer.rows(auth,f,{limit:limit+1,offset,count:true});
          return {read_only:true,results:rows.slice(0,limit).map(snippet),offset,limit,total,next_offset:rows.length>limit?offset+limit:null,truncated,
            retrieval:{...found.retrieval,candidate_limit:500,aliases,alias_expanded:plan?.expanded,alias_ambiguous:plan?.ambiguous,alias_source_truncated:plan?.source_truncated}};
        }
        // Body, topic and keywords already share the same relevance checks. Keep the ranked,
        // pre-filtered window; do not append unvalidated keyword substring matches.
        const ranked=found.results.map(r=>r.memory_id);
        const {query,...rest}=f,{rows,total}=organizer.rows(auth,rest,{ranked,limit:limit+1,offset,count:true});
        const truncated=found.truncated===true||found.retrieval.result_truncated===true||found.retrieval.candidate_truncated===true;
        return {read_only:true,results:rows.slice(0,limit).map(r=>snippet({...r,ranking:found.results.find(x=>x.memory_id===r.memory_id)?.ranking})),offset,limit,total,next_offset:rows.length>limit?offset+limit:null,truncated,retrieval:{...found.retrieval,window_limited:true,candidate_limit:20}};
      }
      // Filters apply inside the owner-scoped (and, for a search, bounded) candidate set before paging.
      // total: matching records across all pages, so the library can show the page count and jump to a page.
      const {rows,truncated,aliases,plan,total}=organizer.rows(auth,f,{limit:limit+1,offset,count:true});
      return {read_only:true,results:rows.slice(0,limit).map(snippet),offset,limit,total,next_offset:rows.length>limit?offset+limit:null,
        ...(f.query?{truncated,retrieval:{mode:'lexical',requested_mode:'lexical',effective_mode:'lexical',candidate_limit:500,degraded:false,aliases,alias_expanded:plan?.expanded,alias_ambiguous:plan?.ambiguous,alias_source_truncated:plan?.source_truncated}}:{})};
    }
    case 'summaries':{const {offset,limit}=pagination(params),live=store.lifecycle.live(user),deps=live.sql('m.project_id');
      // A summary that depends on any record of a deleted project (also user-wide or mixed summaries, whose own scope
      // names no project) is not listed; the detail read revalidates every source.
      // A summary whose own scope names one of this owner's deleted projects is not listed either, even with no remaining
      // dependency. Malformed, dangling or foreign scope keys keep their existing display (an unknown scope, no names).
      const deadScope=JSON.stringify([...live.dead]);
      const rows=db.prepare(`SELECT rowid AS row,summary_id,category,status,revision,coverage,omitted,created_at,scope_key,window_json FROM memory_summaries s WHERE user_id=?
        AND NOT EXISTS (SELECT 1 FROM memory_summary_dependencies d JOIN memories m ON m.user_id=d.user_id AND m.memory_id=d.memory_id
          WHERE d.summary_id=s.summary_id AND NOT ${deps.sql})
        AND (json_valid(s.scope_key)=0 OR json_type(s.scope_key)<>'array' OR json_extract(s.scope_key,'$[0]') IS NOT ? OR json_extract(s.scope_key,'$[2]') IS NULL
          OR json_extract(s.scope_key,'$[2]') NOT IN (SELECT value FROM json_each(?)))
        ORDER BY created_at DESC,summary_id LIMIT ? OFFSET ?`).all(user,...deps.params,user,deadScope,limit+1,offset)
      .map(({row:rowid,scope_key,window_json,...row})=>({...row,...summaryContext(db,user,{scope_key,window_json}),preview:summaryPreview(store,auth,user,{...row,row:rowid,scope_key})}));return {read_only:true,
      categories:db.prepare(`SELECT COALESCE(o.category,a.category,'uncategorized') category,COUNT(*) count FROM memories m
        LEFT JOIN memory_category_overrides o ON o.user_id=m.user_id AND o.memory_id=m.memory_id AND o.locked=1
        LEFT JOIN memory_annotations a ON a.user_id=m.user_id AND a.memory_id=m.memory_id AND a.taxonomy_version=?
          AND a.revision=(SELECT MAX(revision) FROM memory_revisions WHERE user_id=m.user_id AND memory_id=m.memory_id)
        WHERE m.user_id=? AND m.status='active' AND ${deps.sql} GROUP BY COALESCE(o.category,a.category,'uncategorized')`).all(store.consoleService.taxonomy(user).version,user,...deps.params),
      summaries:rows.slice(0,limit),offset,limit,next_offset:rows.length>limit?offset+limit:null};}
    case 'summary': {
      const row=db.prepare('SELECT rowid AS row,* FROM memory_summaries WHERE user_id=? AND summary_id=?').get(user,params.summary_id||'');
      if(!row)throw new NotFoundError('Summary not found.');
      // Detail agrees with the list: a summary scoped to one of this owner's deleted projects is PROJECT_DELETED; malformed,
      // dangling and foreign keys keep their existing unknown-scope display. Every dependency is still revalidated below.
      const scopeProject=parsedScopeKey(row.scope_key,user)?.project_id??null;
      if(scopeProject!==null&&store.lifecycle.projectState(user,scopeProject)==='deleted')throw new ConflictError('This project was deleted.','PROJECT_DELETED');
      if(row.status!=='current'||params.revision!==undefined&&Number(params.revision)!==row.revision)throw new ConflictError('Summary changed; restart reading.','SUMMARY_VERSION_CHANGED');
      const offset=params.cursor?0:db.prepare("SELECT COUNT(*) n FROM memory_summaries WHERE user_id=? AND scope_key=? AND category=? AND status='current' AND rowid>?").get(user,row.scope_key,row.category,row.row).n;
      const result=store.derivedMemory.summaries(user,row.scope_key,{auth,category:row.category,limit:1,offset,cursor:params.cursor,budget:48*1024});
      if(result.results[0]?.summary_id!==row.summary_id)throw new ConflictError('Summary changed; restart reading.','SUMMARY_VERSION_CHANGED');
      const next=result.results[0].content_complete?null:{summary_id:row.summary_id,revision:row.revision,cursor:result.next_cursor};
      return {...result,context:{...summaryContext(db,user,row),coverage:row.coverage,omitted:row.omitted,created_at:row.created_at},
        next_request:next,next_cursor:next?.cursor||null,next_offset:null,complete:!next};
    }
    case 'jobs':{const {offset,limit}=pagination(params);if(params.job_id)return {read_only:true,job:jobView(store.consoleService.job(auth,params.job_id))};
      // One page of a batch's jobs, with the project/task and day each one covers.
      if(params.batch_id){if(typeof params.batch_id!=='string'||params.batch_id.length>200)throw new ValidationError('Invalid batch.');
        const page=store.memoryJobs.batchPage(user,params.batch_id,{offset,limit});
        return {read_only:true,batch_id:params.batch_id,total:page.total,offset,limit,next_offset:offset+limit<page.total?offset+limit:null,
          jobs:page.rows.map(({scope_key,window_json,...j})=>({...j,...summaryContext(db,user,{scope_key,window_json})}))};}
      // stale_taxonomy: the job was planned with a category list the account has since changed.
      const version=store.consoleService.taxonomy(user).version;
      const rows=db.prepare('SELECT job_id,job_type,state,total,processed,attempt_count,last_error_code,created_at,updated_at,metadata_json,json_extract(metadata_json,\'$.taxonomy.version\') taxonomy_version FROM memory_jobs WHERE user_id=? ORDER BY created_at DESC,job_id LIMIT ? OFFSET ?').all(user,limit+1,offset)
        .map(({taxonomy_version,metadata_json,...job})=>({...job,stale_taxonomy:job.job_type!=='classification'&&!!taxonomy_version&&taxonomy_version!==version,...(job.job_type==='classification'?{retired:true}:{})}));
      // group=batch (the console page): one row per planned round with its progress; offset and next_offset page through
      // the batches instead of the jobs.
      const batches=params.group==='batch'?store.memoryJobs.batches(user,{offset,limit:limit+1}):null,more=batches?batches.length>limit:rows.length>limit;
      return {read_only:true,...(batches?{batches:batches.slice(0,limit)}:{}),worker_enabled:store.consoleService.owner.user?store.consoleService.owner.allowed('processing'):store.memoryConfig.console?.worker_enabled===true,settings:store.consoleService.settings(user),vector:db.prepare('SELECT generation,state,error_code,updated_at FROM console_vector_requests WHERE user_id=?').get(user)||null,jobs:rows.slice(0,limit),offset,limit,next_offset:more?offset+limit:null,processing:{summary:store.consoleService.processing(user).summary},operations:store.consoleService.capabilities(auth).writable?'available':'blocked_policy'};}
    case 'connections':return {read_only:true,connections:db.prepare('SELECT credential_id,label,device_id,agent_id,agent_instance_id,created_at,last_used_at,revoked_at,expires_at,scopes_json FROM credentials WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user).map(row=>credentialView(row)),operations:store.consoleService.capabilities(auth).writable?'available':'blocked_policy'};
    case 'audit':{let q;try{q=auditQuery(params);}catch{throw new ValidationError('Invalid audit query.');}
      return auditPage(store,user,q);}
    case 'storage':return {read_only:true,counts:{memories:count('memories'),sources:count('memory_sources'),events:count('events'),revisions:count('memory_revisions')},export:'blocked_policy',restore:'blocked_policy'};
    default:throw new NotFoundError('Console view not found.');
  }
}

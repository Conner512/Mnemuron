import {DEFAULT_TAXONOMY,adoptionPreview,categoryDefinitions} from '../memory-derived/taxonomy.mjs';
import {readFileSync} from 'node:fs';
import {object,id,number} from './state.mjs';
import {ValidationError,ConflictError,NotFoundError,AuthorizationError} from '../errors.mjs';
import {CONSOLE_FEATURE_VIEWS as FEATURE_VIEWS} from '../../../shared/console-contract.mjs';

export {FEATURE_VIEWS};
// An explicit Codex plugin grant, separate from ordinary memory/capture credentials.
// Preview, confirmation and delivery still enforce their existing session/owner checks.
const CODEX_CONTINUITY_SCOPES=['resume:read','resume:confirm','task:bootstrap:preview','task:bootstrap:confirm','project:bootstrap:preview','project:bootstrap:confirm'];
const DEVICE_WRITE_SCOPES=['memory:read','memory:write','capture:write'];
// Memory flow over the last 7 days, counts only: new live memories by where they came from, and audited searches and
// reads by who made them (ChatGPT, the console, or any other agent credential: coding assistants).
const SOURCE_GROUP=source=>source==='model_submitted'?'chatgpt':source==='console_explicit'?'console':source==='capture_derived'?'agents':/import/.test(source||'')?'import':'other';
const READER_GROUP=agent=>agent==='chatgpt-web'?'chatgpt':agent==='mnemuron-console'?'console':'agents';
function activity(db,user,liveSql){const since=new Date(Date.now()-7*86400000).toISOString(),sources={chatgpt:0,agents:0,console:0,import:0,other:0},uses={chatgpt:{search:0,read:0},agents:{search:0,read:0},console:{search:0,read:0}};
  for(const r of db.prepare(`SELECT source,count(*) n FROM memories WHERE user_id=? AND created_at>=? AND ${liveSql.sql} GROUP BY source`).all(user,since,...liveSql.params))sources[SOURCE_GROUP(r.source)]+=r.n;
  for(const r of db.prepare("SELECT c.agent_id agent,e.action,count(*) n FROM audit_events e LEFT JOIN credentials c ON c.credential_id=e.credential_id WHERE e.user_id=? AND e.created_at>=? AND e.action IN ('memory.query','memory.read') GROUP BY c.agent_id,e.action").all(user,since))
    uses[READER_GROUP(r.agent)][r.action==='memory.query'?'search':'read']+=r.n;
  // Write-time scrubbing (server/lib/redaction.mjs) records one privacy.redacted event per scrubbed write.
  const redacted=db.prepare("SELECT count(*) n FROM audit_events WHERE user_id=? AND created_at>=? AND action='privacy.redacted'").get(user,since).n;
  return {window_days:7,sources,uses,redacted};}
// Overview memory map: the newest active memories (coloured by kind) with their keywords and topics. The browser links
// memories through shared keywords (agentmemory-style concepts); there is no separate entity layer. Bounded; keywords
// and topics are the owner's own labels; no memory content is returned. entities/links stay empty for older clients.
// day: the latest of written and traits-updated (YYYY-MM-DD), so the browser can show a recent window (7/30/90 days…).
const GRAPH_MEMORIES=1000;
function memoryGraph(service,auth){const db=service.db,user=auth.user_id,live=service.store.lifecycle.live(user).sql('m.project_id');
  const memories=db.prepare(`SELECT m.memory_id id,t.kind,t.concepts_json,m.topic,substr(max(m.created_at,COALESCE(t.updated_at,'')),1,10) day FROM memories m
    LEFT JOIN memory_traits t ON t.user_id=m.user_id AND t.memory_id=m.memory_id
    WHERE m.user_id=? AND m.status='active' AND ${live.sql} ORDER BY m.created_at DESC,m.memory_id LIMIT ?`).all(user,...live.params,GRAPH_MEMORIES+1);
  const concepts=raw=>{try{const v=JSON.parse(raw||'[]');return Array.isArray(v)?v.filter(c=>typeof c==='string').slice(0,8):[];}catch{return [];}};
  return {memories:memories.slice(0,GRAPH_MEMORIES).map(m=>({id:m.id,kind:m.kind||null,concepts:concepts(m.concepts_json),topic:m.topic||null,day:m.day||null})),entities:[],links:[],truncated:memories.length>GRAPH_MEMORIES};}
export const FEATURE_ACTIONS=['memory.batch_retract','privacy.defaults','retention.save','retention.prune','devices.register','devices.rotate'];
export const featureParams={
  'task-branches':['task_id','project_id','offset','limit'],'project-context':['project_id'],
  'task-checkpoints':['task_id','offset','limit'],'task-reconciliation':['task_id'],
  'memory-versions':['memory_id','offset','limit','revision','content_offset','content_limit','chain'],
};
const page=p=>{
  const offset=Number(p.offset??0),limit=Number(p.limit??25);number(offset,0,1000000);number(limit,1,100);return {offset,limit};
};
const paged=(rows,{offset,limit},key='items')=>({[key]:rows.slice(0,limit),offset,limit,next_offset:rows.length>limit?offset+limit:null});
const count=(db,sql,...args)=>db.prepare(sql).get(...args).n;
const packageVersion=JSON.parse(readFileSync(new URL('../../../package.json',import.meta.url),'utf8')).version;

// Console preferences are account-owned. Never write the global operator retention settings.
export class ConsoleFeatures {
  constructor(service){this.service=service;this.store=service.store;this.db=service.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS console_preferences(user_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(user_id,kind));`);
  }
  initializeNewAccountTaxonomy(user){
    // Called before the first credential is inserted, under the issuance transaction.
    // Revoked credentials and retained data also identify an existing account.
    if(this.store.memoryConfig.memory?.taxonomy)return;
    for(const table of ['credentials','memories','events','tasks','console_preferences','audit_events'])
      if(this.db.prepare(`SELECT 1 FROM ${table} WHERE user_id=? LIMIT 1`).get(user))return;
    this.db.prepare('INSERT INTO console_preferences VALUES(?,?,?,?)').run(user,'taxonomy-default',0,JSON.stringify(DEFAULT_TAXONOMY));
  }
  preference(user,kind,fallback){const row=this.db.prepare('SELECT revision,value_json FROM console_preferences WHERE user_id=? AND kind=?').get(user,kind);return {revision:row?.revision||0,...(row?JSON.parse(row.value_json):fallback)};}
  save(user,kind,p,value){const previous=this.preference(user,kind,{});number(p.expected_revision,0,2147483647);
    if(previous.revision!==p.expected_revision)throw new ConflictError('Settings changed; reload before saving.','SETTINGS_VERSION_CHANGED');
    this.db.prepare('INSERT INTO console_preferences VALUES(?,?,?,?) ON CONFLICT(user_id,kind) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json').run(user,kind,previous.revision+1,JSON.stringify(value));
    return {status:'saved',revision:previous.revision+1,...value};
  }
  privacy(user){const {sensitivity,...current}=this.preference(user,'privacy',{cloud_readable:false});return current;} // sensitivity: removed, ignored if stored
  retention(user){return {...this.preference(user,'retention',{raw_retention_days:this.store.getRetention().raw_retention_days}),applies_to_existing_events:false,checkpoints:'permanent',memories:'permanent',pinned_sources_preserved:true};}
  taxonomy(user,fallback){const p=this.preference(user,'taxonomy',fallback);return {version:p.version,categories:p.categories};}
  // Display names for category IDs. Built-in IDs without a stored name are translated by the browser.
  descriptions(user){const p=this.preference(user,'taxonomy',{});return p.descriptions&&typeof p.descriptions==='object'?p.descriptions:{};}
  labels(user){const p=this.preference(user,'taxonomy',{});return p.labels&&typeof p.labels==='object'?p.labels:{};}
  task(auth,taskId){id(taskId);const row=this.db.prepare('SELECT * FROM tasks WHERE user_id=? AND task_id=?').get(auth.user_id,taskId);if(!row)throw new NotFoundError('Task not found.');
    this.service.projects.requireLive(auth.user_id,row.project_id);return row;}
  read(auth,view,p){
    object(p,featureParams[view]||[]);const {db,store,service}=this,user=auth.user_id;
    const result=value=>({read_only:true,production_ready:false,...value});
    if(view==='taxonomy'){const current=this.preference(user,'taxonomy',service.taxonomy(user)),labels=this.labels(user);return result({...current,...service.taxonomy(user),labels,descriptions:this.descriptions(user),definitions:categoryDefinitions(service.taxonomy(user),labels,this.descriptions(user)),default_adoption:adoptionPreview(service.taxonomy(user),current.revision,labels)});}
    if(view==='privacy-defaults')return result({...this.privacy(user),applies_to:'new_console_memories',cloud_grant_requires_explicit_revision:true});
    if(view==='retention')return result(this.retention(user));
    // Normal views are live-only: records of deleted projects are not counted or listed.
    const liveSql=view==='attention'||view==='capture-status'||view==='task-branches'?store.lifecycle.live(user).sql('project_id'):null;
    if(view==='attention')return result({counts:{memories:db.prepare(`SELECT count(*) n FROM memories WHERE user_id=? AND ${liveSql.sql}`).get(user,...liveSql.params).n,
      failed_jobs:count(db,"SELECT count(*) n FROM memory_jobs WHERE user_id=? AND state IN ('dead_letter','blocked_auth','blocked_budget','blocked_config','review_required')",user),
      stale_summaries:count(db,"SELECT count(*) n FROM memory_summaries WHERE user_id=? AND status='stale'",user),
      pending_reconciliation:count(db,"SELECT count(*) n FROM task_reconciliation_proposals WHERE user_id=? AND status='awaiting_confirmation'",user)},activity_7d:activity(db,user,liveSql),graph:memoryGraph(service,auth)});
    if(view==='capture-status')return result({
      agents:db.prepare(`SELECT agent_id,agent_instance_id,device_id,count(*) events,max(received_at) last_received_at,max(captured_at) last_captured_at FROM events WHERE user_id=? AND ${liveSql.sql} GROUP BY agent_id,agent_instance_id,device_id ORDER BY last_received_at DESC LIMIT 100`).all(user,...liveSql.params),
      local_hook_failures:'not_observable',local_queue:'not_observable',
      processing:db.prepare('SELECT state,count(*) count FROM memory_processing_outbox WHERE user_id=? GROUP BY state').all(user)});
    if(view==='model-usage'){
      const day=new Date().toISOString().slice(0,10),hasVectors=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_owner_vector_usage'").get(),hasBuild=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_owner_vector_build_usage'").get();
      const models=service.models.list(user).map(m=>{
        if(!m.config.model)return {kind:m.kind,configured:false,used:null,limit:null};
        const profile=service.models.profile(user,m.kind,m.config).fingerprint;
        const calls=db.prepare('SELECT reserved_calls n FROM memory_owner_model_usage WHERE user_id=? AND profile=? AND day=?').get(user,profile,day)?.n||0;
        const vectorCalls=hasVectors?db.prepare('SELECT count n FROM memory_owner_vector_usage WHERE user_id=? AND profile=? AND day=?').get(user,profile,day)?.n||0:0;
        // First-run build calls are real requests but are bounded by the first-run total, not the daily limit.
        const buildCalls=hasBuild?db.prepare('SELECT count n FROM memory_owner_vector_build_usage WHERE user_id=? AND profile=? AND day=?').get(user,profile,day)?.n||0:0;
        // The enforced limits: the owner's call limits when set (null = no limit), otherwise the model's daily requests.
        const quota=service.models.quotas.view(user,m.kind),daily=quota.mode==='manual'?quota.daily:{limit:m.config.daily_requests,used:calls+vectorCalls,remaining:Math.max(0,m.config.daily_requests-calls-vectorCalls)};
        return {kind:m.kind,configured:true,used:daily.used,limit:daily.limit,remaining:daily.remaining,limit_mode:quota.mode,total:quota.total,
          first_run_build_calls:buildCalls,total_requests:calls+vectorCalls+buildCalls};
      });
      // Usage page: owner-counted calls per kind for the last 14 UTC days (zero-filled) and how many memory searches
      // were audited in the last 7 days. Counts only.
      const since=new Date(Date.now()-13*86400000).toISOString().slice(0,10),days=Array.from({length:14},(_,i)=>new Date(Date.parse(since)+i*86400000).toISOString().slice(0,10));
      const daily=db.prepare("SELECT 1 FROM sqlite_master WHERE name='console_model_usage_daily'").get()?db.prepare('SELECT kind,day,used FROM console_model_usage_daily WHERE user_id=? AND day>=?').all(user,since):[];
      const history=days.map(d=>({day:d,...Object.fromEntries(['organizer','embedder'].map(kind=>[kind,daily.find(r=>r.day===d&&r.kind===kind)?.used||0]))}));
      const searches=db.prepare("SELECT count(*) n FROM audit_events WHERE user_id=? AND action='memory.query' AND created_at>=?").get(user,new Date(Date.now()-7*86400000).toISOString()).n;
      return result({day,unit:'reserved_requests',cost:null,cost_status:'not_metered',models,history,searches_7d:searches});
    }
    if(view==='task-branches'){
      if(p.task_id){this.task(auth,p.task_id);return result({preview:store.previewTaskBranches(auth,{query:p.task_id,signals:{task_id:p.task_id}})});}
      const pg=page(p);let members=null;
      if(p.project_id){id(p.project_id);if(!db.prepare('SELECT 1 FROM projects WHERE user_id=? AND project_id=?').get(user,p.project_id))throw new NotFoundError('Project not found.');
        // A merged source's tasks belong to its canonical project; each task keeps its origin project_id.
        members=store.lifecycle.scope(user,p.project_id).members;}
      const rows=db.prepare(`SELECT task_id,project_id,title,status,canonical_version,updated_at FROM tasks WHERE user_id=? AND ${liveSql.sql}
        AND (? IS NULL OR project_id IN (SELECT value FROM json_each(?))) ORDER BY updated_at DESC,task_id LIMIT ? OFFSET ?`)
        .all(user,...liveSql.params,members?'1':null,members?JSON.stringify(members):null,pg.limit+1,pg.offset);
      return result(paged(rows,pg,'tasks'));
    }
    if(view==='project-context'){
      id(p.project_id);if(!db.prepare('SELECT 1 FROM projects WHERE user_id=? AND project_id=?').get(user,p.project_id))throw new NotFoundError('Project not found.');
      return result(store.previewProjectContext(auth,{project_id:p.project_id,query:p.project_id}));
    }
    if(view==='task-checkpoints'){
      const row=this.task(auth,p.task_id),pg=page(p);
      // Per-record lifecycle (a moved Task keeps an earlier, possibly deleted, project's checkpoints), before paging.
      const live=store.lifecycle.live(user).sql('project_id');
      const checkpoints=db.prepare(`SELECT * FROM checkpoints WHERE user_id=? AND task_id=? AND ${live.sql} ORDER BY created_at DESC,checkpoint_id LIMIT ? OFFSET ?`).all(user,p.task_id,...live.params,pg.limit+1,pg.offset).map(r=>store.checkpointFromRow(r));
      return result({...paged(checkpoints,pg,'checkpoints'),canonical:store.taskFromRow(row),revisions:store.listCanonicalRevisions({...auth,scopes:[...auth.scopes,'task:reconcile:read']},p.task_id,100)});
    }
    if(view==='task-reconciliation'){this.task(auth,p.task_id);return result(store.reconciliationState(auth,p.task_id,{internal:true}));}
    if(view==='memory-versions'){
      id(p.memory_id);service.memory(auth,p.memory_id);
      // Corrections create a replacement record linked by supersedes/superseded_by. chain=1 lists that lineage,
      // newest first (at most 10 records, live projects only), with each record's latest revision and why it was made (a replaced record keeps the correction reason).
      if(p.chain!==undefined){if(p.chain!=='1')throw new ValidationError('Invalid version chain request.');
        const live=store.lifecycle.live(user).sql('project_id'),get=memoryId=>db.prepare(`SELECT memory_id,status,created_at,lifecycle_reason,supersedes_memory_id,superseded_by_memory_id FROM memories WHERE user_id=? AND memory_id=? AND ${live.sql}`).get(user,memoryId,...live.params);
        let row=get(p.memory_id);const seen=new Set();
        while(row?.superseded_by_memory_id&&!seen.has(row.memory_id)&&seen.size<50){seen.add(row.memory_id);row=get(row.superseded_by_memory_id)||null;}
        const chain=[];seen.clear();
        while(row&&!seen.has(row.memory_id)&&chain.length<11){seen.add(row.memory_id);chain.push(row);row=row.supersedes_memory_id?get(row.supersedes_memory_id):null;}
        const revisions=db.prepare('SELECT memory_id,MAX(revision) revision FROM memory_revisions WHERE user_id=? AND memory_id IN (SELECT value FROM json_each(?)) GROUP BY memory_id').all(user,JSON.stringify(chain.map(c=>c.memory_id)));
        const byId=new Map(revisions.map(r=>[r.memory_id,r]));
        return result({memory_id:p.memory_id,chain:chain.slice(0,10).map((c,i)=>({memory_id:c.memory_id,status:c.status,created_at:c.created_at,revision:byId.get(c.memory_id)?.revision||1,reason:chain[i+1]?.lifecycle_reason||null})),truncated:chain.length>10});}
      if(p.revision!==undefined){
        const revision=Number(p.revision),offset=Number(p.content_offset??0),limit=Number(p.content_limit??4096);number(revision,1,2147483647);number(offset,0,1000000);number(limit,1,4096);
        const row=db.prepare('SELECT revision,content,status,reason,created_at FROM memory_revisions WHERE user_id=? AND memory_id=? AND revision=?').get(user,p.memory_id,revision);if(!row)throw new NotFoundError('Revision not found.');
        const chars=[...row.content],end=offset+limit;return result({...row,content:chars.slice(offset,end).join(''),content_offset:offset,content_length:chars.length,content_complete:end>=chars.length,next_request:end<chars.length?{memory_id:p.memory_id,revision,content_offset:end,content_limit:limit}:null});
      }
      const pg=page(p);return result(paged(db.prepare('SELECT revision,status,reason,created_at,length(content) content_length FROM memory_revisions WHERE user_id=? AND memory_id=? ORDER BY revision DESC LIMIT ? OFFSET ?').all(user,p.memory_id,pg.limit+1,pg.offset),pg,'versions'));
    }
    if(view==='system-health')return result({...(service.owner.user?{owner:service.owner.view(user)}:{}),services:{core:db.prepare('SELECT 1 n').get().n===1?'ready':'unavailable',search:store.memorySearch.status().state,
      worker:service.owner.user?(service.owner.allowed('processing')?'enabled_not_probed':'paused'):(store.memoryConfig.console?.worker_enabled?'enabled_not_probed':'disabled'),vector:store.memoryConfig.vector_store?.enabled?'enabled_not_probed':'disabled',mcp:'not_probed'},observed_at:new Date().toISOString()});
    if(view==='system-version')return result({release:packageVersion,node:process.version,schema_version:db.prepare('PRAGMA user_version').get().user_version,migrations:'initialization_completed',production_ready:false});
    if(view==='backups')return result({status:'not_configured',entries:[],verified:false,automatic_backup_changed:false});
    throw new NotFoundError('Console feature not found.');
  }
  apply(auth,action,p){
    const {store,service,db}=this,user=auth.user_id;
    if(action.startsWith('memory.batch_')){
      object(p,['items','reason']);
      if(!Array.isArray(p.items)||!p.items.length||p.items.length>50)throw new ValidationError('Batch must contain 1..50 records.');
      for(const item of p.items){object(item,['memory_id','revision']);id(item.memory_id);number(item.revision,1,2147483647);}
      if(new Set(p.items.map(i=>i.memory_id)).size!==p.items.length)throw new ValidationError('Duplicate records in batch.');
      if(p.reason!==undefined&&(typeof p.reason!=='string'||p.reason.length>4096))throw new ValidationError('Invalid reason.');
      const results=p.items.map(item=>{
        try{return store.memoryTransaction(()=>({memory_id:item.memory_id,ok:true,result:service.apply(auth,'memory.retract',{...item,reason:p.reason})}));}
        catch(error){if(!error.errorCode)throw error;return {memory_id:item.memory_id,ok:false,error_code:error.errorCode};}
      });return {status:results.every(r=>r.ok)?'completed':'partial',results,physically_deleted:false};
    }
    if(action==='privacy.defaults'){
      object(p,['expected_revision','sensitivity','cloud_readable']); // a sent sensitivity is ignored
      if(p.cloud_readable!==false)throw new AuthorizationError('explicit per-revision cloud grant');
      return this.save(user,'privacy',p,{cloud_readable:false});
    }
    if(action==='retention.save'){
      object(p,['expected_revision','raw_retention_days']);if(p.raw_retention_days!=='permanent')number(p.raw_retention_days,1,3650);
      return {...this.save(user,'retention',p,{raw_retention_days:p.raw_retention_days}),applies_to_existing_events:false,checkpoints:'permanent'};
    }
    if(action==='retention.prune'){
      object(p,['confirmed','batch_size']);if(p.confirmed!==true)throw new ValidationError('Explicit confirmation required.');const limit=p.batch_size??100;number(limit,1,1000);
      return store.pruneExpired({...auth,scopes:[...auth.scopes,'admin:retention']},{batchSize:limit,recordMaintenance:false});
    }
    if(action==='devices.register'){
      object(p,['label','agent_id','device_id','access','task_continuity','receipt_session']);
      if(p.receipt_session!==undefined&&!/^[a-f0-9]{64}$/.test(p.receipt_session))throw new ValidationError('Invalid receipt binding.');
      if(p.task_continuity!==undefined&&typeof p.task_continuity!=='boolean')throw new ValidationError('Invalid task continuity choice.');
      if(p.task_continuity===true&&(p.agent_id!=='codex'||p.access!=='read_write'))throw new ValidationError('Task continuity requires a read-write Codex plugin credential.');
      const {receipt_session,task_continuity,...input}=p,result=service.apply(auth,'connections.create',input);result.secret_expires_in_seconds=300;
      // Existing clients retain the memory/capture grant. Only explicit Codex plugin setup adds continuity.
      if(p.access==='read_write'){
        const scopes=[...DEVICE_WRITE_SCOPES,...(task_continuity?CODEX_CONTINUITY_SCOPES:[])];
        db.prepare('UPDATE credentials SET scopes_json=? WHERE user_id=? AND credential_id=?').run(JSON.stringify(scopes),user,result.credential.credential_id);
        result.credential.scopes=scopes;
      }return result;
    }
    if(action==='devices.rotate'){
      object(p,['credential_id','receipt_session']);id(p.credential_id);
      if(p.receipt_session!==undefined&&!/^[a-f0-9]{64}$/.test(p.receipt_session))throw new ValidationError('Invalid receipt binding.');
      const row=db.prepare('SELECT * FROM credentials WHERE user_id=? AND credential_id=?').get(user,p.credential_id);
      if(!row)throw new NotFoundError('Credential not found.');
      const scopes=JSON.parse(row.scopes_json);
      const allowed=[...DEVICE_WRITE_SCOPES,...(row.agent_id==='codex'?CODEX_CONTINUITY_SCOPES:[])];
      if(['mnemuron-console','chatgpt-web','mnemuron'].includes(row.agent_id)||scopes.some(s=>!allowed.includes(s)))throw new ConflictError('Managed credential.','MANAGED_CONNECTION');
      if(row.revoked_at||row.expires_at&&Date.parse(row.expires_at)<=Date.now())throw new ConflictError('Credential inactive.','CONNECTION_REVOKED');
      db.prepare('UPDATE credentials SET revoked_at=? WHERE user_id=? AND credential_id=?').run(new Date().toISOString(),user,row.credential_id);
      const created=store.issueCredential({label:row.label,userId:user,deviceId:row.device_id,agentId:row.agent_id,agentInstanceId:row.agent_instance_id,scopes,expiresAt:row.expires_at});
      return {status:'rotated',...created,secret_expires_in_seconds:300};
    }
    throw new NotFoundError('Console action not found.');
  }
}

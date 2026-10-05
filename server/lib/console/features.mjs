import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {object,id,number} from './state.mjs';
import {ValidationError,ConflictError,NotFoundError,AuthorizationError} from '../errors.mjs';
import {CONSOLE_FEATURE_VIEWS as FEATURE_VIEWS} from '../../../shared/console-contract.mjs';
import {categoryEditor} from './organize.mjs';

export {FEATURE_VIEWS};
export const FEATURE_ACTIONS=['memory.batch_classify','memory.batch_retract','taxonomy.save','privacy.defaults','retention.save','retention.prune','devices.register','devices.rotate'];
export const featureParams={
  'task-branches':['task_id','project_id','offset','limit'],'project-context':['project_id'],
  'task-checkpoints':['task_id','offset','limit'],'task-reconciliation':['task_id'],
  'memory-versions':['memory_id','offset','limit','revision','content_offset','content_limit'],
};
const page=p=>{
  const offset=Number(p.offset??0),limit=Number(p.limit??25);number(offset,0,1000000);number(limit,1,100);return {offset,limit};
};
const paged=(rows,{offset,limit},key='items')=>({[key]:rows.slice(0,limit),offset,limit,next_offset:rows.length>limit?offset+limit:null});
const count=(db,sql,...args)=>db.prepare(sql).get(...args).n;
const packageVersion=JSON.parse(readFileSync(new URL('../../../package.json',import.meta.url),'utf8')).version;

// Console preferences are account-owned. Never write the global operator retention settings.
export class ConsoleFeatures {
  constructor(service){this.service=service;this.store=service.store;this.db=service.db;this.categories=categoryEditor(this);
    this.db.exec(`CREATE TABLE IF NOT EXISTS console_preferences(user_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,value_json TEXT NOT NULL,PRIMARY KEY(user_id,kind));`);
  }
  preference(user,kind,fallback){const row=this.db.prepare('SELECT revision,value_json FROM console_preferences WHERE user_id=? AND kind=?').get(user,kind);return {revision:row?.revision||0,...(row?JSON.parse(row.value_json):fallback)};}
  save(user,kind,p,value){const previous=this.preference(user,kind,{});number(p.expected_revision,0,2147483647);
    if(previous.revision!==p.expected_revision)throw new ConflictError('Settings changed; reload before saving.','SETTINGS_VERSION_CHANGED');
    this.db.prepare('INSERT INTO console_preferences VALUES(?,?,?,?) ON CONFLICT(user_id,kind) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json').run(user,kind,previous.revision+1,JSON.stringify(value));
    return {status:'saved',revision:previous.revision+1,...value};
  }
  privacy(user){return this.preference(user,'privacy',{sensitivity:'sensitive',cloud_readable:false});}
  retention(user){return {...this.preference(user,'retention',{raw_retention_days:this.store.getRetention().raw_retention_days}),applies_to_existing_events:false,checkpoints:'permanent',memories:'permanent',pinned_sources_preserved:true};}
  taxonomy(user,fallback){const p=this.preference(user,'taxonomy',fallback);return {version:p.version,categories:p.categories};}
  // Display names for category IDs. Built-in IDs without a stored name are translated by the browser.
  labels(user){const p=this.preference(user,'taxonomy',{});return p.labels&&typeof p.labels==='object'?p.labels:{};}
  restoreCategory(auth,detail){return this.categories.restore(auth,detail);}
  task(auth,taskId){id(taskId);const row=this.db.prepare('SELECT * FROM tasks WHERE user_id=? AND task_id=?').get(auth.user_id,taskId);if(!row)throw new NotFoundError('Task not found.');return row;}
  read(auth,view,p){
    object(p,featureParams[view]||[]);const {db,store,service}=this,user=auth.user_id;
    const result=value=>({read_only:true,production_ready:false,...value});
    if(view==='taxonomy')return result({...this.preference(user,'taxonomy',service.taxonomy(user)),...service.taxonomy(user),labels:this.labels(user)});
    if(view==='privacy-defaults')return result({...this.privacy(user),applies_to:'new_console_memories',cloud_grant_requires_explicit_revision:true});
    if(view==='retention')return result(this.retention(user));
    if(view==='attention')return result({counts:{memories:count(db,'SELECT count(*) n FROM memories WHERE user_id=?',user),
      failed_jobs:count(db,"SELECT count(*) n FROM memory_jobs WHERE user_id=? AND state IN ('dead_letter','blocked_auth','blocked_budget','blocked_config','review_required')",user),
      stale_summaries:count(db,"SELECT count(*) n FROM memory_summaries WHERE user_id=? AND status='stale'",user),
      pending_reconciliation:count(db,"SELECT count(*) n FROM task_reconciliation_proposals WHERE user_id=? AND status='awaiting_confirmation'",user)}});
    if(view==='capture-status')return result({
      agents:db.prepare('SELECT agent_id,agent_instance_id,device_id,count(*) events,max(received_at) last_received_at,max(captured_at) last_captured_at FROM events WHERE user_id=? GROUP BY agent_id,agent_instance_id,device_id ORDER BY last_received_at DESC LIMIT 100').all(user),
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
        return {kind:m.kind,configured:true,used:calls+vectorCalls,limit:m.config.daily_requests,remaining:Math.max(0,m.config.daily_requests-calls-vectorCalls),
          first_run_build_calls:buildCalls,total_requests:calls+vectorCalls+buildCalls};
      });return result({day,unit:'reserved_requests',cost:null,cost_status:'not_metered',models});
    }
    if(view==='task-branches'){
      if(p.task_id){this.task(auth,p.task_id);return result({preview:store.previewTaskBranches(auth,{query:p.task_id})});}
      const pg=page(p);if(p.project_id){id(p.project_id);if(!db.prepare('SELECT 1 FROM projects WHERE user_id=? AND project_id=?').get(user,p.project_id))throw new NotFoundError('Project not found.');}
      const rows=db.prepare('SELECT task_id,project_id,title,status,canonical_version,updated_at FROM tasks WHERE user_id=? AND (? IS NULL OR project_id=?) ORDER BY updated_at DESC,task_id LIMIT ? OFFSET ?').all(user,p.project_id||null,p.project_id||null,pg.limit+1,pg.offset);
      return result(paged(rows,pg,'tasks'));
    }
    if(view==='project-context'){
      id(p.project_id);if(!db.prepare('SELECT 1 FROM projects WHERE user_id=? AND project_id=?').get(user,p.project_id))throw new NotFoundError('Project not found.');
      return result(store.previewProjectContext(auth,{project_id:p.project_id,query:p.project_id}));
    }
    if(view==='task-checkpoints'){
      const row=this.task(auth,p.task_id),pg=page(p);
      const checkpoints=db.prepare('SELECT * FROM checkpoints WHERE user_id=? AND task_id=? ORDER BY created_at DESC,checkpoint_id LIMIT ? OFFSET ?').all(user,p.task_id,pg.limit+1,pg.offset).map(r=>store.checkpointFromRow(r));
      return result({...paged(checkpoints,pg,'checkpoints'),canonical:store.taskFromRow(row),revisions:store.listCanonicalRevisions({...auth,scopes:[...auth.scopes,'task:reconcile:read']},p.task_id,100)});
    }
    if(view==='task-reconciliation'){this.task(auth,p.task_id);return result(store.reconciliationState(auth,p.task_id,{internal:true}));}
    if(view==='memory-versions'){
      id(p.memory_id);service.memory(auth,p.memory_id);
      if(p.revision!==undefined){
        const revision=Number(p.revision),offset=Number(p.content_offset??0),limit=Number(p.content_limit??4096);number(revision,1,2147483647);number(offset,0,1000000);number(limit,1,4096);
        const row=db.prepare('SELECT revision,content,status,reason,created_at FROM memory_revisions WHERE user_id=? AND memory_id=? AND revision=?').get(user,p.memory_id,revision);if(!row)throw new NotFoundError('Revision not found.');
        const chars=[...row.content],end=offset+limit;return result({...row,content:chars.slice(offset,end).join(''),content_offset:offset,content_length:chars.length,content_complete:end>=chars.length,next_request:end<chars.length?{memory_id:p.memory_id,revision,content_offset:end,content_limit:limit}:null});
      }
      const pg=page(p);return result(paged(db.prepare('SELECT revision,status,reason,created_at,length(content) content_length FROM memory_revisions WHERE user_id=? AND memory_id=? ORDER BY revision DESC LIMIT ? OFFSET ?').all(user,p.memory_id,pg.limit+1,pg.offset),pg,'versions'));
    }
    if(view==='system-health')return result({services:{core:db.prepare('SELECT 1 n').get().n===1?'ready':'unavailable',search:store.memorySearch.status().state,
      worker:store.memoryConfig.console?.worker_enabled?'enabled_not_probed':'disabled',vector:store.memoryConfig.vector_store?.enabled?'enabled_not_probed':'disabled',mcp:'not_probed'},observed_at:new Date().toISOString()});
    if(view==='system-version')return result({release:packageVersion,node:process.version,schema_version:db.prepare('PRAGMA user_version').get().user_version,migrations:'initialization_completed',production_ready:false});
    if(view==='backups')return result({status:'not_configured',entries:[],verified:false,automatic_backup_changed:false});
    throw new NotFoundError('Console feature not found.');
  }
  apply(auth,action,p){
    const {store,service,db}=this,user=auth.user_id;
    if(action.startsWith('memory.batch_')){
      object(p,['items',...(action==='memory.batch_classify'?['category']:['reason'])]);
      if(!Array.isArray(p.items)||!p.items.length||p.items.length>50)throw new ValidationError('Batch must contain 1..50 records.');
      for(const item of p.items){object(item,['memory_id','revision']);id(item.memory_id);number(item.revision,1,2147483647);}
      if(new Set(p.items.map(i=>i.memory_id)).size!==p.items.length)throw new ValidationError('Duplicate records in batch.');
      if(action==='memory.batch_classify'&&!service.taxonomy(user).categories.includes(p.category))throw new ValidationError('Invalid category.');
      if(p.reason!==undefined&&(typeof p.reason!=='string'||p.reason.length>4096))throw new ValidationError('Invalid reason.');
      if(action==='memory.batch_classify'){
        // One recorded batch for the eligible items, so the whole selection can be undone together.
        const {results,batch}=service.organizer.classify(auth,p.items,p.category,{kind:'batch_classify'});
        return {status:results.every(r=>r.ok)?'completed':'partial',results,physically_deleted:false,...(batch?{batch_id:batch.batch_id,changed:batch.changed,undo_available:batch.undo_available}:{})};
      }
      const results=p.items.map(item=>{
        try{return store.memoryTransaction(()=>({memory_id:item.memory_id,ok:true,result:service.apply(auth,'memory.retract',{...item,reason:p.reason})}));}
        catch(error){if(!error.errorCode)throw error;return {memory_id:item.memory_id,ok:false,error_code:error.errorCode};}
      });return {status:results.every(r=>r.ok)?'completed':'partial',results,physically_deleted:false};
    }
    if(action==='taxonomy.save'){
      object(p,['expected_revision','categories']);const version='console-'+createHash('sha256').update(JSON.stringify([user,p.categories])).digest('hex');
      const taxonomy={version,categories:p.categories};store.derivedMemory.taxonomy(taxonomy);
      const used=db.prepare('SELECT DISTINCT category FROM memory_category_overrides WHERE user_id=? AND locked=1').all(user);
      if(used.some(r=>!p.categories.includes(r.category)))throw new ConflictError('Reclassify records before removing their category.','CATEGORY_IN_USE');
      const before=this.categories.current(user),labels=Object.fromEntries(Object.entries(before.labels).filter(([c])=>p.categories.includes(c)));
      const saved=this.save(user,'taxonomy',p,{...taxonomy,labels});
      // Model classifications of kept IDs stay visible under the new version; old rows are preserved.
      this.categories.carryForward(user,before.version,version,p.categories);
      // Jobs keep their immutable taxonomy; fence the old queued jobs before any output can publish.
      this.categories.fence(user);
      db.prepare("UPDATE memory_summaries SET status='stale' WHERE user_id=? AND status='current'").run(user);
      return {...saved,labels:undefined};
    }
    if(action==='privacy.defaults'){
      object(p,['expected_revision','sensitivity','cloud_readable']);service.sensitivity(p.sensitivity);
      if(p.cloud_readable!==false)throw new AuthorizationError('explicit per-revision cloud grant');
      return this.save(user,'privacy',p,{sensitivity:p.sensitivity,cloud_readable:false});
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
      object(p,['label','agent_id','device_id','access','receipt_session']);
      if(p.receipt_session!==undefined&&!/^[a-f0-9]{64}$/.test(p.receipt_session))throw new ValidationError('Invalid receipt binding.');
      const {receipt_session,...input}=p,result=service.apply(auth,'connections.create',input);result.secret_expires_in_seconds=300;
      // Capture is opt-in and never includes administration, bootstrap or Resume scopes.
      if(p.access==='read_write'){
        const scopes=['memory:read','memory:write','capture:write'];
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
      if(['mnemuron-console','chatgpt-web','mnemuron'].includes(row.agent_id)||scopes.some(s=>!['memory:read','memory:write','capture:write'].includes(s)))throw new ConflictError('Managed credential.','MANAGED_CONNECTION');
      if(row.revoked_at||row.expires_at&&Date.parse(row.expires_at)<=Date.now())throw new ConflictError('Credential inactive.','CONNECTION_REVOKED');
      db.prepare('UPDATE credentials SET revoked_at=? WHERE user_id=? AND credential_id=?').run(new Date().toISOString(),user,row.credential_id);
      const created=store.issueCredential({label:row.label,userId:user,deviceId:row.device_id,agentId:row.agent_id,agentInstanceId:row.agent_instance_id,scopes,expiresAt:row.expires_at});
      return {status:'rotated',...created,secret_expires_in_seconds:300};
    }
    throw new NotFoundError('Console action not found.');
  }
}

import {CONSOLE_WRITE_SCOPES,exactScopes} from '../../../shared/console-contract.mjs';
import {webMemorySql,AGENT_READ_POLICIES} from '../memory/web-visibility.mjs';
import {protectGroup} from '../lifecycle/protection.mjs';
import {randomUUID} from 'node:crypto';
import {object,number,fingerprint} from './state.mjs';
import {ConflictError,AuthorizationError,ValidationError} from '../errors.mjs';
import {classificationContext} from '../memory-derived/taxonomy.mjs';
import {calendarWindow} from '../memory-jobs/windows.mjs';
import {MemoryWorker} from '../memory-jobs/worker.mjs';
import {VectorIndex} from '../vector-stores/index.mjs';

export const OWNER_ACTIONS=['features.save','schedule.save','processing.preview','processing.start','processing.pause','processing.resume','processing.cancel'];
export const OWNER_FLAGS=['processing','classification','summary','entities','vector_build','vector_search','memory','handoff','capture','conversation','cloud_write','cloud_submitted_grants','connections'];
const channels=['classification','summary','entities','vector'];
const flag=kind=>kind==='vector'?'vector_build':kind;
const modelKind=kind=>kind==='vector'?'embedder':'organizer';
const error=(code)=>{throw new ConflictError(code,code);};
const now=()=>Date.now();

// Explicit migration only. Constructor never initializes policy or authorizes existing work.
export function migrateOwner(db,user,defaults){
 db.exec(`CREATE TABLE IF NOT EXISTS owner_feature_policy(user_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,flags_json TEXT NOT NULL,schedule_json TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS owner_processing_runs(run_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,policy_revision INTEGER NOT NULL,model_revision INTEGER NOT NULL,profile TEXT NOT NULL,manifest_digest TEXT NOT NULL,budget INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,metadata_json TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,generation TEXT,error_code TEXT);
 CREATE TABLE IF NOT EXISTS owner_processing_items(run_id TEXT NOT NULL,ordinal INTEGER NOT NULL,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,state_hash TEXT NOT NULL,PRIMARY KEY(run_id,ordinal));
 CREATE TABLE IF NOT EXISTS owner_processing_jobs(job_id TEXT PRIMARY KEY,run_id TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS owner_processing_runs_state ON owner_processing_runs(user_id,state,created_at);`);
 protectGroup(db,'owner_controls');
 const flags={processing:false,classification:false,summary:false,entities:false,vector_build:false,vector_search:defaults.vector_search===true,memory:defaults.memory===true,handoff:defaults.handoff===true,capture:defaults.capture===true,conversation:defaults.conversation===true,cloud_write:defaults.cloud_write===true,cloud_submitted_grants:defaults.cloud_submitted_grants===true,connections:defaults.connections===true};
 const highwater=db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM memories WHERE user_id=?').get(user).n;
 db.prepare('INSERT OR IGNORE INTO owner_feature_policy VALUES(?,0,?,?,?)').run(user,JSON.stringify(flags),JSON.stringify({enabled:false,kinds:[],interval_minutes:60,max_items:10,budget:10,after_rowid:highwater,next_at:0}),now());
 return {schema:'owner-controls-v1',owner:user,existing_outbox_untouched:true};
}
export class OwnerControls{
 constructor(service){this.service=service;this.store=service.store;this.db=service.db;this.user=this.store.memoryConfig.console?.owner_user_id||null;
  if(this.user){if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='owner_feature_policy'").get()||!this.db.prepare('SELECT 1 FROM owner_feature_policy WHERE user_id=?').get(this.user))error('OWNER_MIGRATION_REQUIRED');
   // Runtime getters remain live after a Web save; the startup file is a bootstrap, not a hidden business gate.
   for(const [property,key] of [['memory','memory'],['captureExtraction','capture'],['cloudMemory','cloud_write'],['cloudSubmittedGrant','cloud_submitted_grants']])Object.defineProperty(this.store.runtime,property,{configurable:true,get:()=>this.policy().flags[key]});
   const conversation=this.store.memoryService.conversation;Object.defineProperty(this.store.memoryService,'conversation',{configurable:true,get:()=>({...conversation,enabled:conversation?.enabled===true&&this.allowed('conversation')})});
   this.store.memoryTransaction(()=>this.store.handoffPolicy.setEnabled(this.allowed('handoff')));
   Object.defineProperty(this.store.runtime,'agentReadPolicy',{configurable:true,get:()=>this.preferences().read_policy});
  }
 }
 require(user){if(!this.user||user!==this.user)throw new AuthorizationError('single owner');}
 policy(){const row=this.db.prepare('SELECT * FROM owner_feature_policy WHERE user_id=?').get(this.user);if(!row)error('OWNER_MIGRATION_REQUIRED');return {revision:row.revision,flags:JSON.parse(row.flags_json),schedule:JSON.parse(row.schedule_json)};}
 preferences(){return this.service.features.preference(this.user,'owner-controls',{read_policy:this.store.memoryConfig.memory?.agent_read_policy||'chatgpt_per_memory_v1',retrieval_mode:this.store.memoryConfig.memory?.retrieval?.mode||'hybrid'});}
 readImpact(policy){return this.db.prepare(`SELECT COUNT(*) n FROM memories m WHERE m.user_id=? AND m.status='active' AND NOT EXISTS(SELECT 1 FROM project_lifecycle l WHERE l.user_id=m.user_id AND l.project_id=m.project_id AND l.state<>'active') AND ${webMemorySql({agent_id:'chatgpt-web',read_policy:AGENT_READ_POLICIES[policy]})}`).get(this.user).n;}
 allowed(key){return !this.user||this.policy().flags[key]===true;}
 view(user){this.require(user);const p=this.policy(),models=this.service.models.list(user),effective={};
  for(const key of OWNER_FLAGS){const blockers=[];if(!p.flags[key])blockers.push('FEATURE_DISABLED');
   if(['classification','summary','entities','vector_build'].includes(key)){
    if(!p.flags.processing)blockers.push('PROCESSING_PAUSED');
    const c=models.find(m=>m.kind===(key==='vector_build'?'embedder':'organizer'))?.config;
    blockers.push(...this.service.models.quotas.view(user,key==='vector_build'?'embedder':'organizer').exhausted);
    if(!c?.enabled)blockers.push('NOT_CONFIGURED');else if(!c.egress_approved)blockers.push('EGRESS_DENIED');
    if(!p.flags.memory)blockers.push('MEMORY_DISABLED');
    if(key==='vector_build'&&c?.enabled&&!this.service.probeVerified(user,c.dimensions))blockers.push('PROBE_REQUIRED');
   }
   if(key==='cloud_write'&&this.store.memoryConfig.cloud_memory?.enabled!==true)blockers.push('CLOUD_WRITE_NOT_CONFIGURED');
   if(key==='conversation'&&this.store.memoryConfig.memory?.capture_extraction?.conversation?.enabled!==true)blockers.push('CONVERSATION_NOT_CONFIGURED');
   if(key==='vector_search'){const quota=this.service.models.quotas.view(user,'embedder');blockers.push(...quota.exhausted);const c=models.find(m=>m.kind==='embedder')?.config;if(!c?.enabled)blockers.push('NOT_CONFIGURED');if(!c?.query_approved||!c?.egress_approved)blockers.push('QUERY_EGRESS_DENIED');if(!this.db.prepare('SELECT 1 FROM memory_vector_owner_active WHERE user_id=?').get(user))blockers.push('VECTOR_NOT_READY');}
   if(['vector_build','vector_search'].includes(key)&&!this.store.memoryConfig.vector_store?.enabled)blockers.push('VECTOR_DISABLED');
   effective[key]={requested:p.flags[key],effective:!blockers.length,blockers};
  }
  return {...p,preferences:this.preferences(),read_policy_options:(this.store.memoryConfig.memory?.agent_read_policy==='active_uniform_v1'?['chatgpt_per_memory_v1','active_uniform_v1']:['chatgpt_per_memory_v1']).map(value=>({value,active_readable:this.readImpact(value)})),effective,mode:'single_owner',configured:true,model_calls_on_save:0,historical_replay:false,
   runs:this.db.prepare('SELECT run_id,kind,state,budget,used,created_at,generation,error_code,manifest_digest,metadata_json FROM owner_processing_runs WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30').all(user).map(({metadata_json,...r})=>{const m=JSON.parse(metadata_json);return {...r,count:m.limits.items,model:m.model,sensitivities:m.sensitivities,excluded:m.excluded,truncated:m.truncated};}),
   legacy_runnable_jobs:this.db.prepare("SELECT COUNT(*) n FROM memory_jobs j WHERE user_id=? AND state IN ('pending','retry_wait','leased') AND NOT EXISTS(SELECT 1 FROM owner_processing_jobs g WHERE g.job_id=j.job_id)").get(user).n};
 }
 save(user,p){this.require(user);object(p,['expected_revision','flags','read_policy','retrieval_mode']);object(p.flags,OWNER_FLAGS);const old=this.policy();if(p.expected_revision!==old.revision)error('SETTINGS_VERSION_CHANGED');
  for(const value of Object.values(p.flags))if(typeof value!=='boolean')throw new ValidationError('Boolean flags required.');
  const preferences=this.preferences();
  if(p.read_policy!==undefined){if(!['chatgpt_per_memory_v1','active_uniform_v1'].includes(p.read_policy)||p.read_policy==='active_uniform_v1'&&this.store.memoryConfig.memory?.agent_read_policy!=='active_uniform_v1')error('READ_POLICY_OUTSIDE_DEPLOYMENT');preferences.read_policy=p.read_policy;}
  if(p.retrieval_mode!==undefined){if(!['lexical','hybrid','semantic'].includes(p.retrieval_mode))throw new ValidationError('Invalid retrieval mode');preferences.retrieval_mode=p.retrieval_mode;}
  const flags={...old.flags,...p.flags};
  if(flags.cloud_submitted_grants&&this.store.memoryConfig.cloud_memory?.allow_submitted_revision_grant!==true)error('CLOUD_GRANT_NOT_CONFIGURED');
  if(flags.cloud_write&&this.store.memoryConfig.cloud_memory?.enabled!==true)error('CLOUD_WRITE_NOT_CONFIGURED');
  if(flags.conversation&&this.store.memoryConfig.memory?.capture_extraction?.conversation?.enabled!==true)error('CONVERSATION_NOT_CONFIGURED');
  // Saving pauses all grants, including in-flight leases; reopening a feature never resumes a run.
  this.service.features.save(user,'owner-controls',{expected_revision:preferences.revision},{read_policy:preferences.read_policy,retrieval_mode:preferences.retrieval_mode});
  this.fenceAll(user);if(flags.handoff!==old.flags.handoff)this.store.handoffPolicy.setEnabled(flags.handoff);
  this.db.prepare('UPDATE owner_feature_policy SET flags_json=?,revision=revision+1 WHERE user_id=?').run(JSON.stringify(flags),user);
  return {status:'saved',features:this.view(user),processing_started:false};
 }
 schedule(user,p,credentialId){this.require(user);object(p,['expected_revision','enabled','kinds','interval_minutes','max_items','budget']);
  const old=this.policy();if(p.expected_revision!==old.revision)error('SETTINGS_VERSION_CHANGED');if(typeof p.enabled!=='boolean'||!Array.isArray(p.kinds)||p.kinds.some(k=>!channels.includes(k))||new Set(p.kinds).size!==p.kinds.length||p.enabled&&!p.kinds.length)throw new ValidationError('Invalid schedule');
  number(p.interval_minutes,5,10080);number(p.max_items,1,100);number(p.budget,1,1000);
  // Explicitly scoped to newly created memories after this save, never old revisions/outbox replays.
  const highwater=this.db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM memories WHERE user_id=?').get(user).n;
  const schedule={...p,credential_id:credentialId,model_revisions:Object.fromEntries(p.kinds.map(k=>[k,this.service.models.raw(user,modelKind(k))?.revision||0])),after_rowid:highwater,next_at:now()+p.interval_minutes*60000};delete schedule.expected_revision;
  this.fenceAll(user);this.db.prepare('UPDATE owner_feature_policy SET schedule_json=?,revision=revision+1 WHERE user_id=?').run(JSON.stringify(schedule),user);
  return {status:'saved',features:this.view(user),processing_started:false,new_memories_only:true};
 }
 fenceAll(user){for(const r of this.db.prepare("SELECT run_id FROM owner_processing_runs WHERE user_id=? AND state IN ('queued','running')").all(user))this.change(user,r.run_id,'paused');}
 run(user,id){this.require(user);const r=this.db.prepare('SELECT * FROM owner_processing_runs WHERE user_id=? AND run_id=?').get(user,id);if(!r)error('RUN_NOT_FOUND');return {...r,metadata:JSON.parse(r.metadata_json)};}
 items(id){return this.db.prepare('SELECT memory_id,revision,state_hash FROM owner_processing_items WHERE run_id=? ORDER BY ordinal').all(id);}
 preview(user,p,{automatic=false,after=0,credentialId=null}={}){this.require(user);object(p,['kind','limit','budget','from','to']);if(!channels.includes(p.kind))throw new ValidationError('Unknown processing kind');number(p.limit,1,100);number(p.budget,1,1000);
  const dates={};for(const key of ['from','to'])if(p[key]){if(typeof p[key]!=='string'||!Number.isFinite(Date.parse(p[key])))throw new ValidationError('Invalid date');dates[key]=new Date(p[key]).toISOString();}
  if(dates.from&&dates.to&&dates.from>dates.to)throw new ValidationError('Invalid date range');
  const model=this.service.models.raw(user,modelKind(p.kind));if(!model)error('NOT_CONFIGURED');const c=JSON.parse(model.config_json);if(!c.enabled)error('NOT_CONFIGURED');if(!c.egress_approved)error('EGRESS_DENIED');
  const provider=this.service.models.provider(user,modelKind(p.kind)),policy=this.policy();
  const where=['user_id=?','rowid>?',"status='active'"];const values=[user,after];if(dates.from){where.push('created_at>=?');values.push(dates.from);}if(dates.to){where.push('created_at<=?');values.push(dates.to);}
  const rows=this.db.prepare(`SELECT rowid n,memory_id FROM memories WHERE ${where.join(' AND ')} ORDER BY rowid LIMIT ?`).all(...values,p.limit+1),chosen=rows.slice(0,p.limit),items=[],sensitivities={};let excluded=0;
  for(const row of chosen){const s=this.store.derivedMemory.currentSource(user,row.memory_id);if(!s||!provider.profile.egress.sensitivities.includes(s.sensitivity)){excluded++;continue;}items.push({memory_id:s.memory_id,revision:s.revision,state_hash:s.state_hash});sensitivities[s.sensitivity]=(sensitivities[s.sensitivity]||0)+1;}
  if(!items.length){if(automatic)return {status:'no_work',after_rowid:chosen.at(-1)?.n||after};error('MANIFEST_EMPTY');}const id=randomUUID(),digest=fingerprint(items),metadata={credential_id:credentialId,model:c.model,model_kind:modelKind(p.kind),model_revision:model.revision,profile:provider.profile.fingerprint,limits:{budget:p.budget,items:items.length},sensitivities,excluded,truncated:rows.length>p.limit,range:dates,automatic,lifecycle_generation:this.store.lifecycle.generation(user),after_rowid:chosen.at(-1)?.n||after,taxonomy:this.service.taxonomy(user)};
  this.db.prepare("INSERT INTO owner_processing_runs VALUES(?,?,?,'preview',?,?,?,?,?,0,?,?,?,NULL,NULL)").run(id,user,p.kind,policy.revision,model.revision,provider.profile.fingerprint,digest,p.budget,JSON.stringify(metadata),now(),now()+15*60000);
  const insert=this.db.prepare('INSERT INTO owner_processing_items VALUES(?,?,?,?,?)');for(const [i,item] of items.entries())insert.run(id,i,item.memory_id,item.revision,item.state_hash);
  return {status:'preview',run_id:id,kind:p.kind,count:items.length,digest,budget:p.budget,model:c.model,model_revision:model.revision,sensitivities,excluded,truncated:rows.length>p.limit,range:dates,expires_at:now()+15*60000,production_content_sent:false};
 }
 validate(item,user){const s=this.store.derivedMemory.currentSource(user,item.memory_id);return s&&s.revision===item.revision&&s.state_hash===item.state_hash?s:null;}
 ready(run){if(run.metadata.lifecycle_generation!==this.store.lifecycle.generation(run.user_id))error('STALE_INPUT');const credential=this.db.prepare("SELECT scopes_json FROM credentials WHERE credential_id=? AND user_id=? AND agent_id='mnemuron-console' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)").get(run.metadata.credential_id,this.user,new Date().toISOString());if(!credential||!exactScopes(JSON.parse(credential.scopes_json),CONSOLE_WRITE_SCOPES))error('OWNER_CREDENTIAL_INACTIVE');const p=this.policy();if(!p.flags.processing||!p.flags[flag(run.kind)]||!p.flags.memory)error('PROCESSING_PAUSED');if(run.policy_revision!==p.revision)error('SETTINGS_VERSION_CHANGED');
  const row=this.service.models.raw(run.user_id,modelKind(run.kind));if(!row||row.revision!==run.model_revision)error('MODEL_VERSION_CHANGED');const c=JSON.parse(row.config_json);if(!c.enabled||!c.egress_approved)error('EGRESS_DENIED');
  if(run.kind==='vector'&&!this.store.memoryConfig.vector_store?.enabled)error('VECTOR_DISABLED');
  if(run.kind==='vector'&&!this.service.probeVerified(run.user_id,c.dimensions))error('PROBE_REQUIRED');
 }
 start(user,p){object(p,['run_id','digest']);const r=this.run(user,p.run_id);if(r.state!=='preview'||r.expires_at<now())error('PREVIEW_EXPIRED');if(p.digest!==r.manifest_digest)error('MANIFEST_CHANGED');this.ready(r);
  const items=this.items(r.run_id);for(const item of items)if(!this.validate(item,user))error('STALE_INPUT');
  if(r.kind==='vector'){
   const index=this.vector(r),generation=index.begin(r.profile,{manifest:items});this.service.models.snapshot(user,generation);
   this.db.prepare('UPDATE owner_processing_runs SET generation=? WHERE run_id=?').run(generation,r.run_id);
   this.db.prepare("INSERT OR REPLACE INTO console_vector_requests VALUES(?,?,?,'pending',NULL,?)").run(user,generation,r.profile,now());
  }else{
   const groups=new Map(),taxonomy=this.service.taxonomy(user);
   for(const item of items){const s=this.store.derivedMemory.currentSource(user,item.memory_id),category=r.kind==='summary'?this.store.derivedMemory.category(s,taxonomy.version):'uncategorized',window=r.kind==='summary'?calendarWindow(Date.parse(s.created_at),{timezone:'UTC',period:'daily'}):null;
    const key=fingerprint([s.scope_key,category,window]);if(!groups.has(key))groups.set(key,{scope:s.scope_key,items:[],metadata:{taxonomy,category,window,owner_run:r.run_id,...(r.kind==='classification'?{classification_context:classificationContext(this.store,user,taxonomy)}:{}),...(r.kind==='entities'?{configuration_revision:r.model_revision,lifecycle_stamp:this.store.entities.lifecycleStamp(user,s.project_id),lifecycle_generation:this.store.lifecycle.generation(user)}:{}),prompt_version:r.kind==='summary'?'grounded-extractive-v5':r.kind==='classification'?'grounded-classification-v4':'entities-grounded-v1',schema_version:r.kind==='summary'?'memory-derived-spans-v2':'memory-derived-v1'}});groups.get(key).items.push(s);
   }
   for(const group of groups.values()){const jobId=this.store.memoryJobs.enqueue({type:r.kind,userId:user,profile:r.profile,...group});this.db.prepare('INSERT INTO owner_processing_jobs VALUES(?,?)').run(jobId,r.run_id);}
  }
  this.db.prepare("UPDATE owner_processing_runs SET state='queued' WHERE run_id=?").run(r.run_id);return {status:'queued',run_id:r.run_id,count:items.length,budget:r.budget};
 }
 change(user,id,state){const r=this.run(user,id);if(['cancelled','completed'].includes(r.state))error('RUN_TERMINAL');if(state==='paused'&&!['queued','running','blocked','paused'].includes(r.state))error('RUN_NOT_STARTED');
  this.db.prepare('UPDATE owner_processing_runs SET state=? WHERE run_id=?').run(state,id);
  this.db.prepare("UPDATE memory_jobs SET state='blocked_config',fence=fence+1,lease_owner=NULL,lease_expires=NULL,last_error_code='PROCESSING_PAUSED' WHERE job_id IN (SELECT job_id FROM owner_processing_jobs WHERE run_id=?) AND state NOT IN ('succeeded','cancelled')").run(id);
  if(r.generation)this.db.prepare('UPDATE memory_vector_generations SET fence=fence+1,lease_owner=NULL,lease_expires=NULL WHERE generation=?').run(r.generation);
  return {status:state,run_id:id,sent_requests_cannot_be_recalled:true};
 }
 resume(user,p){object(p,['run_id','digest']);const r=this.run(user,p.run_id);if(!['paused','blocked'].includes(r.state)||p.digest!==r.manifest_digest)error('RUN_NOT_RESUMABLE');
  const revision=this.policy().revision;this.ready({...r,policy_revision:revision});for(const item of this.items(r.run_id))if(!this.validate(item,user))error('STALE_INPUT');
  if(r.used>=r.budget)error('RUN_BUDGET_EXHAUSTED');
  this.db.prepare("UPDATE owner_processing_runs SET state='queued',policy_revision=?,error_code=NULL WHERE run_id=?").run(revision,r.run_id);
  this.db.prepare("UPDATE memory_profile_state SET state='ready' WHERE profile=?").run(r.profile);
  this.db.prepare("UPDATE memory_jobs SET state='pending',run_after=?,last_error_code=NULL WHERE job_id IN (SELECT job_id FROM owner_processing_jobs WHERE run_id=?) AND state NOT IN ('succeeded','cancelled')").run(now(),r.run_id);return {status:'queued',run_id:r.run_id};
 }
 guard(id,{reserve=false}={}){const r=this.run(this.user,id);if(!['queued','running'].includes(r.state))error('PROCESSING_PAUSED');this.ready(r);for(const item of this.items(id))if(!this.validate(item,r.user_id))error('STALE_INPUT');if(reserve){if(r.used>=r.budget)error('RUN_BUDGET_EXHAUSTED');this.db.prepare('UPDATE owner_processing_runs SET used=used+1 WHERE run_id=?').run(id);}return r;}
 guardJob(job,{reserve=false}={}){if(!this.user)return;const g=this.db.prepare('SELECT run_id FROM owner_processing_jobs WHERE job_id=?').get(job.job_id);if(!g||job.user_id!==this.user)error('EXECUTION_GRANT_REQUIRED');this.guard(g.run_id,{reserve});}
 vector(r){const provider=this.service.models.provider(r.user_id,'embedder',{runId:r.run_id});return new VectorIndex(this.store,this.service.vectorBackend(this.store.memoryConfig.vector_store),new Map([[provider.profile.fingerprint,provider]]),{ownerId:r.user_id,prefix:this.store.memoryConfig.vector_store.collection_prefix,guard:()=>this.guard(r.run_id),budget:(purpose,day)=>{this.guard(r.run_id,{reserve:true});return this.service.models.budgetReserve(r.user_id,purpose,day);}});}
 async tick(){if(!this.user)return;const p=this.policy();if(!p.flags.processing)return;
  const schedule=p.schedule;
  if(schedule.enabled&&schedule.next_at<=now()){
   try{this.store.memoryTransaction(()=>{
    // Per-channel grants cover only new rows since the explicit schedule activation.
    let after=schedule.after_rowid;for(const kind of schedule.kinds){if(!p.flags[flag(kind)])continue;try{if((this.service.models.raw(this.user,modelKind(kind))?.revision||0)!==schedule.model_revisions?.[kind])error('MODEL_VERSION_CHANGED');const preview=this.preview(this.user,{kind,limit:schedule.max_items,budget:schedule.budget},{automatic:true,after:schedule.after_rowid,credentialId:schedule.credential_id});if(preview.status==='no_work'){after=Math.max(after,preview.after_rowid);continue;}this.start(this.user,{run_id:preview.run_id,digest:preview.digest});after=Math.max(after,this.run(this.user,preview.run_id).metadata.after_rowid);}catch(e){if(e.errorCode!=='MANIFEST_EMPTY')throw e;}}
    this.db.prepare("UPDATE owner_feature_policy SET schedule_json=? WHERE user_id=?").run(JSON.stringify({...schedule,after_rowid:after,next_at:now()+schedule.interval_minutes*60000}),this.user);
   });}catch(e){this.db.prepare('UPDATE owner_feature_policy SET schedule_json=? WHERE user_id=?').run(JSON.stringify({...schedule,enabled:false,error_code:e.errorCode||e.code||'SCHEDULE_BLOCKED'}),this.user);}
  }
  const rows=this.db.prepare("SELECT run_id FROM owner_processing_runs WHERE user_id=? AND state IN ('queued','running') ORDER BY created_at LIMIT 1").all(this.user);
  for(const row of rows){const r=this.run(this.user,row.run_id);try{
   this.guard(r.run_id);this.db.prepare("UPDATE owner_processing_runs SET state='running' WHERE run_id=?").run(r.run_id);
   if(r.kind==='vector'){const index=this.vector(r),result=await index.sync(r.generation,{maxDocuments:1});this.guard(r.run_id);if(result.complete){this.db.prepare("UPDATE owner_processing_runs SET state='completed' WHERE run_id=?").run(r.run_id);this.db.prepare("UPDATE console_vector_requests SET state='built',error_code=NULL,updated_at=? WHERE user_id=? AND generation=?").run(now(),r.user_id,r.generation);}}
   else{
    const provider=this.service.models.provider(this.user,'organizer',{runId:r.run_id});await new MemoryWorker(this.store,this.store.memoryJobs,provider,{workerId:`owner-${process.pid}`,userId:this.user,profileFilter:r.profile,runId:r.run_id,quota:(job,day)=>this.service.models.quotas.reserve(this.user,'organizer',{day})}).drain({maxJobs:1});
    const states=this.db.prepare('SELECT j.state FROM memory_jobs j JOIN owner_processing_jobs g ON g.job_id=j.job_id WHERE g.run_id=?').all(r.run_id).map(x=>x.state);
    if(states.every(s=>s==='succeeded'))this.db.prepare("UPDATE owner_processing_runs SET state='completed' WHERE run_id=? AND state='running'").run(r.run_id);
    else if(states.some(s=>!['pending','leased','retry_wait','succeeded'].includes(s)))this.db.prepare("UPDATE owner_processing_runs SET state='blocked',error_code='RUN_BLOCKED' WHERE run_id=? AND state='running'").run(r.run_id);
   }
  }catch(e){this.db.prepare("UPDATE owner_processing_runs SET state='blocked',error_code=? WHERE run_id=? AND state IN ('running','queued')").run(e.errorCode||e.code||'RUN_BLOCKED',r.run_id);}}
 }
 apply(auth,action,p){const user=auth.user_id;this.require(user);if(action==='features.save')return this.save(user,p);if(action==='schedule.save')return this.schedule(user,p,auth.credential_id);if(action==='processing.preview')return this.preview(user,p,{credentialId:auth.credential_id});if(action==='processing.start')return this.start(user,p);if(action==='processing.resume')return this.resume(user,p);object(p,['run_id']);return this.change(user,p.run_id,action==='processing.cancel'?'cancelled':'paused');}
}

import {randomUUID} from 'node:crypto';
import {ConsoleState,object,id,number,fingerprint} from './state.mjs';
import {ConsoleModels} from './models.mjs';
import {consoleWritable,CONSOLE_ACTIONS} from '../../../shared/console-contract.mjs';
import {AuthorizationError,ValidationError,ConflictError,NotFoundError} from '../errors.mjs';
import {MemoryWorker,scheduleLibrary} from '../memory-jobs/worker.mjs';
import {VectorIndex} from '../vector-stores/index.mjs';
import {QdrantStore} from '../vector-stores/qdrant.mjs';

const taxonomyDefault={version:'console-default-v1',categories:['uncategorized','preferences','projects','technical','personal','decisions']};
const receipt=result=>({status:result.status,memory_id:result.replacement_memory?.memory_id||result.memory?.memory_id||result.memory_id,physically_deleted:false});
export class ConsoleService {
  constructor(store){this.store=store;this.db=store.db;this.state=new ConsoleState(store);this.models=new ConsoleModels(store,this.state);this.busy=false;}
  require(auth){if(!consoleWritable(auth))throw new AuthorizationError('console:write');}
  taxonomy(){return this.store.memoryConfig.memory?.taxonomy||taxonomyDefault;}
  capabilities(auth){return {version:'console-actions-v1',writable:consoleWritable(auth),actions:consoleWritable(auth)?CONSOLE_ACTIONS:[],taxonomy:this.taxonomy(),
    secret_storage:!!this.store.memoryConfig.console?.key_file,worker_enabled:this.store.memoryConfig.console?.worker_enabled===true,vector_enabled:this.store.memoryConfig.vector_store?.enabled===true,production_ready:false};}
  memory(auth,memoryId,revision){id(memoryId);const row=this.db.prepare('SELECT * FROM memories WHERE user_id=? AND memory_id=?').get(auth.user_id,memoryId);if(!row)throw new NotFoundError('Memory not found.','MEMORY_NOT_FOUND');
    const current=this.store.revisions.latest(auth.user_id,memoryId);if(revision!==undefined&&number(revision,1,2147483647)!==current.revision)throw new ConflictError('Memory changed; review the current revision.','MEMORY_VERSION_CHANGED');return {row,current};}
  meta(auth,p){object(p,['memory_id']);const {row,current}=this.memory(auth,p.memory_id);
    const sensitivity=this.db.prepare('SELECT sensitivity FROM memory_privacy WHERE user_id=? AND memory_id=?').get(auth.user_id,row.memory_id)?.sensitivity||'sensitive';
    const category=this.store.derivedMemory.category({user_id:auth.user_id,memory_id:row.memory_id,revision:current.revision},this.taxonomy().version);
    return {memory_id:row.memory_id,revision:current.revision,state_hash:current.state_hash,sensitivity,category,
      web_allowed:row.status==='active'&&this.store.webVisibility.visible({...auth,agent_id:'chatgpt-web'},row.memory_id),scope:row.scope,topic:row.topic,memory_type:row.memory_type,status:row.status};}
  job(auth,jobId){const job=this.store.memoryJobs.get(id(jobId));if(!job||job.user_id!==auth.user_id)throw new NotFoundError('Job not found.','JOB_NOT_FOUND');return job;}
  settings(user){const row=this.db.prepare('SELECT * FROM console_settings WHERE user_id=?').get(user);return {revision:row?.revision||0,...(row?JSON.parse(row.settings_json):{schedule_enabled:false,timezone:'UTC',periods:['daily','weekly']})};}
  async execute(auth,input){this.require(auth);object(input,['action','operation_id','payload']);const {action,operation_id:operation,payload:p}=input;id(operation);if(!CONSOLE_ACTIONS.includes(action))throw new NotFoundError('Action not found.');
    if(Buffer.byteLength(JSON.stringify(input))>56*1024)throw new ValidationError('Request too large.','CONSOLE_INPUT_TOO_LARGE');
    object(p,Object.keys(p||{}));
    if(action==='models.test')return this.probe(auth,p,operation);
    return this.state.sync(auth,action,p,operation,()=>this.apply(auth,action,p),{secret:['connections.create','connections.rotate'].includes(action)});
  }
  apply(auth,action,p){const store=this.store;
    if(action.startsWith('memory.')&&action!=='memory.create')number(p.revision,1,2147483647);
    if(action==='memory.create'){object(p,['content','memory_type','scope','topic','project_id','task_id','workstream_id','session_id','sensitivity']);
      const {sensitivity='sensitive',...input}=p;this.sensitivity(sensitivity);const result=store.saveMemory(auth,{...input,source:'console_explicit'});
      store.memorySources.setSensitivity(auth,result.memory.memory_id,sensitivity);return receipt(result);}
    if(action==='memory.correct'){object(p,['memory_id','revision','content','memory_type','topic','reason']);this.memory(auth,p.memory_id,p.revision);
      const sensitivity=this.meta(auth,{memory_id:p.memory_id}).sensitivity;const result=store.supersedeMemory(auth,p.memory_id,{content:p.content,memory_type:p.memory_type,topic:p.topic,reason:p.reason||'Explicit console correction.'});
      store.memorySources.setSensitivity(auth,result.replacement_memory.memory_id,sensitivity);return receipt(result);}
    if(action==='memory.retract'){object(p,['memory_id','revision','reason']);this.memory(auth,p.memory_id,p.revision);return receipt(store.retractMemory(auth,p.memory_id,{reason:p.reason||'Explicit console retraction.'}));}
    if(action==='memory.sensitivity'){object(p,['memory_id','revision','sensitivity']);this.memory(auth,p.memory_id,p.revision);this.sensitivity(p.sensitivity);store.memorySources.setSensitivity(auth,p.memory_id,p.sensitivity);return {status:'updated',...this.meta(auth,{memory_id:p.memory_id})};}
    if(action==='memory.classify'){object(p,['memory_id','revision','category']);this.memory(auth,p.memory_id,p.revision);return {status:'classified',...store.derivedMemory.setCategory(auth,p.memory_id,p.category,this.taxonomy())};}
    if(action==='memory.visibility'){object(p,['memory_id','revision','state_hash','allow']);this.memory(auth,p.memory_id,p.revision);return {status:'updated',...store.webVisibility.set(auth,p.memory_id,p)};}
    if(action==='jobs.schedule'){
      object(p,['type','timezone','periods','include_open','schedule_enabled','settings_revision']);
      if(!['classification','summary'].includes(p.type)||typeof p.timezone!=='string'||(p.include_open!==undefined&&typeof p.include_open!=='boolean'))throw new ValidationError('Invalid scheduling request.');
      const organizer=this.models.provider(auth.user_id,'organizer');
      if(!organizer.profile.egress.approved)throw new ConflictError('Model egress must be explicitly approved.','EGRESS_DENIED');
      if(p.schedule_enabled!==undefined){if(typeof p.schedule_enabled!=='boolean')throw new ValidationError('Invalid schedule.');
        const current=this.settings(auth.user_id);if(p.settings_revision!==current.revision)throw new ConflictError('Schedule changed.','SETTINGS_VERSION_CHANGED');
        this.db.prepare('INSERT INTO console_settings VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json,revision=excluded.revision,updated_at=excluded.updated_at')
          .run(auth.user_id,JSON.stringify({schedule_enabled:p.schedule_enabled,timezone:p.timezone,periods:p.periods}),current.revision+1,Date.now());}
      const result=scheduleLibrary(store,store.memoryJobs,{userId:auth.user_id,organizer,taxonomy:this.taxonomy(),type:p.type,timezone:p.timezone,periods:p.periods,includeOpen:p.include_open===true});
      return {status:result.jobs.length?'queued':'no_work',...result,worker_enabled:store.memoryConfig.console?.worker_enabled===true};
    }
    if(action==='jobs.cancel'){object(p,['job_id']);const job=this.job(auth,p.job_id);if(job.state==='succeeded')throw new ConflictError('A completed job cannot be cancelled.','JOB_TERMINAL');store.memoryJobs.cancel(job.job_id);return {status:'cancelled',job_id:job.job_id};}
    if(action==='jobs.retry'){object(p,['job_id']);const job=this.job(auth,p.job_id);
      if(!['dead_letter','blocked_auth','blocked_budget','blocked_config','review_required','retry_wait','cancelled'].includes(job.state))throw new ConflictError('Job is not retryable.','JOB_NOT_RETRYABLE');
      const provider=this.models.provider(auth.user_id,'organizer');if(provider.profile.fingerprint!==job.profile||store.memoryJobs.items(job).some(i=>!store.derivedMemory.validateItem(i)))throw new ConflictError('Inputs/model changed; schedule a new job.','STALE_INPUT');
      this.db.prepare("UPDATE memory_profile_state SET state='ready' WHERE profile=?").run(job.profile);
      this.db.prepare("UPDATE memory_jobs SET state='pending',run_after=?,last_error_code=NULL,fence=fence+1,lease_owner=NULL,lease_expires=NULL,updated_at=? WHERE job_id=? AND user_id=?").run(Date.now(),Date.now(),job.job_id,auth.user_id);return {status:'queued',job_id:job.job_id};}
    if(action==='models.save')return this.models.save(auth,p);
    if(action==='models.disable'){object(p,['kind','expected_revision']);const row=this.models.raw(auth.user_id,p.kind);if(!row||row.revision!==p.expected_revision)throw new ConflictError('Model changed.','MODEL_VERSION_CHANGED');const config=JSON.parse(row.config_json);return this.models.save(auth,{kind:p.kind,expected_revision:row.revision,config:{...config,enabled:false}});}
    if(action==='vector.schedule'){object(p,[]);const index=this.vector(auth.user_id),profile=this.models.provider(auth.user_id,'embedder').profile.fingerprint;
      const prior=this.db.prepare('SELECT * FROM console_vector_requests WHERE user_id=?').get(auth.user_id);if(prior?.state==='pending'&&prior.profile===profile)return {status:'queued',generation:prior.generation};
      if(prior?.state==='pending')this.db.prepare("UPDATE memory_vector_generations SET state='retired',fence=fence+1 WHERE generation=? AND state<>'active'").run(prior.generation);
      const generation=index.begin(profile);this.db.prepare('INSERT OR REPLACE INTO console_vector_requests VALUES(?,?,?,\'pending\',NULL,?)').run(auth.user_id,generation,profile,Date.now());return {status:'queued',generation};}
    if(action==='connections.create'){
      object(p,['label','agent_id','device_id','access']);if(!['read','read_write'].includes(p.access)||typeof p.label!=='string'||!p.label.trim()||p.label.length>120)throw new ValidationError('Invalid connection.');
      for(const name of ['agent_id','device_id'])id(p[name]);if(['mnemuron-console','chatgpt-web','mnemuron'].includes(p.agent_id))throw new ValidationError('Reserved internal agent.');
      const created=store.issueCredential({label:p.label,userId:auth.user_id,deviceId:p.device_id,agentId:p.agent_id,agentInstanceId:randomUUID(),scopes:['memory:read',...(p.access==='read_write'?['memory:write']:[])]});return {status:'created',...created,secret_expires_in_seconds:600};}
    if(action==='connections.rotate'||action==='connections.revoke'){
      object(p,['credential_id']);const row=this.db.prepare('SELECT * FROM credentials WHERE user_id=? AND credential_id=?').get(auth.user_id,id(p.credential_id));if(!row)throw new NotFoundError('Connection not found.');
      const scopes=JSON.parse(row.scopes_json);if(['mnemuron-console','chatgpt-web','mnemuron'].includes(row.agent_id)||scopes.some(s=>!['memory:read','memory:write'].includes(s)))throw new ConflictError('Managed/internal connection; use authorization or operator management.','MANAGED_CONNECTION');
      if(action==='connections.rotate'&&row.expires_at&&Date.parse(row.expires_at)<=Date.now())throw new ConflictError('Connection expired; create a new connection.','CONNECTION_EXPIRED');
      if(action==='connections.rotate'&&row.revoked_at)throw new ConflictError('Connection revoked.','CONNECTION_REVOKED');
      this.db.prepare('UPDATE credentials SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=? AND credential_id=?').run(new Date().toISOString(),auth.user_id,row.credential_id);
      if(action==='connections.revoke')return {status:'revoked',credential_id:row.credential_id};
      const created=store.issueCredential({label:row.label,userId:auth.user_id,deviceId:row.device_id,agentId:row.agent_id,agentInstanceId:row.agent_instance_id,scopes,expiresAt:row.expires_at});return {status:'rotated',...created,secret_expires_in_seconds:600};}
    if(action==='storage.import')return this.import(auth,p);
    throw new NotFoundError('Action not found.');
  }
  sensitivity(value){if(!['public','internal','sensitive','secret'].includes(value))throw new ValidationError('Invalid sensitivity.');}
  export(auth,p){this.require(auth);object(p,['after','highwater','limit']);const after=number(Number(p.after||0),0,Number.MAX_SAFE_INTEGER),limit=number(Number(p.limit||10),1,20);
    const highwater=p.highwater===undefined?this.db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM memories WHERE user_id=?').get(auth.user_id).n:number(Number(p.highwater),0,Number.MAX_SAFE_INTEGER);
    const rows=this.db.prepare('SELECT rowid AS position,* FROM memories WHERE user_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?').all(auth.user_id,after,highwater,limit+1);
    const records=[];let size=0;
    for(const row of rows.slice(0,limit)){
      const revision=this.store.revisions.latest(auth.user_id,row.memory_id);const item={original_id:row.memory_id,revision:revision.revision,content:row.content,memory_type:row.memory_type,status:row.status,topic:row.topic,
        sensitivity:this.meta(auth,{memory_id:row.memory_id}).sensitivity,original_scope:{scope:row.scope,project_id:row.project_id,task_id:row.task_id,workstream_id:row.workstream_id,session_id:row.session_id},created_at:row.created_at};
      const bytes=Buffer.byteLength(JSON.stringify(item));if(bytes>180000)throw new ValidationError('One legacy record exceeds the portable page limit. Use the offline export procedure.','EXPORT_RECORD_TOO_LARGE');
      if(size+bytes>200000)break;records.push(item);size+=bytes;
    }
    const consumed=records.length;return {format:'mnemuron-personal-portable-v1',records,includes_credentials:false,includes_other_accounts:false,scope_policy:'import_as_new_personal_memories',snapshot:'bounded_live_export_not_database_backup',
      next_request:consumed<rows.length?{after:rows[consumed-1]?.position||after,highwater,limit}:null};
  }
  import(auth,p){object(p,['format','records','confirm_personal_scope']);if(p.format!=='mnemuron-personal-portable-v1'||p.confirm_personal_scope!==true||!Array.isArray(p.records)||!p.records.length||p.records.length>20)throw new ValidationError('Invalid portable import.');
    const imported=[],existing=[];
    for(const r of p.records){object(r,['original_id','revision','content','memory_type','status','topic','sensitivity','original_scope','created_at']);id(r.original_id);number(r.revision,1,2147483647);this.sensitivity(r.sensitivity);
      if(!['active','superseded','retracted'].includes(r.status))throw new ValidationError('Invalid imported lifecycle.');
      const hash=fingerprint(r),key=fingerprint([r.original_id,r.revision]);const previous=this.db.prepare('SELECT * FROM console_imports WHERE user_id=? AND source_key=?').get(auth.user_id,key);
      if(previous){if(previous.content_hash!==hash)throw new ConflictError('Imported version has different content.','IMPORT_CONFLICT');existing.push(previous.memory_id);continue;}
      const result=this.store.saveMemory(auth,{content:r.content,memory_type:r.memory_type,topic:r.topic,scope:'user',source:`user_import:${r.original_id}:r${r.revision}`}),memoryId=result.memory.memory_id;
      this.store.memorySources.setSensitivity(auth,memoryId,r.sensitivity);
      if(r.status!=='active')this.store.retractMemory(auth,memoryId,{reason:'Imported non-active record; retained as a tombstone, not reactivated.'});
      this.db.prepare('INSERT INTO console_imports VALUES(?,?,?,?)').run(auth.user_id,key,memoryId,hash);imported.push(memoryId);
    }
    return {status:'imported',created:imported.length,existing:existing.length,memory_ids:imported,originals_overwritten:false,scope:'user'};
  }
  async probe(auth,p,operation){const prior=this.state.existing(auth.user_id,operation,'models.test',p);if(prior)return prior;
    this.store.memoryTransaction(()=>{this.state.existing(auth.user_id,operation,'models.test',p);this.db.prepare("INSERT INTO console_operations VALUES(?,?,?,?,'running',NULL,NULL,?)").run(auth.user_id,operation,'models.test',fingerprint(p),Date.now());});
    try{const result=await this.models.test(auth,p);this.db.prepare("UPDATE console_operations SET state='completed',result_json=? WHERE user_id=? AND operation_id=?").run(JSON.stringify(result),auth.user_id,operation);this.store.audit({auth,action:'console.models.test',targetType:'console_operation',targetId:operation});return {...result,operation_id:operation};}
    catch(error){this.db.prepare("UPDATE console_operations SET state='failed',error_code=? WHERE user_id=? AND operation_id=?").run(/^[A-Z_]{1,80}$/.test(error.code||'')?error.code:'MODEL_TEST_FAILED',auth.user_id,operation);throw error;}
  }
  vector(user){if(!this.store.memoryConfig.vector_store?.enabled)throw new ConflictError('Configure the vector backend before rebuilding.','VECTOR_DISABLED');const embedder=this.models.provider(user,'embedder');return new VectorIndex(this.store,new QdrantStore(this.store.memoryConfig.vector_store),new Map([[embedder.profile.fingerprint,embedder]]),{ownerId:user});}
  async tick(){if(this.busy||this.store.memoryConfig.console?.worker_enabled!==true)return;this.busy=true;
    try{
      const users=this.db.prepare("SELECT user_id FROM console_models WHERE kind='organizer' AND json_extract(config_json,'$.enabled')=1 ORDER BY updated_at").all();
      for(const {user_id:user} of users){try{const organizer=this.models.provider(user,'organizer'),settings=this.settings(user);
        if(settings.schedule_enabled&&(settings.next_scan_at||0)<=Date.now()){
          for(const type of ['classification','summary'])scheduleLibrary(this.store,this.store.memoryJobs,{userId:user,organizer,taxonomy:this.taxonomy(),type,timezone:settings.timezone,periods:settings.periods});
          this.db.prepare("UPDATE console_settings SET settings_json=json_set(settings_json,'$.next_scan_at',?) WHERE user_id=?").run(Date.now()+60000,user);
        }
        await new MemoryWorker(this.store,this.store.memoryJobs,organizer,{workerId:`console-${process.pid}`,userId:user,profileFilter:organizer.profile.fingerprint}).drain({maxJobs:1});
      }catch{/* Persistent job state reports failures; never log source text or keys. */}}
      // Catch up successful personal indices as memories evolve, without reviving a disabled account.
      this.db.prepare(`UPDATE console_vector_requests SET state='pending' WHERE state='succeeded' AND updated_at<?
        AND EXISTS(SELECT 1 FROM console_models m WHERE m.user_id=console_vector_requests.user_id AND m.kind='embedder' AND json_extract(m.config_json,'$.enabled')=1)
        AND EXISTS(SELECT 1 FROM credentials c WHERE c.user_id=console_vector_requests.user_id AND c.agent_id='mnemuron-console' AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>?))`)
        .run(Date.now()-60000,new Date().toISOString());
      for(const row of this.db.prepare("SELECT * FROM console_vector_requests WHERE state='pending' ORDER BY updated_at LIMIT 1").all()){
        try{const index=this.vector(row.user_id),result=await index.sync(row.generation,{maxDocuments:10});if(result.complete){if(this.db.prepare("SELECT state FROM console_vector_requests WHERE user_id=? AND generation=?").get(row.user_id,row.generation)?.state!=='pending')continue;if(this.db.prepare('SELECT state FROM memory_vector_generations WHERE generation=?').get(row.generation)?.state!=='active')index.activate(row.generation);this.db.prepare("UPDATE console_vector_requests SET state='succeeded',error_code=NULL,updated_at=? WHERE user_id=? AND generation=?").run(Date.now(),row.user_id,row.generation);}}
        catch(error){this.db.prepare("UPDATE console_vector_requests SET state='failed',error_code=?,updated_at=? WHERE user_id=? AND generation=?").run(/^[A-Z_]+$/.test(error.code||'')?error.code:'VECTOR_UNAVAILABLE',Date.now(),row.user_id,row.generation);}
      }
    }finally{this.busy=false;}
  }
}

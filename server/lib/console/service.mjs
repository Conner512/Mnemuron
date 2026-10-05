import {randomUUID} from 'node:crypto';
import {ConsoleState,object,id,number,fingerprint} from './state.mjs';
import {ConsoleModels} from './models.mjs';
import {credentialView} from './credentials.mjs';
import {consoleActionWritable,CONSOLE_ACTIONS} from '../../../shared/console-contract.mjs';
import {AuthorizationError,ValidationError,ConflictError,NotFoundError} from '../errors.mjs';
import {MemoryWorker,scheduleLibrary} from '../memory-jobs/worker.mjs';
import {VectorIndex} from '../vector-stores/index.mjs';
import {QdrantStore} from '../vector-stores/qdrant.mjs';
import {ConsoleFeatures,FEATURE_ACTIONS} from './features.mjs';
import {ConsoleOrganizer} from './organize.mjs';
import {ModelError} from '../model-providers/contracts.mjs';
import {AGENT_READ_POLICIES} from '../memory/web-visibility.mjs';
import {memoryPresentation} from '../../../shared/memory-display.mjs';
// Provenance kind for display. The stored source string is never returned or changed here.
const memoryOrigin=(source,imported)=>{const s=String(source||'');
  return s.startsWith('user_import:')?{kind:'imported',original_created_at:imported?.original_created_at||null}:{kind:s==='console_explicit'?'console':s==='model_submitted'?'model_tool':'agent'};};

/** Digest of a frozen first-run manifest: the exact (memory_id, revision, state_hash) set, order-independent. */
export const manifestDigest=items=>fingerprint(items.map(i=>[i.memory_id,i.revision,i.state_hash]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0));
const taxonomyDefault={version:'console-default-v1',categories:['uncategorized','preferences','projects','technical','personal','decisions']};
const receipt=result=>({status:result.status,memory_id:result.replacement_memory?.memory_id||result.memory?.memory_id||result.memory_id,physically_deleted:false});
export class ConsoleService {
  constructor(store){this.store=store;this.db=store.db;this.state=new ConsoleState(store);this.models=new ConsoleModels(store,this.state);this.features=new ConsoleFeatures(this);this.organizer=new ConsoleOrganizer(this);this.busy=false;}
  require(auth,action){if(!consoleActionWritable(auth,action))throw new AuthorizationError('console:write');}
  taxonomy(user){const fallback=this.store.memoryConfig.memory?.taxonomy||taxonomyDefault;return user?this.features.taxonomy(user,fallback):fallback;}
  capabilities(auth){const actions=CONSOLE_ACTIONS.filter(action=>consoleActionWritable(auth,action));return {version:'console-actions-v1',writable:actions.length>0,actions,taxonomy:this.taxonomy(auth.user_id),category_labels:this.features.labels(auth.user_id),
    read_policy:this.readPolicy(auth),secret_storage:!!this.store.memoryConfig.console?.key_file,worker_enabled:this.store.memoryConfig.console?.worker_enabled===true,vector_enabled:this.store.memoryConfig.vector_store?.enabled===true,production_ready:false};}
  /** Read-only: which ChatGPT read policy the operator configured. The console cannot change it. */
  // legacy_read_all is this account's earlier "ChatGPT may read all memories" setting: still in force under the
  // per-memory policy, shown so the console never understates what ChatGPT can read.
  readPolicy(auth){const key=this.store.runtime.agentReadPolicy||'chatgpt_per_memory_v1';
    return {policy:AGENT_READ_POLICIES[key],setting:key,active_records_uniform:key==='active_uniform_v1',legacy_read_all:this.store.webVisibility.policy(auth).read_all,history_and_secret_filtered:true,configured_by:'operator'};}
  memory(auth,memoryId,revision){id(memoryId);const row=this.db.prepare('SELECT * FROM memories WHERE user_id=? AND memory_id=?').get(auth.user_id,memoryId);if(!row)throw new NotFoundError('Memory not found.','MEMORY_NOT_FOUND');
    const current=this.store.revisions.latest(auth.user_id,memoryId);if(revision!==undefined&&number(revision,1,2147483647)!==current.revision)throw new ConflictError('Memory changed; review the current revision.','MEMORY_VERSION_CHANGED');return {row,current};}
  meta(auth,p){object(p,['memory_id']);const {row,current}=this.memory(auth,p.memory_id);
    const sensitivity=this.db.prepare('SELECT sensitivity FROM memory_privacy WHERE user_id=? AND memory_id=?').get(auth.user_id,row.memory_id)?.sensitivity||'sensitive';
    const category=this.store.derivedMemory.category({user_id:auth.user_id,memory_id:row.memory_id,revision:current.revision},this.taxonomy(auth.user_id).version);
    const imported=this.db.prepare('SELECT original_created_at FROM console_import_records WHERE user_id=? AND memory_id=?').get(auth.user_id,row.memory_id);
    return {memory_id:row.memory_id,revision:current.revision,state_hash:current.state_hash,sensitivity,category,...memoryPresentation(row),origin:memoryOrigin(row.source,imported),
      scope:row.scope,topic:row.topic,memory_type:row.memory_type,status:row.status};}
  job(auth,jobId){const job=this.store.memoryJobs.get(id(jobId));if(!job||job.user_id!==auth.user_id)throw new NotFoundError('Job not found.','JOB_NOT_FOUND');return job;}
  settings(user){const row=this.db.prepare('SELECT * FROM console_settings WHERE user_id=?').get(user);return {revision:row?.revision||0,...(row?JSON.parse(row.settings_json):{schedule_enabled:false,timezone:'UTC',periods:['daily','weekly']})};}
  processing(user){
    const models=this.models.list(user),worker=this.store.memoryConfig.console?.worker_enabled===true;
    const blockers=kind=>{const c=models.find(m=>m.kind===kind).config;return [...(!c.enabled?['NOT_CONFIGURED']:[]),...(c.enabled&&!c.egress_approved?['EGRESS_DENIED']:[])];};
    const organizer=[...blockers('organizer'),...(!worker?['WORKER_DISABLED']:[])],vector=[...blockers('embedder'),...(!worker?['WORKER_DISABLED']:[]),...(!this.store.memoryConfig.vector_store?.enabled?['VECTOR_DISABLED']:[])];
    const active=this.db.prepare('SELECT generation,profile FROM memory_vector_owner_active WHERE user_id=?').get(user);
    const request=this.db.prepare('SELECT generation,state,error_code,updated_at FROM console_vector_requests WHERE user_id=?').get(user)||{};
    const embedder=models.find(m=>m.kind==='embedder').config,search=[...blockers('embedder'),...(!this.store.memoryConfig.vector_store?.enabled?['VECTOR_DISABLED']:[]),...(!embedder.query_approved?['QUERY_EGRESS_DENIED']:[])];
    const configured=embedder.enabled?this.models.profile(user,'embedder',embedder).fingerprint:null;
    // A generation built with a retained profile keeps serving after the configuration changes.
    const retained=active&&this.models.retainedServes(user,active.generation);
    if(!active)search.push('VECTOR_NOT_READY');
    else if(embedder.enabled&&configured!==active.profile&&!retained)search.push('VECTOR_PROFILE_MISMATCH');
    const hasDocuments=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_vector_documents'").get();
    const indexed=active&&hasDocuments?this.db.prepare("SELECT COUNT(*) n FROM memory_vector_documents WHERE user_id=? AND generation=? AND state='indexed'").get(user,active.generation).n:0;
    return {classification:{ready:!organizer.length,blockers:organizer},summary:{ready:!organizer.length,blockers:organizer},
      vector:{ready:!vector.length,blockers:vector,state:request.state||'not_started',error_code:request.error_code||null,updated_at:request.updated_at||null,indexed_documents:indexed,search_ready:!search.length,search_blockers:search,
        serving_generation:active?.generation||null,serving_profile_differs:!!active&&!!configured&&configured!==active.profile,first_run:this.firstRun(user,active)},settings:this.settings(user)};
  }
  /** Truthful first-run state: frozen manifest, build progress, budget and whether it is serving. Counts only. */
  firstRun(user,active){
    // The generation tables exist only once an index has been constructed for this database.
    if(!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_vector_generations'").get())return {budget:this.models.budget(user)};
    const g=this.db.prepare(`SELECT g.generation,g.collection_name,g.state,g.dimensions,g.created_at FROM memory_vector_generations g JOIN memory_vector_owners o ON o.generation=g.generation
      WHERE o.user_id=? AND EXISTS(SELECT 1 FROM memory_vector_manifest m WHERE m.generation=g.generation) ORDER BY g.created_at DESC,g.rowid DESC LIMIT 1`).get(user);
    if(!g)return {budget:this.models.budget(user)};
    const items=this.db.prepare('SELECT memory_id,revision,state_hash,state FROM memory_vector_manifest WHERE generation=? ORDER BY memory_id').all(g.generation);
    const counts=Object.fromEntries(['pending','indexed','stale','excluded'].map(s=>[s,items.filter(i=>i.state===s).length]));
    const request=this.db.prepare('SELECT state,error_code FROM console_vector_requests WHERE user_id=? AND generation=?').get(user,g.generation);
    return {generation:g.generation,collection:g.collection_name,dimensions:g.dimensions,state:g.state,serving:active?.generation===g.generation,
      build:request?.state||'prepared',error_code:request?.error_code||null,manifest:{count:items.length,digest:manifestDigest(items),...counts},
      budget:this.models.budget(user),catch_up:false};
  }
  /** The owner's current, active, non-secret records the embedder may receive, as a frozen revision-bound list. */
  manifestCandidates(user,profile){
    const excluded={inactive:0,secret_or_unavailable:0,sensitivity_not_approved:0},items=[];
    for(const row of this.db.prepare('SELECT memory_id,status FROM memories WHERE user_id=? ORDER BY memory_id').all(user)){
      if(row.status!=='active'){excluded.inactive++;continue;}
      const source=this.store.derivedMemory.currentSource(user,row.memory_id);
      if(!source){excluded.secret_or_unavailable++;continue;}
      if(!profile.egress.sensitivities.includes(source.sensitivity)){excluded.sensitivity_not_approved++;continue;}
      items.push({memory_id:source.memory_id,revision:source.revision,state_hash:source.state_hash});
    }
    return {items,excluded};
  }
  async execute(auth,input){object(input,['action','operation_id','payload']);const {action,operation_id:operation,payload:p}=input;this.require(auth,action);id(operation);if(!CONSOLE_ACTIONS.includes(action))throw new NotFoundError('Action not found.');
    if(Buffer.byteLength(JSON.stringify(input))>56*1024)throw new ValidationError('Request too large.','CONSOLE_INPUT_TOO_LARGE');
    object(p,Object.keys(p||{}));
    if(action==='models.test')return this.probe(auth,p,operation);
    return this.state.sync(auth,action,p,operation,()=>this.apply(auth,action,p),{secret:['connections.create','connections.rotate','devices.register','devices.rotate'].includes(action)});
  }
  apply(auth,action,p){const store=this.store;
    if(FEATURE_ACTIONS.includes(action))return this.features.apply(auth,action,p);
    if(action.startsWith('memory.')&&!['memory.create','memory.organize','memory.organize_undo'].includes(action))number(p.revision,1,2147483647);
    if(action==='memory.create'){object(p,['content','memory_type','scope','topic','project_id','task_id','workstream_id','session_id','sensitivity']);
      const defaults=this.features.privacy(auth.user_id),{sensitivity=defaults.sensitivity,...input}=p;this.sensitivity(sensitivity);const result=store.saveMemory(auth,{...input,source:'console_explicit'});
      store.memorySources.setSensitivity(auth,result.memory.memory_id,sensitivity);
      if(defaults.revision>0&&!result.idempotent)store.webVisibility.keepPrivate(auth.user_id,result.memory.memory_id,store.revisions.latest(auth.user_id,result.memory.memory_id));
      return receipt(result);}
    if(action==='memory.correct'){object(p,['memory_id','revision','content','memory_type','topic','reason']);this.memory(auth,p.memory_id,p.revision);
      const sensitivity=this.meta(auth,{memory_id:p.memory_id}).sensitivity;const result=store.supersedeMemory(auth,p.memory_id,{content:p.content,memory_type:p.memory_type,topic:p.topic,reason:p.reason||'Explicit console correction.'});
      store.memorySources.setSensitivity(auth,result.replacement_memory.memory_id,sensitivity);return receipt(result);}
    if(action==='memory.retract'){object(p,['memory_id','revision','reason']);this.memory(auth,p.memory_id,p.revision);return receipt(store.retractMemory(auth,p.memory_id,{reason:p.reason||'Explicit console retraction.'}));}
    if(action==='memory.sensitivity'){object(p,['memory_id','revision','sensitivity']);this.memory(auth,p.memory_id,p.revision);this.sensitivity(p.sensitivity);store.memorySources.setSensitivity(auth,p.memory_id,p.sensitivity);return {status:'updated',...this.meta(auth,{memory_id:p.memory_id})};}
    if(action==='memory.classify'){object(p,['memory_id','revision','category']);this.memory(auth,p.memory_id,p.revision);store.requireScope(auth,'memory:organize');
      const {results:[r],batch}=this.organizer.classify(auth,[{memory_id:p.memory_id,revision:p.revision}],p.category,{kind:'classify'});
      if(!r.ok)throw new ValidationError('This memory cannot be categorized.','INVALID_CATEGORY_TARGET');
      return {status:'classified',locked:true,category:p.category,batch_id:batch.batch_id,changed:batch.changed,undo_available:batch.undo_available};}
    // One organize flow: preview (read view) → memory.organize with the preview token → optional undo.
    if(action==='memory.organize'){store.requireScope(auth,'memory:organize');return this.organizer.organize(auth,p);}
    if(action==='memory.organize_undo'){store.requireScope(auth,'memory:organize');return this.organizer.undo(auth,p);}
    if(action==='category.create'){store.requireScope(auth,'memory:organize');return this.features.categories.create(auth,p);}
    if(action==='category.rename'){store.requireScope(auth,'memory:organize');return this.features.categories.rename(auth,p);}
    if(action==='category.delete'){store.requireScope(auth,'memory:organize');return this.features.categories.remove(auth,p,this.organizer);}
    if(action==='devices.revoke'){object(p,['agent_instance_id']);id(p.agent_instance_id);
      // Same effect as the admin revoke of an agent instance, limited to the owner's own unmanaged keys.
      const rows=this.db.prepare('SELECT * FROM credentials WHERE user_id=? AND agent_instance_id=? AND revoked_at IS NULL').all(auth.user_id,p.agent_instance_id).map(row=>credentialView(row));
      if(!rows.length)throw new NotFoundError('Active agent credential not found.','CREDENTIAL_NOT_FOUND');
      if(rows.some(row=>row.managed))throw new ConflictError('Platform-managed and admin keys are revoked by an operator, not from the console.','MANAGED_CONNECTION');
      const revokedAt=new Date().toISOString(),result=this.db.prepare('UPDATE credentials SET revoked_at=? WHERE user_id=? AND agent_instance_id=? AND revoked_at IS NULL').run(revokedAt,auth.user_id,p.agent_instance_id);
      store.audit({auth,action:'agent_instance.revoke',targetType:'agent_instance',targetId:p.agent_instance_id,metadata:{revoked_credentials:result.changes,source:'console'}});
      return {status:'revoked',agent_instance_id:p.agent_instance_id,revoked_at:revokedAt,revoked_credentials:result.changes};}
    if(action==='jobs.schedule'){
      object(p,['type','timezone','periods','include_open','schedule_enabled','settings_revision']);
      if(!['classification','summary'].includes(p.type)||typeof p.timezone!=='string'||(p.include_open!==undefined&&typeof p.include_open!=='boolean'))throw new ValidationError('Invalid scheduling request.');
      const organizer=this.models.provider(auth.user_id,'organizer');
      if(!organizer.profile.egress.approved)throw new ConflictError('Model egress must be explicitly approved.','EGRESS_DENIED');
      if(p.schedule_enabled!==undefined){if(typeof p.schedule_enabled!=='boolean')throw new ValidationError('Invalid schedule.');
        const current=this.settings(auth.user_id);if(p.settings_revision!==current.revision)throw new ConflictError('Schedule changed.','SETTINGS_VERSION_CHANGED');
        this.db.prepare('INSERT INTO console_settings VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET settings_json=excluded.settings_json,revision=excluded.revision,updated_at=excluded.updated_at')
          .run(auth.user_id,JSON.stringify({schedule_enabled:p.schedule_enabled,timezone:p.timezone,periods:p.periods}),current.revision+1,Date.now());}
      const result=scheduleLibrary(store,store.memoryJobs,{userId:auth.user_id,organizer,taxonomy:this.taxonomy(auth.user_id),type:p.type,timezone:p.timezone,periods:p.periods,includeOpen:p.include_open===true});
      return {status:result.jobs.length?'queued':'no_work',...result,worker_enabled:store.memoryConfig.console?.worker_enabled===true};
    }
    if(action==='jobs.cancel'){object(p,['job_id']);const job=this.job(auth,p.job_id);if(job.state==='succeeded')throw new ConflictError('A completed job cannot be cancelled.','JOB_TERMINAL');store.memoryJobs.cancel(job.job_id);return {status:'cancelled',job_id:job.job_id};}
    if(action==='jobs.retry'){object(p,['job_id']);const job=this.job(auth,p.job_id);
      if(!['dead_letter','blocked_auth','blocked_budget','blocked_config','review_required','retry_wait','cancelled'].includes(job.state)||job.last_error_code==='RESCHEDULED')throw new ConflictError('Job is not retryable.','JOB_NOT_RETRYABLE');
      // A job planned with an outdated category list cannot run as is; retrying it re-plans the same work
      // under the current categories. Existing classifications stay; the stale job is kept as superseded.
      if(job.metadata.taxonomy&&job.metadata.taxonomy.version!==this.taxonomy(auth.user_id).version)return this.reschedule(auth,job);
      const provider=this.models.provider(auth.user_id,'organizer');if(provider.profile.fingerprint!==job.profile||job.metadata.taxonomy?.version!==this.taxonomy(auth.user_id).version||store.memoryJobs.items(job).some(i=>!store.derivedMemory.validateItem(i)))throw new ConflictError('Inputs/model/taxonomy changed; schedule a new job.','STALE_INPUT');
      this.db.prepare("UPDATE memory_profile_state SET state='ready' WHERE profile=?").run(job.profile);
      this.db.prepare("UPDATE memory_jobs SET state='pending',run_after=?,last_error_code=NULL,fence=fence+1,lease_owner=NULL,lease_expires=NULL,updated_at=? WHERE job_id=? AND user_id=?").run(Date.now(),Date.now(),job.job_id,auth.user_id);return {status:'queued',job_id:job.job_id};}
    if(action==='models.save')return this.models.save(auth,p);
    if(action==='models.disable'){object(p,['kind','expected_revision']);const row=this.models.raw(auth.user_id,p.kind);if(!row||row.revision!==p.expected_revision)throw new ConflictError('Model changed.','MODEL_VERSION_CHANGED');const config=JSON.parse(row.config_json);return this.models.save(auth,{kind:p.kind,expected_revision:row.revision,config:{...config,enabled:false}});}
    if(action.startsWith('vector.'))return this.vectorAction(auth,action,p);
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
  /** Personal vector index. First run: prepare (freeze manifest, open the finite budget) → synthetic probe →
   * schedule (count and digest confirmed) → background build → explicit activate; deactivate is the rollback.
   * The ordinary full rebuild stays available only while no first-run budget exists for the account. */
  vectorAction(auth,action,p){
    const user=auth.user_id,owned=generation=>{id(generation);const g=this.db.prepare('SELECT g.* FROM memory_vector_generations g JOIN memory_vector_owners o ON o.generation=g.generation WHERE g.generation=? AND o.user_id=?').get(generation,user);
      if(!g)throw new NotFoundError('Index generation not found.','VECTOR_NOT_FOUND');return g;};
    if(action==='vector.prepare'){
      object(p,['budget_calls']);number(p.budget_calls,1,150);
      const index=this.vector(user),profile=this.models.provider(user,'embedder').profile;
      if(!profile.egress.approved)throw new ConflictError('Model egress must be explicitly approved.','EGRESS_DENIED');
      const budget=this.models.budget(user);
      if(budget&&budget.total!==p.budget_calls)throw new ConflictError('The first-run budget is already set and is never reset or raised here.','BUDGET_ALREADY_SET');
      // An earlier prepared generation that never embedded anything is discarded, freeing its pre-created collection.
      const prior=this.firstRun(user,null);
      if(prior.generation&&prior.state!=='retired'&&prior.state!=='active'){
        // Something was already embedded: the one-time budget belongs to that run. Re-activate it, or a new
        // first run needs a new approval and change.
        if(prior.manifest.indexed||prior.manifest.stale||prior.manifest.excluded||prior.build==='pending')throw new ConflictError('A first run already embedded records; activate it again instead.',prior.state==='building'?'FIRST_RUN_IN_PROGRESS':'FIRST_RUN_EXISTS');
        for(const table of ['memory_vector_manifest','memory_vector_owners','console_vector_profiles','memory_vector_generations'])this.db.prepare(`DELETE FROM ${table} WHERE generation=?`).run(prior.generation);
        this.db.prepare('DELETE FROM console_vector_requests WHERE user_id=? AND generation=?').run(user,prior.generation);
      }
      const {items,excluded}=this.manifestCandidates(user,profile);
      if(!items.length)throw new ConflictError('No active record is approved for embedding.','MANIFEST_EMPTY');
      // The build needs at least one call per record plus the two probe calls; a smaller budget could only strand it.
      const remaining=budget?budget.remaining:p.budget_calls;
      if(items.length+2>remaining)throw new ConflictError('The budget cannot cover the probe and one call per listed record.','MANIFEST_EXCEEDS_BUDGET');
      if(!budget)this.db.prepare('INSERT INTO console_vector_budget VALUES(?,?,0,?)').run(user,p.budget_calls,Date.now());
      const generation=index.begin(profile.fingerprint,{manifest:items});this.models.snapshot(user,generation);
      const g=owned(generation);
      return {status:'prepared',generation,collection:g.collection_name,dimensions:g.dimensions,manifest:{count:items.length,digest:manifestDigest(items),excluded},
        budget:this.models.budget(user),probe_required:!this.probeVerified(user,g.dimensions),catch_up:false};
    }
    if(action==='vector.schedule'){
      if(!Object.keys(p).length){
        if(this.models.budget(user))throw new ConflictError('A first-run budget is open; use the first-run build.','FIRST_RUN_ACTIVE');
        const index=this.vector(user),profile=this.models.provider(user,'embedder').profile.fingerprint;
        const prior=this.db.prepare('SELECT * FROM console_vector_requests WHERE user_id=?').get(user);if(prior?.state==='pending'&&prior.profile===profile)return {status:'queued',generation:prior.generation};
        if(prior?.state==='pending')this.db.prepare("UPDATE memory_vector_generations SET state='retired',fence=fence+1 WHERE generation=? AND state<>'active'").run(prior.generation);
        const generation=index.begin(profile);this.models.snapshot(user,generation);this.db.prepare('INSERT OR REPLACE INTO console_vector_requests VALUES(?,?,?,\'pending\',NULL,?)').run(user,generation,profile,Date.now());return {status:'queued',generation};
      }
      object(p,['generation','expected_count','expected_digest']);const g=owned(p.generation);number(p.expected_count,1,1000000);
      if(typeof p.expected_digest!=='string'||!/^[a-f0-9]{64}$/.test(p.expected_digest))throw new ValidationError('Invalid manifest digest.','INVALID_CONSOLE_INPUT');
      const index=this.vector(user),items=index.manifest(g.generation);
      if(!items.length)throw new ConflictError('Not a first-run generation.','NOT_FIRST_RUN');
      if(items.length!==p.expected_count||manifestDigest(items)!==p.expected_digest)throw new ConflictError('The frozen manifest differs from the reviewed one.','MANIFEST_CHANGED');
      if(this.models.provider(user,'embedder').profile.fingerprint!==g.profile)throw new ConflictError('The embedding model changed since prepare.','VECTOR_PROFILE_MISMATCH');
      if(!this.probeVerified(user,g.dimensions))throw new ConflictError('Run the synthetic embedding probe first; it must return the configured dimensions.','PROBE_REQUIRED');
      if(!this.models.budget(user))throw new ConflictError('Prepare the first run first.','BUDGET_REQUIRED');
      if(!['building'].includes(g.state))throw new ConflictError('This generation is already built.','VECTOR_ALREADY_BUILT');
      this.db.prepare("INSERT OR REPLACE INTO console_vector_requests VALUES(?,?,?,'pending',NULL,?)").run(user,g.generation,g.profile,Date.now());
      return {status:'queued',generation:g.generation,manifest:index.manifestCounts(g.generation),budget:this.models.budget(user),activation:'explicit',catch_up:false};
    }
    if(action==='vector.activate'||action==='vector.deactivate'){
      object(p,['generation']);const g=owned(p.generation),index=this.vector(user);
      if(action==='vector.deactivate'){const result=index.deactivate(g.generation);
        this.db.prepare("UPDATE console_vector_requests SET state='deactivated',updated_at=? WHERE user_id=? AND generation=?").run(Date.now(),user,g.generation);return {status:'deactivated',...result};}
      const snapshot=index.activate(g.generation);
      this.db.prepare("UPDATE console_vector_requests SET state='succeeded',error_code=NULL,updated_at=? WHERE user_id=? AND generation=?").run(Date.now(),user,g.generation);
      return {status:'activated',generation:snapshot.generation,collection:snapshot.collection_name,manifest:index.manifestCounts(g.generation),catch_up:false};
    }
    throw new NotFoundError('Action not found.');
  }
  /** The current embedder revision passed the synthetic probe with exactly these dimensions. */
  probeVerified(user,dimensions){const m=this.models.list(user).find(x=>x.kind==='embedder');return m?.verification?.state==='verified'&&m.verification.dimensions===dimensions&&m.verification.real_memory_sent===false;}
  /** Supersede every retryable job of this type planned under an outdated taxonomy and queue the work again. */
  reschedule(auth,job){
    const store=this.store,user=auth.user_id,taxonomy=this.taxonomy(user),organizer=this.models.provider(user,'organizer');
    if(!organizer.profile.egress.approved)throw new ConflictError('Model egress must be explicitly approved.','EGRESS_DENIED');
    const stale=this.db.prepare("SELECT job_id,metadata_json FROM memory_jobs WHERE user_id=? AND job_type=? AND state IN ('dead_letter','blocked_auth','blocked_budget','blocked_config','review_required','retry_wait','cancelled','pending') AND COALESCE(last_error_code,'')<>'RESCHEDULED' AND json_extract(metadata_json,'$.taxonomy.version')<>?")
      .all(user,job.job_type,taxonomy.version).map(r=>({job_id:r.job_id,window:JSON.parse(r.metadata_json).window}));
    const windows=stale.map(r=>r.window).filter(Boolean),settings=this.settings(user),now=Date.now();
    const periods=[...new Set(windows.map(w=>w.period))],timezone=windows[0]?.timezone||settings.timezone;
    const result=scheduleLibrary(store,store.memoryJobs,{userId:user,organizer,taxonomy,type:job.job_type,timezone,
      periods:periods.length?periods:settings.periods,includeOpen:windows.some(w=>Date.parse(w.end)>now)});
    const superseded=this.db.prepare("UPDATE memory_jobs SET state='cancelled',last_error_code='RESCHEDULED',fence=fence+1,lease_owner=NULL,lease_expires=NULL,updated_at=? WHERE user_id=? AND job_id IN (SELECT value FROM json_each(?))")
      .run(now,user,JSON.stringify(stale.map(r=>r.job_id))).changes;
    store.audit({auth,action:'console.jobs.reschedule',targetType:'memory_job',targetId:job.job_id,metadata:{superseded,queued:result.jobs.length,job_type:job.job_type}});
    return {status:result.jobs.length?'rescheduled':'no_work',job_id:job.job_id,superseded,jobs:result.jobs,job_type:job.job_type,worker_enabled:store.memoryConfig.console?.worker_enabled===true};
  }
  sensitivity(value){if(!['public','internal','sensitive','secret'].includes(value))throw new ValidationError('Invalid sensitivity.');}
  export(auth,p){this.require(auth);object(p,['after','highwater','limit']);const after=number(Number(p.after||0),0,Number.MAX_SAFE_INTEGER),limit=number(Number(p.limit||10),1,20);
    const highwater=p.highwater===undefined?this.db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM memories WHERE user_id=?').get(auth.user_id).n:number(Number(p.highwater),0,Number.MAX_SAFE_INTEGER);
    const rows=this.db.prepare('SELECT rowid AS position,* FROM memories WHERE user_id=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?').all(auth.user_id,after,highwater,limit+1);
    const records=[];let size=0;
    for(const row of rows.slice(0,limit)){
      const revision=this.store.revisions.latest(auth.user_id,row.memory_id);const item={original_id:row.memory_id,revision:revision.revision,content:row.content,memory_type:row.memory_type,status:row.status,topic:row.topic,
        sensitivity:this.meta(auth,{memory_id:row.memory_id}).sensitivity,...(this.store.webVisibility.denied(auth.user_id,row.memory_id)?{cloud_private:true}:{}),
        original_scope:{scope:row.scope,project_id:row.project_id,task_id:row.task_id,workstream_id:row.workstream_id,session_id:row.session_id},created_at:row.created_at};
      const bytes=Buffer.byteLength(JSON.stringify(item));if(bytes>180000)throw new ValidationError('One legacy record exceeds the portable page limit. Use the offline export procedure.','EXPORT_RECORD_TOO_LARGE');
      if(size+bytes>200000)break;records.push(item);size+=bytes;
    }
    const consumed=records.length;return {format:'mnemuron-personal-portable-v1',records,includes_credentials:false,includes_other_accounts:false,scope_policy:'import_as_new_personal_memories',snapshot:'bounded_live_export_not_database_backup',
      next_request:consumed<rows.length?{after:rows[consumed-1]?.position||after,highwater,limit}:null};
  }
  import(auth,p){object(p,['format','records','confirm_personal_scope']);if(p.format!=='mnemuron-personal-portable-v1'||p.confirm_personal_scope!==true||!Array.isArray(p.records)||!p.records.length||p.records.length>20)throw new ValidationError('Invalid portable import.');
    const imported=[],existing=[];
    for(const r of p.records){object(r,['original_id','revision','content','memory_type','status','topic','sensitivity','cloud_private','original_scope','created_at']);id(r.original_id);number(r.revision,1,2147483647);this.sensitivity(r.sensitivity);
      if(r.cloud_private!==undefined&&typeof r.cloud_private!=='boolean')throw new ValidationError('Invalid imported cloud privacy.');
      if(!['active','superseded','retracted'].includes(r.status))throw new ValidationError('Invalid imported lifecycle.');
      const hash=fingerprint(r),key=fingerprint([r.original_id,r.revision]);const previous=this.db.prepare('SELECT * FROM console_imports WHERE user_id=? AND source_key=?').get(auth.user_id,key);
      if(previous){if(previous.content_hash!==hash)throw new ConflictError('Imported version has different content.','IMPORT_CONFLICT');existing.push(previous.memory_id);continue;}
      const result=this.store.saveMemory(auth,{content:r.content,memory_type:r.memory_type,topic:r.topic,scope:'user',source:`user_import:${r.original_id}:r${r.revision}`}),memoryId=result.memory.memory_id;
      this.store.memorySources.setSensitivity(auth,memoryId,r.sensitivity);
      if(r.status!=='active')this.store.retractMemory(auth,memoryId,{reason:'Imported non-active record; retained as a tombstone, not reactivated.'});
      if(r.cloud_private===true)this.store.webVisibility.keepPrivate(auth.user_id,memoryId,this.store.revisions.latest(auth.user_id,memoryId));
      this.db.prepare('INSERT INTO console_imports VALUES(?,?,?,?)').run(auth.user_id,key,memoryId,hash);this.organizer.recordImport(auth.user_id,memoryId,r.created_at);imported.push(memoryId);
    }
    return {status:'imported',created:imported.length,existing:existing.length,memory_ids:imported,originals_overwritten:false,scope:'user'};
  }
  async probe(auth,p,operation){const prior=this.state.existing(auth.user_id,operation,'models.test',p);if(prior)return prior;
    this.store.memoryTransaction(()=>{this.state.existing(auth.user_id,operation,'models.test',p);this.db.prepare("INSERT INTO console_operations VALUES(?,?,?,?,'running',NULL,NULL,?)").run(auth.user_id,operation,'models.test',fingerprint(p),Date.now());});
    try{const result=await this.models.test(auth,p);this.db.prepare("UPDATE console_operations SET state='completed',result_json=? WHERE user_id=? AND operation_id=?").run(JSON.stringify(result),auth.user_id,operation);this.store.audit({auth,action:'console.models.test',targetType:'console_operation',targetId:operation});return {...result,operation_id:operation};}
    catch(error){this.db.prepare("UPDATE console_operations SET state='failed',error_code=? WHERE user_id=? AND operation_id=?").run(/^[A-Z_]{1,80}$/.test(error.code||'')?error.code:'MODEL_TEST_FAILED',auth.user_id,operation);
      if(error instanceof ModelError&&error.statusCode>=500)throw new ConflictError('Model test could not complete.',error.code);throw error;}
  }
  vectorBackend(config){return new QdrantStore(config);}
  vector(user){const config=this.store.memoryConfig.vector_store;if(!config?.enabled)throw new ConflictError('Configure the vector backend before rebuilding.','VECTOR_DISABLED');
    // Every retained generation profile can keep serving; the current configuration wins for its own fingerprint.
    const embedders=new Map(this.models.snapshotProviders(user).map(e=>[e.profile.fingerprint,e]));
    let current=null;try{current=this.models.provider(user,'embedder');}catch(error){if(!embedders.size)throw error;}
    if(current)embedders.set(current.profile.fingerprint,current);
    return new VectorIndex(this.store,this.vectorBackend(config),embedders,{ownerId:user,prefix:config.collection_prefix,budget:purpose=>this.models.budgetReserve(user,purpose)});}
  async tick(){if(this.busy||this.store.memoryConfig.console?.worker_enabled!==true)return;this.busy=true;
    try{
      const users=this.db.prepare("SELECT user_id FROM console_models WHERE kind='organizer' AND json_extract(config_json,'$.enabled')=1 ORDER BY updated_at").all();
      for(const {user_id:user} of users){try{const organizer=this.models.provider(user,'organizer'),settings=this.settings(user);
        if(settings.schedule_enabled&&(settings.next_scan_at||0)<=Date.now()){
          for(const type of ['classification','summary'])scheduleLibrary(this.store,this.store.memoryJobs,{userId:user,organizer,taxonomy:this.taxonomy(user),type,timezone:settings.timezone,periods:settings.periods});
          this.db.prepare("UPDATE console_settings SET settings_json=json_set(settings_json,'$.next_scan_at',?) WHERE user_id=?").run(Date.now()+60000,user);
        }
        await new MemoryWorker(this.store,this.store.memoryJobs,organizer,{workerId:`console-${process.pid}`,userId:user,profileFilter:organizer.profile.fingerprint}).drain({maxJobs:1});
      }catch{/* Persistent job state reports failures; never log source text or keys. */}}
      // Catch up successful personal indices as memories evolve, without reviving a disabled account.
      // Never for an account in first-run mode: its index covers only the frozen manifest until a separate approval.
      this.db.prepare(`UPDATE console_vector_requests SET state='pending' WHERE state='succeeded' AND updated_at<?
        AND NOT EXISTS(SELECT 1 FROM console_vector_budget b WHERE b.user_id=console_vector_requests.user_id)
        AND NOT EXISTS(SELECT 1 FROM memory_vector_manifest x WHERE x.generation=console_vector_requests.generation)
        AND EXISTS(SELECT 1 FROM console_models m WHERE m.user_id=console_vector_requests.user_id AND m.kind='embedder' AND json_extract(m.config_json,'$.enabled')=1)
        AND EXISTS(SELECT 1 FROM credentials c WHERE c.user_id=console_vector_requests.user_id AND c.agent_id='mnemuron-console' AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at>?))`)
        .run(Date.now()-60000,new Date().toISOString());
      for(const row of this.db.prepare("SELECT * FROM console_vector_requests WHERE state='pending' ORDER BY updated_at LIMIT 1").all()){
        try{const index=this.vector(row.user_id),result=await index.sync(row.generation,{maxDocuments:10});if(result.complete){if(this.db.prepare("SELECT state FROM console_vector_requests WHERE user_id=? AND generation=?").get(row.user_id,row.generation)?.state!=='pending')continue;
          // A first-run build waits for an explicit vector.activate; it is never switched on automatically.
          if(result.manifest){this.db.prepare("UPDATE console_vector_requests SET state='built',error_code=NULL,updated_at=? WHERE user_id=? AND generation=?").run(Date.now(),row.user_id,row.generation);continue;}
          if(this.db.prepare('SELECT state FROM memory_vector_generations WHERE generation=?').get(row.generation)?.state!=='active')index.activate(row.generation);this.db.prepare("UPDATE console_vector_requests SET state='succeeded',error_code=NULL,updated_at=? WHERE user_id=? AND generation=?").run(Date.now(),row.user_id,row.generation);}}
        catch(error){this.db.prepare("UPDATE console_vector_requests SET state='failed',error_code=?,updated_at=? WHERE user_id=? AND generation=?").run(/^[A-Z_]+$/.test(error.code||'')?error.code:'VECTOR_UNAVAILABLE',Date.now(),row.user_id,row.generation);}
      }
    }finally{this.busy=false;}
  }
}

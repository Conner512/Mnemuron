import {AuthorizationError,ValidationError,ConflictError,NotFoundError} from '../errors.mjs';
import {consoleMemoryWritable,exactScopes} from '../../../shared/console-contract.mjs';
import {CLOUD_CORE_SCOPES} from '../../../shared/cloud-contract.mjs';
import {CORE_SCOPES} from '../../../shared/oauth-common.mjs';
import {fingerprint,object,id,number} from '../console/state.mjs';

// Only the gateway's server-verified, per-owner Web credential may reach these operations.
export class CloudMemoryService {
  constructor(store){this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_cloud_operations(user_id TEXT NOT NULL,connection_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(user_id,connection_id,operation_id));`);
  }
  enable(auth,p) {
    if(!consoleMemoryWritable(auth))throw new AuthorizationError('memory:write');object(p,['credential_id']);id(p.credential_id);
    return this.store.memoryTransaction(()=>{
      const row=this.db.prepare('SELECT * FROM credentials WHERE user_id=? AND credential_id=?').get(auth.user_id,p.credential_id);
      if(!row||row.agent_id!=='chatgpt-web'||row.revoked_at||(row.expires_at&&Date.parse(row.expires_at)<=Date.now())||![CORE_SCOPES,CLOUD_CORE_SCOPES].some(s=>exactScopes(JSON.parse(row.scopes_json),s)))throw new NotFoundError('Eligible account Web binding not found.','CLOUD_WRITE_BINDING_REQUIRED');
      this.db.prepare('UPDATE credentials SET scopes_json=? WHERE user_id=? AND credential_id=?').run(JSON.stringify(CLOUD_CORE_SCOPES),auth.user_id,p.credential_id);
      this.store.audit({auth,action:'connection.cloud_write.enable',targetType:'credential',targetId:p.credential_id});
      return {enabled:true,credential_id:p.credential_id,oauth_grants_changed:false};
    });
  }
  require(auth){if(auth.agent_id!=='chatgpt-web'||!exactScopes(auth.scopes,CLOUD_CORE_SCOPES))throw new AuthorizationError('memory:write');}
  current(auth,result){const row=this.db.prepare('SELECT status FROM memories WHERE user_id=? AND memory_id=?').get(auth.user_id,result.memory_id);
    return {...result,current_status:row?.status||'unavailable',web_readable:!!row&&row.status==='active'&&this.store.webVisibility.visible(auth,result.memory_id)};}
  execute(auth,input) {
    this.require(auth);object(input,['action','connection_id','operation_id','payload']);const {action,connection_id,operation_id,payload:p}=input;
    id(connection_id);id(operation_id);if(!['save','supersede','retract'].includes(action))throw new ValidationError('Invalid cloud action.','INVALID_TOOL_ARGUMENTS');
    object(p,action==='save'?['content','scope','project_id','task_id','workstream_id','session_id','memory_type','topic','allow_future_read']:
      action==='supersede'?['memory_id','revision','content','memory_type','topic','reason','allow_future_read']:['memory_id','revision','reason']);
    if(action!=='retract'&&typeof p.allow_future_read!=='boolean')throw new ValidationError('Explicit future-read choice required.','INVALID_TOOL_ARGUMENTS');
    if(Buffer.byteLength(JSON.stringify(input))>32*1024)throw new ValidationError('Cloud write is too large.','INVALID_TOOL_ARGUMENTS');
    const hash=fingerprint({action,p});
    return this.store.memoryTransaction(()=>{
      const prior=this.db.prepare('SELECT * FROM memory_cloud_operations WHERE user_id=? AND connection_id=? AND operation_id=?').get(auth.user_id,connection_id,operation_id);
      if(prior){if(prior.request_hash!==hash)throw new ConflictError('Operation ID already used for another request.','IDEMPOTENCY_CONFLICT');return {...this.current(auth,JSON.parse(prior.result_json)),replayed:true};}
      let old;
      if(action!=='save') {
        id(p.memory_id);number(p.revision,1,2147483647);
        if(!this.store.webVisibility.visible(auth,p.memory_id))throw new NotFoundError('Memory not found.','MEMORY_NOT_FOUND');
        old=this.db.prepare('SELECT * FROM memories WHERE user_id=? AND memory_id=?').get(auth.user_id,p.memory_id);
        if(this.store.revisions.latest(auth.user_id,p.memory_id)?.revision!==p.revision)throw new ConflictError('Review the current revision first.','MEMORY_VERSION_CHANGED');
        if(old.status!=='active')throw new ConflictError('Memory is no longer active.','MEMORY_VERSION_CHANGED');
      }
      let memoryId,status;
      if(action==='save') {
        const {allow_future_read,...body}=p;
        const r=this.store.saveMemory(auth,{...body,source:'cloud_mcp_explicit_request'});memoryId=r.memory.memory_id;status='saved';
      } else if(action==='supersede'){
        const r=this.store.supersedeMemory(auth,p.memory_id,{content:p.content,memory_type:p.memory_type,topic:p.topic,reason:p.reason||'Explicit cloud memory correction.'});memoryId=r.replacement_memory.memory_id;status='superseded';
      }else {this.store.retractMemory(auth,p.memory_id,{reason:p.reason||'Explicit cloud memory retraction.'});memoryId=p.memory_id;status='retracted';}
      if(action!=='retract') {
        // New tool-submitted material is not an independently recorded transcript or verified fact.
        this.db.prepare("UPDATE memories SET generation_method='cloud-explicit-request-v1',confidence=0.75,confidence_label='medium',warnings_json=? WHERE user_id=? AND memory_id=?")
          .run(JSON.stringify(['Tool-submitted explicit memory; not independently fact checked.']),auth.user_id,memoryId);
        const row=this.db.prepare('SELECT * FROM memories WHERE user_id=? AND memory_id=?').get(auth.user_id,memoryId);
        this.store.revisions.record(row,'cloud_request');
        // Never lower sensitivity, and never grant existing unseen records through this endpoint.
        const sensitivity=old?this.db.prepare('SELECT sensitivity FROM memory_privacy WHERE user_id=? AND memory_id=?').get(auth.user_id,old.memory_id)?.sensitivity||'sensitive':'sensitive';
        const privacy=sensitivity==='public'?'sensitive':sensitivity;
        this.db.prepare('INSERT OR REPLACE INTO memory_privacy VALUES(?,?,?)').run(auth.user_id,memoryId,privacy);
        if(p.allow_future_read){const r=this.store.revisions.latest(auth.user_id,memoryId);
          this.db.prepare('INSERT OR REPLACE INTO memory_web_grants VALUES(?,?,?,?,?)').run(auth.user_id,memoryId,r.revision,r.state_hash,privacy);}
      }
      const result={read_only:false,status,memory_id:memoryId,revision:this.store.revisions.latest(auth.user_id,memoryId).revision,
        operation_id,physically_deleted:false,canonical_task_state_overwritten:false,evidence_kind:'tool_submitted',independently_fact_checked:false};
      this.db.prepare('INSERT INTO memory_cloud_operations VALUES(?,?,?,?,?,?)').run(auth.user_id,connection_id,operation_id,hash,JSON.stringify(result),new Date().toISOString());
      this.store.audit({auth,action:`memory.cloud.${action}`,targetType:'memory',targetId:memoryId,metadata:{connection_id,operation_id}});
      return {...this.current(auth,result),replayed:false};
    });
  }
}

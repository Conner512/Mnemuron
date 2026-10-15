import {createHash} from 'node:crypto';
import {AuthorizationError,ConflictError,NotFoundError,ValidationError} from '../errors.mjs';
import {memoryContent,memoryType,memoryTopic,memoryOperationId} from '../memory-validation.mjs';
import {isWebReader} from './web-visibility.mjs';
import {protectGroup} from '../lifecycle/protection.mjs';

export const CLOUD_CORE_SCOPES=Object.freeze(['memory:read','resume:read','memory:write']);
const sameScopes=(a,b)=>Array.isArray(a)&&a.length===b.length&&new Set(a).size===a.length&&b.every(s=>a.includes(s));
const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const strict=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new ValidationError('Invalid cloud operation.','INVALID_CLOUD_OPERATION');};
const missing=()=>new NotFoundError('Memory not found.','MEMORY_NOT_FOUND');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;

export class CloudMemory {
  constructor(store){
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS cloud_memory_bindings (
      credential_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,connection_id TEXT NOT NULL,account_id TEXT NOT NULL,
      security_version INTEGER NOT NULL,allow_submitted_revision_grant INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS cloud_memory_operations (
      user_id TEXT NOT NULL,connection_id TEXT NOT NULL,action TEXT NOT NULL,operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,receipt_json TEXT NOT NULL,credential_id TEXT NOT NULL,created_at TEXT NOT NULL,
      PRIMARY KEY(user_id,connection_id,action,operation_id),UNIQUE(user_id,connection_id,operation_id));`);
    protectGroup(this.db,'cloud');
    this.store.webVisibility.migrateCloudPrivateChoices();
  }
  // Local provisioning only: this function is never exposed as an HTTP route.
  bind(auth,input){
    strict(input,['connection_id','account_id','security_version','allow_submitted_revision_grant']);
    if(!isWebReader(auth)||!sameScopes(auth.scopes,CLOUD_CORE_SCOPES)||!/^[a-f0-9]{64}$/.test(input.connection_id)||!identifier(input.account_id)
      ||!Number.isSafeInteger(input.security_version)||input.security_version<1||typeof input.allow_submitted_revision_grant!=='boolean')throw new ValidationError('Invalid cloud binding.');
    const values=[auth.credential_id,auth.user_id,input.connection_id,input.account_id,input.security_version,Number(input.allow_submitted_revision_grant),1];
    const old=this.db.prepare('SELECT * FROM cloud_memory_bindings WHERE credential_id=?').get(auth.credential_id);
    if(old){if(JSON.stringify(Object.values(old))!==JSON.stringify(values))throw new ConflictError('Cloud binding differs.','CLOUD_BINDING_CONFLICT');return;}
    this.db.prepare('INSERT INTO cloud_memory_bindings VALUES(?,?,?,?,?,?,?)').run(...values);
  }
  binding(auth){return this.db.prepare('SELECT * FROM cloud_memory_bindings WHERE credential_id=? AND user_id=? AND enabled=1').get(auth.credential_id,auth.user_id);}
  authorize(auth,connection){
    if(!isWebReader(auth)||!sameScopes(auth.scopes,CLOUD_CORE_SCOPES))throw new AuthorizationError('memory:write');
    const b=this.binding(auth);
    if(!b||b.connection_id!==connection)throw new AuthorizationError('cloud-bound connection');
    if(this.store.runtime.cloudMemory!==true)throw new ConflictError('Cloud writes disabled.','CLOUD_MEMORY_DISABLED');
    return b;
  }
  get(auth,connection,operation){
    this.authorize(auth,connection);memoryOperationId({operation_id:operation});
    const row=this.db.prepare('SELECT receipt_json FROM cloud_memory_operations WHERE user_id=? AND connection_id=? AND operation_id=?').get(auth.user_id,connection,operation);
    if(!row)throw new NotFoundError('Operation not found.','OPERATION_NOT_FOUND');return JSON.parse(row.receipt_json);
  }
  execute(auth,input){
    strict(input,['connection_id','action','operation_id','payload']);
    const binding=this.authorize(auth,input.connection_id),{action,operation_id,payload}=input;
    if(!['memory.save','memory.supersede','memory.retract'].includes(action)||!operation_id)throw new ValidationError('Invalid cloud operation.','INVALID_CLOUD_OPERATION');
    memoryOperationId({operation_id});
    const saving=action==='memory.save',writing=action!=='memory.retract';
    strict(payload,saving?['content','scope','memory_type','topic','project_id','task_id','workstream_id','session_id','cloud_read']:
      writing?['memory_id','expected_revision','content','memory_type','topic','reason','cloud_read']:['memory_id','expected_revision','reason']);
    if(writing){memoryContent(payload.content);if(payload.memory_type!==undefined)memoryType(payload.memory_type);if(payload.topic!==undefined)memoryTopic(payload.topic);
      if(!['keep_private','allow_submitted_revision'].includes(payload.cloud_read))throw new ValidationError('Explicit cloud_read choice required.','INVALID_CLOUD_OPERATION');}
    if(!saving&&(!identifier(payload.memory_id)||!Number.isSafeInteger(payload.expected_revision)||payload.expected_revision<1
      ||typeof payload.reason!=='string'||!payload.reason.trim()||payload.reason.length>1000))throw new ValidationError('Exact version and reason required.','INVALID_CLOUD_OPERATION');
    const grant=writing&&payload.cloud_read==='allow_submitted_revision';
    if(grant&&(!this.store.runtime.cloudSubmittedGrant||!binding.allow_submitted_revision_grant))throw Object.assign(new AuthorizationError('cloud submitted revision policy'),{errorCode:'CLOUD_READ_POLICY_DENIED'});
    const hash=createHash('sha256').update(JSON.stringify(canonical({action,payload}))).digest('hex');
    return this.store.memoryTransaction(()=>{
      this.store.webVisibility.migrateCloudPrivateChoices({markEmpty:true});
      const old=this.db.prepare('SELECT * FROM cloud_memory_operations WHERE user_id=? AND connection_id=? AND operation_id=?').get(auth.user_id,binding.connection_id,operation_id);
      if(old){if(old.action!==action||old.request_hash!==hash)throw new ConflictError('Operation ID has different parameters.','IDEMPOTENCY_CONFLICT');return JSON.parse(old.receipt_json);}
      let prior;
      if(!saving){
        prior=this.db.prepare('SELECT * FROM memories WHERE user_id=? AND memory_id=?').get(auth.user_id,payload.memory_id);
        if(!prior||!this.store.webVisibility.visible(auth,payload.memory_id))throw missing();
        if(this.store.revisions.latest(auth.user_id,payload.memory_id)?.revision!==payload.expected_revision)throw new ConflictError('Memory changed.','MEMORY_VERSION_CHANGED');
        if(prior.status!=='active')throw new ConflictError('Memory is no longer active.','MEMORY_VERSION_CHANGED');
      }
      const {cloud_read,expected_revision,...args}=payload;
      let result;
      if(saving)result=this.store.saveMemory(auth,{...args,source:'model_submitted'},{evidenceKind:'model_submitted'}).memory;
      else if(writing)result=this.store.supersedeMemory(auth,payload.memory_id,args,{evidenceKind:'model_submitted'}).replacement_memory;
      else result=this.store.retractMemory(auth,payload.memory_id,args).memory;
      const id=result.memory_id,revision=this.store.revisions.latest(auth.user_id,id);
      if(writing){
        const sensitivity=prior?this.db.prepare('SELECT sensitivity FROM memory_privacy WHERE user_id=? AND memory_id=?').get(auth.user_id,prior.memory_id)?.sensitivity||'sensitive':'sensitive';
        // A remote correction never inherits a public classification implicitly.
        this.db.prepare('INSERT OR REPLACE INTO memory_privacy VALUES(?,?,?)').run(auth.user_id,id,sensitivity==='public'?'sensitive':sensitivity);
        if(grant){
          if(!['internal','sensitive','public'].includes(sensitivity))throw new ValidationError('This revision cannot be shared.','CLOUD_READ_POLICY_DENIED');
          this.db.prepare('INSERT INTO memory_web_grants VALUES(?,?,?,?,?)').run(auth.user_id,id,revision.revision,revision.state_hash,sensitivity==='public'?'sensitive':sensitivity);
        }else this.store.webVisibility.keepPrivate(auth.user_id,id,revision);
      }
      const receipt={schema_version:'cloud-memory-operation-v1',status:'committed',saved:true,action,operation_id,
        memory_id:id,revision:revision.revision,memory_status:result.status,...(prior?{previous_memory_id:prior.memory_id}:{}),
        cloud_readable:this.store.webVisibility.visible(auth,id),cloud_read_choice:writing?cloud_read:null,
        capture_mode:'tool_only',evidence_kind:'model_submitted',physically_deleted:false,committed_at:new Date().toISOString(),receipt_semantics:'commit_snapshot'};
      // Fixed metadata-only receipts are bounded before COMMIT, not trimmed after a write.
      if(Buffer.byteLength(JSON.stringify(receipt))>2048)throw new ValidationError('Receipt limit.','OPERATION_RESULT_TOO_LARGE');
      this.db.prepare('INSERT INTO cloud_memory_operations VALUES(?,?,?,?,?,?,?,?)').run(auth.user_id,binding.connection_id,action,operation_id,hash,JSON.stringify(receipt),auth.credential_id,receipt.committed_at);
      this.store.audit({auth,action:'cloud.'+action,targetType:'memory',targetId:id,metadata:{operation_id,connection_id:binding.connection_id,account_id:binding.account_id,revision:revision.revision,capture_mode:'tool_only',evidence_kind:'model_submitted'}});
      return receipt;
    });
  }
}

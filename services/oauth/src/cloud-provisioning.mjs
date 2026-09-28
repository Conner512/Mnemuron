import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {requireConfig,randomSecret,secretHash,seconds,MEMORY_WRITE_CORE_SCOPES} from '../../../shared/oauth-common.mjs';
import {applyIdentityBindings} from './provisioning.mjs';

const connection=(ids,config,a)=>secretHash(JSON.stringify([ids.issuer,config.chatgpt_client.client_id,a.subject]));
export function queueCloudBinding(ids,config,accountId,{allowSubmittedRevisionGrant}={}){
  requireConfig(config.cloud_memory?.enabled===true&&typeof allowSubmittedRevisionGrant==='boolean','explicit cloud policy');
  requireConfig(!allowSubmittedRevisionGrant||config.cloud_memory.allow_submitted_revision_grant===true,'submitted revision policy');
  const a=ids.byId(accountId);requireConfig(a&&ids.eligible(a.subject),'active MFA-bound account');
  const request={client_id:config.chatgpt_client.client_id,connection_id:connection(ids,config,a),allow_submitted_revision_grant:allowSubmittedRevisionGrant};
  const kind=`cloud-write:${a.security_version}:${request.connection_id}`;
  return ids.store.transaction(()=>{
    const old=ids.db.prepare('SELECT * FROM identity_operations WHERE account_id=? AND kind=?').get(accountId,kind);
    if(old){
      const payload=ids.unseal(old.payload_cipher,accountId,'cloud-provision');
      requireConfig(JSON.stringify(payload.request)===JSON.stringify(request),'existing cloud operation policy differs');
      return {operation_id:old.operation_id,status:old.state};
    }
    const operation_id=randomUUID();ids.db.prepare('INSERT INTO identity_operations VALUES(?,?,?,?,?,?,?)')
      .run(operation_id,accountId,kind,'pending',ids.seal({request},accountId,'cloud-provision'),null,seconds());
    ids.audit(accountId,'cloud.binding.requested');return {operation_id,status:'pending'};
  });
}
export function prepareCloudBinding(ids,config,op,directory){
  const a=ids.byId(op.account_id);
  if(!a||!ids.eligible(a.subject)||!op.kind.startsWith(`cloud-write:${a.security_version}:`)){
    ids.db.prepare("UPDATE identity_operations SET state='superseded' WHERE operation_id=?").run(op.operation_id);return null;
  }
  requireConfig(config.cloud_memory?.enabled===true,'cloud provisioning enabled');
  return ids.store.transaction(()=>{
    const row=ids.db.prepare('SELECT * FROM identity_operations WHERE operation_id=?').get(op.operation_id);
    const data=ids.unseal(row.payload_cipher,a.account_id,'cloud-provision'),r=data.request;
    requireConfig(r.client_id===config.chatgpt_client.client_id&&r.connection_id===connection(ids,config,a)
      &&(!r.allow_submitted_revision_grant||config.cloud_memory.allow_submitted_revision_grant),'current cloud policy');
    if(data.work)return data.work;
    const work={kind:'cloud',operation_id:op.operation_id,account:{account_id:a.account_id,user_id:a.user_id,subject:a.subject,security_version:a.security_version},
      binding:{purpose:'cloud',credential_id:randomUUID(),api_key:`mnm_${randomSecret()}`,user_id:a.user_id,
        agent_id:'chatgpt-web',agent_instance_id:`cloud-${a.account_id}`,scopes:[...MEMORY_WRITE_CORE_SCOPES],
        connection_id:r.connection_id,account_id:a.account_id,security_version:a.security_version,allow_submitted_revision_grant:r.allow_submitted_revision_grant,
        credential_file:path.join(directory,`${a.account_id}-cloud-${r.connection_id}-v${a.security_version}.key`)}};
    ids.db.prepare("UPDATE identity_operations SET state='prepared',payload_cipher=? WHERE operation_id=?")
      .run(ids.seal({...data,work},a.account_id,'cloud-provision'),op.operation_id);return work;
  });
}
export function cloudWorkCurrent(ids,config,work){
  const a=ids.byId(work.account.account_id),op=ids.db.prepare('SELECT * FROM identity_operations WHERE operation_id=? AND account_id=?').get(work.operation_id,work.account.account_id);
  return !!a&&ids.eligible(a.subject)&&a.security_version===work.account.security_version&&config.cloud_memory?.enabled===true
    &&(!work.binding.allow_submitted_revision_grant||config.cloud_memory.allow_submitted_revision_grant===true)
    &&work.binding.connection_id===connection(ids,config,a)&&!!op?.payload_cipher
    &&JSON.stringify(ids.unseal(op.payload_cipher,a.account_id,'cloud-provision').work)===JSON.stringify(work);
}
export function finishCloudBinding(ids,config,work){
  ids.store.transaction(()=>{
    requireConfig(cloudWorkCurrent(ids,config,work),'current cloud work');
    const {api_key,scopes,purpose,user_id,agent_id,...binding}=work.binding;
    ids.db.prepare('INSERT OR REPLACE INTO identity_cloud_bindings VALUES(?,?,?,?,?)')
      .run(work.account.account_id,binding.connection_id,binding.security_version,JSON.stringify(binding),1);
    ids.db.prepare("UPDATE identity_operations SET state='completed',last_error=NULL WHERE operation_id=?").run(work.operation_id);
    ids.audit(work.account.account_id,'cloud.binding.ready');
  });
}
export function applyCloudBinding(core,work){
  core.memoryTransaction(()=>{
    applyIdentityBindings(core,work.account,[work.binding]);
    const {connection_id,account_id,security_version,allow_submitted_revision_grant}=work.binding;
    core.cloudMemory.bind(core.authenticate(work.binding.api_key),{connection_id,account_id,security_version,allow_submitted_revision_grant});
  });
}

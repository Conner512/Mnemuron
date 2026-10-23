import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {randomSecret,requireConfig,CORE_SCOPES,MEMORY_WRITE_CORE_SCOPES} from '../../../shared/oauth-common.mjs';
import {applyIdentityBindings} from './provisioning.mjs';

export function prepareConnectionBinding(ids,op,directory){return ids.store.transaction(()=>{
 const row=ids.db.prepare('SELECT * FROM identity_operations WHERE operation_id=?').get(op.operation_id);
 const r=ids.db.prepare('SELECT * FROM identity_connections WHERE account_id=? AND ?=?||connection_id||\':\'||version').get(op.account_id,op.kind,'connection-bind:');
 const a=ids.byId(op.account_id);
 if(!r||!ids.eligible(a?.subject)||['disabled','revoked'].includes(r.state)||!ids.connections.enabled()){
   ids.db.prepare("UPDATE identity_operations SET state='superseded' WHERE operation_id=?").run(op.operation_id);return null;
 }
 if(row.payload_cipher){
   const prepared=ids.unseal(row.payload_cipher,a.account_id,'connection-provision');
   if(prepared.account.security_version!==a.security_version){
     ids.db.prepare("UPDATE identity_operations SET state='superseded' WHERE operation_id=?").run(op.operation_id);
     ids.db.prepare('UPDATE identity_connection_credentials SET revoked=1 WHERE credential_id=?').run(prepared.binding.credential_id);return null;
   }
   return prepared;
 }
 const work={kind:'connection',operation_id:op.operation_id,account:{account_id:a.account_id,user_id:a.user_id,subject:a.subject,security_version:a.security_version},
   binding:{purpose:'connection',credential_id:randomUUID(),api_key:`mnm_${randomSecret()}`,user_id:a.user_id,agent_id:'chatgpt-web',agent_instance_id:`connection-${r.connection_id}`,
     scopes:r.profile==='memory_readwrite'?[...MEMORY_WRITE_CORE_SCOPES]:[...CORE_SCOPES],connection_id:r.connection_id,account_id:a.account_id,security_version:a.security_version,
     profile:r.profile,client_id:r.client_id,connection_version:r.version,allow_submitted_revision_grant:!!r.allow_submitted_revision_grant,
     credential_file:path.join(directory,`${a.account_id}-connection-${r.connection_id}-v${r.version}-s${a.security_version}.key`)}};
 ids.db.prepare("UPDATE identity_operations SET state='prepared',payload_cipher=? WHERE operation_id=?").run(ids.seal(work,a.account_id,'connection-provision'),op.operation_id);
 ids.db.prepare('INSERT INTO identity_connection_credentials VALUES(?,?,?,?,?,0)').run(work.binding.credential_id,a.account_id,r.connection_id,r.version,a.security_version);
 return work;
});}
export function connectionWorkCurrent(ids,work){
 const a=ids.byId(work.account.account_id),r=ids.db.prepare('SELECT * FROM identity_connections WHERE account_id=? AND connection_id=?').get(work.account.account_id,work.binding.connection_id);
 const op=ids.db.prepare('SELECT * FROM identity_operations WHERE account_id=? AND operation_id=?').get(work.account.account_id,work.operation_id);
 return !!a&&ids.eligible(a.subject)&&a.security_version===work.account.security_version&&!!r&&r.version===work.binding.connection_version&&!['disabled','revoked'].includes(r.state)&&ids.connections.enabled()
   &&!!op?.payload_cipher&&JSON.stringify(ids.unseal(op.payload_cipher,a.account_id,'connection-provision'))===JSON.stringify(work);
}
export function finishConnectionBinding(ids,work){ids.store.transaction(()=>{
 requireConfig(connectionWorkCurrent(ids,work),'current connection work');
 if(ids.db.prepare('SELECT state FROM identity_operations WHERE operation_id=?').get(work.operation_id).state==='completed')return;
 const {api_key,scopes,purpose,user_id,agent_id,...binding}=work.binding;
 ids.db.prepare('UPDATE identity_connections SET binding_json=?,binding_version=?,binding_account_version=? WHERE account_id=? AND connection_id=?').run(JSON.stringify(binding),binding.connection_version,binding.security_version,binding.account_id,binding.connection_id);
 ids.db.prepare("UPDATE identity_operations SET state='completed',last_error=NULL WHERE operation_id=?").run(work.operation_id);
 ids.connections.activity(ids.connections.row(binding.account_id,binding.connection_id),'connection.binding_ready');
});}
export function applyConnectionBinding(core,work){core.memoryTransaction(()=>{
 applyIdentityBindings(core,work.account,[work.binding]);
 if(work.binding.profile==='memory_readwrite'){
   const {connection_id,account_id,security_version,allow_submitted_revision_grant}=work.binding;
   core.cloudMemory.bind(core.authenticate(work.binding.api_key),{connection_id,account_id,security_version,allow_submitted_revision_grant});
 }
});}

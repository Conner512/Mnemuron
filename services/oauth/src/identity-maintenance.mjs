import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {MnemuronStore} from '../../../server/lib/store.mjs';
import {storageDoctor} from '../../../server/lib/storage-policy.mjs';
import {loadMemoryRuntimeFile} from '../../../server/lib/memory-runtime.mjs';
import {BoundaryError,seconds} from '../../../shared/oauth-common.mjs';
import {provisionIdentities} from './provisioning.mjs';

// Optional local worker, configured only by the operator. Never expose arbitrary
// file paths/SQL or a cross-user administrative Core token to a console request.
export class IdentityMaintenance {
  constructor(ids,config){this.ids=ids;this.config=config;this.busy=false;this.p=config.identity?.provisioning;
    if(this.p?.enabled){storageDoctor({core_database:this.p.core_database,credential_directory:this.p.credential_directory,identity_map:this.p.identity_map_file,memory_config:this.p.memory_config_file});
      if(!fs.existsSync(this.p.core_database))throw new BoundaryError(503,'IDENTITY_MAINTENANCE_REQUIRED');}}
  enabled(){return this.p?.enabled===true;}
  open(){if(!this.enabled()||!fs.existsSync(this.p.core_database))throw new BoundaryError(503,'IDENTITY_MAINTENANCE_REQUIRED');
    const memoryConfig=this.p.memory_config_file?loadMemoryRuntimeFile(this.p.memory_config_file):undefined;
    return new MnemuronStore(this.p.core_database,{memoryConfig,memoryConfigPath:this.p.memory_config_file});}
  revoke({user_id}){const core=this.open();try{core.memoryTransaction(()=>{
    core.db.prepare('UPDATE credentials SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?').run(new Date().toISOString(),user_id);
    core.db.prepare("UPDATE memory_jobs SET state='cancelled',fence=fence+1,lease_owner=NULL,lease_expires=NULL WHERE user_id=? AND state NOT IN ('succeeded','cancelled')").run(user_id);
    core.db.prepare("UPDATE console_vector_requests SET state='cancelled' WHERE user_id=? AND state='pending'").run(user_id);
    core.db.prepare("UPDATE console_settings SET settings_json=json_set(settings_json,'$.schedule_enabled',json('false')) WHERE user_id=?").run(user_id);
    core.audit({auth:{user_id,credential_id:null},action:'identity.credentials.revoke_all',targetType:'account'});
  });return true;}finally{core.close();}}
  async run(){if(!this.enabled()||this.busy)return;this.busy=true;try{
    const pending=this.ids.db.prepare("SELECT * FROM identity_operations WHERE kind LIKE 'console-disable:%' AND state='revocation_pending'").all();
    for(const op of pending){const a=this.ids.byId(op.account_id);try{this.revoke({user_id:a.user_id});this.ids.db.prepare("UPDATE identity_operations SET state='completed',last_error=NULL WHERE operation_id=?").run(op.operation_id);}catch{this.ids.db.prepare("UPDATE identity_operations SET last_error='REVOCATION_INCOMPLETE' WHERE operation_id=?").run(op.operation_id);}}
    const core=this.open();try{return provisionIdentities(this.ids,core,{credentialDirectory:this.p.credential_directory,identityMapFile:this.p.identity_map_file,consoleOperations:this.config.identity.console_operations===true});}finally{core.close();}
  }finally{this.busy=false;}}
  async setState(accountId,action){if(!this.enabled())throw new BoundaryError(503,'IDENTITY_MAINTENANCE_REQUIRED');const a=this.ids.byId(accountId);if(!a)throw new BoundaryError(404,'ACCOUNT_NOT_FOUND');
    if(action==='disable'){
      if(!['active','disabled'].includes(a.status))throw new BoundaryError(409,'ACCOUNT_STATE_CONFLICT');
      this.ids.store.transaction(()=>{if(a.status==='active')this.ids.db.prepare("UPDATE identity_accounts SET status='disabled',binding_ready=0,security_version=security_version+1 WHERE account_id=?").run(accountId);
        this.ids.db.prepare('DELETE FROM identity_sessions WHERE account_id=?').run(accountId);
        this.ids.db.prepare("INSERT OR IGNORE INTO identity_operations(operation_id,account_id,kind,state,created) VALUES(?,?,?,'revocation_pending',?)").run(randomUUID(),accountId,`console-disable:${this.ids.byId(accountId).security_version}`,seconds());
        this.ids.audit(accountId,'account.disabled');});
      this.ids.store.revoke({subject:a.subject});await this.run();
      const pending=this.ids.db.prepare("SELECT 1 FROM identity_operations WHERE account_id=? AND kind LIKE 'console-disable:%' AND state='revocation_pending'").get(accountId);
      if(pending)throw new BoundaryError(503,'REVOCATION_INCOMPLETE');return {status:'disabled',account_id:accountId};
    }
    if(action==='enable'&&['active','provisioning'].includes(a.status)&&a.mfa_verified&&a.recovery_ack){await this.run();return {status:this.ids.byId(accountId).status,account_id:accountId,old_agent_keys_restored:false};}
    if(action!=='enable'||a.status!=='disabled'||!a.mfa_verified||!a.recovery_ack)throw new BoundaryError(409,'ACCOUNT_STATE_CONFLICT');
    if(this.ids.db.prepare("SELECT 1 FROM identity_operations WHERE account_id=? AND kind LIKE 'console-disable:%' AND state='revocation_pending'").get(accountId))throw new BoundaryError(503,'REVOCATION_INCOMPLETE');
    this.ids.store.transaction(()=>{this.ids.db.prepare("UPDATE identity_accounts SET status='provisioning',binding_ready=0 WHERE account_id=?").run(accountId);this.ids.queueProvision(accountId);this.ids.audit(accountId,'account.enable_requested');});
    await this.run();return {status:this.ids.byId(accountId).status,account_id:accountId,old_agent_keys_restored:false};
  }
}

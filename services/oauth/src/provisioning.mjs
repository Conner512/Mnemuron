import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {randomSecret,secretHash,readPrivate,writePrivate,requireConfig,CORE_SCOPES} from '../../../shared/oauth-common.mjs';
import {storageDoctor} from '../../../server/lib/storage-policy.mjs';

export function provisionIdentities(identities,core,{credentialDirectory,identityMapFile,afterCore=()=>{}}) {
  storageDoctor({credential_directory:credentialDirectory,identity_map:identityMapFile});
  const db=identities.db;
  const operations=db.prepare("SELECT * FROM identity_operations WHERE kind LIKE 'provision:%' AND state NOT IN ('completed','superseded') ORDER BY created,operation_id").all();
  const completed=[];
  for(const operation of operations) {
    const a=identities.byId(operation.account_id);
    if(a&&operation.kind!==`provision:${a.security_version}`){db.prepare("UPDATE identity_operations SET state='superseded' WHERE operation_id=?").run(operation.operation_id);continue;}
    if(!a || !a.mfa_verified || !['provisioning','active'].includes(a.status))continue;
    const prepared=identities.store.transaction(()=>{
      const row=db.prepare('SELECT * FROM identity_operations WHERE operation_id=?').get(operation.operation_id);
      if(row.payload_cipher)return identities.unseal(row.payload_cipher,a.account_id,'provision');
      const bindings=['web','console'].map(purpose=>({purpose,credential_id:randomUUID(),api_key:`mnm_${randomSecret()}`,
        user_id:a.user_id,agent_instance_id:`${purpose}-${a.account_id}`,agent_id:purpose==='web'?'chatgpt-web':'mnemuron-console',
        scopes:purpose==='web'?[...CORE_SCOPES]:['memory:read','resume:read','console:read'],
        credential_file:path.join(credentialDirectory,`${a.account_id}-${purpose}-v${a.security_version}.key`)}));
      db.prepare("UPDATE identity_operations SET state='prepared',payload_cipher=? WHERE operation_id=?")
        .run(identities.seal(bindings,a.account_id,'provision'),operation.operation_id);
      return bindings;
    });
    try {
      // The durable operation is committed BEFORE Core. An uncertain completion reuses the same key/id.
      core.memoryTransaction(()=>{
        for(const b of prepared) {
          const existing=core.db.prepare('SELECT * FROM credentials WHERE credential_id=? OR key_hash=?').get(b.credential_id,secretHash(b.api_key));
          if(existing) {
            requireConfig(existing.credential_id===b.credential_id&&existing.user_id===a.user_id&&existing.agent_instance_id===b.agent_instance_id
              &&existing.agent_id===b.agent_id&&existing.key_hash===secretHash(b.api_key)&&!existing.revoked_at&&existing.scopes_json===JSON.stringify(b.scopes),'core provisioning conflict');
          } else core.db.prepare(`INSERT INTO credentials(credential_id,label,user_id,device_id,agent_id,agent_instance_id,key_hash,scopes_json,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(b.credential_id,'Account-bound read-only connection',a.user_id,'identity-service',b.agent_id,b.agent_instance_id,secretHash(b.api_key),JSON.stringify(b.scopes),new Date().toISOString());
        }
      });
      afterCore(operation);
      for(const b of prepared) {
        const auth=core.authenticate(b.api_key);
        requireConfig(auth.user_id===a.user_id&&auth.credential_id===b.credential_id&&auth.agent_instance_id===b.agent_instance_id,'authoritative core identity');
        if(fs.existsSync(b.credential_file))requireConfig(readPrivate(b.credential_file)===b.api_key,'credential file collision');
        else writePrivate(b.credential_file,b.api_key);
      }
      identities.finishProvision(a.account_id,prepared,operation.operation_id);
      completed.push(a.account_id);
    } catch(error) {
      db.prepare("UPDATE identity_operations SET last_error='PROVISIONING_INCOMPLETE' WHERE operation_id=?").run(operation.operation_id);
      throw error;
    }
  }
  // Derived publication only: OAuth introspection remains authoritative for current activity/version.
  identities.store.transaction(()=>{
  const mappings=db.prepare(`SELECT a.*,b.credential_id,b.agent_instance_id,b.credential_file FROM identity_accounts a
    JOIN identity_bindings b ON a.account_id=b.account_id AND b.purpose='web' AND b.checked=1 WHERE a.binding_ready=1`).all().map(a=>({
      issuer:a.issuer,subject:a.subject,account_id:a.account_id,mnemuron_user_id:a.user_id,security_version:a.security_version,
      enabled:a.status==='active',agent_instance_id:a.agent_instance_id,credential_id:a.credential_id,credential_file:a.credential_file}));
  writePrivate(identityMapFile,{schema_version:'multi-account-identity-v1',unknown_subject_policy:'deny',mappings},{replace:fs.existsSync(identityMapFile)});
  });
  return {completed:completed.length,pending:db.prepare("SELECT COUNT(*) n FROM identity_operations WHERE kind LIKE 'provision:%' AND state NOT IN ('completed','superseded')").get().n};
}

// Child-process fixture: only disposable paths supplied by release-upgrade.test.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const [source,root]=process.argv.slice(2);
const load=rel=>import(pathToFileURL(path.join(source,rel)));
const {MnemuronStore}=await load('server/lib/store.mjs');
const {AuthStore}=await load('services/oauth/src/sqlite-adapter.mjs');
const {IdentityRepository}=await load('services/oauth/src/identity-repository.mjs');
const {pendingAccount}=await load('services/oauth/test/helpers/identity-fixture.mjs');
const {provisionIdentities}=await load('services/oauth/src/provisioning.mjs');
const {randomSecret,writePrivate,readPrivate}=await load('shared/oauth-common.mjs');
const keyFile=path.join(root,'identity-key');writePrivate(keyFile,randomSecret());
const auth=new AuthStore(path.join(root,'oauth.sqlite3'),{identity:true});
const ids=new IdentityRepository(auth,{keyFile,issuer:'http://127.0.0.1:49001',batchLimit:10,sessionTtl:3600});
const core=new MnemuronStore(path.join(root,'core.sqlite3'));
try {
 const owners=[];
 for(const name of ['Synthetic_Upgrade_A','Synthetic_Upgrade_B']){
  const a=await pendingAccount({identities:ids},name);ids.takeRecoveryCodes(a.session.token);ids.acknowledgeRecovery(a.session.token);owners.push(a);
 }
 provisionIdentities(ids,core,{credentialDirectory:path.join(root,'keys'),identityMapFile:path.join(root,'map.json'),consoleOperations:true});
 const records=[];
 for(const a of owners){
  const account=ids.byId(a.account.account_id);
  const binding=ids.db.prepare("SELECT * FROM identity_bindings WHERE account_id=? AND purpose='console'").get(account.account_id);
  const owner=core.authenticate(readPrivate(binding.credential_file));
  const memory=core.saveMemory(owner,{scope:'user',content:'Synthetic upgrade memory '+account.username}).memory;
  core.webVisibility.setPolicy(owner,{read_all:true,expected_revision:0});
  // Reproduce the durable pre-fix cloud receipt, not an invented privacy field.
  Object.assign(core.runtime,{cloudMemory:true,cloudSubmittedGrant:true});
  const {CLOUD_CORE_SCOPES}=await load('server/lib/memory/cloud.mjs');
  const credential=core.issueCredential({userId:account.user_id,deviceId:'synthetic-upgrade',agentId:'chatgpt-web',agentInstanceId:'upgrade-'+account.account_id,scopes:CLOUD_CORE_SCOPES,expiresAt:new Date(Date.now()+3600000).toISOString()});
  const writer=core.authenticate(credential.api_key),connection=account.account_id.replaceAll('-','').padEnd(64,'0');
  core.cloudMemory.bind(writer,{connection_id:connection,account_id:account.account_id,security_version:1,allow_submitted_revision_grant:true});
  const receipt=core.cloudMemory.execute(writer,{connection_id:connection,action:'memory.save',operation_id:'synthetic-private-'+account.account_id,payload:{scope:'user',content:'Synthetic private upgrade note '+account.username,cloud_read:'keep_private'}});
  records.push({account_id:account.account_id,user_id:account.user_id,subject:account.subject,memory_id:memory.memory_id,private_id:receipt.memory_id,legacy_private_visible:core.webVisibility.visible(writer,receipt.memory_id)});
 }
 writePrivate(path.join(root,'fixture.json'),records);
 console.log(JSON.stringify({seeded:records.length}));
} finally {core.close();auth.close();}

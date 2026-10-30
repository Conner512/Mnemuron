// A disposable loopback fixture. Stdin commands seed synthetic records only; no production
// endpoint, runtime directory, model call or authorization policy is reused or weakened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {memoryFixture,assertIsolatedTarget} from '../../server/test/helpers/core-memory-fixture.mjs';
import {fixture} from '../../services/oauth/test/fixture.mjs';
import {pendingAccount} from '../../services/oauth/test/helpers/identity-fixture.mjs';
import {provisionIdentities} from '../../services/oauth/src/provisioning.mjs';
import {randomSecret,writePrivate} from '../../shared/oauth-common.mjs';

const cleanup=[],t={after:fn=>cleanup.push(fn)},core=await memoryFixture(t);
assertIsolatedTarget(core.root,core.databasePath,core.baseUrl);
const key=path.join(core.root,'console-key');writePrivate(key,randomSecret());
core.store.memoryConfig.console={key_file:key,worker_enabled:false};
const f=await fixture(t,{start:false,mutate:config=>{
 config.identity_mode='multi_account_v1';config.login.registration_enabled=true;
 config.identity={encryption_key_file:path.join(path.dirname(config.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600,console_operations:true,
  core:{base_url:core.baseUrl},provisioning:{enabled:true,core_database:core.databasePath,credential_directory:path.join(path.dirname(config.database_file),'keys'),identity_map_file:path.join(path.dirname(config.database_file),'map.json')}};
}});
assert.equal(new URL(f.config.issuer).hostname,'127.0.0.1');writePrivate(f.config.identity.encryption_key_file,randomSecret());await f.start();
const ids=f.app.accounts,owners=[];
for(const username of ['Synthetic_Map_A','Synthetic_Map_B']){const owner=await pendingAccount({identities:ids},username);ids.takeRecoveryCodes(owner.session.token);ids.acknowledgeRecovery(owner.session.token);owners.push(owner);}
provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json'),consoleOperations:true});
for(const [i,owner]of owners.entries()){owner.account=ids.byId(owner.account.account_id);owner.console=ids.newSession('console',{accountId:owner.account.account_id});owner.writer=core.issue(owner.account.user_id,`synthetic-map-writer-${i}`);}
const save=(owner,content,traits={})=>core.store.saveMemory(owner.writer.auth,{scope:'user',content,...traits}).memory;
const a=owners[0],now=Date.now(),old=new Date(now-120*86400000).toISOString();
const untagged=[];for(let i=0;i<151;i++)untagged.push(save(a,`Synthetic untagged map memory ${i}`,{kind:'fact'}).memory_id);
const shared=Array.from({length:2},(_,i)=>save(a,`Synthetic shared map memory ${i}`,{kind:'preference',concepts:['Synthetic Shared','<b>Synthetic label</b>',i?'pve':'ＰＶＥ',i?'E\u0301quipe':'Équipe',i?'data store':'Data  Store']}).memory_id);
for(let i=0;i<48;i++)save(a,`Synthetic connected map memory ${i}`,{kind:i%2?'bug':'architecture',concepts:[`word-${String(i%24).padStart(2,'0')}`,`word-${String((i+1)%24).padStart(2,'0')}`]});
const renewed=save(a,'Synthetic old source whose keyword was filled recently',{kind:'workflow',concepts:['Synthetic Renewed']});
core.store.db.prepare('UPDATE memories SET created_at=?,updated_at=? WHERE user_id=? AND memory_id=?').run(old,old,a.account.user_id,renewed.memory_id);
const outside=save(a,'Synthetic old memory outside the default graph window',{kind:'pattern',concepts:['Synthetic Outside']});
core.store.db.prepare('UPDATE memories SET created_at=?,updated_at=? WHERE user_id=? AND memory_id=?').run(old,old,a.account.user_id,outside.memory_id);
core.store.db.prepare('UPDATE memory_traits SET updated_at=? WHERE user_id=? AND memory_id=?').run(old,a.account.user_id,outside.memory_id);
const retracted=save(a,'Synthetic retracted graph memory',{kind:'bug',concepts:['Synthetic Retracted','PVE']});core.store.retractMemory(a.writer.auth,retracted.memory_id,{reason:'Synthetic browser lifecycle exclusion'});
save(owners[1],'Synthetic private other-account graph body',{kind:'fact',concepts:['Synthetic Other Owner','PVE']});
let largeSeeded=false,stopped=false;
async function stop(){if(stopped)return;stopped=true;for(const fn of cleanup.reverse())await fn();const removed=!fs.existsSync(core.root)&&!fs.existsSync(f.directory);process.stderr.write(JSON.stringify({synthetic_cleanup_complete:removed,core_storage_removed:!fs.existsSync(core.root),identity_storage_removed:!fs.existsSync(f.directory)})+'\n');process.exit(removed?0:1);}
console.log(JSON.stringify({fixture:true,url:f.config.issuer,cookie:'mnm_fixture_console',accounts:owners.map(owner=>({account_id:owner.account.account_id,token:owner.console.token})),expected:{default_count:202,all_count:203,shared,renewed:renewed.memory_id,outside:outside.memory_id,untagged_first:untagged[0]}}));
readline.createInterface({input:process.stdin}).on('line',async line=>{try{
 const request=JSON.parse(line);if(request.command==='stop')return stop();let reply;
 if(request.command==='seed-large'){
  assert.equal(largeSeeded,false);largeSeeded=true;
  for(let i=0;i<260;i++)save(a,`Synthetic bounded map memory ${i}`,{kind:'fact',concepts:Array.from({length:8},(_,j)=>String.fromCharCode(0x4e00+j).repeat(38)+String(i%8).padStart(2,'0'))});
  reply={created:260};
 }else if(request.command==='revoke-console'){ids.db.prepare("DELETE FROM identity_sessions WHERE account_id=? AND purpose='console'").run(a.account.account_id);reply={revoked:true};}
 else throw new Error('UNKNOWN_SYNTHETIC_COMMAND');
 console.log(JSON.stringify({command:request.command,...reply}));
 }catch(error){console.log(JSON.stringify({fixture_error:error.errorCode||error.code||error.message||'FAILED'}));}});
process.on('SIGTERM',stop);process.on('SIGINT',stop);

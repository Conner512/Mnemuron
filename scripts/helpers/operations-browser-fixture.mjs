// Disposable loopback-only accounts, model endpoint and snapshots. Commands are stdin fixture controls,
// never production HTTP endpoints. No configured user model or database is read.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import readline from 'node:readline';
import {memoryFixture,assertIsolatedTarget} from '../../server/test/helpers/core-memory-fixture.mjs';
import {fixture} from '../../services/oauth/test/fixture.mjs';
import {pendingAccount} from '../../services/oauth/test/helpers/identity-fixture.mjs';
import {provisionIdentities} from '../../services/oauth/src/provisioning.mjs';
import {randomSecret,writePrivate} from '../../shared/oauth-common.mjs';
import {runBackupMaintenance} from '../../server/lib/memory/backup-status.mjs';

const cleanup=[],t={after:fn=>cleanup.push(fn)},core=await memoryFixture(t);assertIsolatedTarget(core.root,core.databasePath,core.baseUrl);
let mode='reported',calls=0,stopped=false,sequence=0,backupFile=null;
const model=http.createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;calls++;const body=JSON.parse(raw);
  if(mode==='failed'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:'Synthetic upstream-private-error-sentinel'}));return;}
  const input=body.messages?JSON.parse(body.messages[1].content).input:null;
  const output=input?.sources?{results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content}))}:{ok:true};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}],
    ...(mode==='reported'?{usage:{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:10}}}:{})}));
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));cleanup.push(()=>{model.closeAllConnections();return new Promise(r=>model.close(r));});
const modelUrl=`http://127.0.0.1:${model.address().port}`,key=path.join(core.root,'console-key');writePrivate(key,randomSecret());
core.store.memoryConfig.console={key_file:key,worker_enabled:false,allowed_private_origins:[modelUrl]};
const f=await fixture(t,{start:false,mutate:config=>{
  config.identity_mode='multi_account_v1';config.login.registration_enabled=true;
  config.identity={encryption_key_file:path.join(path.dirname(config.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600,console_operations:true,
    core:{base_url:core.baseUrl},provisioning:{enabled:true,core_database:core.databasePath,credential_directory:path.join(path.dirname(config.database_file),'keys'),identity_map_file:path.join(path.dirname(config.database_file),'map.json')}};
}});
writePrivate(f.config.identity.encryption_key_file,randomSecret());await f.start();const identities=f.app.accounts,owners=[];
for(const username of ['Synthetic_Operations_A','Synthetic_Operations_B']){const owner=await pendingAccount({identities},username);identities.takeRecoveryCodes(owner.session.token);identities.acknowledgeRecovery(owner.session.token);owners.push(owner);}
provisionIdentities(identities,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json'),consoleOperations:true});
for(const [index,owner] of owners.entries()){owner.account=identities.byId(owner.account.account_id);owner.console=identities.newSession('console',{accountId:owner.account.account_id});
  const writer=core.issue(owner.account.user_id,`synthetic-operations-${index}`);core.store.saveMemory(writer.auth,{scope:'user',content:index?'Synthetic OTHER OWNER sentinel':'Synthetic private operations memory'});}
identities.console.role(owners[0].account.account_id,true);
async function stop(){if(stopped)return;stopped=true;for(const fn of cleanup.reverse())await fn();const removed=!fs.existsSync(core.root)&&!fs.existsSync(f.directory);
  process.stderr.write(JSON.stringify({synthetic_cleanup_complete:removed})+'\n');process.exit(removed?0:1);}
console.log(JSON.stringify({fixture:true,url:f.config.issuer,model_url:modelUrl,cookie:'mnm_fixture_console',accounts:owners.map(owner=>({token:owner.console.token}))}));
readline.createInterface({input:process.stdin}).on('line',async line=>{try{
  const request=JSON.parse(line);if(request.command==='stop')return stop();let reply;
  if(request.command==='metrics')reply={calls,attempts:core.store.consoleService.models.usage.report(owners[0].account.user_id).totals.attempts};
  else if(request.command==='model-mode'){if(!['reported','unknown','failed'].includes(request.mode))throw new Error('INVALID_SYNTHETIC_MODE');mode=request.mode;reply={mode};}
  else if(request.command==='backup-configure'){core.store.memoryConfig.storage={sqlite_path:core.databasePath,backup_dir:path.join(core.root,'backup-evidence')};reply={configured:true};}
  else if(['backup-create','backup-verify','backup-restore'].includes(request.command)){
    if(request.command==='backup-create')backupFile=path.join(core.store.memoryConfig.storage.backup_dir,`snapshot-${++sequence}.sqlite3`);
    try{const r=await runBackupMaintenance(core.store.memoryConfig,{operation:request.command==='backup-create'?'backup':request.command==='backup-verify'?'verify':'restore_isolated',backupFile,
      destination:request.command==='backup-create'?backupFile:path.join(core.root,`isolated-${sequence}.sqlite3`)});reply={success:true,evidence_status:r.evidence_status};}
    catch(error){reply={success:false,error_code:error.code||error.errorCode||'FAILED'};}
  }else if(request.command==='backup-corrupt'){const manifest=JSON.parse(fs.readFileSync(backupFile+'.manifest.json','utf8'));manifest.tables[0].sha256='synthetic-corrupt';fs.writeFileSync(backupFile+'.manifest.json',JSON.stringify(manifest));reply={corrupted:true};}
  else throw new Error('UNKNOWN_SYNTHETIC_COMMAND');
  console.log(JSON.stringify({command:request.command,...reply}));
}catch(error){console.log(JSON.stringify({fixture_error:error.errorCode||error.code||error.message||'FAILED'}));}});
process.on('SIGTERM',stop);process.on('SIGINT',stop);

// Synthetic loopback fixture for real browser/module/CSP acceptance. No production configuration is read.
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import http from 'node:http';
import {generate} from 'otplib';
import {fixture} from '../fixture.mjs';
import {pendingAccount} from './identity-fixture.mjs';
import {memoryFixture} from '../../../../server/test/helpers/core-memory-fixture.mjs';
import {provisionIdentities} from '../../src/provisioning.mjs';
import {randomSecret,writePrivate,seconds} from '../../../../shared/oauth-common.mjs';
const cleanup=[],t={after:fn=>cleanup.push(fn)};
let stopped=false;
async function stop(){if(stopped)return;stopped=true;for(const fn of cleanup.reverse())await fn();process.exit(0);}
const core=await memoryFixture(t);
const model=http.createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);let output={ok:true};
 try{const request=JSON.parse(body.messages?.find(m=>m.role==='user')?.content||'{}'),sources=request.input?.sources;
  if(sources)output={results:sources.map(s=>request.input.operation==='classification'?{memory_id:s.memory_id,category:'technical',tags:['synthetic']}:{memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content})};
 }catch{}
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body.input?{data:body.input.map((_,index)=>({index,embedding:[1,0,0]}))}:{choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}]}));
});
await new Promise(r=>model.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise(r=>model.close(r)));
const modelUrl='http://127.0.0.1:'+model.address().port;
const key=path.join(core.root,'console-key');writePrivate(key,randomSecret());
core.store.memoryConfig.console={key_file:key,worker_enabled:false,allowed_private_origins:[modelUrl]};
const f=await fixture(t,{start:false,mutate:c=>{c.identity_mode='multi_account_v1';c.login.registration_enabled=true;
 c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:20,console_session_ttl_seconds:3600,console_operations:true,core:{base_url:core.baseUrl},
 recovery_policy:{password:['recovery_code','totp'],totp:['recovery_code','password']},
 provisioning:{enabled:true,core_database:core.databasePath,credential_directory:path.join(path.dirname(c.database_file),'keys'),identity_map_file:path.join(path.dirname(c.database_file),'map.json')}};
}});
writePrivate(f.config.identity.encryption_key_file,randomSecret());await f.start();const ids=f.app.accounts,owners=[];
for(const username of ['Synthetic_Browser_A','Synthetic_Browser_B']){
 const o=await pendingAccount({identities:ids},username);o.codes=ids.takeRecoveryCodes(o.session.token);ids.acknowledgeRecovery(o.session.token);owners.push(o);
}
provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json'),consoleOperations:true});
for(const [i,o] of owners.entries()){
 o.account=ids.byId(o.account.account_id);o.console=ids.newSession('console',{accountId:o.account.account_id});
 const writer=core.issue(o.account.user_id,`synthetic-browser-${i}`);
 for(const content of [i?'Synthetic private B sentinel':'合成记忆：蓝色纸船在测试港口。',i?'Synthetic B second memory':'Synthetic technical decision: preserve exact source revisions.'])core.store.saveMemory(writer.auth,{scope:'user',content});
}
ids.console.role(owners[0].account.account_id,true);
const Adapter=f.app.store.adapter();for(const o of owners)await new (Adapter)('Grant').upsert('synthetic-browser-'+o.account.account_id,{accountId:o.account.subject,clientId:f.config.chatgpt_client.client_id},3600);
console.log(JSON.stringify({fixture:true,url:f.config.issuer,model_url:modelUrl,cookie:'mnm_fixture_console',accounts:owners.map(o=>({account_id:o.account.account_id,username:o.account.username,token:o.console.token})),password:'Synthetic password with spaces  '}));
const lines=readline.createInterface({input:process.stdin});
lines.on('line',async line=>{
 try{const req=JSON.parse(line);if(req.command==='stop')return stop();const o=owners[req.owner||0];let reply;
  if(req.command==='otp')reply={otp:await generate({secret:o.setup.secret,epoch:seconds()+(req.offset||0)})};
  if(req.command==='tick'){core.store.memoryConfig.console.worker_enabled=true;await core.store.consoleService.tick();core.store.memoryConfig.console.worker_enabled=false;reply={done:true};}
  if(req.command==='invitation')reply=ids.issueInvitations({count:1,ttlMinutes:10,issuer:'synthetic-browser-operator'});
  if(req.command==='codes')reply={codes:o.codes};
  if(req.command==='cookies'){o.console=ids.newSession('console',{accountId:o.account.account_id});reply={token:o.console.token};}
  console.log(JSON.stringify({request:req.command,...reply}));
 }catch(error){console.log(JSON.stringify({fixture_error:error.code||error.errorCode||'FAILED'}));}
});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,stop);

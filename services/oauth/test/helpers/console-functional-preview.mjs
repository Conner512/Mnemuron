// Synthetic loopback fixture for real browser/module/CSP acceptance. No production configuration is read.
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import http from 'node:http';
import {generate} from 'otplib';
import {fixture} from '../fixture.mjs';
import {pendingAccount} from './identity-fixture.mjs';
import {memoryFixture} from '../../../../server/test/helpers/core-memory-fixture.mjs';
import {VectorIndex} from '../../../../server/lib/vector-stores/index.mjs';
import {MockVectorStore} from '../../../../server/test/helpers/vector-mock.mjs';
import {provisionIdentities} from '../../src/provisioning.mjs';
import {prepareConnectionBinding,applyConnectionBinding,finishConnectionBinding} from '../../src/connection-provisioning.mjs';
import {randomSecret,writePrivate,seconds,secretHash} from '../../../../shared/oauth-common.mjs';
const cleanup=[],t={after:fn=>cleanup.push(fn)};
let stopped=false;
async function stop(){
 if(stopped)return;stopped=true;
 for(const fn of cleanup.reverse())await fn();
 const removed=!fs.existsSync(core.root)&&!fs.existsSync(f.directory);
 process.stderr.write(JSON.stringify({synthetic_cleanup_complete:removed,core_storage_removed:!fs.existsSync(core.root),identity_storage_removed:!fs.existsSync(f.directory)})+'\n');
 process.exit(removed?0:1);
}
const core=await memoryFixture(t);
Object.assign(core.store.runtime,{cloudMemory:true,cloudSubmittedGrant:true});
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
 c.cloud_memory={enabled:true,allow_submitted_revision_grant:true};c.resource_scopes.push('memory:write');c.chatgpt_client.allowed_scopes.push('memory:write');
 c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:20,console_session_ttl_seconds:3600,console_operations:true,core:{base_url:core.baseUrl},
 connection_management:{enabled:true,max_connections:20,pat_default_ttl_seconds:2592000,pat_max_ttl_seconds:7776000,secret_receipt_ttl_seconds:300,rotation_overlap_seconds:0},
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
 core.store.upsertTask(writer.auth,{task_id:`synthetic-browser-task-${i}`,project_id:`synthetic-browser-project-${i}`,project_name:'Synthetic UI Project',title:'Synthetic UI Task',goal:'Synthetic canonical goal for read-only console acceptance.',status:'active',workstreams:[{workstream_id:`synthetic-browser-branch-${i}`,name:'Synthetic branch',status:'active'}]});
 for(const content of [i?'Synthetic private B sentinel':'合成记忆：蓝色纸船在测试港口。',i?'Synthetic B second memory':'Synthetic technical decision: preserve exact source revisions.'])core.store.saveMemory(writer.auth,{scope:'user',content});
}
ids.console.role(owners[0].account.account_id,true);
const Adapter=f.app.store.adapter();for(const o of owners)await new (Adapter)('Grant').upsert('synthetic-browser-'+o.account.account_id,{accountId:o.account.subject,clientId:f.config.chatgpt_client.client_id},3600);
console.log(JSON.stringify({fixture:true,url:f.config.issuer,model_url:modelUrl,cookie:'mnm_fixture_console',accounts:owners.map(o=>({account_id:o.account.account_id,username:o.account.username,token:o.console.token})),password:'Synthetic password with spaces  '}));
const lines=readline.createInterface({input:process.stdin});
lines.on('line',async line=>{
 try{const req=JSON.parse(line);if(req.command==='stop')return stop();const o=owners[req.owner||0];let reply;
  if(req.command==='otp'){
   // Isolated test fixtures reset their proof window between independent UI cases.
   // This stdin helper is not a service endpoint and never exists in production.
   if(req.fresh){ids.db.prepare('DELETE FROM oauth_mfa_steps WHERE subject=?').run(o.account.subject);ids.db.prepare('DELETE FROM oauth_rate_limits WHERE key=?').run(secretHash(`console:reauth:${o.account.account_id}`));}
   reply={otp:await generate({secret:o.setup.secret,epoch:seconds()+(req.offset||0)})};
  }
  if(req.command==='provision-connections'){
   for(const op of ids.db.prepare("SELECT * FROM identity_operations WHERE kind LIKE 'connection-bind:%' AND state NOT IN ('completed','superseded')").all()){
    const work=prepareConnectionBinding(ids,op,path.join(f.directory,'keys'));if(!work)continue;applyConnectionBinding(core.store,work);writePrivate(work.binding.credential_file,work.binding.api_key);finishConnectionBinding(ids,work);
   }reply={done:true};
  }
  if(req.command==='tick'){core.store.memoryConfig.console.worker_enabled=true;await core.store.consoleService.tick();core.store.memoryConfig.console.worker_enabled=false;reply={done:true};}
  if(req.command==='enable-synthetic-processing'){
   core.store.memoryConfig.console.worker_enabled=true;core.store.memoryConfig.vector_store={enabled:true};
   const backend=new MockVectorStore();core.store.consoleService.vector=user=>{const e=core.store.consoleService.models.provider(user,'embedder');return new VectorIndex(core.store,backend,new Map([[e.profile.fingerprint,e]]),{ownerId:user});};
   reply={done:true,synthetic_vector_backend:true};
  }
  // UI-state fixtures only; actual OAuth/MCP acceptance lives in the gateway SDK suite.
  if(req.command==='connection-evidence'){
   const r=ids.db.prepare('SELECT * FROM identity_connections WHERE account_id=? AND label=?').get(o.account.account_id,req.label);if(!r)throw new Error('Synthetic connection missing');
   if(req.state==='authorized'){await new (Adapter)('Grant').upsert('synthetic-guide-'+r.connection_id,{accountId:o.account.subject,clientId:r.client_id,resources:{[f.config.resource]:'memory:read'}},3600);ids.connections.markAuthorized(r.client_id,o.account.subject);}
   else if(req.state==='verified')ids.connections.markTool({connection_id:r.connection_id,account_id:r.account_id,connection_version:r.version});
   else if(req.state==='revoked')ids.store.revoke({subject:o.account.subject,clientId:r.client_id});
   reply={done:true};
  }
  // Read-only integrity evidence for organize acceptance: schema version and row counts, never content.
  if(req.command==='integrity'){const db=core.store.db,n=(sql,...a)=>db.prepare(sql).get(...a).n;
   reply={user_version:db.prepare('PRAGMA user_version').get().user_version,users:owners.map(x=>({memories:n('SELECT COUNT(*) n FROM memories WHERE user_id=?',x.account.user_id),
    active:n("SELECT COUNT(*) n FROM memories WHERE user_id=? AND status='active'",x.account.user_id),revisions:n('SELECT COUNT(*) n FROM memory_revisions WHERE user_id=?',x.account.user_id),
    overrides:n('SELECT COUNT(*) n FROM memory_category_overrides WHERE user_id=?',x.account.user_id),denials:n('SELECT COUNT(*) n FROM memory_web_denials WHERE user_id=?',x.account.user_id),
    // Original memory fields (content, type, lifecycle, topic, scope, dates) must never change by organizing.
    fields_sha256:createHash('sha256').update(JSON.stringify(db.prepare('SELECT memory_id,content,memory_type,status,topic,scope,source,created_at,updated_at FROM memories WHERE user_id=? ORDER BY memory_id').all(x.account.user_id))).digest('hex')}))};
  }
  if(req.command==='keep-private'){const writer=core.issue(o.account.user_id,'synthetic-private-'+Date.now());const m=core.store.saveMemory(writer.auth,{scope:'user',content:'Synthetic keep-private memory for organize acceptance',topic:'privacy-check'}).memory;
   core.store.webVisibility.keepPrivate(o.account.user_id,m.memory_id,core.store.revisions.latest(o.account.user_id,m.memory_id));reply={memory_id:m.memory_id};}
  if(req.command==='web-visible'){reply={visible:core.store.webVisibility.visible({user_id:o.account.user_id,agent_id:'chatgpt-web',scopes:['memory:read']},req.memory_id),denied:core.store.webVisibility.denied(o.account.user_id,req.memory_id)};}
  // Synthetic bulk memories for limit acceptance (owner-scoped, one transaction).
  if(req.command==='bulk'){const writer=core.issue(o.account.user_id,'synthetic-bulk-'+Date.now());core.store.db.exec('BEGIN');
   try{for(let i=0;i<req.count;i++)core.store.saveMemory(writer.auth,{scope:'user',content:`Synthetic bulk limit note ${i}`,topic:req.topic});core.store.db.exec('COMMIT');}catch(e){core.store.db.exec('ROLLBACK');throw e;}reply={created:req.count};}
  if(req.command==='invitation')reply=ids.issueInvitations({count:1,ttlMinutes:10,issuer:'synthetic-browser-operator'});
  if(req.command==='codes')reply={codes:o.codes};
  if(req.command==='cookies'){o.console=ids.newSession('console',{accountId:o.account.account_id});reply={token:o.console.token};}
  if(req.command==='basic-memory-only'){f.app.config.identity.console_operations=false;f.app.config.identity.console_basic_operations={memory:true,security:true,oauth:true};reply={done:true};}
  if(req.command==='revoke-console-sessions'){ids.db.prepare("DELETE FROM identity_sessions WHERE account_id=? AND purpose='console'").run(o.account.account_id);reply={done:true};}
  console.log(JSON.stringify({request:req.command,...reply}));
 }catch(error){console.log(JSON.stringify({fixture_error:error.code||error.errorCode||'FAILED'}));}
});
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,stop);

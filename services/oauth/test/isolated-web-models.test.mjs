import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Browser,fixture} from './fixture.mjs';
import {pendingAccount} from './helpers/identity-fixture.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {randomSecret,writePrivate,readPrivate} from '../../../shared/oauth-common.mjs';
import {CONSOLE_READ_SCOPES,CONSOLE_WRITE_SCOPES,exactScopes} from '../../../shared/console-contract.mjs';
import {main as operatorCommand} from '../bin/console-operator.mjs';
import {consoleActionAllowed} from '../src/console-policy.mjs';

// Web model operations next to the isolated identity worker, with existing configuration only:
// the web service runs with console_operations=true; the worker reads its own auth view with
// console_operations=false (otherwise identical). The worker still refuses general writes and
// issues read/basic credentials; console:write comes only from the confirmed enable-console operation.
async function setup(t){
 const core=await memoryFixture(t);
 const model=http.createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;const body=JSON.parse(data);let output={ok:true};
   try{const input=JSON.parse(body.messages?.find(m=>m.role==='user')?.content||'{}').input;if(input?.sources)output={results:input.sources.map(s=>input.operation==='classification'?{memory_id:s.memory_id,category:'technical',tags:['synthetic']}:{memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content})};}catch{}
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}]}));});
 await new Promise(r=>model.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>model.close(r)));const modelUrl=`http://127.0.0.1:${model.address().port}`;
 const key=path.join(core.root,'console.key');writePrivate(key,randomSecret());core.store.memoryConfig.console={key_file:key,worker_enabled:false,allowed_private_origins:[modelUrl]};
 const f=await fixture(t,{start:false,mutate:c=>{c.identity_mode='multi_account_v1';c.login.registration_enabled=true;
   c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600,console_operations:true,
     core:{base_url:core.baseUrl},provisioning:{enabled:true,mode:'external_worker'}};}});
 writePrivate(f.config.identity.encryption_key_file,randomSecret());await f.start();const ids=f.app.accounts;
 // Two files: the web service's view and the worker's view, which differ only in the general-write switch.
 const webConfigFile=path.join(f.directory,'web-runtime.json'),workerAuthFile=path.join(f.directory,'worker-auth.json');
 writePrivate(webConfigFile,f.config);writePrivate(workerAuthFile,{...f.config,identity:{...f.config.identity,console_operations:false}});
 const owners=[];for(const name of ['Synthetic_Web_Model_A','Synthetic_Web_Model_B']){const o=await pendingAccount({identities:ids},name);ids.takeRecoveryCodes(o.session.token);ids.acknowledgeRecovery(o.session.token);owners.push(o);}
 const worker={config_version:'isolated-identity-worker-v1',auth:{uid:process.getuid(),gid:process.getgid(),config_file:workerAuthFile,credential_directory:path.join(f.directory,'console-keys')},
   core:{uid:process.getuid(),gid:process.getgid(),database_file:core.databasePath},
   web:{uid:process.getuid(),gid:process.getgid(),credential_directory:path.join(f.directory,'web-keys'),identity_map_file:path.join(f.directory,'web-map.json')}};
 const {runIsolatedMaintenance}=await import('../src/isolated-maintenance.mjs');
 const run=(config=worker)=>runIsolatedMaintenance(config,{isolated:true});
 const session=o=>{o.record=ids.byId(o.account.account_id);o.browser=new Browser(f.config.issuer);o.console=ids.newSession('console',{accountId:o.record.account_id});
   o.browser.cookies.set('mnm_fixture_console:/',{name:'mnm_fixture_console',path:'/',value:o.console.token});};
 const get=async(view,o)=>{const r=await o.browser.request('/console-api/'+view);return {status:r.status,body:JSON.parse(r.text)};};
 const act=async(action,payload,o)=>{const me=await get('me',o),r=await o.browser.post('/console-api/action',{csrf:me.body.csrf,account_id:o.record.account_id,action,operation_id:randomUUID(),payload:JSON.stringify(payload)});return {status:r.status,body:JSON.parse(r.text)};};
 const consoleScopes=o=>{const b=ids.bindings(ids.byId(o.account.account_id).subject).find(b=>b.purpose==='console');return core.store.authenticate(readPrivate(b.credential_file)).scopes;};
 const modelConfig={enabled:true,protocol:'openai_compatible',base_url:modelUrl+'/v1',model:'synthetic-organizer',profile_revision:'1',daily_requests:10,output_tokens:4096,batch_size:5,sensitivities:['public','internal','sensitive'],egress_approved:true,query_approved:false,native_schema:true};
 return {core,f,ids,owners,worker,webConfigFile,workerAuthFile,run,session,get,act,consoleScopes,modelConfig};
}

test('ISO-WEB-01: Web model operations coexist with the isolated worker through separate effective configuration',async t=>{
 const x=await setup(t),[a,b]=x.owners;
 // The worker provisions both accounts from its own view and never issues a write credential.
 assert.equal(x.run().completed,2);for(const o of [a,b]){x.session(o);assert.ok(exactScopes(x.consoleScopes(o),CONSOLE_READ_SCOPES));}
 // Pointing the worker at the web view is still refused (ISO-WORKER-07 behaviour is unchanged).
 const shared={...x.worker,auth:{...x.worker.auth,config_file:x.webConfigFile}},{workerPhase}=await import('../src/isolated-maintenance.mjs');
 assert.throws(()=>x.run(shared),/IDENTITY_WORKER_AUTH_FAILED/,'the worker fails closed (sanitized outer error)');
 assert.throws(()=>workerPhase('auth',{config:shared,action:'plan'},{isolated:true}),/isolated worker excludes general writes/,'the cause is the unchanged general-write guard');
 // The web policy offers model operations, but an account without console:write is refused by Core.
 // Policy permits model operations, but the account's capabilities reflect its read-only credential.
 assert.equal(consoleActionAllowed(x.f.app.config,'models.save'),true);assert.ok(!(await x.get('capabilities',a)).body.allowed_actions.includes('models.save'));
 const denied=await x.act('models.save',{kind:'organizer',expected_revision:0,config:x.modelConfig},a);
 assert.equal(denied.status,403,JSON.stringify(denied.body));assert.equal(x.core.store.db.prepare('SELECT COUNT(*) n FROM console_models').get().n,0);
 // The existing, confirmed enable-console operation is the only way to console:write.
 await operatorCommand(['enable-console','--config',x.webConfigFile,'--core-database',x.core.databasePath,'--account-id',a.record.account_id,'--confirm','--isolated-fixture']);
 assert.ok(exactScopes(x.consoleScopes(a),CONSOLE_WRITE_SCOPES));assert.ok((await x.get('capabilities',a)).body.allowed_actions.includes('models.save'));
 const saved=await x.act('models.save',{kind:'organizer',expected_revision:0,config:x.modelConfig,api_key:'synthetic-key'},a);
 assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.status,'saved');
 const probe=await x.act('models.test',{kind:'organizer',mode:'capabilities'},a);
 assert.equal(probe.status,200,JSON.stringify(probe.body));assert.equal(probe.body.status,'verified','a legitimate model-service call works (synthetic loopback model)');
 // Another account stays refused; the worker keeps running and does not touch the enabled credential.
 assert.equal((await x.act('models.save',{kind:'organizer',expected_revision:0,config:x.modelConfig},b)).status,403);
 assert.equal(x.run().completed,0);assert.ok(exactScopes(x.consoleScopes(a),CONSOLE_WRITE_SCOPES));assert.ok(exactScopes(x.consoleScopes(b),CONSOLE_READ_SCOPES));
 assert.ok(!fs.readdirSync(x.worker.auth.credential_directory).some(file=>exactScopes(x.core.store.authenticate(readPrivate(path.join(x.worker.auth.credential_directory,file))).scopes,CONSOLE_WRITE_SCOPES)&&!file.startsWith(a.record.account_id)),'the worker issued no write credential');
});

test('ISO-WEB-02: with the global Web model switch off, model writes are refused even for an enabled account; the worker is unaffected',async t=>{
 const x=await setup(t),[a]=x.owners;assert.equal(x.run().completed,2);x.session(a);
 await operatorCommand(['enable-console','--config',x.webConfigFile,'--core-database',x.core.databasePath,'--account-id',a.record.account_id,'--confirm','--isolated-fixture']);
 x.f.app.config.identity.console_operations=false;
 const blocked=await x.act('models.save',{kind:'organizer',expected_revision:0,config:x.modelConfig},a);
 assert.equal(blocked.status,403);assert.equal(blocked.body.error_code,'BLOCKED_POLICY');
 assert.ok(!(await x.get('capabilities',a)).body.allowed_actions.includes('models.save'));
 assert.equal(x.core.store.db.prepare('SELECT COUNT(*) n FROM console_models').get().n,0);assert.equal(x.run().completed,0);
});

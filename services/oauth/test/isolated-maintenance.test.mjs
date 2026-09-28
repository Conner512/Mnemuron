import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {consoleFixture,pendingAccount} from './helpers/identity-fixture.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {writePrivate} from '../../../shared/oauth-common.mjs';
import {IdentityMaintenance} from '../src/identity-maintenance.mjs';
import {generate} from 'otplib';

async function setup(t){
 const core=await memoryFixture(t),f=await consoleFixture(t,{core}),ids=f.app.accounts;
 f.config.identity.provisioning={enabled:true,mode:'external_worker'};
 f.config.identity.console_operations=false;
 const configFile=path.join(f.directory,'runtime.json');writePrivate(configFile,f.config);
 const account=await pendingAccount({identities:ids},'Synthetic_Isolated_Worker');ids.takeRecoveryCodes(account.session.token);ids.acknowledgeRecovery(account.session.token);
 const worker={config_version:'isolated-identity-worker-v1',auth:{uid:process.getuid(),gid:process.getgid(),config_file:configFile,credential_directory:path.join(f.directory,'console-keys')},
   core:{uid:process.getuid(),gid:process.getgid(),database_file:core.databasePath},
   web:{uid:process.getuid(),gid:process.getgid(),credential_directory:path.join(f.directory,'web-keys'),identity_map_file:path.join(f.directory,'web-map.json')}};
 return {core,f,ids,account,worker,maintenance:new IdentityMaintenance(ids,f.config)};
}
async function connectionSetup(t){
 const x=await setup(t),{runIsolatedMaintenance}=await import('../src/isolated-maintenance.mjs');runIsolatedMaintenance(x.worker,{isolated:true});
 x.worker.connection_management=true;x.f.config.identity.connection_management={enabled:true,max_connections:20,pat_default_ttl_seconds:2592000,pat_max_ttl_seconds:7776000,secret_receipt_ttl_seconds:300,rotation_overlap_seconds:0};
 writePrivate(x.worker.auth.config_file,x.f.config,{replace:true});x.ids.connections.config=x.f.config;
 const a=x.ids.byId(x.account.account.account_id),s=x.ids.newSession('console',{accountId:a.account_id});
 const c=await x.ids.connections.execute(a.account_id,x.ids.session(s.token,'console'),'connections.create',{kind:'generic_mcp',label:'Synthetic isolated connection',profile:'readonly',current_password:'Synthetic password with spaces  ',otp:await generate({secret:x.account.setup.secret})},'synthetic-worker-connection');
 return {...x,a,connection:c.connection,run:options=>runIsolatedMaintenance(x.worker,{isolated:true,...options})};
}
test('B-WORKER-01: connection Core/key publication retries fixed IDs, completed work is idempotent and old bindings preserved',async t=>{
 const x=await connectionSetup(t),before=x.core.store.db.prepare('SELECT * FROM credentials ORDER BY credential_id').all();
 assert.throws(()=>x.run({afterPhase:name=>{if(name==='core.apply-connection')throw new Error('Synthetic interruption');}}));
 assert.equal(x.ids.connections.public(x.ids.connections.row(x.a.account_id,x.connection.connection_id)).provisioning,true);
 const prepared=x.core.store.db.prepare('SELECT * FROM credentials ORDER BY credential_id').all();assert.equal(prepared.length,before.length+1);
 assert.equal(x.run().connection_completed,1);assert.deepEqual(x.core.store.db.prepare('SELECT * FROM credentials ORDER BY credential_id').all(),prepared);
 assert.equal(x.run().connection_completed,0);
 const map=JSON.parse(fs.readFileSync(x.worker.web.identity_map_file)),connection=map.mappings[0].connections[0];assert.equal(connection.connection_id,x.connection.connection_id);
 assert.deepEqual(x.core.store.authenticate(fs.readFileSync(connection.credential_file,'utf8').trim()).scopes,['memory:read','resume:read']);
 for(const r of before)assert.deepEqual(x.core.store.db.prepare('SELECT * FROM credentials WHERE credential_id=?').get(r.credential_id),r);
});
test('B-WORKER-02: disable racing publication discards new keys; stale account work cannot starve maintenance',async t=>{
 const x=await connectionSetup(t);
 assert.throws(()=>x.run({afterPhase:name=>{if(name==='core.apply-connection')x.ids.db.prepare("UPDATE identity_connections SET state='disabled',version=version+1 WHERE connection_id=?").run(x.connection.connection_id);}}));
 const key=x.ids.db.prepare('SELECT credential_id FROM identity_connection_credentials WHERE connection_id=?').get(x.connection.connection_id);
 assert.ok(x.core.store.db.prepare('SELECT revoked_at FROM credentials WHERE credential_id=?').get(key.credential_id).revoked_at);
 assert.equal(x.run().connection_completed,0);assert.equal(JSON.parse(fs.readFileSync(x.worker.web.identity_map_file)).mappings[0].connections?.length??0,0);
});
test('ISO-WORKER-01: separate fixed phases provision and revoke without giving OAuth a Core path',async t=>{
 const x=await setup(t),{runIsolatedMaintenance}=await import('../src/isolated-maintenance.mjs');
 assert.throws(()=>x.maintenance.open());await x.maintenance.run();assert.equal(x.ids.byId(x.account.account.account_id).status,'provisioning');
 const done=runIsolatedMaintenance(x.worker,{isolated:true});assert.equal(done.completed,1);
 const a=x.ids.byId(x.account.account.account_id);assert.equal(a.status,'active');const bindings=x.ids.bindings(a.subject);
 assert.equal(bindings.length,2);for(const b of bindings){
   assert.equal(path.dirname(b.credential_file),x.worker[b.purpose==='web'?'web':'auth'].credential_directory);
   assert.equal(fs.statSync(b.credential_file).mode&0o777,0o600);
   assert.ok(x.core.store.authenticate(fs.readFileSync(b.credential_file,'utf8').trim()).scopes.every(s=>!s.endsWith(':write')));
 }
 assert.equal(runIsolatedMaintenance(x.worker,{isolated:true}).completed,0);
 const requested=await x.maintenance.setState(a.account_id,'disable');assert.equal(requested.status,'revocation_pending');
 assert.equal(x.ids.byId(a.account_id).status,'disabled');assert.equal(x.ids.eligible(a.subject),false);
 assert.equal(runIsolatedMaintenance(x.worker,{isolated:true}).revoked,1);
 for(const b of bindings)assert.throws(()=>x.core.store.authenticate(fs.readFileSync(b.credential_file,'utf8').trim()));
 assert.equal((await x.maintenance.setState(a.account_id,'enable')).status,'provisioning');
 assert.equal(runIsolatedMaintenance(x.worker,{isolated:true}).completed,1);
 assert.equal(x.ids.byId(a.account_id).status,'active');assert.equal(x.ids.byId(a.account_id).user_id,a.user_id);
});
test('ISO-WORKER-02: interrupted publication retries the same durable credential IDs',async t=>{
 const x=await setup(t),{runIsolatedMaintenance}=await import('../src/isolated-maintenance.mjs');
 assert.throws(()=>runIsolatedMaintenance(x.worker,{isolated:true,afterPhase:name=>{if(name==='core.apply')throw new Error('synthetic interruption');}}));
 const first=x.core.store.db.prepare("SELECT credential_id FROM credentials WHERE user_id=?").all(x.ids.byId(x.account.account.account_id).user_id);
 assert.equal(first.length,2);assert.equal(x.ids.byId(x.account.account.account_id).status,'provisioning');
 assert.equal(runIsolatedMaintenance(x.worker,{isolated:true}).completed,1);
 const second=x.core.store.db.prepare("SELECT credential_id FROM credentials WHERE user_id=?").all(x.ids.byId(x.account.account.account_id).user_id);assert.deepEqual(second,first);
});
test('ISO-WORKER-03: unsafe credential publication never activates an account and remains recoverable',async t=>{
 const x=await setup(t),{runIsolatedMaintenance}=await import('../src/isolated-maintenance.mjs');
 fs.mkdirSync(x.worker.web.credential_directory,{mode:0o755});fs.chmodSync(x.worker.web.credential_directory,0o755);
 assert.throws(()=>runIsolatedMaintenance(x.worker,{isolated:true}));
 assert.equal(x.ids.byId(x.account.account.account_id).status,'provisioning');assert.equal(x.ids.byId(x.account.account.account_id).binding_ready,0);
 fs.chmodSync(x.worker.web.credential_directory,0o700);assert.equal(runIsolatedMaintenance(x.worker,{isolated:true}).completed,1);
});
test('ISO-WORKER-04: disable racing Core provisioning prevents activation and revokes unpublished keys',async t=>{
 const x=await setup(t),{runIsolatedMaintenance}=await import('../src/isolated-maintenance.mjs');
 assert.throws(()=>runIsolatedMaintenance(x.worker,{isolated:true,afterPhase:name=>{
   if(name==='core.apply')x.ids.db.prepare("UPDATE identity_accounts SET status='disabled',security_version=security_version+1 WHERE account_id=?").run(x.account.account.account_id);
 }}));
 const a=x.ids.byId(x.account.account.account_id);assert.equal(a.status,'disabled');assert.equal(a.binding_ready,0);
 assert.equal(x.core.store.db.prepare('SELECT COUNT(*) n FROM credentials WHERE user_id=? AND revoked_at IS NULL').get(a.user_id).n,0);
});
test('ISO-WORKER-05: coordinator validates all storage while each child only traverses its own destinations',async t=>{
 const x=await setup(t),{validateWorkerConfig,workerPhase}=await import('../src/isolated-maintenance.mjs');
 // An inaccessible foreign destination is the coordinator's concern, not a reason
 // for granting the authorization child access to another service's directory.
 const worker=structuredClone(x.worker);worker.core.database_file='/dev/null/foreign.sqlite3';
 assert.throws(()=>validateWorkerConfig(worker,{isolated:true}),{errorCode:'INVALID_STORAGE_PATH'});
 assert.doesNotThrow(()=>workerPhase('auth',{config:worker,action:'plan'},{isolated:true}));
});

test('ISO-WORKER-06: explicit basic policy provisions narrow console keys and keeps Web read-only across retry',async t=>{
 const x=await setup(t),{runIsolatedMaintenance}=await import('../src/isolated-maintenance.mjs');
 x.worker.console_access='basic_memory';x.f.config.identity.console_basic_operations={memory:true,security:true,oauth:true};
 writePrivate(x.worker.auth.config_file,x.f.config,{replace:true});
 assert.throws(()=>runIsolatedMaintenance(x.worker,{isolated:true,afterPhase:name=>{if(name==='core.apply')throw new Error('synthetic retry');}}));
 const before=x.core.store.db.prepare('SELECT * FROM credentials ORDER BY credential_id').all();
 assert.equal(runIsolatedMaintenance(x.worker,{isolated:true}).completed,1);
 const a=x.ids.byId(x.account.account.account_id);assert.equal(a.status,'active');
 assert.deepEqual(x.core.store.db.prepare('SELECT * FROM credentials ORDER BY credential_id').all(),before);
 for(const b of x.ids.bindings(a.subject)){
  const scopes=x.core.store.authenticate(fs.readFileSync(b.credential_file,'utf8').trim()).scopes;
  assert.deepEqual(scopes,b.purpose==='web'?['memory:read','resume:read']:['memory:read','resume:read','console:read','memory:write','memory:organize']);
  assert.ok(!scopes.includes('console:write'));
 }
});
test('ISO-WORKER-07: basic provisioning requires matching root and auth policy, and refuses general writes',async t=>{
 const x=await setup(t),{runIsolatedMaintenance,validateWorkerConfig}=await import('../src/isolated-maintenance.mjs');
 x.worker.console_access='basic_memory';assert.throws(()=>runIsolatedMaintenance(x.worker,{isolated:true}));
 assert.equal(x.ids.byId(x.account.account.account_id).status,'provisioning');
 assert.throws(()=>validateWorkerConfig({...x.worker,console_access:'full'},{isolated:true}));
 x.f.config.identity.console_basic_operations={memory:true};x.f.config.identity.console_operations=true;writePrivate(x.worker.auth.config_file,x.f.config,{replace:true});
 assert.throws(()=>runIsolatedMaintenance(x.worker,{isolated:true}));
});

test('A-BASE-04/05: cloud binding is explicit, durable across interrupted publication and separate from old readonly credentials',async t=>{
 const x=await setup(t),{runIsolatedMaintenance}=await import('../src/isolated-maintenance.mjs');
 const {queueCloudBinding}=await import('../src/cloud-provisioning.mjs');
 runIsolatedMaintenance(x.worker,{isolated:true});const a=x.ids.byId(x.account.account.account_id);
 const old=x.core.store.db.prepare('SELECT * FROM credentials ORDER BY credential_id').all();
 assert.throws(()=>queueCloudBinding(x.ids,x.f.config,a.account_id,{allowSubmittedRevisionGrant:false}));
 x.f.config.cloud_memory={enabled:true,allow_submitted_revision_grant:false};x.f.config.resource_scopes.push('memory:write');x.f.config.chatgpt_client.allowed_scopes.push('memory:write');
 x.worker.cloud_memory={...x.f.config.cloud_memory};
 writePrivate(x.worker.auth.config_file,x.f.config,{replace:true});
 const op=queueCloudBinding(x.ids,x.f.config,a.account_id,{allowSubmittedRevisionGrant:false});
 assert.deepEqual(queueCloudBinding(x.ids,x.f.config,a.account_id,{allowSubmittedRevisionGrant:false}),op);
 assert.throws(()=>queueCloudBinding(x.ids,x.f.config,a.account_id,{allowSubmittedRevisionGrant:true}));
 assert.throws(()=>runIsolatedMaintenance(x.worker,{isolated:true,afterPhase:name=>{if(name==='core.apply-cloud')throw new Error('synthetic response loss');}}));
 const prepared=x.core.store.db.prepare('SELECT * FROM credentials ORDER BY credential_id').all();assert.equal(prepared.length,old.length+1);
 assert.equal(runIsolatedMaintenance(x.worker,{isolated:true}).cloud_completed,1);
 assert.deepEqual(x.core.store.db.prepare('SELECT * FROM credentials ORDER BY credential_id').all(),prepared);
 const map=JSON.parse(fs.readFileSync(x.worker.web.identity_map_file)),m=map.mappings.find(m=>m.account_id===a.account_id);
 assert.ok(m.cloud_write);assert.notEqual(m.credential_file,m.cloud_write.credential_file);
 assert.deepEqual(x.core.store.authenticate(fs.readFileSync(m.credential_file,'utf8').trim()).scopes,['memory:read','resume:read']);
 const write=x.core.store.authenticate(fs.readFileSync(m.cloud_write.credential_file,'utf8').trim());assert.deepEqual(write.scopes,['memory:read','resume:read','memory:write']);
 assert.equal(x.core.store.cloudMemory.binding(write).connection_id,m.cloud_write.connection_id);
 for(const previous of old)assert.deepEqual(x.core.store.db.prepare('SELECT * FROM credentials WHERE credential_id=?').get(previous.credential_id),previous);
 assert.equal(runIsolatedMaintenance(x.worker,{isolated:true}).cloud_completed,0);
 await x.maintenance.setState(a.account_id,'disable');runIsolatedMaintenance(x.worker,{isolated:true});assert.throws(()=>x.core.store.authenticate(fs.readFileSync(m.cloud_write.credential_file,'utf8').trim()));
 assert.equal(JSON.parse(fs.readFileSync(x.worker.web.identity_map_file)).mappings.find(m=>m.account_id===a.account_id)?.cloud_write,undefined);
});

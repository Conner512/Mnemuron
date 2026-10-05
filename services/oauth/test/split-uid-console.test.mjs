import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {consoleFixture,pendingAccount} from './helpers/identity-fixture.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {writePrivate,CORE_SCOPES} from '../../../shared/oauth-common.mjs';
// Test-side reads/writes of service-owned files (root may run the real-UID mode); existing files keep owner and mode.
const readKey=file=>fs.readFileSync(file,'utf8').trim(),overwrite=(file,value)=>fs.writeFileSync(file,value);
import {CONSOLE_READ_SCOPES,CONSOLE_BASIC_SCOPES,CONSOLE_WRITE_SCOPES,exactScopes} from '../../../shared/console-contract.mjs';
import {main as operatorCommand} from '../bin/console-operator.mjs';

// Synthetic split-service deployment. By default the phases run as separate child processes through private pipes
// under the current UID, as in the isolated worker tests. On a Linux test host, root can run the same tests with
// real distinct service UIDs: MNEMURON_SPLIT_UIDS=oauthUid:coreUid:webUid (each also used as the gid).
const REAL_UIDS=process.env.MNEMURON_SPLIT_UIDS?.split(':').map(Number);
if(REAL_UIDS)assert.ok(process.getuid()===0&&REAL_UIDS.length===3&&REAL_UIDS.every(n=>Number.isInteger(n)&&n>0)&&new Set(REAL_UIDS).size===3,'real-UID mode needs root and three distinct non-root UIDs');
const ISOLATED=!REAL_UIDS;
const chownTree=(dir,uid)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())chownTree(p,uid);else fs.chownSync(p,uid,uid);}fs.chownSync(dir,uid,uid);};
async function setup(t,{basic=false}={}){
 const core=await memoryFixture(t),f=await consoleFixture(t,{core}),ids=f.app.accounts;
 f.config.identity.provisioning={enabled:true,mode:'external_worker'};f.config.identity.console_operations=false;
 if(basic)f.config.identity.console_basic_operations={memory:true};
 const authFile=path.join(f.directory,'worker-auth.json');writePrivate(authFile,f.config);
 const owners=[];for(const name of ['Synthetic_Split_A','Synthetic_Split_B']){const o=await pendingAccount({identities:ids},name);ids.takeRecoveryCodes(o.session.token);ids.acknowledgeRecovery(o.session.token);owners.push(o);}
 const [oauthUid,coreUid,webUid]=REAL_UIDS||[process.getuid(),process.getuid(),process.getuid()],gid=uid=>REAL_UIDS?uid:process.getgid();
 const separate=prefix=>{if(!REAL_UIDS)return f.directory;const d=fs.mkdtempSync(path.join(os.tmpdir(),prefix));fs.chmodSync(d,0o700);t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
 const webDir=separate('synthetic-split-web-'),coordinatorDir=separate('synthetic-split-root-');
 const worker={config_version:'isolated-identity-worker-v1',...(basic?{console_access:'basic_memory'}:{}),
   auth:{uid:oauthUid,gid:gid(oauthUid),config_file:authFile,credential_directory:path.join(f.directory,'console-keys')},
   core:{uid:coreUid,gid:gid(coreUid),database_file:core.databasePath},
   web:{uid:webUid,gid:gid(webUid),credential_directory:path.join(webDir,'web-keys'),identity_map_file:path.join(webDir,'web-map.json')}};
 const workerFile=path.join(coordinatorDir,'identity-worker.json');writePrivate(workerFile,worker);
 if(REAL_UIDS){fs.mkdirSync(worker.auth.credential_directory,{mode:0o700});fs.mkdirSync(worker.web.credential_directory,{mode:0o700});
   chownTree(f.directory,oauthUid);chownTree(core.root,coreUid);chownTree(webDir,webUid);}
 const {runIsolatedMaintenance,runConsoleCapability}=await import('../src/isolated-maintenance.mjs');
 runIsolatedMaintenance(worker,{isolated:ISOLATED});
 const account=o=>ids.byId(o.account.account_id);
 const binding=(o,purpose)=>ids.bindings(account(o).subject).find(b=>b.purpose===purpose);
 const scopes=(o,purpose='console')=>JSON.parse(core.store.db.prepare('SELECT scopes_json FROM credentials WHERE credential_id=?').get(binding(o,purpose).credential_id).scopes_json);
 const audits=action=>core.store.db.prepare('SELECT * FROM audit_events WHERE action=? ORDER BY created_at').all(action);
 const enable=(o,command='enable-console')=>operatorCommand([command,'--worker-config',workerFile,'--account-id',account(o).account_id,'--confirm',...(ISOLATED?['--isolated-fixture']:[])]);
 const credentials=()=>core.store.db.prepare('SELECT * FROM credentials ORDER BY credential_id').all();
 return {core,f,ids,owners,worker,workerFile,account,binding,scopes,audits,enable,credentials,runConsoleCapability,runIsolatedMaintenance};
}
const quiet=async fn=>{const log=console.log;const out=[];console.log=v=>out.push(v);try{await fn();}finally{console.log=log;}return out.map(v=>JSON.parse(v));};

test('SPLIT-REPRO: the owner check that stops the single-process command rejects a private directory owned by another user',async t=>{
 // Deployment stack: console-operator.mjs:36 -> sqlite-adapter.mjs:9 -> oauth-common.mjs privateDirectory. The failing check
 // is called on a 0700 directory owned by another user: the real /root when not root, else a synthetic temporary directory.
 const {privateDirectory}=await import('../../../shared/oauth-common.mjs');let foreign='/root';
 if(process.getuid()===0){foreign=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-foreign-'));fs.chmodSync(foreign,0o700);fs.chownSync(foreign,65534,65534);t.after(()=>fs.rmSync(foreign,{recursive:true,force:true}));}
 assert.equal(fs.statSync(foreign).mode&0o777,0o700);assert.notEqual(fs.statSync(foreign).uid,process.getuid());
 assert.throws(()=>privateDirectory(foreign),/private directory permissions\/owner/);
});

test('SPLIT-01: enable-console through fixed service phases upgrades exactly the bound console credential, once, with an audit record',async t=>{
 const x=await setup(t),[a,b]=x.owners,webBefore=x.scopes(a,'web'),bBefore=x.scopes(b);
 assert.ok(exactScopes(x.scopes(a),CONSOLE_READ_SCOPES));
 const [result]=await quiet(()=>x.enable(a));
 assert.deepEqual(result,{status:'enabled',account_id:x.account(a).account_id,access:'full',changed:true,chatgpt_scopes_unchanged:true,split_uid:true});
 assert.ok(exactScopes(x.scopes(a),CONSOLE_WRITE_SCOPES));assert.deepEqual(x.scopes(a,'web'),webBefore,'the ChatGPT credential is untouched');
 assert.deepEqual(x.scopes(b),bBefore,'another account is never changed');
 const [audit]=x.audits('console.capability.enable');assert.equal(audit.target_id,x.binding(a,'console').credential_id);assert.equal(audit.user_id,x.account(a).user_id);
 assert.deepEqual(JSON.parse(audit.metadata_json),{split_uid:true});assert.ok(!JSON.stringify(audit).includes(readKey(x.binding(a,'console').credential_file)),'no key in the audit');
 const [again]=await quiet(()=>x.enable(a));assert.equal(again.changed,false);assert.equal(x.audits('console.capability.enable').length,1,'a repeat writes nothing');
 assert.equal(x.runIsolatedMaintenance(x.worker,{isolated:ISOLATED}).completed,0);assert.ok(exactScopes(x.scopes(a),CONSOLE_WRITE_SCOPES),'the worker leaves the enabled credential alone');
 assert.ok(!fs.existsSync(x.workerFile+'.process-lock'),'the coordinator lease is released');
});

test('SPLIT-02: wrong, unknown, disabled and tampered accounts fail closed without writing',async t=>{
 const x=await setup(t),[a,b]=x.owners,before=x.credentials();
 const run=(request,o={})=>x.runConsoleCapability(x.worker,request,{isolated:ISOLATED,...o});
 assert.throws(()=>run({account_id:'synthetic-unknown',access:'full'}),/IDENTITY_WORKER_AUTH_FAILED/);
 assert.throws(()=>run({account_id:x.account(a).account_id,access:'admin'}),/exact console capability request/);
 assert.throws(()=>run({account_id:x.account(a).account_id,access:'full',extra:true}),/exact console capability request/);
 // The OAuth binding file holds a different (valid-looking) key: Core refuses to change anything.
 const file=x.binding(a,'console').credential_file,original=fs.readFileSync(file);
 overwrite(file,readKey(x.binding(b,'console').credential_file));
 assert.throws(()=>run({account_id:x.account(a).account_id,access:'full'}),/IDENTITY_WORKER_CORE_FAILED/);overwrite(file,original);
 // A revoked Core credential is never upgraded.
 x.core.store.db.prepare('UPDATE credentials SET revoked_at=? WHERE credential_id=?').run(new Date().toISOString(),x.binding(b,'console').credential_id);
 assert.throws(()=>run({account_id:x.account(b).account_id,access:'full'}),/IDENTITY_WORKER_CORE_FAILED/);
 x.core.store.db.prepare('UPDATE credentials SET revoked_at=NULL WHERE credential_id=?').run(x.binding(b,'console').credential_id);
 x.ids.db.prepare("UPDATE identity_accounts SET status='disabled' WHERE account_id=?").run(x.account(a).account_id);
 assert.throws(()=>run({account_id:x.account(a).account_id,access:'full'}),/IDENTITY_WORKER_AUTH_FAILED/);
 assert.deepEqual(x.credentials(),before);assert.equal(x.audits('console.capability.enable').length,0);
});

test('SPLIT-03: an interruption after the Core change is safely retried; a mid-operation account change is undone',async t=>{
 const x=await setup(t),[a,b]=x.owners,run=(o,options={})=>x.runConsoleCapability(x.worker,{account_id:x.account(o).account_id,access:'full'},{isolated:ISOLATED,...options});
 assert.throws(()=>run(a,{afterPhase:name=>{if(name==='core.console-capability-apply')throw new Error('Synthetic coordinator interruption');}}),/Synthetic coordinator interruption/);
 assert.ok(exactScopes(x.scopes(a),CONSOLE_WRITE_SCOPES),'the Core change is complete and atomic');
 const retried=run(a);assert.equal(retried.changed,false);assert.equal(x.audits('console.capability.enable').length,1);
 // The account is disabled between the Core change and the final check: the change is restored and audited.
 const bCredential=x.binding(b,'console').credential_id,bAccount=x.account(b).account_id;
 const bScopes=()=>JSON.parse(x.core.store.db.prepare('SELECT scopes_json FROM credentials WHERE credential_id=?').get(bCredential).scopes_json);
 assert.throws(()=>run(b,{afterPhase:name=>{if(name==='core.console-capability-apply'){assert.ok(exactScopes(bScopes(),CONSOLE_WRITE_SCOPES));x.ids.db.prepare("UPDATE identity_accounts SET status='disabled' WHERE account_id=?").run(bAccount);}}}),/CONSOLE_CAPABILITY_STALE/);
 assert.ok(exactScopes(bScopes(),CONSOLE_READ_SCOPES));assert.equal(x.audits('console.capability.restore').length,1);
 assert.throws(()=>x.runConsoleCapability(x.worker,{account_id:bAccount,access:'full'},{isolated:ISOLATED}),/IDENTITY_WORKER_AUTH_FAILED/,'a retry for the disabled account is refused');
 assert.ok(exactScopes(bScopes(),CONSOLE_READ_SCOPES));
});

test('SPLIT-04: basic access follows the basic policy; the isolated worker still refuses general writes',async t=>{
 const plain=await setup(t);
 await assert.rejects(()=>quiet(()=>plain.enable(plain.owners[0],'enable-console-basic')),/IDENTITY_WORKER_AUTH_FAILED/);
 const x=await setup(t,{basic:true}),[a]=x.owners;assert.ok(exactScopes(x.scopes(a),CONSOLE_BASIC_SCOPES));
 const [basic]=await quiet(()=>x.enable(a,'enable-console-basic'));assert.equal(basic.changed,false);
 const [full]=await quiet(()=>x.enable(a));assert.equal(full.changed,true);assert.ok(exactScopes(x.scopes(a),CONSOLE_WRITE_SCOPES));
 assert.ok(exactScopes(x.scopes(a,'web'),CORE_SCOPES));
 x.f.config.identity.console_operations=true;overwrite(x.worker.auth.config_file,JSON.stringify(x.f.config));
 assert.throws(()=>x.runIsolatedMaintenance(x.worker,{isolated:ISOLATED}),/IDENTITY_WORKER_AUTH_FAILED/);
 await assert.rejects(()=>quiet(()=>x.enable(x.owners[1])),/IDENTITY_WORKER_AUTH_FAILED/,'the shared auth guard also applies to enable-console');
});

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
// The fixture's OAuth config is loopback HTTP, which production validation correctly rejects (HTTPS), so the
// phases always use the test-harness config flag. It does not affect UID switching: every phase child is spawned
// with its configured uid/gid and checks process.getuid() itself. Real-UID mode additionally asserts the production
// worker-config validation and the resulting file ownership.
const REAL_UIDS=process.env.MNEMURON_SPLIT_UIDS?.split(':').map(Number);
const ISOLATED=true;
const PHASE_MODULE=new URL('../src/isolated-maintenance.mjs',import.meta.url).pathname;
/** Everything a real-UID run needs before any fixture is built; returns readable problems instead of failing later. */
// `boundary` limits the ancestor walk to a synthetic tree; real-UID runs leave it unset and check every ancestor.
export function realUidPrerequisites(uids,{uid=process.getuid(),tmpdir=os.tmpdir(),files=[[PHASE_MODULE,0o004],[process.execPath,0o001]],boundary}={}){
  const problems=[];
  if(uid!==0)problems.push('run as root (the coordinator launches each phase under its service uid)');
  if(!Array.isArray(uids)||uids.length!==3||!uids.every(n=>Number.isInteger(n)&&n>0)||new Set(uids).size!==3)problems.push('MNEMURON_SPLIT_UIDS needs three distinct non-root uids oauth:core:web');
  if((fs.statSync(tmpdir).mode&0o001)===0)problems.push(`temporary directory ${tmpdir} is not traversable by service uids; set TMPDIR=/tmp`);
  for(const [file,bit] of files){
    if((fs.statSync(file).mode&bit)===0)problems.push(`${file} is not ${bit===0o004?'readable':'executable'} by service uids`);
    for(let dir=path.dirname(file);dir!==path.dirname(dir);dir=path.dirname(dir)){if((fs.statSync(dir).mode&0o001)===0){problems.push(`${dir} is not traversable by service uids`);break;}if(dir===boundary)break;}}
  return problems;
}
if(REAL_UIDS){const problems=realUidPrerequisites(REAL_UIDS);assert.deepEqual(problems,[],'real-UID prerequisites: '+problems.join('; '));}
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
 const {runIsolatedMaintenance,runConsoleCapability,validateWorkerConfig}=await import('../src/isolated-maintenance.mjs');
 // Real-UID mode: the production validation (distinct non-root identities, fixed private paths) must accept this config.
 if(REAL_UIDS)validateWorkerConfig(worker,{isolated:false});
 runIsolatedMaintenance(worker,{isolated:ISOLATED});
 if(REAL_UIDS){
   // Each phase really ran under its own uid: published files belong to the service that wrote them.
   const owner=file=>fs.statSync(file).uid;
   for(const o of owners){const a=ids.byId(o.account.account_id),bs=ids.bindings(a.subject);
     assert.equal(owner(bs.find(b=>b.purpose==='console').credential_file),oauthUid);assert.equal(owner(bs.find(b=>b.purpose==='web').credential_file),webUid);}
   assert.equal(owner(worker.web.identity_map_file),webUid);assert.equal(owner(core.databasePath),coreUid);
 }
 const account=o=>ids.byId(o.account.account_id);
 const binding=(o,purpose)=>ids.bindings(account(o).subject).find(b=>b.purpose===purpose);
 const scopes=(o,purpose='console')=>JSON.parse(core.store.db.prepare('SELECT scopes_json FROM credentials WHERE credential_id=?').get(binding(o,purpose).credential_id).scopes_json);
 const audits=action=>core.store.db.prepare('SELECT * FROM audit_events WHERE action=? ORDER BY created_at').all(action);
 const enable=(o,command='enable-console')=>operatorCommand([command,'--worker-config',workerFile,'--account-id',account(o).account_id,'--confirm',...(ISOLATED?['--isolated-fixture']:[])]);
 const credentials=()=>core.store.db.prepare('SELECT * FROM credentials ORDER BY credential_id').all();
 return {core,f,ids,owners,worker,workerFile,account,binding,scopes,audits,enable,credentials,runConsoleCapability,runIsolatedMaintenance};
}
const quiet=async fn=>{const log=console.log;const out=[];console.log=v=>out.push(v);try{await fn();}finally{console.log=log;}return out.map(v=>JSON.parse(v));};

test('SPLIT-CONFIG: real-UID construction is checked without root: prerequisites, production worker validation and why the harness flag is needed',async t=>{
 // Prerequisite logic on synthetic directories (no host change).
 const open=fs.mkdtempSync(path.join(os.tmpdir(),'synthetic-open-'));t.after(()=>fs.rmSync(open,{recursive:true,force:true}));
 fs.chmodSync(open,0o755);const module=path.join(open,'phase.mjs');fs.writeFileSync(module,'');fs.chmodSync(module,0o644);
 const closed=path.join(open,'private');fs.mkdirSync(closed,{mode:0o700});
 // Synthetic files only: the walk stops at the fixture root, so the host's own temporary-directory parents do not matter.
 const check=(uids,o={})=>realUidPrerequisites(uids,{uid:0,tmpdir:open,files:[[module,0o004]],boundary:open,...o});
 assert.deepEqual(check([61001,61002,61003]),[]);
 assert.match(check([61001,61001,61003]).join(),/three distinct non-root uids/);assert.match(check([0,61002,61003]).join(),/three distinct non-root uids/);
 assert.match(check([61001,61002,61003],{uid:1000}).join(),/run as root/);
 assert.match(check([61001,61002,61003],{tmpdir:closed}).join(),/TMPDIR=\/tmp/);
 const hidden=path.join(closed,'phase.mjs');fs.writeFileSync(hidden,'');fs.chmodSync(hidden,0o644);
 assert.match(check([61001,61002,61003],{files:[[hidden,0o004]]}).join(),/not traversable/);
 // Without a boundary (the real-UID gate) every ancestor is checked: a closed ancestor above the fixture is reported.
 const nested=path.join(closed,'open-inside');fs.mkdirSync(nested);fs.chmodSync(nested,0o755);const deep=path.join(nested,'phase.mjs');fs.writeFileSync(deep,'');fs.chmodSync(deep,0o644);
 assert.match(realUidPrerequisites([61001,61002,61003],{uid:0,tmpdir:open,files:[[deep,0o004]]}).join(),new RegExp(`${closed.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')} is not traversable`));
 assert.match(check([61001,61002,61003],{files:[[deep,0o004]],boundary:nested}).join(),/^$/);
 // The production worker-config validation (distinct non-root identities, fixed private paths) for the real-UID layout.
 const {validateWorkerConfig}=await import('../src/isolated-maintenance.mjs');
 const worker=(a,c,w)=>({config_version:'isolated-identity-worker-v1',auth:{uid:a,gid:a,config_file:path.join(open,'auth.json'),credential_directory:path.join(open,'console-keys')},
   core:{uid:c,gid:c,database_file:path.join(open,'core.sqlite3')},web:{uid:w,gid:w,credential_directory:path.join(open,'web-keys'),identity_map_file:path.join(open,'web-map.json')}});
 assert.doesNotThrow(()=>validateWorkerConfig(worker(61001,61002,61003),{isolated:false}));
 for(const ids of [[61001,61001,61003],[0,61002,61003]])assert.throws(()=>validateWorkerConfig(worker(...ids),{isolated:false}),/distinct unprivileged service identities/);
 // The loopback fixture config is rejected by production validation (the deployment gate failure) and accepted by the harness flag.
 const {loadAuthConfig}=await import('../src/config.mjs'),core=await memoryFixture(t),f=await consoleFixture(t,{core});
 f.config.identity.provisioning={enabled:true,mode:'external_worker'};const file=path.join(f.directory,'worker-auth.json');writePrivate(file,f.config);
 assert.throws(()=>loadAuthConfig(file,{isolated:false}),/HTTPS/);assert.doesNotThrow(()=>loadAuthConfig(file,{isolated:true}));
});

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

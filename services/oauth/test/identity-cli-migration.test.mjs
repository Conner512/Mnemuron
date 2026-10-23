import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {backup} from 'node:sqlite';
import {fixture} from './fixture.mjs';
import {AuthStore} from '../src/sqlite-adapter.mjs';
import {IdentityRepository} from '../src/identity-repository.mjs';
import {acquireAuthorizationLease} from '../src/process-lease.mjs';
import {MnemuronStore} from '../../../server/lib/store.mjs';
import {memoryFixture,businessSnapshot} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {pendingAccount} from './helpers/identity-fixture.mjs';
import {readPrivate,writePrivate,randomSecret} from '../../../shared/oauth-common.mjs';

function multiConfig(f) {
 const config={...f.config,identity_mode:'multi_account_v1',identity:{encryption_key_file:path.join(f.directory,'identity-key'),invitation_batch_limit:3,console_session_ttl_seconds:600}};
 writePrivate(config.identity.encryption_key_file,randomSecret());
 const file=path.join(f.directory,'multi.json');writePrivate(file,config);return {config,file};
}
const cli=(file,...args)=>spawnSync(process.execPath,['services/oauth/bin/identity.mjs',args[0],'--config',file,'--isolated-fixture',...args.slice(1)],{encoding:'utf8',timeout:15000});

test('INV-01..07 INV-13: actual CLI has strict arguments and private one-time output',async t=>{
 const f=await fixture(t,{start:false}),{file,config}=multiConfig(f),output=path.join(f.directory,'batch.json');
 const args=['invite-issue','--count','3','--ttl-minutes','1440','--issuer','synthetic-operator','--output',output];
 const created=cli(file,...args);assert.equal(created.status,0,created.stderr);
 const batch=readPrivate(output,{json:true});assert.equal(batch.codes.length,3);
 assert.equal(fs.statSync(output).mode&0o777,0o600);assert.ok(batch.codes.every(code=>!created.stdout.includes(code)&&!created.stderr.includes(code)));
 assert.notEqual(cli(file,...args).status,0,'no overwrite');
 for(const [count,ttl] of [['0','1'],['4','1'],['1','1.5'],['1','0'],['1','1441']])
  assert.notEqual(cli(file,'invite-issue','--count',count,'--ttl-minutes',ttl,'--issuer','synthetic','--output',path.join(f.directory,'invalid.json')).status,0);
 assert.equal(fs.existsSync(path.join(f.directory,'invalid.json')),false);
 assert.notEqual(cli(file,'status','--role','admin').status,0,'unknown options are not silently ignored');
 assert.notEqual(cli(file,'invite-issue','--count','1','--ttl-minutes','1','--issuer','synthetic','--output',path.resolve('synthetic-invite-MUST-NOT-EXIST.json')).status,0);
 assert.equal(fs.existsSync(path.resolve('synthetic-invite-MUST-NOT-EXIST.json')),false);
 const list=cli(file,'invite-list');assert.equal(list.status,0);assert.ok(batch.codes.every(code=>!list.stdout.includes(code)));
 assert.equal(cli(file,'invite-revoke','--batch-id',batch.batch_id,'--confirm').status,0);
 const store=new AuthStore(config.database_file,{identity:true});t.after(()=>store.close());
 const ids=new IdentityRepository(store,{issuer:config.issuer,keyFile:config.identity.encryption_key_file,batchLimit:3,sessionTtl:600});
 assert.equal(ids.listInvitations().length,3);assert.ok(ids.listInvitations().every(i=>i.state==='revoked'));
});

test('BASE-03..07: nonempty migration, repeat, exclusive lease and isolated restore preserve old and new data',async t=>{
 const f=await fixture(t),core=await memoryFixture(t);
 const authorization=await f.authorize();assert.equal((await f.exchange(authorization)).status,200);await f.stop();
 const memory=core.store.saveMemory(core.a.auth,{scope:'user',content:'Synthetic legacy record and provenance',operation_id:'legacy-operation'}).memory;
 const before=businessSnapshot(core.store),sourceBefore=core.store.db.prepare('SELECT * FROM memory_sources ORDER BY rowid').all(),revisionBefore=core.store.db.prepare('SELECT * FROM memory_revisions ORDER BY rowid').all();
 const owner=readPrivate(f.config.accounts_file,{json:true}),ownerBytes=fs.readFileSync(f.config.accounts_file);
 const {file,config}=multiConfig(f),mapping=path.join(f.directory,'legacy-map.json');
 writePrivate(mapping,{mappings:[{issuer:config.issuer,subject:owner.subject,mnemuron_user_id:core.a.auth.user_id,agent_instance_id:'legacy-web',enabled:true}]});
 const old=new AuthStore(config.database_file),records=old.db.prepare('SELECT * FROM oauth_records ORDER BY model,id').all();t.after(()=>old.close());
 const release=acquireAuthorizationLease(config.database_file);
 try {assert.notEqual(cli(file,'migrate-owner','--legacy-file',f.config.accounts_file,'--mapping-file',mapping,'--confirm').status,0);}
 finally {release();}
 const migrate=()=>cli(file,'migrate-owner','--legacy-file',f.config.accounts_file,'--mapping-file',mapping,'--confirm');
 const first=migrate();assert.equal(first.status,0,first.stderr);const second=migrate();assert.equal(second.status,0,second.stderr);
 assert.equal(JSON.parse(first.stdout).account_id,JSON.parse(second.stdout).account_id);
 assert.throws(()=>old.csrf('legacy-writer',60),/incompatible|multi.account/i);
 assert.equal(cli(file,'provision','--core-database',core.databasePath,'--credential-directory',path.join(f.directory,'keys'),'--identity-map',path.join(f.directory,'map.json'),'--confirm').status,0);
 const store=new AuthStore(config.database_file,{identity:true});t.after(()=>store.close());
 const ids=new IdentityRepository(store,{issuer:config.issuer,keyFile:config.identity.encryption_key_file,batchLimit:3,sessionTtl:600});
 assert.equal(ids.principal(owner.subject).user_id,core.a.auth.user_id);assert.deepEqual(fs.readFileSync(f.config.accounts_file),ownerBytes);
 assert.deepEqual(businessSnapshot(core.store),before);assert.deepEqual(core.store.db.prepare('SELECT * FROM memory_sources ORDER BY rowid').all(),sourceBefore);
 assert.deepEqual(core.store.db.prepare('SELECT * FROM memory_revisions ORDER BY rowid').all(),revisionBefore);
 assert.deepEqual(store.db.prepare('SELECT * FROM oauth_records ORDER BY model,id').all(),records);
 const restoredDirectory=path.join(f.directory,'isolated-restored-copy');fs.mkdirSync(restoredDirectory,{mode:0o700});
 const authBackup=path.join(restoredDirectory,'auth.sqlite3'),coreBackup=path.join(restoredDirectory,'core.sqlite3');
 await backup(store.db,authBackup);await backup(core.store.db,coreBackup);fs.chmodSync(authBackup,0o600);fs.chmodSync(coreBackup,0o600);
 const added=await pendingAccount({identities:ids},'Synthetic_After_Backup');
 const addedMemory=core.store.saveMemory(core.a.auth,{scope:'user',content:'Synthetic post-backup memory must survive'}).memory;
 const restoredAuth=new AuthStore(authBackup,{identity:true}),restoredCore=new MnemuronStore(coreBackup);
 try {
  const restoredIds=new IdentityRepository(restoredAuth,{issuer:config.issuer,keyFile:config.identity.encryption_key_file,batchLimit:3,sessionTtl:600});
  assert.equal(restoredIds.account(owner.subject).user_id,core.a.auth.user_id);assert.equal(restoredIds.byId(added.account.account_id),undefined);
  assert.deepEqual(businessSnapshot(restoredCore),before);assert.equal(restoredCore.db.prepare('SELECT memory_id FROM memories WHERE memory_id=?').get(memory.memory_id).memory_id,memory.memory_id);
  assert.equal(fs.statSync(authBackup).mode&0o777,0o600);
 } finally {restoredAuth.close();restoredCore.close();}
 assert.ok(ids.byId(added.account.account_id));assert.ok(core.store.db.prepare('SELECT 1 FROM memories WHERE memory_id=?').get(addedMemory.memory_id));
});

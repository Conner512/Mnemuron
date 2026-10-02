import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {MnemuronStore} from '../../../server/lib/store.mjs';
import {AuthStore} from '../src/sqlite-adapter.mjs';
import {IdentityRepository} from '../src/identity-repository.mjs';
import {readPrivate} from '../../../shared/oauth-common.mjs';

const root=path.resolve(import.meta.dirname,'../../..');
const baseline='6eb46980dcb7d78a3335b32fd4875f5586b675f7';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tableHash=(db,table)=>digest(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

test('RELEASE-01 paired Core/OAuth upgrade, old-reader refusal and isolated restore preserve two owners',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mnemuron-release-upgrade-'));fs.chmodSync(dir,0o700);
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const old=path.join(dir,'source'),live=path.join(dir,'live'),before=path.join(dir,'before'),restored=path.join(dir,'restored');
 fs.mkdirSync(old);fs.mkdirSync(live,{mode:0o700});
 const archive=execFileSync('git',['archive',baseline],{cwd:root,maxBuffer:32*1024*1024});
 execFileSync('tar',['-x','-C',old],{input:archive});
 for(const part of ['services/oauth','adapters/chatgpt-web'])fs.symlinkSync(path.join(root,part,'node_modules'),path.join(old,part,'node_modules'),'dir');
 const seed=spawnSync(process.execPath,[path.join(root,'services/oauth/test/helpers/release-upgrade-seed.mjs'),old,live],{encoding:'utf8',timeout:15000});
 assert.equal(seed.status,0,seed.stderr);assert.deepEqual(JSON.parse(seed.stdout),{seeded:2});
 // Both writers are stopped. Copy both DBs and their matching encryption keys/map.
 fs.cpSync(live,before,{recursive:true});fs.chmodSync(before,0o700);
 const records=readPrivate(path.join(live,'fixture.json'),{json:true});
 assert.ok(records.every(r=>r.legacy_private_visible),'fixture reproduces the old read_all/private conflict');
 const oldCore=new DatabaseSync(path.join(before,'core.sqlite3'),{readOnly:true});
 const oldAuth=new DatabaseSync(path.join(before,'oauth.sqlite3'),{readOnly:true});
 const business=tableHash(oldCore,'memories'),receipts=tableHash(oldCore,'cloud_memory_operations'),identities=tableHash(oldAuth,'identity_accounts');
 oldCore.close();oldAuth.close();
 const open=directory=>{
  const core=new MnemuronStore(path.join(directory,'core.sqlite3'));
  const auth=new AuthStore(path.join(directory,'oauth.sqlite3'),{identity:true});
  const ids=new IdentityRepository(auth,{keyFile:path.join(directory,'identity-key'),issuer:'http://127.0.0.1:49001',batchLimit:10,sessionTtl:3600});
  const principal=(record,purpose)=>{
   const row=ids.db.prepare('SELECT * FROM identity_bindings WHERE account_id=? AND purpose=?').get(record.account_id,purpose);
   return core.authenticate(readPrivate(path.join(directory,'keys',path.basename(row.credential_file))));
  };
  return {core,auth,ids,principal,close(){core.close();auth.close();}};
 };
 let f=open(live);
 try{
  assert.equal(tableHash(f.core.db,'memories'),business);
  assert.equal(tableHash(f.core.db,'cloud_memory_operations'),receipts);
  assert.equal(tableHash(f.auth.db,'identity_accounts'),identities);
  assert.equal(f.core.db.prepare('PRAGMA user_version').get().user_version,7);
  for(const r of records){
   assert.ok(f.ids.eligible(r.subject));
   const own=f.principal(r,'console'),web=f.principal(r,'web'),foreign=records.find(x=>x!==r);
   assert.equal(f.core.memoryDetail(own,r.memory_id).memory.memory_id,r.memory_id);
   assert.equal(f.core.webVisibility.visible(web,r.private_id),false);
   assert.throws(()=>f.core.memoryDetail(own,foreign.memory_id));
  }
  f.core.saveMemory(f.principal(records[0],'console'),{scope:'user',content:'Synthetic post-upgrade write that must survive rollback'});
  const {account_id}=records[0];
  f.auth.db.prepare("INSERT INTO oauth_records(model,id,payload,expires) VALUES(?,?,?,?)").run('Grant','synthetic-grant',JSON.stringify({accountId:records[0].subject}),Math.floor(Date.now()/1000)+3600);
  f.auth.db.prepare("INSERT INTO oauth_records(model,id,payload,expires,grant_id) VALUES(?,?,?,?,?)").run('AccessToken','synthetic-restored-token',JSON.stringify({accountId:records[0].subject}),Math.floor(Date.now()/1000)+3600,'synthetic-grant');
  f.ids.newSession('console',{accountId:account_id});
 }finally{f.close();}
 // Old readers must reject the new privacy contract, not simply tolerate its new table.
 const probe=`import {MnemuronStore} from ${JSON.stringify(new URL('file://'+path.join(old,'server/lib/store.mjs')).href)};try{const s=new MnemuronStore(process.argv[1]);s.close();process.exit(2)}catch(e){if(e.code!=='SCHEMA_VERSION_UNSUPPORTED')process.exit(3)}`;
 const downgrade=spawnSync(process.execPath,['--input-type=module','-e',probe,path.join(live,'core.sqlite3')],{encoding:'utf8'});
 assert.equal(downgrade.status,0,'previous release refuses schema 7');
 // Snapshot current state after stopping both writers, keeping post-upgrade data.
 fs.cpSync(live,restored,{recursive:true});fs.chmodSync(restored,0o700);fs.chmodSync(path.join(restored,'keys'),0o700);
 f=open(restored);
 try{
  for(const db of [f.core.db,f.auth.db])assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  assert.equal(f.core.db.prepare('SELECT count(*) n FROM memories').get().n,5);
  assert.equal(f.auth.db.prepare('SELECT count(*) n FROM identity_accounts').get().n,2);
  assert.equal(tableHash(f.auth.db,'identity_accounts'),identities);
  assert.equal(f.core.webVisibility.visible(f.principal(records[0],'web'),records[0].private_id),false);
  // A recovered auth snapshot must not revive captured bearer tokens or console sessions.
  f.auth.revoke({all:true});f.auth.db.exec('DELETE FROM identity_sessions; DELETE FROM identity_recovery_claims');
  assert.equal(f.auth.db.prepare('SELECT count(*) n FROM oauth_records').get().n,0);
  assert.equal(f.auth.db.prepare('SELECT count(*) n FROM identity_sessions').get().n,0);
  assert.ok(f.ids.eligible(records[1].subject));
 }finally{f.close();}
 // Restoring the older snapshot is visibly stale and is never used to replace live.
 const stale=new DatabaseSync(path.join(before,'core.sqlite3'),{readOnly:true});
 assert.equal(stale.prepare('SELECT count(*) n FROM memories').get().n,4);stale.close();
 f=open(live);try{assert.equal(f.core.db.prepare('SELECT count(*) n FROM memories').get().n,5);}finally{f.close();}
});

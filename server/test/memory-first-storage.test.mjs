import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,symlinkSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {storageDoctor,realDestination} from '../lib/storage-policy.mjs';
import {memoryRuntime,loadMemoryRuntimeFile} from '../lib/memory-runtime.mjs';
import {MnemuronStore} from '../lib/store.mjs';

function directories(t) {
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-storage-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),data=path.join(root,'data');
  mkdirSync(source);mkdirSync(data);mkdirSync(path.join(source,'.git'));
  return {root,source,data};
}
test('P-12 P-13: all private path kinds reject source worktrees, linked worktrees and new symlink children', t=>{
  const f=directories(t),link=path.join(f.data,'link');symlinkSync(f.source,link);
  for(const field of ['sqlite_path','config_file','secrets_file','objects_dir','exports_dir','backup_dir','vector_data_dir','snapshot_dir','job_spool_dir']) {
    for(const target of [f.source+'/runtime',link+'/new/child',f.data+'/../source/new']) {
      assert.throws(()=>storageDoctor({[field]:target}),e=>e.errorCode==='PRIVATE_PATH_IN_SOURCE');
    }
    assert.equal(storageDoctor({[field]:f.data+'/new/'+field}).status,'passed');
  }
  const repo=path.join(f.root,'repo'),checkout=path.join(f.root,'checkout');
  mkdirSync(repo);const git=args=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});
  git(['init','--quiet']);git(['-c','user.name=Example','-c','user.email=example@example.com','-c','commit.gpgsign=false','commit','--allow-empty','-qm','Synthetic root']);
  git(['worktree','add','--detach',checkout]);
  assert.throws(()=>storageDoctor({config_file:checkout+'/new.json'},{sourceRoots:[repo]}),e=>e.errorCode==='PRIVATE_PATH_IN_SOURCE');
});
test('P-12: service and doctor entrypoints parse; doctor requires a guarded database path without opening one',t=>{
  const f=directories(t);
  for (const file of ['mnemuron-server.mjs','mnemuron-storage-doctor.mjs']) execFileSync(process.execPath,['--check',new URL('../bin/'+file,import.meta.url).pathname]);
  const config={config_version:'mnemuron-memory-first-v1',modules:{memory:{enabled:true},handoff:{enabled:false,existing_inflight_policy:'drain_before_disable'}},storage:{sqlite_path:f.data+'/never-created.sqlite3'}};
  const file=f.data+'/runtime.json';writeFileSync(file,JSON.stringify(config),{mode:0o600});
  const result=JSON.parse(execFileSync(process.execPath,[new URL('../bin/mnemuron-storage-doctor.mjs',import.meta.url).pathname,'--config',file],{encoding:'utf8'}));
  assert.equal(result.database_opened,false);assert.equal(result.credentials_read,false);assert.equal(existsSync(config.storage.sqlite_path),false);
  delete config.storage.sqlite_path;writeFileSync(file,JSON.stringify(config));
  assert.throws(()=>execFileSync(process.execPath,[new URL('../bin/mnemuron-storage-doctor.mjs',import.meta.url).pathname,'--config',file],{stdio:'pipe'}));
});
test('P-13: link followed by parent traversal uses filesystem semantics, not lexical prefixes',t=>{
  const f=directories(t);mkdirSync(f.source+'/child');symlinkSync(f.source+'/child',f.data+'/link');
  assert.equal(realDestination(f.data+'/link/../new.sqlite3'),realDestination(f.source+'/new.sqlite3'));
  assert.throws(()=>new MnemuronStore(f.data+'/link/../new.sqlite3'),e=>e.errorCode==='PRIVATE_PATH_IN_SOURCE');
  assert.equal(existsSync(f.source+'/new.sqlite3'),false);
  symlinkSync(f.root+'/missing',f.data+'/dangling');
  assert.throws(()=>storageDoctor({sqlite_path:f.data+'/dangling/new'}),e=>e.errorCode==='INVALID_STORAGE_PATH');
});
test('P-14 C-06: development exception is explicit, synthetic and confined to .dev; doctor never migrates',t=>{
  const f=directories(t),target=f.source+'/.dev/test.sqlite3';
  assert.throws(()=>storageDoctor({sqlite_path:target},{deploymentMode:'production',syntheticData:true}),e=>e.errorCode==='PRIVATE_PATH_IN_SOURCE');
  assert.throws(()=>storageDoctor({sqlite_path:target},{deploymentMode:'development'}),e=>e.errorCode==='SYNTHETIC_DATA_REQUIRED');
  const result=storageDoctor({sqlite_path:target},{deploymentMode:'test',syntheticData:true});
  assert.equal(result.status,'passed');assert.equal(result.migration_applied,false);assert.equal(result.data_read,false);assert.equal(existsSync(target),false);
  assert.throws(()=>storageDoctor({sqlite_path:f.source+'/arbitrary/test.sqlite3'},{deploymentMode:'test',syntheticData:true}));
});
test('P-12: runtime file is rejected before reading from source; disabled providers cannot silently activate',t=>{
  const f=directories(t),file=f.source+'/runtime.json';writeFileSync(file,'private-not-json');
  assert.throws(()=>loadMemoryRuntimeFile(file),e=>e.errorCode==='PRIVATE_PATH_IN_SOURCE');
  const config={config_version:'mnemuron-memory-first-v1',modules:{memory:{enabled:true},handoff:{enabled:false,existing_inflight_policy:'drain_before_disable'}}};
  assert.equal(memoryRuntime(config).handoff,false);
  assert.throws(()=>memoryRuntime({...config,providers:{organizer:{enabled:true}}}),e=>e.errorCode==='INVALID_MEMORY_CONFIG');
  assert.throws(()=>memoryRuntime({...config,storage:{reject_private_paths_inside_git_worktree:false}}),e=>e.errorCode==='INVALID_STORAGE_POLICY');
});

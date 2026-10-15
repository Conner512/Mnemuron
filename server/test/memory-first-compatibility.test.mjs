import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync,statSync,symlinkSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {fixture,organizer,taxonomy} from './helpers/memory-models.mjs';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {MemoryWorker,scheduleLibrary} from '../lib/memory-jobs/worker.mjs';
import {createMemoryBackup,verifyMemoryBackup,restoreIsolatedBackup,databaseManifest} from '../lib/memory/backup.mjs';
import {hash} from '../lib/memory/revisions.mjs';
import {memoryCommand} from '../bin/mnemuron-memory.mjs';
import {createMnemuronApp} from '../lib/app.mjs';
const admin=f=>({...f.auth,scopes:[...f.auth.scopes,'memory:sources:read','memory:retention','memory:organize']});
test('C-01 C-02: existing read requests unchanged; additional reads cannot grant maintenance scopes',async t=>{
  const f=fixture(t);f.save('Synthetic readonly memory');
  const before=f.s.db.prepare('SELECT COUNT(*) AS n FROM memory_jobs').get().n;
  const plain=f.s.queryMemories(f.auth,{query:'readonly'}),compat=await f.s.searchMemories(f.auth,{query:'readonly'});assert.deepEqual(plain.results,compat.results);
  assert.equal(f.s.memorySummaries(f.auth,{scope:'user'}).read_only,true);assert.equal(f.s.db.prepare('SELECT COUNT(*) AS n FROM memory_jobs').get().n,before);
  assert.throws(()=>f.s.memorySources.privacyImpact(f.auth,[plain.results[0].memory_id]),e=>e.statusCode===403);
  assert.throws(()=>f.s.derivedMemory.setCategory(f.auth,plain.results[0].memory_id,'preferences',taxonomy),e=>e.statusCode===403);
  assert.equal((await f.s.searchMemories(f.auth,{query:'readonly',mode:'hybrid'})).retrieval.degraded,true);
});
test('C-03 C-04: 73-source manifest and long Unicode source round trip; explicit pins alone resist pruning',t=>{
  const f=fixture(t),auth=admin(f),body='```js\n'+('字符串🙂 = "exact";\n'.repeat(1000))+'```';
  for(let n=0;n<73;n++)f.s.appendEvents(f.auth,{event:{event_id:'synthetic-source-'+n,event_type:'tool_result',content:n===0?body:'Synthetic '+n,task_id:'synthetic-task',workstream_id:'synthetic-work',session_id:'synthetic-session'}});
  const options={task_id:'synthetic-task',workstream_id:'synthetic-work',session_id:'synthetic-session',limit:11};
  let after=0,highwater,entries=[];do{const page=f.s.memorySources.manifest(auth,{...options,after,highwater});highwater=page.highwater;entries.push(...page.entries);after=page.next_after;}while(after!==null);
  assert.equal(entries.length,73);let offset=0,reassembled='',expected;do{const page=f.s.memorySources.content(auth,'synthetic-source-0',{offset,limit:333});reassembled+=page.content;expected=page.content_hash;offset=page.next_offset;}while(offset!==null);
  assert.equal(hash(reassembled),expected);assert.equal(JSON.parse(reassembled),body);
  f.s.memorySources.pin(auth,{event_ids:['synthetic-source-0'],pin_id:'synthetic-handoff-source-pin'});
  f.s.db.prepare('UPDATE events SET expires_at=?').run('2020-01-01T00:00:00Z');
  const result=f.s.pruneExpired();assert.equal(result.expired_events,72);assert.equal(f.s.memorySources.content(auth,'synthetic-source-0').availability,'available');
  assert.equal(f.s.memorySources.content(auth,'synthetic-source-1').availability,'unavailable');
  f.s.memorySources.unpin(auth,'synthetic-handoff-source-pin');assert.equal(f.s.pruneExpired().expired_events,1);
});
test('C-05: consistent nonempty backup + isolated restore check hashes and relationships, not only counts',async t=>{
  const f=fixture(t);f.save('Synthetic source preserved during backup');const file=f.root+'/snapshot.sqlite3';
  await createMemoryBackup(f.s,file);assert.equal(verifyMemoryBackup(file).verified,true);
  const restore=f.root+'/restored.sqlite3',result=await restoreIsolatedBackup(file,restore);assert.equal(result.source_manifest_matched,true);assert.equal(result.service_started,false);
  const db=new DatabaseSync(restore,{readOnly:true});try{assert.equal(databaseManifest(db).tables.find(t=>t.table==='memories').count,1);}finally{db.close();}
  await assert.rejects(createMemoryBackup(f.s,file),e=>e.code==='BACKUP_TARGET_EXISTS');
  const manifest=JSON.parse(readFileSync(file+'.manifest.json'));manifest.tables[0].sha256='invalid';writeFileSync(file+'.manifest.json',JSON.stringify(manifest));
  assert.throws(()=>verifyMemoryBackup(file),e=>e.code==='BACKUP_MANIFEST_MISMATCH');
});
test('C-06 C-07: migration is dry-run, privacy impact accounts for derived state without erasure',async t=>{
  const f=fixture(t),m=f.save('Synthetic private memory'),model=organizer(),jobs=new MemoryJobs(f.s);
  scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy,type:'summary',includeOpen:true});await new MemoryWorker(f.s,jobs,model).drain();
  const before=databaseManifest(f.s.db),impact=f.s.memorySources.privacyImpact(admin(f),[m.memory_id]);
  assert.equal(impact.dry_run,true);assert.equal(impact.summaries,2);assert.equal(impact.physical_erasure_performed,false);assert.deepEqual(databaseManifest(f.s.db),before);
  const filename=f.root+'/runtime.json';writeFileSync(filename,JSON.stringify({...f.s.memoryConfig,storage:{sqlite_path:f.root+'/not-created.sqlite3'}}),{mode:0o600});
  assert.equal((await memoryCommand(['migration-dry-run','--config',filename,'--destination',f.root+'/move.sqlite3'])).copied,false);
  assert.equal(existsSync(f.root+'/not-created.sqlite3'),false);assert.equal(existsSync(f.root+'/move.sqlite3'),false);
});
test('C-08: transient query errors keep readiness; actual broken projection requires explicit repair',t=>{
  const f=fixture(t),m=f.save('Transient testing memory'),real=f.s.db.prepare.bind(f.s.db);let once=true;
  f.s.db.prepare=sql=>{if(once && sql.includes('FROM memory_search_fts')){once=false;throw Object.assign(new Error('database busy'),{errcode:5});}return real(sql);};
  assert.throws(()=>f.s.queryMemories(f.auth,{query:'Transient'}),e=>e.errorCode==='SEARCH_RETRYABLE');
  assert.equal(f.s.memorySearch.status().state,'ready');assert.equal(f.s.queryMemories(f.auth,{query:'Transient'}).results[0].memory_id,m.memory_id);
  f.s.db.exec('DROP TABLE memory_search_fts');assert.throws(()=>f.s.queryMemories(f.auth,{query:'Transient'}),e=>e.errorCode==='SEARCH_UNAVAILABLE');
  f.s.memorySearch.initialize();assert.equal(f.s.memorySearch.status().state,'ready');
});
test('S-08: privacy changes and category overrides invalidate current derived results immediately',async t=>{
  const f=fixture(t),memory=f.save('Sensitive synthetic source'),model=organizer(),jobs=new MemoryJobs(f.s),auth=admin(f);
  scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy,type:'summary',includeOpen:true});await new MemoryWorker(f.s,jobs,model).drain();
  assert.equal(f.s.memorySummaries(f.auth,{scope:'user'}).results.length,2);
  f.s.derivedMemory.setCategory(auth,memory.memory_id,'preferences',taxonomy);assert.equal(f.s.memorySummaries(f.auth,{scope:'user'}).results.length,0);
  scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy,type:'summary',includeOpen:true});await new MemoryWorker(f.s,jobs,model).drain();
  f.s.memorySources.setSensitivity(auth,memory.memory_id,'secret');assert.equal(f.s.memorySummaries(f.auth,{scope:'user'}).results.length,0);
});
test('C-02 C-08: additive HTTP reads enforce source scopes and return actionable unavailable codes',async t=>{
  const f=fixture(t),app=createMnemuronApp({databasePath:f.root+'/http.sqlite3'}),address=await app.listen({host:'127.0.0.1',port:0});t.after(()=>app.close());
  const c=app.store.issueCredential({label:'Synthetic read only',userId:'http-owner',deviceId:'http-device',agentId:'synthetic',agentInstanceId:'http-agent',scopes:['memory:read']});
  const root='http://127.0.0.1:'+address.port,headers={authorization:'Bearer '+c.api_key,'content-type':'application/json'};
  const summaries=await fetch(root+'/v1/memory-summaries/query',{method:'POST',headers,body:JSON.stringify({scope:'user'})});assert.equal(summaries.status,200);
  const source=await fetch(root+'/v1/memory-sources/unknown',{headers});assert.equal(source.status,403);
  const semantic=await fetch(root+'/v1/memories/query',{method:'POST',headers,body:JSON.stringify({query:'synthetic',mode:'semantic'})});assert.equal((await semantic.json()).error_code,'SEMANTIC_UNAVAILABLE');
  const write=await fetch(root+'/v1/memories',{method:'POST',headers,body:JSON.stringify({content:'not allowed',scope:'user'})});assert.equal(write.status,403);
});
test('C-05: backup and restore refuse occupied destination sidecars without modifying them',async t=>{
  const f=fixture(t),backup=f.root+'/clean.sqlite3';f.save('Synthetic collision guard');await createMemoryBackup(f.s,backup);
  for(const suffix of ['-wal','-shm','-journal','.manifest.json']){
    const target=f.root+'/backup'+suffix.replaceAll('.','-')+'.sqlite3';writeFileSync(target+suffix,'synthetic existing file',{mode:0o600});
    await assert.rejects(createMemoryBackup(f.s,target),e=>e.code==='BACKUP_TARGET_EXISTS');
    assert.equal(existsSync(target),false);assert.equal(readFileSync(target+suffix,'utf8'),'synthetic existing file');
    const restored=f.root+'/restore'+suffix.replaceAll('.','-')+'.sqlite3';writeFileSync(restored+suffix,'synthetic existing file',{mode:0o600});
    await assert.rejects(restoreIsolatedBackup(backup,restored),e=>e.code==='RESTORE_TARGET_EXISTS');
    assert.equal(existsSync(restored),false);assert.equal(readFileSync(restored+suffix,'utf8'),'synthetic existing file');
  }
});
test('C-05: backup reserves private outputs before asynchronous copying and rejects competing writers',async t=>{
  const f=fixture(t),target=f.root+'/reserved.sqlite3';f.save('Synthetic private reservation');
  const previous=process.umask(0o022);let pending;
  try{
    pending=createMemoryBackup(f.s,target);
    assert.equal(statSync(target).mode&0o777,0o600);assert.equal(statSync(target+'.manifest.json').mode&0o777,0o600);
    await assert.rejects(createMemoryBackup(f.s,target),e=>e.code==='BACKUP_TARGET_EXISTS');
  }finally{process.umask(previous);if(pending)await pending;}
  assert.equal(verifyMemoryBackup(target).verified,true);
});
test('C-05: live WAL backup preserves raw source, revisions and retention pins by content digest',async t=>{
  const f=fixture(t),auth=admin(f);f.s.db.exec('PRAGMA wal_autocheckpoint=0');
  f.s.appendEvents(f.auth,{event:{event_id:'synthetic-backup-source',event_type:'user_message',content:'Synthetic raw source 🙂'}});
  f.save('Synthetic source-linked atom',{source_event_ids:['synthetic-backup-source']});
  f.s.memorySources.pin(auth,{event_ids:['synthetic-backup-source'],pin_id:'synthetic-backup-pin'});
  assert.ok(statSync(f.s.databasePath+'-wal').size>0);const before=databaseManifest(f.s.db),target=f.root+'/wal.sqlite3';
  await createMemoryBackup(f.s,target);assert.deepEqual(JSON.parse(readFileSync(target+'.manifest.json')).tables,before.tables);
  const restored=f.root+'/wal-restored.sqlite3';await restoreIsolatedBackup(target,restored);
  const db=new DatabaseSync(restored,{readOnly:true});try{assert.deepEqual(databaseManifest(db).tables,before.tables);}finally{db.close();}
  assert.deepEqual(databaseManifest(f.s.db),before);
});
test('C-05: manifest paths obey the same source isolation guard as backup files',async t=>{
  const f=fixture(t),target=f.root+'/manifest-guard.sqlite3';
  writeFileSync(target,'synthetic backup placeholder');symlinkSync(new URL('../../package.json',import.meta.url),target+'.manifest.json');
  assert.throws(()=>verifyMemoryBackup(target),e=>e.errorCode==='PRIVATE_PATH_IN_SOURCE');
});
test('C-06: maintenance status refuses missing databases without creating them',async t=>{
  const f=fixture(t),database=f.root+'/absent.sqlite3',config=f.root+'/missing-runtime.json';
  writeFileSync(config,JSON.stringify({...f.s.memoryConfig,storage:{sqlite_path:database}}),{mode:0o600});
  await assert.rejects(memoryCommand(['status','--config',config]),e=>e.code==='MEMORY_DATABASE_REQUIRED');
  assert.equal(existsSync(database),false);
});
test('C-06: status and backup read an older schema without running store migrations',async t=>{
  const f=fixture(t),database=f.root+'/old.sqlite3',config=f.root+'/old-runtime.json';
  const legacy=new DatabaseSync(database);legacy.exec("CREATE TABLE synthetic_sentinel(value TEXT);INSERT INTO synthetic_sentinel VALUES('preserve original')");legacy.close();
  writeFileSync(config,JSON.stringify({...f.s.memoryConfig,storage:{sqlite_path:database}}),{mode:0o600});
  const before=readFileSync(database);const status=await memoryCommand(['status','--config',config]);
  assert.equal(status.read_only,true);assert.equal(status.migration_applied,false);assert.equal(status.jobs.state,'not_initialized');
  assert.deepEqual(readFileSync(database),before);
  const backup=f.root+'/old-backup.sqlite3';await memoryCommand(['backup','--config',config,'--destination',backup]);
  assert.deepEqual(readFileSync(database),before);assert.equal(verifyMemoryBackup(backup).table_count,1);
});
test('C-06: live status preserves authoritative rows, reports counts and never initializes a worker',async t=>{
  const f=fixture(t),config=f.root+'/live-runtime.json';f.save('Synthetic live status atom');
  writeFileSync(config,JSON.stringify({...f.s.memoryConfig,storage:{sqlite_path:f.s.databasePath}}),{mode:0o600});
  const before=databaseManifest(f.s.db),status=await memoryCommand(['status','--config',config]);
  assert.equal(status.read_only,true);assert.equal(status.production_ready,false);assert.equal(status.migration_applied,false);
  assert.deepEqual(status.jobs.states,f.s.memoryJobs.status().states);assert.deepEqual(status.vector,{state:'disabled'});
  assert.deepEqual(databaseManifest(f.s.db),before);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync,fork} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {MnemuronStore,SCOPE_DEFAULTS} from '../lib/store.mjs';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';

const baseline='4289bfe883d514d0534e9dad000efe70040363f8';
const repo=path.resolve(import.meta.dirname,'../..');
function originalSnapshot(db,columns) {
  return Object.fromEntries(Object.entries(columns).map(([table,fields])=>{
    const rows=db.prepare(`SELECT ${fields.map(f=>'"'+f+'"').join(',')} FROM "${table}" ORDER BY rowid`).all();
    return [table,{rows:rows.length,sha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')}];
  }));
}

test('E-01..04 F-01..02 original binary migration, all-column hashes, consistent backup and rollback limitations',async t=>{
  const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'mnemuron-core-test-release-')));
  assert.equal(path.dirname(root),realpathSync(os.tmpdir()));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const oldCode=path.join(root,'old-code');mkdirSync(oldCode);
  for(const file of ['store.mjs','resolver.mjs','reconciliation.mjs'])writeFileSync(path.join(oldCode,file),execFileSync('git',['show',`${baseline}:server/lib/${file}`],{cwd:repo,maxBuffer:4*1024*1024}),{mode:0o600});
  const {MnemuronStore:OldStore}=await import(pathToFileURL(path.join(oldCode,'store.mjs')).href);
  const dbPath=path.join(root,'old.sqlite3');let old=new OldStore(dbPath);
  const credential=old.issueCredential({label:'synthetic migration',userId:'migration-user',deviceId:'migration-device',agentId:'test',agentInstanceId:'migration-agent',scopes:[...SCOPE_DEFAULTS.agent,...SCOPE_DEFAULTS.admin]});
  const auth=old.authenticate(credential.api_key);
  const task={task_id:'task-migration-core',project_id:'project-migration-core',project_name:'Migration',title:'Task migration core',goal:'synthetic',status:'active',workstreams:[{workstream_id:'branch-a',name:'a',status:'active'}],conflicts:[]};
  old.upsertTask(auth,task);
  old.appendEvents(auth,{events:[{event_id:'old-user-event',event_type:'user_message',captured_at:new Date().toISOString(),task_id:task.task_id,project_id:task.project_id,session_id:'old-session',workstream_id:'branch-a',content:'约束：必须保留来源。'},{event_id:'old-stop-event',event_type:'assistant_message',hook_event_name:'Stop',captured_at:new Date().toISOString(),task_id:task.task_id,project_id:task.project_id,session_id:'old-session',workstream_id:'branch-a',content:'已完成：迁移样例已生成。'}]});
  old.db.exec('BEGIN');
  for(let i=0;i<601;i++)old.saveMemory(auth,{scope:'task',task_id:task.task_id,project_id:task.project_id,content:`oldfact-${i}`,workstream_id:'branch-a'});
  old.db.exec('COMMIT');
  const preview=old.createPreview(auth,{query:task.task_id});assert.equal(preview.status,'pending_confirmation',JSON.stringify(preview));old.confirmPreview(auth,preview.resume_id,preview.preview_version,true);
  const common={preview_version:preview.preview_version,receipt_id:'migration-receipt',session_id:'old-session',workstream_id:'branch-a',delivery_method:'codex-mcp-tool-result',occurred_at:new Date().toISOString()};
  old.recordDeliveryReceipt(auth,preview.resume_id,{...common,receipt_event_id:'old-delivered',phase:'delivered',turn_id:null});
  old.recordDeliveryReceipt(auth,preview.resume_id,{...common,receipt_event_id:'old-ack',phase:'acknowledged',turn_id:'old-turn'});
  const tables=old.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
  const columns=Object.fromEntries(tables.map(table=>[table,old.db.prepare(`PRAGMA table_info("${table}")`).all().map(c=>c.name)]));
  const original=originalSnapshot(old.db,columns);
  for(const table of ['events','checkpoints','memories','tasks','task_canonical_revisions','resumes','resume_delivery_receipts','resolver_selections'])assert.ok(original[table].rows>0,table);
  const publicBefore={identity:old.publicIdentity(auth),retention:old.getRetention(),tasks:old.listTasks(auth.user_id)};
  old.close();old=null;
  const migrated=new MnemuronStore(dbPath);t.after(()=>migrated.close());
  assert.deepEqual(originalSnapshot(migrated.db,columns),original);
  assert.deepEqual({identity:migrated.publicIdentity(auth),retention:migrated.getRetention(),tasks:migrated.listTasks(auth.user_id)},publicBefore);
  assert.equal(migrated.deliveryReceiptStatus(auth,preview.resume_id).status,'acknowledged');
  migrated.migrate();migrated.memorySearch.initialize();assert.deepEqual(originalSnapshot(migrated.db,columns),original);
  const documents=migrated.db.prepare('SELECT doc_id,memory_id FROM memory_search_docs ORDER BY doc_id').all();
  let batches=0;assert.throws(()=>migrated.memorySearch.rebuild({afterBatch:()=>{if(++batches===2)throw Error('interrupted backfill');}}));
  assert.equal(migrated.memorySearch.status().state,'unavailable');assert.deepEqual(originalSnapshot(migrated.db,columns),original);
  const restart=new MnemuronStore(dbPath);assert.equal(restart.memorySearch.validate(),true);restart.close();
  migrated.memorySearch.initialize();assert.deepEqual(migrated.db.prepare('SELECT doc_id,memory_id FROM memory_search_docs ORDER BY doc_id').all(),documents);
  assert.equal(migrated.queryMemories(auth,{query:'oldfact-0',task_id:task.task_id}).result_count,1);
  const intent={scope:'user',content:'backup-lifecycle',operation_id:'durable-operation'};
  const saved=migrated.saveMemory(auth,intent).memory;
  const replacement=migrated.supersedeMemory(auth,saved.memory_id,{content:'backup-replacement'}).replacement_memory;
  migrated.retractMemory(auth,replacement.memory_id,{});
  const backupPath=path.join(root,'consistent.sqlite3');await backup(migrated.db,backupPath);
  const restore=new MnemuronStore(backupPath);t.after(()=>restore.close());
  assert.deepEqual(originalSnapshot(restore.db,columns),originalSnapshot(migrated.db,columns));
  assert.equal(restore.memorySearch.validate(),true);
  assert.equal(restore.saveMemory(auth,intent).memory.status,'superseded');
  assert.equal(restore.memoryDetail(auth,replacement.memory_id,{include_history:true}).memory.status,'retracted');
  const late=migrated.saveMemory(auth,{scope:'user',content:'post-backup-write',operation_id:'post-backup'}).memory;
  assert.equal(restore.db.prepare('SELECT count(*) n FROM memories WHERE memory_id=?').get(late.memory_id).n,0);
  assert.equal(migrated.db.prepare('SELECT count(*) n FROM memories WHERE memory_id=?').get(late.memory_id).n,1);
  migrated.memorySearch.enabled=false;assert.throws(()=>migrated.queryMemories(auth,{query:'oldfact-0'}),e=>e.errorCode==='SEARCH_UNAVAILABLE');migrated.memorySearch.enabled=true;
  const oldRead=new OldStore(dbPath);
  try {
    assert.deepEqual(oldRead.publicIdentity(auth),migrated.publicIdentity(auth));
    assert.throws(()=>oldRead.saveMemory(auth,{scope:'user',content:'unsafe-old-writer'}),/no such function.*memory_search/i);
  }finally{oldRead.close();}
  assert.equal(migrated.db.prepare("SELECT count(*) n FROM memories WHERE content='unsafe-old-writer'").get().n,0);
  // Exercise the old scope defect against an old-only database, never against a live DB.
  const legacy=new OldStore(path.join(root,'legacy-only.sqlite3'));
  try {
    const legacyKey=legacy.issueCredential({label:'synthetic',userId:auth.user_id,deviceId:'legacy-device',agentId:'test',agentInstanceId:'legacy-agent',scopes:[...SCOPE_DEFAULTS.agent,...SCOPE_DEFAULTS.admin]});
    const legacyAuth=legacy.authenticate(legacyKey.api_key);
    legacy.upsertTask(legacyAuth,task);legacy.upsertTask(legacyAuth,{...task,task_id:'other-task',project_id:'other-project'});
    const wrong=legacy.saveMemory(legacyAuth,{scope:'project',project_id:'other-project',content:'oldscopebug'}).memory;
    assert.ok(legacy.queryMemories(legacyAuth,{query:'oldscopebug',task_id:task.task_id}).results.some(m=>m.memory_id===wrong.memory_id));
  }finally{legacy.close();}
  assert.equal(migrated.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  const evidence=path.join(repo,'evidence/core-optimization-v0.2');mkdirSync(evidence,{recursive:true,mode:0o700});
  writeFileSync(path.join(evidence,`migration-${process.version}.json`),JSON.stringify({
    schema_version:'core-memory-migration-evidence-v1',at:new Date().toISOString(),node:process.version,baseline,
    original_binary_sha256:createHash('sha256').update(readFileSync(path.join(oldCode,'store.mjs'))).digest('hex'),
    original_columns:columns,original_tables:original,original_hashes_preserved:true,
    repeated_migration_preserved:true,interrupted_backfill_batches:batches,index_doc_ids_preserved:true,
    consistent_backup_restored:true,restored_index_valid:true,operation_replay_lifecycle:'superseded',replacement_history:'retracted',
    post_backup_write_preserved_in_source_and_absent_in_restore:true,old_reader_compatible:true,old_writer_rejected_by_index_trigger:true,
    old_scope_defect_reproduced:true,integrity:'ok',synthetic_only:true,production_touched:false,
  },null,2)+'\n',{mode:0o600});
});

test('M-05 two independent administrative processes rotate without widening authority',async t=>{
  const f=await memoryFixture(t);
  const workers=[0,1].map(()=>fork(new URL('./helpers/rotate-key-worker.mjs',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc']}));
  t.after(()=>workers.forEach(w=>{if(w.connected)w.kill();}));
  await Promise.all(workers.map(async w=>{const ready=once(w,'message');w.send({databasePath:f.databasePath});assert.equal((await ready)[0].ready,true);}));
  const results=workers.map(w=>once(w,'message').then(([m])=>m));workers.forEach(w=>w.send({auth:f.b.auth,agent:f.a.auth.agent_instance_id}));
  const rotated=await Promise.all(results);assert.ok(rotated.every(r=>r.result),JSON.stringify(rotated));
  const active=[];for(const r of rotated)try{active.push(f.store.authenticate(r.result.api_key));}catch(e){assert.equal(e.statusCode,401);}
  assert.equal(active.length,1);assert.deepEqual(active[0].scopes,f.a.auth.scopes);assert.equal(active[0].agent_instance_id,f.a.auth.agent_instance_id);
  assert.throws(()=>f.store.authenticate(f.a.api_key));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM credentials WHERE agent_instance_id=? AND revoked_at IS NULL').get(f.a.auth.agent_instance_id).n,1);
});

test('F-03 explicit index maintenance target and acyclic core dependency graph',async t=>{
  const f=await memoryFixture(t);
  const before=f.store.db.prepare('SELECT * FROM memories').all();
  const command=path.join(repo,'server/bin/mnemuron-admin.mjs');
  const result=JSON.parse(execFileSync(process.execPath,[command,'memory-index','--database',f.databasePath,'--rebuild'],{env:{...process.env,MNEMURON_ADMIN_API_KEY:f.b.api_key},encoding:'utf8'}));
  assert.equal(result.valid,true);assert.equal(result.business_records_rewritten,false);assert.deepEqual(f.store.db.prepare('SELECT * FROM memories').all(),before);
  assert.throws(()=>execFileSync(process.execPath,[command,'memory-index'],{env:{...process.env,MNEMURON_ADMIN_API_KEY:f.b.api_key},stdio:'pipe'}));
  const complete=new Set(),active=new Set();
  const visit=file=>{
    if(complete.has(file))return;
    assert.ok(!active.has(file),'cyclic import: '+file);active.add(file);
    const code=readFileSync(file,'utf8');
    for(const match of code.matchAll(/(?:from\s*|import\s*)["'](\.\.?\/[^"']+)["']/g))visit(path.resolve(path.dirname(file),match[1]));
    active.delete(file);complete.add(file);
  };
  visit(path.join(repo,'server/lib/store.mjs'));
  assert.ok(complete.has(path.join(repo,'server/lib/memory-validation.mjs')));
  assert.ok(complete.has(path.join(repo,'server/lib/memory-scope.mjs')));
  assert.ok(!readFileSync(path.join(repo,'server/lib/store.mjs'),'utf8').includes('function memoryLexicalScore'));
});

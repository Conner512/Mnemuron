// Schema v10: the first fully enforcing build (reads 5B, writes 5C, jobs 5D). It removes the open-time refusal of
// deleted/merged projects. Every earlier reader is the exact saved source in verified fixtures (never a changed constant)
// and must refuse a v10 database holding real non-active state before touching any record. Synthetic databases only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadHistoricalReader} from './helpers/historical-readers.mjs';
import {DatabaseSync} from 'node:sqlite';
import {MnemuronStore} from '../lib/store.mjs';
import {CORE_SCHEMA_VERSION} from '../lib/store/schema.mjs';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {scheduleLibrary} from '../lib/memory-jobs/worker.mjs';
import {organizer,taxonomy} from './helpers/memory-models.mjs';

// The last fenced v9 build (5C reviews complete, 5D), the earlier v9 candidate without generation guards, v8 and v7.
const READERS={v9_final:['e63249f9847ee9c62620290e9f3210bc063fad9f',9],v9_candidate:['343cecdfd9c6a9ad64800bebbdf1f1f2e0289bc8',9],
  v8:['e3ced0cf5b1d7c9041d7af3b44191b224d13ae93',8],v7:['ffbd18b5f21269ecfae01e801a480953a93ca271',7]};
const A='synthetic-lv-a',B='synthetic-lv-b';
function temp(t,label){const dir=mkdtempSync(path.join(os.tmpdir(),`mnemuron-lv-${label}-`));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
const reader=(t,name)=>loadHistoricalReader(t,READERS[name][0]);
const owner=(store,user)=>store.authenticate(store.issueCredential({userId:user,deviceId:`device-${user}`,agentId:'synthetic',agentInstanceId:`agent-${user}`,scopes:['memory:read','memory:write','admin:tasks','resume:read','resume:confirm']}).api_key);
const snapshot=file=>{const db=new DatabaseSync(file,{readOnly:true});try{return JSON.stringify([db.prepare('PRAGMA user_version').get().user_version,
  ...db.prepare("SELECT name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(r=>[r.name,r.sql]),
  ...db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_search_fts%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])]);}finally{db.close();}};
// A v10 database with real persisted state: a deleted project and a merge, each committed with its generation bump.
function persisted(t){
  const file=path.join(temp(t,'db'),'core.sqlite3'),store=new MnemuronStore(file),a=owner(store,A),b=owner(store,B);
  for(const id of ['lv-live','lv-dead','lv-src','lv-tgt'])store.upsertProject(a,{project_id:id,name:`LV ${id}`});
  store.upsertProject(b,{project_id:'lv-foreign',name:'LV foreign'});
  const save=(project,text)=>store.saveMemory(a,{scope:'project',project_id:project,content:`LVMARK ${text} synthetic`}).memory.memory_id;
  const m={live:save('lv-live','live record'),dead:save('lv-dead','deleted record'),src:save('lv-src','source record'),tgt:save('lv-tgt','target record')};
  store.upsertTask(a,{task_id:'lv-task',project_id:'lv-live',project_name:'LV lv-live',title:'LV resume task',goal:'Synthetic v10 resume',status:'active',workstreams:[]});
  const preview=store.createPreview(a,{query:'lv resume',signals:{task_id:'lv-task'}});assert.equal(preview.status,'pending_confirmation');
  const set=(id,state,into=null)=>store.memoryTransaction(()=>{store.db.prepare('INSERT OR REPLACE INTO project_lifecycle VALUES (?,?,?,?,1,?)').run(A,id,state,into,new Date().toISOString());store.lifecycle.bumpGeneration(A);});
  set('lv-dead','deleted');set('lv-src','merged','lv-tgt');
  store.close();return {file,m,preview};
}

test('LV-01: the current schema retains v10 enforcement and opens a database with persisted deleted and merged projects, enforcing them after reopen',async t=>{
  assert.equal(CORE_SCHEMA_VERSION,11);
  const {file,m,preview}=persisted(t),store=new MnemuronStore(file);t.after(()=>store.close());
  const a=owner(store,A),b=owner(store,B);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,CORE_SCHEMA_VERSION);
  assert.ok(store.db.prepare('SELECT enforced_since FROM project_lifecycle_enforcement WHERE id=1').get()?.enforced_since);
  // Reads: deleted is owner-only truth; merged reads the canonical member set; other owners get the generic answer.
  assert.throws(()=>store.queryMemories(a,{query:'LVMARK',project_id:'lv-dead'}),{errorCode:'PROJECT_DELETED'});
  assert.throws(()=>store.queryMemories(b,{query:'LVMARK',project_id:'lv-dead'}),{errorCode:'PROJECT_NOT_FOUND'});
  const ids=r=>r.results.map(x=>x.memory_id).sort();
  assert.deepEqual(ids(store.queryMemories(a,{query:'LVMARK',project_id:'lv-src'})),[m.src,m.tgt].sort());
  assert.ok(!ids(store.queryMemories(a,{query:'LVMARK'})).includes(m.dead));
  // Writes: deleted IDs stay reserved; merged IDs route with provenance.
  assert.throws(()=>store.upsertProject(a,{project_id:'lv-dead',name:'Recreated'}),{errorCode:'PROJECT_DELETED'});
  const routed=store.saveMemory(a,{scope:'project',project_id:'lv-src',content:'LV routed after reopen'}).memory.memory_id;
  assert.equal(store.db.prepare('SELECT project_id FROM memories WHERE memory_id=?').get(routed).project_id,'lv-tgt');
  // Authority bound before the lifecycle changes is stale after reopen.
  assert.throws(()=>store.confirmPreview(a,preview.resume_id,preview.preview_version,true),{errorCode:'LIFECYCLE_AUTHORITY_STALE'});
  // Jobs: scheduling never includes the deleted project's record.
  const model=organizer(),jobs=new MemoryJobs(store);
  const plan=scheduleLibrary(store,jobs,{userId:A,organizer:model,taxonomy,includeOpen:true,periods:['daily']});
  const scheduled=plan.jobs.flatMap(id=>store.db.prepare('SELECT memory_id FROM memory_job_items WHERE job_id=?').all(id).map(r=>r.memory_id));
  assert.ok(!scheduled.includes(m.dead));assert.ok(scheduled.includes(m.src));
  const {MemoryWorker}=await import('../lib/memory-jobs/worker.mjs');
  assert.ok((await new MemoryWorker(store,jobs,model).drain()).every(r=>r.state==='succeeded'),'queued jobs run after reopen');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM memory_annotations WHERE memory_id=?').get(m.dead).n,0);
});

test('LV-02: every saved earlier reader refuses the current database with real non-active state before touching any record',async t=>{
  const {file}=persisted(t),before=snapshot(file);
  assert.equal(JSON.parse(before)[0],CORE_SCHEMA_VERSION,'the refused database is the current schema');
  for(const [name,[commit,version]] of Object.entries(READERS)){
    const {MnemuronStore:Old}=await reader(t,name);
    assert.throws(()=>new Old(file),{code:'SCHEMA_VERSION_UNSUPPORTED'},`${name} (${commit.slice(0,7)}, schema v${version})`);
    assert.equal(snapshot(file),before,`${name}: the refused open left every record and schema object unchanged`);
  }
  // Defense in depth, on a copy relabelled v9: the final fenced v9 reader would still refuse the non-active state itself.
  const copy=path.join(temp(t,'relabelled'),'core.sqlite3');copyFileSync(file,copy);
  const raw=new DatabaseSync(copy);raw.exec('PRAGMA user_version = 9');raw.close();
  const relabelled=snapshot(copy);const {MnemuronStore:V9}=await reader(t,'v9_final');
  assert.throws(()=>new V9(copy),{code:'PROJECT_LIFECYCLE_UNSUPPORTED'});assert.equal(snapshot(copy),relabelled);
});

test('LV-03: the exact final v9 build upgrades through v10 to v11 preserving business rows; a failed v10 step rolls back',async t=>{
  const {MnemuronStore:V9}=await reader(t,'v9_final');
  const file=path.join(temp(t,'upgrade'),'core.sqlite3'),old=new V9(file),a=owner(old,A);
  old.upsertProject(a,{project_id:'lv-up',name:'LV upgrade'});old.saveMemory(a,{scope:'project',project_id:'lv-up',content:'LV upgrade record'});old.close();
  const rows=f=>{const db=new DatabaseSync(f,{readOnly:true});try{return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_search_fts%'").all()
    .map(({name})=>[name,JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())]));}finally{db.close();}};
  const before=rows(file),version=f=>{const db=new DatabaseSync(f,{readOnly:true});try{return db.prepare('PRAGMA user_version').get().user_version;}finally{db.close();}};
  assert.equal(version(file),9);
  new MnemuronStore(file).close();
  assert.equal(version(file),CORE_SCHEMA_VERSION);const after=rows(file);
  for(const [table,value] of Object.entries(before)){if(table==='lifecycle_protection'){const prior=JSON.parse(value),current=JSON.parse(after[table]);assert.deepEqual(current.filter(r=>prior.some(p=>p.table_name===r.table_name)),prior,'preexisting protection rows preserved');continue;}assert.equal(after[table],value,`${table} unchanged by the upgrade`);}
  assert.deepEqual(Object.keys(after).filter(t=>!(t in before)).sort(),['project_lifecycle_enforcement','memory_entities','memory_entity_names','memory_entity_members','memory_entity_proposals','memory_entity_tombstones','memory_entity_queue_cursor'].sort());
  // A conflicting pre-existing object makes the v10 step fail: nothing of v10 remains and the version stays 9.
  // (The v10 step is one table plus one marker row; rollback of objects a failing step had already created is proven for
  // the shared migration runner by LF-02.)
  const broken=path.join(temp(t,'broken'),'core.sqlite3'),v9=new V9(broken);owner(v9,A);v9.db.exec('CREATE TABLE project_lifecycle_enforcement (unrelated TEXT)');v9.close();
  const kept=snapshot(broken);
  assert.throws(()=>new MnemuronStore(broken),/enforced_since|no column|has no column/);
  assert.equal(snapshot(broken),kept,'the failed v10 step changed nothing and the version stays 9');
});

test('LV-04: persisted inconsistent lifecycle metadata of any kind refuses the open before any write; corruption appearing after the open fails closed for owner-wide reads, writes and scheduling, and per record for queued jobs',async t=>{
  const cases={
    cycle:raw=>raw.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,'lv-tgt','merged','lv-src',1,?)").run(A,new Date().toISOString()),
    'missing target':raw=>raw.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,'lv-live','merged','lv-nowhere',1,?)").run(A,new Date().toISOString()),
    'foreign target':raw=>raw.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,'lv-live','merged','lv-foreign',1,?)").run(A,new Date().toISOString()),
    'unowned project row':raw=>raw.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,'lv-foreign','active',NULL,1,?)").run(A,new Date().toISOString()),
    'unknown state':raw=>{raw.exec('PRAGMA ignore_check_constraints=ON');raw.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,'lv-live','Deleted',NULL,1,?)").run(A,new Date().toISOString());},
    'merged without target':raw=>{raw.exec('PRAGMA ignore_check_constraints=ON');raw.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,'lv-live','merged',NULL,1,?)").run(A,new Date().toISOString());},
    'merged into itself':raw=>{raw.exec('PRAGMA ignore_check_constraints=ON');raw.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,'lv-live','merged','lv-live',1,?)").run(A,new Date().toISOString());},
    'active with a target':raw=>{raw.exec('PRAGMA ignore_check_constraints=ON');raw.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,'lv-live','active','lv-tgt',1,?)").run(A,new Date().toISOString());},
    'invalid identifier':raw=>{const now=new Date().toISOString();
      raw.prepare("INSERT INTO projects (project_id,user_id,name,aliases_json,git_remotes_json,repo_fingerprints_json,path_hints_json,created_at,updated_at) VALUES ('bad id!',?,'bad','[]','[]','[]','[]',?,?)").run(A,now,now);
      raw.prepare("INSERT INTO project_lifecycle VALUES (?,'bad id!','deleted',NULL,1,?)").run(A,now);},
    'rows without a projects table':raw=>raw.exec('DROP TABLE projects'),
    'too many sources':raw=>{const now=new Date().toISOString();for(let i=0;i<21;i++){const id=`lv-many-${String(i).padStart(2,'0')}`;
      raw.prepare("INSERT INTO projects (project_id,user_id,name,aliases_json,git_remotes_json,repo_fingerprints_json,path_hints_json,created_at,updated_at) VALUES (?,?,?,'[]','[]','[]','[]',?,?)").run(id,A,id,now,now);
      raw.prepare("INSERT INTO project_lifecycle VALUES (?,?,'merged','lv-tgt',1,?)").run(A,id,now);}},
  };
  for(const [label,corrupt] of Object.entries(cases)){
    const {file}=persisted(t),raw=new DatabaseSync(file);corrupt(raw);raw.close();
    const before=snapshot(file);
    assert.throws(()=>new MnemuronStore(file),{errorCode:'PROJECT_LIFECYCLE_CORRUPT'},label);
    assert.equal(snapshot(file),before,`${label}: the refused open wrote nothing (no migration, ensure or repair)`);
  }
  // Corruption that appears after a consistent open: owner-wide reads and scheduling fail closed for that owner, writes
  // through the inconsistent chain fail closed, and per-record paths judge each record by its own chain. Nothing is written.
  const {file,m}=persisted(t),store=new MnemuronStore(file);t.after(()=>store.close());const a=owner(store,A),b=owner(store,B);
  const jobs=new MemoryJobs(store),model=organizer();
  const plan=scheduleLibrary(store,jobs,{userId:A,organizer:model,taxonomy,includeOpen:true,periods:['daily']});assert.ok(plan.jobs.length>0);
  store.db.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,'lv-tgt','merged','lv-src',1,?)").run(A,new Date().toISOString());
  const counts=()=>JSON.stringify(['memories','tasks','projects','events','memory_jobs','memory_annotations','project_route_log'].map(table=>store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n));
  const before=counts(),corruptCode={errorCode:'PROJECT_LIFECYCLE_CORRUPT'};
  assert.throws(()=>store.queryMemories(a,{query:'LVMARK',project_id:'lv-tgt'}),corruptCode,'scoped read');
  assert.throws(()=>store.queryMemories(a,{query:'LVMARK'}),corruptCode,'unscoped read');
  assert.throws(()=>store.saveMemory(a,{scope:'project',project_id:'lv-src',content:'LV never saved'}),corruptCode,'write through the cycle');
  assert.throws(()=>store.upsertTask(a,{task_id:'lv-never',project_id:'lv-tgt',project_name:'x',title:'LV never',goal:'never',status:'active',workstreams:[]}),corruptCode,'task write');
  assert.throws(()=>scheduleLibrary(store,jobs,{userId:A,organizer:model,taxonomy,includeOpen:true,periods:['daily']}),corruptCode,'scheduling');
  const {MemoryWorker}=await import('../lib/memory-jobs/worker.mjs');
  // Per-record paths resolve each record's own project chain: a job whose source lies in the inconsistent chain never
  // publishes; a source whose own chain is consistent (lv-live) is unaffected, as for single-record delivery.
  const ran=await new MemoryWorker(store,jobs,model).drain(),affected=new Set([m.src,m.tgt]);
  const jobOf=id=>store.db.prepare('SELECT memory_id FROM memory_job_items WHERE job_id=?').all(id).map(r=>r.memory_id);
  const touching=ran.filter(r=>jobOf(r.job_id).some(id=>affected.has(id)));
  assert.ok(touching.length>0&&touching.every(r=>r.state!=='succeeded'),'queued jobs over the inconsistent chain never publish');
  assert.equal(store.db.prepare(`SELECT COUNT(*) n FROM memory_annotations WHERE memory_id IN (?,?)`).get(m.src,m.tgt).n,0);
  const fixed=c=>JSON.parse(c).filter((_,i)=>![4,5].includes(i));
  assert.deepEqual(fixed(counts()),fixed(before),'no record, task, project, event or route was written');
  // A malformed row written after the open (bypassing CHECK) never reads as live either.
  store.db.exec('PRAGMA ignore_check_constraints=ON');store.db.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,'lv-live','Deleted',NULL,1,?)").run(A,new Date().toISOString());store.db.exec('PRAGMA ignore_check_constraints=OFF');
  assert.throws(()=>store.queryMemories(a,{query:'LVMARK',project_id:'lv-live'}),corruptCode,'unknown state is not live');
  // An active row with a target is inconsistent too, for owner-wide reads as well as scoped ones.
  store.db.exec('PRAGMA ignore_check_constraints=ON');store.db.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,'lv-live','active','lv-tgt',1,?)").run(A,new Date().toISOString());store.db.exec('PRAGMA ignore_check_constraints=OFF');
  store.db.prepare("DELETE FROM project_lifecycle WHERE user_id=? AND project_id='lv-tgt'").run(A);
  assert.throws(()=>store.queryMemories(a,{query:'LVMARK'}),corruptCode,'unscoped read with a malformed active row');
  assert.throws(()=>store.queryMemories(a,{query:'LVMARK',project_id:'lv-live'}),corruptCode,'scoped read with a malformed active row');
  // Another owner is unaffected at runtime.
  assert.equal(store.queryMemories(b,{query:'LVMARK'}).results.length,0);
  void m;
});

test('LV-05: a v8 database with lifecycle rows (no generation table yet) upgrades directly to v10 and is enforced',async t=>{
  const {MnemuronStore:V8}=await reader(t,'v8');
  const file=path.join(temp(t,'v8'),'core.sqlite3'),old=new V8(file),a=owner(old,A);
  for(const id of ['lv8-live','lv8-dead'])old.upsertProject(a,{project_id:id,name:`LV8 ${id}`});
  old.saveMemory(a,{scope:'project',project_id:'lv8-dead',content:'LVMARK v8 deleted record'});old.close();
  const raw=new DatabaseSync(file),now=new Date().toISOString();
  raw.prepare("INSERT INTO project_lifecycle VALUES (?,'lv8-live','active',NULL,1,?)").run(A,now);
  raw.prepare("INSERT INTO project_lifecycle VALUES (?,'lv8-dead','deleted',NULL,1,?)").run(A,now);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version,8);
  assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name='owner_lifecycle_generation'").get(),undefined,'v8 has no generation table');raw.close();
  const store=new MnemuronStore(file);t.after(()=>store.close());
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,CORE_SCHEMA_VERSION);
  assert.throws(()=>store.queryMemories(owner(store,A),{query:'LVMARK',project_id:'lv8-dead'}),{errorCode:'PROJECT_DELETED'});
});

test('LV-06: repair on open still works: a damaged database without lifecycle rows but missing the projects table opens and is repaired',async t=>{
  const file=path.join(temp(t,'repair'),'core.sqlite3'),store=new MnemuronStore(file),a=owner(store,A);
  store.upsertProject(a,{project_id:'lv-repair',name:'LV repair'});store.db.exec('DROP TABLE projects');store.close();
  const reopened=new MnemuronStore(file);t.after(()=>reopened.close());
  assert.ok(reopened.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get(),'the repeatable migration recreated the table');
  assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version,CORE_SCHEMA_VERSION);
});

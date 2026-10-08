// Lifecycle enforcement groundwork (introduced in schema v9, LE-01..LE-10). These tests create deleted or
// merged rows at runtime in a disposable synthetic database to exercise
// the authoritative view and scope API. The v8 reader is the exact accepted foundation (e3ced0c) preserved in byte-exact fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadHistoricalReader} from './helpers/historical-readers.mjs';
import {DatabaseSync} from 'node:sqlite';
import {MnemuronStore} from '../lib/store.mjs';
import {CORE_SCHEMA_VERSION} from '../lib/store/schema.mjs';

const V8_SOURCE='e3ced0cf5b1d7c9041d7af3b44191b224d13ae93';
// The earlier fenced v9 candidate: schema v9 without generation guards or their initialization marker.
const V9_CANDIDATE='343cecdfd9c6a9ad64800bebbdf1f1f2e0289bc8';
const A='synthetic-le-a',B='synthetic-le-b';
function temp(t,label){const dir=mkdtempSync(path.join(os.tmpdir(),`mnemuron-le-${label}-`));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function owner(store,user){const c=store.issueCredential({userId:user,deviceId:`device-${user}`,agentId:'synthetic',agentInstanceId:`agent-${user}`,scopes:['memory:read','memory:write','admin:tasks']});return store.authenticate(c.api_key);}
function setup(t){
  const store=new MnemuronStore(path.join(temp(t,'store'),'core.sqlite3'));t.after(()=>{if(store.db.isOpen)store.close();});
  const a=owner(store,A),b=owner(store,B);
  for(const id of ['le-target','le-source','le-source-2','le-deleted','le-member-of-deleted','le-plain'])store.upsertProject(a,{project_id:id,name:id});
  store.upsertProject(b,{project_id:'le-foreign',name:'le-foreign'});
  const row=(user,id,state,into)=>store.db.prepare('INSERT OR REPLACE INTO project_lifecycle VALUES (?,?,?,?,1,?)').run(user,id,state,into??null,new Date().toISOString());
  return {store,a,b,row,L:store.lifecycle};
}

test('LE-01: a project of the owner without lifecycle metadata is an active singleton scope, including new projects',t=>{
  const {store,a,L,row}=setup(t);
  assert.deepEqual(L.scope(A,'le-plain'),{requested_project_id:'le-plain',canonical_project_id:'le-plain',routed:false,members:['le-plain'],generation:0});
  row(A,'le-source','merged','le-target');row(A,'le-deleted','deleted');
  store.upsertProject(a,{project_id:'le-created-later',name:'later'});
  assert.deepEqual(L.scope(A,'le-created-later').members,['le-created-later'],'a project created after lifecycle rows exist is active');
  // A merge target without its own lifecycle row stays its own canonical project with its members.
  assert.deepEqual(L.scope(A,'le-target').members.sort(),['le-source','le-target']);
  assert.deepEqual(L.view(A).dead,['le-deleted']);
});

test('LE-02: deleted state is truthful to the owner only and covers every member of a deleted canonical project',t=>{
  const {L,row}=setup(t);
  row(A,'le-deleted','deleted');row(A,'le-member-of-deleted','merged','le-deleted');
  for(const id of ['le-deleted','le-member-of-deleted'])assert.throws(()=>L.scope(A,id),{errorCode:'PROJECT_DELETED'});
  assert.deepEqual(L.view(A).dead.sort(),['le-deleted','le-member-of-deleted']);
  // Another owner learns nothing: the same generic not-found as a missing ID.
  for(const id of ['le-deleted','le-member-of-deleted','never'])assert.throws(()=>L.scope(B,id),{errorCode:'PROJECT_NOT_FOUND',message:'Project not found.'});
  assert.deepEqual(L.view(B).dead,[],'views are per owner');
});

test('LE-03: merged sources route to the canonical target, transitively, keeping their own identity',t=>{
  const {L,row}=setup(t);
  row(A,'le-source-2','merged','le-source');row(A,'le-source','merged','le-target');
  const scope=L.scope(A,'le-source-2');
  assert.deepEqual([scope.canonical_project_id,scope.routed],['le-target',true]);
  assert.deepEqual(scope.members.sort(),['le-source','le-source-2','le-target']);
  assert.deepEqual({...L.view(A).canonical},{'le-source':'le-target','le-source-2':'le-target'});
  assert.equal(L.scope(A,'le-target').routed,false);
});

test('LE-04: inconsistent lifecycle metadata is refused, never treated as active',t=>{
  const {L,row}=setup(t);
  for(const [label,setupRows] of [
    ['cycle',()=>{row(A,'le-source','merged','le-source-2');row(A,'le-source-2','merged','le-source');}],
    ['foreign target',()=>row(A,'le-source','merged','le-foreign')],
    ['missing target',()=>row(A,'le-source','merged','le-never-created')],
  ]){
    setupRows();
    assert.throws(()=>L.view(A),{errorCode:'PROJECT_LIFECYCLE_CORRUPT'},`${label}: the owner view fails closed`);
    assert.throws(()=>L.scope(A,'le-source'),{errorCode:'PROJECT_LIFECYCLE_CORRUPT'},`${label}: the scope fails closed`);
    L.db.prepare('DELETE FROM project_lifecycle').run();
  }
  // Rows of another owner can never make A's projects appear or disappear.
  row(B,'le-plain','deleted');
  assert.deepEqual(L.view(A).dead,[]);assert.equal(L.scope(A,'le-plain').canonical_project_id,'le-plain');
});

test('LE-05: the owner lifecycle generation starts at 0, moves only through the transactional bump, and never decreases or resets',t=>{
  const {store,L}=setup(t),db=store.db,tx=fn=>store.memoryTransaction(fn);
  assert.equal(L.generation(A),0);
  assert.throws(()=>L.bumpGeneration(A),/only inside a lifecycle transaction/,'no bump outside a transaction');
  assert.equal(tx(()=>L.bumpGeneration(A)),1);
  // Repeated legitimate bumps keep working after the generation is above the insert seed of a plain insert.
  for(const expected of [2,3,4,5])assert.equal(tx(()=>L.bumpGeneration(A)),expected);
  assert.equal(L.generation(A),5);assert.equal(L.generation(B),0,'per owner');
  const refused=/never decreases or resets/;
  for(const [label,sql] of [
    ['decrement 5->1','UPDATE owner_lifecycle_generation SET generation=1 WHERE user_id=?'],
    ['decrement 5->0','UPDATE owner_lifecycle_generation SET generation=0 WHERE user_id=?'],
    ['same-value update','UPDATE owner_lifecycle_generation SET generation=generation WHERE user_id=?'],
    ['owner move',"UPDATE owner_lifecycle_generation SET user_id='synthetic-le-other' WHERE user_id=?"],
    ['delete','DELETE FROM owner_lifecycle_generation WHERE user_id=?'],
  ]){assert.throws(()=>db.prepare(sql).run(A),refused,label);assert.equal(L.generation(A),5,`${label} keeps the generation`);}
  for(const [label,sql] of [
    ['REPLACE reset to 0','INSERT OR REPLACE INTO owner_lifecycle_generation VALUES (?,0)'],
    ['REPLACE lower','INSERT OR REPLACE INTO owner_lifecycle_generation VALUES (?,1)'],
    ['REPLACE equal','INSERT OR REPLACE INTO owner_lifecycle_generation VALUES (?,5)'],
    ['REPLACE statement form','REPLACE INTO owner_lifecycle_generation VALUES (?,2)'],
    ['INSERT OR IGNORE lower','INSERT OR IGNORE INTO owner_lifecycle_generation VALUES (?,0)'],
    ['UPSERT to lower','INSERT INTO owner_lifecycle_generation VALUES (?,1) ON CONFLICT(user_id) DO UPDATE SET generation=excluded.generation'],
  ]){assert.throws(()=>db.prepare(sql).run(A),refused,label);assert.equal(L.generation(A),5,`${label} keeps the generation`);}
  assert.throws(()=>db.prepare('INSERT INTO owner_lifecycle_generation VALUES (?,-1)').run(B),/CHECK/);
  // A rolled-back lifecycle transaction keeps the prior token.
  assert.throws(()=>tx(()=>{assert.equal(L.bumpGeneration(A),6);throw new Error('synthetic rollback');}),/synthetic rollback/);
  assert.equal(L.generation(A),5);
  assert.equal(tx(()=>L.bumpGeneration(A)),6);
  // Lost or altered guards after initialization: LE-10.
});

test('LE-06: the exact accepted v8 foundation refuses this schema before touching any record',async t=>{
  const {MnemuronStore:V8}=await loadHistoricalReader(t,V8_SOURCE);
  const file=path.join(temp(t,'db'),'core.sqlite3');
  const store=new MnemuronStore(file);owner(store,A);store.close();
  const snapshot=()=>{const db=new DatabaseSync(file,{readOnly:true});try{return JSON.stringify([db.prepare('PRAGMA user_version').get().user_version,
    ...db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_search_fts%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])]);}finally{db.close();}};
  const before=snapshot();
  assert.equal(JSON.parse(before)[0],CORE_SCHEMA_VERSION,'the refused database is exactly the current schema');
  assert.throws(()=>new V8(file),{code:'SCHEMA_VERSION_UNSUPPORTED'});
  assert.equal(snapshot(),before,'the refused open left every record snapshot unchanged');
});

test('LE-07: valid IDs named like Object properties resolve as ordinary projects, unmerged and merged',t=>{
  const {store,a,L,row}=setup(t);
  for(const id of ['constructor','toString','hasOwnProperty','valueOf'])store.upsertProject(a,{project_id:id,name:id});
  let live=L.live(A);
  for(const id of ['constructor','toString','hasOwnProperty','valueOf']){
    assert.equal(live.canonicalOf(id),id,`${id} unmerged is its own canonical project`);
    assert.equal(live.has(id),true);
    assert.equal(Object.hasOwn(L.view(A).canonical,id),false);
  }
  assert.equal(live.canonicalOf('le-plain'),'le-plain');
  row(A,'toString','merged','constructor');row(A,'valueOf','merged','hasOwnProperty');
  live=L.live(A);
  assert.equal(live.canonicalOf('toString'),'constructor');assert.equal(live.canonicalOf('valueOf'),'hasOwnProperty');
  assert.equal(live.canonicalOf('constructor'),'constructor','a merge target named constructor is not shadowed');
  assert.equal(Object.getPrototypeOf(live.canonical),null);
  assert.deepEqual({...L.view(A).canonical},{toString:'constructor',valueOf:'hasOwnProperty'});
  assert.deepEqual(L.scope(A,'toString').members.sort(),['constructor','toString']);
});

test('LE-08: the unscoped view enforces the same source-member limit as scope',t=>{
  const {store,a,L,row}=setup(t);
  const ids=Array.from({length:21},(_,i)=>`le-many-${String(i).padStart(2,'0')}`);
  for(const id of ids)store.upsertProject(a,{project_id:id,name:id});
  // 20 sources (one of them transitive) are accepted by both.
  for(const id of ids.slice(0,19))row(A,id,'merged','le-target');
  row(A,ids[19],'merged',ids[0]);
  assert.equal(Object.keys(L.view(A).canonical).length,20);
  assert.equal(L.scope(A,'le-target').members.length,21);
  row(A,ids[20],'merged',ids[19]);
  assert.throws(()=>L.view(A),{errorCode:'PROJECT_MEMBER_LIMIT'},'the unscoped view rejects an oversized canonical project');
  assert.throws(()=>L.live(A),{errorCode:'PROJECT_MEMBER_LIMIT'});
  assert.throws(()=>L.scope(A,'le-target'),{errorCode:'PROJECT_MEMBER_LIMIT'});
  // A dead (deleted) canonical project is held to the same bound.
  L.db.prepare('DELETE FROM project_lifecycle').run();
  for(const id of ids)row(A,id,'merged','le-deleted');row(A,'le-deleted','deleted');
  assert.throws(()=>L.view(A),{errorCode:'PROJECT_MEMBER_LIMIT'});
});

test('LE-09: only NULL or owned, not-deleted project IDs are live; dangling and foreign IDs never are, with one rule for SQL and lookups',t=>{
  const {store,L,row}=setup(t),db=store.db;
  row(A,'le-deleted','deleted');row(A,'le-member-of-deleted','merged','le-deleted');row(A,'le-source','merged','le-target');
  const live=L.live(A),cases={
    null:true,'le-plain':true,'le-target':true,'le-source':true,
    'le-deleted':false,'le-member-of-deleted':false,'le-foreign':false,'le-dangling-never-created':false};
  db.exec('CREATE TEMP TABLE probe (project_id TEXT)');
  const insert=db.prepare('INSERT INTO probe VALUES (?)');for(const id of Object.keys(cases))insert.run(id==='null'?null:id);
  const filter=live.sql('probe.project_id');
  const selected=db.prepare(`SELECT project_id FROM probe WHERE ${filter.sql}`).all(...filter.params).map(r=>r.project_id??'null').sort();
  assert.deepEqual(selected,Object.keys(cases).filter(id=>cases[id]).sort(),'SQL keeps exactly the live IDs');
  for(const [id,expected] of Object.entries(cases)){
    const value=id==='null'?null:id;
    assert.equal(live.has(value),expected,`has(${id})`);
    if(value!==null)assert.equal(live.canonicalOf(value),expected?(id==='le-source'?'le-target':id):null,`canonicalOf(${id})`);
    assert.equal(L.liveProject(A,value),expected,`liveProject(${id})`);
  }
  assert.deepEqual(['null','le-plain','le-deleted','le-foreign','le-dangling-never-created'].map(id=>L.projectState(A,id==='null'?null:id)),
    ['neutral','live','deleted','unavailable','unavailable']);
  // The other owner's view of the same IDs: its own project is live, A's projects are not.
  const liveB=L.live(B);
  assert.equal(liveB.has('le-foreign'),true);assert.equal(liveB.has('le-plain'),false);assert.equal(liveB.canonicalOf('le-source'),null);
  // A lifecycle row for an ID the owner does not own is inconsistent metadata, refused by every entry point.
  row(A,'le-foreign','deleted');
  assert.throws(()=>L.live(A),{errorCode:'PROJECT_LIFECYCLE_CORRUPT'});
  assert.throws(()=>L.projectState(A,'le-foreign'),{errorCode:'PROJECT_LIFECYCLE_CORRUPT'});
  assert.equal(liveB.has('le-foreign'),true,'B is unaffected by a row filed under A');
});

// Complete read-only state of a database file: schema version, every schema object with its stored SQL (so a
// reinstalled trigger would show), and every row of every table.
function fileSnapshot(file){
  const db=new DatabaseSync(file,{readOnly:true});
  try{return JSON.stringify([db.prepare('PRAGMA user_version').get().user_version,
    db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all(),
    ...db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_search_fts%' ORDER BY name").all()
      .map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])]);}finally{db.close();}
}

test('LE-10: once initialized, a lost or altered generation guard is refused before any repair, and only a never-initialized database gets a first install',async t=>{
  const refused=/never decreases or resets/;
  const initialized=label=>{
    const file=path.join(temp(t,label),'core.sqlite3'),store=new MnemuronStore(file);owner(store,A);
    for(let i=0;i<5;i++)store.memoryTransaction(()=>store.lifecycle.bumpGeneration(A));
    assert.deepEqual(store.db.prepare('SELECT guard_set FROM lifecycle_guard_installations').all().map(r=>r.guard_set),['owner_lifecycle_generation']);
    store.close();return file;
  };
  // An actual reset or deletion of the generation during the gap, then reopen: refused, nothing repaired or written.
  for(const [label,tamper,problem] of [
    ['reset 5->1 while no_decrease was missing',"DROP TRIGGER owner_lifecycle_generation_no_decrease; UPDATE owner_lifecycle_generation SET generation=1;",/no_decrease: missing/],
    ['row deleted while no_delete was missing',"DROP TRIGGER owner_lifecycle_generation_no_delete; DELETE FROM owner_lifecycle_generation;",/no_delete: missing/],
    ['REPLACE reset while no_reset was missing',"DROP TRIGGER owner_lifecycle_generation_no_reset; DROP TRIGGER owner_lifecycle_generation_no_delete; INSERT OR REPLACE INTO owner_lifecycle_generation VALUES ('synthetic-le-a',0);",/no_reset: missing; owner_lifecycle_generation_no_delete: missing/],
    ['all guards missing, no write in the gap','DROP TRIGGER owner_lifecycle_generation_no_reset; DROP TRIGGER owner_lifecycle_generation_no_decrease; DROP TRIGGER owner_lifecycle_generation_no_delete;',/no_reset: missing.*no_decrease: missing.*no_delete: missing/],
    ['altered guard',`DROP TRIGGER owner_lifecycle_generation_no_delete;
      CREATE TRIGGER owner_lifecycle_generation_no_delete BEFORE DELETE ON owner_lifecycle_generation WHEN 0 BEGIN SELECT 1; END;`,/no_delete: altered/],
  ]){
    const file=initialized(label.replace(/\W+/g,'-').slice(0,24));
    const raw=new DatabaseSync(file);raw.exec(tamper);raw.close();
    const before=fileSnapshot(file);
    assert.throws(()=>new MnemuronStore(file),{errorCode:'LIFECYCLE_PROTECTION_MISSING',message:problem},label);
    assert.equal(fileSnapshot(file),before,`${label}: the refused open left schema and records unchanged (no guard reinstalled)`);
    assert.throws(()=>new MnemuronStore(file),{errorCode:'LIFECYCLE_PROTECTION_MISSING'},`${label}: still refused on a second attempt`);
  }
  // Legitimate first install: a v9 database written by the exact earlier fenced candidate (343cecd), which had no
  // guards and never exposed lifecycle authority, opens and is guarded from then on with its generation preserved.
  const {MnemuronStore:Candidate}=await loadHistoricalReader(t,V9_CANDIDATE);
  const file=path.join(temp(t,'candidate-db'),'core.sqlite3');
  const old=new Candidate(file);owner(old,A);
  old.db.prepare('INSERT INTO owner_lifecycle_generation VALUES (?,3)').run(A);old.db.prepare('UPDATE owner_lifecycle_generation SET generation=2 WHERE user_id=?').run(A);
  assert.equal(old.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'owner_lifecycle_generation_no_%' OR name='lifecycle_guard_installations'").get().n,0,'the candidate had neither guards nor marker');
  assert.equal(old.db.prepare('PRAGMA user_version').get().user_version,9);old.close();
  const upgraded=new MnemuronStore(file);t.after(()=>{if(upgraded.db.isOpen)upgraded.close();});
  assert.equal(upgraded.lifecycle.generation(A),2,'existing generation preserved');
  assert.deepEqual(upgraded.db.prepare('SELECT guard_set FROM lifecycle_guard_installations').all().map(r=>r.guard_set),['owner_lifecycle_generation']);
  assert.throws(()=>upgraded.db.prepare('UPDATE owner_lifecycle_generation SET generation=1 WHERE user_id=?').run(A),refused,'guarded from first install on');
  assert.equal(upgraded.memoryTransaction(()=>upgraded.lifecycle.bumpGeneration(A)),3);
  upgraded.close();
  // Reopening an intact initialized database is unchanged by the check.
  const reopened=new MnemuronStore(file);assert.equal(reopened.lifecycle.generation(A),3);reopened.close();
});

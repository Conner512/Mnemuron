// Project lifecycle foundation (LF-01..LF-09): schema v8, old-reader refusals, owner-first resolution,
// idempotent operations, the owner/global mutation epoch, protection loss and append-only history.
// Disposable synthetic databases only. The v7 reader is the exact phase 3 source (ffbd18b) exported from Git.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {MnemuronStore} from '../lib/store.mjs';
import {VectorIndex} from '../lib/vector-stores/index.mjs';
import {MATERIAL_TABLES,OPTIONAL_GROUPS,assertProtection,ownerEpoch,globalEpoch,triggerName} from '../lib/lifecycle/protection.mjs';
import {MAX_SOURCE_MEMBERS,MAX_CHAIN_DEPTH,ProjectLifecycle} from '../lib/lifecycle/resolver.mjs';
import {CONSOLE_ACTIONS,CONSOLE_FEATURE_VIEWS,CONSOLE_LIFECYCLE_CONFIRMS} from '../../shared/console-contract.mjs';
import {CORE_SCHEMA_VERSION} from '../lib/store/schema.mjs';

const ROOT=path.resolve(import.meta.dirname,'../..');
const V7_SOURCE='ffbd18b5f21269ecfae01e801a480953a93ca271';
const A='synthetic-lf-a',B='synthetic-lf-b';

function temp(t,label){const dir=mkdtempSync(path.join(os.tmpdir(),`mnemuron-lf-${label}-`));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
let v7Module=null;
async function v7Store(t){
  if(v7Module)return v7Module;
  // The accepted phase 3 release (schema v7), byte-exact from history; a shallow checkout cannot run this test.
  const dir=mkdtempSync(path.join(os.tmpdir(),'mnemuron-lf-v7-source-'));
  const tar=execFileSync('git',['archive','--format=tar',V7_SOURCE,'server','shared','package.json'],{cwd:ROOT,maxBuffer:64*1024*1024});
  writeFileSync(path.join(dir,'source.tar'),tar);execFileSync('tar',['-xf',path.join(dir,'source.tar'),'-C',dir]);
  v7Module=await import(pathToFileURL(path.join(dir,'server/lib/store.mjs')).href);
  return v7Module;
}
function open(file,options={}){return new MnemuronStore(file,options);}
function owner(store,user){
  const c=store.issueCredential({userId:user,deviceId:`device-${user}`,agentId:'synthetic',agentInstanceId:`agent-${user}`,scopes:['memory:read','memory:write','admin:tasks']});
  return store.authenticate(c.api_key);
}
// Content of every non-internal table, for "a refused open changed nothing" checks.
function snapshot(file){
  const db=new DatabaseSync(file,{readOnly:true});
  try{return Object.fromEntries([['user_version',db.prepare('PRAGMA user_version').get().user_version],
    ...db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_search_fts%' ORDER BY name").all()
      .map(({name})=>[name,JSON.stringify(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all())])]);}
  finally{db.close();}
}
function seed(store){
  const a=owner(store,A),b=owner(store,B);
  store.upsertTask(a,{task_id:'lf-task-a',project_id:'lf-project-a',project_name:'LF project A',title:'LF task A',goal:'Synthetic'});
  store.upsertTask(b,{task_id:'lf-task-b',project_id:'lf-project-b',project_name:'LF project B',title:'LF task B',goal:'Synthetic'});
  store.saveMemory(a,{scope:'project',project_id:'lf-project-a',content:'Synthetic LF memory A'});
  return {a,b};
}

test('LF-01: a fresh database is at the current schema with every required material table protected and stable on reopen',async t=>{
  const file=path.join(temp(t,'fresh'),'core.sqlite3');
  let store=open(file);seed(store);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,CORE_SCHEMA_VERSION);
  const required=MATERIAL_TABLES.filter(e=>!OPTIONAL_GROUPS.includes(e.group)).map(e=>e.table);
  const recorded=store.db.prepare('SELECT table_name,losses FROM lifecycle_protection').all();
  assert.deepEqual(recorded.map(r=>r.table_name).sort(),[...required].sort());
  assert.ok(recorded.every(r=>r.losses===0));
  assert.doesNotThrow(()=>assertProtection(store.db));
  const before={global:globalEpoch(store.db),a:ownerEpoch(store.db,A)};store.close();
  store=open(file);
  assert.deepEqual({global:globalEpoch(store.db),a:ownerEpoch(store.db,A)},before,'a clean reopen repairs nothing and invalidates nothing');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM project_lifecycle").get().n,0,'no backfill: every project is implicitly active');
  store.close();
});

test('LF-02: the exact v7 release upgrades to the current schema with every existing row unchanged; a failed v8 step rolls back',async t=>{
  const {MnemuronStore:V7}=await v7Store(t);
  const file=path.join(temp(t,'upgrade'),'core.sqlite3');
  const old=new V7(file);seed(old);old.close();
  const before=snapshot(file);assert.equal(before.user_version,7);
  const store=open(file);store.close();
  const after=snapshot(file);assert.equal(after.user_version,CORE_SCHEMA_VERSION);
  for(const [table,rows] of Object.entries(before))if(table!=='user_version')assert.equal(after[table],rows,`${table} rows unchanged by the upgrade`);
  // A conflicting pre-existing object makes the v8 step fail: nothing of v8 remains and the version stays 7.
  const broken=path.join(temp(t,'broken'),'core.sqlite3');
  const v7=new V7(broken);seed(v7);v7.db.exec('CREATE TABLE project_lifecycle_events (unrelated TEXT)');v7.close();
  const kept=snapshot(broken);
  assert.throws(()=>open(broken),/project_id|no such column/);
  const failed=snapshot(broken);assert.equal(failed.user_version,7);
  assert.equal('project_lifecycle' in failed,false,'the failed step created nothing');
  assert.deepEqual(failed,kept);
});

test('LF-03: old readers refuse before reading or writing any record; this enforcing build opens consistent lifecycle state and refuses inconsistent state before writing',async t=>{
  const {MnemuronStore:V7}=await v7Store(t);
  const file=path.join(temp(t,'refuse'),'core.sqlite3');
  let store=open(file);seed(store);store.close();
  let before=snapshot(file);
  assert.throws(()=>new V7(file),{code:'SCHEMA_VERSION_UNSUPPORTED'},'the v7 release refuses a current-schema database');
  assert.deepEqual(snapshot(file),before);
  for(const state of ['deleted','merged']){
    const raw=new DatabaseSync(file);
    raw.prepare('DELETE FROM project_lifecycle').run();
    raw.prepare('INSERT INTO project_lifecycle VALUES (?,?,?,?,1,?)').run(A,'lf-project-a',state,state==='merged'?'lf-project-merged-target':null,new Date().toISOString());raw.close();
    before=snapshot(file);
    if(state==='deleted'){
      // Schema v10 enforces deleted projects, so a consistent deleted project opens and reads as deleted to its owner.
      const store=open(file);try{assert.throws(()=>store.queryMemories(owner(store,A),{query:'Synthetic',project_id:'lf-project-a'}),{errorCode:'PROJECT_DELETED'});}finally{store.close();}
    }else{
      // A merge into a project the owner does not own is inconsistent: refused at open before any write.
      assert.throws(()=>open(file),{errorCode:'PROJECT_LIFECYCLE_CORRUPT'},`this build refuses an inconsistent ${state} project`);
      assert.deepEqual(snapshot(file),before,`refusing an inconsistent ${state} project wrote nothing (no repair inserts, no trigger repair)`);
    }
  }
  const raw=new DatabaseSync(file);raw.prepare('DELETE FROM project_lifecycle').run();raw.exec(`PRAGMA user_version = ${CORE_SCHEMA_VERSION+1}`);raw.close();
  before=snapshot(file);
  assert.throws(()=>open(file),{code:'SCHEMA_VERSION_UNSUPPORTED'},'this build refuses a newer schema version');
  assert.deepEqual(snapshot(file),before);
});

test('LF-04: resolution is owner-first, implicit-active, transitive, bounded and fails closed',async t=>{
  const store=open(path.join(temp(t,'resolve'),'core.sqlite3'));t.after(()=>store.close());
  const {a}=seed(store),L=store.lifecycle,row=(user,id,state,into)=>store.db.prepare('INSERT OR REPLACE INTO project_lifecycle VALUES (?,?,?,?,1,?)').run(user,id,state,into??null,new Date().toISOString());
  const project=id=>store.upsertProject(a,{project_id:id,name:id});
  assert.deepEqual(L.resolve(A,'lf-project-a'),{requested_project_id:'lf-project-a',canonical_project_id:'lf-project-a',routed:false,state:'active',effective_state:'active',lifecycle_revision:0,chain:['lf-project-a']});
  for(const id of ['lf-project-b','never-created'])assert.throws(()=>L.resolve(A,id),{errorCode:'PROJECT_NOT_FOUND',message:'Project not found.'});
  for(const id of ['lf-c','lf-b2','lf-a2'])project(id);
  row(A,'lf-a2','merged','lf-b2');row(A,'lf-b2','merged','lf-c');
  const routed=L.resolve(A,'lf-a2');
  assert.deepEqual([routed.canonical_project_id,routed.routed,routed.state,routed.effective_state,routed.chain],['lf-c',true,'merged','active',['lf-a2','lf-b2','lf-c']]);
  assert.deepEqual(L.members(A,'lf-c').map(m=>[m.project_id,m.origin]),[['lf-c',true],['lf-b2',false],['lf-a2',false]]);
  assert.throws(()=>L.members(A,'lf-a2'),{errorCode:'PROJECT_NOT_CANONICAL'});
  row(A,'lf-c','deleted');assert.equal(L.resolve(A,'lf-a2').effective_state,'deleted','a merged source is effectively what its canonical target is');
  row(A,'lf-c','merged','lf-a2');assert.throws(()=>L.resolve(A,'lf-a2'),{errorCode:'PROJECT_LIFECYCLE_CORRUPT'},'cycle');
  row(A,'lf-c','merged','lf-project-b');assert.throws(()=>L.resolve(A,'lf-c'),{errorCode:'PROJECT_LIFECYCLE_CORRUPT'},'foreign target');
  row(A,'lf-c','merged','missing-target');assert.throws(()=>L.resolve(A,'lf-c'),{errorCode:'PROJECT_LIFECYCLE_CORRUPT'},'missing target');
  row(A,'lf-c','active');
  // Exactly the source limit is accepted; one more fails closed. The canonical target is not counted.
  store.db.prepare("DELETE FROM project_lifecycle").run();project('lf-hub');
  for(let i=0;i<MAX_SOURCE_MEMBERS;i++){project(`lf-src-${i}`);row(A,`lf-src-${i}`,'merged','lf-hub');}
  assert.equal(L.members(A,'lf-hub').length,MAX_SOURCE_MEMBERS+1);
  project('lf-src-extra');row(A,'lf-src-extra','merged','lf-hub');
  assert.throws(()=>L.members(A,'lf-hub'),{errorCode:'PROJECT_MEMBER_LIMIT'});
  // Chain depth boundary: resolution follows at most MAX_CHAIN_DEPTH merge edges. 20 edges (21 projects) resolve,
  // 21 edges fail closed.
  store.db.prepare("DELETE FROM project_lifecycle").run();
  const chain=Array.from({length:MAX_CHAIN_DEPTH+2},(_,i)=>`lf-depth-${String(i).padStart(2,'0')}`);chain.forEach(project);
  for(let i=1;i<=MAX_CHAIN_DEPTH;i++)row(A,chain[i],'merged',chain[i-1]);
  const deep=L.resolve(A,chain[MAX_CHAIN_DEPTH]);
  assert.deepEqual([deep.canonical_project_id,deep.chain.length],[chain[0],MAX_CHAIN_DEPTH+1],'exactly MAX_CHAIN_DEPTH edges resolve');
  row(A,chain[MAX_CHAIN_DEPTH+1],'merged',chain[MAX_CHAIN_DEPTH]);
  assert.throws(()=>L.resolve(A,chain[MAX_CHAIN_DEPTH+1]),{errorCode:'PROJECT_LIFECYCLE_CORRUPT'},'one edge more fails closed');
  // Owner B cannot resolve or enumerate A's projects, merged or not.
  for(const id of ['lf-hub','lf-src-0'])assert.throws(()=>L.resolve(B,id),{errorCode:'PROJECT_NOT_FOUND'});
  assert.throws(()=>L.members(B,'lf-hub'),{errorCode:'PROJECT_NOT_FOUND'});
});

test('LF-05: lifecycle operation IDs replay the same request, refuse a different one and serialize',async t=>{
  const dir=temp(t,'operations'),file=path.join(dir,'core.sqlite3');
  const store=open(file);t.after(()=>store.close());seed(store);
  let applied=0;const apply=()=>({applied:++applied});
  assert.deepEqual(store.lifecycle.operation(A,'op-1','synthetic.noop',{project_id:'lf-project-a'},apply),{applied:1,replayed:false});
  assert.deepEqual(store.lifecycle.operation(A,'op-1','synthetic.noop',{project_id:'lf-project-a'},apply),{applied:1,replayed:true});
  assert.throws(()=>store.lifecycle.operation(A,'op-1','synthetic.noop',{project_id:'other'},apply),{errorCode:'IDEMPOTENCY_CONFLICT'});
  assert.throws(()=>store.lifecycle.operation(A,'op-1','synthetic.other',{project_id:'lf-project-a'},apply),{errorCode:'IDEMPOTENCY_CONFLICT'});
  assert.equal(applied,1);
  // A callback that writes a business row and then fails rolls back that row and leaves no receipt; the retry
  // applies once and is replayed afterwards without applying again.
  const projectName=()=>store.db.prepare('SELECT name FROM projects WHERE project_id=?').get('lf-project-a').name,name=projectName();
  const receipt=id=>store.db.prepare('SELECT COUNT(*) n FROM project_lifecycle_operations WHERE user_id=? AND operation_id=?').get(A,id).n;
  let writes=0;
  const failing=()=>{store.db.prepare('UPDATE projects SET name=? WHERE project_id=?').run('changed by a failing operation','lf-project-a');writes++;throw new Error('Injected failure after a business write');};
  assert.throws(()=>store.lifecycle.operation(A,'op-fail','synthetic.rename',{name:'renamed'},failing),/Injected failure/);
  assert.equal(projectName(),name,'the business write rolled back');assert.equal(receipt('op-fail'),0,'no receipt for a failed operation');
  assert.equal(store.db.isTransaction,false);
  const succeeding=()=>{store.db.prepare('UPDATE projects SET name=? WHERE project_id=?').run('renamed','lf-project-a');writes++;return {renamed:true};};
  assert.deepEqual(store.lifecycle.operation(A,'op-fail','synthetic.rename',{name:'renamed'},succeeding),{renamed:true,replayed:false});
  assert.deepEqual(store.lifecycle.operation(A,'op-fail','synthetic.rename',{name:'renamed'},succeeding),{renamed:true,replayed:true});
  assert.equal(writes,2,'one failed attempt and one applied retry; the replay did not apply');
  assert.equal(projectName(),'renamed');assert.equal(receipt('op-fail'),1);
  // Owner-scoped: another owner may use the same operation ID independently.
  assert.equal(store.lifecycle.operation(B,'op-1','synthetic.noop',{project_id:'lf-project-b'},apply).replayed,false);
  // A second connection cannot record the same operation while the first holds its immediate transaction.
  const competitor=new DatabaseSync(file);t.after(()=>competitor.close());competitor.exec('PRAGMA busy_timeout=50');
  let competing=null;
  store.lifecycle.operation(A,'op-2','synthetic.noop',{},()=>{
    try{competitor.prepare("INSERT INTO project_lifecycle_operations VALUES (?,?,?,?,'completed','{}',?)").run(A,'op-2','synthetic.noop','x',new Date().toISOString());}catch(error){competing=error;}
    return {applied:++applied};});
  assert.equal(competing?.errcode,5,'SQLITE_BUSY while the first operation is open');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM project_lifecycle_operations WHERE user_id=? AND operation_id=?').get(A,'op-2').n,1);
});

test('LF-06: the epoch moves on every material change and only on material changes',async t=>{
  const store=open(path.join(temp(t,'epoch'),'core.sqlite3'));t.after(()=>store.close());
  const {a}=seed(store),db=store.db,e=user=>ownerEpoch(db,user);
  const moved=(label,user,fn)=>{const before=e(user);fn();assert.ok(e(user)>before,`${label} moves the epoch of ${user}`);};
  const still=(label,fn)=>{const before=[e(A),e(B),globalEpoch(db)];fn();assert.deepEqual([e(A),e(B),globalEpoch(db)],before,`${label} does not move any epoch`);};
  const memory=db.prepare('SELECT * FROM memories WHERE user_id=?').get(A);
  moved('An in-place edit with the same timestamp and counts',A,()=>db.prepare('UPDATE memories SET content=? WHERE memory_id=?').run('Edited synthetic content',memory.memory_id));
  moved('A canonical task write by an agent',A,()=>store.upsertTask(a,{...store.taskFromRow(db.prepare('SELECT * FROM tasks WHERE task_id=?').get('lf-task-a')),goal:'Changed'}));
  moved('A web-visibility denial',A,()=>db.prepare('INSERT OR REPLACE INTO memory_web_denials VALUES (?,?,1,?)').run(A,memory.memory_id,'x'));
  const before={a:e(A),b:e(B)};db.prepare('UPDATE memories SET user_id=? WHERE memory_id=?').run(B,memory.memory_id);
  assert.ok(e(A)>before.a&&e(B)>before.b,'an owner change moves both the old and the new owner');
  db.prepare('UPDATE memories SET user_id=? WHERE memory_id=?').run(A,memory.memory_id);
  // Child rows without user_id are attributed through their parent, including replacement and deletion.
  db.prepare("INSERT INTO memory_summaries VALUES ('lf-sum',?,1,?,'[]','technical','{}','current','p','lf-job',1,0,?)").run('lf-group',A,new Date().toISOString());
  moved('A summary claim insert',A,()=>db.prepare("INSERT INTO memory_summary_claims VALUES ('lf-sum',0,'{}')").run());
  moved('A summary claim replacement',A,()=>db.prepare("INSERT OR REPLACE INTO memory_summary_claims VALUES ('lf-sum',0,'{\"x\":1}')").run());
  moved('A summary claim deletion',A,()=>db.prepare("DELETE FROM memory_summary_claims WHERE summary_id='lf-sum'").run());
  moved('A summary deletion',A,()=>db.prepare("DELETE FROM memory_summaries WHERE summary_id='lf-sum'").run());
  moved('A memory deletion',A,()=>db.prepare('DELETE FROM memories WHERE memory_id=?').run(memory.memory_id));
  // Authority changes are material; last-used touches are not.
  const cred=db.prepare('SELECT * FROM credentials WHERE user_id=? LIMIT 1').get(A);
  still('A last-used touch and a label change',()=>db.prepare('UPDATE credentials SET last_used_at=?,label=? WHERE credential_id=?').run(new Date().toISOString(),'renamed',cred.credential_id));
  for(const [column,value] of [['scopes_json','["memory:read"]'],['device_id','other-device'],['agent_instance_id','other-instance'],['revoked_at',new Date().toISOString()]])
    moved(`A credential ${column} change`,A,()=>db.prepare(`UPDATE credentials SET ${column}=? WHERE credential_id=?`).run(value,cred.credential_id));
  // Job source sets and outcomes are material; leases and attempts are not.
  db.prepare("INSERT INTO memory_jobs (job_id,fingerprint,job_type,user_id,scope_key,group_key,profile,metadata_json,input_hash,highwater,state,attempt_count,run_after,fence,created_at,updated_at,total,processed) VALUES ('lf-job','lf-fp','summary',?,'k','g','p','{}','h',0,'queued',0,0,0,0,0,1,0)").run(A);
  still('A job lease and attempt update',()=>db.prepare("UPDATE memory_jobs SET lease_owner='w',lease_expires=1,attempt_count=1,fence=1,processed=1,updated_at=1 WHERE job_id='lf-job'").run());
  moved('A job state change',A,()=>db.prepare("UPDATE memory_jobs SET state='running' WHERE job_id='lf-job'").run());
  moved('A job source item',A,()=>db.prepare("INSERT INTO memory_job_items (job_id,ordinal,user_id,memory_id,revision,state_hash,scope_key,state) VALUES ('lf-job',0,?,'m',1,'h','k','pending')").run(A));
  // Reads, audit rows and rolled-back writes leave the epoch as it was.
  still('Reads and audit records',()=>{store.listProjects(A);store.audit({auth:a,action:'synthetic.read'});});
  still('A rolled-back write',()=>{db.exec('BEGIN');db.prepare('UPDATE projects SET name=? WHERE project_id=?').run('rolled back','lf-project-a');db.exec('ROLLBACK');});
  // Ownerless effects move the global epoch: a global vector generation has no single owner.
  new VectorIndex(store,null,new Map());
  // The public tokens of both owners are invalidated by a global generation change, through the global part only.
  const tokenA=store.lifecycle.epoch(A),tokenB=store.lifecycle.epoch(B);
  db.prepare("INSERT INTO memory_vector_generations (generation,profile,collection_name,state,dimensions,distance,created_at) VALUES ('lf-global','p','c-global','building',3,'Cosine',0)").run();
  const afterInsert={a:store.lifecycle.epoch(A),b:store.lifecycle.epoch(B)};
  db.prepare("UPDATE memory_vector_generations SET state='retired' WHERE generation='lf-global'").run();
  const afterRetire={a:store.lifecycle.epoch(A),b:store.lifecycle.epoch(B)};
  for(const [label,token,now] of [['A after insert',tokenA,afterInsert.a],['B after insert',tokenB,afterInsert.b],['A after retire',afterInsert.a,afterRetire.a],['B after retire',afterInsert.b,afterRetire.b]]){
    assert.notDeepEqual(now,token,`${label}: the earlier token no longer matches`);
    assert.ok(now.global>token.global,`${label}: the global part moved`);
    assert.equal(now.owner,token.owner,`${label}: the owner-local part is unchanged`);
  }
  db.prepare("INSERT INTO memory_vector_owners VALUES ('lf-owned',?)").run(A);
  moved('An owned generation change',A,()=>db.prepare("INSERT INTO memory_vector_generations (generation,profile,collection_name,state,dimensions,distance,created_at) VALUES ('lf-owned','p','c-owned','building',3,'Cosine',0)").run());
});

test('LF-07: optional vector tables are protected when created later, and a protection loss invalidates tokens',async t=>{
  const file=path.join(temp(t,'protection'),'core.sqlite3');
  let store=open(file);seed(store);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='memory_vector_documents'").get().n,0,'vectors are not configured');
  assert.doesNotThrow(()=>assertProtection(store.db),'an absent optional group is accepted');
  new VectorIndex(store,null,new Map(),{ownerId:A});// later Console-style initialization
  assert.doesNotThrow(()=>assertProtection(store.db,['vector']));
  for(const op of ['insert','update','delete'])assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(triggerName('memory_vector_documents',op)));
  // An optional group with a missing trigger is not accepted as protected.
  store.db.exec(`DROP TRIGGER ${triggerName('memory_vector_documents','update')}`);
  assert.throws(()=>assertProtection(store.db,['vector']),{errorCode:'LIFECYCLE_PROTECTION_MISSING'});
  const token={global:globalEpoch(store.db),a:ownerEpoch(store.db,A)};
  // Protection lost: a trigger is dropped, a write goes uncounted, another trigger is altered.
  store.db.exec(`DROP TRIGGER ${triggerName('projects','update')}`);
  store.db.prepare('UPDATE projects SET name=? WHERE project_id=?').run('Changed while unprotected','lf-project-a');
  assert.equal(ownerEpoch(store.db,A),token.a,'the unprotected write was not counted');
  store.db.exec(`DROP TRIGGER ${triggerName('tasks','insert')}`);store.db.exec(`CREATE TRIGGER ${triggerName('tasks','insert')} AFTER INSERT ON tasks BEGIN SELECT 1; END`);
  store.close();
  store=open(file);
  assert.doesNotThrow(()=>assertProtection(store.db));
  assert.ok(globalEpoch(store.db)>token.global,'repairing a lost trigger moves the global epoch, so the old token can never match again');
  const losses=Object.fromEntries(store.db.prepare('SELECT table_name,losses FROM lifecycle_protection WHERE losses>0').all().map(r=>[r.table_name,r.losses]));
  assert.deepEqual(losses,{projects:1,tasks:1,memory_vector_documents:1});
  const after=globalEpoch(store.db);store.close();store=open(file);
  assert.equal(globalEpoch(store.db),after,'a clean reopen after repair moves nothing');store.close();
  // A partially present optional group is refused before anything is repaired or counted.
  const raw=new DatabaseSync(file);raw.exec('DROP TABLE memory_vector_generations');raw.close();
  const before=snapshot(file);
  assert.throws(()=>open(file),{errorCode:'LIFECYCLE_PROTECTION_MISSING'});
  assert.deepEqual(snapshot(file),before,'the refused open wrote nothing');
});

test('LF-08: lifecycle history is append-only, including INSERT OR REPLACE',async t=>{
  const store=open(path.join(temp(t,'append'),'core.sqlite3'));t.after(()=>store.close());
  const db=store.db,insert=sql=>db.prepare(sql).run('lf-event',A,'lf-project-a','synthetic',new Date().toISOString());
  insert('INSERT INTO project_lifecycle_events (event_id,user_id,project_id,action,created_at) VALUES (?,?,?,?,?)');
  const original=db.prepare("SELECT * FROM project_lifecycle_events WHERE event_id='lf-event'").get();
  assert.throws(()=>db.prepare("UPDATE project_lifecycle_events SET action='changed'").run(),/append-only/);
  assert.throws(()=>db.prepare('DELETE FROM project_lifecycle_events').run(),/append-only/);
  assert.throws(()=>insert('INSERT OR REPLACE INTO project_lifecycle_events (event_id,user_id,project_id,action,created_at) VALUES (?,?,?,?,?)'),/append-only/);
  assert.throws(()=>insert('REPLACE INTO project_lifecycle_events (event_id,user_id,project_id,action,created_at) VALUES (?,?,?,?,?)'),/append-only/);
  assert.deepEqual({...db.prepare("SELECT * FROM project_lifecycle_events WHERE event_id='lf-event'").get()},{...original});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM project_lifecycle_events').get().n,1);
});

test('LF-09: lifecycle mutations exist only behind the four Console actions; the resolver, the store and other modules never change lifecycle state',()=>{
  // Project actions: the phase 3 edits, Console-only archive (projects.restore is unarchive), and the 5E lifecycle actions.
  assert.deepEqual(CONSOLE_ACTIONS.filter(a=>a.startsWith('projects.')).sort(),['projects.archive','projects.lifecycle_delete','projects.lifecycle_preview','projects.lifecycle_restore','projects.merge','projects.restore','projects.update']);
  assert.equal(CONSOLE_ACTIONS.some(a=>/purge|projects\.delete\b/.test(a)),false,'nothing purges');
  // Every confirm is in the BFF re-authentication list, with exactly its forwarded fields.
  assert.deepEqual(CONSOLE_LIFECYCLE_CONFIRMS,{'projects.lifecycle_delete':['preview_id','confirm_name'],'projects.lifecycle_restore':['preview_id'],'projects.merge':['preview_id']});
  const bff=readFileSync(path.join(ROOT,'services/oauth/src/console.mjs'),'utf8');
  // In the lifecycle branch: the read-only staleness pre-check, then re-authentication, then the stripped Core call.
  const branch=bff.slice(bff.indexOf('Object.hasOwn(CONSOLE_LIFECYCLE_CONFIRMS,action)){'),bff.indexOf("else if(['devices.revoke'"));
  const at=needle=>branch.indexOf(needle);
  assert.ok(at("view('lifecycle-preview-check'")>0&&at('reauthenticate(')>at("view('lifecycle-preview-check'")&&at('.action({action,operation_id,payload:Object.fromEntries(')>at('reauthenticate('),
    'the BFF pre-checks, re-authenticates and forwards only the confirm fields, in that order');
  assert.equal(CONSOLE_FEATURE_VIEWS.some(v=>/lifecycle|merge/.test(v)),false);
  const lifecycle=Object.getOwnPropertyNames(ProjectLifecycle.prototype).sort();
  assert.deepEqual(lifecycle,['bumpGeneration','constructor','epoch','generation','live','liveProject','logRoute','members','operation','owned','projectState','resolve','row','scope','view','writeProject'],'the resolver only reads, guards writes, records operations and bumps the generation for a caller');
  assert.equal(/INSERT[^;]*project_lifecycle\b|UPDATE\s+project_lifecycle\b/i.test(readFileSync(path.join(ROOT,'server/lib/lifecycle/resolver.mjs'),'utf8')),false,'the resolver never writes lifecycle state');
  // Only the mutations module writes lifecycle rows and bumps the generation.
  for(const file of ['server/lib/store.mjs','server/lib/console/service.mjs','server/lib/console/projects.mjs','server/lib/app.mjs'])
    assert.equal(/bumpGeneration|INSERT[^;]*project_lifecycle\b|UPDATE\s+project_lifecycle\b/i.test(readFileSync(path.join(ROOT,file),'utf8')),false,`${file} never changes lifecycle state`);
  assert.match(readFileSync(path.join(ROOT,'server/lib/lifecycle/mutations.mjs'),'utf8'),/bumpGeneration/);
  const store=Object.getOwnPropertyNames(MnemuronStore.prototype).filter(n=>/delete|merge|restore|lifecycle/i.test(n));
  assert.deepEqual(store,[],'no store method deletes, merges or restores projects');
});

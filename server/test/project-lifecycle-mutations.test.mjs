// Project lifecycle mutations (phase 5E, LM-01..LM-07): recoverable delete, restore and canonical merge through the
// Console preview → confirm actions. Synthetic isolated fixtures only (a disposable Core behind loopback); no models.
// The BFF password + OTP gate for confirms is tested in services/oauth (5F).
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {world} from './helpers/lifecycle-world.mjs';
import {CONSOLE_WRITE_SCOPES,CONSOLE_BASIC_SCOPES,CONSOLE_READ_SCOPES} from '../../shared/console-contract.mjs';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {MemoryWorker,scheduleLibrary} from '../lib/memory-jobs/worker.mjs';
import {organizer,taxonomy} from './helpers/memory-models.mjs';

const count=(w,table,where='1',...params)=>w.store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...params).n;
const code=expected=>error=>{assert.equal(error.errorCode||error.code,expected,`${error.errorCode||error.code}: ${error.message}`);return true;};
const records=w=>JSON.stringify(['memories','memory_revisions','tasks','checkpoints','events','projects','memory_summaries'].map(t=>w.store.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
function setup(w){
  const c=w.store.issueCredential({userId:w.user,deviceId:'d-lm',agentId:'mnemuron-console',agentInstanceId:`lm-${randomUUID()}`,scopes:[...CONSOLE_WRITE_SCOPES]});
  const writer=w.store.authenticate(c.api_key),service=w.store.consoleService;
  const act=(action,payload,op=randomUUID(),auth=writer)=>service.execute(auth,{action,operation_id:op,payload});
  const preview=(action,project_id,target)=>act('projects.lifecycle_preview',{action,project_id,...(target?{target_project_id:target}:{})});
  const project=(id,name=`LM ${id}`)=>{w.store.upsertProject(w.a.auth,{project_id:id,name});return id;};
  const save=(project,text)=>w.store.saveMemory(w.a.auth,{scope:'project',project_id:project,content:`LMMARK ${text}`}).memory.memory_id;
  return {writer,service,act,preview,project,save};
}

test('LM-01: delete: preview shows the full impact and needs the typed name; confirm hides everything, purges nothing and replays',async t=>{
  const w=await world(t),{store}=w,{act,preview,project,save}=setup(w);
  project('lm-del','LM Delete Me');w.task('task-lm-del','lm-del','LM Delete Me');const m=save('lm-del','to be hidden');
  const p=await preview('delete','lm-del');
  assert.deepEqual([p.status,p.requires_typed_name,p.requires_reauthentication,p.merge_undo_available],['previewed',true,true,false]);
  assert.deepEqual([p.impact.totals.tasks,p.impact.totals.memories,p.impact.members_total],[1,1,1]);
  const before=records(w),generation=store.lifecycle.generation(w.user);
  await assert.rejects(act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Delete'}),code('CONFIRMATION_MISMATCH'));
  assert.equal(store.lifecycle.projectState(w.user,'lm-del'),'live','a wrong name changes nothing');
  const op=randomUUID(),done=await act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Delete Me'},op);
  assert.deepEqual([done.status,done.records_purged,done.generation],['deleted',0,generation+1]);
  assert.equal(records(w),before,'every record is retained unchanged');
  assert.throws(()=>store.queryMemories(w.a.auth,{query:'LMMARK',project_id:'lm-del'}),code('PROJECT_DELETED'));
  assert.ok(!store.queryMemories(w.a.auth,{query:'LMMARK'}).results.some(r=>r.memory_id===m));
  assert.throws(()=>store.upsertProject(w.a.auth,{project_id:'lm-del',name:'Recreated'}),code('PROJECT_DELETED'),'the ID stays reserved');
  assert.equal(count(w,'project_lifecycle_events',"project_id='lm-del' AND action='project.delete'"),1);
  const replay=await act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Delete Me'},op);
  assert.deepEqual([replay.replayed,replay.lifecycle_event_id],[true,done.lifecycle_event_id],'same operation replays the result');
  assert.equal(store.lifecycle.generation(w.user),generation+1,'a replay changes nothing');
  await assert.rejects(act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Delete Me'}),code('PREVIEW_CHANGED'),'a used preview cannot confirm again');
});

test('LM-02: stale previews never confirm: any material change, a second tab, expiry, another owner or another action',async t=>{
  const w=await world(t),{store}=w,{act,preview,project,save,service}=setup(w);
  project('lm-stale','LM Stale');save('lm-stale','initial');
  project('lm-unrelated');let p=await preview('delete','lm-stale');save('lm-unrelated',`unrelated ${randomUUID()}`);
  await assert.rejects(act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Stale'}),code('PREVIEW_CHANGED'),'an unrelated material write moves the owner epoch');
  // Two tabs: confirming one supersedes the other.
  const first=await preview('delete','lm-stale'),second=await preview('delete','lm-stale');
  await act('projects.lifecycle_delete',{preview_id:first.preview_id,confirm_name:'LM Stale'});
  await assert.rejects(act('projects.lifecycle_delete',{preview_id:second.preview_id,confirm_name:'LM Stale'}),code('PREVIEW_CHANGED'));
  // Expiry, another action, an unknown or foreign preview.
  p=await preview('restore','lm-stale');const clock=service.lifecycleMutations.clock;service.lifecycleMutations.clock=()=>Date.now()+11*60*1000;
  await assert.rejects(act('projects.lifecycle_restore',{preview_id:p.preview_id}),code('PREVIEW_EXPIRED'));service.lifecycleMutations.clock=clock;
  await assert.rejects(act('projects.merge',{preview_id:p.preview_id}),code('PREVIEW_REQUIRED'),'a restore preview cannot confirm a merge');
  await assert.rejects(act('projects.lifecycle_restore',{preview_id:randomUUID()}),code('PREVIEW_REQUIRED'));
  const otherOwner=store.authenticate(store.issueCredential({userId:w.other.auth.user_id,deviceId:'d-lm-b',agentId:'mnemuron-console',agentInstanceId:'lm-b',scopes:[...CONSOLE_WRITE_SCOPES]}).api_key);
  await assert.rejects(service.execute(otherOwner,{action:'projects.lifecycle_restore',operation_id:randomUUID(),payload:{preview_id:p.preview_id}}),code('PREVIEW_REQUIRED'),'another owner cannot use it');
  await assert.rejects(service.execute(otherOwner,{action:'projects.lifecycle_preview',operation_id:randomUUID(),payload:{action:'delete',project_id:'lm-stale'}}),code('PROJECT_NOT_FOUND'),'nor learn the project exists');
  assert.equal(store.lifecycle.projectState(w.user,'lm-stale'),'deleted');
});

test('LM-03: restore: the canonical project and its members return, Console archive is kept, old authority stays stale, stale jobs rerun',async t=>{
  const w=await world(t,{readerScopes:['memory:read','resume:read','resume:confirm']}),{store}=w,{act,preview,project,save}=setup(w);
  project('lm-res','LM Restore');project('lm-res-src','LM Restore Source');w.task('task-lm-res','lm-res','LM Restore');save('lm-res','restorable record');
  const merge=await preview('merge','lm-res-src','lm-res');await act('projects.merge',{preview_id:merge.preview_id});
  await act('projects.archive',{project_id:'lm-res'});
  const resume=store.createPreview(w.reader.auth,{query:'lm resume',signals:{task_id:'task-lm-res'}});
  const jobs=new MemoryJobs(store),model=organizer();
  scheduleLibrary(store,jobs,{userId:w.user,organizer:model,taxonomy,includeOpen:true,periods:['daily']});
  const del=await preview('delete','lm-res');await act('projects.lifecycle_delete',{preview_id:del.preview_id,confirm_name:'LM Restore'});
  const ran=await new MemoryWorker(store,jobs,model).drain();
  const staleJobs=ran.filter(r=>r.state==='stale').map(r=>r.job_id);assert.ok(staleJobs.length>0,'jobs over the deleted project went stale');
  await assert.rejects(preview('restore','lm-res-src'),code('PROJECT_NOT_CANONICAL'),'a merged source is restored with its target');
  await assert.rejects(preview('restore','lm-live-never-deleted').catch(e=>{throw e;}),code('PROJECT_NOT_FOUND'));
  const res=await preview('restore','lm-res');assert.equal(res.impact.members_total,2);
  const done=await act('projects.lifecycle_restore',{preview_id:res.preview_id});
  assert.deepEqual([done.status,done.rescheduled_jobs>0],['restored',true]);
  assert.equal(store.lifecycle.projectState(w.user,'lm-res'),'live');assert.equal(store.lifecycle.projectState(w.user,'lm-res-src'),'live');
  assert.ok(store.queryMemories(w.a.auth,{query:'LMMARK',project_id:'lm-res-src'}).results.length>0,'members read through the restored group');
  assert.ok(store.db.prepare("SELECT archived_at FROM console_project_state WHERE project_id='lm-res'").get().archived_at,'the Console archive state survives delete and restore');
  assert.throws(()=>store.confirmPreview(w.reader.auth,resume.resume_id,resume.preview_version,true),code('LIFECYCLE_AUTHORITY_STALE'),'restore never revives earlier authority');
  for(const id of staleJobs)assert.equal(jobs.get(id).state,'pending','stale jobs are rescheduled');
  assert.ok((await new MemoryWorker(store,jobs,model).drain()).every(r=>r.state==='succeeded'));
  await assert.rejects(preview('restore','lm-res'),code('PROJECT_NOT_DELETED'));
});

test('LM-04: merge: sources route to the target, conflicts are shown and never resolved, invalid pairs and limits are refused',async t=>{
  const w=await world(t),{store}=w,{act,preview,project,save}=setup(w);
  project('lm-s','LM Shared');project('lm-t','LM Target');
  store.upsertProject(w.a.auth,{project_id:'lm-t',name:'LM Target',aliases:['lm shared']});
  w.task('task-lm-s','lm-s','LM Shared',{title:'Same title'});w.task('task-lm-t','lm-t','LM Target',{title:'same title'});
  const sMemory=save('lm-s','source record');
  const p=await preview('merge','lm-s','lm-t');
  assert.deepEqual(p.impact.conflicts.map(c=>c.kind).sort(),['name_or_alias_collision','same_task_title']);
  assert.equal(p.impact.members_total,2);
  const done=await act('projects.merge',{preview_id:p.preview_id});assert.deepEqual([done.status,done.merge_undo_available],['merged',false]);
  assert.equal(count(w,'tasks',"task_id IN ('task-lm-s','task-lm-t')"),2,'same-titled Tasks stay distinct');
  assert.equal(store.db.prepare("SELECT project_id FROM memories WHERE memory_id=?").get(sMemory).project_id,'lm-s','no record is reparented');
  const routed=save('lm-s','new through the old ID');
  assert.equal(store.db.prepare("SELECT project_id FROM memories WHERE memory_id=?").get(routed).project_id,'lm-t');
  // Invalid pairs.
  project('lm-u','LM Other');
  await assert.rejects(preview('merge','lm-u','lm-u'),code('PROJECT_MERGE_CONFLICT'));
  await assert.rejects(preview('merge','lm-u','lm-s'),code('PROJECT_NOT_CANONICAL'),'never into a merged source');
  await assert.rejects(preview('merge','lm-s','lm-u'),code('PROJECT_NOT_CANONICAL'),'a source is moved through its canonical project');
  await assert.rejects(preview('merge','lm-u','proj-lr-dead'),code('PROJECT_DELETED'));
  await assert.rejects(preview('merge','lm-u','proj-foreign-never'),code('PROJECT_NOT_FOUND'));
  // Flattening: the target group (with its source) merges onward; every member then resolves to the new target.
  const onward=await preview('merge','lm-t','lm-u');await act('projects.merge',{preview_id:onward.preview_id});
  assert.equal(store.lifecycle.resolve(w.user,'lm-s').canonical_project_id,'lm-u');
  // Member limit: lm-u already has 2 sources; 18 more reach the limit of 20, and one more is refused.
  for(let i=0;i<18;i++){const id=project(`lm-many-${i}`);const q=await preview('merge',id,'lm-u');await act('projects.merge',{preview_id:q.preview_id});}
  const extra=project('lm-extra');await assert.rejects(preview('merge',extra,'lm-u'),code('PROJECT_MEMBER_LIMIT'));
});

test('LM-05: only full Console write credentials preview or confirm; agent, admin:tasks, read-only and basic Console credentials are refused',async t=>{
  const w=await world(t),{store}=w,{preview,project}=setup(w);project('lm-auth','LM Auth');
  const p=await preview('delete','lm-auth');
  const as=(agent,scopes)=>store.authenticate(store.issueCredential({userId:w.user,deviceId:'d-lm-auth',agentId:agent,agentInstanceId:`lm-auth-${randomUUID()}`,scopes}).api_key);
  for(const [label,auth] of [['agent admin:tasks',w.a.auth],['console basic',as('mnemuron-console',[...CONSOLE_BASIC_SCOPES])],['console read',as('mnemuron-console',[...CONSOLE_READ_SCOPES])],['other agent with console scopes',as('chatgpt-web',[...CONSOLE_WRITE_SCOPES])]])
    for(const [action,payload] of [['projects.lifecycle_preview',{action:'delete',project_id:'lm-auth'}],['projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Auth'}],['projects.lifecycle_restore',{preview_id:p.preview_id}],['projects.merge',{preview_id:p.preview_id}]])
      await assert.rejects(store.consoleService.execute(auth,{action,operation_id:randomUUID(),payload}),error=>/scope|console:write/i.test(error.message),`${label}: ${action}`);
  assert.equal(store.lifecycle.projectState(w.user,'lm-auth'),'live');
  // Core HTTP: the Console action route does not exist for an agent credential (404), and nothing changes.
  const r=await w.request('POST','/v1/console/action',{action:'projects.lifecycle_preview',operation_id:randomUUID(),payload:{action:'delete',project_id:'lm-auth'}});
  assert.ok([401,403,404].includes(r.status),`HTTP ${r.status}`);assert.equal(store.lifecycle.projectState(w.user,'lm-auth'),'live');
});

test('LM-06: a confirm is serialized and atomic: a concurrent lifecycle change makes it stale, and an injected failure leaves nothing',async t=>{
  const w=await world(t),{store}=w,{act,preview,project}=setup(w);project('lm-race','LM Race');project('lm-race-2','LM Race Two');
  // Another connection commits a lifecycle change after the preview.
  let p=await preview('delete','lm-race');
  const other=new DatabaseSync(store.databasePath);t.after(()=>{if(other.isOpen)other.close();});
  other.exec('BEGIN IMMEDIATE');other.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,'lm-race-2','deleted',NULL,1,?)").run(w.user,new Date().toISOString());
  other.prepare(`INSERT INTO owner_lifecycle_generation (user_id, generation) VALUES (?, COALESCE((SELECT generation FROM owner_lifecycle_generation WHERE user_id = ?), 0) + 1)
    ON CONFLICT (user_id) DO UPDATE SET generation = excluded.generation`).run(w.user,w.user);
  store.db.exec('PRAGMA busy_timeout=50');
  await assert.rejects(act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Race'}),/locked|busy/i,'blocked while the other writer holds the lock');
  other.exec('COMMIT');
  await assert.rejects(act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Race'}),code('PREVIEW_CHANGED'));
  // Injected failure at the end of the confirm: no lifecycle row, generation, history or preview change remains.
  p=await preview('delete','lm-race');
  const state=()=>JSON.stringify([store.lifecycle.projectState(w.user,'lm-race'),store.lifecycle.generation(w.user),count(w,'project_lifecycle_events'),
    store.db.prepare('SELECT state FROM project_lifecycle_previews WHERE preview_id=?').get(p.preview_id).state,count(w,'console_operations'),count(w,'project_lifecycle_operations')]);
  const before=state(),audit=store.audit.bind(store);store.audit=input=>{if(input.action==='project.lifecycle.delete')throw new Error('synthetic failure');return audit(input);};
  t.after(()=>{store.audit=audit;});
  await assert.rejects(act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Race'}),/synthetic failure/);
  store.audit=audit;assert.equal(state(),before);assert.equal(store.db.isTransaction,false);
  assert.equal((await act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Race'})).status,'deleted','control: the same preview then confirms');
});

test('LM-07: the fingerprint covers the complete impact; the stored row and the display are bounded and say when truncated',async t=>{
  const w=await world(t),{store}=w,{preview,project,act}=setup(w),mutations=store.consoleService.lifecycleMutations;
  project('lm-big','LM Big');
  for(let i=0;i<20;i++){const id=project(`lm-src-${i}`);const q=await preview('merge',id,'lm-big');await act('projects.merge',{preview_id:q.preview_id});}
  const p=await preview('delete','lm-big');
  assert.deepEqual([p.impact.members_total,p.impact.members.length,p.impact.members_truncated],[21,20,true]);
  const row=store.db.prepare('SELECT impact_sha256,impact_json FROM project_lifecycle_previews WHERE preview_id=?').get(p.preview_id);
  const full=mutations.impact(w.user,'delete',mutations.subject(w.user,'delete',{project_id:'lm-big'}));
  assert.equal(full.members.length,21,'the fingerprinted impact covers every member');
  const {createHash}=await import('node:crypto');
  assert.equal(row.impact_sha256,createHash('sha256').update(JSON.stringify(full)).digest('hex'));
  assert.equal(JSON.parse(row.impact_json).members.length,20,'the stored row keeps only the bounded display');
  // Conflicts: 21 same-title Tasks are all fingerprinted; the display shows 20 and says so.
  project('lm-conf-t','LM Conflict Target');project('lm-conf-s','LM Conflict Source');
  for(let i=0;i<21;i++){w.task(`task-lm-ct-${i}`,'lm-conf-t','LM Conflict Target',{title:`Conflict ${i}`});w.task(`task-lm-cs-${i}`,'lm-conf-s','LM Conflict Source',{title:`conflict ${i}`});}
  const c=await preview('merge','lm-conf-s','lm-conf-t');
  assert.deepEqual([c.impact.conflicts_total,c.impact.conflicts.length,c.impact.conflicts_truncated],[21,20,true]);
});

test('LM-08: the read-only pre-check reports staleness without writing; restore leaves jobs with still-invalid items stale',async t=>{
  const w=await world(t),{store}=w,{act,preview,project,save,writer}=setup(w),mutations=store.consoleService.lifecycleMutations;
  project('lm-chk','LM Check');save('lm-chk','checked record');
  const p=await preview('delete','lm-chk'),snapshot=()=>records(w)+store.db.prepare('SELECT state FROM project_lifecycle_previews WHERE preview_id=?').get(p.preview_id).state;
  const before=snapshot();
  assert.deepEqual(mutations.check(writer,{preview_id:p.preview_id,action:'delete'}),{read_only:true,current:true});
  assert.deepEqual(mutations.check(writer,{preview_id:p.preview_id,action:'delete',confirm_name:'LM Chec'}),{read_only:true,current:false,error_code:'CONFIRMATION_MISMATCH'});
  assert.equal(snapshot(),before,'the check writes nothing');
  assert.throws(()=>mutations.check(writer,{preview_id:p.preview_id,action:'merge'}),code('PREVIEW_REQUIRED'));
  const other=store.authenticate(store.issueCredential({userId:w.other.auth.user_id,deviceId:'d-lm-chk',agentId:'mnemuron-console',agentInstanceId:'lm-chk-b',scopes:[...CONSOLE_WRITE_SCOPES]}).api_key);
  assert.throws(()=>mutations.check(other,{preview_id:p.preview_id,action:'delete'}),code('PREVIEW_REQUIRED'));
  project('lm-chk-other');save('lm-chk-other','unrelated write');
  assert.deepEqual(mutations.check(writer,{preview_id:p.preview_id,action:'delete'}),{read_only:true,current:false,error_code:'PREVIEW_CHANGED'});
  // Restore reschedules only jobs whose every item validates again.
  const doomed=save('lm-chk','record that stays invalid'),jobs=new MemoryJobs(store),model=organizer();
  scheduleLibrary(store,jobs,{userId:w.user,organizer:model,taxonomy,includeOpen:true,periods:['daily']});
  const del=await preview('delete','lm-chk');await act('projects.lifecycle_delete',{preview_id:del.preview_id,confirm_name:'LM Check'});
  const stale=(await new MemoryWorker(store,jobs,model).drain()).filter(r=>r.state==='stale').map(r=>r.job_id);
  const withDoomed=stale.filter(id=>store.db.prepare('SELECT 1 FROM memory_job_items WHERE job_id=? AND memory_id=?').get(id,doomed));
  assert.ok(withDoomed.length>0);
  // (Synthetic: the item's privacy changes to secret while the project is deleted, so it can no longer validate.)
  store.db.prepare("INSERT OR REPLACE INTO memory_privacy VALUES (?,?,'secret')").run(w.user,doomed);
  const res=await preview('restore','lm-chk');await act('projects.lifecycle_restore',{preview_id:res.preview_id});
  for(const id of withDoomed)assert.equal(jobs.get(id).state,'stale','a job with a still-invalid item is not rescheduled');
});

test('LM-09: the exact earlier readers refuse the database state a real lifecycle mutation produced',async t=>{
  const w=await world(t),{store}=w,{act,preview,project}=setup(w);project('lm-old','LM Old Reader');
  const p=await preview('delete','lm-old');await act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Old Reader'});
  const {execFileSync}=await import('node:child_process'),{mkdtempSync,writeFileSync,rmSync}=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),{pathToFileURL}=await import('node:url');
  const ROOT=path.resolve(import.meta.dirname,'../..'),dir=mkdtempSync(path.join(os.tmpdir(),'mnemuron-lm-v9-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(path.join(dir,'s.tar'),execFileSync('git',['archive','--format=tar','e63249f9847ee9c62620290e9f3210bc063fad9f','server','shared','package.json'],{cwd:ROOT,maxBuffer:64*1024*1024}));
  execFileSync('tar',['-xf',path.join(dir,'s.tar'),'-C',dir]);
  const {MnemuronStore:V9}=await import(pathToFileURL(path.join(dir,'server/lib/store.mjs')).href);
  // A consistent copy of the live database (checkpointed through the backup API).
  const dbDir=mkdtempSync(path.join(os.tmpdir(),'mnemuron-lm-db-'));t.after(()=>rmSync(dbDir,{recursive:true,force:true}));
  const {backup}=await import('node:sqlite'),copy=path.join(dbDir,'copy.sqlite3');await backup(store.db,copy);
  assert.throws(()=>new V9(copy),{code:'SCHEMA_VERSION_UNSUPPORTED'});
});

test('LM-10: the pre-check view is full-write only; old expired previews are pruned; vector impact counts each memory once across generations',async t=>{
  const w=await world(t),{store}=w,{preview,project,save}=setup(w),mutations=store.consoleService.lifecycleMutations;
  project('lm-ten','LM Ten');const m=save('lm-ten','vectorized record');
  // Credentials are issued first: issuing one is a material write that (correctly) makes an earlier preview stale.
  const issue=scopes=>{const c=store.issueCredential({userId:w.user,deviceId:'d-lm-ten',agentId:'mnemuron-console',agentInstanceId:`lm-ten-${randomUUID()}`,scopes});return {...c,auth:store.authenticate(c.api_key)};};
  const basic=issue([...CONSOLE_BASIC_SCOPES]),readonly=issue([...CONSOLE_READ_SCOPES]),writer=issue([...CONSOLE_WRITE_SCOPES]);
  const p=await preview('delete','lm-ten');
  // Core HTTP view: basic and read-only Console credentials cannot use the confirm pre-check.
  for(const owner of [basic,readonly]){
    const r=await w.request('GET',`/v1/console/lifecycle-preview-check?preview_id=${p.preview_id}&action=delete`,undefined,owner);
    assert.ok([401,403].includes(r.status),`HTTP ${r.status}`);
  }
  const full=await w.request('GET',`/v1/console/lifecycle-preview-check?preview_id=${p.preview_id}&action=delete`,undefined,writer);
  assert.deepEqual([full.status,full.body.current],[200,true]);
  // Pruning: a preview that expired more than a day ago is removed at the owner's next preview; a recent one stays.
  const clock=mutations.clock;mutations.clock=()=>Date.now()+2*86400000;t.after(()=>{mutations.clock=clock;});
  const later=await preview('delete','lm-ten');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM project_lifecycle_previews WHERE preview_id=?').get(p.preview_id).n,0,'the old preview was pruned');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM project_lifecycle_previews WHERE preview_id=?').get(later.preview_id).n,1);
  mutations.clock=clock;
  // Vector impact: two generations index the same memory; it is counted once.
  const {VectorIndex}=await import('../lib/vector-stores/index.mjs'),{MockVectorStore}=await import('./helpers/vector-mock.mjs'),{embedder}=await import('./helpers/memory-models.mjs');
  const e=embedder(),index=new VectorIndex(store,new MockVectorStore(),new Map([[e.profile.fingerprint,e]]));
  for(let i=0;i<2;i++)await index.sync(index.begin(e.profile.fingerprint));
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM memory_vector_documents WHERE memory_id=? AND state='indexed'").get(m).n,2,'two generations hold a document for the memory');
  assert.equal((await preview('delete','lm-ten')).impact.totals.vector_indexed_memories,1);
});

test('LM-11: the project list offers active, archived and owner-only deleted views with counts and members, and a name/alias search before paging',async t=>{
  const w=await world(t),{store}=w,{act,preview,project}=setup(w),consoleRead=(await import('../lib/console-read.mjs')).consoleRead;
  const reader=store.authenticate(store.issueCredential({userId:w.user,deviceId:'d-lm-11',agentId:'mnemuron-console',agentInstanceId:'lm-11',scopes:[...CONSOLE_WRITE_SCOPES]}).api_key);
  const list=params=>consoleRead(store,reader,'projects',params);
  project('lm11-keep','Alpha Keep');project('lm11-gone','Bravo Gone');project('lm11-src','Charlie Source');
  store.upsertProject(w.a.auth,{project_id:'lm11-keep',name:'Alpha Keep',aliases:['nickname-delta']});
  let p=await preview('merge','lm11-src','lm11-gone');await act('projects.merge',{preview_id:p.preview_id});
  p=await preview('delete','lm11-gone');await act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'Bravo Gone'});
  const active=await list({});
  assert.ok(active.projects.some(r=>r.project_id==='lm11-keep'));assert.ok(!active.projects.some(r=>['lm11-gone','lm11-src'].includes(r.project_id)));
  assert.equal(active.deleted_count,2,'the fixture already holds one deleted project');
  const deleted=await list({archived:'deleted'});
  assert.equal(deleted.deleted_count,2);
  assert.deepEqual(deleted.projects.filter(r=>r.project_id.startsWith('lm11')).map(r=>[r.project_id,r.deleted,r.merged_project_ids]),[['lm11-gone',true,['lm11-src']]]);
  assert.equal(deleted.retained_history,true);
  assert.deepEqual((await list({query:'delta'})).projects.map(r=>r.project_id),['lm11-keep'],'alias search');
  assert.deepEqual((await list({query:'ALPHA KEEP'})).projects.map(r=>r.project_id),['lm11-keep'],'case-insensitive name search');
  assert.equal((await list({query:'100%_literal'})).projects.length,0,'LIKE wildcards are escaped');
  assert.deepEqual((await list({archived:'deleted',query:'bravo'})).projects.map(r=>r.project_id),['lm11-gone']);
  // Another owner sees none of it.
  const other=store.authenticate(store.issueCredential({userId:w.other.auth.user_id,deviceId:'d-lm-11b',agentId:'mnemuron-console',agentInstanceId:'lm-11b',scopes:[...CONSOLE_WRITE_SCOPES]}).api_key);
  assert.equal((await consoleRead(store,other,'projects',{archived:'deleted'})).projects.length,0);
  // Owner-only lifecycle truth: read-only and basic Console credentials of the same owner get neither the view nor the count.
  for(const scopes of [CONSOLE_READ_SCOPES,CONSOLE_BASIC_SCOPES]){
    const narrow=store.authenticate(store.issueCredential({userId:w.user,deviceId:'d-lm-11n',agentId:'mnemuron-console',agentInstanceId:`lm-11n-${randomUUID()}`,scopes:[...scopes]}).api_key);
    await assert.rejects(consoleRead(store,narrow,'projects',{archived:'deleted'}),code('NOT_FOUND'));
    assert.equal('deleted_count' in await consoleRead(store,narrow,'projects',{}),false);
  }
  // Deleted view counts: the other views' counts are present; deleted_count is unfiltered, matched_count is filtered.
  const filtered=await list({archived:'deleted',query:'bravo'});
  assert.deepEqual([filtered.deleted_count,filtered.matched_count,typeof filtered.active_count,typeof filtered.archived_count],[2,1,'number','number']);
  // Unicode-aware, per-alias search; 'any' includes Console-archived projects (merge targets).
  project('lm11-umlaut','Ärger Projekt');store.upsertProject(w.a.auth,{project_id:'lm11-quote',name:'Quote project',aliases:['say "hello"','second']});
  assert.deepEqual((await list({query:'ärger'})).projects.map(r=>r.project_id),['lm11-umlaut']);
  assert.deepEqual((await list({query:'"hello"'})).projects.map(r=>r.project_id),['lm11-quote'],'an alias with a quote matches');
  assert.equal((await list({query:'hello","second'})).projects.length,0,'a query never spans two aliases');
  await act('projects.archive',{project_id:'lm11-umlaut'});
  assert.equal((await list({query:'ärger'})).projects.length,0,'the active view excludes the archived project');
  assert.deepEqual((await list({archived:'any',query:'ärger'})).projects.map(r=>r.project_id),['lm11-umlaut']);
});

test('LM-12: a retry of a confirmed delete with the same operation ID passes the pre-check and replays; another ID cannot reuse the preview',async t=>{
  const w=await world(t),{store}=w,{act,preview,project,writer}=setup(w),mutations=store.consoleService.lifecycleMutations;
  project('lm12','LM Twelve');const p=await preview('delete','lm12'),op=randomUUID();
  const first=await act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Twelve'},op);
  assert.deepEqual(mutations.check(writer,{preview_id:p.preview_id,action:'delete',confirm_name:'LM Twelve',operation_id:op}),{read_only:true,current:true,replay:true});
  // Any other operation ID (or none) on a confirmed preview is refused before the factors are checked.
  assert.deepEqual(mutations.check(writer,{preview_id:p.preview_id,action:'delete',confirm_name:'LM Twelve',operation_id:randomUUID()}),{read_only:true,current:false,error_code:'PREVIEW_CHANGED'});
  assert.deepEqual(mutations.check(writer,{preview_id:p.preview_id,action:'delete',confirm_name:'LM Twelve'}),{read_only:true,current:false,error_code:'PREVIEW_CHANGED'});
  const again=await act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Twelve'},op);
  assert.deepEqual([again.replayed,again.lifecycle_event_id],[true,first.lifecycle_event_id]);
  await assert.rejects(act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'LM Twelve'}),code('PREVIEW_CHANGED'));
});

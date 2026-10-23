// Lifecycle write enforcement, 5C independent review findings (LW-10..LW-13). Synthetic isolated fixtures only; no models.
// Fixture: see lifecycle-world (proj-lr-dead deleted, proj-lr-src merged into proj-lr-tgt; generation 0 at start).
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {world} from './helpers/lifecycle-world.mjs';

const routes=w=>w.store.db.prepare('SELECT requested_project_id r,canonical_project_id c,entity_type e,entity_id id FROM project_route_log WHERE user_id=? ORDER BY rowid').all(w.user).map(row=>({...row}));
const count=(w,table,where='1',...params)=>w.store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...params).n;
const fromEvent=(w,id)=>w.store.db.prepare('SELECT memory_id,project_id FROM memories m WHERE user_id=? AND EXISTS (SELECT 1 FROM json_each(m.source_event_ids_json) WHERE value=?) ORDER BY rowid').all(w.user,id).map(row=>({...row}));
const at=offset=>new Date(Date.now()-120_000+offset).toISOString();
const event=(id,project,task,extra={})=>({event_id:id,event_type:'user_message',captured_at:at(0),project_id:project,task_id:task,workstream_id:`ws-${task}`,session_id:`session-${task}`,content:`决定：${id} synthetic`,...extra});
// Commits a lifecycle change and a generation bump on a second connection (a real concurrent writer).
const otherWriter=(t,w)=>{const db=new DatabaseSync(w.store.databasePath);t.after(()=>{if(db.isOpen)db.close();});
  return (projectId,state,into=null)=>{db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT OR REPLACE INTO project_lifecycle VALUES (?,?,?,?,1,?)').run(w.user,projectId,state,into,new Date().toISOString());
    db.prepare(`INSERT INTO owner_lifecycle_generation (user_id, generation) VALUES (?, COALESCE((SELECT generation FROM owner_lifecycle_generation WHERE user_id = ?), 0) + 1)
      ON CONFLICT (user_id) DO UPDATE SET generation = excluded.generation`).run(w.user,w.user);
    db.exec('COMMIT');};};
// Runs `change` once, on another connection, just before the next write transaction of `store` begins.
const beforeNextTransaction=(store,change)=>{const original=store.memoryTransaction;
  store.memoryTransaction=function(fn){store.memoryTransaction=original;change();return original.call(this,fn);};};

test('LW-10: an event captured before its project was merged replays without a second memory or a new route, along a chain as well',async t=>{
  const w=await world(t),{store,a}=w;
  for(const id of ['proj-lw-x','proj-lw-y'])store.upsertProject(a.auth,{project_id:id,name:`Replay ${id}`});
  w.task('task-lw-x','proj-lw-x','Replay proj-lw-x');
  const e=event('lw-replay-1','proj-lw-x','task-lw-x');
  store.appendEvents(a.auth,{events:[e]});
  const derived=fromEvent(w,'lw-replay-1');
  assert.ok(derived.length>0,'the fixture event derives memories (otherwise this test proves nothing)');
  assert.ok(derived.every(m=>m.project_id==='proj-lw-x'));
  w.mutate('proj-lw-x','merged','proj-lw-y');
  const routesBefore=routes(w).length,memoriesBefore=count(w,'memories');
  assert.equal(store.appendEvents(a.auth,{events:[e]}).inserted,0);
  assert.deepEqual(fromEvent(w,'lw-replay-1'),derived,'the replay finds the memory derived before the merge');
  assert.equal(count(w,'memories'),memoriesBefore);assert.equal(routes(w).length,routesBefore,'no route for a record that was not written');
  // Further along a chain: X -> Y -> target.
  w.mutate('proj-lw-y','merged','proj-lr-tgt');
  store.appendEvents(a.auth,{events:[e]});
  assert.deepEqual(fromEvent(w,'lw-replay-1'),derived);assert.equal(routes(w).length,routesBefore);
  // Control: a genuinely new event after the merge still lands in the canonical project with provenance.
  store.appendEvents(a.auth,{events:[event('lw-replay-2','proj-lw-x','task-lw-x')]});
  const fresh=fromEvent(w,'lw-replay-2');
  assert.ok(fresh.length>0&&fresh.every(m=>m.project_id==='proj-lr-tgt'));
  assert.ok(routes(w).slice(routesBefore).some(r=>r.e==='memory'&&r.r==='proj-lw-x'&&r.c==='proj-lr-tgt'));
});

test('LW-11: a checkpoint replay never returns content of a deleted project (capture extraction on or off, replayed trigger or manual request)',async t=>{
  const w=await world(t),{store,a}=w;
  store.upsertProject(a.auth,{project_id:'proj-lw-cp',name:'Checkpoint replay'});
  w.task('task-lw-cp','proj-lw-cp','Checkpoint replay');
  const stop={...event('lw-cp-stop','proj-lw-cp','task-lw-cp'),event_type:'assistant_message',hook_event_name:'Stop',captured_at:at(1000),content:'已完成：lw checkpoint synthetic step'};
  store.appendEvents(a.auth,{events:[event('lw-cp-1','proj-lw-cp','task-lw-cp'),stop]});
  assert.equal(count(w,'checkpoints',"trigger_event_id='lw-cp-stop'"),1,'the Stop trigger created a checkpoint');
  // Control while live: the manual request replays the existing checkpoint.
  assert.equal(store.createCheckpoint(a.auth,'session-task-lw-cp').status,'existing');
  w.mutate('proj-lw-cp','deleted');
  for(const extraction of [true,false]){
    store.runtime.captureExtraction=extraction;
    assert.throws(()=>store.createCheckpoint(a.auth,'session-task-lw-cp'),{errorCode:'PROJECT_DELETED'},`manual, extraction ${extraction}`);
    // appendEvents reports a checkpoint failure per trigger instead of throwing: no checkpoint content is returned.
    const replay=store.appendEvents(a.auth,{events:[stop]});
    assert.equal(replay.inserted,0);
    assert.deepEqual(replay.checkpoints,[{status:'failed',trigger_event_id:'lw-cp-stop',error:'This project was deleted.'}],`replayed trigger, extraction ${extraction}`);
  }
  store.runtime.captureExtraction=true;
  // A Task moved after its checkpoint: the replay is judged by the Task's current project too.
  w.mutate('proj-lw-cp','active');
  store.upsertProject(a.auth,{project_id:'proj-lw-cp2',name:'Checkpoint moved'});
  store.upsertTask(a.auth,{task_id:'task-lw-cp',project_id:'proj-lw-cp2',project_name:'Checkpoint moved',title:'Lifecycle task-lw-cp',goal:'Synthetic lifecycle read check',status:'active',workstreams:[]});
  // (Extraction off: re-deriving a moved Task's earlier checkpoint is refused as Task/Project disagreement, unrelated here.)
  store.runtime.captureExtraction=false;
  assert.equal(store.createCheckpoint(a.auth,'session-task-lw-cp').status,'existing');
  w.mutate('proj-lw-cp2','deleted');
  assert.throws(()=>store.createCheckpoint(a.auth,'session-task-lw-cp'),{errorCode:'PROJECT_DELETED'});
});

test('LW-12: authority binds the generation observed before the preview reads; a change committed before the insert leaves it stale',async t=>{
  const w=await world(t,{readerScopes:['memory:read','resume:read','resume:confirm','task:reconcile:read','task:reconcile:confirm']}),{store,reader,a}=w;
  const change=otherWriter(t,w);let probe=0;
  const racingChange=()=>{store.upsertProject(a.auth,{project_id:`proj-lw-probe-${++probe}`,name:`Probe ${probe}`});
    beforeNextTransaction(store,()=>change(`proj-lw-probe-${probe}`,'deleted'));};
  // Legacy positive control: an unbound record is current while the owner's generation is still 0.
  assert.equal(store.lifecycle.generation(w.user),0);
  let p=store.createPreview(reader.auth,{query:'lw resume',signals:{task_id:'task-lr-live'}});
  store.db.prepare('DELETE FROM lifecycle_authority_bindings WHERE record_id=?').run(p.resume_id);
  assert.equal(store.confirmPreview(reader.auth,p.resume_id,p.preview_version,true).status,'confirmed','legacy rows are current at generation 0');
  // Resume.
  racingChange();p=store.createPreview(reader.auth,{query:'lw resume race',signals:{task_id:'task-lr-live'}});
  assert.equal(probe,1);assert.equal(store.lifecycle.generation(w.user),1,'the racing change committed during the preview');
  assert.throws(()=>store.confirmPreview(reader.auth,p.resume_id,p.preview_version,true),{errorCode:'LIFECYCLE_AUTHORITY_STALE'});
  // Task bootstrap.
  const boot=w.credential('test','boot-lw12',['task:bootstrap:preview','task:bootstrap:confirm','project:bootstrap:preview','project:bootstrap:confirm']).auth;
  const request={project_query:'Lifecycle Live',title:'LW12 bootstrap task',goal:'Synthetic bootstrap',aliases:[],workstream_id:'ws-lw12',workstream_name:'boot',session_id:'session-lw12'};
  racingChange();const bp=store.createTaskBootstrapPreview(boot,request);assert.equal(bp.status,'pending_confirmation');
  assert.throws(()=>store.confirmTaskBootstrap(boot,bp.bootstrap_id,bp.preview_version,true,request.session_id),{errorCode:'LIFECYCLE_AUTHORITY_STALE'});
  assert.equal(count(w,'tasks',"title='LW12 bootstrap task'"),0);
  // Project bootstrap.
  const projectRequest={project_name:'LW12 Bootstrapped Project',project_aliases:[],git_remotes:[],repo_fingerprints:[],path_hints:[],task_title:'LW12 first task',task_goal:'Synthetic',task_aliases:[],workstream_id:'ws-lw12-pb',workstream_name:'pb',session_id:'session-lw12-pb'};
  racingChange();const pb=store.createProjectBootstrapPreview(boot,projectRequest);assert.equal(pb.status,'pending_confirmation');
  assert.throws(()=>store.confirmProjectBootstrap(boot,pb.bootstrap_id,pb.preview_version,true,projectRequest.session_id),{errorCode:'LIFECYCLE_AUTHORITY_STALE'});
  assert.equal(count(w,'projects',"name='LW12 Bootstrapped Project'"),0);
  // Reconciliation.
  racingChange();const proposal=store.runReconciliation(reader.auth,'task-lr-live',{operations:[{op:'append_unique',field:'decisions',value:'LW12 decision'}]}).proposal;
  assert.equal(proposal.status,'awaiting_confirmation');
  assert.throws(()=>store.resolveReconciliation(reader.auth,proposal.proposal_id,{proposal_version:1,base_canonical_version:proposal.base_canonical_version,decision:'confirm'}),{errorCode:'LIFECYCLE_AUTHORITY_STALE'});
  assert.equal(probe,4);
  // Control: without a racing change, a fresh preview still confirms.
  p=store.createPreview(reader.auth,{query:'lw resume calm',signals:{task_id:'task-lr-live'}});
  assert.equal(store.confirmPreview(reader.auth,p.resume_id,p.preview_version,true).status,'confirmed');
});

test('LW-13: checkpoint creation rechecks the Task\'s current project under the write lock',async t=>{
  const w=await world(t),{store,a}=w,change=otherWriter(t,w);
  store.upsertProject(a.auth,{project_id:'proj-lw-from',name:'Moved from'});store.upsertProject(a.auth,{project_id:'proj-lw-to',name:'Moved to'});
  w.task('task-lw-mv','proj-lw-from','Moved from');
  // A plain user message is not an automatic trigger, so the manual request below creates a new checkpoint from it.
  store.appendEvents(a.auth,{events:[event('lw-mv-1','proj-lw-from','task-lw-mv')]});
  const before=count(w,'checkpoints',"task_id='task-lw-mv'");
  store.upsertTask(a.auth,{task_id:'task-lw-mv',project_id:'proj-lw-to',project_name:'Moved to',title:'Lifecycle task-lw-mv',goal:'Synthetic lifecycle read check',status:'active',workstreams:[]});
  // The Task's project is deleted on another connection after the pre-transaction check, before the insert's lock.
  const projectState=store.lifecycle.projectState.bind(store.lifecycle);let armed=true;
  store.lifecycle.projectState=(user,id)=>{const state=projectState(user,id);
    if(armed&&id==='proj-lw-to'){armed=false;beforeNextTransaction(store,()=>change('proj-lw-to','deleted'));}return state;};
  t.after(()=>{store.lifecycle.projectState=projectState;});
  store.runtime.captureExtraction=false;
  assert.equal(before,0);
  assert.throws(()=>store.createCheckpoint(a.auth,'session-task-lw-mv'),{errorCode:'PROJECT_DELETED'});
  assert.equal(armed,false,'the race was injected');
  assert.equal(count(w,'checkpoints',"task_id='task-lw-mv'"),before,'no checkpoint for a Task whose project is deleted');
  assert.equal(store.db.isTransaction,false);
});

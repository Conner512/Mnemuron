// Lifecycle write enforcement (phase 5C, LW-01..LW-09). Synthetic isolated fixtures only (no lifecycle mutation
// action exists yet, so deleted/merged state is created at runtime); no models are involved.
// Fixture: proj-lr-live, proj-lr-dead (deleted), proj-lr-src (merged into proj-lr-tgt), proj-lr-tgt; see lifecycle-world.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {world} from './helpers/lifecycle-world.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {CLOUD_CORE_SCOPES} from '../lib/memory/cloud.mjs';

const routes=w=>w.store.db.prepare('SELECT requested_project_id r,canonical_project_id c,entity_type e,entity_id id FROM project_route_log WHERE user_id=? ORDER BY rowid').all(w.user).map(row=>({...row}));
const count=(w,table,where='1',...params)=>w.store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...params).n;
const memoryRow=(w,id)=>w.store.db.prepare('SELECT * FROM memories WHERE memory_id=?').get(id);
const at=offset=>new Date(Date.now()-120_000+offset).toISOString();

test('LW-01: projects and tasks: deleted IDs stay reserved, merged IDs route new Tasks with provenance, existing Task origins are kept, A->B->C routes',async t=>{
  const w=await world(t),{store,a}=w;
  assert.throws(()=>store.upsertProject(a.auth,{project_id:'proj-lr-dead',name:'Recreated'}),{errorCode:'PROJECT_DELETED'});
  assert.equal(store.db.prepare("SELECT name FROM projects WHERE project_id='proj-lr-dead'").get().name,'Lifecycle Dead','reserved ID unchanged');
  assert.throws(()=>store.upsertProject(a.auth,{project_id:'proj-lr-src',name:'Renamed source'}),{errorCode:'PROJECT_NOT_CANONICAL'});
  assert.equal(store.upsertProject(a.auth,{project_id:'proj-lw-new',name:'Brand new'}).status,'saved','a genuinely new ID is created');
  const task=(id,project,extra={})=>store.upsertTask(a.auth,{task_id:id,project_id:project,project_name:extra.project_name||project,title:`LW ${id}`,goal:'Synthetic write check',status:'active',workstreams:[],...extra});
  const before=routes(w).length;
  task('task-lw-via-src','proj-lr-src');
  assert.equal(store.db.prepare("SELECT project_id FROM tasks WHERE task_id='task-lw-via-src'").get().project_id,'proj-lr-tgt','new Task lands in the canonical project');
  assert.deepEqual(routes(w).slice(before),[{r:'proj-lr-src',c:'proj-lr-tgt',e:'task',id:'task-lw-via-src'}]);
  assert.throws(()=>task('task-lw-dead','proj-lr-dead'),{errorCode:'PROJECT_DELETED'});
  assert.equal(count(w,'tasks',"task_id='task-lw-dead'"),0);
  // Existing source-origin Task: naming either member keeps its origin; nothing is reparented or logged.
  const routesBefore=routes(w).length;
  for(const project of ['proj-lr-tgt','proj-lr-src']){task('task-lr-src',project,{goal:`Updated through ${project}`});
    assert.equal(store.db.prepare("SELECT project_id FROM tasks WHERE task_id='task-lr-src'").get().project_id,'proj-lr-src');}
  assert.equal(routes(w).length,routesBefore);
  assert.throws(()=>task('task-lr-dead','proj-lr-live'),{errorCode:'PROJECT_DELETED'},'a Task of a deleted project is not moved out of it either');
  // A->B->C: a new Task through the oldest ID lands in the final canonical project.
  store.upsertProject(a.auth,{project_id:'proj-lw-a',name:'Chain A'});store.upsertProject(a.auth,{project_id:'proj-lw-b',name:'Chain B'});
  w.row('proj-lw-a','merged','proj-lw-b');w.row('proj-lw-b','merged','proj-lr-tgt');
  task('task-lw-chain','proj-lw-a');
  assert.equal(store.db.prepare("SELECT project_id FROM tasks WHERE task_id='task-lw-chain'").get().project_id,'proj-lr-tgt');
  assert.deepEqual(routes(w).at(-1),{r:'proj-lw-a',c:'proj-lr-tgt',e:'task',id:'task-lw-chain'});
  // Phase-3 contract kept: a stale project_name on a Task never renames the formal project.
  task('task-lw-stale-name','proj-lr-tgt',{project_name:'Stale snapshot name'});
  assert.equal(store.db.prepare("SELECT name FROM projects WHERE project_id='proj-lr-tgt'").get().name,'Lifecycle Target');
});

test('LW-02: capture: a deleted item refuses the whole batch with no event or route left; merged IDs route with intact raw payloads; replays add nothing',async t=>{
  const w=await world(t),{store,a}=w,base={task_id:'task-lr-src',workstream_id:'ws-lw',session_id:'session-lw'};
  const ev=(id,extra={})=>({...base,event_id:id,event_type:'user_message',captured_at:at(0),content:`决定：${id} synthetic`,...extra});
  const routesBefore=routes(w).length;
  assert.throws(()=>store.appendEvents(a.auth,{events:[ev('lw-e1',{project_id:'proj-lr-src'}),ev('lw-e2',{project_id:'proj-lr-dead',task_id:null})]}),{errorCode:'PROJECT_DELETED'});
  assert.equal(count(w,'events',"event_id IN ('lw-e1','lw-e2')"),0,'atomic batch');assert.equal(routes(w).length,routesBefore,'no orphan route record');
  assert.equal(store.db.isTransaction,false);
  assert.throws(()=>store.appendEvents(a.auth,{events:[ev('lw-e3',{task_id:'task-lr-dead',project_id:'proj-lr-dead'})]}),{errorCode:'PROJECT_DELETED'});
  store.appendEvents(a.auth,{events:[ev('lw-e1',{project_id:'proj-lr-src'}),
    {...ev('lw-stop',{project_id:'proj-lr-src'}),event_type:'assistant_message',hook_event_name:'Stop',captured_at:at(1000),content:'已完成：lw synthetic step'}]});
  const stored=store.db.prepare("SELECT project_id,raw_payload_json FROM events WHERE event_id='lw-e1'").get();
  assert.equal(stored.project_id,'proj-lr-tgt');assert.match(stored.raw_payload_json,/proj-lr-src/,'retained raw payload is never rewritten');
  assert.deepEqual(routes(w).slice(routesBefore).filter(r=>r.e==='event').map(r=>[r.r,r.c,r.id]),[['proj-lr-src','proj-lr-tgt','lw-e1'],['proj-lr-src','proj-lr-tgt','lw-stop']]);
  const checkpoint=store.db.prepare("SELECT project_id FROM checkpoints WHERE task_id='task-lr-src' AND trigger_event_id='lw-stop'").get();
  assert.equal(checkpoint?.project_id,'proj-lr-tgt','the checkpoint of a source-origin Task lands in the canonical project');
  assert.equal(store.db.prepare("SELECT project_id FROM tasks WHERE task_id='task-lr-src'").get().project_id,'proj-lr-src','the Task row keeps its origin');
  const after=routes(w).length;
  const replay=store.appendEvents(a.auth,{events:[ev('lw-e1',{project_id:'proj-lr-src'})]});
  assert.equal(replay.inserted,0);assert.equal(routes(w).length,after,'a replayed event adds no route');
});

test('LW-03: memory writes: canonical destination for explicit and Task-inferred merged IDs, deleted refusal, replay authorization, supersede/retract',async t=>{
  const w=await world(t),{store,a,m}=w;
  const routesBefore=routes(w).length;
  const explicit=store.saveMemory(a.auth,{scope:'project',project_id:'proj-lr-src',content:'LW explicit through source',operation_id:'lw-op-1'}).memory;
  assert.equal(memoryRow(w,explicit.memory_id).project_id,'proj-lr-tgt');
  const inferred=store.saveMemory(a.auth,{scope:'task',task_id:'task-lr-src',content:'LW inferred through task'}).memory;
  assert.equal(memoryRow(w,inferred.memory_id).project_id,'proj-lr-tgt');assert.equal(memoryRow(w,inferred.memory_id).task_id,'task-lr-src');
  assert.deepEqual(routes(w).slice(routesBefore).map(r=>[r.r,r.c,r.e,r.id]),[['proj-lr-src','proj-lr-tgt','memory',explicit.memory_id],['proj-lr-src','proj-lr-tgt','memory',inferred.memory_id]]);
  const memoriesBefore=count(w,'memories'),routesMid=routes(w).length;
  assert.throws(()=>store.saveMemory(a.auth,{scope:'project',project_id:'proj-lr-dead',content:'LW never saved'}),{errorCode:'PROJECT_DELETED'});
  assert.throws(()=>store.saveMemory(a.auth,{scope:'task',task_id:'task-lr-dead',content:'LW never saved'}),{errorCode:'PROJECT_DELETED'});
  assert.equal(count(w,'memories'),memoriesBefore);assert.equal(routes(w).length,routesMid);
  // Same-intent replay: same record, nothing new, never retargeted; a different intent conflicts.
  const replay=store.saveMemory(a.auth,{scope:'project',project_id:'proj-lr-src',content:'LW explicit through source',operation_id:'lw-op-1'});
  assert.deepEqual([replay.idempotent,replay.memory.memory_id],[true,explicit.memory_id]);assert.equal(routes(w).length,routesMid);
  assert.throws(()=>store.saveMemory(a.auth,{scope:'project',project_id:'proj-lr-src',content:'LW different intent',operation_id:'lw-op-1'}),{errorCode:'IDEMPOTENCY_CONFLICT'});
  // Supersede of a source-origin record: replacement in the canonical project, original untouched, provenance logged.
  const sup=store.supersedeMemory(a.auth,m.src,{content:'LW corrected source record'});
  assert.equal(memoryRow(w,m.src).project_id,'proj-lr-src');assert.equal(memoryRow(w,sup.replacement_memory.memory_id).project_id,'proj-lr-tgt');
  assert.deepEqual(routes(w).at(-1),{r:'proj-lr-src',c:'proj-lr-tgt',e:'memory',id:sup.replacement_memory.memory_id});
  assert.throws(()=>store.supersedeMemory(a.auth,m.dead,{content:'LW nope'}),{errorCode:'PROJECT_DELETED'});
  assert.throws(()=>store.retractMemory(a.auth,m.dead,{}),{errorCode:'PROJECT_DELETED'});
  assert.equal(memoryRow(w,m.dead).status,'active','no change to a deleted-project record');
  const retracted=store.retractMemory(a.auth,m.live,{}).memory;assert.equal(retracted.status,'retracted');
  // Delete the canonical project afterwards: every content-bearing replay is refused, nothing is re-created.
  w.mutate('proj-lr-tgt','deleted');
  assert.throws(()=>store.saveMemory(a.auth,{scope:'project',project_id:'proj-lr-src',content:'LW explicit through source',operation_id:'lw-op-1'}),{errorCode:'PROJECT_DELETED'});
  assert.throws(()=>store.supersedeMemory(a.auth,m.src,{content:'LW corrected source record'}),{errorCode:'PROJECT_DELETED'},'supersede replay with both records deleted-project');
  w.mutate('proj-lr-live','deleted');
  assert.throws(()=>store.retractMemory(a.auth,m.live,{}),{errorCode:'PROJECT_DELETED'},'retract replay');
  // A dangling project reference is generic.
  store.db.prepare("UPDATE memories SET project_id='proj-lw-never' WHERE memory_id=?").run(m.neutral);
  assert.throws(()=>store.retractMemory(a.auth,m.neutral,{}),{errorCode:'MEMORY_NOT_FOUND'});
});

test('LW-04: injected failures roll back records, route provenance and replacements together',async t=>{
  const w=await world(t),{store,a,m}=w,record=store.revisions.record.bind(store.revisions);
  const snapshot=()=>JSON.stringify([count(w,'memories'),routes(w),count(w,'memory_revisions')]);
  const before=snapshot();
  store.revisions.record=()=>{throw new Error('synthetic failure after the insert');};
  t.after(()=>{store.revisions.record=record;});
  assert.throws(()=>store.saveMemory(a.auth,{scope:'project',project_id:'proj-lr-src',content:'LW rolled back'}),/synthetic failure/);
  assert.throws(()=>store.supersedeMemory(a.auth,m.src,{content:'LW rolled back correction'}),/synthetic failure/);
  assert.equal(store.db.isTransaction,false);assert.equal(snapshot(),before,'no memory, revision or route record remains');
  assert.equal(memoryRow(w,m.src).status,'active');
  store.revisions.record=record;
  // Batch capture: a later invalid item rolls back an earlier routed one.
  assert.throws(()=>store.appendEvents(a.auth,{events:[{event_id:'lw-ok',event_type:'user_message',project_id:'proj-lr-src',content:'x'},{event_id:'lw-bad'}]}),/event_type is required/);
  assert.equal(count(w,'events',"event_id='lw-ok'"),0);assert.equal(snapshot(),before);
});

test('LW-05: pending authority is bound to the lifecycle generation: resume, bootstraps and reconciliation refuse stale previews; cancel and reject stay allowed',async t=>{
  const w=await world(t,{readerScopes:['memory:read','resume:read','resume:confirm','task:reconcile:read','task:reconcile:confirm']}),{store,reader,a}=w;
  store.upsertProject(a.auth,{project_id:'proj-lw-gen',name:'Generation probe'});
  const bump=()=>w.mutate('proj-lw-gen',store.lifecycle.projectState(w.user,'proj-lw-gen')==='deleted'?'active':'deleted');
  const preview=()=>store.createPreview(reader.auth,{query:'lw resume',signals:{task_id:'task-lr-live'}});
  const selections=()=>count(w,'resolver_selections');
  // Stale pending preview: refused, nothing confirmed or recorded; explicit cancel still works.
  let p=preview();bump();
  assert.throws(()=>store.confirmPreview(reader.auth,p.resume_id,p.preview_version,true),{errorCode:'LIFECYCLE_AUTHORITY_STALE'});
  assert.equal(store.db.prepare('SELECT status FROM resumes WHERE resume_id=?').get(p.resume_id).status,'pending_confirmation');assert.equal(selections(),0);
  assert.equal(store.confirmPreview(reader.auth,p.resume_id,p.preview_version,false).status,'cancelled');
  // A confirmed resume is not re-delivered after a later lifecycle change (delete->restore cannot revive it).
  p=preview();assert.equal(store.confirmPreview(reader.auth,p.resume_id,p.preview_version,true).status,'confirmed');
  const afterConfirm=selections();bump();
  assert.throws(()=>store.confirmPreview(reader.auth,p.resume_id,p.preview_version,true),{errorCode:'LIFECYCLE_AUTHORITY_STALE'});
  assert.equal(selections(),afterConfirm,'no selection write on a refused replay');
  // A preview without a binding (older build) is stale once the owner has lifecycle history.
  p=preview();store.db.prepare("DELETE FROM lifecycle_authority_bindings WHERE record_id=?").run(p.resume_id);
  assert.throws(()=>store.confirmPreview(reader.auth,p.resume_id,p.preview_version,true),{errorCode:'LIFECYCLE_AUTHORITY_STALE'});
  // Task bootstrap: a stale pending preview is neither confirmed nor reused for the same request.
  const boot=w.credential('test','boot-lw',['task:bootstrap:preview','task:bootstrap:confirm','project:bootstrap:preview','project:bootstrap:confirm']).auth;
  const request={project_query:'Lifecycle Live',title:'LW bootstrap task',goal:'Synthetic bootstrap',aliases:[],workstream_id:'ws-lw-boot',workstream_name:'boot',session_id:'session-lw-boot'};
  const bp=store.createTaskBootstrapPreview(boot,request);assert.equal(bp.status,'pending_confirmation');
  bump();
  assert.throws(()=>store.confirmTaskBootstrap(boot,bp.bootstrap_id,bp.preview_version,true,request.session_id),{errorCode:'LIFECYCLE_AUTHORITY_STALE'});
  assert.equal(count(w,'tasks',"title='LW bootstrap task'"),0);
  const fresh=store.createTaskBootstrapPreview(boot,request);assert.notEqual(fresh.bootstrap_id,bp.bootstrap_id,'a stale pending preview is never reused');
  assert.equal(store.confirmTaskBootstrap(boot,fresh.bootstrap_id,fresh.preview_version,true,request.session_id).status,'confirmed');
  bump();
  assert.throws(()=>store.confirmTaskBootstrap(boot,fresh.bootstrap_id,fresh.preview_version,true,request.session_id),{errorCode:'LIFECYCLE_AUTHORITY_STALE'},'binding packet not re-delivered');
  // Project bootstrap: same binding.
  const projectRequest={project_name:'LW Bootstrapped Project',project_aliases:[],git_remotes:[],repo_fingerprints:[],path_hints:[],task_title:'LW first task',task_goal:'Synthetic',task_aliases:[],workstream_id:'ws-lw-pb',workstream_name:'pb',session_id:'session-lw-pb'};
  const pb=store.createProjectBootstrapPreview(boot,projectRequest);assert.equal(pb.status,'pending_confirmation');bump();
  assert.throws(()=>store.confirmProjectBootstrap(boot,pb.bootstrap_id,pb.preview_version,true,projectRequest.session_id),{errorCode:'LIFECYCLE_AUTHORITY_STALE'});
  assert.equal(count(w,'projects',"name='LW Bootstrapped Project'"),0);
  // Reconciliation: a stale material proposal is not applied even though the Task hash is unchanged; reject is allowed.
  const run=()=>store.runReconciliation(reader.auth,'task-lr-live',{operations:[{op:'append_unique',field:'decisions',value:`LW decision ${randomUUID()}`}]});
  let proposal=run().proposal;assert.equal(proposal.status,'awaiting_confirmation');bump();
  const resolve=(id,decision)=>store.resolveReconciliation(reader.auth,id,{proposal_version:1,base_canonical_version:proposal.base_canonical_version,decision});
  assert.throws(()=>resolve(proposal.proposal_id,'confirm'),{errorCode:'LIFECYCLE_AUTHORITY_STALE'});
  assert.equal(store.db.prepare("SELECT canonical_version FROM tasks WHERE task_id='task-lr-live'").get().canonical_version,proposal.base_canonical_version);
  assert.equal(resolve(proposal.proposal_id,'reject').status,'rejected');
  proposal=run().proposal;assert.equal(resolve(proposal.proposal_id,'confirm').status,'applied','a current proposal still applies');
  // Nothing about a deleted project's Task can be proposed.
  assert.throws(()=>store.runReconciliation(reader.auth,'task-lr-dead',{}),{errorCode:'PROJECT_DELETED'});
});

test('LW-06: organize apply rechecks its token inside the transaction; rejections and undo never touch hidden records',async t=>{
  const w=await world(t),{store,m}=w,organizer=store.consoleService.organizer;
  const writer=store.authenticate(store.issueCredential({userId:w.user,deviceId:'d-lw-org',agentId:'mnemuron-console',agentInstanceId:'lw-org',scopes:[...CONSOLE_WRITE_SCOPES]}).api_key);
  const overrides=()=>count(w,'memory_category_overrides'),batches=()=>count(w,'console_organize_batches');
  const request={category:'technical',all:true},preview=organizer.preview(writer,request);
  w.mutate('proj-lr-live','deleted');
  const state=[overrides(),batches(),count(w,'audit_events',"action='memory.category.batch'")];
  assert.throws(()=>organizer.organize(writer,{...request,preview_token:preview.preview_token}),{errorCode:'PREVIEW_CHANGED'});
  assert.deepEqual([overrides(),batches(),count(w,'audit_events',"action='memory.category.batch'")],state,'no override, batch or success audit');
  assert.equal(store.db.isTransaction,false);
  const fresh=organizer.preview(writer,request),applied=organizer.organize(writer,{...request,preview_token:fresh.preview_token});
  assert.equal(applied.matched,4,'neutral, source, source task, target (not the deleted ones)');
  // Undo after the canonical project is deleted: its members' records are skipped and keep their category.
  w.mutate('proj-lr-tgt','deleted');
  const undo=organizer.undo(writer,{batch_id:applied.batch_id});
  assert.deepEqual(undo.skipped.filter(s=>s.reason==='PROJECT_UNAVAILABLE').map(s=>s.memory_id).sort(),[m.src,m.srcTask,m.tgt].sort());
  const category=id=>store.db.prepare('SELECT category FROM memory_category_overrides WHERE memory_id=?').get(id)?.category??null;
  assert.equal(category(m.tgt),'technical','hidden record untouched');assert.equal(category(m.neutral),null,'live record restored');
});

test('LW-07: cloud supersede/retract never act on a deleted-project memory and leave no grant, privacy or replacement',async t=>{
  const w=await world(t),{store}=w;Object.assign(store.runtime,{cloudMemory:true,cloudSubmittedGrant:true});
  const c=w.credential('chatgpt-web','cloud-lw',[...CLOUD_CORE_SCOPES]),connection='d'.repeat(64);
  store.cloudMemory.bind(c.auth,{connection_id:connection,account_id:'synthetic-lw',security_version:1,allow_submitted_revision_grant:true});
  const act=(action,payload)=>w.request('POST','/v1/cloud-memory/operations',{connection_id:connection,action,operation_id:randomUUID(),payload},c);
  const saved=await act('memory.save',{scope:'project',project_id:'proj-lr-live',content:'LW cloud record',cloud_read:'allow_submitted_revision'});
  assert.equal(saved.status,200,JSON.stringify(saved.body));const id=saved.body.memory_id,revision=saved.body.revision;
  w.mutate('proj-lr-live','deleted');
  const before=JSON.stringify([count(w,'memories'),count(w,'memory_web_grants'),count(w,'memory_privacy'),count(w,'memory_revisions')]);
  for(const [action,payload] of [['memory.supersede',{memory_id:id,expected_revision:revision,content:'LW cloud correction',reason:'r',cloud_read:'keep_private'}],['memory.retract',{memory_id:id,expected_revision:revision,reason:'r'}]]){
    const r=await act(action,payload);assert.deepEqual([r.status,r.body.error_code],[404,'MEMORY_NOT_FOUND'],action);
  }
  assert.equal(JSON.stringify([count(w,'memories'),count(w,'memory_web_grants'),count(w,'memory_privacy'),count(w,'memory_revisions')]),before);
  const routedSave=await act('memory.save',{scope:'project',project_id:'proj-lr-src',content:'LW cloud via source',cloud_read:'keep_private'});
  assert.equal(memoryRow(w,routedSave.body.memory_id).project_id,'proj-lr-tgt','cloud saves route like Core saves');
});

test('LW-08: Console privacy, grants, manual categories and operation replays respect each record\'s lifecycle',async t=>{
  const w=await world(t),{store,m,a}=w;
  const writer=store.authenticate(store.issueCredential({userId:w.user,deviceId:'d-lw-con',agentId:'mnemuron-console',agentInstanceId:'lw-con',scopes:[...CONSOLE_WRITE_SCOPES]}).api_key);
  assert.throws(()=>store.memorySources.setSensitivity(writer,m.dead,'internal'),{errorCode:'PROJECT_DELETED'});
  const {revision,state_hash}=store.revisions.latest(w.user,m.dead);
  assert.throws(()=>store.webVisibility.set(a.auth,m.dead,{allow:true,revision,state_hash}),{errorCode:'PROJECT_DELETED'});
  assert.throws(()=>store.derivedMemory.setCategory(writer,m.dead,'technical',store.consoleService.taxonomy(w.user)),{code:'INVALID_CATEGORY_TARGET'});
  assert.equal(count(w,'memory_privacy','memory_id=?',m.dead)+count(w,'memory_web_grants','memory_id=?',m.dead)+count(w,'memory_category_overrides','memory_id=?',m.dead),0);
  const live=store.revisions.latest(w.user,m.live);
  const done=await store.consoleService.execute(writer,{action:'memory.sensitivity',operation_id:'lw-op-sens',payload:{memory_id:m.live,revision:live.revision,sensitivity:'internal'}});
  // The stored result carries the memory's metadata (its `status` is the memory status, as before this phase).
  assert.equal(done.memory_id,m.live);assert.equal(done.sensitivity,'internal');assert.equal(done.replayed,false);
  w.mutate('proj-lr-live','deleted');
  const replay=await store.consoleService.execute(writer,{action:'memory.sensitivity',operation_id:'lw-op-sens',payload:{memory_id:m.live,revision:live.revision,sensitivity:'internal'}});
  assert.deepEqual(Object.keys(replay).sort(),['content_withheld','current_status','memory_id','operation_id','replayed','status']);
  assert.equal(replay.current_status,'unavailable');
});

test('LW-09: a lifecycle change on another connection is serialized with the write: busy while held, PROJECT_DELETED after commit',async t=>{
  const w=await world(t),{store,a}=w;
  store.db.exec('PRAGMA busy_timeout=50');
  const other=new DatabaseSync(store.databasePath);t.after(()=>{if(other.isOpen)other.close();});
  other.exec('PRAGMA busy_timeout=50; BEGIN IMMEDIATE');
  other.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,'proj-lr-live','deleted',NULL,1,?)").run(w.user,new Date().toISOString());
  const before=count(w,'memories');
  assert.throws(()=>store.saveMemory(a.auth,{scope:'project',project_id:'proj-lr-live',content:'LW racing write'}),/locked|busy/i);
  assert.equal(count(w,'memories'),before);assert.equal(store.db.isTransaction,false);
  other.exec('COMMIT');
  assert.throws(()=>store.saveMemory(a.auth,{scope:'project',project_id:'proj-lr-live',content:'LW racing write'}),{errorCode:'PROJECT_DELETED'});
  assert.equal(count(w,'memories'),before,'the write after the committed delete makes no material change');
});

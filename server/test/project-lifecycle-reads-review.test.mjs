// Lifecycle read enforcement, review notes 17-26 (phase 5B, LR-10..LR-19). Synthetic isolated fixtures only: the
// deleted/merged state is created at runtime (no lifecycle mutation action exists yet), models are mocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {world} from './helpers/lifecycle-world.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {VectorIndex} from '../lib/vector-stores/index.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {fixture,embedder} from './helpers/memory-models.mjs';
import {resolveProjectCandidates} from '../lib/resolver.mjs';

const consoleWriter=w=>w.store.authenticate(w.store.issueCredential({userId:w.user,deviceId:'device-console-writer',agentId:'mnemuron-console',agentInstanceId:'console-writer',scopes:[...CONSOLE_WRITE_SCOPES]}).api_key);
const consoleGet=(w,view,params={})=>w.request('GET',`/v1/console/${view}?${new URLSearchParams(params)}`,undefined,w.consoleReader);

test('LR-10 (note 17): inherited token overlap and prior confirmations carry their origin',async t=>{
  const w=await world(t),{store,reader}=w;
  // A merged source's identity cannot be edited through its old ID (5C); rename it while unmerged, then merge again.
  w.mutate('proj-lr-src','active');store.upsertProject(w.a.auth,{project_id:'proj-lr-src',name:'Orbit Telemetry',aliases:['old-codename']});w.mutate('proj-lr-src','merged','proj-lr-tgt');
  // Token overlap that only the merged source's names produce.
  const tokens=store.resolveProject(reader.auth,{query:'telemetry dashboards'});
  const target=tokens.candidates.find(c=>c.project_id==='proj-lr-tgt');
  const reason=target.reasons.find(r=>r.signal==='project_name_tokens');
  assert.ok(reason,'source-only token overlap scores the canonical target');assert.equal(reason.inherited_from,'proj-lr-src');assert.match(reason.detail,/inherited from merged project proj-lr-src/);
  assert.equal(tokens.candidates.some(c=>c.project_id==='proj-lr-src'),false);
  // The target's own names keep an unlabelled reason.
  const own=store.resolveProject(reader.auth,{query:'target metrics'}).candidates.find(c=>c.project_id==='proj-lr-tgt').reasons.find(r=>r.signal==='project_name_tokens');
  assert.ok(own,'own-name token overlap');assert.equal(Object.hasOwn(own,'inherited_from'),false);
  // History recorded only for the source, through the real resume preview/confirm API (selections are recorded for the
  // Task's origin project): the confirmation reason of the canonical target names it.
  const confirmer=w.credential('test','confirm-lr',['resume:read','resume:confirm']).auth;
  for(let i=0;i<2;i++){const p=store.createPreview(confirmer,{query:'task-lr-src'});assert.equal(p.status,'pending_confirmation');store.confirmPreview(confirmer,p.resume_id,p.preview_version,true);}
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM resolver_selections WHERE project_id='proj-lr-src'").get().n,2);
  const history=store.resolveProject(reader.auth,{query:'task-lr-src'}).candidates.find(c=>c.project_id==='proj-lr-tgt').reasons.find(r=>r.signal==='prior_confirmation');
  assert.equal(history.inherited_from,'proj-lr-src');assert.deepEqual(history.confirmation_origins,[{project_id:'proj-lr-src',inherited:true,confirmations:2}]);
  assert.match(history.detail,/^2 matching confirmation\(s\) \(2 inherited from merged project\(s\) proj-lr-src\)$/);
  // Mixed history (resolver contract): weight from the total, both origins listed, no single inherited_from; an unmerged
  // project's reason keeps its exact earlier shape.
  const candidates=resolveProjectCandidates({query:'unrelated words',projects:[
    {project_id:'p-target',name:'Target',aliases:[],merged_sources:[{project_id:'p-source',name:'Source',aliases:[]}]},{project_id:'p-plain',name:'Plain',aliases:[]}],
    historyByProject:new Map([['p-target',1],['p-source',2],['p-plain',1]])}).candidates;
  const mixed=candidates.find(c=>c.project_id==='p-target').reasons.find(r=>r.signal==='prior_confirmation');
  assert.equal(Object.hasOwn(mixed,'inherited_from'),false);assert.match(mixed.detail,/^3 matching confirmation\(s\) \(2 inherited from merged project\(s\) p-source\)$/);
  assert.deepEqual(mixed.confirmation_origins,[{project_id:'p-target',inherited:false,confirmations:1},{project_id:'p-source',inherited:true,confirmations:2}]);
  assert.equal(mixed.weight,0.85,'weight from the total of 3, exactly as before for 3 confirmations');
  const plain=candidates.find(c=>c.project_id==='p-plain').reasons.find(r=>r.signal==='prior_confirmation');
  assert.deepEqual(plain,{signal:'prior_confirmation',weight:0.75,detail:'1 matching confirmation(s)'});
});

test('LR-11 (notes 18, 21): a Task whose parent is dangling or foreign is a generic not found on every direct path; an owned deleted parent is PROJECT_DELETED',async t=>{
  const w=await world(t),{store,reader}=w;
  w.task('task-lr-orphan','proj-lr-orphan','Orphan parent');w.task('task-lr-foreignparent','proj-lr-fp','Foreign parent');
  store.db.prepare("UPDATE tasks SET project_id='proj-lr-never-created' WHERE task_id='task-lr-orphan'").run();
  store.db.prepare("UPDATE tasks SET project_id='project-foreign' WHERE task_id='task-lr-foreignparent'").run();
  for(const taskId of ['task-lr-orphan','task-lr-foreignparent']){
    for(const read of [()=>store.listCheckpoints(reader.auth,taskId),()=>store.reconciliationState(reader.auth,taskId),()=>store.listCanonicalRevisions(reader.auth,taskId)])
      assert.throws(read,{errorCode:'TASK_NOT_FOUND'},taskId);
    for(const [view,params] of [['task-detail',{task_id:taskId}],['task-checkpoints',{task_id:taskId}],['task-reconciliation',{task_id:taskId}]]){
      const r=await consoleGet(w,view,params);assert.equal(r.status,404,`${view} ${taskId}`);assert.equal(r.body.error_code,'TASK_NOT_FOUND');
    }
    const http=await w.request('GET',`/v1/tasks/${taskId}/checkpoints`,undefined,reader);assert.deepEqual([http.status,http.body.error_code],[404,'TASK_NOT_FOUND']);
  }
  // Deleted owned parent: the owner learns it; the other owner sees an unknown Task exactly like a missing one.
  const deleted=await consoleGet(w,'task-detail',{task_id:'task-lr-dead'});assert.deepEqual([deleted.status,deleted.body.error_code],[409,'PROJECT_DELETED']);
  const otherReader=w.store.authenticate(w.store.issueCredential({userId:w.other.auth.user_id,deviceId:'device-other-r',agentId:'test',agentInstanceId:'other-r',scopes:['memory:read','task:reconcile:read']}).api_key);
  for(const taskId of ['task-lr-dead','task-lr-orphan','task-lr-never'])assert.throws(()=>store.reconciliationState(otherReader,taskId),{message:'Task not found.'});
  assert.deepEqual(store.listCheckpoints(otherReader,'task-lr-dead'),[],'another owner: same empty answer as an unknown Task');
});

test('LR-12 (notes 19, 26): project summaries through either merged ID cover both origin scopes, keep each scope key, and revalidate every source',async t=>{
  const w=await world(t),{store,user,m,reader}=w;
  const dep=id=>{const s=store.derivedMemory.currentSource(user,id);return [s.revision,s.state_hash,s.scope_key];};
  const key=project=>JSON.stringify([user,'project',project,null,null,null]);
  const insert=(id,scope,deps)=>{store.db.prepare("INSERT INTO memory_summaries VALUES (?,?,1,?,?,'uncategorized','{}','current','synthetic',?,?,0,?)").run(id,`g-${id}`,user,scope,`job-${id}`,deps.length,new Date().toISOString());
    for(const memory of deps){const [revision,hash,scopeKey]=dep(memory);store.db.prepare('INSERT INTO memory_summary_dependencies VALUES (?,?,?,?,?,?)').run(id,user,memory,revision,hash,scopeKey);}};
  insert('sum-src',key('proj-lr-src'),[m.src]);insert('sum-tgt',key('proj-lr-tgt'),[m.tgt]);insert('sum-live',key('proj-lr-live'),[m.live]);
  // A user-wide summary with one live and one later-deleted source (mixed); deps are valid until the delete.
  w.mutate('proj-lr-dead','active');insert('sum-mixed',JSON.stringify([user,'user',null,null,null,null]),[m.neutral,m.dead]);w.mutate('proj-lr-dead','deleted');
  const read=body=>store.memorySummaries(reader.auth,body);
  for(const project of ['proj-lr-src','proj-lr-tgt']){
    const page=read({scope:'project',project_id:project});
    assert.deepEqual(page.results.map(r=>r.summary_id).sort(),['sum-src','sum-tgt'],project);
    assert.deepEqual(Object.fromEntries(page.results.map(r=>[r.summary_id,r.scope_key])),{'sum-src':key('proj-lr-src'),'sum-tgt':key('proj-lr-tgt')},'origin scope keys are kept');
  }
  assert.deepEqual(read({scope:'project',project_id:'proj-lr-live'}).results.map(r=>r.summary_id),['sum-live'],'unmerged: its single scope as before');
  assert.deepEqual(read({scope:'user'}).results.map(r=>r.summary_id),[],'a mixed summary with a deleted-project source is never delivered');
  assert.throws(()=>read({scope:'project',project_id:'proj-lr-dead'}),{errorCode:'PROJECT_DELETED'});
  // Paging across both origin scopes: one per page, cursor continues to the other scope, nothing repeats.
  const first=read({scope:'project',project_id:'proj-lr-src',limit:1});assert.equal(first.results.length,1);assert.ok(first.next_cursor);
  const second=read({scope:'project',project_id:'proj-lr-src',limit:1,cursor:first.next_cursor});
  assert.deepEqual([first.results[0].summary_id,second.results[0].summary_id].sort(),['sum-src','sum-tgt']);
  assert.throws(()=>read({scope:'project',project_id:'proj-lr-live',limit:1,cursor:first.next_cursor}),{errorCode:'INVALID_CURSOR'},'a merged-scope cursor is bound to that read');
  // Console list/detail agree: the mixed summary is hidden; a summary scoped to the deleted project with no remaining
  // dependency is hidden from the list and PROJECT_DELETED in detail.
  store.db.prepare("INSERT INTO memory_summaries VALUES ('sum-dead-empty','g-de',1,?,?,'uncategorized','{}','current','synthetic','job-de',0,0,?)").run(user,key('proj-lr-dead'),new Date().toISOString());
  const list=await consoleGet(w,'summaries');assert.equal(list.status,200);
  const listed=list.body.summaries.map(s=>s.summary_id);assert.ok(listed.includes('sum-src')&&listed.includes('sum-tgt'));
  assert.equal(listed.includes('sum-mixed')||listed.includes('sum-dead-empty'),false);
  const detail=await consoleGet(w,'summary',{summary_id:'sum-dead-empty'});assert.deepEqual([detail.status,detail.body.error_code],[409,'PROJECT_DELETED']);
});

test('LR-13 (note 19): a source-origin Task keeps its workstream when later evidence names the canonical target; deleted-project evidence never owns one',async t=>{
  const w=await world(t),{store,reader}=w;
  const memory=store.saveMemory(w.a.auth,{scope:'workstream',task_id:'task-lr-src',workstream_id:'ws-lr-moved',content:'LRMARK workstream evidence synthetic record'}).memory.memory_id;
  // Later records of this Task name the canonical target (what routed writes record after a merge).
  store.db.prepare("UPDATE memories SET project_id='proj-lr-tgt' WHERE memory_id=?").run(memory);
  const read=store.queryMemories(reader.auth,{query:'LRMARK',workstream_id:'ws-lr-moved'});
  assert.ok(read.results.some(r=>r.memory_id===memory),'workstream resolves to the source-origin Task');
  assert.equal(store.queryMemories(reader.auth,{query:'LRMARK',workstream_id:'ws-lr-moved',task_id:'task-lr-src'}).result_count>0,true);
  // Evidence in another, unrelated project is not equivalent.
  store.db.prepare("UPDATE memories SET project_id='proj-lr-live' WHERE memory_id=?").run(memory);
  assert.throws(()=>store.queryMemories(reader.auth,{query:'LRMARK',workstream_id:'ws-lr-moved'}),{errorCode:'WORKSTREAM_NOT_FOUND'});
  // Evidence that only exists in a deleted project owns nothing.
  const dead=store.saveMemory(w.a.auth,{scope:'workstream',task_id:'task-lr-live',workstream_id:'ws-lr-ghost',content:'LRMARK ghost synthetic record'}).memory.memory_id;
  store.db.prepare("UPDATE memories SET project_id='proj-lr-live' WHERE memory_id=?").run(dead);
  assert.ok(store.queryMemories(reader.auth,{query:'LRMARK',workstream_id:'ws-lr-ghost'}));
  w.mutate('proj-lr-live','deleted');
  assert.throws(()=>store.queryMemories(reader.auth,{query:'LRMARK',workstream_id:'ws-lr-ghost'}),{errorCode:'WORKSTREAM_NOT_FOUND'});
});

test('LR-14 (note 20): an organize preview never survives a project delete and restore, and select-all never covers hidden records',async t=>{
  const w=await world(t),{store,m}=w,writer=consoleWriter(w),organizer=store.consoleService.organizer;
  const request={category:'technical',all:true};
  const preview=organizer.preview(writer,request);
  assert.equal(preview.total,5,'select-all covers exactly the live records (not the 2 deleted-project ones)');
  // Delete and restore proj-lr-live: every revision and category is unchanged, the generation moved twice.
  w.mutate('proj-lr-live','deleted');w.mutate('proj-lr-live','active');
  assert.throws(()=>organizer.organize(writer,{...request,preview_token:preview.preview_token}),{errorCode:'PREVIEW_CHANGED'});
  const fresh=organizer.preview(writer,request);assert.notEqual(fresh.preview_token,preview.preview_token);
  const applied=organizer.organize(writer,{...request,preview_token:fresh.preview_token});assert.equal(applied.matched,5);
  const category=id=>store.db.prepare('SELECT category FROM memory_category_overrides WHERE user_id=? AND memory_id=?').get(w.user,id)?.category??null;
  assert.equal(category(m.dead),null,'a hidden record was never written');assert.equal(category(m.deadTask),null);assert.equal(category(m.src),'technical');
  // Browse and preview agree on the same filter.
  const browse=await consoleGet(w,'memories',{query:'LRMARK',limit:50});
  assert.equal(browse.body.results.length,organizer.preview(writer,{category:'decisions',query:'LRMARK'}).total);
});

test('LR-15 (note 21): project identity of every merged member is never Task evidence; same-named Tasks stay separate',async t=>{
  const w=await world(t),{store,reader}=w;
  w.task('task-atlas-origin','proj-atlas','Atlas',{title:'Release checklist'});
  w.task('task-legacy-atlas','proj-legacy','Legacy',{title:'Atlas'});
  w.task('task-legacy-release','proj-legacy','Legacy',{title:'Release checklist'});
  w.task('task-legacy-cleanup','proj-legacy','Legacy',{title:'Legacy cleanup sweep'});
  store.upsertProject(w.a.auth,{project_id:'proj-legacy',name:'Legacy',aliases:['oldname']});
  w.row('proj-legacy','merged','proj-atlas');
  const resolve=query=>store.resolveTask(reader.auth,{query});
  for(const query of ['Atlas','Legacy','oldname']){
    const r=resolve(query);assert.equal(r.match,undefined,`project-only query "${query}" forces no Task`);
  }
  const both=resolve('release checklist');assert.equal(both.match,undefined,'same-named Tasks are not merged or auto-picked');
  assert.deepEqual(both.candidates.filter(c=>c.title==='Release checklist').map(c=>c.task_id).sort(),['task-atlas-origin','task-legacy-release']);
  assert.equal(resolve('cleanup sweep').match?.task_id,'task-legacy-cleanup','real task keywords still resolve');
  assert.equal(store.resolveTask(reader.auth,{query:'x',signals:{task_id:'task-legacy-atlas'}}).match?.task_id,'task-legacy-atlas','explicit IDs still work');
});

test('LR-16 (note 23): a Task moved from P to Q: every historical record is checked on its own project before limits',async t=>{
  const w=await world(t,{readerScopes:['memory:read','resume:read','task:reconcile:read','memory:sources:read']}),{store,reader}=w;
  const task={task_id:'task-lr-moving',project_id:'proj-lr-p',project_name:'Moving P',title:'Moving synthetic task',goal:'Synthetic history check',status:'active',workstreams:[{workstream_id:'ws-lr-move',name:'move',status:'active'}]};
  store.upsertTask(w.a.auth,task);
  const capture=(project,session,label)=>{const at=Date.now()-60_000;const base={project_id:project,task_id:task.task_id,workstream_id:'ws-lr-move',session_id:session};
    return store.appendEvents(w.a.auth,{events:[{...base,event_id:`${label}-user`,event_type:'user_message',captured_at:new Date(at).toISOString(),content:`决定：${label} uses synthetic storage`},
      {...base,event_id:`${label}-stop`,event_type:'assistant_message',hook_event_name:'Stop',captured_at:new Date(at+1000).toISOString(),content:`已完成：${label} synthetic step`}]});};
  const before=capture('proj-lr-p','session-lr-p','lrp');
  store.upsertTask(w.a.auth,{...task,project_id:'proj-lr-q',project_name:'Moving Q'});
  capture('proj-lr-q','session-lr-q','lrq');
  const pCheckpoints=store.db.prepare("SELECT checkpoint_id FROM checkpoints WHERE project_id='proj-lr-p'").all().map(r=>r.checkpoint_id);
  assert.ok(pCheckpoints.length&&before.checkpoints.length,'P history created through the supported API');
  w.mutate('proj-lr-p','deleted');
  const ids=list=>list.map(c=>c.checkpoint_id);
  assert.equal(ids(store.listCheckpoints(reader.auth,task.task_id)).some(id=>pCheckpoints.includes(id)),false);
  assert.ok(store.listCheckpoints(reader.auth,task.task_id).length>0,'Q history remains');
  assert.equal(ids(store.latestCheckpoints(w.user,task.task_id)).some(id=>pCheckpoints.includes(id)),false);
  const branches=store.previewTaskBranches(reader.auth,{query:'x',signals:{task_id:task.task_id}});
  assert.equal(branches.branches.find(b=>b.workstream_id==='ws-lr-move').sampled_event_count,2,'only Q events are sampled');
  const consoleCheckpoints=await consoleGet(w,'task-checkpoints',{task_id:task.task_id});
  assert.equal(consoleCheckpoints.body.checkpoints.some(c=>pCheckpoints.includes(c.checkpoint_id)),false);
  const manifestP=store.memorySources.manifest(reader.auth,{task_id:task.task_id,workstream_id:'ws-lr-move',session_id:'session-lr-p'});
  assert.equal(manifestP.total,0);assert.ok(store.memorySources.manifest(reader.auth,{task_id:task.task_id,workstream_id:'ws-lr-move',session_id:'session-lr-q'}).total>0);
  assert.throws(()=>store.memorySources.content(reader.auth,'lrp-user'),{errorCode:'PROJECT_DELETED'});
  assert.equal(store.memorySources.content(reader.auth,'lrq-user').availability,'available');
  // Resume inputs: no P event or P-derived memory becomes resume content.
  const resume=w.store.createPreview({...reader.auth,scopes:[...reader.auth.scopes]},{query:'x',signals:{task_id:task.task_id}});
  const text=JSON.stringify(resume);assert.doesNotMatch(text,/lrp-user|lrp-stop|lrp uses synthetic/);assert.match(text,/lrq/);
});

test('LR-17 (note 24): query-form IDs, aggregate resume status, and merged-ID Console metadata and archive rules',async t=>{
  const w=await world(t,{readerScopes:['memory:read','resume:read','resume:confirm','task:reconcile:read']}),{store,reader}=w;
  w.task('task-lr-gone','project-lr-gone','Gone project');w.task('task-lr-keep','project-lr-keep','Kept project');
  // A confirmed resume in a project that is deleted later must not break aggregate status.
  const confirm=taskId=>{const preview=store.createPreview(reader.auth,{query:taskId});assert.equal(preview.status,'pending_confirmation',JSON.stringify(preview).slice(0,300));
    return store.confirmPreview(reader.auth,preview.resume_id,preview.preview_version,true);};
  confirm('task-lr-gone');confirm('task-lr-keep');
  w.mutate('project-lr-gone','deleted');
  for(const query of ['continue project-lr-gone','status of project-lr-gone please'])assert.throws(()=>store.resolveProject(reader.auth,{query}),{errorCode:'PROJECT_DELETED'},query);
  assert.throws(()=>store.resolveTask(reader.auth,{query:'resume task-lr-gone now'}),{errorCode:'PROJECT_DELETED'});
  assert.throws(()=>store.previewProjectContext(reader.auth,{query:'project-lr-gone'}),{errorCode:'PROJECT_DELETED'});
  assert.equal(store.resolveProject(reader.auth,{query:'continue project-lr-keep'}).match?.project_id,'project-lr-keep');
  const status=store.status(reader.auth);
  assert.equal(store.injectionSummary(reader.auth).confirmed,1);assert.equal(store.deliveryReceiptSummary(reader.auth).confirmed,1);assert.ok(status);
  // Merged source ID in the Console: its own values are readable and labelled; project-level writes are refused unchanged.
  const writer=consoleWriter(w);
  store.db.prepare("INSERT INTO console_project_state VALUES (?,'proj-lr-src',?,1)").run(w.user,new Date().toISOString());
  const values=await consoleGet(w,'metadata-values',{kind:'project',id:'proj-lr-src',field:'aliases'});
  assert.equal(values.status,200);assert.deepEqual(values.body.items.map(i=>i.value),['old-codename']);assert.equal(values.body.canonical_project_id,'proj-lr-tgt');
  const before=store.db.prepare("SELECT * FROM console_project_state WHERE project_id='proj-lr-src'").get();
  for(const action of ['projects.archive','projects.restore','projects.update']){
    const payload=action==='projects.update'?{project_id:'proj-lr-src',expected_revision:'x',name:'Renamed'}:{project_id:'proj-lr-src'};
    await assert.rejects(store.consoleService.execute(writer,{action,operation_id:`op-${action.replace('.','-')}`,payload}),{errorCode:'PROJECT_NOT_CANONICAL'},action);
  }
  assert.deepEqual(store.db.prepare("SELECT * FROM console_project_state WHERE project_id='proj-lr-src'").get(),before,'the source keeps its own archive state');
  assert.equal(store.db.prepare("SELECT name FROM projects WHERE project_id='proj-lr-src'").get().name,'Lifecycle Source');
  const archiveTarget=await store.consoleService.execute(writer,{action:'projects.archive',operation_id:'op-archive-target',payload:{project_id:'proj-lr-tgt'}});
  assert.equal(archiveTarget.status,'archived','the canonical target is edited by its own ID');
});

test('LR-18 (note 25): a large legitimate merged group stays within the branch preview budget with truthful truncation',async t=>{
  const w=await world(t),{store,reader}=w,long=n=>`synthetic-${n}-`+'x'.repeat(1900);
  store.upsertProject(w.a.auth,{project_id:'proj-big',name:'Big Target',aliases:Array.from({length:20},(_,i)=>long(`t${i}`)),path_hints:Array.from({length:20},(_,i)=>`/synthetic/big/${i}/`+'p'.repeat(1500))});
  w.task('task-big','proj-big','Big Target',{title:'Big synthetic branch task',workstreams:[{workstream_id:'ws-big',name:'big',status:'active'}]});
  for(let i=0;i<20;i++){
    store.upsertProject(w.a.auth,{project_id:`proj-big-src-${i}`,name:`Big source ${i}`,aliases:Array.from({length:20},(_,j)=>long(`s${i}-${j}`)),
      git_remotes:Array.from({length:10},(_,j)=>`https://git.example.test/synthetic/big-${i}-${j}.git`),path_hints:Array.from({length:20},(_,j)=>`/synthetic/src/${i}/${j}/`+'q'.repeat(1500))});
    w.row(`proj-big-src-${i}`,'merged','proj-big');
  }
  const preview=store.previewTaskBranches(reader.auth,{query:'x',signals:{task_id:'task-big'}});
  assert.equal(preview.status,'task_branches_preview');
  const selected=preview.resolution.selected_project;
  assert.equal(selected.project_id,'proj-big');assert.equal(selected.merged_source_count,20);assert.equal(selected.merged_sources.length,20);
  assert.ok(selected.merged_sources.every(s=>s.inherited_from===s.project_id&&s.aliases.length<=3&&s.aliases_count===20&&s.git_remotes_count===10&&!('git_remotes' in s)));
  assert.equal(selected.metadata_truncated,true);assert.equal(selected.aliases_count,20);assert.ok(selected.aliases.length<=5);
  assert.ok(preview.projection.serialized_bytes<=128*1024);
  assert.equal(store.listProjects(w.user).find(p=>p.project_id==='proj-big').merged_sources[0].aliases.length,20,'stored aliases unchanged');
});

test('LR-19 (note 26): deletion during an in-flight semantic query, exact web grants, and source content',async t=>{
  let gate=null;
  // Deterministic barrier: `entered` resolves only when the query is blocked inside the embedding on this gate and
  // records the watched project's state then; the delete happens strictly after entry, before release.
  const f=fixture(t),e=embedder(async(texts,inputType)=>{
    if(inputType==='query'&&gate){const current=gate;current.signal(f.s.lifecycle.projectState('synthetic-owner',current.projectId));await current.promise;}
    return texts.map(x=>/network|router/i.test(x)?[1,0,0]:[0,0,1]);});
  const backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]])),now=new Date().toISOString();
  for(const project of ['proj-vec-live','proj-vec-dead'])f.s.db.prepare("INSERT INTO projects VALUES (?,'synthetic-owner',?,'[]','[]','[]','[]',?,?)").run(project,project,now,now);
  const live=f.save('Network router version 17.9.8 must not be changed.',{scope:'project',project_id:'proj-vec-live'});
  const dead=f.save('Network router firmware 4.2 belongs to the retired lab.',{scope:'project',project_id:'proj-vec-dead'});
  const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);
  gate={projectId:'proj-vec-dead'};gate.entered=new Promise(resolve=>gate.signal=resolve);gate.promise=new Promise(resolve=>gate.release=resolve);
  const pending=index.search(f.auth,{query:'network router',mode:'semantic'});
  assert.equal(await gate.entered,'live','the query reached the embedding wait while the project was live');
  // The project is deleted while the query embedding is outstanding.
  f.s.db.prepare("INSERT INTO project_lifecycle VALUES ('synthetic-owner','proj-vec-dead','deleted',NULL,1,?)").run(now);
  gate.release();
  const result=await pending;assert.equal(result.retrieval.effective_mode,'semantic');
  const ids=result.results.map(r=>r.memory_id);assert.ok(ids.includes(live.memory_id));assert.equal(ids.includes(dead.memory_id),false,'delivery revalidates after the wait');
  // Exact-revision web grant on a record whose project is deleted: no read, no listing, owner inspection is truthful.
  const w=await world(t),{store}=w;
  const grant=id=>{const {revision,state_hash}=store.revisions.latest(w.user,id);store.webVisibility.set(w.a.auth,id,{allow:true,revision,state_hash});};
  w.mutate('proj-lr-live','active');grant(w.m.live);grant(w.m.tgt);
  const web=store.authenticate(store.issueCredential({userId:w.user,deviceId:'web-lr',agentId:'chatgpt-web',agentInstanceId:'web-lr',scopes:['memory:read','resume:read']}).api_key);
  assert.ok(store.queryMemories(web,{query:'LRMARK'}).results.some(r=>r.memory_id===w.m.live));
  w.mutate('proj-lr-live','deleted');
  assert.equal(store.queryMemories(web,{query:'LRMARK'}).results.some(r=>r.memory_id===w.m.live),false);
  assert.throws(()=>store.memoryDetail(web,w.m.live),{errorCode:'MEMORY_NOT_FOUND'});
  assert.deepEqual(store.webVisibility.list(w.a.auth,{}).grants.map(g=>g.memory_id),[w.m.tgt]);
  assert.throws(()=>store.webVisibility.inspect(w.a.auth,w.m.live),{errorCode:'PROJECT_DELETED'});
  assert.equal(store.webVisibility.inspect(w.a.auth,w.m.tgt).allowed,true);
  const webContext=store.previewProjectContext(web,{project_id:'proj-lr-live'});assert.equal(webContext.status,'project_context_unavailable');
});

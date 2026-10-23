// Lifecycle read enforcement (phase 5B, LR-01..LR-08). Lifecycle state is created at runtime (no
// lifecycle mutation action exists yet; schema v10 enforcement after reopen is LV-01), so every test creates it in a disposable synthetic database behind a real
// loopback Core HTTP app. No model, embedding, network or real data is involved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {world,REMOTE} from './helpers/lifecycle-world.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {VectorIndex} from '../lib/vector-stores/index.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {fixture,embedder} from './helpers/memory-models.mjs';

test('LR-01: memory search excludes deleted-project records before the window, groups merged members, and answers deleted scopes truthfully only to the owner',async t=>{
  const w=await world(t),{m}=w;
  const all=await w.query({});assert.equal(all.status,200);
  assert.deepEqual(w.ids(all),[m.neutral,m.live,m.src,m.srcTask,m.tgt].sort(),'unscoped: neutral and live records only, never the deleted project or another owner');
  for(const project of ['proj-lr-tgt','proj-lr-src']){
    const scoped=await w.query({project_id:project});assert.equal(scoped.status,200);
    // A project scope covers that project's task-scoped records too (unchanged rule), now for every member.
    assert.deepEqual(w.ids(scoped),[m.neutral,m.src,m.srcTask,m.tgt].sort(),`${project}: canonical member set plus user-scope records`);
  }
  const viaSource=await w.query({project_id:'proj-lr-src'});
  assert.equal(viaSource.body.effective_scope.canonical_project_id,'proj-lr-tgt');assert.deepEqual(viaSource.body.effective_scope.project_members,['proj-lr-src','proj-lr-tgt']);
  const plain=await w.query({project_id:'proj-lr-live'});assert.equal(Object.hasOwn(plain.body.effective_scope,'canonical_project_id'),false,'single-project scopes keep their shape');
  // A Task of a merged source and its canonical target are the same project scope; another project is a mismatch.
  assert.equal((await w.query({project_id:'proj-lr-tgt',task_id:'task-lr-src'})).status,200);
  assert.equal((await w.query({project_id:'proj-lr-live',task_id:'task-lr-src'})).body.error_code,'SCOPE_MISMATCH');
  for(const body of [{project_id:'proj-lr-dead'},{task_id:'task-lr-dead'}]){
    const refused=await w.query(body);assert.equal(refused.status,409);assert.equal(refused.body.error_code,'PROJECT_DELETED');
  }
  const foreign=await w.query({project_id:'proj-lr-dead'},w.other);assert.equal(foreign.status,404);assert.equal(foreign.body.error_code,'PROJECT_NOT_FOUND');
  assert.equal((await w.query({project_id:'proj-lr-never'})).body.error_code,'PROJECT_NOT_FOUND');
  // The window is cut after the live filter: deleted records never take candidate slots.
  for(let i=0;i<30;i++)w.store.saveMemory(w.a.auth,{scope:'project',project_id:'proj-lr-tgt',content:`LRMARK filler ${i} synthetic lifecycle record`});
  w.store.db.prepare("DELETE FROM project_lifecycle WHERE project_id='proj-lr-dead'").run();
  for(let i=0;i<600;i++)w.store.saveMemory(w.a.auth,{scope:'project',project_id:'proj-lr-dead',content:`LRMARK flood ${i} synthetic lifecycle record`});
  w.row('proj-lr-dead','deleted');
  const flooded=await w.query({limit:10});assert.equal(flooded.status,200);assert.equal(flooded.body.result_count,10);
  assert.equal(flooded.body.retrieval.candidate_truncated,false,'600 deleted records do not exhaust the 500-candidate window');
});

test('LR-02: direct memory reads: PROJECT_DELETED for the owner (also with history), generic for others and for dangling or foreign references',async t=>{
  const w=await world(t),{m}=w;
  const get=(id,owner=w.reader,qs='')=>w.request('GET',`/v1/memories/${id}${qs}`,undefined,owner);
  assert.equal((await get(m.live)).status,200);assert.equal((await get(m.neutral)).status,200);assert.equal((await get(m.src)).status,200);
  for(const qs of ['','?include_history=true']){const r=await get(m.dead,w.reader,qs);assert.equal(r.status,409);assert.equal(r.body.error_code,'PROJECT_DELETED');}
  const foreign=await get(m.dead,w.other);assert.equal(foreign.status,404);assert.equal(foreign.body.error_code,'MEMORY_NOT_FOUND');
  // A non-NULL project reference that is dangling or another owner's is never readable, and never called deleted.
  for(const project of ['proj-lr-never-created','project-foreign']){
    w.store.db.prepare('UPDATE memories SET project_id=? WHERE memory_id=?').run(project,m.live);
    const r=await get(m.live);assert.equal(r.status,404,project);assert.equal(r.body.error_code,'MEMORY_NOT_FOUND');
    assert.equal(w.ids(await w.query({})).includes(m.live),false,`${project}: not in unscoped search either`);
  }
});

test('LR-03: derived consumers revalidate sources: deleted-project records are not current sources; live and merged ones are',async t=>{
  const w=await world(t),{m,user,store}=w;
  for(const id of [m.neutral,m.live,m.src,m.tgt])assert.ok(store.derivedMemory.currentSource(user,id),'live source');
  for(const id of [m.dead,m.deadTask])assert.equal(store.derivedMemory.currentSource(user,id),null,'deleted-project source');
  const snapshot=store.derivedMemory.currentSource(user,m.live),item={user_id:user,memory_id:m.live,revision:snapshot.revision,state_hash:snapshot.state_hash,scope_key:snapshot.scope_key};
  assert.ok(store.derivedMemory.validateItem(item));
  store.db.prepare("INSERT OR REPLACE INTO project_lifecycle VALUES (?,?,'deleted',NULL,1,?)").run(user,'proj-lr-live',new Date().toISOString());
  assert.equal(store.derivedMemory.validateItem(item),null,'a summary/vector item bound before the delete no longer validates');
  // Console summary list: a summary that depends on a deleted-project record is not listed (also a user-wide one).
  const insert=(id,dep)=>{store.db.prepare("INSERT INTO memory_summaries VALUES (?,?,1,?,?,'technical','{}','current','synthetic',?,1,0,?)").run(id,`g-${id}`,user,JSON.stringify([user,'user',null,null,null,null]),`job-${id}`,new Date().toISOString());
    store.db.prepare("INSERT INTO memory_summary_dependencies VALUES (?,?,?,1,'h',?)").run(id,user,dep,'k');};
  insert('sum-lr-live',m.tgt);insert('sum-lr-mixed',m.dead);
  const list=await w.request('GET','/v1/console/summaries',undefined,w.consoleReader);assert.equal(list.status,200);
  assert.deepEqual(list.body.summaries.map(s=>s.summary_id),['sum-lr-live']);
});

test('LR-04: project and task lists and the resolver: deleted absent, merged sources leave candidates and lend labelled signals to the target',async t=>{
  const w=await world(t),{store,user,reader}=w;
  const projects=store.listProjects(user);
  assert.deepEqual(projects.map(p=>p.project_id).filter(id=>id.startsWith('proj-lr')).sort(),['proj-lr-live','proj-lr-tgt']);
  const target=projects.find(p=>p.project_id==='proj-lr-tgt');
  assert.deepEqual(target.merged_sources.map(s=>[s.project_id,s.name,s.aliases]),[['proj-lr-src','Lifecycle Source',['old-codename']]]);
  assert.deepEqual([target.name,target.aliases],['Lifecycle Target',[]],'target identity not rewritten');
  const tasks=store.listTasks(user);
  assert.equal(tasks.some(t=>t.task_id==='task-lr-dead'),false);
  assert.deepEqual(tasks.filter(t=>t.task_id==='task-lr-src').map(t=>[t.project_id,t.canonical_project_id]),[['proj-lr-src','proj-lr-tgt']]);
  assert.equal(Object.hasOwn(tasks.find(t=>t.task_id==='task-lr-tgt'),'canonical_project_id'),false);
  const byRemote=store.resolveProject(reader.auth,{query:'continue work',signals:{git_remote:REMOTE}});
  assert.equal(byRemote.match?.project_id,'proj-lr-tgt');
  assert.ok(byRemote.match.reasons.some(r=>r.signal==='git_remote_exact'&&r.inherited_from==='proj-lr-src'),'inherited signal labelled with its origin');
  const byAlias=store.resolveProject(reader.auth,{query:'old-codename'});assert.equal(byAlias.match?.project_id,'proj-lr-tgt');
  const explicit=store.resolveProject(reader.auth,{query:'anything',signals:{project_id:'proj-lr-src'}});
  assert.deepEqual([explicit.match.project_id,explicit.match.routed_from,explicit.match.reasons[0].signal],['proj-lr-tgt','proj-lr-src','project_id_routed']);
  assert.throws(()=>store.resolveProject(reader.auth,{query:'anything',signals:{project_id:'proj-lr-dead'}}),{errorCode:'PROJECT_DELETED'});
  assert.throws(()=>store.resolveTask(reader.auth,{query:'anything',signals:{task_id:'task-lr-dead'}}),{errorCode:'PROJECT_DELETED'});
  const byDeadName=store.resolveProject(reader.auth,{query:'Lifecycle Dead'});
  assert.equal(byDeadName.candidates.some(c=>c.project_id==='proj-lr-dead'),false,'a deleted project is never a candidate');
  const scoped=store.resolveTask(reader.auth,{query:'Lifecycle task-lr-src',signals:{project_id:'proj-lr-tgt'}});
  assert.equal(scoped.match?.task_id,'task-lr-src');assert.equal(scoped.selected_project?.project_id,'proj-lr-tgt');
  // Another owner's view is unaffected by A's lifecycle state.
  assert.equal(store.listProjects(w.other.auth.user_id).some(p=>p.project_id.startsWith('proj-lr')),false);
});

test('LR-05: project context reads the canonical member set with origin labels; a deleted project is PROJECT_DELETED',async t=>{
  const w=await world(t),{m}=w;
  const preview=body=>w.request('POST','/v1/project-context/preview',body,w.reader);
  for(const id of ['proj-lr-src','proj-lr-tgt']){
    const r=await preview({query:id,project_id:id});assert.equal(r.status,200,id);
    assert.equal(r.body.project.project_id,'proj-lr-tgt');assert.deepEqual(r.body.project.merged_project_ids,['proj-lr-src']);
    assert.deepEqual(r.body.tasks.map(t=>[t.task_id,t.origin_project_id??null]).sort(),[['task-lr-src','proj-lr-src'],['task-lr-tgt',null]]);
    const memoryIds=r.body.structured_memories.map(x=>x.memory_id);
    assert.ok(memoryIds.includes(m.src)&&memoryIds.includes(m.tgt));assert.equal(memoryIds.includes(m.dead),false);
  }
  const dead=await preview({query:'proj-lr-dead',project_id:'proj-lr-dead'});assert.equal(dead.status,409);assert.equal(dead.body.error_code,'PROJECT_DELETED');
  const live=await preview({query:'proj-lr-live',project_id:'proj-lr-live'});assert.equal(Object.hasOwn(live.body.project,'merged_project_ids'),false);
});

test('LR-06: task-keyed reads: canonical pairs read, mismatches are generic, deleted projects are PROJECT_DELETED',async t=>{
  const w=await world(t),{store,reader}=w;
  const detail=payload=>store.previewProjectContext(reader.auth,{query:'x',task_field:'goal',...payload});
  assert.equal(detail({project_id:'proj-lr-tgt',task_id:'task-lr-src'}).task.project_id,'proj-lr-src','read through the canonical target, origin kept');
  assert.equal(detail({project_id:'proj-lr-src',task_id:'task-lr-src'}).status,'task_context_detail');
  assert.throws(()=>detail({project_id:'proj-lr-live',task_id:'task-lr-src'}),{errorCode:'TASK_CONTEXT_NOT_FOUND'});
  assert.throws(()=>detail({project_id:'proj-lr-never',task_id:'task-lr-src'}),{errorCode:'TASK_CONTEXT_NOT_FOUND'});
  for(const pair of [{project_id:'proj-lr-dead',task_id:'task-lr-dead'},{project_id:'proj-lr-tgt',task_id:'task-lr-dead'},{project_id:'proj-lr-dead',task_id:'task-lr-live'}])
    assert.throws(()=>detail(pair),{errorCode:'PROJECT_DELETED'},JSON.stringify(pair));
  assert.throws(()=>store.listCheckpoints(reader.auth,'task-lr-dead'),{errorCode:'PROJECT_DELETED'});
  assert.throws(()=>store.reconciliationState(reader.auth,'task-lr-dead'),{errorCode:'PROJECT_DELETED'});
  assert.throws(()=>store.listCanonicalRevisions(reader.auth,'task-lr-dead'),{errorCode:'PROJECT_DELETED'});
  assert.deepEqual(store.listCheckpoints(reader.auth,'task-lr-src'),[]);
  const http=await w.request('GET','/v1/tasks/task-lr-dead/checkpoints',undefined,reader);
  assert.deepEqual([http.status,http.body.error_code],[409,'PROJECT_DELETED']);
  assert.equal((await w.request('GET','/v1/tasks/task-lr-src/checkpoints',undefined,reader)).status,200);
});

test('LR-07: normal Console views are live-only and group merged sources under their target',async t=>{
  const w=await world(t),{m}=w,get=(view,params={})=>w.request('GET',`/v1/console/${view}?${new URLSearchParams(params)}`,undefined,w.consoleReader);
  const overview=await get('overview');assert.equal(overview.status,200);
  assert.equal(overview.body.counts.memories,5,'neutral, live, source, source task, target; not the 2 deleted-project records');
  for(const params of [{},{query:'LRMARK'}]){
    const list=await get('memories',params);assert.equal(list.status,200);
    const ids=list.body.results.map(r=>r.memory_id);assert.equal(ids.includes(m.dead)||ids.includes(m.deadTask),false);assert.ok(ids.includes(m.src));
  }
  const facets=await get('memories',{part:'facets'});assert.equal(facets.body.statuses.active,5);
  const projects=await get('projects');assert.equal(projects.status,200);
  const lr=projects.body.projects.filter(p=>p.project_id.startsWith('proj-lr'));
  assert.deepEqual(lr.map(p=>[p.project_id,p.task_count,p.merged_project_ids??null]).sort(),[['proj-lr-live',1,null],['proj-lr-tgt',2,['proj-lr-src']]]);
  const meta=await get('memory-meta',{memory_id:m.dead});assert.equal(meta.status,409);assert.equal(meta.body.error_code,'PROJECT_DELETED');
  assert.equal((await get('memory-meta',{memory_id:m.src})).status,200);
  const detail=await get('task-detail',{task_id:'task-lr-dead'});assert.equal(detail.body.error_code,'PROJECT_DELETED');
  const branches=await get('task-branches',{project_id:'proj-lr-src'});assert.equal(branches.status,200);
  assert.deepEqual(branches.body.tasks.map(x=>x.task_id).sort(),['task-lr-src','task-lr-tgt']);
  assert.equal((await get('task-branches',{project_id:'proj-lr-dead'})).body.error_code,'PROJECT_DELETED');
  // The live export (Console write credential) never carries deleted-project records.
  const writer=w.store.issueCredential({userId:w.user,deviceId:'device-console-writer-lr',agentId:'mnemuron-console',agentInstanceId:'console-writer-lr',scopes:[...CONSOLE_WRITE_SCOPES]});
  const exported=w.store.consoleService.export(w.store.authenticate(writer.api_key),{limit:20});
  assert.deepEqual(exported.records.map(r=>r.original_id).sort(),[m.neutral,m.live,m.src,m.srcTask,m.tgt].sort());
});

test('LR-09: semantic and hybrid retrieval never deliver an indexed record of a project deleted after indexing',async t=>{
  const f=fixture(t),e=embedder(),backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]));
  // This model fixture disables new handoff operations, so the synthetic owner's project rows are seeded directly.
  const now=new Date().toISOString();
  for(const project of ['proj-vec-live','proj-vec-dead'])f.s.db.prepare("INSERT INTO projects VALUES (?,'synthetic-owner',?,'[]','[]','[]','[]',?,?)").run(project,project,now,now);
  const live=f.save('Network router version 17.9.8 must not be changed.',{scope:'project',project_id:'proj-vec-live'});
  const dead=f.save('Network router firmware 4.2 belongs to the retired lab.',{scope:'project',project_id:'proj-vec-dead'});
  const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);
  const points=backend.collections.get(index.snapshot().collection_name).points;assert.equal(points.size,2,'both records were indexed before the delete');
  f.s.db.prepare("INSERT INTO project_lifecycle VALUES ('synthetic-owner','proj-vec-dead','deleted',NULL,1,?)").run(new Date().toISOString());
  for(const mode of ['semantic','hybrid']){
    const result=await index.search(f.auth,{query:'network router',mode});
    assert.equal(result.retrieval.effective_mode,mode,`${mode} ran (not a lexical fallback)`);
    const ids=result.results.map(r=>r.memory_id);
    assert.ok(ids.includes(live.memory_id),mode);assert.equal(ids.includes(dead.memory_id),false,`${mode}: the stale point never hydrates`);
  }
  // The scoped request is refused before any embedding call (the scope resolves first), not degraded.
  await assert.rejects(index.search(f.auth,{query:'network router',mode:'semantic',project_id:'proj-vec-dead'}),{errorCode:'PROJECT_DELETED'});
  assert.throws(()=>f.s.queryMemories(f.auth,{query:'network router',project_id:'proj-vec-dead'}),{errorCode:'PROJECT_DELETED'});
});

test('LR-08: inconsistent lifecycle metadata fails closed on reads instead of reading as live',async t=>{
  const w=await world(t);
  w.row('proj-lr-live','merged','proj-lr-tgt');w.row('proj-lr-tgt','merged','proj-lr-live');
  const search=await w.query({});assert.equal(search.status,409);assert.equal(search.body.error_code,'PROJECT_LIFECYCLE_CORRUPT');
  assert.throws(()=>w.store.listProjects(w.user),{errorCode:'PROJECT_LIFECYCLE_CORRUPT'});
  const consoleView=await w.request('GET','/v1/console/projects',undefined,w.consoleReader);assert.equal(consoleView.body.error_code,'PROJECT_LIFECYCLE_CORRUPT');
  // Another owner is unaffected.
  assert.equal((await w.query({},w.other)).status,200);
});

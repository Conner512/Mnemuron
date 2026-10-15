// Lifecycle read enforcement, review notes 28-31 (phase 5B, LR-20..LR-23). Synthetic isolated fixtures only; models
// are mocks and the vector backend is the in-memory mock. Lifecycle state is created at runtime (no lifecycle mutation action exists yet).
import test from 'node:test';
import assert from 'node:assert/strict';
import {world} from './helpers/lifecycle-world.mjs';
import {VectorIndex} from '../lib/vector-stores/index.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {embedder} from './helpers/memory-models.mjs';

const at=offset=>new Date(Date.now()-120_000+offset).toISOString();
// Captured events through the supported API; a Stop event creates the automatic checkpoint.
function capture(w,task,project,session,label){
  const base={project_id:project,task_id:task,workstream_id:'ws-final',session_id:session};
  return w.store.appendEvents(w.a.auth,{events:[{...base,event_id:`${label}-user`,event_type:'user_message',captured_at:at(0),content:`决定：${label} keeps synthetic storage`},
    {...base,event_id:`${label}-stop`,event_type:'assistant_message',hook_event_name:'Stop',captured_at:at(1000),content:`已完成：${label} synthetic step`}]});
}
const movingTask=(w,id,project)=>({task_id:id,project_id:project,project_name:project,title:`Moving ${id}`,goal:'Synthetic moved task',status:'active',
  workstreams:[{workstream_id:'ws-final',name:'final',status:'active'},{workstream_id:'ws-other',name:'other',status:'active'}]});

test('LR-20 (note 28): a moved Task is never ranked or explained by deleted-project confirmations or activity; live and merged history still count',async t=>{
  const w=await world(t,{readerScopes:['memory:read','resume:read','resume:confirm']}),{store,reader}=w;
  const confirm=taskId=>{const p=store.createPreview(reader.auth,{query:'unrelated marker',signals:{task_id:taskId}});assert.equal(p.status,'pending_confirmation');store.confirmPreview(reader.auth,p.resume_id,p.preview_version,true);};
  const task=movingTask(w,'task-final-move','proj-final-p');store.upsertTask(w.a.auth,task);
  confirm(task.task_id);capture(w,task.task_id,'proj-final-p','session-final-p','final-p');
  assert.equal(store.db.prepare("SELECT project_id FROM resolver_selections WHERE task_id='task-final-move'").get().project_id,'proj-final-p');
  assert.ok(store.taskAssociations(w.a.auth,{}).get(task.task_id)?.agent_instance_hits>0,'P activity counted while P is live');
  const before=store.resolveTask(reader.auth,{query:'unrelated marker'});
  assert.equal(before.match?.task_id,task.task_id,'baseline: the old confirmation alone auto-selects the Task');
  store.upsertTask(w.a.auth,{...task,project_id:'proj-final-q',project_name:'proj-final-q'});
  w.mutate('proj-final-p','deleted');
  const after=store.resolveTask(reader.auth,{query:'unrelated marker'});
  assert.equal(after.match,undefined,'deleted-project confirmations no longer auto-select the live Task in Q');
  const explained=JSON.stringify(after);assert.doesNotMatch(explained,/prior_confirmation/,'and never appear in explanations');
  assert.equal(store.taskAssociations(w.a.auth,{}).get(task.task_id),undefined,'P-only agent/recency evidence is gone');
  // Live positive: a confirmation recorded while the Task is in Q counts again.
  confirm(task.task_id);
  const live=store.resolveTask(reader.auth,{query:'unrelated marker'});
  assert.equal(live.match?.task_id,task.task_id);
  assert.equal(live.match.reasons.find(r=>r.signal==='prior_confirmation').detail,'1 matching confirmation(s)','only the live confirmation counts');
  // Merged-origin positive: confirmations of a Task in a merged source stay live and keep ranking it.
  const merged=await world(t,{readerScopes:['memory:read','resume:read','resume:confirm']});
  const p=merged.store.createPreview(merged.reader.auth,{query:'merged marker',signals:{task_id:'task-lr-src'}});merged.store.confirmPreview(merged.reader.auth,p.resume_id,p.preview_version,true);
  merged.mutate('proj-lr-src','merged','proj-lr-tgt');
  assert.equal(merged.store.resolveTask(merged.reader.auth,{query:'merged marker'}).match?.task_id,'task-lr-src');
});

test('LR-21 (note 29): semantic and hybrid reads through the Core entry keep PROJECT_DELETED instead of reporting provider degradation',async t=>{
  const w=await world(t),{store,user}=w;let gate=null;
  // Deterministic barrier: `entered` resolves only when the request is blocked inside the query embedding on this gate,
  // and records the watched project's state at that moment; the test deletes only after entry, then releases.
  const barrier=projectId=>{const g={projectId};g.entered=new Promise(resolve=>g.signal=resolve);g.promise=new Promise(resolve=>g.release=resolve);return g;};
  const e=embedder(async(texts,inputType)=>{
    if(inputType==='query'&&gate){const current=gate;current.signal(store.lifecycle.projectState(user,current.projectId));await current.promise;}
    return texts.map(x=>/LRMARK/i.test(x)?[1,0,0]:[0,0,1]);});
  const index=new VectorIndex(store,new MockVectorStore(),new Map([[e.profile.fingerprint,e]]));
  const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);
  // Test seam: a personal embedder exists for this owner and the Console vector index is the synthetic one, so
  // store.searchMemories takes its personal-profile path (and its outer catch) exactly as in production.
  store.db.prepare("INSERT INTO console_models VALUES (?,'embedder',1,?,'synthetic-cipher',?)").run(user,JSON.stringify({enabled:true,model:'synthetic-embedder'}),Date.now());
  store.consoleService.vector=()=>index;
  const query=(body,owner=w.reader)=>w.request('POST','/v1/memories/query',{query:'LRMARK',...body},owner);
  const unscoped=await query({mode:'semantic'});assert.equal(unscoped.status,200);assert.equal(unscoped.body.retrieval.effective_mode,'semantic');
  for(const mode of ['semantic','hybrid']){
    const refused=await query({mode,project_id:'proj-lr-dead'});
    assert.deepEqual([refused.status,refused.body.error_code],[409,'PROJECT_DELETED'],`${mode}: pre-deleted requested scope`);
    const foreign=await query({mode,project_id:'proj-lr-dead'},w.other);
    assert.deepEqual([foreign.status,foreign.body.error_code],[404,'PROJECT_NOT_FOUND'],'another owner: generic not found');
  }
  // Scoped request whose project is deleted while the query embedding is outstanding.
  gate=barrier('proj-lr-live');
  const pending=store.searchMemories(w.reader.auth,{query:'LRMARK',mode:'semantic',project_id:'proj-lr-live'});
  assert.equal(await gate.entered,'live','the request reached the embedding wait while the project was live');
  w.mutate('proj-lr-live','deleted');gate.release();
  await assert.rejects(pending,error=>error.errorCode==='PROJECT_DELETED'&&error.statusCode===409,'deleted during the wait: still PROJECT_DELETED');
  gate=null;
  // Narrow web reader (note 32): an exact current grant on a record of the requested project; the project is deleted
  // while the query embedding is outstanding. The requested scope is rechecked before web index freshness, so the answer
  // is PROJECT_DELETED, not a VECTOR_STALE degradation.
  const {revision,state_hash}=store.revisions.latest(user,w.m.tgt);store.webVisibility.set(w.a.auth,w.m.tgt,{allow:true,revision,state_hash});
  const web=w.credential('chatgpt-web','web-lr21',['memory:read','resume:read']);
  const granted=await query({mode:'semantic',project_id:'proj-lr-tgt'},web);
  assert.equal(granted.status,200);assert.equal(granted.body.retrieval.effective_mode,'semantic');
  assert.deepEqual(granted.body.results.map(r=>r.memory_id),[w.m.tgt],'baseline: only the exact grant is readable');
  gate=barrier('proj-lr-tgt');
  const webPending=query({mode:'semantic',project_id:'proj-lr-tgt'},web);
  assert.equal(await gate.entered,'live','the HTTP request reached the embedding wait while the project was live');
  w.mutate('proj-lr-tgt','deleted');gate.release();
  const webDeleted=await webPending;
  assert.deepEqual([webDeleted.status,webDeleted.body.error_code],[409,'PROJECT_DELETED'],'narrow web reader: deleted during the wait');
  assert.doesNotMatch(JSON.stringify(webDeleted.body),/LRMARK/,'no content in the refusal');
  gate=null;
  // Real provider degradation is still reported as such.
  store.consoleService.vector=()=>{throw Object.assign(new Error('synthetic backend down'),{code:'VECTOR_UNAVAILABLE'});};
  const degraded=await query({mode:'semantic'});
  assert.deepEqual([degraded.status,degraded.body.error_code],[503,'SEMANTIC_UNAVAILABLE']);
  const fallback=await query({mode:'hybrid'});
  assert.equal(fallback.status,200);assert.equal(fallback.body.retrieval.degraded,true);
});

test('LR-22 (note 30): status reconciliation counts and direct reconciliation state agree for a moved Task after its old project is deleted',async t=>{
  const w=await world(t,{readerScopes:['memory:read','resume:read','task:reconcile:read']}),{store,reader}=w;
  const task=movingTask(w,'task-final-recon','proj-recon-p');store.upsertTask(w.a.auth,task);
  capture(w,task.task_id,'proj-recon-p','session-recon-p','recon-p');
  const pProposals=store.db.prepare("SELECT COUNT(*) n FROM task_reconciliation_proposals WHERE project_id='proj-recon-p'").get().n;
  assert.ok(pProposals>0,'P proposals exist through the supported capture path');
  store.upsertTask(w.a.auth,{...task,project_id:'proj-recon-q',project_name:'proj-recon-q'});
  capture(w,task.task_id,'proj-recon-q','session-recon-q','recon-q');
  const compare=()=>{
    const direct=store.reconciliationState(reader.auth,task.task_id).summary,aggregate=store.status(reader.auth).canonical_reconciliation;
    // This is the only Task with proposals, so the account-wide live aggregate must equal its direct state exactly.
    for(const key of ['pending','conflicts','auto_applied','stale','deferred_checkpoints'])assert.equal(aggregate[key],direct[key],key);
    return direct;
  };
  const before=compare();
  w.mutate('proj-recon-p','deleted');
  const after=compare();
  assert.ok(after.auto_applied+after.stale+after.pending<before.auto_applied+before.stale+before.pending,'P proposals left both views');
});

test('LR-23 (note 31): exact task and workstream summaries of a moved Task cover both origin project keys after a merge, without blending other Tasks or workstreams',async t=>{
  const w=await world(t),{store,user,reader}=w;
  const task=movingTask(w,'task-final-sum','proj-sum-p');store.upsertTask(w.a.auth,task);
  const inP=store.saveMemory(w.a.auth,{scope:'task',task_id:task.task_id,content:'LRMARK summary source in P'}).memory.memory_id;
  store.upsertTask(w.a.auth,{...task,project_id:'proj-sum-q',project_name:'proj-sum-q'});
  const inQ=store.saveMemory(w.a.auth,{scope:'task',task_id:task.task_id,content:'LRMARK summary source in Q'}).memory.memory_id;
  store.upsertTask(w.a.auth,movingTask(w,'task-final-neighbour','proj-sum-q'));
  const neighbour=store.saveMemory(w.a.auth,{scope:'task',task_id:'task-final-neighbour',content:'LRMARK neighbour source'}).memory.memory_id;
  const key=(scope,project,taskId,workstream=null)=>JSON.stringify([user,scope,project,taskId,workstream,null]);
  const insert=(id,scopeKey,deps)=>{store.db.prepare("INSERT INTO memory_summaries VALUES (?,?,1,?,?,'uncategorized','{}','current','synthetic',?,?,0,?)").run(id,`g-${id}`,user,scopeKey,`job-${id}`,deps.length,new Date().toISOString());
    for(const memory of deps){const s=store.derivedMemory.currentSource(user,memory);store.db.prepare('INSERT INTO memory_summary_dependencies VALUES (?,?,?,?,?,?)').run(id,user,memory,s.revision,s.state_hash,s.scope_key);}};
  insert('sum-task-p',key('task','proj-sum-p',task.task_id),[inP]);insert('sum-task-q',key('task','proj-sum-q',task.task_id),[inQ]);
  insert('sum-neighbour',key('task','proj-sum-q','task-final-neighbour'),[neighbour]);
  insert('sum-ws-p',key('workstream','proj-sum-p',task.task_id,'ws-final'),[inP]);insert('sum-ws-other-p',key('workstream','proj-sum-p',task.task_id,'ws-other'),[inP]);
  const read=body=>store.memorySummaries(reader.auth,body).results.map(r=>r.summary_id).sort();
  assert.deepEqual(read({scope:'task',task_id:task.task_id}),['sum-task-q'],'before the merge: only the current project key');
  w.mutate('proj-sum-p','merged','proj-sum-q');
  assert.deepEqual(read({scope:'task',task_id:task.task_id}),['sum-task-p','sum-task-q'],'after P->Q merge: both origin keys of this Task');
  assert.deepEqual(read({scope:'task',task_id:'task-final-neighbour'}),['sum-neighbour'],'another Task in Q is never blended in');
  assert.deepEqual(read({scope:'workstream',task_id:task.task_id,workstream_id:'ws-final'}),['sum-ws-p'],'workstream field kept exactly');
  assert.deepEqual(read({scope:'workstream',task_id:task.task_id,workstream_id:'ws-other'}),['sum-ws-other-p']);
  // Dependency authorization still applies per summary: a later retraction of P's source hides the P summary only.
  store.retractMemory(w.a.auth,inP,{});
  assert.deepEqual(read({scope:'task',task_id:task.task_id}),['sum-task-q']);
});

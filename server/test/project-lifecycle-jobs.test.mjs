// Lifecycle enforcement for jobs and derived outputs (phase 5D, LJ-01..LJ-06). Synthetic isolated fixtures and mock
// providers only. No lifecycle mutation action exists yet, so deleted/merged state is created at
// runtime (reopen of persisted state: LV-01). Deleted-project sources are never scheduled, never sent to a model, and never published or indexed;
// merged sources stay live members of their target.
import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {MemoryWorker,scheduleLibrary} from '../lib/memory-jobs/worker.mjs';
import {VectorIndex} from '../lib/vector-stores/index.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {fixture,organizer,embedder,taxonomy} from './helpers/memory-models.mjs';
import {ModelError} from '../lib/model-providers/contracts.mjs';

const OWNER='synthetic-owner';
const rows=(s,table,where='1',...params)=>s.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...params);
const classify=input=>({results:input.sources.map(s=>({memory_id:s.memory_id,category:'engineering',tags:[]}))});
const quoteAll=input=>({results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content}))});
// This model fixture disables new handoff operations, so the synthetic owner's project rows are seeded directly.
function world(t){
  const f=fixture(t),now=new Date().toISOString();
  for(const id of ['proj-lj-live','proj-lj-dead','proj-lj-src','proj-lj-tgt'])f.s.db.prepare("INSERT INTO projects VALUES (?,?,?,'[]','[]','[]','[]',?,?)").run(id,OWNER,id,now,now);
  const save=(project,text)=>f.save(`${text} synthetic job source.`,{scope:'project',project_id:project}).memory_id;
  const m={live:save('proj-lj-live','Live release 1.2 is approved'),dead:save('proj-lj-dead','Retired lab firmware 4.2'),src:save('proj-lj-src','Source codename stays internal'),
    neutral:f.save('Neutral user preference synthetic job source.').memory_id};
  const lifecycle=(id,state,into=null)=>f.s.db.prepare('INSERT OR REPLACE INTO project_lifecycle VALUES (?,?,?,?,1,?)').run(OWNER,id,state,into,new Date().toISOString());
  const del=id=>lifecycle(id,'deleted');
  lifecycle('proj-lj-src','merged','proj-lj-tgt');
  return {...f,m,lifecycle,del,saveIn:save};
}
const schedule=(w,jobs,model,type='classification')=>scheduleLibrary(w.s,jobs,{userId:OWNER,organizer:model,taxonomy,type,periods:['daily'],includeOpen:true});
const itemIds=(w,jobIds)=>jobIds.flatMap(id=>rows(w.s,'memory_job_items','job_id=?',id).map(r=>r.memory_id)).sort();

test('LJ-01: scheduling never includes a deleted project\'s records; merged sources and neutral records stay schedulable',async t=>{
  const w=world(t),jobs=new MemoryJobs(w.s),model=organizer(classify);
  w.del('proj-lj-dead');
  const plan=schedule(w,jobs,model);
  assert.deepEqual(itemIds(w,plan.jobs),[w.m.live,w.m.src,w.m.neutral].sort());
  assert.equal(plan.excluded,1);
  // Control: the same scheduling covers the record while its project is live.
  w.s.db.prepare("DELETE FROM project_lifecycle WHERE project_id='proj-lj-dead'").run();
  assert.ok(itemIds(w,schedule(w,jobs,model).jobs).includes(w.m.dead));
  // Merged sources run and publish (they are live members of their target).
  assert.ok((await new MemoryWorker(w.s,jobs,model).drain()).every(r=>r.state==='succeeded'));
  assert.equal(rows(w.s,'memory_annotations','memory_id=?',w.m.src).length,1);
});

test('LJ-02: a job queued before its project was deleted never sends the source to a model and publishes nothing',async t=>{
  const w=world(t);let calls=0;
  const model=organizer(input=>{calls++;return classify(input);}),jobs=new MemoryJobs(w.s);
  schedule(w,jobs,model);
  w.del('proj-lj-dead');
  const results=await new MemoryWorker(w.s,jobs,model).drain();
  const job=results.map(r=>jobs.get(r.job_id)).find(j=>rows(w.s,'memory_job_items','job_id=?',j.job_id).some(i=>i.memory_id===w.m.dead));
  assert.equal(job.state,'stale');assert.equal(job.last_error_code,'STALE_INPUT');
  assert.equal(rows(w.s,'memory_annotations','memory_id=?',w.m.dead).length,0);
  assert.equal(calls,results.filter(r=>r.state==='succeeded').length,'only jobs without the deleted source called the model');
});

test('LJ-03: a deletion while the model call is in flight prevents the chunk result and publication (classification and summary)',async t=>{
  for(const type of ['classification','summary']){
    const w=world(t);
    const model=organizer(input=>{if(input.sources.some(s=>s.memory_id===w.m.dead))w.del('proj-lj-dead');return type==='summary'?quoteAll(input):classify(input);});
    const jobs=new MemoryJobs(w.s);schedule(w,jobs,model,type);
    const states=await new MemoryWorker(w.s,jobs,model).drain();
    assert.ok(states.some(r=>r.state==='stale'),type);
    assert.equal(rows(w.s,'memory_annotations','memory_id=?',w.m.dead).length,0,type);
    assert.equal(rows(w.s,'memory_summary_dependencies','memory_id=?',w.m.dead).length,0,`${type}: no summary depends on the deleted source`);
    assert.equal(rows(w.s,'memory_job_items',"memory_id=? AND state='done'",w.m.dead).length,0,`${type}: no chunk result saved`);
  }
});

test('LJ-04: the organizer repair retry is not sent once a source\'s project was deleted during the first call',async t=>{
  const w=world(t);let calls=0;
  const model=organizer(input=>{calls++;if(calls===1){w.del('proj-lj-dead');return 'not json';}return classify(input);},{retry:{max_attempts:3,base_ms:100,max_ms:10000,repair_once:true}});
  const jobs=new MemoryJobs(w.s);
  // Only the deleted-to-be project's record is scheduled, so the first model call is for it.
  w.del('proj-lj-live');w.lifecycle('proj-lj-src','deleted');w.s.db.prepare("INSERT INTO memory_privacy VALUES (?,?, 'secret')").run(OWNER,w.m.neutral);
  const plan=schedule(w,jobs,model);assert.deepEqual(itemIds(w,plan.jobs),[w.m.dead]);
  const [result]=await new MemoryWorker(w.s,jobs,model).drain();
  assert.equal(result.state,'stale');assert.equal(jobs.get(result.job_id).last_error_code,'STALE_INPUT');
  assert.equal(calls,1,'the repair request carrying the deleted source was never sent');
  assert.equal(rows(w.s,'memory_annotations').length,0);
});

test('LJ-05: publication revalidates every source inside its transaction, at each layer on its own (summary and classification)',async t=>{
  // Through the worker: a deletion just before publication publishes nothing for that job; other jobs still publish.
  const w=world(t),model=organizer(quoteAll),jobs=new MemoryJobs(w.s);
  schedule(w,jobs,model,'summary');
  const publish=jobs.publish.bind(jobs);
  jobs.publish=(job,callback)=>{if(rows(w.s,'memory_job_items','job_id=?',job.job_id).some(i=>i.memory_id===w.m.dead))w.del('proj-lj-dead');return publish(job,callback);};
  const states=await new MemoryWorker(w.s,jobs,model).drain();
  assert.equal(states.filter(r=>r.state==='stale').length,1);
  assert.equal(rows(w.s,'memory_summary_dependencies','memory_id=?',w.m.dead).length,0);
  assert.ok(rows(w.s,'memory_summary_dependencies','memory_id=?',w.m.live).length>0,'control: other summaries published');
  // Each layer alone, with the source deleted after its items were saved: MemoryJobs.publish, then the derived publishers.
  for(const type of ['summary','classification']){
    const v=world(t),vjobs=new MemoryJobs(v.s),vmodel=organizer(type==='summary'?quoteAll:classify);
    // Only the deleted-to-be project's record is scheduled, so it is the one job to claim.
    v.del('proj-lj-live');v.lifecycle('proj-lj-src','deleted');v.s.db.prepare("INSERT INTO memory_privacy VALUES (?,?, 'secret')").run(OWNER,v.m.neutral);
    const plan=schedule(v,vjobs,vmodel,type);assert.deepEqual(itemIds(v,plan.jobs),[v.m.dead]);
    const job=vjobs.claim('lj-05',{userId:OWNER});assert.equal(job.job_id,plan.jobs[0]);
    const items=vjobs.items(job),outputs=(type==='summary'?quoteAll:classify)({sources:items.map(i=>({...v.s.derivedMemory.validateItem(i)}))}).results;
    vjobs.saveChunk(job,items,outputs);
    v.del('proj-lj-dead');
    let called=false;
    assert.throws(()=>vjobs.publish(job,()=>{called=true;}),{code:'STALE_INPUT'},`${type}: MemoryJobs.publish`);
    assert.equal(called,false,`${type}: the publisher callback never ran`);
    const derived=v.s.derivedMemory,ran=()=>type==='summary'?derived.publishSummary(job,items,outputs,Date.now()):derived.publishAnnotations(job,items,outputs);
    assert.throws(()=>v.s.memoryTransaction(ran),{code:'STALE_INPUT'},`${type}: ${type==='summary'?'publishSummary':'publishAnnotations'} on its own`);
    assert.equal(rows(v.s,'memory_annotations','memory_id=?',v.m.dead).length+rows(v.s,'memory_summary_dependencies','memory_id=?',v.m.dead).length,0);
  }
});

test('LJ-06: vector builds hide a deleted project\'s documents and never embed a source deleted before its provider call; the build continues',async t=>{
  const w=world(t);let calls=0;
  const e=embedder(texts=>{calls++;return texts.map(()=>[0,0,1]);}),backend=new MockVectorStore(),index=new VectorIndex(w.s,backend,new Map([[e.profile.fingerprint,e]]));
  const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);
  const docs=g=>Object.fromEntries(rows(w.s,'memory_vector_documents','generation=?',g).map(d=>[d.memory_id,d.state]));
  const points=g=>[...backend.collections.get(w.s.db.prepare('SELECT collection_name FROM memory_vector_generations WHERE generation=?').get(g).collection_name).points.values()];
  assert.equal(docs(generation)[w.m.dead],'indexed');
  w.del('proj-lj-dead');await index.sync(generation);
  assert.equal(docs(generation)[w.m.dead],'hidden');
  assert.equal(rows(w.s,'memory_vector_points','memory_id=?',w.m.dead).length,0,'no point mapping remains for the deleted record');
  assert.equal(points(generation).length,rows(w.s,'memory_vector_points','generation=?',generation).length,'backend points match the remaining mappings');
  // A source whose project is deleted after it was read but before the provider call: refused at reservation (no call),
  // hidden, and a later live record in the same pass is still indexed.
  const doomed=w.saveIn('proj-lj-live','Doomed addition'),later=w.saveIn('proj-lj-tgt','Later addition');
  const embed=e.embed.bind(e);e.embed=(texts,type,options)=>{if(texts.some(x=>x.includes('Doomed addition')))w.del('proj-lj-live');return embed(texts,type,options);};
  const before=calls;
  const result=await index.sync(generation);
  assert.equal(result.complete,true,'one stale document does not stop the build');
  assert.equal(calls,before+1,'only the later live record was embedded');
  assert.equal(docs(generation)[doomed],'hidden');assert.equal(docs(generation)[later],'indexed');
  // First-run manifest build: the same document is marked stale and skipped, and the build completes.
  w.s.db.prepare("DELETE FROM project_lifecycle WHERE project_id='proj-lj-live'").run();
  const manifest=[w.m.live,later].map(id=>{const r=w.s.derivedMemory.currentSource(OWNER,id);return {memory_id:id,revision:r.revision,state_hash:r.state_hash};});
  // A first-run manifest build belongs to one owner (an owner-scoped index, as the Console builds it).
  const owned=new VectorIndex(w.s,backend,new Map([[e.profile.fingerprint,e]]),{ownerId:OWNER});
  const g2=owned.begin(e.profile.fingerprint,{manifest});
  e.embed=(texts,type,options)=>{if(texts.some(x=>x.includes('Live release')))w.del('proj-lj-live');return embed(texts,type,options);};
  const built=await owned.sync(g2);
  assert.equal(built.complete,true);
  assert.deepEqual(Object.fromEntries(owned.manifest(g2).map(m=>[m.memory_id,m.state])),{[w.m.live]:'stale',[later]:'indexed'});
  assert.equal(points(g2).length,rows(w.s,'memory_vector_points','generation=?',g2).length);
});

test('LJ-07: a provider STALE_INPUT for a still-valid source (configuration changed mid-build) stops the build and never hides or skips live records',async t=>{
  const w=world(t);let failing=false;
  const e=embedder(texts=>{if(failing)throw new ModelError('STALE_INPUT');return texts.map(()=>[0,0,1]);}),backend=new MockVectorStore();
  const index=new VectorIndex(w.s,backend,new Map([[e.profile.fingerprint,e]]),{ownerId:OWNER});
  const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);
  const indexed=()=>rows(w.s,'memory_vector_documents',"generation=? AND state='indexed'",generation).length,mapped=()=>rows(w.s,'memory_vector_points','generation=?',generation).length;
  const before=[indexed(),mapped()];
  // A new live record needs embedding; the provider now reports that its configuration changed.
  const added=w.saveIn('proj-lj-live','Live addition needing embedding');
  failing=true;
  await assert.rejects(index.sync(generation),{code:'STALE_INPUT'});
  assert.deepEqual([indexed(),mapped()],before,'no live document was hidden and no point mapping removed');
  assert.equal(rows(w.s,'memory_vector_documents','generation=? AND memory_id=?',generation,added).length,0,'the live record is not recorded as hidden; it is retried');
  // First-run manifest build: the live items stay pending (retried later), never silently marked stale.
  const manifest=[w.m.src,w.m.neutral].map(id=>{const r=w.s.derivedMemory.currentSource(OWNER,id);return {memory_id:id,revision:r.revision,state_hash:r.state_hash};});
  const g2=index.begin(e.profile.fingerprint,{manifest});
  await assert.rejects(index.sync(g2),{code:'STALE_INPUT'});
  assert.deepEqual(index.manifest(g2).map(m=>m.state),['pending','pending']);
});

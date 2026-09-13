import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {MemoryWorker,scheduleLibrary} from '../lib/memory-jobs/worker.mjs';
import {calendarWindow} from '../lib/memory-jobs/windows.mjs';
import {fixture,organizer,taxonomy} from './helpers/memory-models.mjs';
import {ModelError} from '../lib/model-providers/contracts.mjs';
const rows=(s,table)=>s.db.prepare('SELECT * FROM '+table).all();
function scheduled(t,{count=3,model=organizer(),clock}={}){
  const f=fixture(t),jobs=new MemoryJobs(f.s,{clock,batchSize:2});for(let n=0;n<count;n++)f.save('Natural language version 1.'+n+' is not approved.');
  const options={userId:f.auth.user_id,organizer:model,taxonomy,includeOpen:true};
  return {...f,jobs,model,options,worker:new MemoryWorker(f.s,jobs,model)};
}
test('J-01 S-01 S-06: ordinary memories classify separately and repeat snapshot schedules are idempotent',async t=>{
  const f=scheduled(t),before=rows(f.s,'memories');const first=scheduleLibrary(f.s,f.jobs,f.options);
  assert.deepEqual(scheduleLibrary(f.s,f.jobs,f.options).jobs,first.jobs);await f.worker.drain();
  assert.equal(rows(f.s,'memory_annotations').length,3);assert.deepEqual(rows(f.s,'memories'),before);
  assert.deepEqual(scheduleLibrary(f.s,f.jobs,f.options).jobs,first.jobs);
  assert.equal((await f.worker.drain()).length,0);
});
test('J-02 J-03: crash/reclaim fencing rejects late workers and retains completed chunks',async t=>{
  let now=1000;const f=scheduled(t,{clock:()=>now});scheduleLibrary(f.s,f.jobs,f.options);
  const first=f.jobs.claim('old');now+=60001;const second=f.jobs.claim('new');assert.equal(second.fence,first.fence+1);
  assert.throws(()=>f.jobs.publish(first,()=>{}),e=>e.code==='LEASE_LOST');
  now+=60001;assert.equal((await f.worker.runOne()).state,'succeeded');assert.equal(rows(f.s,'memory_annotations').length,3);
});
test('J-04 S-09: network work holds no SQLite transaction and a retraction prevents publication',async t=>{
  const f=fixture(t),memory=f.save('Do not deploy version 2.0.');let called=false;
  const model=organizer(input=>{assert.equal(f.s.db.isTransaction,false);f.s.retractMemory(f.auth,memory.memory_id);called=true;return {results:input.sources.map(s=>({memory_id:s.memory_id,category:'engineering',tags:[]}))};});
  const jobs=new MemoryJobs(f.s);scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy});
  assert.equal((await new MemoryWorker(f.s,jobs,model).runOne()).state,'stale');assert.equal(called,true);assert.equal(rows(f.s,'memory_annotations').length,0);
});
test('J-05: DST days are 23/25 hours; weekly and restart windows stay stable',()=>{
  const spring=calendarWindow(Date.parse('2026-03-08T15:00:00Z'),{timezone:'America/New_York'});
  const fall=calendarWindow(Date.parse('2026-11-01T15:00:00Z'),{timezone:'America/New_York'});
  assert.equal(Date.parse(spring.end)-Date.parse(spring.start),23*3600000);assert.equal(Date.parse(fall.end)-Date.parse(fall.start),25*3600000);
  const week=calendarWindow(Date.parse('2026-03-08T15:00:00Z'),{timezone:'America/New_York',period:'weekly'});assert.equal(week.local_start,'2026-03-02');
  assert.deepEqual(spring,calendarWindow(Date.parse('2026-03-08T19:00:00Z'),{timezone:'America/New_York'}));
});
test('J-06 J-08: per-profile auth pause, budgets, retries, dead letter and cancellation',async t=>{
  let now=1000;const f=scheduled(t,{clock:()=>now,model:organizer(()=>{throw new ModelError('AUTH_FAILED');})});
  const plan=scheduleLibrary(f.s,f.jobs,f.options);assert.equal((await f.worker.runOne()).state,'blocked_auth');assert.equal(f.jobs.claim('other'),null);
  assert.equal(f.s.queryMemories(f.auth,{query:'version'}).results.length,3);
  f.jobs.resumeProfile(f.model.profile.fingerprint);f.jobs.cancel(plan.jobs[0]);assert.equal(f.jobs.get(plan.jobs[0]).state,'cancelled');
  const g=scheduled(t,{clock:()=>now,model:organizer(()=>{throw new ModelError('RATE_LIMITED',{retryAfterMs:5000});})});
  scheduleLibrary(g.s,g.jobs,g.options);
  for(let n=1;n<=3;n++){const result=await g.worker.runOne();assert.equal(result.state,n===3?'dead_letter':'retry_wait');assert.ok(result.run_after>=now+5000);now+=5001;}
  const h=scheduled(t,{count:3,model:organizer(undefined,{limits:{...organizer().profile.limits,daily_requests:1}})});
  scheduleLibrary(h.s,h.jobs,h.options);assert.equal((await h.worker.runOne()).state,'blocked_budget');assert.equal(rows(h.s,'memory_annotations').length,0);
});
test('J-07: more than 500 items use every input page and bounded model batches',async t=>{
  const f=scheduled(t,{count:0});f.s.memoryTransaction(()=>{for(let n=0;n<603;n++)f.save('Synthetic distinct memory '+n);});
  f.jobs.batchSize=20;const plan=scheduleLibrary(f.s,f.jobs,f.options);assert.equal(plan.scanned,603);
  const result=await f.worker.runOne();assert.equal(result.processed,603);assert.equal(rows(f.s,'memory_annotations').length,603);
});
test('S-02 S-04 S-07 S-08 S-10: locked categories, source-grounded daily/weekly views and immediate stale reads',async t=>{
  const f=scheduled(t,{count:2});const memory=rows(f.s,'memories')[0];
  f.s.db.prepare('INSERT INTO memory_category_overrides VALUES (?,?,?,1)').run(f.auth.user_id,memory.memory_id,'preferences');
  scheduleLibrary(f.s,f.jobs,f.options);await f.worker.drain();
  assert.equal(f.s.derivedMemory.category(f.s.derivedMemory.currentSource(f.auth.user_id,memory.memory_id),taxonomy.version),'preferences');
  scheduleLibrary(f.s,f.jobs,{...f.options,type:'summary'});await f.worker.drain();
  const summaries=rows(f.s,'memory_summaries');assert.equal(summaries.length,4);
  const visible=f.s.derivedMemory.summaries(f.auth.user_id,summaries[0].scope_key);assert.equal(visible.results.length,4);
  for(const summary of visible.results){assert.equal(summary.omitted,0);assert.equal(summary.kind,'derived_summary');assert.equal(summary.independently_fact_checked,false);assert.match(summary.claims[0].quote,/not approved/);}
  f.s.retractMemory(f.auth,memory.memory_id);assert.equal(f.s.derivedMemory.summaries(f.auth.user_id,summaries[0].scope_key).results.length,2);
  assert.equal(rows(f.s,'memory_summaries').filter(s=>s.status==='stale').length,2);
});
test('S-05: existing but unselected source IDs cannot enter claims; unknown categories remain suggestions',async t=>{
  const f=scheduled(t,{model:organizer(input=>({results:input.sources.map(s=>({memory_id:s.memory_id,category:'new-category',tags:[]}))}))});
  scheduleLibrary(f.s,f.jobs,f.options);await f.worker.drain();assert.ok(rows(f.s,'memory_annotations').every(a=>a.category==='uncategorized' && a.suggestion==='new-category'));
  const bad=organizer(()=>({results:[{memory_id:'unselected-existing-source',revision:1,start:0,end:1,quote:'x'}]}));
  scheduleLibrary(f.s,f.jobs,{...f.options,organizer:bad,type:'summary'});
  const worker=new MemoryWorker(f.s,f.jobs,bad);assert.equal((await worker.runOne()).state,'review_required');assert.equal(rows(f.s,'memory_summaries').length,0);
});

test('S-04 L-10: unique exact quotes resolve Unicode offsets locally without changing source text',async t=>{
  const f=fixture(t),memory=f.save('磁盘 😀 容量为 200 GB，不是 2 TB。');
  const model=organizer(input=>({results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision,start:0,end:Buffer.byteLength(s.content),quote:s.content}))}));
  const jobs=new MemoryJobs(f.s);scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy,type:'summary',periods:['daily'],includeOpen:true});
  assert.equal((await new MemoryWorker(f.s,jobs,model).runOne()).state,'succeeded');
  const claim=f.s.memorySummaries(f.auth,{scope:'user'}).results[0].claims[0];
  assert.equal(claim.quote,memory.content);assert.equal(claim.end,memory.content.length);assert.equal(claim.span_resolution,'unique_exact_quote');
  assert.equal(claim.reported_source_span.end,Buffer.byteLength(memory.content));assert.equal(claim.independently_fact_checked,false);
  assert.equal(f.s.memoryDetail(f.auth,memory.memory_id).memory.content,memory.content);
});

test('S-04 S-05: partial short atoms, ambiguous quotes, changed quotes and wrong revisions remain rejected',async t=>{
  for(const scenario of ['partial','ambiguous','changed','revision']){
    const f=fixture(t),content=scenario==='ambiguous'?'x'.repeat(1100)+' repeated phrase repeated phrase':'Opening the port was suggested, but is not authorized.';
    f.save(content);
    const model=organizer(input=>({results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision+(scenario==='revision'?1:0),start:0,end:10,
      quote:scenario==='partial'?'Opening the port':scenario==='ambiguous'?'repeated phrase':scenario==='changed'?'Opening the port is authorized.':s.content}))}));
    const jobs=new MemoryJobs(f.s);scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy,type:'summary',periods:['daily'],includeOpen:true});
    assert.equal((await new MemoryWorker(f.s,jobs,model).runOne()).state,'review_required',scenario);
    assert.equal(f.s.memorySummaries(f.auth,{scope:'user'}).results.length,0,scenario);
  }
});

test('S-04 S-08 Q-04: omitted sources remain explicit and bounded instead of implying complete summary coverage',async t=>{
  const f=fixture(t),memories=Array.from({length:103},(_,n)=>f.save(`Synthetic coverage source ${n}; the decision is still pending.`));
  const model=organizer(input=>({results:input.sources.filter(s=>s.memory_id===memories[0].memory_id).map(s=>({memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content}))}));
  const jobs=new MemoryJobs(f.s),plan=scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy,type:'summary',periods:['daily'],includeOpen:true});
  assert.equal(jobs.get(plan.jobs[0]).metadata.prompt_version,'grounded-extractive-v5');
  assert.equal((await new MemoryWorker(f.s,jobs,model).runOne()).state,'succeeded');
  const result=f.s.memorySummaries(f.auth,{scope:'user'}).results[0];
  assert.equal(result.coverage_status,'partial');assert.equal(result.selected_source_count,1);assert.equal(result.omitted_source_count,102);
  assert.equal(result.omitted_sources.length,100);assert.equal(result.omitted_sources_truncated,true);
  assert.ok(result.omitted_sources.every(source=>source.revision===1 && source.memory_id!==memories[0].memory_id));
  assert.equal(result.coverage,103);assert.equal(result.omitted,102);
  assert.equal(result.independently_fact_checked,false);
  const full=organizer(undefined,{profile_revision:'full-coverage-fixture'});
  scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:full,taxonomy,type:'summary',periods:['daily'],includeOpen:true});
  assert.equal((await new MemoryWorker(f.s,jobs,full).runOne()).state,'succeeded');
  const complete=f.s.memorySummaries(f.auth,{scope:'user'}).results[0];
  assert.equal(complete.coverage_status,'complete');assert.equal(complete.selected_source_count,103);assert.equal(complete.omitted_source_count,0);
  assert.equal(complete.claims.length,100);assert.equal(complete.claims_truncated,true);assert.deepEqual(complete.omitted_sources,[]);
});

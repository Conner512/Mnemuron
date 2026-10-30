import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,organizer,profile,taxonomy} from './helpers/memory-models.mjs';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {MemoryWorker,scheduleLibrary} from '../lib/memory-jobs/worker.mjs';

const longText=n=>'Synthetic source '+n+': '+'ordinary observation '.repeat(180)+'最终决定：保留 17.9.8，不部署 17.12.3。';
const limits={...profile().limits,input_bytes:8500,input_tokens:8500};
const response=(seen,input)=>{seen.push(input.sources.map(source=>({id:source.memory_id,content:source.content})));
  return {results:input.sources.map(source=>({memory_id:source.memory_id,revision:source.revision,start:0,end:source.content.length,quote:source.content}))};};
const plan=(f,jobs,model)=>scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy,type:'summary',periods:['daily'],includeOpen:true});
const claims=f=>f.s.db.prepare('SELECT claim_json FROM memory_summary_claims ORDER BY ordinal').all().map(row=>JSON.parse(row.claim_json));

test('whole-source batches shrink to the complete request budget without losing long Chinese qualifications or source coverage',async t=>{
  const f=fixture(t),saved=[f.save(longText(1)),f.save(longText(2))],seen=[],model=organizer(input=>response(seen,input),{limits}),jobs=new MemoryJobs(f.s);
  const scheduled=plan(f,jobs,model);assert.equal(scheduled.jobs.length,1);
  const result=await new MemoryWorker(f.s,jobs,model).runOne();assert.equal(result.state,'succeeded');assert.equal(result.processed,2);assert.equal(seen.length,2);
  assert.deepEqual(seen.flat().map(source=>source.id),saved.map(memory=>memory.memory_id));assert.deepEqual(seen.flat().map(source=>source.content),saved.map(memory=>memory.content));
  assert.deepEqual(claims(f).map(claim=>claim.quote),saved.map(memory=>memory.content));
  const summary=f.s.db.prepare('SELECT coverage,omitted FROM memory_summaries').get();assert.equal(summary.coverage,2);assert.equal(summary.omitted,0);
  assert.equal(f.s.db.prepare('SELECT reserved_calls FROM memory_model_budget').get().reserved_calls,2);
});

test('a genuinely oversized single source remains explicit and unmodified, while committed earlier chunks survive a larger-budget retry',async t=>{
  const f=fixture(t),saved=[f.save('Synthetic complete first statement.'),f.save('大型来源：'+'原始观察。'.repeat(760)+'最终决定：禁止部署。')],seen=[];
  const model=organizer(input=>response(seen,input),{limits}),jobs=new MemoryJobs(f.s);plan(f,jobs,model);
  const worker=new MemoryWorker(f.s,jobs,model),first=await worker.runOne();assert.equal(first.state,'review_required');assert.equal(first.last_error_code,'INPUT_TOO_LARGE');assert.equal(first.processed,1);
  assert.equal(seen.length,1);assert.deepEqual(seen[0].map(source=>source.id),[saved[0].memory_id]);assert.equal(claims(f).length,0);
  assert.equal(f.s.db.prepare('SELECT content FROM memories WHERE memory_id=?').get(saved[1].memory_id).content,saved[1].content);
  const larger=organizer(input=>response(seen,input),{limits:{...limits,input_bytes:100000,input_tokens:100000}});assert.equal(larger.profile.fingerprint,model.profile.fingerprint);
  f.s.db.prepare("UPDATE memory_jobs SET state='pending',run_after=0 WHERE job_id=?").run(first.job_id);
  const retried=await new MemoryWorker(f.s,jobs,larger).runOne();assert.equal(retried.state,'succeeded');assert.equal(retried.processed,2);
  assert.deepEqual(seen.flat().map(source=>source.id),saved.map(memory=>memory.memory_id));assert.deepEqual(claims(f).map(claim=>claim.quote),saved.map(memory=>memory.content));
});

test('budget exhaustion between dynamically sized batches resumes the remaining source the next day without resending its committed predecessor',async t=>{
  const f=fixture(t),saved=[f.save(longText(1)),f.save(longText(2))],seen=[];let now=Date.now();
  const model=organizer(input=>response(seen,input),{limits:{...limits,daily_requests:1}}),jobs=new MemoryJobs(f.s,{clock:()=>now}),worker=new MemoryWorker(f.s,jobs,model);plan(f,jobs,model);
  const blocked=await worker.runOne();assert.equal(blocked.state,'blocked_budget');assert.equal(blocked.processed,1);assert.equal(seen.length,1);
  assert.equal(claims(f).length,0);now+=86400000;jobs.resumeProfile(model.profile.fingerprint);
  const done=await worker.runOne();assert.equal(done.state,'succeeded');assert.equal(done.processed,2);
  assert.deepEqual(seen.flat().map(source=>source.id),saved.map(memory=>memory.memory_id));assert.equal(claims(f).length,2);
  assert.deepEqual(f.s.db.prepare('SELECT reserved_calls FROM memory_model_budget ORDER BY day').all().map(row=>row.reserved_calls),[1,1]);
});

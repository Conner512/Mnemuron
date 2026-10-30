import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,organizer,profile,taxonomy} from './helpers/memory-models.mjs';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {MemoryWorker,scheduleLibrary} from '../lib/memory-jobs/worker.mjs';
import {consoleRead} from '../lib/console-read.mjs';
import {CONSOLE_READ_SCOPES} from '../../shared/console-contract.mjs';

test('partial summary progress exposes bounded counts, not checkpoint source text or a completed summary',async t=>{
  const f=fixture(t),memory=f.save('合成私有来源。'+'尚未验证，不可部署。'.repeat(330));
  const auth=f.s.authenticate(f.s.issueCredential({userId:f.auth.user_id,label:'Synthetic console reader',deviceId:'synthetic',agentId:'mnemuron-console',agentInstanceId:'synthetic',scopes:CONSOLE_READ_SCOPES}).api_key);
  let calls=0;const model=organizer(input=>{calls++;return {results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content}))};},
    {limits:{...profile().limits,input_bytes:8500,input_tokens:8500,daily_requests:1}}),jobs=new MemoryJobs(f.s);
  scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy,type:'summary',periods:['daily'],includeOpen:true});
  const result=await new MemoryWorker(f.s,jobs,model).runOne();assert.equal(result.state,'blocked_budget');
  const data=await consoleRead(f.s,auth,'memory-processing',{memory_id:memory.memory_id,revision:1}),job=data.jobs.items[0];
  assert.equal(job.item_state,'partial');assert.equal(job.segment_processed,1);assert.ok(job.segment_total>1);assert.equal(job.segment_results_published,false);assert.equal(data.summary.status,'missing');assert.equal(calls,1);
  assert.doesNotMatch(JSON.stringify(data),/checkpoint_json|result_json|尚未验证/);
  f.s.db.prepare("UPDATE memory_job_items SET result_json='legacy malformed' WHERE job_id=?").run(result.job_id);
  const legacy=await consoleRead(f.s,auth,'memory-processing',{memory_id:memory.memory_id,revision:1});assert.equal(legacy.jobs.items[0].segment_total,undefined);assert.equal(calls,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,organizer,taxonomy} from './helpers/memory-models.mjs';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {MemoryWorker,scheduleLibrary} from '../lib/memory-jobs/worker.mjs';
import {ModelError} from '../lib/model-providers/contracts.mjs';

const classify=input=>({results:input.sources.map(s=>({memory_id:s.memory_id,category:'engineering',tags:[]}))});
const budget=store=>store.db.prepare('SELECT SUM(reserved_calls) n FROM memory_model_budget').get().n;
const annotations=store=>store.db.prepare('SELECT COUNT(*) n FROM memory_annotations').get().n;

for(const repair of [false,true])test(`LEASE: a long ${repair?'request plus repair':'request'} retains one fence and publishes once`,async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const f=fixture(t);f.save('Synthetic slow organizer source.');
  let now=1000000,calls=0,renewals=0;
  const jobs=new MemoryJobs(f.s,{clock:()=>now}),renew=jobs.renew.bind(jobs);
  jobs.renew=job=>{renewals++;return renew(job);};
  const advance=duration=>{for(let elapsed=0;elapsed<duration;elapsed+=1000){now+=1000;t.mock.timers.tick(1000);}};
  const model=organizer(input=>{
    calls++;advance(repair?45000:90000);
    assert.equal(jobs.claim('competing-worker'),null,'heartbeat prevents another worker reclaiming the running call');
    return repair&&calls===1?{}:classify(input);
  },{timeouts:{request_ms:120000},retry:{max_attempts:3,base_ms:100,max_ms:1000,repair_once:repair}});
  scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy});
  const result=await new MemoryWorker(f.s,jobs,model).runOne();
  assert.equal(result.state,'succeeded');assert.equal(result.attempt_count,1);assert.equal(result.fence,1);
  assert.equal(calls,repair?2:1);assert.equal(budget(f.s),calls);assert.equal(annotations(f.s),1);
  assert.ok(renewals>1,'the request outlasted the original lease');
  const stopped=renewals;advance(90000);assert.equal(renewals,stopped,'completion clears its heartbeat');
});

test('LEASE: an event-loop stall records expiry and stops at the configured attempt limit',async t=>{
  const f=fixture(t);f.save('Synthetic stalled organizer source.');
  let now=1000000,calls=0;
  // Jump only the injected lease clock: no timer can run during this simulated event-loop stall.
  const model=organizer(input=>{calls++;now+=61000;return classify(input);},{timeouts:{request_ms:120000}});
  const jobs=new MemoryJobs(f.s,{clock:()=>now}),worker=new MemoryWorker(f.s,jobs,model);
  scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy});
  for(let attempt=1;attempt<=3;attempt++){
    const result=await worker.runOne();
    assert.equal(result.attempt_count,attempt);assert.equal(result.state,attempt===3?'dead_letter':'retry_wait');
    assert.equal(result.last_error_code,'LEASE_LOST');assert.equal(result.lease_owner,null);
    assert.equal(result.processed,0);now=result.run_after+1;
  }
  assert.equal(await worker.runOne(),null);assert.equal(calls,3);assert.equal(budget(f.s),3);assert.equal(annotations(f.s),0);
});

test('LEASE: crashed attempts are bounded even when the old worker never records a failure',async t=>{
  const f=fixture(t);f.save('Synthetic abandoned job.');let now=1000000,calls=0;
  const model=organizer(input=>{calls++;return classify(input);}),jobs=new MemoryJobs(f.s,{clock:()=>now});
  const plan=scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy});
  for(let attempt=1;attempt<=3;attempt++){assert.equal(jobs.claim('crashed-'+attempt).attempt_count,attempt);now+=60001;}
  assert.equal(await new MemoryWorker(f.s,jobs,model).runOne(),null);
  const result=jobs.get(plan.jobs[0]);assert.equal(result.state,'dead_letter');assert.equal(result.last_error_code,'LEASE_LOST');
  assert.equal(result.attempt_count,3);assert.equal(result.lease_owner,null);assert.equal(calls,0);
});

test('LEASE: a late worker failure cannot overwrite a replacement lease or block its profile',async t=>{
  const f=fixture(t);f.save('Synthetic fenced organizer source.');let now=1000000,entered,release;
  const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const model=organizer(async()=>{entered();await gate;throw new ModelError('AUTH_FAILED');});
  const jobs=new MemoryJobs(f.s,{clock:()=>now}),worker=new MemoryWorker(f.s,jobs,model,{workerId:'old-worker'});
  const plan=scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy});
  const pending=worker.runOne();await started;now+=60001;
  const replacement=jobs.claim('replacement-worker',{maxAttempts:3});assert.equal(replacement.fence,2);
  release();await pending;
  const result=jobs.get(plan.jobs[0]);assert.equal(result.state,'leased');assert.equal(result.lease_owner,'replacement-worker');
  assert.equal(result.fence,2);assert.equal(result.last_error_code,null);assert.equal(annotations(f.s),0);
  assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM memory_profile_state').get().n,0);
});

test('LEASE: cancellation during an invalid response prevents the provider repair call',async t=>{
  const f=fixture(t);f.save('Synthetic cancelled repair.');let calls=0,jobId;
  const jobs=new MemoryJobs(f.s),model=organizer(()=>{calls++;jobs.cancel(jobId);return {};},
    {retry:{max_attempts:3,base_ms:100,max_ms:1000,repair_once:true}});
  jobId=scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy}).jobs[0];
  const result=await new MemoryWorker(f.s,jobs,model).runOne();
  assert.equal(result.state,'cancelled');assert.equal(calls,1);assert.equal(budget(f.s),1);assert.equal(annotations(f.s),0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,organizer,taxonomy} from './helpers/memory-models.mjs';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {MemoryWorker,scheduleLibrary} from '../lib/memory-jobs/worker.mjs';
import {calendarWindow} from '../lib/memory-jobs/windows.mjs';
import {ModelError} from '../lib/model-providers/contracts.mjs';

const output=input=>({results:input.sources.map(s=>({memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content}))});
const options=(f,model)=>({userId:f.auth.user_id,organizer:model,taxonomy,type:'summary',periods:['daily'],includeOpen:true});

test('SUMMARY-ORDER: retrying an older period snapshot cannot replace a newer published snapshot',async t=>{
  const f=fixture(t);let now=Date.now(),calls=0;
  const first=f.save('Synthetic first source in one daily snapshot.');
  const model=organizer(input=>{
    if(++calls===1)throw new ModelError('NETWORK_ERROR');
    return output(input);
  });
  const jobs=new MemoryJobs(f.s,{clock:()=>now}),worker=new MemoryWorker(f.s,jobs,model);
  const plan=options(f,model),older=scheduleLibrary(f.s,jobs,plan).jobs[0];
  assert.equal((await worker.runOne()).state,'retry_wait');
  const second=f.save('Synthetic later source included in the next daily snapshot.');
  const newer=scheduleLibrary(f.s,jobs,plan).jobs[0];assert.notEqual(newer,older);
  assert.equal(jobs.get(older).created_at,jobs.get(newer).created_at,'queue order is preserved even within one millisecond');
  assert.equal((await worker.runOne()).job_id,newer);assert.equal(jobs.get(newer).state,'succeeded');
  const before=f.s.memorySummaries(f.auth,{scope:'user'}).results;
  assert.equal(before.length,1);assert.equal(before[0].coverage,2);
  now=jobs.get(older).run_after+1;
  assert.equal((await worker.runOne()).job_id,older);assert.equal(jobs.get(older).state,'succeeded');
  const after=f.s.memorySummaries(f.auth,{scope:'user'}).results;
  assert.equal(after.length,1);
  assert.equal(after[0].summary_id,before[0].summary_id,'the newer published snapshot stays current after the older retry completes');
  assert.deepEqual(after[0].claims.map(c=>c.memory_id).sort(),[first.memory_id,second.memory_id].sort());
  const receipt=jobs.get(older),stored=f.s.db.prepare('SELECT * FROM memory_summaries WHERE summary_id=?').get(receipt.result_ref);
  assert.equal(stored.job_id,older);assert.equal(stored.status,'superseded');assert.equal(stored.coverage,1);
  assert.notEqual(receipt.result_ref,jobs.get(newer).result_ref,'each completed job points to its own durable result');
  assert.equal(f.s.db.prepare('SELECT action FROM memory_derived_outbox WHERE summary_id=?').get(receipt.result_ref).action,'hide');
  assert.equal(jobs.enqueue({type:'summary',userId:receipt.user_id,scope:receipt.scope_key,profile:receipt.profile,metadata:receipt.metadata,items:jobs.items(receipt),highwater:receipt.highwater}),older);
  assert.deepEqual(jobs.get(older),receipt,'repeating the frozen request leaves its receipt unchanged');
  assert.deepEqual(scheduleLibrary(f.s,jobs,plan).jobs,[newer]);assert.equal(await worker.runOne(),null);
  assert.equal(calls,3);
});

test('SUMMARY-ORDER: later snapshots replace earlier completed snapshots in the usual order',async t=>{
  const f=fixture(t),now=Date.now(),model=organizer(),jobs=new MemoryJobs(f.s,{clock:()=>now}),worker=new MemoryWorker(f.s,jobs,model),plan=options(f,model);
  f.save('Synthetic earlier completed daily input.');const older=scheduleLibrary(f.s,jobs,plan).jobs[0];
  assert.equal((await worker.runOne()).state,'succeeded');
  f.save('Synthetic next completed daily input.');const newer=scheduleLibrary(f.s,jobs,plan).jobs[0];
  assert.equal(jobs.get(older).created_at,jobs.get(newer).created_at);
  assert.equal((await worker.runOne()).state,'succeeded');
  const current=f.s.memorySummaries(f.auth,{scope:'user'}).results;
  assert.equal(current.length,1);assert.equal(current[0].job_id,newer);assert.equal(current[0].coverage,2);
  assert.equal(f.s.db.prepare('SELECT status FROM memory_summaries WHERE job_id=?').get(older).status,'superseded');
});

for(const change of ['retraction','raw_expiry'])test(`SUMMARY-ORDER: a newer snapshot invalidated by ${change} cannot suppress a valid older result`,async t=>{
  const f=fixture(t);let now=Date.now(),calls=0;
  const first=f.save('Synthetic still-valid older source.');
  const model=organizer(input=>{if(++calls===1)throw new ModelError('NETWORK_ERROR');return output(input);});
  const jobs=new MemoryJobs(f.s,{clock:()=>now}),worker=new MemoryWorker(f.s,jobs,model),plan=options(f,model);
  const older=scheduleLibrary(f.s,jobs,plan).jobs[0];await worker.runOne();
  f.s.appendEvents(f.auth,{event:{event_id:'synthetic-order-source',event_type:'tool_result',content:'Synthetic expiring raw source.',task_id:'synthetic-task',workstream_id:'synthetic-work',session_id:'synthetic-session'}});
  const second=f.save('Synthetic later source that becomes unavailable.',{source_event_ids:['synthetic-order-source']});
  const source=f.s.db.prepare('SELECT * FROM memories WHERE user_id=? AND memory_id=?').get(f.auth.user_id,second.memory_id);
  f.s.revisions.linkEvent(source,f.s.revisions.latest(f.auth.user_id,second.memory_id).revision,'synthetic-order-source');
  const newer=scheduleLibrary(f.s,jobs,plan).jobs[0];assert.equal((await worker.runOne()).job_id,newer);
  assert.equal(f.s.memorySummaries(f.auth,{scope:'user'}).results[0].coverage,2);
  if(change==='retraction')f.s.retractMemory(f.auth,second.memory_id);
  else{
    f.s.db.prepare('UPDATE events SET expires_at=? WHERE user_id=? AND event_id=?').run('2020-01-01T00:00:00Z',f.auth.user_id,'synthetic-order-source');
    assert.equal(f.s.db.prepare('SELECT status FROM memory_summaries WHERE job_id=?').get(newer).status,'current','raw expiry is detected on read without a status trigger');
  }
  assert.equal(f.s.memorySummaries(f.auth,{scope:'user'}).results.length,0);
  now=jobs.get(older).run_after+1;assert.equal((await worker.runOne()).state,'succeeded');
  const current=f.s.memorySummaries(f.auth,{scope:'user'}).results;
  assert.equal(current.length,1);assert.equal(current[0].job_id,older);
  assert.deepEqual(current[0].claims.map(c=>c.memory_id),[first.memory_id]);
});

test('SUMMARY-ORDER: separate owner grants remain current when their jobs finish in reverse order',async t=>{
  const f=fixture(t);let now=Date.now(),calls=0;
  const first=f.save('Synthetic first authorized batch.'),second=f.save('Synthetic second authorized batch.');
  const model=organizer(input=>{if(++calls===1)throw new ModelError('NETWORK_ERROR');return output(input);});
  const jobs=new MemoryJobs(f.s,{clock:()=>now}),worker=new MemoryWorker(f.s,jobs,model);
  const enqueue=(memory,run)=>{const source=f.s.derivedMemory.currentSource(f.auth.user_id,memory.memory_id);
    return jobs.enqueue({type:'summary',userId:f.auth.user_id,scope:source.scope_key,profile:model.profile.fingerprint,items:[source],metadata:{taxonomy,category:'all',window:calendarWindow(Date.parse(first.created_at)),owner_run:run,prompt_version:'grounded-extractive-v5',schema_version:'memory-derived-spans-v2'}});};
  const older=enqueue(first,'synthetic-owner-run-one');assert.equal((await worker.runOne()).state,'retry_wait');
  const newer=enqueue(second,'synthetic-owner-run-two');assert.equal((await worker.runOne()).job_id,newer);
  now=jobs.get(older).run_after+1;assert.equal((await worker.runOne()).state,'succeeded');
  const current=f.s.memorySummaries(f.auth,{scope:'user'}).results;
  assert.equal(current.length,2);assert.ok(current.every(s=>s.coverage_basis==='authorized_batch'&&s.coverage===1));
  assert.deepEqual(current.flatMap(s=>s.claims.map(c=>c.memory_id)).sort(),[first.memory_id,second.memory_id].sort());
});

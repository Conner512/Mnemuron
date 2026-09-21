import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,organizer,taxonomy} from './helpers/memory-models.mjs';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {scheduleLibrary,MemoryWorker} from '../lib/memory-jobs/worker.mjs';

test('ISO-08: lease, chunk, output, accounting and fingerprint retain their authoritative owner',async t=>{
 const f=fixture(t),model=organizer(),jobs=new MemoryJobs(f.s,{concurrency:2});
 const credential=f.s.issueCredential({userId:'synthetic-other',deviceId:'other',agentId:'synthetic',agentInstanceId:'other',scopes:['memory:read','memory:write']});
 const other=f.s.authenticate(credential.api_key);
 f.save('Same synthetic source');f.s.saveMemory(other,{scope:'user',content:'Same synthetic source'});
 const a=scheduleLibrary(f.s,jobs,{userId:f.auth.user_id,organizer:model,taxonomy});
 const b=scheduleLibrary(f.s,jobs,{userId:other.user_id,organizer:model,taxonomy});
 assert.notEqual(a.jobs[0],b.jobs[0]);
 const ja=jobs.claim('worker-a',{userId:f.auth.user_id}),jb=jobs.claim('worker-b',{userId:other.user_id});
 assert.equal(jobs.owns({...ja,user_id:other.user_id}),false);
 assert.equal(jobs.owns({...ja,profile:'another-profile'}),false);
 assert.equal(jobs.owns({...ja,metadata:{...ja.metadata,category:'forged'}}),false);
 const ia=jobs.items(ja)[0],ib=jobs.items(jb)[0];
 assert.throws(()=>jobs.saveChunk(ja,[{...ib,job_id:ja.job_id}],[]),e=>e.code==='INVALID_JOB_ITEM');
 assert.throws(()=>jobs.saveChunk(ja,[ia],[{memory_id:ib.memory_id,category:'engineering',tags:[]}]),e=>e.code==='INVALID_SOURCE_SET');
 assert.equal(jobs.items(ja)[0].state,'pending');
 jobs.reserve(ja,3);jobs.reserve(ja,3);jobs.reserve(jb,3);
 const ledger=f.s.db.prepare('SELECT user_id,reserved_calls FROM memory_owner_model_usage ORDER BY user_id').all();
 assert.equal(ledger.find(r=>r.user_id===f.auth.user_id).reserved_calls,2);
 assert.equal(ledger.find(r=>r.user_id===other.user_id).reserved_calls,1);
 assert.throws(()=>jobs.reserve(jb,3),e=>e.code==='BUDGET_EXHAUSTED');
 assert.equal(f.s.db.prepare('SELECT SUM(reserved_calls) n FROM memory_owner_model_usage').get().n,3);
});

test('ISO-08: two owners run the existing synthetic organizer without cross-owner publication',async t=>{
 const f=fixture(t),model=organizer(),jobs=new MemoryJobs(f.s);
 const cred=f.s.issueCredential({userId:'synthetic-b',deviceId:'b',agentId:'synthetic',agentInstanceId:'b',scopes:['memory:read','memory:write']});
 const b=f.s.authenticate(cred.api_key),ma=f.save('Synthetic identical job content'),mb=f.s.saveMemory(b,{scope:'user',content:ma.content}).memory;
 for(const userId of [f.auth.user_id,b.user_id])scheduleLibrary(f.s,jobs,{userId,organizer:model,taxonomy});
 const results=await new MemoryWorker(f.s,jobs,model).drain();assert.equal(results.length,2);assert.ok(results.every(r=>r.state==='succeeded'));
 for(const [user,id] of [[f.auth.user_id,ma.memory_id],[b.user_id,mb.memory_id]]) {
   const rows=f.s.db.prepare('SELECT memory_id,user_id FROM memory_annotations WHERE user_id=?').all(user);
   assert.equal(rows.length,1);assert.equal(rows[0].memory_id,id);
 }
});

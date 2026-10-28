import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers/memory-models.mjs';
import {OwnerControls,migrateOwner} from '../lib/console/owner.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {ModelError} from '../lib/model-providers/contracts.mjs';
import {MemoryWorker} from '../lib/memory-jobs/worker.mjs';

const model={enabled:true,protocol:'openai_compatible',base_url:'https://synthetic.example.invalid/v1',model:'synthetic-only',profile_revision:'1',daily_requests:20,output_tokens:4096,batch_size:2,egress_approved:true,query_approved:true};
function setup(t){
  const f=fixture(t),{s}=f,user=f.auth.user_id,credential=s.issueCredential({userId:user,label:'Synthetic owner recovery',deviceId:'synthetic',agentId:'mnemuron-console',agentInstanceId:'synthetic',scopes:CONSOLE_WRITE_SCOPES});
  const auth=s.authenticate(credential.api_key),service=s.consoleService;
  s.memoryConfig={...s.memoryConfig,console:{owner_user_id:user,worker_enabled:false}};
  s.memoryTransaction(()=>migrateOwner(s.db,user,{memory:true,capture:false,handoff:false,connections:true}));service.owner=new OwnerControls(service);
  s.db.prepare('INSERT INTO console_models(user_id,kind,revision,config_json,secret_cipher,updated_at) VALUES(?,?,1,?,NULL,?)').run(user,'organizer',JSON.stringify(model),Date.now());
  const act=(action,payload)=>service.execute(auth,{action,payload,operation_id:randomUUID()});
  return {...f,auth,user,service,owner:service.owner,act};
}
async function start(f,kind){const p=await f.act('processing.preview',{kind,limit:2,budget:5});await f.act('processing.start',{run_id:p.run_id,digest:p.digest});return p;}
const output=input=>({data:{results:input.sources.map(s=>input.operation==='summary'?{memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content}:{memory_id:s.memory_id,revision:s.revision,kind:'fact',concepts:['synthetic'],strength:5})}});
const runJob=(f,run)=>f.s.db.prepare('SELECT j.* FROM memory_jobs j JOIN owner_processing_jobs o ON o.job_id=j.job_id WHERE o.run_id=?').get(run.run_id);

test('OWNER-RECOVERY: a retry delay in one channel does not prevent another ready channel progressing',async t=>{
  const f=setup(t);let now=Date.now();f.s.memoryJobs.clock=()=>now;
  const sent=[],provider=f.service.models.provider.bind(f.service.models);
  f.service.models.provider=(...args)=>{const p=provider(...args);p.generateStructured=async(input,schema,{reserve})=>{
    reserve();sent.push(input.operation);
    if(sent.length===1)throw new ModelError('RATE_LIMITED',{retryAfterMs:60000});
    return output(input);
  };return p;};
  await f.act('features.save',{expected_revision:0,flags:{processing:true,summary:true,traits:true}});
  const memory=f.save('Synthetic independent-channel recovery source.');
  const summary=await start(f,'summary'),traits=await start(f,'traits');
  await f.service.tick();assert.deepEqual(sent,['summary']);
  const job=runJob(f,summary);
  assert.equal(job.state,'retry_wait');assert.equal(job.run_after,now+60000);
  await f.service.tick();
  assert.equal(f.owner.run(f.user,traits.run_id).state,'completed','a future retry deadline is not active work and cannot monopolize owner ticks');
  assert.deepEqual(sent,['summary','traits']);assert.equal(f.s.traits.get(f.user,memory.memory_id).kind,'fact');
  assert.equal(f.owner.run(f.user,summary.run_id).used,1,'skipping a future retry does not reserve another model call');
  await f.service.tick();assert.deepEqual(sent,['summary','traits']);assert.equal(runJob(f,summary).attempt_count,1);
  assert.equal(f.owner.run(f.user,summary.run_id).state,'running','a waiting job is not falsely marked completed');
  now=job.run_after;await f.service.tick();
  assert.deepEqual(sent,['summary','traits','summary']);assert.equal(f.owner.run(f.user,summary.run_id).state,'completed');
  assert.equal(runJob(f,summary).attempt_count,2);assert.equal(f.owner.run(f.user,summary.run_id).used,2);
});

test('OWNER-RECOVERY: choosing a ready run does not bypass an active lease or the global concurrency limit',async t=>{
  const f=setup(t);const sent=[],provider=f.service.models.provider.bind(f.service.models);
  f.service.models.provider=(...args)=>{const p=provider(...args);p.generateStructured=async(input,schema,{reserve})=>{reserve();sent.push(input.operation);return output(input);};return p;};
  await f.act('features.save',{expected_revision:0,flags:{processing:true,summary:true,traits:true}});f.save('Synthetic leased processing source.');
  const summary=await start(f,'summary'),traits=await start(f,'traits'),r=f.owner.run(f.user,summary.run_id);
  const lease=f.s.memoryJobs.claim('synthetic-other-worker',{userId:f.user,profile:r.profile,runId:r.run_id});
  assert.ok(lease);assert.equal(f.s.memoryJobs.concurrency,1);
  await f.service.tick();assert.deepEqual(sent,[]);assert.equal(f.s.memoryJobs.owns(lease),true);
  assert.equal(runJob(f,traits).state,'pending');assert.equal(runJob(f,traits).attempt_count,0);
  assert.equal(f.owner.run(f.user,traits.run_id).used,0);assert.notEqual(f.owner.run(f.user,summary.run_id).state,'completed');
  await f.act('processing.pause',{run_id:summary.run_id});await f.service.tick();
  assert.deepEqual(sent,['traits']);assert.equal(f.owner.run(f.user,traits.run_id).state,'completed');
  assert.equal(f.owner.run(f.user,summary.run_id).state,'paused');
});

test('OWNER-RECOVERY: ticks settle committed terminal jobs without replaying calls or misreporting failed batches',async t=>{
  for(const succeeds of [true,false]){
    const f=setup(t);let calls=0;const provider=f.service.models.provider.bind(f.service.models);
    f.service.models.provider=(...args)=>{const p=provider(...args);p.generateStructured=async(input,schema,{reserve})=>{reserve();calls++;if(!succeeds)throw new ModelError('HTTP_REJECTED');return output(input);};return p;};
    await f.act('features.save',{expected_revision:0,flags:{processing:true,summary:true}});f.save('Synthetic terminal outcome '+succeeds);
    const preview=await start(f,'summary'),r=f.owner.run(f.user,preview.run_id),model=f.service.models.provider(f.user,'organizer',{runId:r.run_id});
    await new MemoryWorker(f.s,f.s.memoryJobs,model,{userId:f.user,profileFilter:r.profile,runId:r.run_id}).runOne();
    assert.equal(f.owner.run(f.user,r.run_id).state,'queued','simulate interruption after the job commits and before the run settles');
    assert.equal(runJob(f,preview).state,succeeds?'succeeded':'blocked_config');
    await f.service.tick();assert.equal(f.owner.run(f.user,r.run_id).state,succeeds?'completed':'blocked');
    assert.equal(calls,1);assert.equal(f.owner.run(f.user,r.run_id).used,1);
  }
});

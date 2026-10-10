import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {organizer} from './helpers/memory-models.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {MemoryWorker,scheduleLibrary,outputSchema} from '../lib/memory-jobs/worker.mjs';

async function setup(t,reply){
 const f=await memoryFixture(t),s=f.store,user=f.a.auth.user_id;
 const c=s.issueCredential({userId:user,label:'Synthetic console',deviceId:'synthetic',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES});
 const owner={...c,auth:s.authenticate(c.api_key)},calls=[];
 const model=organizer(async input=>{calls.push(input);return reply?await reply(input,f):{results:input.sources.map(x=>({memory_id:x.memory_id,category:'technical',tags:['synthetic']}))};});
 s.consoleService.models.provider=()=>model;
 const act=(action,payload)=>f.request('POST','/v1/console/action',{action,payload,operation_id:randomUUID()},owner);
 const tax=()=>s.consoleService.features.read(owner.auth,'taxonomy',{});
 const edit=(payload)=>act('category.rename',{category:'technical',label:'Cooking',expected_revision:tax().revision,...payload});
 const create=async()=>{const r=await act('memory.create',{scope:'user',content:'Synthetic source for category semantics',sensitivity:'public'});assert.equal(r.status,200);return r.body.memory_id;};
 const schedule=()=>scheduleLibrary(s,s.memoryJobs,{userId:user,organizer:model,taxonomy:s.consoleService.taxonomy(user)});
 const worker=new MemoryWorker(s,s.memoryJobs,model,{userId:user,profileFilter:model.profile.fingerprint});
 return Object.assign(f,{s,user,owner,model,calls,act,tax,edit,create,schedule,worker});
}

test('Names and descriptions are authoritative; stable IDs and enum constrain the simulated model',async t=>{
 const f=await setup(t);await f.create();
 assert.equal((await f.edit({description:'Food preparation and recipes; exclude computing.'})).status,200);
 const job=f.schedule().jobs[0];assert.equal((await f.worker.runOne()).state,'succeeded');
 const input=f.calls[0],definition=input.category_definitions.find(c=>c.id==='technical');
 assert.equal(definition.label,'Cooking');assert.equal(definition.description,'Food preparation and recipes; exclude computing.');
 assert.doesNotMatch(definition.description,/Technical mechanisms/);
 assert.equal(f.s.memoryJobs.get(job).metadata.prompt_version,'grounded-classification-v4');
 assert.deepEqual(outputSchema('classification',[{memory_id:'synthetic'}],{categories:f.tax().categories}).properties.results.items.properties.category.enum,f.tax().categories);
 assert.equal(f.s.db.prepare('SELECT category FROM memory_annotations WHERE taxonomy_version=?').get(f.tax().version).category,'technical');
});

test('Name-only edits drop default meaning; definition edits and stale revisions preserve old assignments',async t=>{
 const f=await setup(t),id=await f.create();
 await f.act('memory.classify',{memory_id:id,revision:1,category:'technical'});
 const before=f.tax(),rows=f.s.db.prepare('SELECT * FROM memories').all();
 const renamed=await f.edit({});assert.equal(renamed.body.change_kind,'name');
 assert.equal(f.tax().definitions.find(c=>c.id==='technical').description,'');
 assert.equal(f.s.consoleService.meta(f.owner.auth,{memory_id:id}).category,'technical');
 assert.equal((await f.edit({description:'Gardening knowledge; excludes cooking.'})).body.change_kind,'definition');
 assert.equal((await f.edit({expected_revision:before.revision,label:'Stale'})).status,409);
 assert.equal(f.tax().labels.technical,'Cooking');
 assert.deepEqual(f.s.db.prepare('SELECT * FROM memories').all(),rows);
 assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM memory_jobs').get().n,0);
});

test('Queued and cached work cannot publish after a rename; explicit retry gets fresh definitions',async t=>{
 const f=await setup(t);await f.create();await f.create();const old=f.schedule().jobs[0];
 const leased=f.s.memoryJobs.claim('synthetic-old',{userId:f.user,profile:f.model.profile.fingerprint}),items=f.s.memoryJobs.items(leased);
 f.s.memoryJobs.saveChunk(leased,[items[0]],[{memory_id:items[0].memory_id,category:'technical',tags:[]}]);
 await f.edit({label:'Travel',description:'Trips and itineraries.'});
 assert.equal(f.s.memoryJobs.get(old).state,'blocked_config');
 // Even an operator resuming the profile cannot revive a stale cached definition.
 f.s.memoryJobs.resumeProfile(f.model.profile.fingerprint);
 assert.equal((await f.worker.runOne()).state,'blocked_config');assert.equal(f.calls.length,0);
 assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM memory_annotations').get().n,0);
 const retried=await f.act('jobs.retry',{job_id:old});assert.equal(retried.status,200);assert.equal(retried.body.status,'rescheduled');
 assert.equal((await f.worker.runOne()).state,'succeeded');assert.equal(f.calls[0].category_definitions.find(c=>c.id==='technical').label,'Travel');
 assert.equal(f.s.memoryJobs.get(old).state,'cancelled');
});

test('An in-flight rename rejects the late simulated response and makes no history changes',async t=>{
 let f;f=await setup(t,async input=>{const changed=await f.edit({label:'Plants',description:'Plant care only.'});assert.equal(changed.status,200);return {results:input.sources.map(x=>({memory_id:x.memory_id,category:'technical',tags:[]}))};});
 await f.create();const before=f.s.db.prepare('SELECT * FROM memories').all();f.schedule();
 assert.equal((await f.worker.runOne()).state,'blocked_config');
 assert.equal(f.s.db.prepare('SELECT COUNT(*) n FROM memory_annotations').get().n,0);
 assert.deepEqual(f.s.db.prepare('SELECT * FROM memories').all(),before);
});

test('Manual classification during a request wins and stale source output is rejected',async t=>{
 let f;f=await setup(t,async input=>{const r=await f.act('memory.classify',{memory_id:input.sources[0].memory_id,revision:1,category:'preferences'});assert.equal(r.status,200);return {results:input.sources.map(x=>({memory_id:x.memory_id,category:'technical',tags:[]}))};});
 const id=await f.create();f.schedule();assert.equal((await f.worker.runOne()).state,'stale');
 assert.equal(f.s.consoleService.meta(f.owner.auth,{memory_id:id}).category,'preferences');
});

test('Legacy jobs lacking a definition snapshot stop before any simulated model call',async t=>{
 const f=await setup(t),id=await f.create(),source=f.s.derivedMemory.currentSource(f.user,id);
 const job=f.s.memoryJobs.enqueue({type:'classification',userId:f.user,scope:source.scope_key,profile:f.model.profile.fingerprint,items:[source],metadata:{taxonomy:f.s.consoleService.taxonomy(f.user),category:'uncategorized',window:null,prompt_version:'grounded-classification-v2'}});
 assert.equal((await f.worker.runOne()).last_error_code,'STALE_TAXONOMY');assert.equal(f.calls.length,0);
 const listed=await f.request('GET','/v1/console/jobs',undefined,f.owner);assert.equal(listed.body.jobs.find(j=>j.job_id===job).stale_taxonomy,true);
 const retry=await f.act('jobs.retry',{job_id:job});assert.equal(retry.body.status,'rescheduled');
 assert.equal((await f.worker.runOne()).state,'succeeded');assert.equal(f.calls.length,1);
});

test('Custom descriptions survive legacy ID editing and delete/undo, and remain owner scoped',async t=>{
 const f=await setup(t);let r=await f.act('category.create',{label:'My subject',description:'Synthetic custom boundary',expected_revision:f.tax().revision});assert.equal(r.status,200);const id=r.body.category;
 const save=await f.act('taxonomy.save',{categories:[...f.tax().categories,'extra'],expected_revision:f.tax().revision});assert.equal(save.status,200);assert.equal(f.tax().descriptions[id],'Synthetic custom boundary');
 const version=f.tax().version;await f.act('taxonomy.save',{categories:f.tax().categories,expected_revision:f.tax().revision});assert.notEqual(f.tax().version,version,'even repeated ID lists cannot revive a historical version');
 assert.equal(f.s.consoleService.features.descriptions(f.other.auth.user_id)[id],undefined);
 const remove=await f.act('category.delete',{category:id,move_to:'uncategorized',expected_revision:f.tax().revision});assert.equal(remove.status,200);
 const undo=await f.act('memory.organize_undo',{batch_id:remove.body.batch_id});assert.equal(undo.status,200,JSON.stringify(undo.body));
 assert.equal(f.tax().descriptions[id],'Synthetic custom boundary');
});

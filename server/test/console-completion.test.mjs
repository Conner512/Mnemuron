import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import fs from 'node:fs';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES,CONSOLE_READ_SCOPES} from '../../shared/console-contract.mjs';
import {organizer} from './helpers/memory-models.mjs';
import {MnemuronStore} from '../lib/store.mjs';
import {auditQuery} from '../../shared/console-queries.mjs';

async function fixture(t){
  const f=await memoryFixture(t);
  const key=f.root+'/console.key';fs.writeFileSync(key,randomBytes(32).toString('base64url'),{mode:0o600});f.store.memoryConfig.console={key_file:key};
  const issue=(user,scopes)=>{const c=f.store.issueCredential({userId:user,label:'Synthetic console',deviceId:'synthetic',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes});return {...c,auth:f.store.authenticate(c.api_key)};};
  const owner=issue(f.a.auth.user_id,CONSOLE_WRITE_SCOPES),other=issue(f.other.auth.user_id,CONSOLE_WRITE_SCOPES),reader=issue(owner.auth.user_id,CONSOLE_READ_SCOPES);
  const get=(v,p={},o=owner)=>f.request('GET','/v1/console/'+v+'?'+new URLSearchParams(p),undefined,o);
  const act=(action,payload,o=owner,operation_id=randomUUID())=>f.request('POST','/v1/console/action',{action,payload,operation_id},o);
  const create=async(o=owner)=>{const r=await act('memory.create',{scope:'user',content:'Synthetic '+randomUUID()},o);assert.equal(r.status,200);return r.body.memory_id;};
  return {...f,owner,other,reader,get,act,create};
}

test('Console completion: new read views are owner scoped, strict and available without writes',async t=>{
  const f=await fixture(t);await f.create(f.other);
  for(const view of ['attention','capture-status','model-usage','taxonomy','privacy-defaults','retention','system-health','system-version','backups']){
    const r=await f.get(view,{},f.reader);assert.equal(r.status,200,view+JSON.stringify(r.body));
    assert.equal(r.body.read_only,true,view);assert.ok(!JSON.stringify(r.body).includes(f.other.auth.user_id));
    assert.equal((await f.get(view,{user_id:f.other.auth.user_id})).status,400,view);
  }
  assert.equal((await f.get('attention')).body.counts.memories,0);
  assert.equal((await f.get('backups')).body.status,'not_configured');
});

test('Console completion: bulk operations are bounded, revision checked, per item and idempotent',async t=>{
  const f=await fixture(t),a=await f.create(),b=await f.create(),foreign=await f.create(f.other),op=randomUUID();
  const payload={items:[{memory_id:a,revision:1},{memory_id:b,revision:99},{memory_id:foreign,revision:1}],category:'technical'};
  const r=await f.act('memory.batch_classify',payload,f.owner,op);assert.equal(r.status,200,JSON.stringify(r.body));
  assert.deepEqual(r.body.results.map(x=>x.ok),[true,false,false]);
  assert.equal(r.body.results[1].error_code,'MEMORY_VERSION_CHANGED');assert.equal(r.body.results[2].error_code,'MEMORY_NOT_FOUND');
  assert.deepEqual((await f.act('memory.batch_classify',payload,f.owner,op)).body.results,r.body.results);
  assert.equal((await f.act('memory.batch_retract',{items:[{memory_id:a,revision:1}],reason:'Synthetic'},f.reader)).status,403);
  assert.equal((await f.act('memory.batch_retract',{items:Array.from({length:51},()=>({memory_id:a,revision:1}))})).status,400);
  assert.equal((await f.act('memory.batch_retract',{items:[{memory_id:a,revision:1},{memory_id:a,revision:1}]})).status,400);
  const before=f.store.db.prepare('SELECT * FROM tasks').all();
  assert.equal((await f.act('memory.batch_retract',{items:[{memory_id:a,revision:1}]})).body.results[0].ok,true);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM tasks').all(),before);
});

test('Console completion: taxonomy and privacy preferences cannot affect other owners or grant cloud access',async t=>{
  const f=await fixture(t),m=await f.create();
  let r=await f.act('taxonomy.save',{expected_revision:0,categories:['uncategorized','synthetic']});assert.equal(r.status,200,JSON.stringify(r.body));
  assert.deepEqual((await f.get('taxonomy')).body.categories,['uncategorized','synthetic']);
  assert.ok(!(await f.get('taxonomy',{},f.other)).body.categories.includes('synthetic'));
  assert.equal((await f.act('taxonomy.save',{expected_revision:0,categories:['uncategorized']})).status,409);
  assert.equal((await f.act('taxonomy.save',{expected_revision:1,categories:['bad category']})).status,400);
  assert.equal((await f.act('memory.classify',{memory_id:m,revision:1,category:'synthetic'})).status,200);
  assert.equal((await f.act('taxonomy.save',{expected_revision:1,categories:['uncategorized']})).status,409);
  assert.equal((await f.act('privacy.defaults',{expected_revision:0,sensitivity:'secret',cloud_readable:false})).status,200);
  const secret=await f.create();assert.equal((await f.get('memory-meta',{memory_id:secret})).body.sensitivity,'secret');
  assert.equal((await f.act('privacy.defaults',{expected_revision:1,sensitivity:'public',cloud_readable:true})).status,403);
  await f.act('memory.web_policy',{read_all:true,expected_revision:0});
  assert.equal((await f.act('privacy.defaults',{expected_revision:1,sensitivity:'public',cloud_readable:false})).status,200);
  const privatePublic=await f.create();assert.equal((await f.get('memory-meta',{memory_id:privatePublic})).body.web_allowed,false);
  assert.equal((await f.get('memory-meta',{memory_id:m})).body.sensitivity,'sensitive');
  assert.equal((await f.get('privacy-defaults',{},f.other)).body.sensitivity,'sensitive');
});

test('Console completion: revision pages and diffs preserve Unicode, ownership and exact termination',async t=>{
  const f=await fixture(t),m=(await f.act('memory.create',{scope:'user',content:'A😀中文'.repeat(300),sensitivity:'sensitive'})).body.memory_id;
  await f.act('memory.retract',{memory_id:m,revision:1});
  const versions=await f.get('memory-versions',{memory_id:m,limit:1});assert.equal(versions.body.versions[0].revision,2);assert.equal(versions.body.next_offset,1);
  assert.equal((await f.get('memory-versions',{memory_id:m},f.other)).status,404);
  let p={memory_id:m,revision:1,content_limit:17},text='';do{const r=await f.get('memory-versions',p);assert.equal(r.status,200);text+=r.body.content;p=r.body.next_request;if(!p)assert.equal(r.body.content_complete,true);}while(p);
  assert.equal(text,'A😀中文'.repeat(300));
  assert.equal((await f.get('memory-versions',{memory_id:m,revision:99})).status,404);
});

test('Console completion: new Agent credentials are bounded in scope and replay, rotate and isolate',async t=>{
  const f=await fixture(t),op=randomUUID(),p={label:'Synthetic agent',agent_id:'synthetic-reader',device_id:'synthetic-device',access:'read_write'};
  const r=await f.act('devices.register',p,f.owner,op);assert.equal(r.status,200,JSON.stringify(r.body));
  assert.deepEqual(f.store.authenticate(r.body.api_key).scopes,['memory:read','memory:write','capture:write']);
  assert.equal((await f.act('devices.register',p,f.owner,op)).body.api_key,r.body.api_key);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM console_operations').all()).includes(r.body.api_key));
  f.store.db.prepare('UPDATE console_operations SET created_at=created_at-301000 WHERE user_id=? AND operation_id=?').run(f.owner.auth.user_id,op);
  const expired=await f.act('devices.register',p,f.owner,op);assert.equal(expired.body.secret_expired,true);assert.equal(expired.body.api_key,undefined);
  assert.equal((await f.act('devices.rotate',{credential_id:r.body.credential.credential_id},f.other)).status,404);
  const next=await f.act('devices.rotate',{credential_id:r.body.credential.credential_id});assert.equal(next.status,200);
  assert.throws(()=>f.store.authenticate(r.body.api_key));assert.deepEqual(f.store.authenticate(next.body.api_key).scopes,['memory:read','memory:write','capture:write']);
  assert.equal((await f.act('devices.rotate',{credential_id:f.owner.credential.credential_id})).status,409);
});

test('Console completion: capture and model-usage observations contain only owner metadata',async t=>{
  const f=await fixture(t);const event=(o,content)=>f.store.appendEvents(o.auth,{events:[{event_id:randomUUID(),event_type:'user_message',content,captured_at:new Date().toISOString()}]});
  event(f.a,'OWN PRIVATE BODY');event(f.issue(f.other.auth.user_id,'agent-c'),'FOREIGN PRIVATE BODY');
  const r=await f.get('capture-status');assert.equal(r.status,200);assert.equal(r.body.agents.length,1);assert.equal(r.body.agents[0].events,1);assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE BODY|agent-c/);
  const config={enabled:true,protocol:'openai_compatible',base_url:'https://model.example.invalid/v1',model:'synthetic',profile_revision:'1',daily_requests:10,output_tokens:1024,batch_size:1,sensitivities:['public'],egress_approved:false,query_approved:false};
  assert.equal((await f.act('models.save',{kind:'organizer',expected_revision:0,config})).status,200);
  const profile=f.store.consoleService.models.profile(f.owner.auth.user_id,'organizer',config).fingerprint,day=new Date().toISOString().slice(0,10);
  f.store.db.prepare('INSERT INTO memory_owner_model_usage VALUES(?,?,?,?)').run(f.owner.auth.user_id,profile,day,3);
  const usage=(await f.get('model-usage')).body;assert.equal(usage.models[0].used,3);assert.equal(usage.models[0].remaining,7);assert.equal(usage.cost,null);
  assert.equal((await f.get('model-usage',{},f.other)).body.models[0].used,null);
});

test('Console completion: retention is per owner, future events only and keeps pinned sources/checkpoints',async t=>{
  const f=await fixture(t),global=f.store.getRetention();
  const append=(auth,event_id,extra={})=>f.store.appendEvents(auth,{event:{event_id,event_type:'tool_result',captured_at:'2020-01-01T00:00:00Z',content:'Synthetic retained source'},...extra});
  append(f.a.auth,'old-unexpired',{raw_retention_days:'permanent'});
  assert.equal((await f.act('retention.save',{expected_revision:0,raw_retention_days:7})).status,200);
  assert.equal((await f.get('retention')).body.raw_retention_days,7);
  assert.deepEqual(f.store.getRetention(),global);
  assert.notEqual((await f.get('retention',{},f.other)).body.raw_retention_days,7);
  assert.equal((await f.act('retention.save',{expected_revision:1,raw_retention_days:0})).status,400);
  assert.equal((await f.act('retention.save',{expected_revision:0,raw_retention_days:8})).status,409);
  assert.equal((await f.act('retention.prune',{})).status,400);
  append(f.a.auth,'expired-own');append(f.a.auth,'expired-own-2');append(f.a.auth,'pinned-own');
  append(f.issue(f.other.auth.user_id,'retention-other').auth,'expired-other',{raw_retention_days:1});
  const pinAuth={...f.a.auth,scopes:[...f.a.auth.scopes,'memory:retention']};
  f.store.memorySources.pin(pinAuth,{event_ids:['pinned-own'],pin_id:'synthetic-protection'});
  f.store.appendEvents(f.a.auth,{event:{event_id:'checkpoint-source',event_type:'user_message',content:'Synthetic checkpoint source',session_id:'synthetic-retention-session',project_id:f.alpha.project_id,task_id:f.alpha.task_id,workstream_id:f.alpha.workstreams[0].workstream_id}});
  f.store.createCheckpoint(f.a.auth,'synthetic-retention-session',{task_id:f.alpha.task_id});
  assert.equal(f.store.db.prepare('SELECT expires_at FROM events WHERE event_id=?').get('expired-own').expires_at,'2020-01-08T00:00:00.000Z');
  const settings=f.store.db.prepare('SELECT * FROM settings ORDER BY key').all();
  const before=f.store.db.prepare('SELECT * FROM checkpoints').all();
  assert.ok(before.length>0);
  const r=await f.act('retention.prune',{confirmed:true,batch_size:1});assert.equal(r.status,200);assert.equal(r.body.expired_events,1);assert.equal(r.body.remaining_events,1);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM settings ORDER BY key').all(),settings,'Account cleanup must not overwrite global operator state');
  assert.equal((await f.act('retention.prune',{confirmed:true,batch_size:100})).body.expired_events,1);
  for(const event of ['old-unexpired','pinned-own','expired-other'])assert.notEqual(f.store.db.prepare('SELECT content FROM events WHERE event_id=?').get(event).content,null,event);
  for(const event of ['expired-own','expired-own-2'])assert.equal(f.store.db.prepare('SELECT content FROM events WHERE event_id=?').get(event).content,null,event);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM checkpoints').all(),before);
});

test('Console completion: task reads use explicit own identifiers without Resume or scope changes',async t=>{
  const f=await fixture(t),before=f.store.db.prepare('SELECT * FROM tasks').all();
  for(const view of ['task-branches','task-checkpoints','task-reconciliation']){
    assert.equal((await f.get(view,{task_id:f.alpha.task_id})).status,200,view);
    assert.equal((await f.get(view,{task_id:f.foreign.task_id})).status,404,view);
  }
  const context=await f.get('project-context',{project_id:f.alpha.project_id});assert.equal(context.status,200,JSON.stringify(context.body));
  assert.equal((await f.get('project-context',{project_id:f.foreign.project_id})).status,404);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM tasks').all(),before);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM resumes').get().n,0);
});

test('Console completion: scheduled worker uses the owning account taxonomy without manual scheduling',async t=>{
  const f=await fixture(t),user=f.owner.auth.user_id,service=f.store.consoleService;
  await f.create();await f.create(f.other);await f.act('taxonomy.save',{expected_revision:0,categories:['uncategorized','synthetic']});
  const config={enabled:true,protocol:'openai_compatible',base_url:'https://model.example.invalid/v1',model:'synthetic',profile_revision:'1',daily_requests:10,output_tokens:1024,batch_size:1,sensitivities:['public'],egress_approved:false,query_approved:false};
  await f.act('models.save',{kind:'organizer',expected_revision:0,config});
  const model=organizer(input=>({results:input.sources.map(s=>({memory_id:s.memory_id,category:'synthetic',tags:[]}))}));
  service.models.provider=(owner,kind)=>{assert.equal(owner,user);assert.equal(kind,'organizer');return model;};
  f.store.db.prepare('INSERT INTO console_settings VALUES(?,?,?,?)').run(user,JSON.stringify({schedule_enabled:true,timezone:'UTC',periods:['daily']}),1,Date.now());
  f.store.memoryConfig.console.worker_enabled=true;await service.tick();
  const jobs=f.store.db.prepare('SELECT * FROM memory_jobs WHERE user_id=?').all(user);assert.ok(jobs.length>0);
  assert.ok(jobs.every(j=>JSON.parse(j.metadata_json).taxonomy.version===service.taxonomy(user).version));
  assert.ok(jobs.some(j=>j.state==='succeeded'));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_jobs WHERE user_id=?').get(f.other.auth.user_id).n,0);
});

test('Console completion: audit date filters compare timestamps, reject normalized invalid dates',()=>{
  assert.doesNotThrow(()=>auditQuery({from:'2026-01-01T00:00:00Z',to:'2026-01-01T00:00:00.001Z'}));
  assert.throws(()=>auditQuery({from:'2026-02-30T00:00:00Z'}));
  assert.throws(()=>auditQuery({from:'2026-01-01T00:00:00.001Z',to:'2026-01-01T00:00:00Z'}));
});

test('Console completion: taxonomy changes fence old leases and stale retries without affecting another owner',async t=>{
  const f=await fixture(t),service=f.store.consoleService,model=organizer();service.models.provider=()=>model;
  await f.create();await f.create(f.other);
  const payload={type:'classification',timezone:'UTC',periods:['daily'],include_open:true};
  const a=(await f.act('jobs.schedule',payload)).body.jobs[0],b=(await f.act('jobs.schedule',payload,f.other)).body.jobs[0];
  const lease=f.store.memoryJobs.claim('synthetic-taxonomy',{userId:f.owner.auth.user_id,profile:model.profile.fingerprint});assert.equal(lease.job_id,a);
  assert.equal((await f.act('taxonomy.save',{expected_revision:0,categories:['uncategorized','synthetic']})).status,200);
  assert.equal(f.store.memoryJobs.owns(lease),false);assert.equal(f.store.memoryJobs.get(a).state,'blocked_config');assert.equal(f.store.memoryJobs.get(b).state,'pending');
  assert.equal((await f.act('jobs.retry',{job_id:a})).status,409);
});

test('Console completion: additive preference initialization is repeatable and persists without rewriting memories',async t=>{
  const f=await fixture(t),user=f.owner.auth.user_id;await f.create();
  const before=f.store.db.prepare('SELECT * FROM memories').all();
  await f.act('privacy.defaults',{expected_revision:0,sensitivity:'internal',cloud_readable:false});
  await f.act('retention.save',{expected_revision:0,raw_retention_days:'permanent'});
  await f.act('taxonomy.save',{expected_revision:0,categories:['uncategorized','synthetic']});
  for(let i=0;i<2;i++){
    const reopened=new MnemuronStore(f.databasePath);
    try{assert.equal(reopened.consoleService.features.privacy(user).sensitivity,'internal');assert.equal(reopened.consoleService.features.retention(user).raw_retention_days,'permanent');
      assert.deepEqual(reopened.consoleService.taxonomy(user).categories,['uncategorized','synthetic']);assert.deepEqual(reopened.db.prepare('SELECT * FROM memories').all(),before);
    }finally{reopened.close();}
  }
});

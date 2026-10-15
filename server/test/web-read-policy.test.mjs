import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {fixture as modelFixture,embedder} from './helpers/memory-models.mjs';
import {MemoryJobs} from '../lib/memory-jobs/store.mjs';
import {VectorIndex} from '../lib/vector-stores/index.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {memoryRuntime} from '../lib/memory-runtime.mjs';

// READ-POLICY: the operator-only active-uniform policy opens ACTIVE, non-secret records of the same account
// to ChatGPT. History (superseded/retracted) and secret records keep the legacy per-memory rules.
const chatgpt=f=>f.store.authenticate(f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'web',agentId:'chatgpt-web',agentInstanceId:'web',scopes:['memory:read','resume:read']}).api_key);
const policy=(store,value)=>{store.runtime.agentReadPolicy=value;};
const privacy=(f,m,value)=>f.store.db.prepare('INSERT OR REPLACE INTO memory_privacy VALUES (?,?,?)').run(f.a.auth.user_id,m.memory_id,value);
const grant=(f,m)=>{const {revision,state_hash}=f.store.revisions.latest(f.a.auth.user_id,m.memory_id);f.store.webVisibility.set(f.a.auth,m.memory_id,{allow:true,revision,state_hash});};
const deny=(f,m)=>f.store.webVisibility.keepPrivate(f.a.auth.user_id,m.memory_id,f.store.revisions.latest(f.a.auth.user_id,m.memory_id));

function seed(f){
  const save=(name,sensitivity)=>{const m=f.store.saveMemory(f.a.auth,{scope:'user',content:`Synthetic policy marker ${name}`}).memory;if(sensitivity)privacy(f,m,sensitivity);return m;};
  const r={
    publicActive:save('public','public'),
    grantedActive:save('granted','sensitive'),
    deniedActive:save('denied','sensitive'),
    internalActive:save('internal','internal'),
    defaultActive:save('default'),
    secretActive:save('secret','secret'),
    deniedRetracted:save('denied-retracted','sensitive'),
    secretRetracted:save('secret-retracted','secret'),
    grantedRetracted:save('granted-retracted','internal'),
    deniedOld:save('denied-old','sensitive'),
  };
  grant(f,r.grantedActive);deny(f,r.deniedActive);deny(f,r.deniedRetracted);deny(f,r.deniedOld);
  f.store.retractMemory(f.a.auth,r.deniedRetracted.memory_id,{reason:'Synthetic history'});
  f.store.retractMemory(f.a.auth,r.secretRetracted.memory_id,{reason:'Synthetic history'});
  f.store.retractMemory(f.a.auth,r.grantedRetracted.memory_id,{reason:'Synthetic history'});
  // A local correction: the old denied version becomes history, its replacement inherits the denial and is active.
  r.deniedReplacement={memory_id:f.store.supersedeMemory(f.a.auth,r.deniedOld.memory_id,{content:'Synthetic policy marker denied-new',reason:'Synthetic'}).replacement_memory.memory_id};
  r.foreign=f.store.saveMemory(f.other.auth,{scope:'user',content:'Synthetic policy marker foreign'}).memory;
  f.store.db.prepare('INSERT INTO memory_privacy VALUES (?,?,?)').run(f.other.auth.user_id,r.foreign.memory_id,'public');
  return r;
}
const LEGACY=['publicActive','grantedActive'];
const UNIFORM=['publicActive','grantedActive','deniedActive','internalActive','defaultActive','deniedReplacement'];
const NEVER=['secretActive','deniedRetracted','secretRetracted','grantedRetracted','deniedOld','foreign'];

function readable(f,web,r){
  const all=f.store.queryMemories(web,{query:'Synthetic policy marker',statuses:['active','superseded','retracted'],include_shared:true,limit:50});
  const viaQuery=new Set(all.results.map(m=>m.memory_id));
  const names=Object.keys(r).filter(name=>{
    let detail=true;try{f.store.memoryDetail(web,r[name].memory_id,{include_history:true});}catch(e){assert.equal(e.errorCode,'MEMORY_NOT_FOUND');detail=false;}
    assert.equal(viaQuery.has(r[name].memory_id),detail,`get and search agree for ${name}`);
    assert.equal(f.store.webVisibility.visible(web,r[name].memory_id),detail,`visible() agrees for ${name}`);
    return detail;
  });
  return {names:names.sort(),body:JSON.stringify(all)};
}

test('READ-POLICY-01: default stays per-memory; active-uniform opens only active non-secret records of the account; rollback restores it',async t=>{
  const f=await memoryFixture(t),r=seed(f);
  const denialsBefore=f.store.db.prepare('SELECT * FROM memory_web_denials ORDER BY rowid').all();
  // Default (no config key): identical to the legacy per-memory rule.
  let web=chatgpt(f);assert.equal(web.read_policy,undefined);
  assert.deepEqual(readable(f,web,r).names,[...LEGACY].sort());
  assert.equal((await f.request('GET','/v1/identity',undefined,{api_key:f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'w2',agentId:'chatgpt-web',agentInstanceId:'w2',scopes:['memory:read','resume:read']}).api_key})).body.identity.web_read_policy,'web-memory-visibility-v1');

  policy(f.store,'active_uniform_v1');web=chatgpt(f);
  assert.equal(web.read_policy,'web-memory-active-uniform-v1');
  const uniform=readable(f,web,r);
  assert.deepEqual(uniform.names,[...UNIFORM].sort());
  for(const name of NEVER)assert.ok(!uniform.body.includes(r[name].memory_id),`${name} never leaks`);
  assert.equal(f.store.queryMemories(web,{query:'Synthetic policy marker',limit:50}).visibility_policy,'web-memory-active-uniform-v1');
  // Local agents are unaffected; they always read everything of their own account.
  assert.equal(f.store.queryMemories(f.a.auth,{query:'Synthetic policy marker',statuses:['active','superseded','retracted'],limit:50}).result_count,11);
  // HTTP: the policy is bound at authentication; identity reports it, and secret/history stay hidden.
  const key=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'w3',agentId:'chatgpt-web',agentInstanceId:'w3',scopes:['memory:read','resume:read']}).api_key;
  assert.equal((await f.request('GET','/v1/identity',undefined,{api_key:key})).body.identity.web_read_policy,'web-memory-active-uniform-v1');
  assert.equal((await f.request('GET','/v1/memories/'+r.deniedActive.memory_id,undefined,{api_key:key})).status,200);
  for(const name of ['secretActive','deniedRetracted','foreign'])assert.equal((await f.request('GET',`/v1/memories/${r[name].memory_id}?include_history=true`,undefined,{api_key:key})).status,404,name);
  // A record that leaves the active state goes back under the per-memory rule immediately.
  f.store.retractMemory(f.a.auth,r.deniedActive.memory_id,{reason:'Synthetic'});
  assert.equal(f.store.webVisibility.visible(web,r.deniedActive.memory_id),false);
  // No denial or grant was written or removed by reading under the new policy.
  assert.deepEqual(f.store.db.prepare('SELECT * FROM memory_web_denials ORDER BY rowid').all(),denialsBefore);

  // Rollback: the setting back to per-memory (re-authenticated) restores the legacy result exactly.
  policy(f.store,'chatgpt_per_memory_v1');web=chatgpt(f);assert.equal(web.read_policy,undefined);
  assert.deepEqual(readable(f,web,r).names,[...LEGACY].sort());
});

test('READ-POLICY-02: hybrid/semantic and summaries follow the same rule under active-uniform',async t=>{
  const f=await memoryFixture(t),model=embedder(),backend=new MockVectorStore();
  const index=new VectorIndex(f.store,backend,new Map([[model.profile.fingerprint,model]]));f.store.vectorIndex=index;
  const denied=f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic network router denied active'}).memory;deny(f,denied);
  const history=f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic network router denied history'}).memory;deny(f,history);
  const secret=f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic network router secret'}).memory;privacy(f,secret,'internal');
  const generation=index.begin(model.profile.fingerprint);await index.sync(generation);index.activate(generation);
  f.store.retractMemory(f.a.auth,history.memory_id,{reason:'Synthetic'});privacy(f,secret,'secret');
  await index.sync(generation);
  policy(f.store,'active_uniform_v1');const web=chatgpt(f);
  for(const mode of ['hybrid','semantic']){
    const result=await f.store.searchMemories(web,{query:'network router',mode,statuses:['active','retracted']});
    assert.deepEqual(result.results.map(m=>m.memory_id),[denied.memory_id],mode);
    assert.equal(result.retrieval.degraded,false,mode);
    for(const hidden of [history,secret])assert.ok(!JSON.stringify(result).includes(hidden.memory_id));
  }
});

test('READ-POLICY-03: a summary is readable only when every dependency is readable under the policy',t=>{
  const f=modelFixture(t),active=f.save('Synthetic summary dependency active'),retracted=f.save('Synthetic summary dependency history');
  const jobs=new MemoryJobs(f.s),publish=items=>{const sources=items.map(m=>f.s.derivedMemory.currentSource(f.auth.user_id,m.memory_id));
    const id=jobs.enqueue({type:'summary',userId:f.auth.user_id,scope:sources[0].scope_key,profile:'synthetic',metadata:{taxonomy:{version:'synthetic'},category:'uncategorized',window:{day:items.length}},items:sources});
    f.s.derivedMemory.publishSummary(jobs.get(id),sources,[{memory_id:sources[0].memory_id,revision:sources[0].revision,start:0,end:10,quote:sources[0].content.slice(0,10)}],1000+items.length);};
  const admin={...f.auth,scopes:[...f.auth.scopes,'admin:tasks']};
  for(const m of [active,retracted])f.s.webVisibility.keepPrivate(f.auth.user_id,m.memory_id,f.s.revisions.latest(f.auth.user_id,m.memory_id));
  publish([active]);publish([active,retracted]);
  const reader=()=>f.s.authenticate(f.s.issueCredential({userId:f.auth.user_id,deviceId:'web',agentId:'chatgpt-web',agentInstanceId:'web',scopes:['memory:read']}).api_key);
  assert.equal(f.s.memorySummaries(reader(),{scope:'user'}).results.length,0,'legacy: denied dependencies hide both');
  f.s.runtime.agentReadPolicy='active_uniform_v1';const web=reader();
  assert.equal(f.s.memorySummaries(web,{scope:'user'}).results.length,2,'both depend only on active records');
  f.s.retractMemory(admin,retracted.memory_id,{reason:'Synthetic'});
  const after=f.s.memorySummaries(web,{scope:'user'});
  assert.ok(!JSON.stringify(after).includes(retracted.memory_id),'a summary over a hidden history record is not returned');
  assert.equal(after.results.length,1,'the summary over the active record stays readable');
});

test('READ-POLICY-04: the runtime key accepts only the two named policies; absent means per-memory',()=>{
  const base={config_version:'mnemuron-memory-first-v1',modules:{memory:{enabled:true},handoff:{enabled:true,existing_inflight_policy:'drain_before_disable'}}};
  assert.equal(memoryRuntime(base).agentReadPolicy,'chatgpt_per_memory_v1');
  assert.equal(memoryRuntime({...base,memory:{agent_read_policy:'active_uniform_v1'}}).agentReadPolicy,'active_uniform_v1');
  for(const value of ['all','uniform',true,'ACTIVE_UNIFORM_V1'])assert.throws(()=>memoryRuntime({...base,memory:{agent_read_policy:value}}),e=>e.errorCode==='INVALID_MEMORY_CONFIG');
});

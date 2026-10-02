import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memoryFixture,businessSnapshot} from './helpers/core-memory-fixture.mjs';
import {MnemuronStore} from '../lib/store.mjs';
import {CLOUD_CORE_SCOPES} from '../lib/memory/cloud.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../shared/console-contract.mjs';
import {VectorIndex} from '../lib/vector-stores/index.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {embedder,organizer,taxonomy} from './helpers/memory-models.mjs';
import {scheduleLibrary,MemoryWorker} from '../lib/memory-jobs/worker.mjs';

async function setup(t){
  const f=await memoryFixture(t);
  Object.assign(f.store.runtime,{cloudMemory:true,cloudSubmittedGrant:true});
  const issue=(user,connection)=>{
    const c=f.store.issueCredential({userId:user,deviceId:'synthetic-private',agentId:'chatgpt-web',agentInstanceId:randomUUID(),scopes:CLOUD_CORE_SCOPES});
    c.auth=f.store.authenticate(c.api_key);c.connection=connection;
    f.store.cloudMemory.bind(c.auth,{connection_id:connection,account_id:'synthetic-'+user,security_version:1,allow_submitted_revision_grant:true});return c;
  };
  const writer=issue(f.a.auth.user_id,'a'.repeat(64)),peer=issue(f.a.auth.user_id,'b'.repeat(64)),foreign=issue(f.other.auth.user_id,'c'.repeat(64));
  const act=(action,payload,operation_id=randomUUID())=>f.request('POST','/v1/cloud-memory/operations',{connection_id:writer.connection,action,operation_id,payload},writer);
  const save=(content,cloud_read='keep_private',op)=>act('memory.save',{scope:'user',content,cloud_read},op);
  const policy=value=>f.store.webVisibility.setPolicy(f.a.auth,{read_all:value,expected_revision:f.store.webVisibility.policy(f.a.auth).revision});
  const allow=(id,value)=>f.store.webVisibility.set(f.a.auth,id,{...f.store.webVisibility.inspect(f.a.auth,id),allow:value});
  return {...f,writer,peer,foreign,act,save,policy,allow};
}

for(const readAll of [false,true])test(`explicit private beats read_all=${readAll} for search, detail, peer readers and retries`,async t=>{
  const f=await setup(t);f.policy(readAll);
  const op=randomUUID(),r=await f.save('Synthetic private kestrel network note','keep_private',op);
  assert.equal(r.status,200);assert.equal(r.body.cloud_readable,false);
  assert.equal(r.body.cloud_read_choice,'keep_private');assert.ok(!JSON.stringify(r.body).includes('kestrel'));
  for(const owner of [f.writer,f.peer,f.foreign]){
    assert.equal((await f.request('GET','/v1/memories/'+r.body.memory_id,undefined,owner)).status,404);
    for(const mode of ['lexical','hybrid'])assert.equal((await f.request('POST','/v1/memories/query',{query:'kestrel',mode},owner)).body.result_count,0);
  }
  assert.equal((await f.request('GET','/v1/memories/'+r.body.memory_id)).status,200);
  assert.deepEqual((await f.save('Synthetic private kestrel network note','keep_private',op)).body,r.body);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n,1);
  f.policy(!readAll);assert.equal(f.store.webVisibility.visible(f.writer.auth,r.body.memory_id),false);
  const shared=(await f.save('Synthetic shared kestrel network note','allow_submitted_revision')).body;
  assert.equal(shared.cloud_readable,true);
  assert.equal((await f.request('GET','/v1/memories/'+shared.memory_id,undefined,f.peer)).status,200);
  assert.equal((await f.request('GET','/v1/memories/'+shared.memory_id,undefined,f.foreign)).status,404);
});

test('private correction, local replacement and metadata changes cannot implicitly release a denial',async t=>{
  const f=await setup(t);f.policy(true);
  const initial=(await f.save('Synthetic shared starting point','allow_submitted_revision')).body;
  const correction=await f.act('memory.supersede',{memory_id:initial.memory_id,expected_revision:initial.revision,content:'Synthetic private correction',reason:'Synthetic request',cloud_read:'keep_private'});
  assert.equal(correction.status,200);assert.equal(correction.body.cloud_readable,false);
  const privateId=correction.body.memory_id;
  const replacement=f.store.supersedeMemory(f.a.auth,privateId,{content:'Synthetic local private correction'}).replacement_memory;
  for(const id of [privateId,replacement.memory_id]){
    assert.equal(f.store.webVisibility.visible(f.writer.auth,id),false);
    f.store.db.prepare('INSERT OR REPLACE INTO memory_privacy VALUES(?,?,?)').run(f.a.auth.user_id,id,'public');
    assert.equal(f.store.webVisibility.visible(f.writer.auth,id),false);
  }
  f.allow(privateId,true); // A reviewed allow can clear even a public-classified denial.
  assert.equal(f.store.webVisibility.visible(f.peer.auth,privateId),true);
  f.store.db.prepare('INSERT OR REPLACE INTO memory_privacy VALUES(?,?,?)').run(f.a.auth.user_id,replacement.memory_id,'sensitive');
  assert.throws(()=>f.store.webVisibility.set(f.a.auth,replacement.memory_id,{allow:true,revision:999,state_hash:'stale'}),{errorCode:'MEMORY_VERSION_CHANGED'});
  f.allow(replacement.memory_id,true);
  assert.equal(f.store.webVisibility.visible(f.peer.auth,replacement.memory_id),true);
  f.allow(replacement.memory_id,false);
  assert.equal(f.store.webVisibility.visible(f.peer.auth,replacement.memory_id),false);
  f.store.retractMemory(f.a.auth,replacement.memory_id);
  assert.equal((await f.request('GET','/v1/memories/'+replacement.memory_id,undefined,f.peer)).status,404);
  assert.equal((await f.request('POST','/v1/memories/query',{query:'local',statuses:['active','retracted','superseded']},f.peer)).body.result_count,0);
});

test('private marker failure rolls back memory and receipt; exact retry can safely commit',async t=>{
  const f=await setup(t);f.policy(true);const before=businessSnapshot(f.store),op=randomUUID();
  f.store.db.exec("CREATE TRIGGER synthetic_private_failure BEFORE INSERT ON memory_web_denials BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.ok((await f.save('Synthetic atomic private note','keep_private',op)).status>=400);
  assert.deepEqual(businessSnapshot(f.store),before);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cloud_memory_operations').get().n,0);
  f.store.db.exec('DROP TRIGGER synthetic_private_failure');
  const retry=await f.save('Synthetic atomic private note','keep_private',op);assert.equal(retry.status,200);assert.equal(retry.body.cloud_readable,false);
});

test('legacy private receipts backfill once without rewriting history or revoking reviewed grants',async t=>{
  const f=await setup(t);f.policy(true);
  const hidden=(await f.save('Synthetic legacy private note')).body;
  const allowed=(await f.save('Synthetic reviewed legacy private note')).body;f.allow(allowed.memory_id,true);
  const shared=(await f.save('Synthetic legacy shared note','allow_submitted_revision')).body;
  const corrected=f.store.supersedeMemory(f.a.auth,hidden.memory_id,{content:'Synthetic legacy private descendant'}).replacement_memory;
  // Simulate a pre-fix database: no denials, successful private receipt had read_all visibility.
  f.store.db.exec("DELETE FROM memory_web_denials; DELETE FROM settings WHERE key='cloud_private_denials_v1'; UPDATE cloud_memory_operations SET receipt_json=json_set(receipt_json,'$.cloud_readable',json('true'))");
  const before=businessSnapshot(f.store),receipts=f.store.db.prepare('SELECT receipt_json FROM cloud_memory_operations ORDER BY rowid').all();
  const reopened=new MnemuronStore(f.databasePath);
  try{
    assert.equal(reopened.webVisibility.visible(f.peer.auth,hidden.memory_id),false);
    assert.equal(reopened.webVisibility.visible(f.peer.auth,corrected.memory_id),false);
    assert.equal(reopened.webVisibility.visible(f.peer.auth,allowed.memory_id),true);
    assert.equal(reopened.webVisibility.visible(f.peer.auth,shared.memory_id),true);
    assert.deepEqual(businessSnapshot(reopened),before);
    assert.deepEqual(reopened.db.prepare('SELECT receipt_json FROM cloud_memory_operations ORDER BY rowid').all(),receipts);
    reopened.webVisibility.set(f.a.auth,hidden.memory_id,{...reopened.webVisibility.inspect(f.a.auth,hidden.memory_id),allow:true});
  }finally{reopened.close();}
  const again=new MnemuronStore(f.databasePath);
  try{assert.equal(again.webVisibility.visible(f.peer.auth,hidden.memory_id),true);}finally{again.close();}
});

test('backfill traverses a reviewed ancestor without granting its private replacement; failures roll back',async t=>{
  const f=await setup(t);f.policy(true);
  const parent=(await f.save('Synthetic ancestor private note')).body;
  const child=f.store.supersedeMemory(f.a.auth,parent.memory_id,{content:'Synthetic descendant private note'}).replacement_memory;
  f.allow(parent.memory_id,true);
  f.store.db.exec("DELETE FROM memory_web_denials; DELETE FROM settings WHERE key='cloud_private_denials_v1'; CREATE TRIGGER synthetic_migration_failure BEFORE INSERT ON memory_web_denials BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.throws(()=>new MnemuronStore(f.databasePath),/synthetic failure/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM settings WHERE key='cloud_private_denials_v1'").get().n,0);
  f.store.db.exec('DROP TRIGGER synthetic_migration_failure');
  const reopened=new MnemuronStore(f.databasePath);
  try{
    assert.equal(reopened.webVisibility.visible(f.peer.auth,parent.memory_id),true);
    assert.equal(reopened.webVisibility.visible(f.peer.auth,child.memory_id),false);
  }finally{reopened.close();}
});

test('portable export/import preserves private denial while legacy portable records remain compatible',async t=>{
  const f=await setup(t);f.policy(true);
  const saved=(await f.save('Synthetic portable private note')).body;
  const c=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES});
  const auth=f.store.authenticate(c.api_key),record=f.store.consoleService.export(auth,{}).records.find(r=>r.original_id===saved.memory_id);
  assert.equal(record.cloud_private,true);
  const input={action:'storage.import',operation_id:randomUUID(),payload:{format:'mnemuron-personal-portable-v1',records:[record],confirm_personal_scope:true}};
  const imported=await f.store.consoleService.execute(auth,input);
  assert.equal(imported.created,1);assert.equal(f.store.webVisibility.visible(f.peer.auth,imported.memory_ids[0]),false);
  assert.deepEqual(await f.store.consoleService.execute(auth,input),{...imported,replayed:true});
  const legacy={...record,original_id:'synthetic-legacy-portable',content:'Synthetic ordinary portable note'};delete legacy.cloud_private;
  const normal=await f.store.consoleService.execute(auth,{...input,operation_id:randomUUID(),payload:{...input.payload,records:[legacy]}});
  assert.equal(f.store.webVisibility.visible(f.peer.auth,normal.memory_ids[0]),true);
  await assert.rejects(f.store.consoleService.execute(auth,{...input,operation_id:randomUUID(),payload:{...input.payload,records:[{...legacy,cloud_private:'false'}]}}));
});

test('private sources are excluded from derived summaries and vectors, including a mid-query denial',async t=>{
  const f=await setup(t);f.policy(true);
  const first=(await f.save('Synthetic network private note')).body;
  const shared=(await f.save('Synthetic network shared note','allow_submitted_revision')).body;
  const e=embedder(),backend=new MockVectorStore(),index=new VectorIndex(f.store,backend,new Map([[e.profile.fingerprint,e]]));
  const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);
  for(const mode of ['semantic','hybrid']){
    const result=await index.search(f.peer.auth,{query:'network',mode});
    assert.deepEqual(result.results.map(r=>r.memory_id),[shared.memory_id]);
  }
  const model=organizer();scheduleLibrary(f.store,f.store.memoryJobs,{userId:f.a.auth.user_id,organizer:model,taxonomy,type:'summary',includeOpen:true});
  await new MemoryWorker(f.store,f.store.memoryJobs,model).drain();
  assert.ok(f.store.memorySummaries(f.a.auth,{scope:'user'}).results.length);
  assert.equal(f.store.memorySummaries(f.peer.auth,{scope:'user'}).results.length,0);
  const search=backend.search.bind(backend);backend.search=async(...args)=>{f.allow(shared.memory_id,false);return search(...args);};
  assert.equal((await index.search(f.peer.auth,{query:'network',mode:'hybrid'})).result_count,0);
  assert.equal(f.store.webVisibility.visible(f.peer.auth,first.memory_id),false);
});

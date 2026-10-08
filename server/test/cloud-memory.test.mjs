import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {memoryFixture,businessSnapshot} from './helpers/core-memory-fixture.mjs';
import {MnemuronStore} from '../lib/store.mjs';

async function setup(t){
  const f=await memoryFixture(t);
  Object.assign(f.store.runtime,{cloudMemory:true,cloudSubmittedGrant:true});
  const issue=(user,connection)=>{
    const c=f.store.issueCredential({userId:user,deviceId:'synthetic-cloud',agentId:'chatgpt-web',agentInstanceId:randomUUID(),scopes:['memory:read','resume:read','memory:write']});
    c.auth=f.store.authenticate(c.api_key);c.connection=connection;
    f.store.cloudMemory.bind(c.auth,{connection_id:connection,account_id:'account-'+user,security_version:1,allow_submitted_revision_grant:true});return c;
  };
  const a=issue(f.a.auth.user_id,'a'.repeat(64)),second=issue(f.a.auth.user_id,'b'.repeat(64)),b=issue(f.other.auth.user_id,'c'.repeat(64));
  const act=(action,payload,owner=a,operation_id=randomUUID())=>f.request('POST','/v1/cloud-memory/operations',{connection_id:owner.connection,action,operation_id,payload},owner);
  const get=(operation_id,owner=a)=>f.request('GET','/v1/cloud-memory/operations/'+operation_id+'?connection_id='+owner.connection,undefined,owner);
  const save=(content='Synthetic submitted memory',cloud_read='allow_submitted_revision')=>({content,scope:'user',memory_type:'fact',cloud_read});
  return {...f,a,b,second,act,get,save};
}

test('A-T07/09/10/11/12/16: durable exact receipts, concurrent retries and restart do not duplicate or revive',async t=>{
  const f=await setup(t),op=randomUUID(),payload=f.save('Version 1.2.3, synthetic.');
  const attempts=await Promise.all(Array.from({length:12},()=>f.act('memory.save',payload,f.a,op)));
  for(const r of attempts){assert.equal(r.status,200,JSON.stringify(r.body));assert.deepEqual(r.body,attempts[0].body);}
  const receipt=attempts[0].body;assert.equal(receipt.status,'committed');assert.equal(receipt.saved,true);assert.equal(receipt.capture_mode,'tool_only');
  assert.equal(receipt.evidence_kind,'model_submitted');assert.equal(receipt.revision,1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n,1);
  for(const [table,count] of [['memory_revisions',1],['memory_sources',1],['memory_source_links',1],['memory_processing_outbox',3],['memory_index_outbox',1],['cloud_memory_operations',1]])
    assert.equal(f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,count,table);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM audit_events WHERE target_id=?').get(receipt.memory_id).n,2);
  const childSource=`import {MnemuronStore} from ${JSON.stringify(new URL('../lib/store.mjs',import.meta.url).href)};
    let s='';for await(const c of process.stdin)s+=c;const p=JSON.parse(s),store=new MnemuronStore(p.database);
    try{Object.assign(store.runtime,{cloudMemory:true,cloudSubmittedGrant:true});process.stdout.write(JSON.stringify(store.cloudMemory.execute(store.authenticate(p.key),p.input)));}finally{store.close();}`;
  const crossProcessOp=randomUUID(),runChild=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',childSource],{stdio:['pipe','pipe','pipe'],env:{NODE_NO_WARNINGS:'1'}});let out='';
    child.stdout.on('data',c=>out+=c);child.stderr.resume();child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(out)):reject(new Error('Synthetic child failed: '+code)));
    child.stdin.end(JSON.stringify({database:f.databasePath,key:f.a.api_key,input:{connection_id:f.a.connection,action:'memory.save',operation_id:crossProcessOp,payload:f.save('Synthetic cross-process request')}}));
  });
  const crossProcess=await Promise.all(Array.from({length:4},runChild));for(const r of crossProcess)assert.deepEqual(r,crossProcess[0]);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n,2);
  for(const content of ['Version 1-2-3, synthetic.','Version 1.2.3 synthetic.','Version 1.2.3, synthetic. '])assert.equal((await f.act('memory.save',{...payload,content},f.a,op)).body.error_code,'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.act('memory.save',{...payload,cloud_read:'keep_private'},f.a,op)).status,409);
  const reopened=new MnemuronStore(f.databasePath);Object.assign(reopened.runtime,{cloudMemory:true,cloudSubmittedGrant:true});
  try{assert.deepEqual(reopened.cloudMemory.get(reopened.authenticate(f.a.api_key),f.a.connection,op),receipt);}finally{reopened.close();}
  assert.equal((await f.act('memory.retract',{memory_id:receipt.memory_id,expected_revision:1,reason:'Synthetic retraction'})).status,200);
  assert.deepEqual((await f.get(op)).body,receipt);
  assert.deepEqual((await f.act('memory.save',payload,f.a,op)).body,receipt);
  assert.equal(f.store.revisions.latest(f.a.auth.user_id,receipt.memory_id).status,'retracted');
});

test('A-T08/13/14/15/19/20: ownership, exact versions, preserved originals and final-revision grants',async t=>{
  const f=await setup(t),initial=(await f.act('memory.save',f.save())).body,id=initial.memory_id;
  const detail=await f.request('GET','/v1/memories/'+id,undefined,f.a);assert.equal(detail.status,200);assert.equal(detail.body.source_manifest.evidence_kind,'model_submitted');
  assert.equal(detail.body.source_manifest.independently_fact_checked,false);
  const correction={memory_id:id,expected_revision:1,content:'Corrected synthetic memory',reason:'Requested correction',cloud_read:'allow_submitted_revision'};
  assert.equal((await f.act('memory.supersede',{...correction,expected_revision:99})).body.error_code,'MEMORY_VERSION_CHANGED');
  const updated=await f.act('memory.supersede',correction);assert.equal(updated.status,200,JSON.stringify(updated.body));assert.notEqual(updated.body.memory_id,id);
  assert.equal(f.store.revisions.latest(f.a.auth.user_id,id).content,'Synthetic submitted memory');
  assert.equal(f.store.revisions.latest(f.a.auth.user_id,id).status,'superseded');
  assert.equal(f.store.webVisibility.visible(f.a.auth,id),false);
  assert.equal(f.store.webVisibility.visible(f.a.auth,updated.body.memory_id),true);
  assert.equal((await f.act('memory.supersede',correction)).status,404);
  assert.equal((await f.act('memory.retract',{memory_id:updated.body.memory_id,expected_revision:1,reason:'Done'})).body.memory_status,'retracted');
  assert.equal(f.store.webVisibility.visible(f.a.auth,updated.body.memory_id),false);
  const search=await f.request('POST','/v1/memories/query',{query:'synthetic'},f.a);assert.equal(search.body.result_count,0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n,2);
});

test('A-T01/04/08/17/18/21/24: private, foreign, unbound and revoked destinations fail closed',async t=>{
  const f=await setup(t),op=randomUUID(),saved=(await f.act('memory.save',f.save('Private synthetic','keep_private'),f.a,op)).body;
  assert.equal(saved.cloud_readable,false);assert.equal(JSON.stringify(saved).includes('Private synthetic'),false);
  assert.equal((await f.request('GET','/v1/memories/'+saved.memory_id,undefined,f.a)).status,404);
  for(const owner of [f.second,f.b])assert.equal((await f.get(op,owner)).status,404);
  for(const owner of [f.a,f.second,f.b])assert.equal((await f.act('memory.retract',{memory_id:saved.memory_id,expected_revision:1,reason:'Denied'},owner)).status,404);
  const before=businessSnapshot(f.store);
  for(const changes of [{project_id:f.foreign.project_id,scope:'project'},{project_id:f.alpha.project_id,task_id:f.beta.task_id,scope:'task'},{user_id:f.b.auth.user_id},{agent_id:'mnemuron-console'},{old_memory_ids:[saved.memory_id]},{confirmed:true}]){
    assert.ok((await f.act('memory.save',{...f.save(),...changes})).status>=400);
  }
  assert.deepEqual(businessSnapshot(f.store),before);
  for(const route of ['/v1/memories','/v1/console/action','/v1/events'])assert.equal((await f.request('POST',route,{},f.a)).status,404);
  const readonly=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'readonly',agentId:'chatgpt-web',agentInstanceId:'readonly',scopes:['memory:read','resume:read']});readonly.connection=f.a.connection;
  assert.equal((await f.act('memory.save',f.save(),readonly)).status,403);
  f.store.db.prepare('UPDATE credentials SET revoked_at=? WHERE credential_id=?').run(new Date().toISOString(),f.a.credential.credential_id);
  assert.equal((await f.get(op)).status,401);
});

test('A-T18/20/23 and BASE-T04: gates, atomic grant failures and additive migrations',async t=>{
  const f=await setup(t);f.store.runtime.cloudSubmittedGrant=false;
  assert.equal((await f.act('memory.save',f.save())).body.error_code,'CLOUD_READ_POLICY_DENIED');
  assert.equal((await f.act('memory.save',f.save('Private allowed','keep_private'))).status,200);
  f.store.runtime.cloudSubmittedGrant=true;
  const before=businessSnapshot(f.store);
  f.store.db.exec("CREATE TRIGGER synthetic_grant_failure BEFORE INSERT ON memory_web_grants BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  assert.ok((await f.act('memory.save',f.save())).status>=400);assert.deepEqual(businessSnapshot(f.store),before);
  f.store.db.exec('DROP TRIGGER synthetic_grant_failure');
  const r=(await f.act('memory.save',f.save())).body;
  f.store.db.prepare('INSERT OR REPLACE INTO memory_privacy VALUES(?,?,?)').run(f.a.auth.user_id,r.memory_id,'secret');
  assert.equal(f.store.webVisibility.visible(f.a.auth,r.memory_id),false);
  f.store.runtime.cloudMemory=false;
  assert.equal((await f.act('memory.save',f.save())).body.error_code,'CLOUD_MEMORY_DISABLED');
  const original=f.store.db.prepare('SELECT * FROM memories ORDER BY memory_id').all();
  const reopened=new MnemuronStore(f.databasePath);try{assert.deepEqual(reopened.db.prepare('SELECT * FROM memories ORDER BY memory_id').all(),original);}finally{reopened.close();}
});

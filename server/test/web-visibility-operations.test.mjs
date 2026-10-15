import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {memoryFixture,businessSnapshot} from './helpers/core-memory-fixture.mjs';

test('local grant inventory is bounded, owner isolated, content-free and does not grant history',async t=>{
  const f=await memoryFixture(t),ids=[];
  for(let i=0;i<3;i++) {
    const memory=f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic reviewed memory '+i}).memory;
    const {revision,state_hash}=f.store.webVisibility.inspect(f.a.auth,memory.memory_id);
    f.store.webVisibility.set(f.a.auth,memory.memory_id,{allow:true,revision,state_hash});ids.push(memory.memory_id);
  }
  f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic unapproved history'});
  const before=businessSnapshot(f.store);
  const first=f.store.webVisibility.list(f.a.auth,{limit:2});
  assert.equal(first.grants.length,2);assert.equal(first.content_returned,false);assert.equal(first.selection,'explicit_grants_only');
  const second=f.store.webVisibility.list(f.a.auth,first.next_request);
  assert.equal(second.grants.length,1);assert.equal(second.next_request,null);
  assert.deepEqual([...first.grants,...second.grants].map(r=>r.memory_id),ids.sort());
  assert.equal(f.store.webVisibility.list(f.other.auth).grants.length,0);
  assert.throws(()=>f.store.webVisibility.list({...f.a.auth,scopes:['memory:read']}));
  assert.throws(()=>f.store.webVisibility.list(f.a.auth,{limit:101}));
  assert.ok(!JSON.stringify(first).includes('Synthetic reviewed'));
  assert.deepEqual(businessSnapshot(f.store),before);
  const cli=spawnSync(process.execPath,['server/bin/mnemuron-admin.mjs','memory-web-visibility','--list','--limit','1'],{
    env:{...process.env,MNEMURON_DATABASE_PATH:f.databasePath,MNEMURON_ADMIN_API_KEY:f.a.api_key},encoding:'utf8'});
  assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).grants.length,1);
});

test('account read-all opens internal and sensitive records to ChatGPT, never secret or other accounts, audited and reversible',async t=>{
  const f=await memoryFixture(t);
  const web=f.store.authenticate(f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'web',agentId:'chatgpt-web',agentInstanceId:'web',scopes:['memory:read','resume:read']}).api_key);
  const privacy=f.store.authenticate(f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'privacy',agentId:'test',agentInstanceId:'privacy',scopes:['memory:read','memory:retention']}).api_key);
  const save=(content,sensitivity)=>{const id=f.store.saveMemory(f.a.auth,{scope:'user',content}).memory.memory_id;if(sensitivity)f.store.memorySources.setSensitivity(privacy,id,sensitivity);return id;};
  const plain=save('Synthetic kestrel harbour note'),internal=save('Synthetic kestrel internal note','internal'),secret=save('Synthetic kestrel secret note','secret');
  f.store.saveMemory(f.other.auth,{scope:'user',content:'Synthetic kestrel foreign note'});
  const found=async()=>(await f.store.searchMemories(web,{query:'kestrel',mode:'lexical'})).results.map(r=>r.memory_id).sort();
  assert.deepEqual(await found(),[]);
  assert.deepEqual(f.store.webVisibility.policy(f.a.auth),{read_all:false,revision:0,policy:'web-memory-visibility-v1'});
  assert.throws(()=>f.store.webVisibility.setPolicy(f.a.auth,{read_all:true,expected_revision:1}),{errorCode:'SETTINGS_VERSION_CHANGED'});
  assert.throws(()=>f.store.webVisibility.setPolicy(f.a.auth,{read_all:'yes',expected_revision:0}));
  assert.throws(()=>f.store.webVisibility.setPolicy({...f.a.auth,scopes:['memory:read']},{read_all:true,expected_revision:0}));
  assert.deepEqual(f.store.webVisibility.setPolicy(f.a.auth,{read_all:true,expected_revision:0}),{read_all:true,revision:1,policy:'web-memory-visibility-v1'});
  assert.deepEqual(await found(),[internal,plain].sort());
  assert.equal(f.store.webVisibility.visible(web,secret),false);
  // A correction stays readable without a new grant while read-all is on.
  const corrected=f.store.supersedeMemory(f.a.auth,plain,{content:'Synthetic kestrel harbour note, corrected'}).replacement_memory.memory_id;
  assert.deepEqual(await found(),[corrected,internal].sort());
  assert.equal(f.store.webVisibility.policy(f.other.auth).read_all,false);
  f.store.webVisibility.setPolicy(f.a.auth,{read_all:false,expected_revision:1});
  assert.deepEqual(await found(),[]);
  const audits=f.store.db.prepare("SELECT metadata_json FROM audit_events WHERE action='memory.web_policy' AND user_id=? ORDER BY rowid").all(f.a.auth.user_id).map(r=>JSON.parse(r.metadata_json));
  assert.deepEqual(audits,[{read_all:true,revision:1},{read_all:false,revision:2}]);
});

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

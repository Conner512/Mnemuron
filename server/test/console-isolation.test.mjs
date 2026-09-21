import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
test('ISO-01..04 ISO-11..15 INT-10: account-bound console reads, no admin bypass or exports',async t=>{
 const f=await memoryFixture(t);const a=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'console',agentId:'mnemuron-console',agentInstanceId:'console-A',scopes:['memory:read','resume:read','console:read']});
 const own=f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic isolated console A'}).memory;
 const foreign=f.store.saveMemory(f.other.auth,{scope:'user',content:'Synthetic isolated console B'}).memory;
 for(const view of ['overview','memories','summaries','jobs','storage','connections','audit']) {
  const r=await f.request('GET',`/v1/console/${view}`,undefined,a);assert.equal(r.status,200,view);
  assert.ok(!JSON.stringify(r.body).includes(foreign.memory_id));assert.ok(!JSON.stringify(r.body).includes(f.other.auth.user_id));
 }
 assert.equal((await f.request('GET','/v1/console/memories?user_id='+f.other.auth.user_id,undefined,a)).status,400);
 assert.equal((await f.request('GET','/v1/console/export/../../credentials',undefined,a)).status,404);
 assert.equal((await f.request('GET','/v1/status',undefined,a)).status,404);
 assert.equal((await f.request('POST','/v1/memories',{scope:'user',content:'forbidden'},a)).status,404);
 assert.equal((await f.request('GET',`/v1/memories/${foreign.memory_id}`,undefined,a)).status,404);
 assert.equal((await f.request('GET',`/v1/memories/${own.memory_id}`,undefined,a)).status,200);
});

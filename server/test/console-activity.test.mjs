import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';

// Overview memory flow: 7-day counts of new memories by source and of searches/reads by who made them.
test('attention: memory flow by source and reader, for this account only',async t=>{
  const f=await memoryFixture(t),store=f.store;
  const issue=(agentId,user=f.a.auth.user_id)=>store.authenticate(store.issueCredential({userId:user,deviceId:'d-'+agentId,agentId,agentInstanceId:randomUUID(),scopes:['memory:read','memory:write']}).api_key);
  const gpt=issue('chatgpt-web'),consoleAuth=issue('mnemuron-console'),agent=issue('claude-code'),other=issue('chatgpt-web',f.other.auth.user_id);
  store.saveMemory(gpt,{scope:'user',content:'Synthetic from ChatGPT.',source:'model_submitted'});
  store.saveMemory(consoleAuth,{scope:'user',content:'Synthetic from the console.',source:'console_explicit'});
  store.saveMemory(other,{scope:'user',content:'Synthetic other account.',source:'model_submitted'});
  for(const [auth,n] of [[gpt,3],[agent,2],[consoleAuth,1],[other,5]])for(let i=0;i<n;i++)store.queryMemories(auth,{query:'synthetic'});
  const a=store.consoleService.features.read(f.a.auth,'attention',{}).activity_7d;
  assert.equal(a.window_days,7);
  assert.deepEqual([a.sources.chatgpt,a.sources.console],[1,1]);
  assert.deepEqual([a.uses.chatgpt.search,a.uses.agents.search,a.uses.console.search],[3,2,1]);
});

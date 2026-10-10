import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadonlyCoreClient} from '../src/core-client.mjs';
import {consoleRead} from '../../../server/lib/console-read.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';

test('SEC-00: new multi-account readers cannot inherit an unallocated shared model budget',async()=>{
 const calls=[],client=Object.create(ReadonlyCoreClient.prototype);
 client.config={identity_mode:'multi_account_v1'};client.checkIdentity=async()=>{};
 client.request=async(route,body)=>{calls.push({route,body});return {results:[],retrieval:{mode:body.mode,requested_mode:body.mode,effective_mode:body.mode}};};
 await client.call('mnemuron_search_memories',{query:'synthetic'},{});
 assert.equal(calls[0].body.mode,'lexical');
 const hybrid=await client.call('mnemuron_search_memories',{query:'synthetic',mode:'hybrid'},{});
 assert.equal(calls[1].body.mode,'lexical');assert.equal(hybrid.retrieval.requested_mode,'hybrid');
 assert.equal(hybrid.retrieval.effective_mode,'lexical');assert.equal(hybrid.retrieval.degraded,true);
 assert.equal(hybrid.retrieval.degradation_code,'NOT_CONFIGURED');
 await assert.rejects(client.call('mnemuron_search_memories',{query:'synthetic',mode:'semantic'},{}),e=>e.code==='SEMANTIC_UNAVAILABLE'&&e.degradation_code==='NOT_CONFIGURED');
 assert.equal(calls.length,2);
 client.config.identity_mode='legacy_owner';
 await client.call('mnemuron_search_memories',{query:'synthetic',mode:'hybrid'},{});
 assert.equal(calls[2].body.mode,'hybrid','existing operator-approved legacy retrieval is preserved');
});
test('SEC-00: console search has an explicit no-egress mode while allocation policy is pending',async t=>{
 const f=await memoryFixture(t),credential=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:'no-egress',scopes:['console:read','memory:read','resume:read']});
 f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic no-egress marker'});
 let modelPathCalled=false;f.store.searchMemories=async()=>{modelPathCalled=true;throw new Error('Default console search must not invoke model retrieval');};
 const result=await consoleRead(f.store,f.store.authenticate(credential.api_key),'memories',{query:'synthetic',mode:'lexical'});
 assert.equal(result.retrieval.mode,'lexical');assert.equal(result.results.length,1);assert.equal(modelPathCalled,false);
});
test('console allocation: only self-scoped Core metadata enables personal semantic reads, never tool-supplied identity',async()=>{
 const calls=[],client=Object.create(ReadonlyCoreClient.prototype);client.config={identity_mode:'multi_account_v1'};
 client.checkIdentity=async()=>({personal_retrieval:{configured:true}});
 client.request=async(route,body)=>{calls.push({route,body});return {results:[]};};
 await client.call('mnemuron_search_memories',{query:'synthetic',mode:'semantic'},{});
 assert.deepEqual(calls[0].body,{query:'synthetic',mode:'semantic',personal_model_only:true});
 client.checkIdentity=async()=>({personal_retrieval:{configured:false}});
 await assert.rejects(()=>client.call('mnemuron_search_memories',{query:'synthetic',mode:'semantic',personal_model_only:true},{}),e=>e.code==='SEMANTIC_UNAVAILABLE');
 assert.equal(calls.length,1);
});

test('SEARCH-GW-01: default hybrid is forwarded with a personal allocation guard; explicit lexical stays lexical',async()=>{
 const calls=[],client=Object.create(ReadonlyCoreClient.prototype);client.config={identity_mode:'multi_account_v1'};
 client.checkIdentity=async()=>({personal_retrieval:{configured:true}});
 client.request=async(route,body)=>{calls.push({route,body});return {results:[],retrieval:{}};};
 await client.call('mnemuron_search_memories',{query:'synthetic'},{});
 assert.deepEqual(calls[0].body,{query:'synthetic',mode:'hybrid',personal_model_only:true});
 await client.call('mnemuron_search_memories',{query:'synthetic',mode:'lexical'},{});assert.equal(calls[1].body.mode,'lexical');
 client.checkIdentity=async()=>({personal_retrieval:{configured:false}});
 const fallback=await client.call('mnemuron_search_memories',{query:'synthetic'},{});
 assert.equal(calls[2].body.mode,'lexical');assert.equal(fallback.retrieval.requested_mode,'hybrid');assert.equal(fallback.retrieval.degradation_code,'NOT_CONFIGURED');
});

test('SEARCH-GW-02: saved lexical preference is preserved with and without a personal model',async()=>{
 const client=Object.create(ReadonlyCoreClient.prototype);client.config={identity_mode:'multi_account_v1'};
 for(const configured of [false,true]){
  client.checkIdentity=async()=>({personal_retrieval:{configured,default_mode:'lexical'}});
  client.request=async(route,body)=>{assert.equal(body.mode,'lexical');return {results:[],retrieval:{requested_mode:body.mode,effective_mode:'lexical',degraded:false}};};
  const result=await client.call('mnemuron_search_memories',{query:'synthetic'},{});assert.equal(result.retrieval.requested_mode,'lexical');assert.equal(result.retrieval.degraded,false);
 }
});

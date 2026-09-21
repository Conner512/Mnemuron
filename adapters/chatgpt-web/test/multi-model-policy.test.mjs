import test from 'node:test';
import assert from 'node:assert/strict';
import {ReadonlyCoreClient} from '../src/core-client.mjs';
import {consoleRead} from '../../../server/lib/console-read.mjs';

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
test('SEC-00: console search has an explicit no-egress mode while allocation policy is pending',()=>{
 let args;const auth={user_id:'synthetic-A',agent_id:'mnemuron-console'};
 const store={requireScope(){},searchMemories(principal,body){assert.equal(principal,auth);args=body;return {};}};
 consoleRead(store,auth,'memories',{query:'synthetic'});assert.equal(args.mode,'lexical');
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

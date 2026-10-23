import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayFixture,approveWebMemory} from './fixture.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {MemoryJobs} from '../../../server/lib/memory-jobs/store.mjs';
import {VectorIndex} from '../../../server/lib/vector-stores/index.mjs';
import {MockVectorStore} from '../../../server/test/helpers/vector-mock.mjs';
import {embedder} from '../../../server/test/helpers/memory-models.mjs';

test('WEB-MEM-04: rejected protocol envelopes never execute a core tool',async t=>{
  const core=await memoryFixture(t),f=await gatewayFixture(t,{profile:'readonly',coreFixture:core});
  const token=(await f.exchange(await f.authorize())).data.access_token;
  let calls=0;f.gateway.core.call=async()=>{calls++;return {read_only:true,query:'synthetic',effective_scope:{},results:[],retrieval:{}};};
  for(const extra of [{unexpected:true},{params:{name:'mnemuron_search_memories',arguments:{query:'synthetic'},_meta:'invalid'}}]){
    await fetch(f.gatewayConfig.resource,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'mnemuron_search_memories',arguments:{query:'synthetic'}},...extra})});
  }
  assert.equal(calls,0);
  assert.equal((await f.mcp('tools/call',{name:'mnemuron_search_memories',arguments:{query:'synthetic'}},token)).status,200);
  assert.equal(calls,1);
});

test('WEB-MEM-03/07: emitted SDK schemas expose modes and summaries; real Core paging stays bounded',async t=>{
  const core=await memoryFixture(t),f=await gatewayFixture(t,{profile:'readonly',coreFixture:core,
    mutate:c=>{c.tools.mnemuron_get_summary={required_scope:'memory:read',profile:['readonly']};}});
  const token=(await f.exchange(await f.authorize())).data.access_token;
  const init=await f.mcp('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic',version:'1'}},token);
  assert.match(init.data.result.instructions,/read-only memory/);assert.match(init.data.result.instructions,/not prove/);
  const tools=(await f.mcp('tools/list',undefined,token)).data.result.tools;
  assert.equal(tools.length,5);
  assert.deepEqual(tools.find(t=>t.name==='mnemuron_search_memories').inputSchema.properties.mode.enum,['lexical','hybrid','semantic']);
  const detail=tools.find(t=>t.name==='mnemuron_get_memory');assert.ok(detail.inputSchema.properties.source_offset);assert.ok(detail.inputSchema.properties.revision);
  assert.ok(detail.inputSchema.properties.source_version);
  for(const field of ['source_manifest','revision','next_request','next_source_request'])assert.ok(detail.outputSchema.properties[field],field);
  assert.ok(tools.every(t=>t.outputSchema.type==='object' && t.outputSchema.properties.error && t.annotations.readOnlyHint));
  assert.ok(tools.every(t=>t._meta.securitySchemes[0].type==='oauth2'));
  const memory=core.store.saveMemory(core.a.auth,{scope:'user',content:'合成摘要🙂 '.repeat(500)}).memory;approveWebMemory(core,memory);
  const source=core.store.derivedMemory.currentSource(core.a.auth.user_id,memory.memory_id),jobs=new MemoryJobs(core.store);
  for(let n=0;n<8;n++) {
    const id=jobs.enqueue({type:'summary',userId:core.a.auth.user_id,scope:source.scope_key,profile:'synthetic',metadata:{taxonomy:{version:'synthetic'},category:'uncategorized',window:{day:n}},items:[source]});
    core.store.derivedMemory.publishSummary(jobs.get(id),[source],[{memory_id:memory.memory_id,revision:1,start:0,end:memory.content.length,quote:memory.content}],1000+n);
  }
  let args={scope:'user',limit:20},pages=0;const seen=new Set();
  do {
    const r=await f.mcp('tools/call',{name:'mnemuron_get_summary',arguments:args},token);
    assert.equal(r.status,200);assert.notEqual(r.data.result.isError,true);assert.ok(Buffer.byteLength(JSON.stringify(r.data))<=131072);
    const body=r.data.result.structuredContent;body.results.forEach(s=>seen.add(s.summary_id));args=body.next_request;
    assert.ok(++pages<20);
  }while(args);
  assert.equal(seen.size,8);assert.ok(pages>1);
  const bad=await f.mcp('tools/call',{name:'mnemuron_get_summary',arguments:{scope:'user',cursor:'invalid'}},token);
  assert.equal(bad.data.result.isError,true);assert.equal(bad.data.result.structuredContent.error.code,'INVALID_CURSOR');
});

test('WEB-MEM-03/04: business errors use isError; modes and safe degradation do not claim semantic success',async t=>{
  const core=await memoryFixture(t),f=await gatewayFixture(t,{profile:'readonly',coreFixture:core});
  const token=(await f.exchange(await f.authorize())).data.access_token;
  for(const mode of ['lexical','hybrid','semantic']) {
    const r=await f.mcp('tools/call',{name:'mnemuron_search_memories',arguments:{query:'合成历史偏好',mode}},token);
    assert.equal(r.status,200);
    if(mode==='semantic'){assert.equal(r.data.result.isError,true);assert.equal(r.data.result.structuredContent.error.code,'SEMANTIC_UNAVAILABLE');}
    else {assert.equal(r.data.result.structuredContent.retrieval.requested_mode,mode);assert.equal(r.data.result.structuredContent.retrieval.effective_mode,'lexical');assert.equal(r.data.result.structuredContent.retrieval.degraded,mode==='hybrid');}
  }
  f.gateway.core.call=async()=>{throw new Error('synthetic-private-path provider HTML credential');};
  const failure=await f.mcp('tools/call',{name:'mnemuron_search_memories',arguments:{query:'合成'}},token);
  assert.equal(failure.data.result.isError,true);assert.equal(failure.data.result.structuredContent.error.retryable,true);
  assert.ok(!JSON.stringify([failure.data,f.gatewayLogs]).includes('synthetic-private-path'));
});

test('WEB-MEM-02: SDK forwards source_offset and revision without conflating body pages',async t=>{
  const core=await memoryFixture(t),f=await gatewayFixture(t,{profile:'readonly',coreFixture:core});
  const token=(await f.exchange(await f.authorize())).data.access_token;
  const memory=core.store.saveMemory(core.a.auth,{scope:'user',content:'中文🙂原文'}).memory;
  core.store.db.prepare('DELETE FROM memory_source_links WHERE memory_id=?').run(memory.memory_id);
  for(let i=0;i<45;i++) {
    const id='synthetic-'+i;
    core.store.db.prepare('INSERT INTO memory_sources VALUES (?,?,?,?,?,?,?,?,?,?)').run(core.a.auth.user_id,id,'explicit_memory',null,'hash',1,'available','user','2040-01-01','private-ref');
    core.store.db.prepare('INSERT INTO memory_source_links VALUES (?,?,?,?,?,?,?,?,?)').run(core.a.auth.user_id,memory.memory_id,1,id,0,1,'synthetic','$','utf16_code_units');
  }
  approveWebMemory(core,memory);let args={memory_id:memory.memory_id,content_limit:2},firstContinuation;const sizes=[],ids=[];
  do {
    const r=await f.mcp('tools/call',{name:'mnemuron_get_memory',arguments:args},token);
    assert.notEqual(r.data.result.isError,true);const body=r.data.result.structuredContent;
    assert.equal(body.memory.content,'中文');assert.equal(body.content_complete,false);
    sizes.push(body.source_manifest.sources.length);ids.push(...body.source_manifest.sources.map(s=>s.source_id));args=body.next_source_request;
    firstContinuation ||= args;
  }while(args);
  assert.deepEqual(sizes,[20,20,5]);assert.equal(new Set(ids).size,45);
  core.store.db.prepare('DELETE FROM memory_source_links WHERE memory_id=? AND source_id=?').run(memory.memory_id,'synthetic-0');
  const changed=await f.mcp('tools/call',{name:'mnemuron_get_memory',arguments:firstContinuation},token);
  assert.equal(changed.status,200);assert.equal(changed.data.result.isError,true);
  assert.equal(changed.data.result.structuredContent.error.code,'SOURCE_MANIFEST_CHANGED');
  assert.equal(changed.data.result.structuredContent.error.next_action,'restart_read');
});

test('WEB-MEM-03: SDK preserves the default mode and distinguishes egress, budget and stale-index failures',async t=>{
  const core=await memoryFixture(t),f=await gatewayFixture(t,{profile:'readonly',coreFixture:core});
  const token=(await f.exchange(await f.authorize())).data.access_token,model=embedder();
  const memory=core.store.saveMemory(core.a.auth,{scope:'user',content:'Synthetic network router memory'}).memory;approveWebMemory(core,memory);
  const index=new VectorIndex(core.store,new MockVectorStore(),new Map([[model.profile.fingerprint,model]]));core.store.vectorIndex=index;
  const generation=index.begin(model.profile.fingerprint);await index.sync(generation);index.activate(generation);
  const call=async mode=>(await f.mcp('tools/call',{name:'mnemuron_search_memories',arguments:{query:'network',...(mode?{mode}:{})}},token)).data.result;
  core.store.memoryConfig={...core.store.memoryConfig,memory:{...core.store.memoryConfig.memory,retrieval:{mode:'hybrid'}}};
  assert.equal((await call()).structuredContent.retrieval.effective_mode,'hybrid');
  const original=model.profile;
  for(const [profile,code] of [[{...original,egress:{...original.egress,query_approved:false}},'EGRESS_DENIED'],
    [{...original,limits:{...original.limits,daily_requests:1}},'BUDGET_EXHAUSTED']]) {
    model.profile=profile;
    const hybrid=await call('hybrid');assert.notEqual(hybrid.isError,true);assert.equal(hybrid.structuredContent.retrieval.degradation_code,code);
    const semantic=await call('semantic');assert.equal(semantic.isError,true);assert.equal(semantic.structuredContent.error.degradation_code,code);
  }
  model.profile=original;
  const added=core.store.saveMemory(core.a.auth,{scope:'user',content:'Synthetic network memory not indexed yet'}).memory;approveWebMemory(core,added);
  const hybrid=await call('hybrid');assert.equal(hybrid.structuredContent.retrieval.degradation_code,'VECTOR_STALE');
  assert.ok(hybrid.structuredContent.results.some(m=>m.memory_id===added.memory_id));
  const semantic=await call('semantic');assert.equal(semantic.isError,true);assert.equal(semantic.structuredContent.error.degradation_code,'VECTOR_STALE');
  assert.notEqual((await call('lexical')).isError,true);
});

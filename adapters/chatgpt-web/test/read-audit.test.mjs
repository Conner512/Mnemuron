import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import http from 'node:http';
import {gatewayFixture,approveWebMemory} from './fixture.mjs';
import {memoryFixture,businessSnapshot} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {readObservation,projectAudit} from '../src/read-audit.mjs';

test('Web read audit identifies exact returned revisions and pages without recording content or host claims',async t=>{
  const core=await memoryFixture(t),f=await gatewayFixture(t,{profile:'readonly',coreFixture:core});
  const token=(await f.exchange(await f.authorize())).data.access_token;
  const memory=core.store.saveMemory(core.a.auth,{scope:'user',content:'Synthetic audit-only private fixture🙂 '.repeat(90)}).memory;
  approveWebMemory(core,memory);
  const before=businessSnapshot(core.store);
  const call=async(name,args)=>f.mcp('tools/call',{name,arguments:args,_meta:{'openai/session':'untrusted-session','connection_id':'forged-connection'}},token);
  const search=await call('mnemuron_search_memories',{query:'audit-only',mode:'lexical'});
  assert.equal(search.data.result.structuredContent.results[0].revision,1);
  let args={memory_id:memory.memory_id,content_limit:1024},text='',pages=0;
  do {
    const response=await call('mnemuron_get_memory',args),body=response.data.result.structuredContent;
    assert.notEqual(response.data.result.isError,true);
    text+=body.memory.content;args=body.next_request;assert.ok(++pages<10);
  }while(args);
  assert.equal(text,memory.content);assert.ok(pages>1);
  const logs=f.gatewayLogs.filter(e=>e.schema_version==='web-read-audit-v1');
  assert.equal(logs.length,pages+1);
  assert.ok(logs.every(e=>e.connection_kind==='oauth_client_subject' && /^[a-f0-9]{64}$/.test(e.connection_id)));
  assert.equal(new Set(logs.map(e=>e.connection_id)).size,1);
  assert.ok(logs.every(e=>e.transport_outcome==='response_finished' && e.read_outcome==='success'));
  assert.ok(logs.every(e=>e.read.memory_refs.some(r=>r.memory_id===memory.memory_id && r.revision===1)));
  assert.equal(logs.at(-1).read.content_complete,true);
  assert.equal(logs.at(-1).client_consumption_verified,false);
  const serialized=JSON.stringify(logs);
  for(const forbidden of [memory.content,'audit-only',token,f.subject,f.coreCredential.api_key,'untrusted-session','forged-connection'])assert.ok(!serialized.includes(forbidden));
  assert.deepEqual(businessSnapshot(core.store),before);
});

test('Web read audit distinguishes denied calls, invalid arguments and version errors from successful empty reads',async t=>{
  const core=await memoryFixture(t),f=await gatewayFixture(t,{profile:'readonly',coreFixture:core});
  const token=(await f.exchange(await f.authorize())).data.access_token;
  const memory=core.store.saveMemory(core.a.auth,{scope:'user',content:'Synthetic denied audit fixture'}).memory;
  const call=args=>f.mcp('tools/call',{name:'mnemuron_get_memory',arguments:args},token);
  await call({memory_id:memory.memory_id});
  let event=f.gatewayLogs.at(-1);
  assert.equal(event.read_outcome,'tool_error');assert.equal(event.error_code,'MEMORY_NOT_FOUND');assert.equal(event.read,undefined);
  assert.ok(!JSON.stringify(event).includes(memory.memory_id));
  approveWebMemory(core,memory);await call({memory_id:memory.memory_id,revision:99});
  event=f.gatewayLogs.at(-1);assert.equal(event.error_code,'MEMORY_VERSION_CHANGED');assert.equal(event.read,undefined);
  await call({memory_id:memory.memory_id,content_offset:1});
  event=f.gatewayLogs.at(-1);assert.notEqual(event.read_outcome,'success');assert.equal(event.read,undefined);
  await f.mcp('tools/call',{name:'mnemuron_search_memories',arguments:{query:'synthetic-no-result'}},token);
  event=f.gatewayLogs.at(-1);assert.equal(event.read_outcome,'success');assert.equal(event.read.result_count,0);
  f.app.store.revoke({all:true});await call({memory_id:memory.memory_id});
  event=f.gatewayLogs.at(-1);assert.equal(event.status,401);assert.equal(event.read_outcome,'not_executed');assert.equal(event.read,undefined);
});

test('local audit viewer filters exact records and reprojects logs without echoing unknown fields',async t=>{
  const core=await memoryFixture(t),f=await gatewayFixture(t,{profile:'readonly',coreFixture:core});
  const token=(await f.exchange(await f.authorize())).data.access_token;
  const memory=core.store.saveMemory(core.a.auth,{scope:'user',content:'Synthetic audit viewer fixture'}).memory;approveWebMemory(core,memory);
  await f.mcp('tools/call',{name:'mnemuron_get_memory',arguments:{memory_id:memory.memory_id}},token);
  const event=f.gatewayLogs.at(-1);
  const input=JSON.stringify({MESSAGE:JSON.stringify({...event,token:'do-not-echo',read:{...event.read,content:'do-not-echo'}})})+'\n'+JSON.stringify({message:'do-not-echo'})+'\nnot-json\n';
  const run=args=>spawnSync(process.execPath,['adapters/chatgpt-web/bin/read-audit.mjs',...args],{input,encoding:'utf8'});
  const result=run(['--memory',memory.memory_id,'--limit','1']);
  assert.equal(result.status,0,result.stderr);
  const out=JSON.parse(result.stdout);assert.equal(out.records.length,1);assert.equal(out.records[0].request_id,event.request_id);
  assert.ok(!result.stdout.includes('do-not-echo'));assert.equal(out.records[0].read.memory_refs[0].revision,1);
  assert.equal(JSON.parse(run(['--request','00000000-0000-4000-8000-000000000000']).stdout).records.length,0);
  assert.notEqual(run(['--limit','10001']).status,0);
});

test('audit marks a disconnected client without claiming a delivered or consumed memory',async t=>{
  const core=await memoryFixture(t),f=await gatewayFixture(t,{profile:'readonly',coreFixture:core});
  const token=(await f.exchange(await f.authorize())).data.access_token;
  let entered,release;const called=new Promise(resolve=>{entered=resolve;});
  const pending=new Promise(resolve=>{release=resolve;});
  const closed=new Promise(resolve=>f.gateway.server.once('request',(_request,response)=>response.once('close',resolve)));
  f.gateway.core.call=async()=>{entered();await pending;return {read_only:true,query:'synthetic',effective_scope:{},results:[],retrieval:{}};};
  const request=http.request(f.gatewayConfig.resource,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/json, text/event-stream'}});
  request.on('error',()=>{});
  request.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'mnemuron_search_memories',arguments:{query:'synthetic'}}}));
  await called;request.destroy();
  await closed;release();
  const logs=f.gatewayLogs.filter(e=>e.schema_version==='web-read-audit-v1');
  assert.equal(logs.length,1);assert.equal(logs[0].transport_outcome,'connection_closed');
  assert.equal(logs[0].read,undefined);assert.equal(logs[0].client_consumption_verified,false);
});

test('summary audit records bounded source references, not claim text or opaque cursors',()=>{
  const claims=Array.from({length:110},(_,i)=>({memory_id:'synthetic-'+i,revision:1,quote:'not-for-logs'}));
  const read=readObservation('mnemuron_get_summary',{results:[{summary_id:'synthetic-summary',revision:2,claims}],next_cursor:'not-for-logs'});
  assert.equal(read.memory_refs.length,100);assert.equal(read.memory_refs_complete,false);
  assert.deepEqual(read.summary_refs,[{summary_id:'synthetic-summary',revision:2}]);
  assert.ok(!JSON.stringify(read).includes('not-for-logs'));
  assert.equal(projectAudit({schema_version:'old-schema'}),null);
});

test('search audit includes conflict-only returned records and deduplicates exact references',()=>{
  const read=readObservation('mnemuron_search_memories',{results:[{memory_id:'synthetic-main',revision:1}],
    conflict_presentation:{potential_conflicts:[{variants:[{memory_id:'synthetic-main',revision:1,content:'do-not-log'},
      {memory_id:'synthetic-conflict',revision:3,content:'do-not-log'}]}]}});
  assert.deepEqual(read.memory_refs,[{memory_id:'synthetic-main',revision:1},{memory_id:'synthetic-conflict',revision:3}]);
  assert.equal(read.memory_refs_complete,true);assert.equal(read.result_count,1);
  assert.ok(!JSON.stringify(read).includes('do-not-log'));
});

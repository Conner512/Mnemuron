// Project lifecycle through the ChatGPT web adapter (phase 5H, WL-01). The adapter's read tools run against a real
// synthetic Core whose lifecycle state was produced by the real Console delete/merge actions. Exact per-revision web
// grants stay the visibility boundary: a merged group never lends one member's grant to another record, and a deleted
// project's granted record is never served. Cloud writes through old IDs use the Core cloud endpoint the adapter calls,
// covered over HTTP by server/test LW-07 and LW-16. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {gatewayFixture,approveWebMemory} from './fixture.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../../shared/console-contract.mjs';

test('WL-01: web reads honor deleted and merged projects, keep exact grants per record, and never cross owners',async t=>{
  const core=await memoryFixture(t),{store}=core,user=core.a.auth.user_id;
  for(const id of ['web-live','web-dead','web-src','web-tgt'])store.upsertProject(core.a.auth,{project_id:id,name:`Web ${id}`});
  const save=(project,text)=>store.saveMemory(core.a.auth,{scope:'project',project_id:project,content:`WEBLIFE ${text}`}).memory;
  const m={live:save('web-live','live record'),dead:save('web-dead','deleted record'),src:save('web-src','source record'),tgt:save('web-tgt','target record'),ungranted:save('web-tgt','ungranted target record')};
  approveWebMemory(core,m.live,m.dead,m.src,m.tgt);
  // A foreign owner's granted record with the same marker never appears.
  store.upsertProject(core.other.auth,{project_id:'web-foreign',name:'Web foreign'});
  const foreign=store.saveMemory(core.other.auth,{scope:'project',project_id:'web-foreign',content:'WEBLIFE foreign record'}).memory;
  const {revision,state_hash}=store.revisions.latest(core.other.auth.user_id,foreign.memory_id);store.webVisibility.set(core.other.auth,foreign.memory_id,{allow:true,revision,state_hash});
  const writer=store.authenticate(store.issueCredential({userId:user,deviceId:'web-console',agentId:'mnemuron-console',agentInstanceId:'web-console',scopes:[...CONSOLE_WRITE_SCOPES]}).api_key);
  const act=(action,payload)=>store.consoleService.execute(writer,{action,operation_id:randomUUID(),payload});
  let p=await act('projects.lifecycle_preview',{action:'delete',project_id:'web-dead'});await act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'Web web-dead'});
  p=await act('projects.lifecycle_preview',{action:'merge',project_id:'web-src',target_project_id:'web-tgt'});await act('projects.merge',{preview_id:p.preview_id});
  const f=await gatewayFixture(t,{profile:'readonly',coreFixture:core,sharedOrigin:true,loopbackAuth:true});
  const token=(await f.exchange(await f.authorize())).data.access_token;
  const call=(name,args)=>f.mcp('tools/call',{name,arguments:args},token);
  const ids=r=>(r.data.result.structuredContent?.results||[]).map(x=>x.memory_id).sort();
  const failed=r=>r.status!==200||r.data.result?.isError===true||!!r.data.error;
  const unscoped=await call('mnemuron_search_memories',{query:'WEBLIFE',limit:20});
  assert.equal(unscoped.status,200);
  assert.deepEqual(ids(unscoped),[m.live,m.src,m.tgt].map(x=>x.memory_id).sort(),'granted live and merged-group records only: no deleted, ungranted or foreign record');
  const merged=await call('mnemuron_search_memories',{query:'WEBLIFE',project_id:'web-src',limit:20});
  assert.deepEqual(ids(merged),[m.src,m.tgt].map(x=>x.memory_id).sort(),'an old merged ID reads the canonical group, granted records only');
  const deadSearch=await call('mnemuron_search_memories',{query:'WEBLIFE',project_id:'web-dead',limit:20});
  assert.ok(failed(deadSearch),'a deleted project is not searchable');
  assert.deepEqual([deadSearch.data.result.structuredContent.error.code,deadSearch.data.result.structuredContent.error.retryable],['PROJECT_UNAVAILABLE',false],'refused as non-retryable, not as an outage');assert.ok(!JSON.stringify(deadSearch.data).includes('deleted record'));
  const deadRead=await call('mnemuron_get_memory',{memory_id:m.dead.memory_id});
  assert.ok(failed(deadRead),'a deleted project\'s granted record is not served');assert.ok(!JSON.stringify(deadRead.data).includes('WEBLIFE deleted record'));
  const ungranted=await call('mnemuron_get_memory',{memory_id:m.ungranted.memory_id});
  assert.ok(failed(ungranted),'merging never lends a grant to an ungranted record');
  const context=await call('mnemuron_preview_project_context',{project_id:'web-dead'});
  assert.ok(failed(context)||!JSON.stringify(context.data).includes('deleted record'),'project context never shows the deleted project\'s content');
  const sourceRead=await call('mnemuron_get_memory',{memory_id:m.src.memory_id});
  assert.equal(sourceRead.status,200);assert.equal(sourceRead.data.result.structuredContent.memory.content,'WEBLIFE source record','a merged source\'s granted record stays readable');
});

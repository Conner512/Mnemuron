import test from 'node:test';
import assert from 'node:assert/strict';
import {gatewayFixture} from './fixture.mjs';
import {memoryFixture,businessSnapshot} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {prepareTool} from '../src/tools.mjs';

test('WEB-MEM-01: canonical Task reads stay local and cannot be requested through Web',async t=>{
  const core=await memoryFixture(t);
  const f=await gatewayFixture(t,{profile:'readonly',coreFixture:core});
  const token=(await f.exchange(await f.authorize())).data.access_token;
  const before=businessSnapshot(core.store);
  const definition=(await f.mcp('tools/list',undefined,token)).data.result.tools.find(t=>t.name==='mnemuron_preview_project_context');
  assert.equal(definition.inputSchema.properties.task_id,undefined);
  assert.equal(definition.annotations.readOnlyHint,true);
  for(const args of [{project_id:core.alpha.project_id,task_id:core.alpha.task_id},
    {project_id:core.alpha.project_id,task_field:'goal',canonical_version:1},
    {project_id:core.foreign.project_id,task_id:core.foreign.task_id}]) {
    assert.equal((await f.mcp('tools/call',{name:definition.name,arguments:args},token)).data.result.isError,true);
  }
  const direct=await core.request('POST','/v1/project-context/preview',{project_id:core.alpha.project_id,task_id:core.alpha.task_id},f.coreCredential);
  assert.equal(direct.status,403);
  const local={...core.a.auth,scopes:[...core.a.auth.scopes,'resume:read']};
  const detail=core.store.previewProjectContext(local,{project_id:core.alpha.project_id,task_id:core.alpha.task_id,task_field:'goal'});
  assert.equal(detail.status,'task_context_detail');
  assert.equal(detail.content,core.alpha.goal);
  const preview=(await f.mcp('tools/call',{name:definition.name,arguments:{project_id:core.alpha.project_id}},token)).data.result.structuredContent;
  assert.equal(preview.read_capabilities.task_field_details,false);
  assert.deepEqual(preview.tasks,[]);
  assert.deepEqual(businessSnapshot(core.store),before);
});

test('Web Task arguments fail before any Core read, rather than silently falling back to summary',async()=>{
  let calls=0;
  const context={config:{tool_profile:'readonly',limits:{tool_response_bytes:8192}},auth:{scopes:new Set(['project:read'])},core:{call:async()=>{calls++;return {};}}};
  for(const args of [{project_id:'project-example',task_id:'task-example'},{project_id:'project-example',canonical_version:1}])
    await assert.rejects(prepareTool('mnemuron_preview_project_context',args,context),e=>e.code==='INVALID_TOOL_ARGUMENTS');
  assert.equal(calls,0);
});

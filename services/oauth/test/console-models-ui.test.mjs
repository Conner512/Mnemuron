import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.document={body:{dataset:{}},documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener:()=>{}};
const {actionPage}=await import('../../../web/console/actions.mjs');
const data={models:[{kind:'organizer',config:{enabled:true},has_key:false},{kind:'embedder',config:{enabled:true,dimensions:768},has_key:true}],processing:{classification:{ready:false,blockers:['WORKER_DISABLED']},summary:{ready:false,blockers:['WORKER_DISABLED']},vector:{ready:false,blockers:['VECTOR_DISABLED'],search_ready:false,search_blockers:['VECTOR_NOT_READY'],indexed_documents:0,state:'not_started'},settings:{schedule_enabled:false}}};
test('Models page explains both roles and blocked processing without fake ready states',()=>{
 const html=actionPage('models',data,{enabled:true,writable:true,allowed_actions:['models.save','models.test','jobs.schedule','vector.schedule']});
 for(const role of ['organizerPurpose','embedderPurpose','modelPipeline','probeNotRun'])assert.match(html,new RegExp(`data-i18n="${role}"`));
 assert.match(html,/后台处理已暂停/);assert.match(html,/向量库尚未配置/);
 assert.match(html,/<button\b(?=[^>]*data-console-action="vector.schedule")(?=[^>]*disabled)/);
 assert.match(html,/<button\b(?=[^>]*data-console-action="jobs.schedule")(?=[^>]*disabled)/);
 assert.doesNotMatch(html,/data-console-action="models.disable"/,'test permission must not imply disable permission');
});
test('Model processing actions require exact capabilities even with a writable memory credential',()=>{
 const html=actionPage('models',data,{enabled:true,writable:true,allowed_actions:['memory.create']});
 assert.doesNotMatch(html,/data-console-action="(?:models\.|jobs\.|vector\.)/);
 const jobs=actionPage('jobs',{jobs:[]},{enabled:true,writable:true,allowed_actions:['memory.create']});
 assert.doesNotMatch(jobs,/data-console-action="jobs\./);
});
test('Current-revision verification shows bounded checks and escaped error diagnostics',()=>{
 const d=structuredClone(data);d.models[0].verification={state:'verified',checks:['classification','summary'],updated_at:Date.now()};d.models[1].verification={state:'failed',error_code:'<unsafe>',updated_at:Date.now()};
 const html=actionPage('models',d,{allowed_actions:[]});assert.match(html,/data-i18n="probeVerified"/);assert.match(html,/data-i18n="probeFailed"/);assert.doesNotMatch(html,/<unsafe>/);assert.match(html,/&lt;unsafe&gt;/);
});

test('MODEL-LIMIT-01: a model card shows the daily limit actually enforced; with call limits set that is the call limit, not the model\'s own cap',async()=>{
  const {actionPage}=await import('../../../web/console/actions.mjs');
  const model={kind:'organizer',revision:3,has_key:true,config:{enabled:true,model:'synthetic-model',base_url:'https://model.example.invalid/v1',daily_requests:25},verification:null};
  const caps={enabled:true,writable:true,allowed_actions:['models.save']};
  const quota={kind:'organizer',mode:'manual',revision:1,daily:{limit:250,used:83,remaining:167},total:{limit:null,used:130,remaining:null}};
  const manual=actionPage('models',{models:[model],processing:{quotas:{organizer:quota}}},caps);
  const row=manual.slice(manual.indexOf('每日调用上限'),manual.indexOf('每日调用上限')+200);
  assert.match(row,/<dd>250<\/dd>/);assert.doesNotMatch(manual,/setInCallLimits|仅作记录/,'no extra note under the limit');assert.doesNotMatch(row,/<dd>25</,'the unused model cap is not shown as a limit');
  const unlimited=actionPage('models',{models:[model],processing:{quotas:{organizer:{...quota,daily:{limit:null,used:0,remaining:null}}}}},caps);
  assert.match(unlimited,/<dd><span data-i18n="noLimit">不限制<\/span><\/dd>/);
  const legacy=actionPage('models',{models:[model],processing:{quotas:{organizer:{...quota,mode:'legacy'}}}},caps);
  assert.match(legacy.slice(legacy.indexOf('每日调用上限'),legacy.indexOf('每日调用上限')+120),/<dd>25<\/dd>/,'without call limits the model\'s own cap is the limit');
});

test('HOSTS-UI-01: the models page lists host records with edit and remove, and offers adding one; the two explanation cards are gone in owner mode',async()=>{
  const {actionPage}=await import('../../../web/console/actions.mjs');
  const caps={enabled:true,writable:true,owner_mode:true,allowed_actions:['models.save','hosts.set','hosts.remove']};
  const html=actionPage('models',{models:[],processing:{},hosts:[{hostname:'api.example.com',address:'192.0.2.20',updated_at:'2026-10-27T05:00:00Z'}]},caps);
  assert.match(html,/id="model-hosts"[\s\S]*data-console-action="hosts.set"[^>]*>[\s\S]*?添加解析/);
  assert.match(html,/data-host="api.example.com"><td><code>api.example.com<\/code><\/td><td><code>192.0.2.20<\/code>[\s\S]*?data-console-action="hosts.set" data-id="api.example.com"[\s\S]*?data-console-action="hosts.remove" data-id="api.example.com"/);
  assert.doesNotMatch(html,/data-i18n="modelPipeline"|data-i18n="modelBoundary"/);
  const sys=actionPage('models',{models:[],processing:{},hosts:[],system_hosts:[{hostname:'relay.example.com',address:'192.0.2.52'}],hosts_apply:{writes_file:true,revision:2,pending:false,state:'applied'}},caps);
  assert.match(sys,/data-host="relay.example.com"><td><code>relay.example.com<\/code><\/td><td><code>192.0.2.52<\/code><\/td><td><span class="tag"><span data-i18n="hostSourceSystem">系统 \/etc\/hosts<\/span><\/span>[\s\S]*?data-console-action="hosts.set" data-id="relay.example.com"[\s\S]*?data-console-action="hosts.remove" data-id="relay.example.com"/,'system entries can be edited and removed');
  assert.match(sys,/data-tone="good">已写入 \/etc\/hosts/);assert.doesNotMatch(sys,/还没有解析记录/);
  assert.match(actionPage('models',{models:[],processing:{},hosts:[],system_hosts:[],hosts_apply:{writes_file:true,revision:3,pending:false,state:'failed',error:'HOST_ADDRESS_DENIED'}},caps),/data-tone="bad">写入 \/etc\/hosts 失败 HOST_ADDRESS_DENIED/);
  assert.match(actionPage('models',{models:[],processing:{},hosts:[]},caps),/还没有解析记录/);
  assert.doesNotMatch(actionPage('models',{models:[],processing:{},hosts:[]},{...caps,allowed_actions:[]}),/data-console-action="hosts\./,'read-only: no buttons');
});

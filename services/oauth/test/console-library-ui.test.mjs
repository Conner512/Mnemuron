import test from 'node:test';import assert from 'node:assert/strict';
import {libraryView} from '../../../web/console/visuals.mjs';
import {text} from '../../../web/console/catalog.mjs';
globalThis.document={body:{dataset:{}},documentElement:{dataset:{},lang:'zh-CN'},querySelectorAll:()=>[],addEventListener:()=>{}};
const {actionPage}=await import('../../../web/console/actions.mjs');
const t=k=>text(k,'zh-CN');
const facets=classification=>({categories:[{category:'uncategorized',count:35},{category:'projects',count:0}],topics:[],statuses:{active:35},origins:{imported:0,other:35},recent_batches:[],classification});
const base={state:'unconfigured',blockers:[],model_configured:false,model_enabled:false,worker_enabled:false,key_storage:false,jobs:{running:0,failed:0,succeeded:0},last_job:null,active:35,manual:0,model:0};

test('LIB-UI-01: a leading path sits on its own line above the body; plain memories are unchanged',()=>{
  const html=libraryView(t,{data:{results:[{memory_id:'m1',content:'/Users/example/a/b.md: Body text',path:'/Users/example/a/b.md',body:'Body text',status:'active'},{memory_id:'m2',content:'Plain text',status:'active'}]}});
  assert.match(html,/<span class="memory-path" title="\/Users\/example\/a\/b.md">\/Users\/example\/a\/b.md<\/span><span class="memory-text">Body text<\/span>/);
  assert.match(html,/data-memory="m2"><span class="memory-text">Plain text<\/span>/);
});
test('LIB-UI-02: the status explains each state without a retry that cannot work',()=>{
  const render=c=>libraryView(t,{data:{results:[]},facets:facets({...base,...c}),allowedActions:['jobs.schedule','memory.organize']});
  const unconfigured=render({});assert.match(unconfigured,/data-classification-state="unconfigured"/);assert.match(unconfigured,/自动分类尚未设置/);
  assert.match(unconfigured,/href="\/app\/models"/);assert.match(unconfigured,/href="\/app\/memories\?category=uncategorized"/);assert.match(unconfigured,/模型密钥加密存储/);
  for(const html of [unconfigured,render({state:'blocked',blockers:['EGRESS_DENIED'],model_configured:true})])assert.doesNotMatch(html,/data-console-action="jobs\.(schedule|retry)"|重试/);
  assert.match(render({state:'unscheduled',model_configured:true,model_enabled:true}),/data-console-action="jobs.schedule" data-type="classification"/);
  assert.match(render({state:'failed',last_job:{state:'dead_letter',error_code:'REQUEST_TIMEOUT'}}),/href="\/app\/jobs"/);
  assert.doesNotMatch(libraryView(t,{data:{results:[]},facets:{...facets({...base,state:'completed'}),categories:[{category:'uncategorized',count:0}]}}),/classification-status/);
});
test('LIB-UI-03: the Jobs page disables organize with the reason when scheduling would fail',()=>{
  const caps={enabled:true,writable:true,allowed_actions:['jobs.schedule']};
  const blocked=actionPage('jobs',{jobs:[],worker_enabled:false,processing:{classification:{ready:false,blockers:['NOT_CONFIGURED','WORKER_DISABLED']}}},caps);
  assert.match(blocked,/data-console-action="jobs.schedule" data-type="classification" disabled/);assert.match(blocked,/请先保存并启用对应模型/);assert.match(blocked,/href="\/app\/models"/);
  const waiting=actionPage('jobs',{jobs:[],worker_enabled:false,processing:{classification:{ready:false,blockers:['WORKER_DISABLED']}}},caps);
  assert.doesNotMatch(waiting,/data-type="classification" disabled/,'a disabled worker still allows queuing');
});

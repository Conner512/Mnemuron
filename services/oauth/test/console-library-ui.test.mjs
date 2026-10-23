import test from 'node:test';import assert from 'node:assert/strict';
import {libraryView,summariesView} from '../../../web/console/visuals.mjs';
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
test('LIB-UI-02: the library files memories by writer-chosen type: type filter, type, strength and updated columns, tag row; no category tools',()=>{
  const html=libraryView(t,{data:{results:[{memory_id:'m1',content:'Deploy steps',status:'active',kind:'workflow',strength:9,concepts:['deploy','<pve>'],project_id:'p1',project_name:'Mnemuron',memory_type:'decision',created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-02T00:00:00Z'},
    {memory_id:'m2',content:'Old',status:'active',kind:null,concepts:[],strength:null}]},kind:'workflow',facets:facets({...base}),allowedActions:['jobs.schedule','memory.organize','category.create']});
  assert.match(html,/<select name="kind">/);assert.match(html,/<option value="workflow" selected data-i18n="kind_workflow">工作流程<\/option>/);assert.match(html,/<option value="none" data-i18n="kind_none">/);
  assert.match(html,/<th><span data-i18n="kind">类型<\/span><\/th><th><span data-i18n="strength">重要度<\/span><\/th><th><span data-i18n="updated">更新时间<\/span><\/th>/);
  assert.match(html,/<span class="kind-pill" data-group="flow"><span data-i18n="kind_workflow">工作流程<\/span><\/span>/);
  assert.match(html,/<rect class="fill" width="45" height="8" rx="2"\/><\/svg><b>9<\/b>/);
  assert.match(html,/<span class="project-chip" title="p1">.*Mnemuron<\/span><button type="button" class="concept-chip" data-facet="concept" data-value="deploy">deploy<\/button><button type="button" class="concept-chip" data-facet="concept" data-value="&lt;pve&gt;">&lt;pve&gt;<\/button>/,'keywords are escaped filter buttons');
  const filtered=libraryView(t,{data:{results:[{memory_id:'m1',content:'x',status:'active',concepts:['Deploy']}]},concept:'deploy'});
  assert.match(filtered,/data-value="Deploy" aria-pressed="true"/,'the active keyword is marked, case-insensitively');assert.match(filtered,/<span class="filter-chip">关键词：deploy<button[^>]*data-clear-facet="concept"/);
  assert.match(html,/<span class="chip-label">任务<\/span>决定/);assert.match(html,/datetime="2026-10-02T00:00:00Z"/);
  assert.match(html,/<span class="kind-pill" data-group="none"><span data-i18n="kind_none">未标注<\/span><\/span><\/td><td><span class="muted">—<\/span>/);
  assert.doesNotMatch(html,/classification-status|category\.manage|library-tools|name="category"|memory\.organize/);
});
test('LIB-UI-03: the Jobs page offers summaries only and disables them with the reason when scheduling would fail',()=>{
  const caps={enabled:true,writable:true,allowed_actions:['jobs.schedule']};
  const blocked=actionPage('jobs',{jobs:[],worker_enabled:false,processing:{summary:{ready:false,blockers:['NOT_CONFIGURED','WORKER_DISABLED']}}},caps);
  assert.match(blocked,/data-console-action="jobs.schedule" data-type="summary" disabled/);assert.match(blocked,/请先保存并启用对应模型/);assert.match(blocked,/href="\/app\/models"/);
  assert.doesNotMatch(blocked,/data-type="classification"/,'classification was retired');
  const waiting=actionPage('jobs',{jobs:[],worker_enabled:false,processing:{summary:{ready:false,blockers:['WORKER_DISABLED']}}},caps);
  assert.doesNotMatch(waiting,/data-type="summary" disabled/,'a disabled worker still allows queuing');
});
test('LIB-UI-04: summaries are grouped by what they cover, one row per period; older category summaries say so',()=>{
  const w=(period,local_start)=>({period,timezone:'Asia/Shanghai',local_start});
  const html=summariesView(t,{data:{summaries:[
    {summary_id:'s1',category:'all',status:'current',revision:1,coverage:3,omitted:0,scope:{kind:'project',project_id:'p1',project_name:'<Mnemuron>'},window:w('daily','2026-10-19'),preview:{text:'quote one'}},
    {summary_id:'s2',category:'all',status:'current',revision:1,coverage:2,omitted:0,scope:{kind:'session',session_id:'sess-1'},window:w('weekly','2026-10-13')},
    {summary_id:'s3',category:'technical',status:'current',revision:2,coverage:5,omitted:0,scope:{kind:'project',project_id:'p1',project_name:'<Mnemuron>'},window:w('weekly','2026-10-13')}]}});
  assert.equal((html.match(/<section class="summary-group"/g)||[]).length,2,'two scopes, two groups');
  assert.match(html,/<section class="summary-group" data-group="proj"><header class="summary-group-head">[\s\S]*?&lt;Mnemuron&gt;[\s\S]*?<small>2 <span data-i18n="summaryGroupCount">份摘要<\/span><\/small>/);
  assert.match(html,/<span class="period-pill" data-period="daily"><span data-i18n="summaryPeriod_daily">/);
  assert.equal((html.match(/summary-legacy/g)||[]).length,1,'only the older summary names its category');
  assert.doesNotMatch(html,/category-pill|<Mnemuron>/);
});

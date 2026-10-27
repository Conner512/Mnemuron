import test from 'node:test';import assert from 'node:assert/strict';
globalThis.document={body:{dataset:{}},documentElement:{dataset:{},lang:'zh-CN'},querySelectorAll:()=>[],addEventListener:()=>{}};
const {actionPage,batchJobsView}=await import('../../../web/console/actions.mjs');
const caps={enabled:true,writable:true,allowed_actions:['jobs.schedule','jobs.cancel','jobs.retry']};
const job=(id,patch)=>({job_id:id,job_type:'classification',state:'blocked_config',processed:0,total:3,...patch});

test('JOBS-UI-01: a job fenced by a category change offers a working reschedule, never a bare retry',()=>{
  const html=actionPage('jobs',{jobs:[job('synthetic-stale',{last_error_code:'STALE_TAXONOMY',stale_taxonomy:true})],worker_enabled:true},caps);
  assert.match(html,/data-console-action="jobs.retry"[^>]*data-stale="true"[^>]*><span data-i18n="rescheduleWithCategories"/);
  assert.doesNotMatch(html,/data-i18n="retry"/);
  assert.match(html,/data-i18n="jobState_blocked_config"/,'the state is a translated label, not the raw code');
  assert.match(html,/按旧的分类体系规划/);assert.match(html,/data-i18n="jobStaleTaxonomyHint"/);
});
test('JOBS-UI-02: a replaced job has no retry; ordinary failures keep their retry',()=>{
  const replaced=actionPage('jobs',{jobs:[job('synthetic-old',{state:'cancelled',last_error_code:'RESCHEDULED',stale_taxonomy:true})],worker_enabled:true},caps);
  assert.doesNotMatch(replaced,/data-console-action="jobs\.(retry|cancel)"/);assert.match(replaced,/已重新排队，由新任务接替/);
  const failed=actionPage('jobs',{jobs:[job('synthetic-failed',{state:'dead_letter',last_error_code:'REQUEST_TIMEOUT',stale_taxonomy:false})],worker_enabled:true},caps);
  assert.match(failed,/data-console-action="jobs.retry" data-id="synthetic-failed"[^>]*><span data-i18n="retry"/);
  assert.doesNotMatch(failed,/data-stale/);
});

test('JOBS-UI-BATCH: the queue shows one row per batch with a percentage and a single cancel; finished batches have no cancel',()=>{
  const batch=(id,patch)=>({batch_id:id,job_type:'summary',jobs:83,succeeded:18,cancelled:0,running:1,waiting:64,failed:0,total:83,processed:18,created_at:Date.UTC(2026,9,27,1,0),updated_at:Date.UTC(2026,9,27,1,5),error_codes:[],...patch});
  const html=actionPage('jobs',{jobs:[job('ignored')],batches:[batch('t:summary:1'),batch('t:summary:0',{succeeded:83,running:0,waiting:0})],worker_enabled:true},{...caps,allowed_actions:[...caps.allowed_actions,'jobs.cancel_batch']});
  assert.equal((html.match(/<tr data-batch=/g)||[]).length,2);assert.doesNotMatch(html,/ignored/,'single jobs are not listed when batches are given');
  assert.match(html,/data-batch="t:summary:1"[\s\S]*?共 83 个[\s\S]*?1 个进行中 · 64 个等待 · 18 个完成[\s\S]*?<span>22%<\/span>[\s\S]*?data-console-action="jobs.cancel_batch" data-id="t:summary:1"/);
  assert.match(html,/data-batch="t:summary:0"[\s\S]*?<span>100%<\/span><\/span><\/td>\s*<td>—<\/td>\s*<td>—<\/td>/,'a finished batch offers no cancel');
});

test('JOBS-UI-BATCH-DETAIL: a batch opens into pages of its jobs with what each covers and the page number',()=>{
  const j=(n,patch)=>({job_id:`j${n}`,job_type:'summary',state:'succeeded',processed:1,total:1,updated_at:Date.UTC(2026,9,27,1,n),scope:{kind:'project',project_id:'p1',project_name:'Synthetic homelab'},window:{period:'daily',local_start:`2026-09-1${n}`},...patch});
  const html=batchJobsView({total:83,offset:10,limit:10,next_offset:20,jobs:[j(0),j(1,{state:'dead_letter',last_error_code:'REQUEST_TIMEOUT',scope:{kind:'user'}})]});
  assert.match(html,/data-job-detail="j0">项目 Synthetic homelab · 2026-09-10（每日）</);
  assert.match(html,/data-job-detail="j1">全部记忆 · 2026-09-11（每日）</);
  assert.match(html,/第 2 \/ 9 页 · 共 83 个/);
  assert.match(html,/data-batch-page="0"[\s\S]*data-batch-page="20"/);
  assert.doesNotMatch(batchJobsView({total:3,offset:0,limit:10,next_offset:null,jobs:[j(0)]}),/data-batch-page/,'one page: no page buttons');
  const page=actionPage('jobs',{jobs:[],batches:[{batch_id:'b1',job_type:'summary',jobs:2,succeeded:2,cancelled:0,running:0,waiting:0,failed:0,created_at:1,error_codes:[]}],worker_enabled:true},caps);
  assert.match(page,/data-batch-toggle="b1" aria-expanded="false"/);
});

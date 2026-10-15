import test from 'node:test';import assert from 'node:assert/strict';
globalThis.document={body:{dataset:{}},documentElement:{dataset:{},lang:'zh-CN'},querySelectorAll:()=>[],addEventListener:()=>{}};
const {actionPage}=await import('../../../web/console/actions.mjs');
const caps={enabled:true,writable:true,allowed_actions:['jobs.schedule','jobs.cancel','jobs.retry']};
const job=(id,patch)=>({job_id:id,job_type:'classification',state:'blocked_config',processed:0,total:3,...patch});

test('JOBS-UI-01: a job fenced by a category change offers a working reschedule, never a bare retry',()=>{
  const html=actionPage('jobs',{jobs:[job('synthetic-stale',{last_error_code:'STALE_TAXONOMY',stale_taxonomy:true})],worker_enabled:true},caps);
  assert.match(html,/data-console-action="jobs.retry"[^>]*data-stale="true"[^>]*><span data-i18n="rescheduleWithCategories"/);
  assert.doesNotMatch(html,/data-i18n="retry"/);
  assert.match(html,/data-i18n="jobState_blocked_config"/,'the state is a translated label, not the raw code');
  assert.match(html,/分类已变更/);assert.match(html,/data-i18n="jobStaleTaxonomyHint"/);
});
test('JOBS-UI-02: a replaced job has no retry; ordinary failures keep their retry',()=>{
  const replaced=actionPage('jobs',{jobs:[job('synthetic-old',{state:'cancelled',last_error_code:'RESCHEDULED',stale_taxonomy:true})],worker_enabled:true},caps);
  assert.doesNotMatch(replaced,/data-console-action="jobs\.(retry|cancel)"/);assert.match(replaced,/已按新分类重新排队/);
  const failed=actionPage('jobs',{jobs:[job('synthetic-failed',{state:'dead_letter',last_error_code:'REQUEST_TIMEOUT',stale_taxonomy:false})],worker_enabled:true},caps);
  assert.match(failed,/data-console-action="jobs.retry" data-id="synthetic-failed"[^>]*><span data-i18n="retry"/);
  assert.doesNotMatch(failed,/data-stale/);
});

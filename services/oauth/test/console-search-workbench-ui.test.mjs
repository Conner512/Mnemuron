import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.document??={body:{dataset:{}},documentElement:{dataset:{},lang:'zh-CN'},querySelectorAll:()=>[],addEventListener(){},removeEventListener(){}};
const {graphScopeParams,neighborhoodCard,neighborhoodResult}=await import('../../../web/console/graph-neighborhood.mjs');
const {feedbackKinds,feedbackControls,searchFeedbackCard,feedbackHistory}=await import('../../../web/console/search-feedback.mjs');
const {text}=await import('../../../web/console/catalog.mjs');

test('WORKBENCH-UI-01: graph requests retain applied exact project/task scope and distinguish co-occurrence from replacement',()=>{
 assert.deepEqual(graphScopeParams({days:0,kinds:['fact'],query:'Version 1.2',project_id:'synthetic-project',task_id:'synthetic-task'}),
  {graph_days:0,graph_kinds:'fact',graph_query:'Version 1.2',graph_project_id:'synthetic-project',graph_task_id:'synthetic-task'});
 const n={focus:'<script>synthetic</script>',peer:null,current_count:11,history_count:2,first_seen:'2020-01-01',last_changed:'2026-10-30',
  neighbors:[{keyword:'<svg/onload=synthetic>',label:'<svg/onload=synthetic>',current_count:3,history_count:2}],neighbors_truncated:true,neighbor_labels_omitted_records:1,
  evidence:{total:13,current_count:11,history_count:2,include_history:true,offset:10,limit:10,next_offset:null,
   items:[{memory_id:'synthetic-id',topic:'<img src=x>',status:'superseded',revision:2,updated_at:'2026-10-30',superseded_by_memory_id:'synthetic-new',topic_omitted:1}]}};
 const html=neighborhoodResult(n);
 assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;svg\/onload=synthetic&gt;/);assert.doesNotMatch(html,/<script>|<svg|<img/);
 assert.match(html,/data-neighbor-history checked/);assert.match(html,/data-neighbor-offset="0"/);
 assert.match(html,/mapReplacement/);assert.match(html,/mapHistoryNote/);assert.match(html,/mapNeighborsLimited/);assert.match(html,/mapMetadataOmitted/);
 assert.match(neighborhoodCard(),/data-neighbor-status role="status" aria-live="polite"/);
});

test('WORKBENCH-UI-02: search actions are explicit, read-only policy is visible, and browsing has no fabricated feedback context',()=>{
 assert.deepEqual(feedbackKinds,['relevant','irrelevant','outdated','missing']);
 assert.equal(searchFeedbackCard({results:[]}), '');
 const controls=feedbackControls({memory_id:'synthetic-"<id>'},{writable:false});
 assert.equal((controls.match(/data-feedback-vote=/g)||[]).length,3);assert.equal((controls.match(/ disabled/g)||[]).length,3);
 assert.match(controls,/&quot;&lt;id&gt;/);assert.doesNotMatch(controls,/<id>/);
 const card=searchFeedbackCard({feedback_context:{}},{writable:false});
 assert.match(card,/viewWithoutWrite/);assert.match(card,/searchFeedbackPrivacy/);assert.match(card,/searchFeedbackWindow/);
 assert.match(card,/mnemuron-search-workbench-quality\.mjs/);assert.match(card,/searchFeedbackEvaluationSeparate/);
});

test('WORKBENCH-UI-03: feedback history labels observations rather than accuracy and marks missing, stale and bounded evidence',()=>{
 const html=feedbackHistory({total:2,offset:20,limit:20,next_offset:40,
  groups:[{requested_mode:'semantic',effective_mode:'lexical',feedback:'missing',count:2}],items:[
   {feedback:'missing',memory_id:null,updated_at:'2026-10-30T12:00:00.000Z',truncated:1},
   {feedback:'outdated',memory_id:'synthetic-<old>',revision:1,revision_current:0,updated_at:'2026-10-30T12:00:00.000Z'}]});
 assert.match(html,/searchFeedbackNotAccuracy/);assert.match(html,/searchFeedbackUnspecified/);assert.match(html,/源记忆已有新修订/);
 assert.match(html,/data-feedback-offset="0"/);assert.match(html,/data-feedback-offset="40"/);
 assert.match(html,/synthetic-&lt;old&gt;/);assert.doesNotMatch(html,/<old>/);assert.match(html,/searchFeedbackLimited/);
 for(const language of ['zh-CN','en'])for(const key of ['mapNeighborhoodReadFailed','mapMetadataOmitted','searchFeedbackTitle','searchFeedbackPrivacy','searchFeedbackEvaluationSeparate','SEARCH_FEEDBACK_EXPIRED'])assert.notEqual(text(key,language),key,`${key} must be translated in ${language}`);
});

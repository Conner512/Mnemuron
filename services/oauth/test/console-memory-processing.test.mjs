import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryProcessingView} from '../../../web/console/memory-processing.mjs';
import {libraryView} from '../../../web/console/visuals.mjs';
import {text} from '../../../web/console/catalog.mjs';

const data={memory_id:'synthetic-memory',revision:3,source:{status:'available'},traits:{status:'missing'},summary:{status:'missing',truncated:false},
  vector:{status:'partial',confirmed_chunks:2,repair_blockers:[]},runs:{items:[{kind:'summary',state:'blocked',revision:3,used:2,budget:10,error_code:'<script>unsafe</script>'}],truncated:false},jobs:{items:[],truncated:false}};
test('memory processing view has bilingual revision-pinned repairs, bounded evidence and escaped errors',()=>{
  for(const locale of ['zh-CN','en']){
    const t=k=>text(k,locale),html=memoryProcessingView(t,data,{writable:true});
    assert.equal((html.match(/data-console-action="processing.preview"/g)||[]).length,3);assert.equal((html.match(/data-revision="3"/g)||[]).length,3);
    assert.match(html,/data-selection="true"/);assert.match(html,/&lt;script&gt;unsafe&lt;\/script&gt;/);assert.doesNotMatch(html,/<script|processingState_|processingChannel_|processingEvidence/);
    assert.doesNotMatch(memoryProcessingView(t,data),/data-console-action/);
    assert.doesNotMatch(memoryProcessingView(t,{...data,source:{status:'inactive'}},{writable:true}),/data-console-action/);
  }
});
test('no vector repair is offered without a serving matching profile; explicit selection has no filter-wide model action',()=>{
  assert.doesNotMatch(memoryProcessingView(text,{...data,vector:{...data.vector,repair_blockers:['VECTOR_NOT_READY']}},{writable:true}),/data-kind="vector"/);
  const list=libraryView(text,{data:{results:[{memory_id:'synthetic-memory',content:'Synthetic',status:'active'}]},allowedActions:['processing.preview'],selected:['synthetic-memory']});
  assert.match(list,/data-batch-memory="synthetic-memory"/);assert.equal((list.match(/data-selection="true"/g)||[]).length,3);assert.doesNotMatch(list,/data-select-all>/);
});
test('partial summary segment counts remain explicitly unpublished in both languages',()=>{
  for(const locale of ['zh-CN','en']){
    const view=memoryProcessingView(k=>text(k,locale),{...data,jobs:{items:[{job_type:'summary',state:'blocked_budget',revision:3,segment_processed:1,segment_total:3}],truncated:false}});
    assert.match(view,/1\/3/);assert.match(view,locale==='en'?/Summary not published yet/:/尚未发布摘要/);assert.doesNotMatch(view,/processingSegments/);
  }
});

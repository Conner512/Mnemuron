export const MEMORY_RESPONSE_BYTES = 128 * 1024;
export const unicodeSlice = (text, offset, limit) => Array.from(String(text)).slice(offset,offset+limit).join('');
export function memorySummary(memory, limit=1000) {
  const length=Array.from(memory.content).length;
  return {...memory,content:unicodeSlice(memory.content,0,limit),content_truncated:length>limit,content_length:length,content_length_unit:'unicode_code_points',detail_available:true};
}
export function boundMemoryResponse(result) {
  result.retrieval.budget_bytes=MEMORY_RESPONSE_BYTES;
  result.retrieval.budget_reasons=[];
  const conflicts=result.conflict_presentation;
  if(conflicts.potential_conflicts.some(c=>c.variants.length>20)) {
    for(const conflict of conflicts.potential_conflicts) {
      conflict.variants=conflict.variants.slice(0,20);
      conflict.memory_ids=conflict.variants.map(v=>v.memory_id);
      conflict.workstream_ids=[...new Set(conflict.variants.map(v=>v.workstream_id))];
    }
    result.retrieval.conflict_truncated=true;
    result.retrieval.budget_reasons.push('conflict_variant_limit');
  }
  const size=()=>Buffer.byteLength(JSON.stringify(result));
  while(size()>MEMORY_RESPONSE_BYTES && conflicts.recorded_task_conflicts.length) {
    conflicts.recorded_task_conflicts.pop();result.retrieval.conflict_truncated=true;
    if(!result.retrieval.budget_reasons.includes('recorded_conflict_byte_budget'))result.retrieval.budget_reasons.push('recorded_conflict_byte_budget');
  }
  while(size()>MEMORY_RESPONSE_BYTES && conflicts.potential_conflicts.length) {
    conflicts.potential_conflicts.pop(); result.retrieval.conflict_truncated=true;
    if(!result.retrieval.budget_reasons.includes('conflict_byte_budget')) result.retrieval.budget_reasons.push('conflict_byte_budget');
  }
  while(size()>MEMORY_RESPONSE_BYTES && result.results.length) {
    result.results.pop(); result.retrieval.result_truncated=true;
    if(!result.retrieval.budget_reasons.includes('result_byte_budget')) result.retrieval.budget_reasons.push('result_byte_budget');
  }
  result.result_count=result.results.length;
  result.truncated=result.retrieval.candidate_truncated || result.retrieval.result_truncated || result.retrieval.conflict_truncated;
  return result;
}

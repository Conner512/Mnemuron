const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const tools = new Set(['mnemuron_auth_status','mnemuron_search_memories','mnemuron_get_memory','mnemuron_get_summary','mnemuron_preview_project_context']);

export function readObservation(name, result) {
  if (name === 'mnemuron_auth_status') return undefined;
  const refs = new Map();
  const add = memory => {
    if (!id(memory?.memory_id)) return;
    const revision = integer(memory.revision) && memory.revision > 0 ? memory.revision : null;
    refs.set(`${memory.memory_id}:${revision}`, {memory_id:memory.memory_id,revision});
  };
  if (name === 'mnemuron_get_memory') add({...result.memory,revision:result.revision});
  else if (name === 'mnemuron_get_summary') {
    for (const summary of result.results || []) for (const claim of summary.claims || []) add(claim);
  } else for (const memory of result.results || result.structured_memories || []) add(memory);
  for (const conflict of result.conflict_presentation?.potential_conflicts || []) {
    for (const memory of conflict.variants || []) add(memory);
  }
  const read = {memory_refs:[...refs.values()].slice(0,100),memory_refs_complete:refs.size<=100,
    result_count:name==='mnemuron_get_memory'?1:(result.results || result.structured_memories || []).length};
  if (name === 'mnemuron_get_memory') {
    read.content_offset=result.content_offset;
    read.content_returned_length=Array.from(result.memory.content).length;
    read.content_complete=result.content_complete;
    read.source_count=result.source_manifest?.sources?.length || 0;
    read.source_complete=result.next_source_request===null;
    if (digest(result.source_manifest?.source_version)) read.source_version=result.source_manifest.source_version;
  }
  if (name === 'mnemuron_get_summary') read.summary_refs=(result.results || []).map(s=>({summary_id:s.summary_id,revision:s.revision}));
  return read;
}

// Log exports are data too: re-project them instead of echoing arbitrary JSON fields.
export function projectAudit(event) {
  if (event?.schema_version!=='web-read-audit-v1' || !id(event.request_id)
    || typeof event.time!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.time)
    || !['response_finished','connection_closed'].includes(event.transport_outcome)
    || !['success','tool_error','not_executed'].includes(event.read_outcome)) return null;
  const result={schema_version:event.schema_version,time:event.time,request_id:event.request_id,
    connection_kind:'oauth_client_subject',physical_device_verified:false,client_consumption_verified:false,
    transport_outcome:event.transport_outcome,read_outcome:event.read_outcome};
  if (digest(event.connection_id)) result.connection_id=event.connection_id;
  if (tools.has(event.tool)) result.tool=event.tool;
  for (const key of ['status','duration_ms']) if (integer(event[key])) result[key]=event[key];
  if (typeof event.error_code==='string' && /^[A-Z_]{1,64}$/.test(event.error_code)) result.error_code=event.error_code;
  if (event.read && event.read_outcome==='success') {
    const read={memory_refs:(event.read.memory_refs || []).filter(r=>id(r?.memory_id) && (r.revision===null || integer(r.revision) && r.revision>0))
      .slice(0,100).map(r=>({memory_id:r.memory_id,revision:r.revision})),memory_refs_complete:event.read.memory_refs_complete===true && event.read.memory_refs?.length<=100};
    for (const key of ['result_count','content_offset','content_returned_length','source_count']) if (integer(event.read[key])) read[key]=event.read[key];
    for (const key of ['content_complete','source_complete']) if (typeof event.read[key]==='boolean') read[key]=event.read[key];
    if (digest(event.read.source_version)) read.source_version=event.read.source_version;
    if (Array.isArray(event.read.summary_refs)) read.summary_refs=event.read.summary_refs.filter(r=>id(r?.summary_id) && integer(r.revision))
      .slice(0,20).map(r=>({summary_id:r.summary_id,revision:r.revision}));
    result.read=read;
  }
  return result;
}

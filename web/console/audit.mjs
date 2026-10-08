// Audit export consumes exactly one independently paged stream. It is a bounded live listing, never a snapshot.
// Keep an explicit projection here too: a future API field cannot accidentally export bodies or secrets.
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value||{},key)).map(key=>[key,value[key]]));
const entryKeys=['audit_id','action','kind','outcome','created','created_at','target_type','target_id','credential_id'];
export function auditExportPage(data,source){
  if(data.source!==source||!Array.isArray(data.entries))throw new Error('INVALID_AUDIT_PAGE');
  const entries=data.entries.map(row=>({...pick(row,entryKeys),source,...(source==='core'&&row.query?{query:pick(row.query,['result_count','result_refs','result_refs_truncated','result_refs_kind'])}:{})}));
  const credentialIds=new Set(entries.map(e=>e.credential_id).filter(Boolean)),memoryIds=new Set(entries.flatMap(e=>[...(e.target_type==='memory'&&e.target_id?[e.target_id]:[]),...(e.query?.result_refs||[])]));
  const credentials=Object.create(null),memories=Object.create(null);
  if(source==='core'){
    for(const id of credentialIds){const c=Object.hasOwn(data.credentials||{},id)?data.credentials[id]:null;if(!c)continue;
      credentials[id]={...pick(c,['label','agent_id','agent_instance_id','device_id','revoked']),...(c.connection?{connection:pick(c.connection,['type','connection_id','credential_version','credential_revoked','label','kind','state','missing','purpose'])}:{})};}
    for(const id of memoryIds)if(Object.hasOwn(data.memories||{},id))memories[id]=pick(data.memories[id],['title','status']);
  }
  return {entries,credentials,memories,memory_titles_truncated:data.memory_titles_truncated===true};
}
export async function collectAuditExport(read,params={},current=()=>true){
  const filters={...params,source:params.source||'core'};
  if(!['core','identity'].includes(filters.source))throw new Error('INVALID_AUDIT_PAGE');
  delete filters.offset;delete filters.limit;
  const check=()=>{if(!current())throw new Error('STALE_ACCOUNT');};
  let offset=0,size=0,requests=0,memory_titles_truncated=false;const entries=new Map(),credentials=Object.create(null),memories=Object.create(null);
  for(;;){
    check();if(++requests>100)throw new Error('EXPORT_SIZE_LIMIT');
    const data=await read({...filters,offset,limit:100});check();
    const page=auditExportPage(data,filters.source);size+=new TextEncoder().encode(JSON.stringify(page)).length;
    if(size>16*1024*1024)throw new Error('EXPORT_SIZE_LIMIT');
    for(const e of page.entries)entries.set(e.audit_id,e);Object.assign(credentials,page.credentials);Object.assign(memories,page.memories);
    memory_titles_truncated ||= page.memory_titles_truncated;
    if(data.next_offset==null)break;
    if(!Number.isSafeInteger(data.next_offset)||data.next_offset<=offset||data.next_offset>1000000)throw new Error('INVALID_AUDIT_PAGE');
    offset=data.next_offset;
  }
  check();return {format:'mnemuron-own-audit-v2',snapshot:'bounded_live_listing',source:filters.source,filters,generated_at:new Date().toISOString(),
    provenance:{credential:'recorded_reference_with_issuance_attributes',connection:'current_owner_scoped_mapping_and_labels',memory:'current_owner_readable_titles',query_results:'bounded_lexical_subquery_refs_not_final_search_results'},
    entries:[...entries.values()],credentials,memories,memory_titles_truncated};
}

// Console audit, Core stream (Console item 7). Each row answers: when, which recorded credential acted, what kind of
// action, what outcome, and which of the owner's memories it refers to. Only a whitelisted projection leaves Core:
// never metadata_json, query text, memory bodies, key hashes or another owner's data.
//
// Provenance is labelled, not reconstructed:
// - `credential_id` is what the row recorded. Credential label/agent/device/instance are issuance attributes that
//   Core never changes, and `revoked` is current state; rows without a credential or with a credential that is no
//   longer this owner's stay unknown.
// - Memory titles are current metadata, resolved only for memories the owner can read now (lifecycle live). Deleted,
//   foreign or missing targets keep their recorded ID and get no title and no link.
// - memory.query rows carry the IDs one lexical subquery returned (bounded, flagged when truncated). Under
//   semantic/hybrid search several rows can belong to one user search and none of them is the final delivered list.
//   Rows written before refs were recorded say so (`result_refs: null`), distinct from an empty result.
import {auditKind,AUDIT_QUERY_REFS} from '../../../shared/console-queries.mjs';
import {memoryPresentation} from '../../../shared/memory-display.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PAGE_MEMORY_LIMIT=500,TEXT_LIMIT=80;
const clip=value=>{const chars=[...String(value??'')];return chars.length>TEXT_LIMIT?`${chars.slice(0,TEXT_LIMIT-1).join('')}…`:chars.join('');};
const id=value=>typeof value==='string'&&ID.test(value)?value:null;

function queryProvenance(metadata){
  const count=Number.isSafeInteger(metadata?.result_count)&&metadata.result_count>=0?metadata.result_count:null;
  if(metadata?.result_refs_kind!=='lexical_subquery'||!Array.isArray(metadata?.result_refs))return {result_count:count,result_refs:null,result_refs_truncated:null,result_refs_kind:'not_recorded'};
  const refs=metadata.result_refs.map(id).filter(Boolean),truncated=metadata.result_refs_truncated===true||refs.length>AUDIT_QUERY_REFS||refs.length!==metadata.result_refs.length;
  return {result_count:count,result_refs:[...new Set(refs)].slice(0,AUDIT_QUERY_REFS),result_refs_truncated:truncated,result_refs_kind:'lexical_subquery'};
}

export function auditPage(store,user,q){
  const {db}=store,{offset,limit}=q,conditions=['user_id=?'],values=[user];
  for(const key of ['action','outcome'])if(q[key]){conditions.push(`${key}=?`);values.push(q[key]);}
  if(q.from){conditions.push('created_at>=?');values.push(new Date(q.from).toISOString());}if(q.to){conditions.push('created_at<=?');values.push(new Date(q.to).toISOString());}
  const rows=db.prepare(`SELECT audit_id,credential_id,action,target_type,target_id,outcome,metadata_json,created_at FROM audit_events WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC,audit_id LIMIT ? OFFSET ?`).all(...values,limit+1,offset);
  const page=rows.slice(0,limit),wanted=new Set();let memoryTruncated=false;
  const want=memoryId=>{if(!memoryId)return;if(wanted.size<PAGE_MEMORY_LIMIT||wanted.has(memoryId))wanted.add(memoryId);else memoryTruncated=true;};
  const entries=page.map(row=>{
    let metadata=null;if(row.action==='memory.query'){try{metadata=JSON.parse(row.metadata_json||'null');}catch{metadata=null;}}
    const target=row.target_type==='memory'?id(row.target_id):null;want(target);
    const query=row.action==='memory.query'?queryProvenance(metadata):undefined;for(const ref of query?.result_refs||[])want(ref);
    return {audit_id:row.audit_id,created_at:row.created_at,action:row.action,kind:auditKind(row.action),outcome:row.outcome,
      target_type:row.target_type,target_id:row.target_type==='memory'?target:id(row.target_id),credential_id:id(row.credential_id),...(query?{query}:{})};
  });
  // Recorded credentials of this owner only: issuance attributes plus current revocation state.
  const credentialIds=[...new Set(entries.map(e=>e.credential_id).filter(Boolean))],credentials=Object.create(null);
  for(let i=0;i<credentialIds.length;i+=100){const chunk=credentialIds.slice(i,i+100);
    for(const c of db.prepare(`SELECT credential_id,label,agent_id,device_id,agent_instance_id,revoked_at FROM credentials WHERE user_id=? AND credential_id IN (${chunk.map(()=>'?').join(',')})`).all(user,...chunk))
      credentials[c.credential_id]={label:clip(c.label),agent_id:id(c.agent_id),device_id:id(c.device_id),agent_instance_id:id(c.agent_instance_id),revoked:c.revoked_at!==null};}
  // Current titles for memories the owner can read now; a corrupt lifecycle state throws here (fail closed).
  const memories=Object.create(null),ids=[...wanted];
  if(ids.length){const own=store.lifecycle.live(user).sql('project_id');
    for(let i=0;i<ids.length;i+=100){const chunk=ids.slice(i,i+100);
      for(const m of db.prepare(`SELECT memory_id,content,topic,status FROM memories WHERE user_id=? AND memory_id IN (${chunk.map(()=>'?').join(',')}) AND ${own.sql}`).all(user,...chunk,...own.params))
        memories[m.memory_id]={title:clip(memoryPresentation(m).title),status:m.status};}}
  return {read_only:true,source:'core',entries,credentials,memories,memory_titles_truncated:memoryTruncated,offset,limit,next_offset:rows.length>limit?offset+limit:null};
}

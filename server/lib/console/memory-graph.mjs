import {ValidationError} from '../errors.mjs';
import {MEMORY_KINDS} from '../memory/traits.mjs';
import {normalizeConcept} from '../search-query.mjs';
import {resolveMemoryScope,SCOPE_LIFECYCLE} from '../memory-scope.mjs';

// The overview is a keyword co-occurrence map, not an inferred entity/identity graph. Its metadata-only snapshot
// fits below the Console's 256 KiB response ceiling even with long CJK labels. Filters run before either bound.
export const GRAPH_MEMORY_LIMIT=1000;
export const GRAPH_RESPONSE_BYTES=180*1024;
export const GRAPH_NEIGHBOR_LIMIT=50;
export const GRAPH_KINDS=Object.freeze([...MEMORY_KINDS,'none']);
export const graphFold=normalizeConcept;
const invalid=()=>{throw new ValidationError('Invalid memory graph filter.','INVALID_CONSOLE_INPUT');};

function filters(p){
  const raw=p.graph_days===undefined?30:p.graph_days;
  if((typeof raw!=='number'&&typeof raw!=='string')||(typeof raw==='string'&&!/^(0|[1-9]\d{0,3})$/.test(raw)))invalid();
  const days=Number(raw);if(!Number.isInteger(days)||days<0||days>3650)invalid();
  let kinds=[...GRAPH_KINDS];
  if(p.graph_kinds!==undefined){
    if(typeof p.graph_kinds!=='string'||p.graph_kinds.length>200)invalid();
    const requested=p.graph_kinds.split(',');
    if(!requested.length||requested.some(k=>!GRAPH_KINDS.includes(k)))invalid();
    kinds=GRAPH_KINDS.filter(k=>requested.includes(k));
  }
  if(p.graph_query!==undefined&&(typeof p.graph_query!=='string'||[...p.graph_query].length>200||/[\u0000-\u001f\u007f]/u.test(p.graph_query)))invalid();
  const query=(p.graph_query||'').replace(/\s+/gu,' ').trim();
  const exact=name=>{if(p[name]===undefined)return null;if(typeof p[name]!=='string'||![...p[name]].length||[...p[name]].length>200||/[\u0000-\u001f\u007f]/u.test(p[name]))invalid();const value=graphFold(p[name]);if(!value)invalid();return value;};
  const focus=exact('graph_focus'),peer=exact('graph_peer');
  if(peer&&(!focus||peer===focus))invalid();
  if(p.graph_history!==undefined&&!['0','1'].includes(p.graph_history))invalid();
  const pageNumber=(name,fallback,max)=>{const raw=p[name]??fallback;if(typeof raw!=='number'&&!(typeof raw==='string'&&/^(0|[1-9]\d*)$/.test(raw)))invalid();const value=Number(raw);if(!Number.isSafeInteger(value)||value<0||value>max)invalid();return value;};
  const offset=pageNumber('graph_offset',0,1000000),limit=pageNumber('graph_limit',10,50);if(!limit)invalid();
  if(!focus&&['graph_peer','graph_history','graph_offset','graph_limit'].some(key=>p[key]!==undefined))invalid();
  return {days,kinds,query,focus,peer,offset,limit,history:p.graph_history==='1'};
}
const concepts=raw=>{
  try{const values=JSON.parse(raw||'[]');return Array.isArray(values)?values.filter(v=>typeof v==='string'&&v.trim()).slice(0,8):[];}
  catch{return [];}
};

/** One owner/live snapshot. No body, source quote, foreign metadata or inferred entity relationship is returned. */
export function memoryGraph(service,auth,p={},now=Date.now()){
  const f=filters(p),{days,kinds,query}=f,asOf=new Date(now).toISOString();
  const db=service.db,user=auth.user_id,live=service.store.lifecycle.live(user).sql('m.project_id');
  const scope=resolveMemoryScope(db,user,{project_id:p.graph_project_id,task_id:p.graph_task_id},{lifecycle:service.store.lifecycle});
  // Map filters mean records assigned to this project/task, not contextual recall's inherited user memories.
  // Resolve first to enforce owner checks, deleted-project refusal and canonical merged member sets.
  const members=scope[SCOPE_LIFECYCLE].members;
  const scoped=`(? IS NULL OR m.project_id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR m.task_id=?)`;
  const scopedParams=[members?1:null,JSON.stringify(members||[]),scope.task_id,scope.task_id];
  const from=`FROM memories m LEFT JOIN memory_traits t ON t.user_id=m.user_id AND t.memory_id=m.memory_id`;
  const active=`m.user_id=? AND m.status='active' AND ${live.sql}`,activeParams=[user,...live.params];
  // Old databases may contain malformed/legacy traits; a read never mutates them or lets a bad JSON value crash
  // the account's overview. The normal writer already enforces at most eight nonempty, bounded keywords.
  const safeConcepts=`CASE WHEN json_valid(t.concepts_json) AND json_type(t.concepts_json)='array' THEN t.concepts_json ELSE '[]' END`;
  const kind=`CASE WHEN t.kind IN (${MEMORY_KINDS.map(k=>`'${k}'`).join(',')}) THEN t.kind ELSE 'none' END`;
  const activity=`max(m.created_at,COALESCE(m.updated_at,''),COALESCE(t.updated_at,''))`;
  const totals=db.prepare(`SELECT count(*) active_total,COALESCE(sum(EXISTS(SELECT 1 FROM json_each(${safeConcepts}) c WHERE c.type='text' AND length(trim(c.value))>0)),0) active_with_concepts ${from} WHERE ${active}`).get(...activeParams);
  const cutoff=days?new Date(now-(days-1)*86400000).toISOString().slice(0,10):null,needle=query?graphFold(query):null;
  const metadata=`${scoped} AND (? IS NULL OR substr(${activity},1,10)>=?)
    AND (? IS NULL OR instr(memory_graph_fold(m.topic),?)>0 OR EXISTS
      (SELECT 1 FROM json_each(${safeConcepts}) c WHERE c.type='text' AND instr(memory_graph_fold(c.value),?)>0))
    AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(${safeConcepts}) c WHERE c.type='text' AND memory_graph_fold(c.value)=?))`;
  const metadataParams=[...scopedParams,cutoff,cutoff,needle,needle,needle,f.focus,f.focus];
  const filtered=`${active} AND ${metadata}`,filterParams=[...activeParams,...metadataParams];
  // Type counts ignore only the type filter, so a hidden type remains reachable in the legend. All other counts
  // use precisely the same owner, lifecycle, date and metadata-search filters as the records, before LIMIT.
  const kindCounts=Object.fromEntries(GRAPH_KINDS.map(k=>[k,0]));
  for(const row of db.prepare(`SELECT ${kind} kind,count(*) n ${from} WHERE ${filtered} GROUP BY ${kind}`).all(...filterParams))kindCounts[row.kind]=row.n;
  const total=kinds.reduce((n,k)=>n+kindCounts[k],0);
  const rows=db.prepare(`SELECT m.memory_id id,${kind} kind,${safeConcepts} concepts_json,m.topic,substr(${activity},1,10) day
    ${from} WHERE ${filtered} AND ${kind} IN (SELECT value FROM json_each(?))
    ORDER BY ${activity} DESC,m.memory_id LIMIT ?`).all(...filterParams,JSON.stringify(kinds),GRAPH_MEMORY_LIMIT);
  const graph={memories:[],entities:[],links:[],scope:{days,kinds,query,time_basis:'latest_activity',as_of:asOf,
    project_id:scope.project_id,task_id:scope.task_id,project_members:members,includes_shared_user:false,focus:f.focus},
    ...totals,kind_counts:kindCounts,filtered_total:total,returned:0,truncated:total>rows.length,truncation_reason:total>rows.length?'record_limit':null};
  if(f.focus){
    // Entire authorized, filtered library, not the overview's newest 1000. DISTINCT removes duplicate spelling
    // variants inside a memory; a keyword pair is still co-occurrence evidence, never an asserted entity edge.
    const base=`m.user_id=? AND m.status IN ('active','superseded') AND ${live.sql} AND ${metadata}
      AND ${kind} IN (SELECT value FROM json_each(?))`;
    const args=[user,...live.params,...metadataParams,JSON.stringify(kinds)];
    const summary=where=>db.prepare(`SELECT count(*) total,COALESCE(sum(m.status='active'),0) current_count,
      COALESCE(sum(m.status='superseded'),0) history_count,min(m.created_at) first_seen,max(${activity}) last_changed ${from} WHERE ${where}`);
    const own=summary(base).get(...args);
    const boundedLabel=`length(c.value)<=200 AND length(memory_graph_fold(c.value)) BETWEEN 1 AND 200`;
    // Legacy/imported traits can bypass today's writer bounds. Never let their labels bypass the response cap,
    // and disclose omitted labels rather than truncating one into a different (apparently exact) keyword.
    const omittedLabels=db.prepare(`SELECT count(*) records ${from} WHERE ${base} AND EXISTS
      (SELECT 1 FROM json_each(${safeConcepts}) c WHERE c.type='text' AND length(trim(c.value))>0 AND NOT (${boundedLabel}))`).get(...args).records;
    const neighborRows=db.prepare(`WITH pairs AS (SELECT DISTINCT m.memory_id,m.status,m.created_at,${activity} activity,
      memory_graph_fold(c.value) keyword,c.value label ${from},json_each(${safeConcepts}) c
      WHERE ${base} AND c.type='text' AND length(trim(c.value))>0 AND ${boundedLabel} AND memory_graph_fold(c.value)<>?)
      SELECT keyword,min(label) label,count(*) records,COALESCE(sum(status='active'),0) current_count,
      COALESCE(sum(status='superseded'),0) history_count,min(created_at) first_seen,max(activity) last_changed
      FROM (SELECT memory_id,status,created_at,activity,keyword,min(label) label FROM pairs GROUP BY memory_id,keyword)
      GROUP BY keyword ORDER BY current_count DESC,records DESC,keyword LIMIT ?`).all(...args,f.focus,GRAPH_NEIGHBOR_LIMIT+1);
    const peerSql=`(? IS NULL OR EXISTS(SELECT 1 FROM json_each(${safeConcepts}) c WHERE c.type='text' AND memory_graph_fold(c.value)=?))`;
    const peerArgs=[...args,f.peer,f.peer],pair=summary(`${base} AND ${peerSql}`).get(...peerArgs);
    const evidence=db.prepare(`SELECT m.memory_id,${kind} kind,CASE WHEN length(m.topic)<=120 THEN m.topic END topic,
      COALESCE(length(m.topic)>120,0) topic_omitted,m.status,m.created_at,${activity} updated_at,
      (SELECT max(revision) FROM memory_revisions r WHERE r.user_id=m.user_id AND r.memory_id=m.memory_id) revision,
      m.supersedes_memory_id,m.superseded_by_memory_id
      ${from} WHERE ${base} AND ${peerSql} AND (?=1 OR m.status='active')
      ORDER BY ${activity} DESC,m.memory_id LIMIT ? OFFSET ?`).all(...peerArgs,f.history?1:0,f.limit+1,f.offset);
    // Only expose lineage IDs when their own record is still readable to this owner. Details/source evidence are
    // opened through the normal memory detail/version endpoints, which revalidate the record at read time.
    const lineage=memoryId=>memoryId?db.prepare(`SELECT memory_id FROM memories m WHERE m.user_id=? AND m.memory_id=? AND ${live.sql}`).get(user,memoryId,...live.params)?.memory_id||null:null;
    graph.neighborhood={kind:'keyword_cooccurrence',focus:f.focus,peer:f.peer,...own,neighbors:neighborRows.slice(0,GRAPH_NEIGHBOR_LIMIT),
      neighbors_truncated:neighborRows.length>GRAPH_NEIGHBOR_LIMIT,neighbor_limit:GRAPH_NEIGHBOR_LIMIT,neighbor_labels_omitted_records:omittedLabels,
      evidence:{...pair,total:f.history?pair.total:pair.current_count,include_history:f.history,offset:f.offset,limit:f.limit,
        items:evidence.slice(0,f.limit).map(row=>({...row,supersedes_memory_id:lineage(row.supersedes_memory_id),superseded_by_memory_id:lineage(row.superseded_by_memory_id)})),
        next_offset:evidence.length>f.limit?f.offset+f.limit:null},counts_basis:'all_authorized_filtered_records',history_basis:'superseded_records',retracted_excluded:true};
  }
  // Reserve the metadata and an extra 128 bytes for the final numeric counts and reason. Never clip a label or
  // return invalid UTF-8/JSON to squeeze a record in: omit whole records and make that limit visible instead.
  let bytes=Buffer.byteLength(JSON.stringify(graph))+128;
  for(const row of rows){
    const node={id:row.id,kind:row.kind==='none'?null:row.kind,concepts:concepts(row.concepts_json),topic:row.topic||null,day:row.day||null};
    const added=Buffer.byteLength(JSON.stringify(node))+(graph.memories.length?1:0);
    if(bytes+added>GRAPH_RESPONSE_BYTES){graph.truncated=true;graph.truncation_reason='response_budget';break;}
    graph.memories.push(node);bytes+=added;
  }
  graph.returned=graph.memories.length;
  return graph;
}

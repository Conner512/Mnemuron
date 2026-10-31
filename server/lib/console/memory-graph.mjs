import {ValidationError} from '../errors.mjs';
import {MEMORY_KINDS} from '../memory/traits.mjs';
import {normalizeConcept} from '../search-query.mjs';

// The overview is a keyword co-occurrence map, not an inferred entity/identity graph. Its metadata-only snapshot
// fits below the Console's 256 KiB response ceiling even with long CJK labels. Filters run before either bound.
export const GRAPH_MEMORY_LIMIT=1000;
export const GRAPH_RESPONSE_BYTES=180*1024;
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
  return {days,kinds,query};
}
const concepts=raw=>{
  try{const values=JSON.parse(raw||'[]');return Array.isArray(values)?values.filter(v=>typeof v==='string'&&v.trim()).slice(0,8):[];}
  catch{return [];}
};

/** One owner/live snapshot. No body, source quote, foreign metadata or inferred entity relationship is returned. */
export function memoryGraph(service,auth,p={},now=Date.now()){
  const {days,kinds,query}=filters(p),asOf=new Date(now).toISOString();
  const db=service.db,user=auth.user_id,live=service.store.lifecycle.live(user).sql('m.project_id');
  const from=`FROM memories m LEFT JOIN memory_traits t ON t.user_id=m.user_id AND t.memory_id=m.memory_id`;
  const active=`m.user_id=? AND m.status='active' AND ${live.sql}`,activeParams=[user,...live.params];
  // Old databases may contain malformed/legacy traits; a read never mutates them or lets a bad JSON value crash
  // the account's overview. The normal writer already enforces at most eight nonempty, bounded keywords.
  const safeConcepts=`CASE WHEN json_valid(t.concepts_json) AND json_type(t.concepts_json)='array' THEN t.concepts_json ELSE '[]' END`;
  const kind=`CASE WHEN t.kind IN (${MEMORY_KINDS.map(k=>`'${k}'`).join(',')}) THEN t.kind ELSE 'none' END`;
  const activity=`max(m.created_at,COALESCE(m.updated_at,''),COALESCE(t.updated_at,''))`;
  const totals=db.prepare(`SELECT count(*) active_total,COALESCE(sum(EXISTS(SELECT 1 FROM json_each(${safeConcepts}) c WHERE c.type='text' AND length(trim(c.value))>0)),0) active_with_concepts ${from} WHERE ${active}`).get(...activeParams);
  const cutoff=days?new Date(now-(days-1)*86400000).toISOString().slice(0,10):null,needle=query?graphFold(query):null;
  const filtered=`${active} AND (? IS NULL OR substr(${activity},1,10)>=?)
    AND (? IS NULL OR instr(memory_graph_fold(m.topic),?)>0 OR EXISTS
      (SELECT 1 FROM json_each(${safeConcepts}) c WHERE c.type='text' AND instr(memory_graph_fold(c.value),?)>0))`;
  const filterParams=[...activeParams,cutoff,cutoff,needle,needle,needle];
  // Type counts ignore only the type filter, so a hidden type remains reachable in the legend. All other counts
  // use precisely the same owner, lifecycle, date and metadata-search filters as the records, before LIMIT.
  const kindCounts=Object.fromEntries(GRAPH_KINDS.map(k=>[k,0]));
  for(const row of db.prepare(`SELECT ${kind} kind,count(*) n ${from} WHERE ${filtered} GROUP BY ${kind}`).all(...filterParams))kindCounts[row.kind]=row.n;
  const total=kinds.reduce((n,k)=>n+kindCounts[k],0);
  const rows=db.prepare(`SELECT m.memory_id id,${kind} kind,${safeConcepts} concepts_json,m.topic,substr(${activity},1,10) day
    ${from} WHERE ${filtered} AND ${kind} IN (SELECT value FROM json_each(?))
    ORDER BY ${activity} DESC,m.memory_id LIMIT ?`).all(...filterParams,JSON.stringify(kinds),GRAPH_MEMORY_LIMIT);
  const graph={memories:[],entities:[],links:[],scope:{days,kinds,query,time_basis:'latest_activity',as_of:asOf},
    ...totals,kind_counts:kindCounts,filtered_total:total,returned:0,truncated:total>rows.length,truncation_reason:total>rows.length?'record_limit':null};
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

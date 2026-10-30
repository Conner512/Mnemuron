import {mkdtempSync,writeFileSync,statSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {MnemuronStore} from '../store.mjs';
import {storageDoctor,realDestination} from '../storage-policy.mjs';
import {consoleRead} from '../console-read.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../../shared/console-contract.mjs';
import {fingerprint} from '../console/state.mjs';
import {qualityFixtureV3} from './fixture.mjs';
import {rankMetrics} from './quality.mjs';

/** Reuses the frozen v3 exact-query cases and metric definitions; adds offline workbench hard gates.
 * No configured database, provider, network service or user query is opened. */
export async function evaluateSearchWorkbench({output}={}){
 storageDoctor({evidence_dir:output});const destination=realDestination(output);
 if(!statSync(destination).isDirectory()||(statSync(destination).mode&0o077))throw new Error('PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');
 const run=mkdtempSync(path.join(destination,'synthetic-search-workbench-'));chmodSync(run,0o700);
 const fixture=qualityFixtureV3(),result={fixture_version:'synthetic-search-workbench-v1',reference_fixture:fixture.version,
  fixture_digest:fingerprint(fixture),synthetic_only:true,configured_database_opened:false,network_calls:0,
  model_quality:'not_run',ranking_changed:false,hard_gates:{},components:{}};
 const s=new MnemuronStore(path.join(run,'synthetic.sqlite3'),{memoryConfig:{config_version:'mnemuron-memory-first-v1',
  modules:{memory:{enabled:true},handoff:{enabled:false,existing_inflight_policy:'drain_before_disable'}},memory:{capture_extraction:{enabled:false}}}});
 const authFor=userId=>s.authenticate(s.issueCredential({userId,label:'Synthetic search workbench',deviceId:'synthetic-device',agentId:'mnemuron-console',agentInstanceId:'synthetic-search-workbench',scopes:[...CONSOLE_WRITE_SCOPES]}).api_key);
 try{
  const auth=authFor('synthetic-search-owner'),other=authFor('synthetic-search-other'),byId=new Map(),saved=new Map();
  for(const doc of fixture.documents){const memory=s.saveMemory(auth,{scope:'user',content:doc.content}).memory;byId.set(memory.memory_id,doc.id);saved.set(doc.id,memory);}
  const foreign=s.saveMemory(other,{scope:'user',content:fixture.documents.find(d=>d.id==='serial-short').content}).memory;byId.set(foreign.memory_id,'foreign-owner');
  const exact=fixture.queries.filter(row=>row.kind==='exact'),rankings={},responses=new Map();
  for(const query of exact){const response=await consoleRead(s,auth,'memories',{query:query.query,mode:'lexical',status:'active'});responses.set(query.id,response);rankings[query.id]=response.results.map(row=>byId.get(row.memory_id));}
  result.components.exact=rankMetrics(exact,rankings,['foreign-owner']);
  result.hard_gates.exact_top1=result.components.exact.top1>=fixture.thresholds.exact_top1;
  result.hard_gates.scope_isolation=result.components.exact.scope_leaks===0;
  result.hard_gates.near_identifier_exclusion=exact.every(query=>!rankings[query.id].some(id=>query.near.includes(id)));
  const source=responses.get('exact-serial'),target=source.results.find(row=>row.memory_id===saved.get('serial-short').memory_id),feedback=s.consoleService.searchFeedback;
  const request={search_token:source.feedback_context.token,memory_id:target.memory_id,revision:target.revision,feedback:'relevant'};
  feedback.apply(auth,request);feedback.apply(auth,request);
  result.hard_gates.feedback_deduplicated=feedback.read(auth,{}).total===1;
  result.hard_gates.feedback_owner_isolated=feedback.read(other,{}).total===0;
  const persisted=JSON.stringify(s.db.prepare('SELECT * FROM console_search_feedback').all());
  result.hard_gates.query_body_not_persisted=!persisted.includes('SN-EXAMPLE-0042')&&!Buffer.from(source.feedback_context.token.split('.')[0],'base64url').toString().includes('SN-EXAMPLE-0042');
  s.retractMemory(auth,target.memory_id,{reason:'Synthetic revision fencing check.'});
  try{feedback.apply(auth,request);result.hard_gates.stale_revision_refused=false;}catch(error){result.hard_gates.stale_revision_refused=error.errorCode==='MEMORY_VERSION_CHANGED';}
  const old='2020-01-01T00:00:00.000Z',older=[];
  s.memoryTransaction(()=>{for(let i=0;i<13;i++){
    const memory=s.saveMemory(auth,{scope:'user',content:`Synthetic old relationship ${i}.`,concepts:['Synthetic Router／A','Synthetic Link B']}).memory;older.push(memory.memory_id);
    s.db.prepare('UPDATE memories SET created_at=?,updated_at=? WHERE memory_id=?').run(old,old,memory.memory_id);
    s.db.prepare('UPDATE memory_traits SET updated_at=? WHERE user_id=? AND memory_id=?').run(old,auth.user_id,memory.memory_id);
   }
   for(let i=0;i<1002;i++)s.saveMemory(auth,{scope:'user',content:`Synthetic unrelated recent record ${i}.`,concepts:['Synthetic Noise']});});
  const graph=p=>s.consoleService.features.read(auth,'attention',{graph_days:'0',...p}).graph;
  result.hard_gates.overview_limit_truthful=graph({}).truncated===true&&graph({}).memories.every(row=>!older.includes(row.id));
  const n=graph({graph_focus:'Synthetic Router/A',graph_peer:'Synthetic Link B',graph_limit:'5'}).neighborhood;
  const ids=[];for(let offset=0;offset<13;offset+=5)ids.push(...graph({graph_focus:'Synthetic Router/A',graph_peer:'Synthetic Link B',graph_offset:String(offset),graph_limit:'5'}).neighborhood.evidence.items.map(row=>row.memory_id));
  result.hard_gates.older_pair_reachable=n.current_count===13&&n.neighbors[0].current_count===13&&n.evidence.total===13;
  result.hard_gates.evidence_pages_complete=new Set(ids).size===13&&ids.every(id=>older.includes(id));
  result.hard_gates.keyword_identifier_exact=graph({graph_focus:'Synthetic Router'}).neighborhood.total===0;
  result.components.graph={old_records:13,noise_records:1002,matching_records:n.current_count,paged_unique_records:new Set(ids).size,first_seen:n.first_seen};
 }catch(error){result.hard_gates.completed=false;result.error_code=error.errorCode||'SEARCH_WORKBENCH_EVALUATION_FAILED';}
 finally{s.close();}
 result.status=Object.values(result.hard_gates).every(Boolean)?'passed':'failed';
 const markdown=`# Synthetic search workbench quality\n\nStatus: **${result.status}**. Offline synthetic checks only; real model quality: **not run**.\n\nReference fixture: ${result.reference_fixture}. Original v3 gates are unchanged.\n\n| Check | Result |\n| --- | --- |\n${Object.entries(result.hard_gates).map(([key,value])=>`| ${key} | ${value?'PASS':'FAIL'} |`).join('\n')}\n\n## Exact-query metrics\n\nTop-1: ${result.components.exact?.top1??'not_run'}; MRR: ${result.components.exact?.mrr??'not_run'}; recall@5: ${result.components.exact?.recall_at_5??'not_run'}; scope leaks: ${result.components.exact?.scope_leaks??'not_run'}.\n\n## Scope\n\nNo provider calls, real user data, configured databases, reranking changes or query caches. Graph links mean keyword co-occurrence, not entity identity. To assess real model compression and vector retrieval, separately opt in to the existing memory-quality v3 harness.\n`;
 writeFileSync(path.join(run,'results.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
 writeFileSync(path.join(run,'results.md'),markdown,{flag:'wx',mode:0o600});
 return {run,...result};
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,existsSync,chmodSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {qualityFixture,qualityFixtureV2,qualityFixtureV3} from '../lib/memory-evaluation/fixture.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {evaluateQuality,rankMetrics,summaryMetrics} from '../lib/memory-evaluation/quality.mjs';
import {qualityCli} from '../bin/mnemuron-memory-quality.mjs';
import {profile} from './helpers/memory-models.mjs';
import {ModelError} from '../lib/model-providers/contracts.mjs';

function directory(t){const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-quality-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function models(dimensions=24){return {providers:Object.fromEntries(['organizer','embedder'].map(kind=>[kind,profile(kind,{protocol:'openai_compatible',base_url:'https://model.example.test/v1',
  ...(kind==='embedder'?{dimensions}:{}),limits:{...profile(kind).limits,batch_size:8},egress:{...profile(kind).egress,origins:['https://model.example.test'],addresses:['203.0.113.8']}})]))};}
function simulated({summary=null,classification=null,onCall=()=>{},edition='v1'}={}){
  const fixture=edition==='v3'?qualityFixtureV3():edition==='v2'?qualityFixtureV2():qualityFixture(),dimensions=edition!=='v1'?34:24,byContent=new Map(fixture.documents.map(d=>[d.content,d])),vectors=new Map(fixture.documents.map((d,i)=>[d.id,Array.from({length:dimensions},(_,n)=>Number(i===n))]));
  return async(p,route,body)=>{
    onCall(p,route,body);
    if(route==='/chat/completions'){
      const {input}=JSON.parse(body.messages[1].content);
      const results=input.sources.flatMap(s=>input.operation==='classification'?(classification?.(s) || {memory_id:s.memory_id,category:byContent.get(s.content).category,tags:[]}):
        (summary?.(s) || {memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content}));
      return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({results})}}]};
    }
    return {data:body.input.map((text,index)=>{
      if(edition!=='v1' && text==='FORBIDDEN_SYNTHETIC_DATA '+fixture.documents[0].content)return {index,embedding:Array.from({length:dimensions},(_,n)=>Number(n===32))};
      const ids=byContent.has(text)?[byContent.get(text).id]:fixture.queries.find(q=>q.query===text)?.expected;assert.ok(ids,'unexpected non-fixture egress');
      return {index,embedding:Array.from({length:dimensions},(_,n)=>ids.reduce((sum,id)=>sum+vectors.get(id)[n],0))};})};
  };
}
test('Q-03 Q-04: quality fixture freezes 24 documents, 16 queries, 8 summaries and long multilingual qualifications',()=>{
  const f=qualityFixture();assert.equal(f.documents.length,24);assert.equal(f.queries.length,16);assert.equal(f.summary_ids.length,8);
  assert.equal(new Set(f.documents.map(d=>d.id)).size,24);assert.equal(new Set(f.queries.map(q=>q.id)).size,16);
  assert.equal(f.documents.filter(d=>d.content.length>1024).length,2);assert.ok(f.documents.every(d=>d.content.length<=4096));
  assert.ok(f.queries.every(q=>q.expected.length && q.expected.every(id=>f.documents.some(d=>d.id===id))));
  assert.equal(f.thresholds.exact_top1,1);assert.equal(f.thresholds.critical_source_retention,1);
});

const compact=s=>s.content.length>1024?[{memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.indexOf('\n\n'),quote:s.content.split('\n\n')[0]},
  {memory_id:s.memory_id,revision:s.revision,start:s.content.lastIndexOf('\n\n')+2,end:s.content.length,quote:s.content.slice(s.content.lastIndexOf('\n\n')+2)}]:null;
function vectorFixture(root){
  writeFileSync(root+'/vector-key','synthetic-vector-key',{mode:0o600});
  const backend=new MockVectorStore(),config={enabled:true,protocol:'qdrant-rest-v1.19',base_url:'http://127.0.0.1:6333',collection_prefix:'synthetic',auth:{secret_file:root+'/vector-key'},
    egress:{approved:true,origins:['http://127.0.0.1:6333'],addresses:['127.0.0.1'],allow_private:true},timeouts:{request_ms:100},limits:{input_bytes:8000000,output_bytes:8000000}};
  const transport=async(p,route,body,options)=>{
    if(route==='/')return {version:'1.19.0'};
    const parts=route.split('/'),name=parts[2],collection=backend.collections.get(name);let result;
    if(parts[3]==='exists')result={exists:!!collection};
    else if(parts.length===3 && options.method==='DELETE'){backend.collections.delete(name);result=true;}
    else if(parts.length===3 && options.method==='PUT'){await backend.ensureCollection(name,{dimensions:body.vectors.size,distance:body.vectors.distance});result=true;}
    else if(parts.length===3)result={config:{params:{vectors:{size:collection.config.dimensions,distance:collection.config.distance}}}};
    else if(parts[3]?.startsWith('points?')){await backend.upsert(name,body.points);result=true;}
    else if(parts[4]==='query')result={points:(await backend.search(name,body.query,body.filter,body.limit)).map(({vector,...rest})=>rest)};
    else if(parts[4]==='scroll'){const page=await backend.scroll(name,body.offset);result={...page,points:page.points.map(({vector,...rest})=>rest)};}
    else if(parts[4]?.startsWith('delete?')){await backend.deleteByDocumentRevision(name,body.filter);result=true;}
    else throw Error('Unexpected fixture route');return {status:'ok',result};
  };return {backend,config,transport};
}
test('Q-03 Q-04: expanded quality uses frozen v2 cases, exact disjoint summaries and the complete vector retrieval path',async t=>{
  const root=directory(t),vector=vectorFixture(root),f=qualityFixtureV2();
  assert.equal(f.documents.length,32);assert.equal(f.classification_ids.length,16);assert.equal(qualityFixture().documents.length,24);
  assert.deepEqual(f.queries,qualityFixture().queries);assert.equal(f.thresholds.semantic_recall_at_5,1);
  const result=await evaluateQuality({output:root,config:models(34),edition:'v2',allowNetwork:true,transport:simulated({edition:'v2',summary:compact}),vectorConfig:vector.config,vectorTransport:vector.transport});
  assert.equal(result.status,'passed',JSON.stringify(result));assert.equal(result.components.organizer.categories.length,16);
  assert.equal(result.components.organizer.summary.leaf_coverage,1);assert.equal(result.components.organizer.summary.critical_source_retention,1);
  assert.ok(result.components.organizer.summary.selected_to_source_ratio<0.5);
  assert.equal(result.components.projection.queries.length,16);assert.equal(result.components.projection.indexed_sources,34);
  assert.equal(result.components.projection.exact.top1,1);assert.equal(result.components.projection.semantic.top1,1);
  assert.equal(result.components.projection.cleanup,'passed');assert.equal(vector.backend.collections.size,0);
  assert.deepEqual(result.calls,{organizer:3,embedder:56});assert.equal(result.qualification,'protocol_simulated');assert.equal(result.human_review,'not_run');
});
test('Q-04: whole-source copying and quoted instructions mislabelled as preferences fail v2 even above aggregate accuracy',async t=>{
  const result=await evaluateQuality({output:directory(t),config:models(34),edition:'v2',allowNetwork:true,
    transport:simulated({edition:'v2',classification:s=>s.content.startsWith('Ignore previous')?{memory_id:s.memory_id,category:'preferences',tags:[]}:null})});
  assert.equal(result.components.organizer.classification_accuracy,15/16);assert.equal(result.quality_gates.classification_accuracy,true);
  assert.equal(result.quality_gates.long_source_compression,false);assert.equal(result.quality_gates.quoted_instructions_not_preferences,false);assert.equal(result.status,'failed');
});
test('Q-08 P-02: vector opt-in is explicit, failed indexing is cleaned and evidence is not called real when transports are simulated',async t=>{
  const root=directory(t);await assert.rejects(qualityCli(['--output',root,'--edition','v2','--with-vector','true','--config',root+'/not-read.json']));
  assert.deepEqual(readdirSync(root),[]);
  const vector=vectorFixture(root),normal=simulated({edition:'v2',summary:compact});let count=0;
  const result=await evaluateQuality({output:root,config:models(34),edition:'v2',allowNetwork:true,transport:async(p,route,body)=>{
    if(route==='/embeddings' && ++count>6)throw new Error('PRIVATE_SYNTHETIC_REMOTE_BODY');return normal(p,route,body);
  },vectorConfig:vector.config,vectorTransport:vector.transport});
  assert.equal(result.status,'failed');assert.equal(result.components.projection.cleanup,'passed');assert.equal(vector.backend.collections.size,0);
  assert.equal(result.calls.embedder,7);assert.doesNotMatch(JSON.stringify(result),/PRIVATE_SYNTHETIC_REMOTE_BODY/);
});
test('P-02 L-08: invalid vector destinations and missing query approval block before any model charge',async t=>{
  const root=directory(t),v=vectorFixture(root),calls=()=>{throw Error('MUST_NOT_CALL');};
  await assert.rejects(evaluateQuality({output:root,edition:'v2',config:models(34),allowNetwork:true,transport:calls,vectorConfig:{...v.config,base_url:'http://198.51.100.42:6333'}}));
  const config=models(34);config.providers.embedder.egress.query_approved=false;
  await assert.rejects(evaluateQuality({output:root,edition:'v2',config,allowNetwork:true,transport:calls,vectorConfig:v.config}),e=>e.code==='QUERY_EGRESS_NOT_APPROVED');
  assert.deepEqual(readdirSync(root),['vector-key']);
});
test('Q-04: stricter v3 catches a unique warning inside repetitive background without rewriting v1/v2 goldens',async t=>{
  const before=qualityFixtureV2(),f=qualityFixtureV3();assert.deepEqual(f.documents.map(d=>d.content),before.documents.map(d=>d.content));
  const omitted=await evaluateQuality({output:directory(t),config:models(34),edition:'v3',allowNetwork:true,transport:simulated({edition:'v3',summary:compact})});
  assert.equal(omitted.status,'failed');assert.equal(omitted.components.organizer.summary.critical_source_retention,7/8);
  const retained=await evaluateQuality({output:directory(t),config:models(34),edition:'v3',allowNetwork:true,transport:simulated({edition:'v3',summary:s=>{
    const spans=compact(s);if(!s.content.startsWith('模拟存储'))return spans;
    const start=s.content.indexOf('第 1 项观测'),end=s.content.indexOf('\n',start);
    return [spans[0],{memory_id:s.memory_id,revision:s.revision,start,end,quote:s.content.slice(start,end)},spans[1]];
  }})});
  assert.equal(retained.status,'passed');assert.equal(retained.quality_gates.long_source_compression,true);assert.equal(retained.components.organizer.summary.critical_source_retention,1);
});
test('Q-03 Q-04: missing answers and contradictory excerpts cannot inflate retrieval or critical-fact scores',()=>{
  const queries=[{id:'one',kind:'semantic',expected:['a','b']},{id:'missing',kind:'semantic',expected:['c']}];
  const measured=rankMetrics(queries,{one:['forbidden','a','b']},['forbidden']);
  assert.equal(measured.top1,0);assert.equal(measured.mrr,0.25);assert.equal(measured.recall_at_5,0.5);assert.equal(measured.scope_leaks,1);
  const content='Production is approved in an obsolete memo. Production is NOT approved by the final decision.';
  const summary=summaryMetrics([{id:'x',content,critical:['Production is NOT approved']}],[{memory_id:'saved-x',revision:1,start:0,end:22,quote:content.slice(0,22),independently_fact_checked:false}],new Map([['saved-x','x']]));
  assert.equal(summary.unsupported_claims,0);assert.equal(summary.critical_source_retention,0);assert.equal(summary.leaf_coverage,1);
  assert.equal(summaryMetrics([{id:'x',content}],[],new Map()).leaf_coverage,0);
});
test('Q-03 C-02: offline quality opens only a new synthetic library, ignores config and never calls a provider',async t=>{
  const root=directory(t),result=await qualityCli(['--output',root,'--config',root+'/do-not-read.json']);
  assert.equal(result.status,'partial');assert.equal(result.model_quality,'not_run');assert.equal(result.hard_correctness,'passed');
  assert.equal(result.components.lexical.count,8);assert.equal(result.components.lexical.top1,1);assert.equal(result.hard_gates.no_handoff_state,true);
  assert.deepEqual(result.calls,{organizer:0,embedder:0});assert.equal(existsSync(root+'/do-not-read.json'),false);
  assert.ok(readdirSync(result.run).includes('preflight.json'));assert.equal(result.production_ready,false);
});
test('Q-04 Q-08: protocol-simulated quality scores and model call bounds are recorded independently of human and Qdrant acceptance',async t=>{
  const root=directory(t),config=models(),result=await evaluateQuality({output:root,config,allowNetwork:true,transport:simulated()});
  assert.equal(result.status,'passed');assert.equal(result.model_quality,'passed');assert.equal(result.hard_correctness,'passed');
  assert.equal(result.components.organizer.summary.critical_source_retention,1);assert.equal(result.components.embedder.semantic.top1,1);
  assert.equal(result.components.organizer.summary.full_source_quotes,8);assert.equal(result.components.organizer.summary.selected_to_source_ratio,1);
  assert.equal(result.components.organizer.summary.abstractive_summary,false);
  assert.deepEqual(result.calls,{organizer:2,embedder:5});assert.equal(result.qdrant,'not_run');assert.equal(result.human_review,'not_run');
  const preflight=JSON.parse(readFileSync(result.run+'/preflight.json','utf8'));assert.equal(preflight.fixture_digest,result.fixture_digest);
  assert.deepEqual(preflight.call_limits,result.calls);assert.equal(preflight.configured_database_opened,false);
  assert.equal(readdirSync(result.run).filter(n=>n.startsWith('call-')).length,7);
});
test('Q-04: a valid long-source quote which omits critical qualifications is a quality failure, not a passed JSON test',async t=>{
  const result=await evaluateQuality({output:directory(t),config:models(),allowNetwork:true,transport:simulated({summary:s=>s.content.length>1024?
    {memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.indexOf('\n\n'),quote:s.content.split('\n\n')[0]}:null})});
  assert.equal(result.hard_correctness,'passed');assert.equal(result.model_quality,'failed');assert.equal(result.status,'failed');
  assert.equal(result.components.organizer.summary.critical_source_retention,0.75);assert.equal(result.quality_gates.critical_source_retention,false);
  assert.equal(result.components.embedder.status,'passed');
});
test('Q-02: a failed organizer does not hide embedder evidence or leak untrusted exception bodies',async t=>{
  const root=directory(t),normal=simulated(),result=await evaluateQuality({output:root,config:models(),allowNetwork:true,transport:async(p,route,body)=>{
    if(route==='/chat/completions')throw new Error('SENSITIVE_SYNTHETIC_REMOTE_ERROR_BODY');return normal(p,route,body);
  }});
  assert.equal(result.status,'failed');assert.equal(result.components.embedder.status,'passed');assert.equal(result.components.organizer.status,'failed');
  for(const name of readdirSync(result.run).filter(n=>n.endsWith('.json')))assert.doesNotMatch(readFileSync(path.join(result.run,name),'utf8'),/SENSITIVE_SYNTHETIC_REMOTE_ERROR_BODY/);
});
test('L-08 Q-08: repairs and retries share a fixed request budget; missing providers are never marked passed',async t=>{
  const config=models();config.providers.organizer.retry.repair_once=true;
  const normal=simulated(),result=await evaluateQuality({output:directory(t),config,allowNetwork:true,transport:async(p,route,body)=>route==='/chat/completions'?{choices:[{finish_reason:'stop',message:{content:'invalid'}}]}:normal(p,route,body)});
  assert.equal(result.status,'failed');assert.equal(result.calls.organizer,2);assert.equal(result.calls.embedder,5);
  const missing=await evaluateQuality({output:directory(t),config:{providers:{organizer:{enabled:false},embedder:{enabled:false}}},allowNetwork:true,transport:()=>{throw new Error('must not call');}});
  assert.equal(missing.status,'partial');assert.equal(missing.model_quality,'not_run');assert.deepEqual(missing.calls,{organizer:0,embedder:0});
});
test('P-02 Q-08: evidence output requires a private directory outside source; argument errors have no side effects',async t=>{
  await assert.rejects(evaluateQuality({output:path.resolve(import.meta.dirname,'../..')}),e=>e.errorCode==='PRIVATE_PATH_IN_SOURCE');
  const root=directory(t);chmodSync(root,0o755);
  await assert.rejects(evaluateQuality({output:root}),e=>e instanceof ModelError && e.code==='PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');
  assert.deepEqual(readdirSync(root),[]);chmodSync(root,0o700);
  await assert.rejects(qualityCli(['--output',root,'--allow-network','yes']));assert.deepEqual(readdirSync(root),[]);
});

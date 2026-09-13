import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,readdirSync,chmodSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {evaluateJoint,jointFixture,jointConfig} from '../lib/memory-evaluation/joint.mjs';
import {jointCli} from '../bin/mnemuron-memory-joint.mjs';
import {profile} from './helpers/memory-models.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
function directory(t){const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-joint-contract-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
function config(root){
  writeFileSync(root+'/key.txt','synthetic-unused-vector-key',{mode:0o600});
  return {providers:Object.fromEntries(['organizer','embedder'].map(kind=>[kind,profile(kind,{protocol:'openai_compatible',base_url:'https://model.example.test/v1',
    retry:{max_attempts:1,base_ms:100,max_ms:100,repair_once:false},...(kind==='embedder'?{dimensions:8}:{}),egress:{...profile(kind).egress,origins:['https://model.example.test'],addresses:['203.0.113.8']}})])),
    vector_store:{enabled:true,protocol:'qdrant-rest-v1.19',base_url:'http://127.0.0.1:6333',collection_prefix:'synthetic',auth:{secret_file:root+'/key.txt'},
      egress:{approved:true,origins:['http://127.0.0.1:6333'],addresses:['127.0.0.1'],allow_private:true},timeouts:{request_ms:100},limits:{input_bytes:8000000,output_bytes:8000000}}};
}
function simulated({badSummary=false,badRanking=false,onCall=()=>{}}={}){
  const fixture=jointFixture(),documents=[...fixture.documents,...fixture.guards.filter(d=>d.kind!=='secret')],backend=new MockVectorStore();
  const modelTransport=async(p,route,body)=>{
    onCall(p,route,body);
    if(route==='/chat/completions'){
      const {input}=JSON.parse(body.messages[1].content),sources=badSummary && input.operation==='summary'?input.sources.slice(1):input.sources;
      const results=sources.map(s=>input.operation==='classification'?{memory_id:s.memory_id,category:'engineering',tags:[]}:
        {memory_id:s.memory_id,revision:s.revision,start:0,end:s.content.length,quote:s.content});
      return {choices:[{finish_reason:'stop',message:{content:JSON.stringify({results})}}]};
    }
    return {data:body.input.map((text,index)=>{
      let target=documents.findIndex(d=>d.content===text);
      if(target<0){const query=fixture.queries.find(q=>q.query===text);target=documents.findIndex(d=>d.id===(query?.expected[0] || 'release'));if(badRanking)target=4;}
      assert.ok(target>=0,'unexpected source egress');return {index,embedding:Array.from({length:8},(_,n)=>Number(n===target))};
    })};
  };
  const vectorTransport=async(p,route,body,options)=>{
    if(route==='/')return {version:'1.19.0'};
    const parts=route.split('/'),name=parts[2],collection=backend.collections.get(name);let result;
    if(parts[3]==='exists')result={exists:!!collection};
    else if(parts.length===3 && options.method==='PUT'){await backend.ensureCollection(name,{dimensions:body.vectors.size,distance:body.vectors.distance});result=true;}
    else if(parts.length===3)result={config:{params:{vectors:{size:collection.config.dimensions,distance:collection.config.distance}}}};
    else if(parts[3]?.startsWith('points?')){await backend.upsert(name,body.points);result=true;}
    else if(parts[4]==='query'){result={points:(await backend.search(name,body.query,body.filter,body.limit)).map(({vector,...rest})=>rest)};}
    else if(parts[4]==='scroll'){const page=await backend.scroll(name,body.offset);result={...page,points:page.points.map(({vector,...rest})=>rest)};}
    else if(parts[4]?.startsWith('delete?')){await backend.deleteByDocumentRevision(name,body.filter);result=true;}
    else throw new Error('unknown mock vector route');
    return {status:'ok',result};
  };
  return {modelTransport,vectorTransport};
}
test('Q-09: joint approval gate precedes config access; no implicit production storage or mock model',async t=>{
  const root=directory(t);await assert.rejects(evaluateJoint({get config(){throw new Error('must not read');}}),e=>e.code==='NETWORK_NOT_ALLOWED');
  await assert.rejects(jointCli(['--output',root,'--config',root+'/must-not-read.json']),e=>e.code==='NETWORK_NOT_ALLOWED');assert.deepEqual(readdirSync(root),[]);
  const cfg=config(root);assert.throws(()=>jointConfig({...cfg,storage:{sqlite_path:'/private/not-opened.sqlite3'}}));
  cfg.providers.embedder.protocol='mock';assert.throws(()=>jointConfig(cfg));
});
test('Q-09: frozen joint protocol exercises classification, summary, vector retrieval, detail and stale-vector retraction',async t=>{
  const root=directory(t),result=await evaluateJoint({output:root,config:config(root),allowNetwork:true,...simulated()});
  assert.equal(result.status,'passed',JSON.stringify(result.cases));assert.equal(result.cases.length,14);
  assert.equal(result.qualification,'protocol_simulated');assert.deepEqual(result.calls,{organizer:2,embedder:12});
  assert.equal(result.retrieval.top1,1);assert.equal(result.retrieval.scope_leaks,0);assert.equal(result.summary.leaf_coverage,1);
  assert.equal(result.summary.selected_to_source_ratio,1);assert.equal(result.summary.abstractive_summary,false);
  assert.equal(result.production_ready,false);assert.equal(result.configured_database_opened,false);
  assert.equal(readdirSync(result.run).filter(f=>f.startsWith('call-')).length,14);
  assert.equal(JSON.parse(readFileSync(result.run+'/preflight.json','utf8')).fixture_digest,result.fixture_digest);
});
test('Q-09: dropped summary leaves and irrelevant semantic hits fail quality even with valid protocol responses',async t=>{
  for(const patch of [{badSummary:true},{badRanking:true}]){
    const root=directory(t),result=await evaluateJoint({output:root,config:config(root),allowNetwork:true,...simulated(patch)});
    assert.equal(result.status,'failed');assert.ok(result.cases.some(c=>c.name===(patch.badSummary?'grounded_summary':'retrieval_and_detail') && c.status==='failed'));
    assert.ok(result.calls.organizer<=2 && result.calls.embedder<=12);
  }
});
test('Q-09: private output, fixed model budget and explicit sensitive-query egress cannot be bypassed',async t=>{
  const root=directory(t),cfg=config(root);
  for(const change of [p=>p.retry.repair_once=true,p=>p.retry.max_attempts=2,p=>p.limits.daily_requests=1]){
    const bad=structuredClone(cfg);change(bad.providers.organizer);assert.throws(()=>jointConfig(bad),e=>e.code==='JOINT_BUDGET_OR_POLICY_INVALID');
  }
  const denied=structuredClone(cfg);denied.providers.embedder.egress.sensitivities=['public'];assert.throws(()=>jointConfig(denied),e=>e.code==='QUERY_EGRESS_NOT_APPROVED');
  chmodSync(root,0o755);await assert.rejects(evaluateJoint({output:root,config:cfg,allowNetwork:true}),e=>e.code==='PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');chmodSync(root,0o700);
  await assert.rejects(evaluateJoint({output:path.resolve(import.meta.dirname,'../..'),config:cfg,allowNetwork:true}),e=>e.errorCode==='PRIVATE_PATH_IN_SOURCE');
  const filename=root+'/config.json';writeFileSync(filename,JSON.stringify(cfg),{mode:0o600});chmodSync(filename,0o644);
  await assert.rejects(jointCli(['--output',root,'--config',filename,'--allow-network','true']),e=>e.code==='PRIVATE_CONFIG_REQUIRED');
});
test('Q-09: network failures consume the bounded ledger without publishing response bodies or credentials',async t=>{
  const root=directory(t),cfg=config(root),mocks=simulated();
  const result=await evaluateJoint({output:root,config:cfg,allowNetwork:true,...mocks,modelTransport:async()=>{throw new Error('SENSITIVE_SYNTHETIC_ERROR_BODY');}});
  assert.equal(result.status,'failed');assert.ok(result.calls.organizer<=2 && result.calls.embedder<=12);assert.ok(result.calls.organizer>0);
  for(const filename of readdirSync(result.run).filter(f=>f.endsWith('.json')))assert.doesNotMatch(readFileSync(result.run+'/'+filename,'utf8'),/SENSITIVE_SYNTHETIC_ERROR_BODY|synthetic-unused-vector-key/);
});

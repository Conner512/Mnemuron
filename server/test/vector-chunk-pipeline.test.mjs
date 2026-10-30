import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,embedder,profile,taxonomy} from './helpers/memory-models.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {VectorIndex,surrogate,VECTOR_GROUP_QUERY_ATTEMPTS} from '../lib/vector-stores/index.mjs';
import {documentChunks} from '../lib/vector-stores/chunks.mjs';
import {QdrantStore,QDRANT_PROTOCOL} from '../lib/vector-stores/qdrant.mjs';
import {digest} from '../lib/model-providers/contracts.mjs';

const isCode=code=>error=>error.code===code;
const limits=patch=>({...profile('embedder').limits,...patch});
const document=(f,g,m)=>f.s.db.prepare('SELECT * FROM memory_vector_documents WHERE generation=? AND user_id=? AND memory_id=?').get(g,f.auth.user_id,m.memory_id);
const mappings=(f,g,m)=>f.s.db.prepare('SELECT * FROM memory_vector_points WHERE generation=? AND user_id=? AND memory_id=? ORDER BY chunk').all(g,f.auth.user_id,m.memory_id);
const points=(backend,g,index)=>[...backend.collections.get(index.db.prepare('SELECT collection_name FROM memory_vector_generations WHERE generation=?').get(g).collection_name).points.values()];

for(const mode of ['full','manifest']){
  test(`vector ${mode}: complete Unicode and JSON-escaped content fits each actual embedding request`,async t=>{
    const f=fixture(t),batches=[],prefix='passage: "synthetic" \\ ';
    const e=embedder(texts=>{batches.push(texts);return texts.map(()=>[1,0,0]);},{document_prefix:prefix,
      limits:limits({input_bytes:1024,input_tokens:1500,batch_size:8})});
    const backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]),{ownerId:mode==='manifest'?f.auth.user_id:null});
    const m=f.save('界🙂"\\\n路由 network '.repeat(170)),source=f.s.derivedMemory.currentSource(f.auth.user_id,m.memory_id);
    const g=index.begin(e.profile.fingerprint,mode==='manifest'?{manifest:[source]}:{});
    assert.equal((await index.sync(g)).complete,true);
    assert.equal(batches.flat().map(text=>text.slice(prefix.length)).join(''),m.content);
    assert.ok(batches.every(batch=>batch.length<=8&&e.measureRequest(batch.map(text=>text.slice(prefix.length)),'document').fits));
    assert.equal(document(f,g,m).state,'indexed');assert.equal(mappings(f,g,m).length,batches.flat().length);
    const calls=batches.length;await index.sync(g);assert.equal(batches.length,calls,'completed chunks are not embedded again');
  });

  test(`vector ${mode}: backend-confirmed chunks survive daily-budget exhaustion and publish only the full document`,async t=>{
    const f=fixture(t),seen=[];let now=Date.parse('2026-10-30T01:00:00Z');
    const e=embedder(texts=>{seen.push(...texts);return texts.map(()=>[1,0,0]);},{limits:limits({input_bytes:128,input_tokens:128,batch_size:1,daily_requests:1})});
    const backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]),{clock:()=>now,ownerId:mode==='manifest'?f.auth.user_id:null});
    const m=f.save('BEGIN '+ 'x'.repeat(96)+' MIDDLE '+ 'y'.repeat(96)+' END'),source=f.s.derivedMemory.currentSource(f.auth.user_id,m.memory_id);
    const g=index.begin(e.profile.fingerprint,mode==='manifest'?{manifest:[source]}:{}),planned=documentChunks(e,m.content).chunks.length;
    await assert.rejects(index.sync(g),isCode('BUDGET_EXHAUSTED'));
    assert.equal(document(f,g,m).state,'building');assert.equal(mappings(f,g,m).length,1);assert.equal(points(backend,g,index).length,1);
    assert.ok(points(backend,g,index).every(point=>point.payload.lifecycle==='building'),'confirmed prefixes remain remotely unpublished');
    if(mode==='manifest')assert.equal(index.manifest(g)[0].state,'pending');
    let complete=false;
    for(let day=1;day<=planned&&!complete;day++){
      now+=86400000;
      try{complete=(await index.sync(g)).complete;}catch(error){assert.equal(error.code,'BUDGET_EXHAUSTED');}
    }
    assert.equal(complete,true);assert.equal(seen.join(''),m.content);assert.equal(seen.length,planned);
    assert.equal(document(f,g,m).state,'indexed');assert.equal(mappings(f,g,m).length,planned);
    assert.ok(points(backend,g,index).every(point=>point.payload.lifecycle==='active'));
    assert.ok(f.s.db.prepare('SELECT count FROM memory_vector_calls').all().every(row=>row.count===1));
    if(mode==='manifest')assert.equal(index.manifest(g)[0].state,'indexed');
  });
}

test('vector retry: successful batches survive a new index instance and do not pay again for their prefix',async t=>{
  const f=fixture(t),successful=[];let calls=0;
  const e=embedder(texts=>{if(++calls===2)throw Object.assign(new Error('Synthetic provider interruption'),{code:'NETWORK_ERROR'});
    successful.push(...texts);return texts.map(()=>[1,0,0]);},{limits:limits({input_bytes:180,input_tokens:180,batch_size:1})});
  const backend=new MockVectorStore(),providers=new Map([[e.profile.fingerprint,e]]);let index=new VectorIndex(f.s,backend,providers);
  const m=f.save('Unique first source marker '+ 'x'.repeat(220)+' unique final source marker'),g=index.begin(e.profile.fingerprint);
  await assert.rejects(index.sync(g),isCode('NETWORK_ERROR'));assert.equal(mappings(f,g,m).length,1);
  index=new VectorIndex(f.s,backend,providers);assert.equal((await index.sync(g)).complete,true);
  assert.equal(successful.join(''),m.content);assert.equal(document(f,g,m).state,'indexed');
  assert.equal(points(backend,g,index).length,documentChunks(e,m.content).chunks.length);
});

for(const changed of ['limits','source-state'])test(`vector retry: changed ${changed} cannot reuse an old chunk ordinal`,async t=>{
  const f=fixture(t),calls=[];let now=Date.parse('2026-10-30T01:00:00Z');
  const create=inputBytes=>embedder(texts=>{calls.push(...texts);return texts.map(()=>[1,0,0]);},{limits:limits({input_bytes:inputBytes,input_tokens:10000,batch_size:1,daily_requests:1})});
  let e=create(256);const backend=new MockVectorStore(),providers=new Map([[e.profile.fingerprint,e]]),index=new VectorIndex(f.s,backend,providers,{clock:()=>now});
  const m=f.save('Unchanged first marker '+ 'x'.repeat(400)+' ending'),g=index.begin(e.profile.fingerprint);
  await assert.rejects(index.sync(g),isCode('BUDGET_EXHAUSTED'));const old=mappings(f,g,m)[0],first=calls[0];
  if(changed==='limits'){
    const next=create(400);assert.equal(next.profile.fingerprint,e.profile.fingerprint,'limits do not change the model fingerprint');e=next;providers.set(e.profile.fingerprint,e);
  }else{
    const key=f.s.issueCredential({userId:f.auth.user_id,deviceId:'synthetic-organizer',agentId:'synthetic',agentInstanceId:'synthetic-organizer',scopes:['memory:organize']});
    f.s.derivedMemory.setCategory(f.s.authenticate(key.api_key),m.memory_id,'engineering',taxonomy);
    assert.equal(f.s.revisions.latest(f.auth.user_id,m.memory_id).revision,1,'a category override changes the source state without changing its revision');
  }
  const rebuilt=[];e.mock=texts=>{rebuilt.push(...texts);return texts.map(()=>[1,0,0]);};
  now+=86400000;await assert.rejects(index.sync(g),isCode('BUDGET_EXHAUSTED'));
  assert.ok(mappings(f,g,m).every(point=>point.point_id!==old.point_id));assert.ok(points(backend,g,index).every(point=>point.id!==old.point_id));
  assert.equal(changed==='limits'?rebuilt[0].length>first.length:rebuilt[0]===first,true);
  let complete=false;for(let day=0;day<30&&!complete;day++){now+=86400000;try{complete=(await index.sync(g)).complete;}catch(error){assert.equal(error.code,'BUDGET_EXHAUSTED');}}
  assert.equal(complete,true);assert.equal(rebuilt.join(''),m.content);assert.equal(document(f,g,m).state,'indexed');
});

test('vector catch-up: partially indexed memories cannot be searched or activate a generation',async t=>{
  const f=fixture(t);let now=Date.parse('2026-10-30T01:00:00Z');
  const e=embedder(texts=>texts.map(()=>[1,0,0]),{limits:limits({input_bytes:128,input_tokens:128,batch_size:1,daily_requests:2})});
  const backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]),{clock:()=>now,ownerId:f.auth.user_id});
  const g=index.begin(e.profile.fingerprint);await index.sync(g);index.activate(g);
  const m=f.save('network unfinished source '.repeat(20));await assert.rejects(index.catchUp(g),isCode('BUDGET_EXHAUSTED'));
  assert.equal(document(f,g,m).state,'building');assert.ok(points(backend,g,index).length>0);
  now+=86400000;
  const result=await index.search(f.auth,{query:'network',mode:'semantic'});assert.deepEqual(result.results,[]);
  index.deactivate(g);assert.throws(()=>index.activate(g),isCode('VECTOR_CATCHUP_REQUIRED'));
  f.s.retractMemory(f.auth,m.memory_id);
  assert.ok(index.catchUpPending(g).some(row=>row.memory_id===m.memory_id));
  await index.catchUp(g);assert.equal(document(f,g,m).state,'hidden');assert.equal(mappings(f,g,m).length,0);assert.equal(points(backend,g,index).length,0);
});

test('vector manifest retry: superseding a partial source never embeds a replacement outside its frozen manifest',async t=>{
  const f=fixture(t),seen=[];let now=Date.parse('2026-10-30T01:00:00Z');
  const e=embedder(texts=>{seen.push(...texts);return texts.map(()=>[1,0,0]);},{limits:limits({input_bytes:128,input_tokens:128,batch_size:1,daily_requests:1})});
  const backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]),{clock:()=>now,ownerId:f.auth.user_id});
  const m=f.save('network original frozen source '.repeat(12)),source=f.s.derivedMemory.currentSource(f.auth.user_id,m.memory_id),g=index.begin(e.profile.fingerprint,{manifest:[source]});
  await assert.rejects(index.sync(g),isCode('BUDGET_EXHAUSTED'));assert.equal(mappings(f,g,m).length,1);
  const replacement=f.s.supersedeMemory(f.auth,m.memory_id,{content:'A replacement outside the original manifest'}).replacement_memory;
  now+=86400000;assert.equal((await index.sync(g)).complete,true);
  assert.equal(seen.length,1);assert.equal(index.manifest(g)[0].state,'stale');assert.equal(points(backend,g,index).length,0);assert.equal(mappings(f,g,m).length,0);
  assert.equal(document(f,g,replacement),undefined);
});

test('vector grouped candidates: a long memory cannot fill the document window with its own chunks',async t=>{
  const f=fixture(t),e=embedder((texts,type)=>texts.map(text=>type==='query'||!text.includes('SECOND')?[1,0,0]:[0.95,0.3,0]),
    {limits:limits({input_bytes:110,input_tokens:110,batch_size:1})});
  const backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]));
  const long=f.save('network primary background '.repeat(145)),other=f.save('SECOND network decision.');
  const g=index.begin(e.profile.fingerprint);await index.sync(g);index.activate(g);
  assert.ok(points(backend,g,index).length>100,'the fixture really has more chunks than the backend window');
  const result=await index.search(f.auth,{query:'network',mode:'semantic',limit:5});
  assert.deepEqual(new Set(result.results.map(row=>row.memory_id)),new Set([long.memory_id,other.memory_id]));
  assert.equal(result.retrieval.semantic_candidates_truncated,false);
});

test('vector grouped retry reaches a current document after a full stale window and discloses the bounded window',async t=>{
  const f=fixture(t),e=embedder((texts,type)=>texts.map(text=>type==='query'||!text.includes('SECOND')?[1,0,0]:[0.95,0.3,0]));
  const backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]])),old=[];
  for(let i=0;i<100;i++)old.push(f.save(`network retired synthetic source ${i}`));
  const survivor=f.save('SECOND network active survivor'),g=index.begin(e.profile.fingerprint);await index.sync(g);index.activate(g);
  for(const m of old)f.s.retractMemory(f.auth,m.memory_id);
  const result=await index.search(f.auth,{query:'network',mode:'semantic',limit:5});
  assert.deepEqual(result.results.map(row=>row.memory_id),[survivor.memory_id]);assert.equal(result.retrieval.semantic_candidates,1);assert.equal(backend.searchCalls.length,2);
  assert.equal(result.retrieval.semantic_candidate_limit,100);assert.equal(result.retrieval.semantic_candidates_truncated,true);assert.equal(result.retrieval.result_truncated,true);
});

test('vector lost upsert response: a changed layout leaves its unknown prefix unpublished and recalls the rebuilt document',async t=>{
  const f=fixture(t),seen=[];
  const make=bytes=>embedder((texts,type)=>{if(type==='document')seen.push(...texts);return texts.map(()=>type==='query'?[1,0,0]:[0.95,0.3,0]);},
    {limits:limits({input_bytes:bytes,input_tokens:10000,batch_size:1})});
  let e=make(256);const backend=new MockVectorStore(),providers=new Map([[e.profile.fingerprint,e]]),index=new VectorIndex(f.s,backend,providers);
  const m=f.save('network original prefix '+ 'x'.repeat(400)+' complete source tail'),g=index.begin(e.profile.fingerprint),upsert=backend.upsert.bind(backend);let lost=false;
  backend.upsert=async(...args)=>{await upsert(...args);if(!lost){lost=true;throw Object.assign(new Error('Synthetic lost upsert acknowledgement'),{code:'NETWORK_ERROR'});}};
  await assert.rejects(index.sync(g),isCode('NETWORK_ERROR'));assert.equal(mappings(f,g,m).length,0);
  const orphan=points(backend,g,index)[0];assert.equal(orphan.payload.lifecycle,'building');
  e=make(400);assert.equal(e.profile.fingerprint,index.db.prepare('SELECT profile FROM memory_vector_generations WHERE generation=?').get(g).profile);providers.set(e.profile.fingerprint,e);
  const planned=documentChunks(e,m.content).chunks;assert.equal((await index.sync(g)).complete,true);index.activate(g);
  assert.equal(seen.length,planned.length+1);assert.equal(mappings(f,g,m).length,planned.length);
  const remote=points(backend,g,index);assert.equal(remote.find(point=>point.id===orphan.id).payload.lifecycle,'building');
  assert.ok(remote.filter(point=>point.id!==orphan.id).every(point=>point.payload.lifecycle==='active'&&point.payload.build!==orphan.payload.build));
  assert.deepEqual((await index.search(f.auth,{query:'network',mode:'semantic'})).results.map(row=>row.memory_id),[m.memory_id]);
});

for(const mode of ['full','manifest'])test(`vector ${mode}: a lost publication response retries the full checkpoint without another embedding call`,async t=>{
  const f=fixture(t);let modelCalls=0,publications=0;
  const e=embedder(texts=>{modelCalls++;return texts.map(()=>[1,0,0]);},{limits:limits({input_bytes:160,input_tokens:160,batch_size:1})});
  const backend=new MockVectorStore(),providers=new Map([[e.profile.fingerprint,e]]),options={ownerId:mode==='manifest'?f.auth.user_id:null};
  let index=new VectorIndex(f.s,backend,providers,options);const m=f.save('network complete source '.repeat(12)),source=f.s.derivedMemory.currentSource(f.auth.user_id,m.memory_id);
  const g=index.begin(e.profile.fingerprint,mode==='manifest'?{manifest:[source]}:{}),publish=backend.publishBuild.bind(backend);
  backend.publishBuild=async(...args)=>{await publish(...args);if(++publications===1)throw Object.assign(new Error('Synthetic lost publication acknowledgement'),{code:'TIMEOUT'});};
  await assert.rejects(index.sync(g),isCode('TIMEOUT'));
  const paid=modelCalls;assert.equal(document(f,g,m).state,'building');assert.equal(mappings(f,g,m).length,documentChunks(e,m.content).chunks.length);
  assert.ok(points(backend,g,index).every(point=>point.payload.lifecycle==='active'),'all remote chunks were complete before publication');
  if(mode==='manifest')assert.equal(index.manifest(g)[0].state,'pending');
  index=new VectorIndex(f.s,backend,providers,options);assert.equal((await index.sync(g)).complete,true);
  assert.equal(publications,2);assert.equal(modelCalls,paid);assert.equal(document(f,g,m).state,'indexed');
  if(mode==='manifest')assert.equal(index.manifest(g)[0].state,'indexed');
});

for(const stage of ['upsert','publish'])test(`vector lease fence: a late ${stage} acknowledgement cannot commit or clear a successor lease`,async t=>{
  const f=fixture(t);let now=1000,calls=0,successor;
  const e=embedder(texts=>{calls++;return texts.map(()=>[1,0,0]);}),backend=new MockVectorStore(),providers=new Map([[e.profile.fingerprint,e]]);
  const index=new VectorIndex(f.s,backend,providers,{clock:()=>now,leaseMs:10}),m=f.save('network lease source'),g=index.begin(e.profile.fingerprint);
  const method=stage==='upsert'?'upsert':'publishBuild',original=backend[method].bind(backend);
  backend[method]=async(...args)=>{await original(...args);if(!successor){now+=11;successor=index.acquire(g);}};
  await assert.rejects(index.sync(g),isCode('LEASE_LOST'));
  assert.equal(document(f,g,m).state,'building');assert.equal(mappings(f,g,m).length,stage==='upsert'?0:1);
  assert.equal(index.db.prepare('SELECT lease_owner FROM memory_vector_generations WHERE generation=?').get(g).lease_owner,successor.lease_owner);
  const first=points(backend,g,index)[0];assert.equal(first.payload.lifecycle,stage==='upsert'?'building':'active');
  now+=11;assert.equal((await index.sync(g)).complete,true);
  assert.equal(calls,stage==='upsert'?2:1,'only unacknowledged embedding chunks are paid again');
  assert.deepEqual(points(backend,g,index).map(point=>point.id),[first.id]);assert.equal(document(f,g,m).state,'indexed');
});

test('vector reconciliation shares the writer lease across the remote-upsert checkpoint window and retired maintenance',async t=>{
  const f=fixture(t),e=embedder(),backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]));
  const m=f.save('network leased cleanup'),g=index.begin(e.profile.fingerprint),upsert=backend.upsert.bind(backend);let blocked=0;
  backend.upsert=async(...args)=>{await upsert(...args);await assert.rejects(index.reconcile(g),isCode('VECTOR_LEASE_BUSY'));blocked++;};
  assert.equal((await index.sync(g)).complete,true);assert.equal(blocked,1);index.activate(g);
  assert.equal(points(backend,g,index).length,1);assert.equal(mappings(f,g,m).length,1);
  const orphan={...points(backend,g,index)[0],id:'00000000-0000-5000-a000-000000000001'};await upsert(index.snapshot().collection_name,[orphan]);
  const scroll=backend.scroll.bind(backend);backend.scroll=async(...args)=>{await assert.rejects(index.sync(g),isCode('VECTOR_LEASE_BUSY'));return scroll(...args);};
  assert.equal((await index.reconcile(g)).removed,1);assert.equal(points(backend,g,index).length,1);
  index.db.prepare("UPDATE memory_vector_generations SET state='retired' WHERE generation=?").run(g);
  assert.equal((await index.reconcile(g)).removed,0,'retired generations retain fenced cleanup support');
});

test('vector grouped retry excludes an active orphan without another query embedding or widening a private filter',async t=>{
  const f=fixture(t);let queries=0;
  const e=embedder((texts,type)=>{if(type==='query')queries++;return texts.map(()=>type==='query'?[1,0,0]:[0.95,0.3,0]);});
  const backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]])),m=f.save('network current source'),g=index.begin(e.profile.fingerprint);
  await index.sync(g);index.activate(g);const point=points(backend,g,index)[0],orphan={...point,id:'00000000-0000-5000-a000-000000000002',vector:[1,0,0]};
  await backend.upsert(index.snapshot().collection_name,[orphan]);
  const result=await index.search(f.auth,{query:'network',mode:'semantic',memory_types:['fact']});
  assert.deepEqual(result.results.map(row=>row.memory_id),[m.memory_id]);assert.equal(queries,1);assert.equal(backend.searchCalls.length,2);
  assert.deepEqual(backend.searchCalls[1].filter.must,backend.searchCalls[0].filter.must);
  assert.ok(backend.searchCalls[1].filter.must.some(condition=>condition.key==='document'),'the bounded library allowlist remains in every query');
  assert.deepEqual(backend.searchCalls[1].filter.must_not,[{has_id:[orphan.id]}]);
});

test('vector grouped retry stops at its fixed bound and reports staleness instead of a successful empty result',async t=>{
  const f=fixture(t);let queries=0;
  const e=embedder((texts,type)=>{if(type==='query')queries++;return texts.map(()=>type==='query'?[1,0,0]:[0.95,0.3,0]);});
  const backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]])),m=f.save('network fallback source'),g=index.begin(e.profile.fingerprint);
  await index.sync(g);index.activate(g);const point=points(backend,g,index)[0];
  const orphans=Array.from({length:VECTOR_GROUP_QUERY_ATTEMPTS},(_,n)=>({...point,id:`00000000-0000-5000-a000-${String(n+10).padStart(12,'0')}`,vector:[1,0,0]}));
  await backend.upsert(index.snapshot().collection_name,orphans);
  const hybrid=await index.search(f.auth,{query:'network',mode:'hybrid'});
  assert.equal(hybrid.retrieval.degraded,true);assert.equal(hybrid.retrieval.degradation_code,'VECTOR_STALE');assert.equal(hybrid.retrieval.effective_mode,'lexical');
  assert.deepEqual(hybrid.results.map(row=>row.memory_id),[m.memory_id]);assert.equal(backend.searchCalls.length,VECTOR_GROUP_QUERY_ATTEMPTS);assert.equal(queries,1);
  backend.searchCalls=[];
  await assert.rejects(index.search(f.auth,{query:'network',mode:'semantic'}),error=>error.code==='SEMANTIC_UNAVAILABLE'&&error.statusCode===503&&error.degradation_code==='VECTOR_STALE');
  assert.equal(backend.searchCalls.length,VECTOR_GROUP_QUERY_ATTEMPTS);assert.equal(queries,2);
  const search=backend.search.bind(backend);backend.searchCalls=[];
  backend.search=(name,vector,filter,limit)=>search(name,vector,{must:filter.must},limit);
  assert.equal((await index.search(f.auth,{query:'network',mode:'hybrid'})).retrieval.degradation_code,'VECTOR_STALE');
  assert.equal(backend.searchCalls.length,2,'a backend ignoring exact exclusions fails immediately when it makes no progress');
});

test('vector compatibility: an existing indexed mapping and legacy payload without build remain readable without reembedding',async t=>{
  const f=fixture(t);let documents=0;
  const e=embedder((texts,type)=>{if(type==='document')documents++;return texts.map(()=>[1,0,0]);}),backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]));
  const m=f.save('network legacy complete source'),g=index.begin(e.profile.fingerprint);await index.sync(g);index.activate(g);
  const collection=backend.collections.get(index.snapshot().collection_name),point=[...collection.points.values()][0];
  // Exact pre-v2 identity formula: generation, owner, memory, revision, profile, ordinal.
  const hash=digest([g,f.auth.user_id,m.memory_id,1,e.profile.fingerprint,0]);
  const legacyId=`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
  collection.points.delete(point.id);index.db.prepare('UPDATE memory_vector_points SET point_id=? WHERE point_id=?').run(legacyId,point.id);
  point.id=legacyId;delete point.payload.build;collection.points.set(point.id,point);
  assert.equal((await index.sync(g)).processed,0);assert.equal(documents,1);
  const result=await index.search(f.auth,{query:'network',mode:'semantic'});assert.equal(result.retrieval.degraded,false);
  assert.deepEqual(result.results.map(row=>row.memory_id),[m.memory_id]);assert.equal(f.s.memoryDetail(f.auth,m.memory_id).memory.content,m.content);
});

test('vector chunk planning rejects an empty source and an impossible whole-request budget before model reservation',async t=>{
  const f=fixture(t);let calls=0;
  const e=embedder(texts=>{calls++;return texts.map(()=>[1,0,0]);},{limits:limits({input_bytes:1,input_tokens:1})});
  assert.throws(()=>documentChunks(e,''),isCode('INVALID_INPUT'));
  const backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]])),m=f.save('network cannot fit'),g=index.begin(e.profile.fingerprint);
  await assert.rejects(index.sync(g),isCode('INPUT_TOO_LARGE'));assert.equal(calls,0);assert.equal(mappings(f,g,m).length,0);
  assert.equal(index.db.prepare('SELECT COUNT(*) AS n FROM memory_vector_calls').get().n,0);assert.equal(points(backend,g,index).length,0);
});

test('Qdrant grouped query and exact build publication retain the official private request contracts',async()=>{
  const calls=[],owner=surrogate('synthetic-owner'),document=surrogate('synthetic-document');let groups=[{id:document,hits:[{id:'synthetic-point',score:0.9,payload:{document}}]}];
  const backend=new QdrantStore({enabled:true,protocol:QDRANT_PROTOCOL,base_url:'http://127.0.0.1:6333',collection_prefix:'synthetic',auth:{env:'SYNTHETIC_VECTOR_KEY'},
    egress:{approved:true,origins:['http://127.0.0.1:6333'],addresses:['127.0.0.1'],allow_private:true},timeouts:{request_ms:1000},limits:{input_bytes:1000000,output_bytes:1000000}},
    {env:{SYNTHETIC_VECTOR_KEY:'synthetic-only'},transport:async(config,route,body)=>{calls.push({route,body});return {status:'ok',result:{groups}};}});
  const filter={must:[{key:'owner',match:{value:owner}},{key:'scope',match:{any:['synthetic-scope']}}]};
  assert.equal((await backend.search('synthetic_collection',[1,0,0],filter,10))[0].id,'synthetic-point');
  assert.equal(calls[0].route,'/collections/synthetic_collection/points/query/groups');assert.deepEqual(calls[0].body.filter,filter);
  assert.deepEqual([calls[0].body.group_by,calls[0].body.group_size,calls[0].body.limit],['document',1,10]);
  groups=[{id:document,hits:[{id:'wrong',payload:{document:'another-document'}}]}];await assert.rejects(backend.search('synthetic_collection',[1,0,0],filter,10),isCode('INVALID_VECTOR_RESPONSE'));
  const build=digest('synthetic-build');await backend.publishBuild('synthetic_collection',{owner,document,build});
  assert.equal(calls.at(-1).route,'/collections/synthetic_collection/points/payload?wait=true&ordering=strong');
  assert.deepEqual(calls.at(-1).body,{payload:{lifecycle:'active'},filter:{must:[{key:'owner',match:{value:owner}},{key:'document',match:{value:document}},{key:'build',match:{value:build}}]}});
  await assert.rejects(backend.publishBuild('synthetic_collection',{owner,document,build:'raw source'}),isCode('INVALID_INPUT'));
});

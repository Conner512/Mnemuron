import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,embedder,profile} from './helpers/memory-models.mjs';
import {MockVectorStore,matches} from './helpers/vector-mock.mjs';
import {VectorIndex,surrogate,VECTOR_FILTER_DOCUMENT_LIMIT} from '../lib/vector-stores/index.mjs';
import {consoleRead} from '../lib/console-read.mjs';
import {similarMemories} from '../lib/memory/similar.mjs';
import {comparableSemanticScore} from '../lib/search-query.mjs';

const ids=result=>result.results.map(m=>m.memory_id);
function consoleAuth(f){return f.s.authenticate(f.s.issueCredential({label:'Synthetic console',userId:f.auth.user_id,
  deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:'synthetic-console',scopes:['memory:read','console:read']}).api_key);}
async function indexed(f,e=embedder(texts=>texts.map(()=>[1,0,0]))){
  const backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]));
  const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);f.s.vectorIndex=index;
  return {e,backend,index};
}
function personal(f,v){f.s.consoleService.models.raw=()=>v.e.profile;f.s.consoleService.vector=()=>v.index;}

test('SEARCH-RELIABILITY-01: named projects without aliases constrain high-scoring semantic neighbours',async t=>{
  const f=fixture(t);f.s.ensureProject(f.auth,'orion','Orion');f.s.ensureProject(f.auth,'atlas','Atlas');
  const own=f.save('Orion network routing configuration.',{scope:'project',project_id:'orion'});
  const other=f.save('Atlas network routing configuration.',{scope:'project',project_id:'atlas'});
  await indexed(f); // Deliberately equal vectors test the local subject guard, not model quality.
  for(const mode of ['lexical','hybrid','semantic']){
    const result=await f.s.searchMemories(f.auth,{query:'Orion network routing',mode});
    assert.deepEqual(ids(result),[own.memory_id],mode);assert.ok(!ids(result).includes(other.memory_id));
  }
  // Equivalences still satisfy the named subject; do not require every equivalent name in the body.
  f.s.db.prepare('UPDATE projects SET aliases_json=? WHERE project_id=?').run(JSON.stringify(['Starbridge']),'orion');
  assert.deepEqual(ids(await f.s.searchMemories(f.auth,{query:'Starbridge network routing',mode:'semantic'})),[own.memory_id]);
});

test('SEARCH-RELIABILITY-02: Console keywords use whole-token relevance in lexical and hybrid modes',async t=>{
  const f=fixture(t),auth=consoleAuth(f);
  f.save('The installed release is newer.',{concepts:['17.9.80']});
  f.save('The unrelated review passed.',{concepts:['quality']});
  const expected=f.save('The inspected router is recorded here.',{concepts:['17.9.8']});
  const v=await indexed(f);personal(f,v);v.backend.search=async()=>[];
  for(const mode of ['lexical','hybrid']){
    assert.deepEqual(ids(await consoleRead(f.s,auth,'memories',{query:'17.9.8',mode})),[expected.memory_id]);
    assert.deepEqual(ids(await consoleRead(f.s,auth,'memories',{query:'ali',mode})),[]);
    assert.equal((await consoleRead(f.s,auth,'memories',{query:'quality',mode})).results.length,1,'exact keyword remains searchable');
  }
});

test('SEARCH-RELIABILITY-03: library filters apply before both lexical and vector candidate limits',async t=>{
  const f=fixture(t),auth=consoleAuth(f);
  const target=f.save('router backup target procedure',{kind:'workflow',strength:1,topic:'Maintenance',concepts:['Nightly'],source:'user_import:synthetic'});
  f.s.db.prepare('UPDATE memories SET created_at=? WHERE memory_id=?').run('2020-01-01T00:00:00.000Z',target.memory_id);
  // More than the vector top-100 window as well as the Console top-20 window.
  for(let i=0;i<105;i++)f.save(`router backup generic record ${i}`,{kind:'fact',strength:10});
  const v=await indexed(f,embedder(texts=>texts.map(text=>text.includes('target')?[0.8,0.6,0]:[1,0,0])));personal(f,v);
  const filters=[{kind:'workflow'},{topic:'Maintenance'},{concept:'Nightly'},{origin:'imported'},{review:'stale'},
    {kind:'workflow',topic:'Maintenance',concept:'Nightly',origin:'imported',review:'stale'}];
  for(const filter of filters)for(const mode of ['lexical','hybrid','semantic']){
    const result=await consoleRead(f.s,auth,'memories',{query:'router backup',mode,...filter});
    assert.deepEqual(ids(result),[target.memory_id],JSON.stringify({mode,filter}));assert.equal(result.total,1);
    if(mode!=='lexical')assert.deepEqual(v.backend.searchCalls.at(-1).filter.must.find(c=>c.key==='document').match.any,[surrogate([f.auth.user_id,target.memory_id])]);
  }
});

test('SEARCH-RELIABILITY-04: a library trait change during vector lookup is checked again before hydration',async t=>{
  const f=fixture(t),auth=consoleAuth(f),target=f.save('router backup target',{kind:'workflow'});
  const v=await indexed(f);personal(f,v);const search=v.backend.search.bind(v.backend);
  v.backend.search=async(...args)=>{const hits=await search(...args);f.s.traits.set(f.auth.user_id,target.memory_id,{kind:'fact'});return hits;};
  assert.deepEqual(ids(await consoleRead(f.s,auth,'memories',{query:'router backup',mode:'hybrid',kind:'workflow'})),[]);
});

test('SEARCH-RELIABILITY-05: long save-time similarity uses vectors without relaxing the public search term limit',async t=>{
  const f=fixture(t),parts=Array.from({length:70},(_,i)=>`component${i}`).join(' ');
  const original=f.save(`Backup schedule is daily. ${parts}`),fresh=f.save(`The backup runs every day. ${parts}`);
  const v=await indexed(f);
  await assert.rejects(f.s.searchMemories(f.auth,{query:fresh.content,mode:'semantic',documentSimilarity:true}),{errorCode:'QUERY_TOO_COMPLEX'});
  assert.equal(v.backend.searchCalls.length,0,'a JSON property cannot bypass the public guard');
  assert.deepEqual(await similarMemories(f.s,f.auth,fresh),[{memory_id:original.memory_id,similarity:1,relation:'duplicate'}]);
  assert.equal(v.backend.searchCalls.length,1);
  // The internal document path still enforces the provider's query egress permission.
  const denied=embedder(texts=>texts.map(()=>[1,0,0]),{egress:{...profile('embedder').egress,query_approved:false}});
  const deniedIndex=await indexed(f,denied);
  assert.deepEqual(await similarMemories(f.s,f.auth,fresh),[]);
  assert.equal(deniedIndex.backend.searchCalls.length,0);
});

test('SEARCH-RELIABILITY-06: Euclidean similarity hints convert distance and do not mark distant neighbours',async t=>{
  const f=fixture(t),original=f.save('Backups run nightly to the NAS.'),fresh=f.save('The NAS receives backups every night.');
  f.save('A distant storage maintenance plan.');
  const v=await indexed(f,embedder(texts=>texts.map(text=>text.includes('distant')?[0.55,Math.sqrt(1-0.55**2),0]:[1,0,0]),{distance:'Euclid'}));
  v.backend.search=async(name,vector,filter,limit)=>[...v.backend.collections.get(name).points.values()].filter(p=>matches(p,filter))
    .map(p=>({...p,score:Math.sqrt(p.vector.reduce((sum,n,i)=>sum+(n-vector[i])**2,0))})).sort((a,b)=>a.score-b.score).slice(0,limit);
  assert.deepEqual(await similarMemories(f.s,f.auth,fresh),[{memory_id:original.memory_id,similarity:1,relation:'duplicate'}]);
});

test('SEARCH-RELIABILITY-07: uncalibrated metrics cannot receive cosine duplicate labels',async t=>{
  assert.equal(comparableSemanticScore(0.9,{semantic_distance:'Cosine'}),0.9);
  assert.equal(comparableSemanticScore(0.9,{semantic_distance:'Dot',semantic_normalization:'l2'}),0.9);
  assert.equal(comparableSemanticScore(0,{semantic_distance:'Euclid',semantic_normalization:'l2'}),1);
  for(const metric of ['Dot','Euclid'])assert.equal(comparableSemanticScore(1,{semantic_distance:metric,semantic_normalization:'none'}),null);
  for(const score of [NaN,Infinity,null,'0.9'])assert.equal(comparableSemanticScore(score,{semantic_distance:'Cosine'}),null);
  const f=fixture(t),original=f.save('Backups run nightly to the NAS.'),fresh=f.save('The NAS receives backups every night.');
  f.s.memoryConfig={...f.s.memoryConfig,memory:{retrieval:{semantic_min_score:0.55}}};
  await indexed(f,embedder(texts=>texts.map(()=>[2,0,0]),{distance:'Dot',normalization:'none'}));
  assert.deepEqual(await similarMemories(f.s,f.auth,fresh),[],'large raw dot products are not calibrated duplicate probabilities');
  const exact=f.save(original.content);
  assert.deepEqual(await similarMemories(f.s,f.auth,exact),[{memory_id:original.memory_id,similarity:1,relation:'duplicate'}],'exact fallback remains available');
});

test('SEARCH-RELIABILITY-08: a purely semantic Console result advertises its truncated window',async t=>{
  const f=fixture(t),auth=consoleAuth(f);
  for(let i=0;i<25;i++)f.save(`Synthetic component note ${i}`);
  const v=await indexed(f);personal(f,v);
  for(const mode of ['hybrid','semantic']){
    const result=await consoleRead(f.s,auth,'memories',{query:'网络设备',mode});
    assert.equal(result.results.length,20);assert.equal(result.truncated,true);assert.equal(result.retrieval.result_truncated,true);
    assert.ok(result.results.every(r=>r.ranking.matched_by.includes('semantic')));
  }
});

test('SEARCH-RELIABILITY-09: the vector filter boundary degrades explicitly without dropping eligible IDs',async t=>{
  const f=fixture(t),auth=consoleAuth(f);f.save('router backup indexed target',{kind:'workflow'});
  const v=await indexed(f);personal(f,v);
  f.s.memoryTransaction(()=>{for(let i=1;i<VECTOR_FILTER_DOCUMENT_LIMIT;i++)f.save(`router backup pending record ${i}`,{kind:'workflow'});});
  const atLimit=await consoleRead(f.s,auth,'memories',{query:'router backup',kind:'workflow',mode:'semantic'});
  assert.equal(atLimit.retrieval.effective_mode,'semantic');assert.equal(atLimit.retrieval.degraded,false);
  assert.equal(v.backend.searchCalls.at(-1).filter.must.find(c=>c.key==='document').match.any.length,VECTOR_FILTER_DOCUMENT_LIMIT);
  f.save('router backup overflow record',{kind:'workflow'});const calls=v.backend.searchCalls.length;
  const fallback=await consoleRead(f.s,auth,'memories',{query:'router backup',kind:'workflow',mode:'hybrid'});
  assert.equal(fallback.retrieval.effective_mode,'lexical');assert.equal(fallback.retrieval.degraded,true);
  assert.equal(fallback.retrieval.degradation_code,'VECTOR_FILTER_TOO_BROAD');assert.ok(fallback.results.length>0);
  await assert.rejects(consoleRead(f.s,auth,'memories',{query:'router backup',kind:'workflow',mode:'semantic'}),
    error=>error.statusCode===503&&error.code==='SEMANTIC_UNAVAILABLE'&&error.degradation_code==='VECTOR_FILTER_TOO_BROAD');
  assert.equal(v.backend.searchCalls.length,calls,'overflow fails before a partial vector request is sent');
});

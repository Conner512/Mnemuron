import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,embedder} from './helpers/memory-models.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {VectorIndex,surrogate} from '../lib/vector-stores/index.mjs';
import {similarMemories} from '../lib/memory/similar.mjs';
import {MEMORY_TYPES} from '../lib/memory-validation.mjs';
import {WEB_READ_POLICY_ACTIVE_UNIFORM} from '../lib/memory/web-visibility.mjs';

const ids=result=>result.results.map(row=>row.memory_id);
async function indexed(f,e=embedder(texts=>texts.map(()=>[1,0,0]))){
  const backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]));
  const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);f.s.vectorIndex=index;
  return {backend,index,e};
}

test('RETRIEVAL-CROSS-01: public memory_types constrains vectors before the candidate window',async t=>{
  const f=fixture(t),target=f.save('Synthetic permitted safety condition',{memory_type:'constraint'});
  for(let i=0;i<105;i++)f.save(`Synthetic general observation ${i}`,{memory_type:'fact'});
  const v=await indexed(f,embedder(texts=>texts.map(text=>text===target.content?[0.8,0.6,0]:[1,0,0])));
  // Deliberately synthetic scores isolate candidate filtering; no claim about a real embedding model.
  for(const mode of ['semantic','hybrid']){
    const result=await f.s.searchMemories(f.auth,{query:'network packet schedule',mode,memory_types:['constraint'],limit:10});
    assert.deepEqual(ids(result),[target.memory_id],mode);
    assert.deepEqual(v.backend.searchCalls.at(-1).filter.must.find(c=>c.key==='document').match.any,[surrogate([f.auth.user_id,target.memory_id])]);
  }
  const all=await f.s.searchMemories(f.auth,{query:'network packet schedule',mode:'semantic',memory_types:[...MEMORY_TYPES]});
  assert.equal(all.results.length,10);
  assert.equal(v.backend.searchCalls.at(-1).filter.must.some(c=>c.key==='document'),false,'all types keep the unfiltered path and its existing bounds');
});

test('RETRIEVAL-CROSS-02: exact duplicate fallback applies current Web grants before its three-result limit',async t=>{
  const f=fixture(t),content='Synthetic recurring backup schedule.';
  const prior=Array.from({length:4},()=>f.save(content)),fresh=f.save(content);
  const admin=f.s.authenticate(f.s.issueCredential({userId:f.auth.user_id,agentId:'synthetic-admin',agentInstanceId:'synthetic-admin',
    deviceId:'synthetic-admin',scopes:['memory:read','admin:tasks']}).api_key);
  const web={...f.auth,agent_id:'chatgpt-web'};
  const grant=(memory,allow)=>f.s.webVisibility.set(admin,memory.memory_id,{allow,...f.s.revisions.latest(f.auth.user_id,memory.memory_id)});
  grant(fresh,true);
  // Every duplicate must be discoverable when it is the only prior record this reader may see,
  // regardless of the database's row order. Other records must never consume its result slot.
  for(const target of prior){
    grant(target,true);
    assert.deepEqual(await similarMemories(f.s,web,fresh),[{memory_id:target.memory_id,similarity:1,relation:'duplicate'}]);
    grant(target,false);
  }
});

test('RETRIEVAL-CROSS-03: exact duplicate fallback excludes deleted projects before its result limit',async t=>{
  const f=fixture(t),content='Synthetic recurring backup schedule.';
  const prior=Array.from({length:4},(_,i)=>{
    const project_id=`synthetic-similar-project-${i}`;f.s.ensureProject(f.auth,project_id,`Synthetic similar project ${i}`);
    return f.save(content,{scope:'project',project_id});
  }),fresh=f.save(content);
  // Lifecycle-only fixture changes use the same persisted authority and generation fence as reads.
  for(const target of prior){
    f.s.memoryTransaction(()=>{
      for(const memory of prior)f.s.db.prepare('INSERT OR REPLACE INTO project_lifecycle VALUES (?,?,?,?,1,?)')
        .run(f.auth.user_id,memory.project_id,memory.memory_id===target.memory_id?'active':'deleted',null,new Date().toISOString());
      f.s.lifecycle.bumpGeneration(f.auth.user_id);
    });
    assert.deepEqual(await similarMemories(f.s,f.auth,fresh),[{memory_id:target.memory_id,similarity:1,relation:'duplicate'}]);
  }
});

for(const distance of ['Cosine','Dot','Euclid'])test(`RETRIEVAL-CROSS-04 (${distance}): duplicate hints select nearest vectors before general-search salience truncation`,async t=>{
  const f=fixture(t),scores=new Map();
  const closest=[0.99,0.98,0.97].map((score,i)=>{const memory=f.save(`Synthetic equivalent schedule ${i}`,{strength:1});scores.set(memory.content,score);return memory;});
  const popular=[0.89,0.88,0.87].map((score,i)=>{const memory=f.save(`Synthetic popular alternative ${i}`,{strength:10});scores.set(memory.content,score);return memory;});
  for(const memory of popular)for(let i=0;i<15;i++)f.s.memoryDetail(f.auth,memory.memory_id);
  const {backend}=await indexed(f,embedder(texts=>texts.map(text=>{const score=scores.get(text)??1;return [score,Math.sqrt(1-score**2),0];}),{distance}));
  if(distance==='Euclid'){
    const search=backend.search.bind(backend);
    backend.search=async(...args)=>(await search(...args)).map(point=>({...point,score:Math.sqrt(point.vector.reduce((sum,n,i)=>sum+(n-args[1][i])**2,0))})).sort((a,b)=>a.score-b.score);
  }
  const fresh=f.save('A newly recorded recurring maintenance plan.');
  const ordinary=await f.s.searchMemories(f.auth,{query:fresh.content,mode:'semantic',limit:4});
  assert.ok(ordinary.results.some(row=>popular.some(p=>p.memory_id===row.memory_id)),'ordinary search retains its existing salience ranking');
  assert.ok(ordinary.results.every(row=>row.ranking.method==='rrf-salience-v2'));
  assert.deepEqual(await similarMemories(f.s,f.auth,fresh),closest.map((memory,i)=>({memory_id:memory.memory_id,similarity:[0.99,0.98,0.97][i],relation:'duplicate'})));
});

test('RETRIEVAL-CROSS-05: excessive semantic scope preserves the actionable narrowing diagnostic',async t=>{
  const f=fixture(t);f.save('Synthetic routing anchor');const v=await indexed(f);
  const addScope=i=>{
    const project_id=`synthetic-search-scope-${i}`;f.s.ensureProject(f.auth,project_id,`Synthetic scope ${i}`);
    f.save(`Synthetic routing scope ${i}`,{scope:'project',project_id});
  };
  for(let i=0;i<127;i++)addScope(i);
  assert.equal((await f.s.searchMemories(f.auth,{query:'routing',mode:'semantic'})).retrieval.effective_mode,'semantic');
  assert.equal(v.backend.searchCalls.at(-1).filter.must.find(c=>c.key==='scope').match.any.length,128);
  addScope(127);const calls=v.backend.searchCalls.length;
  for(const personal of [false,true]){
    if(personal){f.s.consoleService.models.raw=()=>v.e.profile;f.s.consoleService.vector=()=>v.index;}
    const result=await f.s.searchMemories(f.auth,{query:'routing',mode:'hybrid'});
    assert.equal(result.retrieval.effective_mode,'lexical');assert.equal(result.retrieval.degradation_code,'VECTOR_SCOPE_TOO_BROAD');
    await assert.rejects(f.s.searchMemories(f.auth,{query:'routing',mode:'semantic'}),error=>error.code==='SEMANTIC_UNAVAILABLE'&&error.degradation_code==='VECTOR_SCOPE_TOO_BROAD');
  }
  assert.equal(v.backend.searchCalls.length,calls,'a partial scope filter must never be sent to the backend');
});

test('RETRIEVAL-CROSS-06: Web index freshness and post-await revision checks honor the requested memory types',async t=>{
  const f=fixture(t),target=f.save('Synthetic required safety condition',{memory_type:'constraint'});
  const v=await indexed(f);f.save('Synthetic unrelated pending observation',{memory_type:'fact'});
  const web={...f.auth,agent_id:'chatgpt-web',read_policy:WEB_READ_POLICY_ACTIVE_UNIFORM};
  const request={query:'network packet schedule',mode:'semantic',memory_types:['constraint']};
  assert.deepEqual(ids(await f.s.searchMemories(web,request)),[target.memory_id],'an unindexed fact cannot block a search for current constraints');
  await assert.rejects(f.s.searchMemories(web,{query:request.query,mode:'semantic'}),error=>error.degradation_code==='VECTOR_STALE','broader Web reads still require a current index');
  const search=v.backend.search.bind(v.backend);let replacement;
  v.backend.search=async(...args)=>{const hits=await search(...args);replacement=f.s.supersedeMemory(f.auth,target.memory_id,{content:'Synthetic corrected observation',memory_type:'fact'}).replacement_memory;return hits;};
  assert.deepEqual(ids(await f.s.searchMemories(web,request)),[],'a source corrected to another type during the vector request cannot return its stale hit');
  assert.ok(replacement);assert.equal(replacement.memory_type,'fact');
});

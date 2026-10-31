import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,embedder} from './helpers/memory-models.mjs';
import {MockVectorStore} from './helpers/vector-mock.mjs';
import {VectorIndex,surrogate} from '../lib/vector-stores/index.mjs';
import {consoleRead} from '../lib/console-read.mjs';
import {normalizeConcept} from '../lib/search-query.mjs';

test('concept identity is consistent from graph to library facets and every retrieval mode',async t=>{
  const f=fixture(t),user=f.auth.user_id;
  const auth=f.s.authenticate(f.s.issueCredential({label:'Synthetic concept console',userId:user,deviceId:'synthetic-concept',agentId:'mnemuron-console',agentInstanceId:'synthetic-concept',scopes:['memory:read','console:read']}).api_key);
  const one=f.save('Synthetic router backup source one.',{concepts:['ＰＶＥ','PVE','Équipe','Synthetic Server']});
  const two=f.save('Synthetic router backup source two.',{concepts:['pve','E\u0301QUIPE','Synthetic   Server']});
  f.save('Synthetic router backup distinct identifiers.',{concepts:['PVE-2','Équipes','Synthetic Server-2']});
  const foreign=f.s.authenticate(f.s.issueCredential({label:'Synthetic foreign concept',userId:'synthetic-concept-other',deviceId:'synthetic-other',agentId:'synthetic-other',agentInstanceId:'synthetic-other',scopes:['memory:read','memory:write']}).api_key);
  f.s.saveMemory(foreign,{scope:'user',content:'Synthetic foreign router backup.',concepts:['PVE','Équipe','Synthetic Server']});
  const retracted=f.save('Synthetic router backup withdrawn.',{concepts:['PVE','Équipe','Synthetic Server']});
  f.s.retractMemory(f.auth,retracted.memory_id,{reason:'Synthetic lifecycle exclusion.'});
  const e=embedder(texts=>texts.map(()=>[1,0,0])),backend=new MockVectorStore(),index=new VectorIndex(f.s,backend,new Map([[e.profile.fingerprint,e]]));
  const generation=index.begin(e.profile.fingerprint);await index.sync(generation);index.activate(generation);f.s.vectorIndex=index;
  f.s.consoleService.models.raw=()=>e.profile;f.s.consoleService.vector=()=>index;
  const expected=[one.memory_id,two.memory_id].sort(),facets=f.s.consoleService.organizer.facets(auth);
  for(const concept of ['pve','éQUIPE','Synthetic\tServer']){
    const normalized=normalizeConcept(concept),facet=facets.concepts.filter(c=>normalizeConcept(c.concept)===normalized);
    assert.equal(facet.length,1);assert.equal(facet[0].count,2,'two equivalent labels on one memory count once');
    const browse=await consoleRead(f.s,auth,'memories',{concept,status:'active'});
    assert.deepEqual(browse.results.map(m=>m.memory_id).sort(),expected,'the graph keyword link opens all equivalent labels');
    for(const mode of ['lexical','hybrid','semantic']){
      const result=await consoleRead(f.s,auth,'memories',{query:'router backup',concept,status:'active',mode});
      assert.deepEqual(result.results.map(m=>m.memory_id).sort(),expected,mode);assert.equal(result.total,2);
      if(mode!=='lexical')assert.deepEqual(backend.searchCalls.at(-1).filter.must.find(c=>c.key==='document').match.any.sort(),expected.map(id=>surrogate([user,id])).sort(),'vector candidates use the same exact-equivalence filter before their window');
    }
  }
  const g=f.s.consoleService.features.read(auth,'attention',{graph_query:'équipe',graph_days:'0'}).graph;
  assert.deepEqual(g.memories.map(m=>m.id).sort(),[...expected,...f.s.db.prepare("SELECT memory_id FROM memories WHERE user_id=? AND content=?").all(user,'Synthetic router backup distinct identifiers.').map(m=>m.memory_id)].sort(),'graph search is a metadata substring search, while clicking a keyword is exact-equivalence');
  assert.equal(normalizeConcept(' PVE-2 '),'pve-2');assert.notEqual(normalizeConcept('PVE-2'),normalizeConcept('PVE'));
});

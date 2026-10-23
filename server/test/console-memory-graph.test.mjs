import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';

// Overview memory map: active memories of this account only, with their kind, keywords and topic; no memory content.
// Entities were replaced by keywords, so the graph carries no entity layer (entities/links stay empty for old clients).
test('attention graph: own active memories with kind, keywords and topic, without content or entities',async t=>{
  const f=await memoryFixture(t),store=f.store,auth=f.a.auth;
  const kept=store.saveMemory(auth,{scope:'user',content:'Synthetic graph memory kept on the map.'}).memory;
  const tagged=store.saveMemory(auth,{scope:'user',content:'Synthetic graph memory naming Synthetic Server.',kind:'architecture',concepts:['Synthetic Server','PVE']}).memory;
  const gone=store.saveMemory(auth,{scope:'user',content:'Synthetic graph memory that is retracted.'}).memory;
  store.saveMemory(f.other.auth,{scope:'user',content:'Synthetic graph memory of another account.',concepts:['Foreign']});
  store.retractMemory(auth,gone.memory_id,{reason:'synthetic'});
  const g=store.consoleService.features.read(auth,'attention',{}).graph;
  const ids=g.memories.map(m=>m.id);
  assert.ok(ids.includes(kept.memory_id)&&ids.includes(tagged.memory_id));
  assert.ok(!ids.includes(gone.memory_id),'retracted memories are not drawn');
  assert.equal(g.memories.length,2,'other accounts are never drawn');
  assert.ok(g.memories.every(m=>Object.keys(m).sort().join()==='concepts,day,id,kind,topic'&&/^\d{4}-\d{2}-\d{2}$/.test(m.day)));
  assert.deepEqual(g.memories.find(m=>m.id===tagged.memory_id),{id:tagged.memory_id,kind:'architecture',concepts:['Synthetic Server','PVE'],topic:null,day:tagged.created_at.slice(0,10)});
  assert.deepEqual([g.entities,g.links,g.truncated],[[],[],false]);
  assert.doesNotMatch(JSON.stringify(g),/Synthetic graph memory|Foreign/,'no memory content and nothing of another account');
  assert.equal(store.consoleService.features.read(auth,'attention',{}).activity_7d.redacted,0);
});

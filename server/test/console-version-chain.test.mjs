import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';

// Detail-pane version chain: corrections are replacement records, so the chain follows supersedes links.
test('memory-versions chain lists the correction lineage newest first, from any record in it',async t=>{
  const f=await memoryFixture(t),store=f.store,auth=f.a.auth;
  const first=store.saveMemory(auth,{scope:'user',content:'Synthetic chain reply in English.'}).memory;
  const second=store.supersedeMemory(auth,first.memory_id,{content:'Synthetic chain reply in Chinese.',reason:'Synthetic correction one.'}).replacement_memory;
  const third=store.supersedeMemory(auth,second.memory_id,{content:'Synthetic chain reply in Chinese, including buttons.',reason:'Synthetic correction two.'}).replacement_memory;
  const other=store.saveMemory(auth,{scope:'user',content:'Synthetic unrelated memory.'}).memory;
  const read=id=>store.consoleService.features.read(auth,'memory-versions',{memory_id:id,chain:'1'});
  for(const id of [first.memory_id,second.memory_id,third.memory_id]){
    const c=read(id);assert.deepEqual(c.chain.map(x=>x.memory_id),[third.memory_id,second.memory_id,first.memory_id]);
    assert.deepEqual(c.chain.map(x=>x.status),['active','superseded','superseded']);assert.equal(c.truncated,false);
  }
  assert.deepEqual(read(third.memory_id).chain.map(x=>x.reason),['Synthetic correction two.','Synthetic correction one.',null],'each version says why it was made');
  assert.deepEqual(read(other.memory_id).chain.map(x=>x.memory_id),[other.memory_id]);
  assert.doesNotMatch(JSON.stringify(read(third.memory_id)),/Synthetic chain reply/,'no content in the chain');
  assert.throws(()=>store.consoleService.features.read(auth,'memory-versions',{memory_id:first.memory_id,chain:'yes'}),/Invalid version chain/);
  assert.throws(()=>store.consoleService.features.read(f.other.auth,'memory-versions',{memory_id:first.memory_id,chain:'1'}));
});

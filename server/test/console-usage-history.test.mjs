import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';

// Usage page data: 14 zero-filled UTC days of owner-counted calls per model kind, and audited searches in 7 days.
test('model-usage: 14-day call history per kind and the 7-day search count, scoped to the account',async t=>{
  const f=await memoryFixture(t),service=f.store.consoleService,db=f.store.db;
  const day=n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);
  service.features.read(f.a.auth,'model-usage',{});
  db.exec('CREATE TABLE IF NOT EXISTS console_model_usage_daily(user_id TEXT NOT NULL,kind TEXT NOT NULL,day TEXT NOT NULL,used INTEGER NOT NULL,PRIMARY KEY(user_id,kind,day))');
  const put=db.prepare('INSERT OR REPLACE INTO console_model_usage_daily(user_id,kind,day,used) VALUES(?,?,?,?)');
  put.run(f.a.auth.user_id,'embedder',day(0),8);put.run(f.a.auth.user_id,'organizer',day(2),3);put.run(f.a.auth.user_id,'embedder',day(20),99);put.run(f.other.auth.user_id,'embedder',day(0),50);
  f.store.saveMemory(f.a.auth,{scope:'user',content:'Synthetic router note.'});
  for(const query of ['router','note'])f.store.queryMemories(f.a.auth,{query});
  f.store.queryMemories(f.other.auth,{query:'router'});
  const usage=service.features.read(f.a.auth,'model-usage',{});
  assert.equal(usage.history.length,14);assert.equal(usage.history.at(-1).day,day(0));assert.equal(usage.history[0].day,day(13));
  assert.deepEqual(usage.history.at(-1),{day:day(0),organizer:0,embedder:8});
  assert.equal(usage.history.find(r=>r.day===day(2)).organizer,3);
  assert.equal(usage.history.reduce((n,r)=>n+r.embedder,0),8,'older days and other accounts are not counted');
  assert.equal(usage.searches_7d,2);
});

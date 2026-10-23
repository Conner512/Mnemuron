import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryFixture, businessSnapshot } from './helpers/core-memory-fixture.mjs';
import { MnemuronStore } from '../lib/store.mjs';

test('M-01..03 D-09 read-side expiry without prune; bounded maintenance rollback and restart',async t=>{
  const f=await memoryFixture(t);
  const auth={...f.a.auth,scopes:[...f.a.auth.scopes,'resume:read','admin:retention']};
  f.store.saveMemory(auth,{scope:'task',task_id:f.alpha.task_id,content:'长期事实'});
  for(let i=0;i<3;i++)f.store.appendEvents(auth,{event:{event_id:`expired-${i}`,event_type:'tool_result',project_id:f.alpha.project_id,task_id:f.alpha.task_id,session_id:'s1',workstream_id:f.alpha.workstreams[0].workstream_id,captured_at:'2020-01-01T00:00:00Z',content:'RAW-SECRET-EXPIRED'},raw_retention_days:1});
  const before=businessSnapshot(f.store), original=f.store.pruneExpired;
  f.store.pruneExpired=()=>{throw Error('read must not prune');};
  const preview=f.store.previewProjectContext(auth,{query:f.alpha.project_id});
  assert.ok(!JSON.stringify(preview).includes('RAW-SECRET-EXPIRED'));
  f.store.previewTaskBranches(auth,{query:f.alpha.task_id});
  f.store.queryMemories(auth,{query:'长期事实'});
  assert.equal(f.store.status(auth).raw_availability.expired_events,3);
  assert.equal(f.store.status(auth).adapter_report.pending,null);
  assert.deepEqual(businessSnapshot(f.store),before);
  f.store.pruneExpired=original;
  assert.equal(f.store.pruneExpired(auth,{batchSize:1}).remaining_events,2);
  f.store.db.exec("CREATE TEMP TRIGGER fail_maintenance BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  assert.throws(()=>f.store.pruneExpired(auth,{batchSize:1}));
  assert.equal(f.store.status(auth).maintenance.status,'failed');
  f.store.db.exec('DROP TRIGGER fail_maintenance');
  const reopened=new MnemuronStore(f.databasePath);
  assert.equal(reopened.pruneExpired(auth,{batchSize:1}).remaining_events,1);
  assert.equal(reopened.pruneExpired(auth,{batchSize:1}).remaining_events,0);
  assert.equal(reopened.pruneExpired(auth).expired_events,0);
  assert.equal(reopened.queryMemories(auth,{query:'长期事实'}).results.length,1);
  reopened.close();
});

test('M-04..07 credential rotation and audit are atomic; throttling never caches authority',async t=>{
  const f=await memoryFixture(t);
  for(const table of ['credentials','audit_events']) {
    f.store.db.exec(`CREATE TEMP TRIGGER fail_rotate BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic'); END`);
    assert.throws(()=>f.store.rotateAgentKey(f.b.auth,f.a.auth.agent_instance_id));
    f.store.db.exec('DROP TRIGGER fail_rotate');
    assert.equal(f.store.authenticate(f.a.api_key).agent_instance_id,f.a.auth.agent_instance_id);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM credentials WHERE agent_instance_id=? AND revoked_at IS NULL').get(f.a.auth.agent_instance_id).n,1);
  }
  f.store.db.exec('CREATE TEMP TABLE touch_count(n INTEGER); INSERT INTO touch_count VALUES(0); CREATE TEMP TRIGGER count_touch AFTER UPDATE OF last_used_at ON credentials BEGIN UPDATE touch_count SET n=n+1; END');
  for(let i=0;i<100;i++)f.store.authenticate(f.a.api_key);
  assert.equal(f.store.db.prepare('SELECT n FROM touch_count').get().n,0);
  f.store.db.prepare('UPDATE credentials SET last_used_at=? WHERE credential_id=?').run('2020-01-01T00:00:00Z',f.a.auth.credential_id);
  const before=f.store.db.prepare('SELECT n FROM touch_count').get().n;
  f.store.authenticate(f.a.api_key);
  assert.equal(f.store.db.prepare('SELECT n FROM touch_count').get().n,before+1);
  const first=f.store.rotateAgentKey(f.b.auth,f.a.auth.agent_instance_id);
  assert.throws(()=>f.store.authenticate(f.a.api_key));
  const other=new MnemuronStore(f.databasePath);
  const second=other.rotateAgentKey(f.b.auth,f.a.auth.agent_instance_id);
  assert.throws(()=>f.store.authenticate(first.api_key));
  const auth=f.store.authenticate(second.api_key);
  assert.deepEqual(auth.scopes,f.a.auth.scopes);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM credentials WHERE agent_instance_id=? AND revoked_at IS NULL').get(auth.agent_instance_id).n,1);
  f.store.db.prepare('UPDATE credentials SET expires_at=? WHERE credential_id=?').run('2020-01-01T00:00:00Z',auth.credential_id);
  assert.throws(()=>f.store.authenticate(second.api_key));
  other.close();
});

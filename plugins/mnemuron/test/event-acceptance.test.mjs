import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { memoryFixture } from '../../../server/test/helpers/core-memory-fixture.mjs';
import { validateAcceptance, queueItems, queueState } from '../scripts/sync-protocol.mjs';
import { validateAcceptance as openclawAcceptance } from '../../../adapters/openclaw/dist/sync-protocol.mjs';
import { flushOutbox } from '../scripts/remote-client.mjs';
import { enqueueOutbox } from '../scripts/storage.mjs';
import * as remote from '../scripts/remote-client.mjs';

const contract = JSON.parse(readFileSync(new URL('../../../server/test/helpers/event-acceptance-vectors.json',import.meta.url)));

test('REV-05/06 JS and packaged OpenClaw require exactly one immutable event ID and integer acceptance counts', () => {
  const item = {payload:{event:{event_id:contract.event_id}}};
  for (const validate of [validateAcceptance,openclawAcceptance]) for (const vector of contract.vectors) {
    if (vector.valid) assert.doesNotThrow(()=>validate('event',item,vector.response),vector.name);
    else assert.throws(()=>validate('event',item,vector.response),e=>e.errorCode==='RECEIPT_MISMATCH',vector.name);
  }
  assert.equal(readFileSync(new URL('../scripts/sync-protocol.mjs',import.meta.url),'utf8'),readFileSync(new URL('../../../adapters/openclaw/dist/sync-protocol.mjs',import.meta.url),'utf8'));
});

test('explicit event reconciliation retries only unchanged selected mismatches and preserves the original block evidence', async t => {
  const f = await memoryFixture(t);
  const root = path.join(f.root, 'reconciliation');
  const env = { MNEMURON_CONFIG_PATH: path.join(root, 'none.json'), MNEMURON_SPIKE_DATA_DIR: root,
    MNEMURON_SERVER_URL: f.baseUrl, MNEMURON_ALLOW_INSECURE_HTTP: 'true', MNEMURON_API_KEY: f.a.api_key };
  const payload = { event: { event_id: 'synthetic-reconcile', event_type: 'tool_result', session_id: 'synthetic-lane',
    captured_at: '2040-01-01T00:00:00Z', content: 'SYNTHETIC-PRIVATE-BODY' } };
  enqueueOutbox(root, payload);
  const item = queueItems(path.join(root, 'outbox'), 'event')[0];
  const { flushQueue, protocolError } = await import('../scripts/sync-protocol.mjs');
  await flushQueue([item], { root, credential: f.baseUrl + '|' + f.a.api_key, send: async () => {
    f.store.appendEvents(f.a.auth, payload);
    throw protocolError('RECEIPT_MISMATCH');
  } });
  const originalState = queueState(item), original = readFileSync(item.filePath);
  assert.equal((await flushOutbox(env)).flushed, 0, 'ordinary retries still fail closed');
  assert.equal(typeof remote.reconcileEventOutbox, 'function');
  assert.equal((await remote.reconcileEventOutbox(['not-selected'], env)).flushed, 0);
  assert.deepEqual(readFileSync(item.filePath), original);
  const result = await remote.reconcileEventOutbox([payload.event.event_id], env);
  assert.equal(result.flushed, 1);
  assert.equal(result.last_response.duplicate, 1);
  assert.equal(existsSync(item.filePath), false);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM events').get().n, 1);
  const { readdirSync } = await import('node:fs');
  const records = readdirSync(path.join(root, 'sync-reconciliation'));
  assert.equal(records.length, 1);
  const evidence = JSON.parse(readFileSync(path.join(root, 'sync-reconciliation', records[0]), 'utf8'));
  assert.deepEqual(evidence.previous_state, originalState);
  assert.equal(evidence.event_id, payload.event.event_id);
  assert.equal(evidence.envelope_hash, item.envelope_hash);
  assert.equal(JSON.stringify(evidence).includes('SYNTHETIC-PRIVATE-BODY'), false);
  assert.equal(JSON.stringify(evidence).includes(f.a.api_key), false);
});

test('event reconciliation keeps mismatched replies blocked and cannot bypass changed credentials, bytes or Receipt ownership', async t => {
  const f = await memoryFixture(t);
  const { flushQueue, protocolError, immutableEnvelope } = await import('../scripts/sync-protocol.mjs');
  const { writeFileSync } = await import('node:fs');
  for (const mode of ['wrong_reply', 'wrong_credential', 'changed_bytes', 'non_mismatch', 'receipt']) {
    const root = path.join(f.root, mode);
    const value = { event: { event_id: mode, session_id: 'lane', event_type: 'tool_result', captured_at: '2040-01-01T00:00:00Z', content: 'synthetic' } };
    if (mode === 'receipt') {
      enqueueOutbox(root, { event: { ...value.event, event_id: 'synthetic-primer' } });
      immutableEnvelope(path.join(root, 'outbox', 'receipt.json'), { resume_id: 'resume-test', payload: { receipt_event_id: mode, session_id: 'lane' } });
    } else enqueueOutbox(root, value);
    const item = queueItems(path.join(root, 'outbox'), mode === 'receipt' ? 'receipt' : 'event').find(item => mode === 'receipt' ? item.filePath.endsWith('/receipt.json') : true);
    await flushQueue([item], { root, credential: 'synthetic', send: async () => { throw protocolError(mode === 'non_mismatch' ? 'CONFLICT' : 'RECEIPT_MISMATCH', mode === 'non_mismatch' ? 409 : undefined); } });
    if (mode === 'changed_bytes') writeFileSync(item.filePath, JSON.stringify({ event: { ...value.event, content: 'changed' } }) + '\n');
    const original = readFileSync(item.filePath);
    let calls = 0;
    const refreshed = queueItems(path.join(root, 'outbox'), item.kind).find(next => next.filePath === item.filePath);
    const result = await flushQueue([refreshed], { root, credential: mode === 'wrong_credential' ? 'different' : 'synthetic',
      reconcileEventIds: [mode], send: async () => { calls++; return { status: 'accepted', received: 1, inserted: 0, duplicate: 1, accepted_event_ids: ['wrong-id'] }; } });
    assert.equal(result.flushed, 0, mode);
    assert.equal(calls, mode === 'wrong_reply' ? 1 : 0, mode);
    assert.deepEqual(readFileSync(item.filePath), original, mode);
    assert.equal(queueState(item).state, 'blocked_reconciliation', mode);
    if (mode === 'changed_bytes') {
      await flushQueue([refreshed], { root, credential: 'synthetic', reconcileEventIds: [mode], send: async () => { calls++; } });
      assert.equal(calls, 0, 'repeated maintenance must not replace the original envelope hash');
    }
  }
});

test('reconciliation validates explicit targets and cannot skip an older pending event', async t => {
  const f = await memoryFixture(t), root = path.join(f.root, 'predecessor');
  const env = { MNEMURON_CONFIG_PATH: path.join(root, 'none'), MNEMURON_SPIKE_DATA_DIR: root,
    MNEMURON_SERVER_URL: f.baseUrl, MNEMURON_ALLOW_INSECURE_HTTP: 'true', MNEMURON_API_KEY: f.a.api_key };
  const payload = { event: { event_id: 'selected-later', event_type: 'tool_result', session_id: 'lane', captured_at: '2040-01-02T00:00:00Z' } };
  enqueueOutbox(root, payload);
  const { flushQueue, protocolError } = await import('../scripts/sync-protocol.mjs');
  await flushQueue(queueItems(path.join(root, 'outbox'), 'event'), { root, credential: f.baseUrl + '|' + f.a.api_key,
    send: async () => { throw protocolError('RECEIPT_MISMATCH'); } });
  enqueueOutbox(root, { event: { ...payload.event, event_id: 'unselected-earlier', captured_at: '2040-01-01T00:00:00Z' } });
  for (const ids of [null, [], '../bad', ['../bad'], Array(101).fill('too-many')]) {
    await assert.rejects(remote.reconcileEventOutbox(ids, env), error => error.errorCode === 'INVALID_RECONCILIATION_TARGET');
  }
  const result = await remote.reconcileEventOutbox(['selected-later'], env);
  assert.equal(result.flushed, 0);
  assert.equal(queueItems(path.join(root, 'outbox'), 'event').length, 2);
  const blocked = queueItems(path.join(root, 'outbox'), 'event').find(item => item.payload.event.event_id === 'selected-later');
  assert.equal(queueState(blocked).state, 'blocked_reconciliation');
  assert.equal(queueState(blocked).last_error_code, 'RECEIPT_MISMATCH');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM events').get().n, 0);
});

test('REV-05/06 committed HTTP events with incomplete replies remain byte-identical and blocked after rediscovery', async t => {
  const f = await memoryFixture(t);
  let mode = 'missing_ids', calls=0;
  const proxy = http.createServer(async (request,response) => {
    try {
      const chunks=[];
      for await (const chunk of request) chunks.push(chunk);
      const envelope=JSON.parse(Buffer.concat(chunks));
      const upstream=await f.request('POST','/v1/events',envelope);
      assert.equal(upstream.status,202);
      calls++;
      const body=structuredClone(upstream.body);
      if (mode==='missing_ids') delete body.accepted_event_ids;
      if (mode==='null_ids') body.accepted_event_ids=null;
      if (mode==='wrong_id') body.accepted_event_ids=['wrong'];
      if (mode==='extra_id') body.accepted_event_ids.push('wrong');
      if (mode==='array_like') body.accepted_event_ids={0:envelope.event.event_id,length:1};
      response.writeHead(202,{'content-type':'application/json'}).end(JSON.stringify(body));
    } catch { response.writeHead(500).end('{}'); }
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>proxy.close(resolve)));
  const envFor = root => ({MNEMURON_CONFIG_PATH:path.join(root,'none.json'),MNEMURON_SPIKE_DATA_DIR:root,
    MNEMURON_SERVER_URL:`http://127.0.0.1:${proxy.address().port}`,MNEMURON_ALLOW_INSECURE_HTTP:'true',MNEMURON_API_KEY:f.a.api_key,MNEMURON_REQUEST_TIMEOUT_MS:'1000'});
  const eventFor = id => ({event:{event_id:id,event_type:'tool_result',session_id:id,captured_at:new Date().toISOString(),content:'SYNTHETIC-PRIVATE-BODY'},raw_retention_days:30});
  for (const name of ['missing_ids','null_ids','wrong_id','extra_id','array_like']) {
    mode=name;
    const root=path.join(f.root,name), env=envFor(root), payload=eventFor(`review-${name}`);
    enqueueOutbox(root,payload);
    const item=queueItems(path.join(root,'outbox'),'event')[0], bytes=readFileSync(item.filePath);
    const result=await flushOutbox(env);
    assert.equal(result.flushed,0,name);
    assert.deepEqual(readFileSync(item.filePath),bytes,name);
    assert.equal(queueState(item).state,'blocked_reconciliation',name);
    assert.equal(queueState(item).last_error_code,'RECEIPT_MISMATCH');
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM events WHERE event_id=?').get(payload.event.event_id).n,1);
    assert.equal(existsSync(path.join(root,'sync-last-success.state')),false);
    const previousCalls=calls;
    mode='exact';
    assert.equal((await flushOutbox({...env})).flushed,0);
    assert.equal(calls,previousCalls,'restart/rediscovery must not auto-clear an unresolved response mismatch');
    assert.deepEqual(readFileSync(item.filePath),bytes);
  }
  for (const duplicate of [false,true]) {
    mode='exact';
    const root=path.join(f.root,`exact-${duplicate}`),payload=eventFor(`review-exact-${duplicate}`);
    if (duplicate) assert.equal((await f.request('POST','/v1/events',payload)).status,202);
    enqueueOutbox(root,payload);
    assert.equal((await flushOutbox(envFor(root))).flushed,1);
    assert.equal(queueItems(path.join(root,'outbox'),'event').length,0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM events WHERE event_id=?').get(payload.event.event_id).n,1);
  }
});

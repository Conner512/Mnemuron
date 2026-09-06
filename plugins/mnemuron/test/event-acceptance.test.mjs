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

const contract = JSON.parse(readFileSync(new URL('../../../server/test/helpers/event-acceptance-vectors.json',import.meta.url)));

test('REV-05/06 JS and packaged OpenClaw require exactly one immutable event ID and integer acceptance counts', () => {
  const item = {payload:{event:{event_id:contract.event_id}}};
  for (const validate of [validateAcceptance,openclawAcceptance]) for (const vector of contract.vectors) {
    if (vector.valid) assert.doesNotThrow(()=>validate('event',item,vector.response),vector.name);
    else assert.throws(()=>validate('event',item,vector.response),e=>e.errorCode==='RECEIPT_MISMATCH',vector.name);
  }
  assert.equal(readFileSync(new URL('../scripts/sync-protocol.mjs',import.meta.url),'utf8'),readFileSync(new URL('../../../adapters/openclaw/dist/sync-protocol.mjs',import.meta.url),'utf8'));
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

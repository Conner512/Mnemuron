import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn, fork } from 'node:child_process';
import { memoryFixture } from './helpers/core-memory-fixture.mjs';
import { queueItems,flushQueue,retryState,protocolError,decodeResponse,queueState,queueSummary,claimLane,validateAcceptance } from '../../plugins/mnemuron/scripts/sync-protocol.mjs';
import { enqueueOutbox } from '../../plugins/mnemuron/scripts/storage.mjs';
import { remoteRequest } from '../../plugins/mnemuron/scripts/remote-client.mjs';
import { MnemuronClient } from '../../adapters/openclaw/dist/client.js';

const accepted=item=>({status:'accepted',received:1,inserted:1,duplicate:0,accepted_event_ids:[item.payload.event.event_id]});
function enqueue(root,id,lane='a',time='2026-01-01T00:00:00Z') {
  return enqueueOutbox(root,{event:{event_id:id,event_type:'tool_result',session_id:lane,captured_at:time,content:'SENSITIVE-DO-NOT-LOG'}});
}
const items=root=>queueItems(path.join(root,'outbox'),'event');

test('Q-04 F-03 shared transport vectors, packaged parity and restart-safe Retry-After',async t=>{
  assert.equal(readFileSync(new URL('../../plugins/mnemuron/scripts/sync-protocol.mjs',import.meta.url),'utf8'),readFileSync(new URL('../../adapters/openclaw/dist/sync-protocol.mjs',import.meta.url),'utf8'));
  const vectors=JSON.parse(readFileSync(new URL('./helpers/sync-contract-vectors.json',import.meta.url),'utf8'));
  for(const c of vectors.vectors) {
    const state=retryState(Object.assign(protocolError(c.code,c.status),{retryAfter:c.retry_after}),{},{now:vectors.now,random:()=>1});
    assert.deepEqual([state.state,state.next_retry_at],[c.state,c.next_retry_at]);
  }
  const f=await memoryFixture(t);
  for(const [i,retryAfter] of ['600','Thu, 01 Jan 2026 00:10:00 GMT','invalid'].entries()) {
    const root=path.join(f.root,String(i));mkdirSync(root);const file=enqueue(root,'event');const raw=readFileSync(file);
    await flushQueue(items(root),{root,credential:'test',now:()=>vectors.now,random:()=>1,send:async()=>{throw Object.assign(protocolError('HTTP_429',429),{retryAfter});}});
    const restart=await flushQueue(items(root),{root,credential:'test',now:()=>vectors.now+500,send:async item=>accepted(item)});
    assert.equal(restart.flushed,0);assert.deepEqual(readFileSync(file),raw);assert.equal(queueState(items(root)[0]).attempt_count,1);
  }
});

test('Q-12 two independent JS processes flush one immutable envelope once',async t=>{
  const f=await memoryFixture(t);enqueue(f.root,'event');
  const workers=[0,1].map(()=>fork(new URL('./helpers/sync-flush-worker.mjs',import.meta.url),[],{stdio:['ignore','ignore','pipe','ipc']}));
  t.after(()=>workers.forEach(w=>{if(w.connected)w.kill();}));
  const first=once(workers[0],'message');workers[0].send({root:f.root,hold:true});assert.equal((await first)[0].phase,'sending');
  const other=once(workers[1],'message');workers[1].send({root:f.root,hold:false});assert.equal((await other)[0].result.flushed,0);
  const done=once(workers[0],'message');workers[0].send({release:true});assert.equal((await done)[0].result.flushed,1);
  assert.equal(items(f.root).length,0);
});

test('Q-01..04 Q-09 persisted backoff, auth pause and credential recovery with fake time',async t=>{
  const f=await memoryFixture(t);let now=Date.parse('2026-01-01T00:00:00Z'),calls=0;
  const file=enqueue(f.root,'retry-event');const original=readFileSync(file);
  const run=(send,credential='synthetic')=>flushQueue(items(f.root),{root:f.root,credential,now:()=>now,random:()=>1,send:async item=>{calls++;return send(item);}});
  await run(()=>{throw protocolError('NETWORK_ERROR');});
  assert.equal(queueState(items(f.root)[0]).attempt_count,1);
  assert.equal(queueState(items(f.root)[0]).next_retry_at,'2026-01-01T00:00:01.000Z');
  await run(accepted);assert.equal(calls,1);
  now+=1000;await run(()=>{throw protocolError('HTTP_401',401);});
  for(let i=0;i<3;i++)await run(accepted);assert.equal(calls,2);
  assert.deepEqual(readFileSync(file),original);
  assert.equal((await run(accepted,'rotated-synthetic')).flushed,1);assert.ok(!existsSync(file));
  for(const retryAfter of ['600','Thu, 01 Jan 2026 00:10:00 GMT','invalid']) {
    const state=retryState(Object.assign(protocolError('HTTP_429',429),{retryAfter}),{},{now:Date.parse('2026-01-01T00:00:00Z'),random:()=>1});
    assert.equal(state.next_retry_at,retryAfter==='invalid'?'2026-01-01T00:00:01.000Z':'2026-01-01T00:10:00.000Z');
  }
});

test('Q-02 Q-07..08 Q-14 permanent lane gap, corrupt sidecars and independent healthy sessions',async t=>{
  const f=await memoryFixture(t);
  enqueue(f.root,'bad','a');enqueue(f.root,'dependent','a','2026-01-01T00:00:01Z');enqueue(f.root,'healthy','b');
  const sent=[];
  const result=await flushQueue(items(f.root),{root:f.root,credential:'test',send:async item=>{sent.push(item.payload.event.event_id);if(item.payload.event.event_id==='bad')throw protocolError('REQUEST_BODY_TOO_LARGE',413);return accepted(item);}});
  assert.equal(result.flushed,1);assert.deepEqual(sent,['bad','healthy']);
  assert.equal(queueState(items(f.root).find(i=>i.payload.event.event_id==='dependent')).state,'blocked_gap');
  assert.ok(existsSync(path.join(f.root,'outbox/bad.json')));
  enqueue(f.root,'corrupt','c');writeFileSync(path.join(f.root,'outbox/corrupt.json.state'),'broken sidecar');
  enqueue(f.root,'valid','d');
  assert.equal((await flushQueue(items(f.root),{root:f.root,credential:'test',send:async item=>accepted(item)})).flushed,1);
  assert.equal(readFileSync(path.join(f.root,'outbox/corrupt.json.state'),'utf8'),'broken sidecar');
  writeFileSync(path.join(f.root,'outbox/malformed.json'),'{broken');
  await flushQueue(items(f.root),{root:f.root,credential:'test',send:async item=>accepted(item)});
  assert.ok(queueSummary(items(f.root)).counts.blocked_protocol>=2);
  const diagnostics=items(f.root).map(i=>queueState(i));
  assert.ok(!JSON.stringify(diagnostics).includes('SENSITIVE'));
  assert.equal(queueSummary(Array.from({length:1001},()=>({filePath:'absent',time:''}))).high_water,true);
  for(const [status,code,expected] of [[400,'UNKNOWN','blocked_protocol'],[404,'HTTP_404','blocked_protocol'],[422,'INVALID_PAYLOAD','quarantined'],[409,'CONFLICT','blocked_reconciliation']])assert.equal(retryState(protocolError(code,status)).state,expected);
});

test('Q-05..06 Q-08 HTML status, redirect, bounded streaming and safe diagnostics on both JS transports',async t=>{
  const f=await memoryFixture(t),requests=[];
  const server=http.createServer((req,res)=>{
    requests.push(req.url);
    if(req.url==='/drip'){res.writeHead(200);res.write('{');const interval=setInterval(()=>res.write(' '),15);res.on('close',()=>clearInterval(interval));return;}
    if(req.url==='/large'){res.end('x'.repeat(2*1024*1024+1));return;}
    if(req.url==='/redirect'){res.writeHead(302,{location:f.baseUrl+'/never-forward'});res.end();return;}
    const status=Number(req.url.slice(1));res.writeHead(status,{'retry-after':'60'});res.end('<html>SECRET PROXY PAGE</html>');
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const url=`http://127.0.0.1:${server.address().port}`;
  const env={MNEMURON_CONFIG_PATH:path.join(f.root,'none'),MNEMURON_SERVER_URL:url,MNEMURON_ALLOW_INSECURE_HTTP:'true',MNEMURON_API_KEY:'mnm_synthetic',MNEMURON_REQUEST_TIMEOUT_MS:'250'};
  const key=path.join(f.root,'test-key');writeFileSync(key,'mnm_synthetic',{mode:0o600});
  const oc=new MnemuronClient({serverUrl:new URL(url),apiKeyFile:key,requestTimeoutMs:250});
  for(const request of [endpoint=>remoteRequest(env,'GET',endpoint),endpoint=>oc.request('GET',endpoint)]) {
    for(const status of [401,429,503])await assert.rejects(request('/'+status),e=>e.statusCode===status && !e.message.includes('SECRET'));
    await assert.rejects(request('/redirect'),e=>e.statusCode===302);
    await assert.rejects(request('/large'),e=>e.errorCode==='RESPONSE_TOO_LARGE');
    const start=performance.now();await assert.rejects(request('/drip'));assert.ok(performance.now()-start<1200);
    await assert.rejects(async()=>request(f.baseUrl+'/foreign'),e=>e.errorCode==='REDIRECT_BLOCKED');
  }
  assert.ok(!requests.includes('/never-forward'));
});

function receiptItem() {
  const payload={receipt_event_id:'event-ack',receipt_id:'receipt-1',preview_version:1,phase:'acknowledged',session_id:'a',turn_id:'turn-a',workstream_id:'work-a',occurred_at:'2026-01-01T00:00:00Z'};
  return {resume_id:'resume-1',payload};
}
function receiptResponse(item) {
  const p=item.payload;
  return {inserted:1,duplicate:0,receipt_event_id:p.receipt_event_id,delivery:{resume_id:item.resume_id,preview_version:p.preview_version,receipts:[{receipt_id:p.receipt_id,session_id:p.session_id,turn_id:p.turn_id,workstream_id:p.workstream_id,ack_complete:true,acknowledged_at:p.occurred_at,receipt_event_ids:[p.receipt_event_id]}]}};
}
test('Q-10..11 exact Receipt ownership, false 2xx and only provable 409 replay accepted',async t=>{
  const f=await memoryFixture(t),item=receiptItem(),correct=receiptResponse(item);
  validateAcceptance('receipt',item,correct);
  for(const field of ['receipt_id','session_id','turn_id','workstream_id']) {
    const wrong=structuredClone(correct);wrong.delivery.receipts[0][field]='wrong';
    assert.throws(()=>validateAcceptance('receipt',item,wrong),e=>e.errorCode==='RECEIPT_MISMATCH');
  }
  for(const field of ['resume_id','preview_version']) {const wrong=structuredClone(correct);wrong.delivery[field]='wrong';assert.throws(()=>validateAcceptance('receipt',item,wrong));}
  mkdirSync(path.join(f.root,'receipts'));const file=path.join(f.root,'receipts/receipt.json');writeFileSync(file,JSON.stringify(item));
  let acknowledged=0;
  const run=send=>flushQueue(queueItems(path.dirname(file),'receipt'),{root:f.root,credential:'test',send,accepted:()=>acknowledged++});
  const first=await run(async()=>({ok:true}));assert.equal(first.flushed,0);assert.equal(acknowledged,0);assert.ok(existsSync(file));
  const isolated=path.join(f.root,'retry-receipts');mkdirSync(isolated);writeFileSync(path.join(isolated,'receipt.json'),JSON.stringify(item));
  const replay=await flushQueue(queueItems(isolated,'receipt'),{root:isolated,credential:'test',send:async()=>{throw Object.assign(protocolError('IDEMPOTENT_REPLAY',409),{responseData:{...correct,error_code:'IDEMPOTENT_REPLAY'}});}});
  assert.equal(replay.flushed,1);
});

test('Q-12 live lane locks cannot be stolen and dead process ownership recovers',async t=>{
  const f=await memoryFixture(t);const release=claimLane(f.root,'session:a');assert.ok(release);
  assert.equal(claimLane(f.root,'session:a'),null);release();
  const module=new URL('../../plugins/mnemuron/scripts/sync-protocol.mjs',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {claimLane} from ${JSON.stringify(module)};claimLane(${JSON.stringify(f.root)},'session:a');console.log('claimed');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']});
  await once(child.stdout,'data');assert.equal(claimLane(f.root,'session:a'),null);
  child.kill('SIGKILL');await once(child,'exit');const recovered=claimLane(f.root,'session:a');assert.ok(recovered);recovered();
});

test('Q-13 server commit before local removal replays the same event without data loss',async t=>{
  const f=await memoryFixture(t);let now=Date.now();const file=enqueue(f.root,'committed');
  const send=async item=>f.store.appendEvents(f.a.auth,item.payload);
  await flushQueue(items(f.root),{root:f.root,credential:'test',now:()=>now,random:()=>1,send,afterAccepted:()=>{throw Error('simulated crash window');}});
  assert.ok(existsSync(file));assert.equal(f.store.db.prepare('SELECT count(*) n FROM events').get().n,1);
  now+=1000;
  assert.equal((await flushQueue(items(f.root),{root:f.root,credential:'test',now:()=>now,send})).flushed,1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM events').get().n,1);
});

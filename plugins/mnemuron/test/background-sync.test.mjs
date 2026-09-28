import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync, readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {enqueueOutbox, listOutbox,authorizeMcpSession,stageTaskScopeForSession,queueResumeInjection,
  claimMcpResumeDelivery,markMcpResumeContextReturned,listDeliveryReceiptOutbox,pendingMcpDeliveryAcknowledgements} from '../scripts/storage.mjs';
import {normalizeHookEvent} from '../scripts/hook.mjs';

const hook=fileURLToPath(new URL('../scripts/hook.mjs',import.meta.url));
async function until(predicate, timeout=12000) {
  const end=Date.now()+timeout;
  while(!predicate()) {assert.ok(Date.now()<end,'background synchronization deadline');await delay(30);}
}
async function fixture(t, responseDelay=1200, accept=true) {
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-background-test-')), seen=[], receipts=[], timers=new Set();
  const server=http.createServer((req,res)=>{
    let bytes='';req.on('data',b=>bytes+=b);req.on('end',()=>{
      const body=JSON.parse(bytes),id=body.event?.event_id,duplicate=seen.includes(id)?1:0;
      if(body.event)seen.push(id);else receipts.push(body);
      const timer=setTimeout(()=>{timers.delete(timer);if(res.destroyed)return;
        res.writeHead(202,{'content-type':'application/json'});
        const result=body.event?{status:'accepted',received:1,inserted:1-duplicate,duplicate,accepted_event_ids:[accept?id:'wrong-event']}:
          {receipt_event_id:body.receipt_event_id,inserted:1,duplicate:0,delivery:{resume_id:'synthetic-resume',preview_version:body.preview_version,receipts:[{
            receipt_id:body.receipt_id,session_id:body.session_id,workstream_id:body.workstream_id,turn_id:body.turn_id,
            acknowledged_at:body.occurred_at,ack_complete:true,receipt_event_ids:[body.receipt_event_id]}]}};
        res.end(JSON.stringify(result));
      },responseDelay);timers.add(timer);
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const env={...process.env,MNEMURON_CONFIG_PATH:path.join(root,'absent'),MNEMURON_MODE:'remote',
    MNEMURON_SPIKE_DATA_DIR:root,MNEMURON_SERVER_URL:`http://127.0.0.1:${server.address().port}`,
    MNEMURON_ALLOW_INSECURE_HTTP:'true',MNEMURON_API_KEY:'synthetic-key',MNEMURON_BACKGROUND_SYNC:'true',
    MNEMURON_DEVICE_ID:'synthetic',MNEMURON_AGENT_ID:'chatgpt',MNEMURON_AGENT_INSTANCE_ID:'synthetic'};
  t.after(async()=>{
    if(existsSync(root+'/background-sync.state')){const state=JSON.parse(readFileSync(root+'/background-sync.state','utf8'));
      if(state.state==='running')try{process.kill(state.pid,'SIGTERM');}catch{}}
    for(const timer of timers)clearTimeout(timer);server.closeAllConnections();await new Promise(r=>server.close(r));
    await delay(50);rmSync(root,{recursive:true,force:true});
  });
  return {root,env,seen,receipts};
}
async function invoke(env, hook_event_name='PostToolUse') {
  const started=Date.now(),p=spawn(process.execPath,[hook],{env,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
  p.stdin.end(JSON.stringify({hook_event_name,session_id:'synthetic-session',turn_id:'synthetic-turn',tool_name:'synthetic',tool_response:'fixture',last_assistant_message:'synthetic response'}));
  return new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',code=>resolve({code,stdout,stderr,elapsed:Date.now()-started}));});
}
test('slow upload is detached from foreground capture; exact ACK drains durable records',async t=>{
  const f=await fixture(t);
  const old=normalizeHookEvent({hook_event_name:'PostToolUse',session_id:'synthetic-session'},f.env,new Date(Date.now()-10000));
  enqueueOutbox(f.root,{event:old});
  const result=await invoke(f.env);
  assert.equal(result.code,0,result.stderr);assert.ok(result.elapsed<1000,`foreground took ${result.elapsed}ms`);
  assert.deepEqual(JSON.parse(result.stdout),{});assert.equal(listOutbox(f.root).length,2);
  await until(()=>listOutbox(f.root).length===0);assert.equal(f.seen.length,2);
});
test('concurrent hooks share one bounded pump without duplicate accepted sends',async t=>{
  const f=await fixture(t,150);
  const results=await Promise.all(Array.from({length:6},()=>invoke(f.env)));
  for(const r of results){assert.equal(r.code,0,r.stderr);assert.ok(r.elapsed<1000);}
  await until(()=>listOutbox(f.root).length===0);
  assert.equal(f.seen.length,6);assert.equal(new Set(f.seen).size,6);
});
test('false acceptance is retained and blocked, never silently deleted or retried',async t=>{
  const f=await fixture(t,80,false),r=await invoke(f.env,'Stop');
  assert.equal(r.code,0,r.stderr);
  await until(()=>listOutbox(f.root).some(item=>existsSync(item.filePath+'.state')&&JSON.parse(readFileSync(item.filePath+'.state')).state==='blocked_reconciliation'));
  assert.equal(listOutbox(f.root).length,1);await delay(350);assert.equal(f.seen.length,1);
});
test('a killed pump restarts from the immutable envelope and accepts a proven duplicate',async t=>{
  const f=await fixture(t,1200);await invoke(f.env);
  await until(()=>f.seen.length===1);
  const first=listOutbox(f.root)[0],bytes=readFileSync(first.filePath,'utf8');
  const state=JSON.parse(readFileSync(f.root+'/background-sync.state','utf8'));process.kill(state.pid,'SIGKILL');
  await until(()=>{try{process.kill(state.pid,0);return false;}catch{return true;}});
  assert.equal(readFileSync(first.filePath,'utf8'),bytes);
  await invoke(f.env);await until(()=>listOutbox(f.root).length===0);
  assert.equal(new Set(f.seen).size,2);assert.equal(f.seen.filter(id=>id===f.seen[0]).length,2);
});
test('Stop journals exact Session and turn ACK before exit; only the background receipt marks it reported',async t=>{
  const f=await fixture(t,700),session='synthetic-session';
  const packet={resume_id:'synthetic-resume',preview_version:1,project:{project_id:'synthetic-project'},task:{task_id:'synthetic-task',title:'Synthetic'},
    selected_workstreams:[{workstream_id:'synthetic-workstream'}],context:{goal:'Synthetic',progress:[],blockers:[],next_steps:[]},provenance:{},injection_authorized_at:new Date().toISOString()};
  authorizeMcpSession(f.root,session,{hookEventName:'UserPromptSubmit'});
  const scope=stageTaskScopeForSession(f.root,packet,session,f.env);
  queueResumeInjection(f.root,packet,session,scope.workstream_id,{injectionMethod:'codex-mcp-delivery-receipt',armed:true});
  const claimed=claimMcpResumeDelivery(f.root,session);markMcpResumeContextReturned(f.root,claimed.receipt_id);
  const r=await invoke(f.env,'Stop');assert.equal(r.code,0,r.stderr);assert.ok(r.elapsed<1000);
  const [ack]=pendingMcpDeliveryAcknowledgements(f.root);assert.ok(ack);
  assert.equal(ack.payload.session_id,session);assert.equal(ack.payload.turn_id,'synthetic-turn');
  await until(()=>listOutbox(f.root).length===0&&listDeliveryReceiptOutbox(f.root).length===0);
  assert.equal(pendingMcpDeliveryAcknowledgements(f.root).length,0);assert.equal(f.receipts.length,1);
  assert.equal(f.receipts[0].receipt_id,claimed.receipt_id);assert.equal(f.receipts[0].turn_id,'synthetic-turn');
});

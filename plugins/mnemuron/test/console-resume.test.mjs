// Console confirmation -> real Codex pending pull -> exact central delivery gate -> real Stop ACK.
// All data, credentials, endpoints and host processes belong to disposable synthetic loopback fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import http from 'node:http';
import path from 'node:path';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../../shared/console-contract.mjs';
import {callTool} from '../scripts/mcp-core.mjs';
import {activateTaskBootstrapScope,authorizeMcpSession,pendingResumeCounts,queueResumeInjection,resolveTaskScope,stageTaskScopeForSession,taskScopeCounts} from '../scripts/storage.mjs';

const HOOK=path.resolve(import.meta.dirname,'../scripts/launch-hook');
const tool='mnemuron_take_pending_resume';
function runHook(payload,env){return new Promise((resolve,reject)=>{
  const child=spawn(HOOK,[],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));child.stdin.end(JSON.stringify(payload));
});}
async function fixture(t){
  const f=await memoryFixture(t),agent=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-codex-host',agentId:'codex',agentInstanceId:'synthetic-codex-instance',
    scopes:['memory:read','memory:write','capture:write','resume:read','resume:confirm']}),owner=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES});
  const session_id='synthetic-console-destination',dataDir=path.join(f.root,'codex-host');
  const env={MNEMURON_MODE:'remote',MNEMURON_CONFIG_PATH:path.join(f.root,'no-config.json'),MNEMURON_SPIKE_DATA_DIR:dataDir,MNEMURON_SERVER_URL:f.baseUrl,
    MNEMURON_ALLOW_INSECURE_HTTP:'true',MNEMURON_API_KEY:agent.api_key,MNEMURON_BACKGROUND_SYNC:'false',MNEMURON_REQUEST_TIMEOUT_MS:'1000',
    MNEMURON_AGENT_ID:'codex',MNEMURON_DEVICE_ID:'synthetic-codex-host',MNEMURON_AGENT_INSTANCE_ID:'synthetic-codex-instance',
    MNEMURON_DEFAULT_PROJECT_ID:f.alpha.project_id,MNEMURON_DEFAULT_TASK_ID:f.alpha.task_id,MNEMURON_DEFAULT_WORKSTREAM_ID:f.alpha.workstreams[0].workstream_id,
    CODEX_THREAD_ID:session_id,CODEX_SESSION_ID:''};
  const act=async(action,payload)=>{const r=await f.request('POST','/v1/console/action',{action,payload,operation_id:randomUUID()},owner);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const read=async(view,params={})=>{const r=await f.request('GET','/v1/console/'+view+'?'+new URLSearchParams(params),undefined,owner);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  return {...f,agent,owner,env,session_id,dataDir,act,read};
}

test('Codex pulls a Console authorization for its actual active workstream and completes only after central acceptance plus Stop ACK',async t=>{
  const f=await fixture(t),activeWorkstream=f.alpha.workstreams[0].workstream_id;
  // Capture uses an already active session binding, even when the installation default points somewhere else.
  stageTaskScopeForSession(f.dataDir,{bootstrap_id:'synthetic-existing-binding',preview_version:1,project:{project_id:f.alpha.project_id},task:{task_id:f.alpha.task_id},workstream:{workstream_id:activeWorkstream}},f.session_id,f.env);
  activateTaskBootstrapScope(f.dataDir,f.session_id,f.env);f.env.MNEMURON_DEFAULT_WORKSTREAM_ID='configured-stale-default';
  const hook=await runHook({hook_event_name:'SessionStart',session_id:f.session_id,source:'startup'},f.env);assert.equal(hook.code,0,hook.stderr);
  const targets=await f.read('resume-targets'),target=targets.targets.find(v=>v.session_id===f.session_id);
  assert.ok(target);assert.equal(target.workstream_id,activeWorkstream);assert.equal(target.agent_id,'codex');
  f.store.upsertTask(f.a.auth,{...f.beta,goal:'Console-authorized source goal sentinel'});
  const p=await f.act('resume.preview',{task_id:f.beta.task_id,target_event_id:target.target_event_id,source_workstream_ids:[f.beta.workstreams[1].workstream_id]});
  const shown=await f.read('resume-status',{resume_id:p.resume_id});assert.equal(shown.can_confirm,true);assert.equal(shown.preview.task.goal,'Console-authorized source goal sentinel');
  assert.equal((await f.act('resume.confirm',{resume_id:p.resume_id,preview_version:p.preview_version,confirmed:true})).status,'queued');
  assert.equal((await f.read('resume-status',{resume_id:p.resume_id})).delivery.completed,false);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM resume_delivery_receipts').get().n,0);
  let pulls=0;const pending=f.store.consoleService.resumeWorkflows.pending.bind(f.store.consoleService.resumeWorkflows);
  f.store.consoleService.resumeWorkflows.pending=(auth,payload)=>{pulls++;return pending(auth,payload);};
  // A real HTTP failure at the central receipt gate leaves the previous scope active and no context exposed.
  const record=f.store.recordDeliveryReceipt;f.store.recordDeliveryReceipt=()=>{throw Object.assign(new Error('Synthetic central receipt outage'),{statusCode:503});};
  let deferred;
  try{deferred=await callTool(tool,{session_id:f.session_id},f.env);}finally{f.store.recordDeliveryReceipt=record;}
  assert.equal(deferred.status,'delivery_deferred');assert.equal(deferred.resume_packet_returned,false);assert.equal(deferred.resume_context,undefined);
  assert.equal(resolveTaskScope(f.dataDir,f.session_id,f.env).task_id,f.alpha.task_id);assert.equal(pulls,1);
  const delivered=await callTool(tool,{session_id:f.session_id},f.env);
  assert.equal(delivered.status,'delivered');assert.equal(delivered.resume_packet_returned,true);assert.match(delivered.resume_context,/Console-authorized source goal sentinel/);
  assert.equal(delivered.task_scope.task_id,f.beta.task_id);assert.equal(delivered.task_scope.workstream_id,activeWorkstream,'target workstream is never inferred from selected source branch or stale runtime default');
  assert.equal(pulls,1,'a staged failed delivery retries its exact receipt without another pull');
  const repeated=await callTool(tool,{session_id:f.session_id},f.env);assert.equal(repeated.status,'already_delivered_this_turn');assert.equal(repeated.resume_packet_returned,false);assert.equal(repeated.resume_context,undefined);assert.equal(pulls,1);
  const inFlight=await f.read('resume-status',{resume_id:p.resume_id});assert.equal(inFlight.status,'delivered');assert.equal(inFlight.delivery.completed,false);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM resume_delivery_receipts').get().n,1);
  await assert.rejects(callTool(tool,{session_id:'unattested-other-session'},f.env),/not attested/);
  const stopped=await runHook({hook_event_name:'Stop',session_id:f.session_id,turn_id:'synthetic-real-codex-turn',last_assistant_message:'Resumed work is in progress.'},f.env);assert.equal(stopped.code,0,stopped.stderr);
  const completed=await f.read('resume-status',{resume_id:p.resume_id});assert.equal(completed.status,'completed');assert.equal(completed.delivery.completed,true);
  const receipts=f.store.db.prepare('SELECT phase,session_id,workstream_id,turn_id FROM resume_delivery_receipts WHERE resume_id=? ORDER BY rowid').all(p.resume_id);
  assert.deepEqual(receipts.map(r=>r.phase),['delivered','acknowledged']);assert.equal(receipts[1].turn_id,'synthetic-real-codex-turn');assert.ok(receipts.every(r=>r.session_id===f.session_id&&r.workstream_id===activeWorkstream));
  assert.deepEqual(pendingResumeCounts(f.dataDir),{pending:0,in_flight:0,delivered:1});
  assert.equal((await callTool(tool,{session_id:f.session_id},f.env)).status,'no_pending_resume','completed server history cannot be pulled a second time');
});

async function mockPending(t,handler){
  const f=await fixture(t),server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));f.env.MNEMURON_SERVER_URL=`http://127.0.0.1:${server.address().port}`;
  authorizeMcpSession(f.dataDir,f.session_id,{hookEventName:'SessionStart'});return f;
}
test('Codex pending pull treats an old-server 404 as empty but exposes authorization and service failures; legacy runtimes never claim Console authority',async t=>{
  let code=404,calls=0;
  const f=await mockPending(t,async(req,res)=>{calls++;assert.equal(req.method,'POST');assert.equal(req.url,'/v1/resume/pending');const chunks=[];for await(const chunk of req)chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)),{session_id:f.session_id,workstream_id:f.env.MNEMURON_DEFAULT_WORKSTREAM_ID});res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify({error:'Synthetic pending response',error_code:code===403?'INSUFFICIENT_SCOPE':'SYNTHETIC_PENDING_FAILURE'}));});
  assert.equal((await callTool(tool,{session_id:f.session_id},f.env)).status,'no_pending_resume');
  code=403;const denied=await callTool(tool,{session_id:f.session_id},f.env);assert.equal(denied.status,'delivery_deferred');assert.equal(denied.error_code,'INSUFFICIENT_SCOPE');assert.equal(denied.retryable,false);assert.equal(denied.resume_packet_returned,false);
  code=503;const outage=await callTool(tool,{session_id:f.session_id},f.env);assert.equal(outage.status,'delivery_deferred');assert.equal(outage.retryable,true);assert.equal(outage.resume_packet_returned,false);
  assert.deepEqual(pendingResumeCounts(f.dataDir),{pending:0,in_flight:0,delivered:0});assert.deepEqual(taskScopeCounts(f.dataDir),{pending:0,active:0,superseded:0});
  for(const agent of ['chatgpt','hermes','openclaw'])assert.equal((await callTool(tool,{session_id:f.session_id},{...f.env,MNEMURON_AGENT_ID:agent})).status,'no_pending_resume');
  assert.equal(calls,3,'only the actual Codex runtime opts into this new queue protocol');
});

test('Codex refuses a pending response for another destination before staging or recording delivery',async t=>{
  const f=await mockPending(t,(_req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'pending',delivery_recorded:false,
    target:{agent_id:'codex',device_id:f.env.MNEMURON_DEVICE_ID,agent_instance_id:f.env.MNEMURON_AGENT_INSTANCE_ID,session_id:'foreign-session',workstream_id:f.env.MNEMURON_DEFAULT_WORKSTREAM_ID},
    resume_packet:{resume_id:'synthetic-foreign-packet',preview_version:1,project:{project_id:f.beta.project_id},task:{task_id:f.beta.task_id},context:{goal:'Must never be returned'}}}));});
  const result=await callTool(tool,{session_id:f.session_id},f.env);assert.equal(result.status,'delivery_deferred');assert.equal(result.error_code,'RESUME_TARGET_MISMATCH');assert.equal(result.retryable,false);assert.equal(result.resume_packet_returned,false);assert.ok(!JSON.stringify(result).includes('Must never be returned'));
  assert.deepEqual(taskScopeCounts(f.dataDir),{pending:0,active:0,superseded:0});assert.deepEqual(pendingResumeCounts(f.dataDir),{pending:0,in_flight:0,delivered:0});
});

test('Concurrent Codex calls share the existing host delivery lock before any pending HTTP pull',async t=>{
  let entered,release,calls=0;const arrived=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
  const f=await mockPending(t,async(_req,res)=>{calls++;entered();await gate;res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'empty',resume_packet:null,target:null,delivery_recorded:false}));});
  const first=callTool(tool,{session_id:f.session_id},f.env);await arrived;
  try{const second=await callTool(tool,{session_id:f.session_id},f.env);assert.equal(second.status,'delivery_in_progress');assert.equal(second.resume_packet_returned,false);assert.equal(calls,1);}finally{release();}
  assert.equal((await first).status,'no_pending_resume');assert.equal(calls,1);
});

test('A permanently stale Console claim retires locally without fabricated receipts and stops blocking a fresh authorization; permission failures retain it',async t=>{
  const f=await fixture(t);
  stageTaskScopeForSession(f.dataDir,{bootstrap_id:'synthetic-stale-existing-binding',preview_version:1,project:{project_id:f.alpha.project_id},task:{task_id:f.alpha.task_id},workstream:{workstream_id:f.env.MNEMURON_DEFAULT_WORKSTREAM_ID}},f.session_id,f.env);
  activateTaskBootstrapScope(f.dataDir,f.session_id,f.env);
  const started=await runHook({hook_event_name:'SessionStart',session_id:f.session_id,source:'startup'},f.env);assert.equal(started.code,0,started.stderr);
  const target=(await f.read('resume-targets')).targets.find(v=>v.session_id===f.session_id);assert.ok(target);
  const authorize=async()=>{const p=await f.act('resume.preview',{task_id:f.beta.task_id,target_event_id:target.target_event_id});await f.act('resume.confirm',{resume_id:p.resume_id,preview_version:p.preview_version,confirmed:true});return p;};
  const old=await authorize(),record=f.store.recordDeliveryReceipt;
  f.store.recordDeliveryReceipt=()=>{throw Object.assign(new Error('Synthetic denied receipt'),{statusCode:403,errorCode:'INSUFFICIENT_SCOPE'});};
  try{const denied=await callTool(tool,{session_id:f.session_id},f.env);assert.equal(denied.status,'delivery_deferred');assert.equal(denied.resume_packet_returned,false);}finally{f.store.recordDeliveryReceipt=record;}
  assert.deepEqual(pendingResumeCounts(f.dataDir),{pending:0,in_flight:1,delivered:0},'an auth denial does not destroy the original claim');
  const file=path.join(f.dataDir,'pending-resumes',old.resume_id+'-v1.json'),before=JSON.parse(readFileSync(file,'utf8'));
  f.store.upsertTask(f.a.auth,{...f.beta,goal:'Fresh authorized version after stale source'});const fresh=await authorize();
  const stale=await callTool(tool,{session_id:f.session_id},f.env);assert.equal(stale.status,'delivery_cancelled');assert.equal(stale.error_code,'RESUME_CONTEXT_CHANGED');assert.equal(stale.resume_packet_returned,false);assert.equal(stale.retryable,false);
  const cancelled=JSON.parse(readFileSync(file,'utf8'));assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.receipt_id,before.receipt_id);assert.equal(cancelled.context_returned_at,undefined);
  const scope=JSON.parse(readFileSync(path.join(f.dataDir,'task-scopes',old.resume_id+'-v1.json'),'utf8'));assert.equal(scope.status,'cancelled');assert.equal(resolveTaskScope(f.dataDir,f.session_id,f.env).task_id,f.alpha.task_id);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM resume_delivery_receipts WHERE resume_id=?').get(old.resume_id).n,0,'retiring a stale local authorization records neither delivery, failure nor completion');
  const next=await callTool(tool,{session_id:f.session_id},f.env);assert.equal(next.status,'delivered');assert.equal(next.resume_id,fresh.resume_id);assert.match(next.resume_context,/Fresh authorized version after stale source/);
  const oldStatus=await f.read('resume-status',{resume_id:old.resume_id});assert.equal(oldStatus.status,'blocked');assert.equal(oldStatus.delivery.delivered,false);assert.equal(oldStatus.delivery.completed,false);
});

async function stageConsolePacket(f){
  stageTaskScopeForSession(f.dataDir,{bootstrap_id:'synthetic-expiry-existing-binding',preview_version:1,project:{project_id:f.alpha.project_id},task:{task_id:f.alpha.task_id},workstream:{workstream_id:f.env.MNEMURON_DEFAULT_WORKSTREAM_ID}},f.session_id,f.env);
  activateTaskBootstrapScope(f.dataDir,f.session_id,f.env);
  const started=await runHook({hook_event_name:'SessionStart',session_id:f.session_id,source:'startup'},f.env);assert.equal(started.code,0,started.stderr);
  const target=(await f.read('resume-targets')).targets.find(v=>v.session_id===f.session_id);assert.ok(target);
  const p=await f.act('resume.preview',{task_id:f.beta.task_id,target_event_id:target.target_event_id});
  await f.act('resume.confirm',{resume_id:p.resume_id,preview_version:p.preview_version,confirmed:true});
  const pending=await f.request('POST','/v1/resume/pending',{session_id:f.session_id,workstream_id:target.workstream_id},f.agent);assert.equal(pending.status,200);assert.equal(pending.body.status,'pending');
  const packet=pending.body.resume_packet;
  const scope=stageTaskScopeForSession(f.dataDir,packet,f.session_id,f.env);
  const queued=queueResumeInjection(f.dataDir,packet,f.session_id,target.workstream_id,{injectionMethod:'codex-mcp-delivery-receipt',armed:true,consoleConfirmed:true});
  return {packet,scope,queued,scopeFile:path.join(f.dataDir,'task-scopes',p.resume_id+'-v1.json'),queueFile:path.join(f.dataDir,'pending-resumes',p.resume_id+'-v1.json')};
}

test('A fresh Core validation renews an expired unclaimed Console packet and pending scope without changing its receipt identity',async t=>{
  const f=await fixture(t),local=await stageConsolePacket(f),expired=new Date(Date.now()-1000).toISOString();
  writeFileSync(local.scopeFile,JSON.stringify({...local.scope,expires_at:expired}));writeFileSync(local.queueFile,JSON.stringify({...local.queued,expires_at:expired}));
  const scopeBefore=readFileSync(local.scopeFile,'utf8'),queueBefore=readFileSync(local.queueFile,'utf8');
  // Neither ordinary local staging nor an unavailable authority grants another local lifetime.
  stageTaskScopeForSession(f.dataDir,local.packet,f.session_id,f.env);
  queueResumeInjection(f.dataDir,local.packet,f.session_id,local.scope.workstream_id,{injectionMethod:'codex-mcp-delivery-receipt',armed:true,consoleConfirmed:true});
  assert.equal(readFileSync(local.scopeFile,'utf8'),scopeBefore);assert.equal(readFileSync(local.queueFile,'utf8'),queueBefore);
  const pending=f.store.consoleService.resumeWorkflows.pending;
  f.store.consoleService.resumeWorkflows.pending=()=>{throw Object.assign(new Error('Synthetic pending outage'),{statusCode:503});};
  try{const deferred=await callTool(tool,{session_id:f.session_id},f.env);assert.equal(deferred.status,'delivery_deferred');assert.equal(deferred.resume_packet_returned,false);}finally{f.store.consoleService.resumeWorkflows.pending=pending;}
  assert.equal(readFileSync(local.scopeFile,'utf8'),scopeBefore);assert.equal(readFileSync(local.queueFile,'utf8'),queueBefore);
  // Stop a real consumer at the queue's atomic rename, after a successful Core pull. Recovery must already
  // have persisted the fresh scope, while the original expired queue and receipt identity remain untouched.
  const crashScript=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const rename=fs.renameSync;fs.renameSync=(source,target)=>{if(target===process.env.SYNTHETIC_QUEUE_FILE)process.exit(77);return rename(source,target);};syncBuiltinESMExports();
    const {callTool}=await import(${JSON.stringify(new URL('../scripts/mcp-core.mjs',import.meta.url).href)});
    await callTool('mnemuron_take_pending_resume',{session_id:process.env.CODEX_THREAD_ID});`;
  const crashed=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','--eval',crashScript],{env:{...process.env,...f.env,SYNTHETIC_QUEUE_FILE:local.queueFile},stdio:['ignore','ignore','pipe']});let stderr='';
    child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>stderr+=chunk);child.once('error',reject);child.once('close',code=>resolve({code,stderr}));
  });
  assert.equal(crashed.code,77,crashed.stderr);assert.equal(readFileSync(local.queueFile,'utf8'),queueBefore);
  assert.ok(JSON.parse(readFileSync(local.scopeFile,'utf8')).expires_at>new Date().toISOString(),'scope renewal must survive a process exit before the queue renewal');
  const result=await callTool(tool,{session_id:f.session_id},f.env);assert.equal(result.status,'delivered');assert.equal(result.resume_id,local.packet.resume_id);assert.equal(result.receipt_id,local.queued.receipt_id);
  const renewed=JSON.parse(readFileSync(local.queueFile,'utf8')),scope=JSON.parse(readFileSync(local.scopeFile,'utf8'));
  assert.equal(renewed.attempt_id,local.queued.attempt_id);assert.equal(renewed.receipt_id,local.queued.receipt_id);assert.equal(renewed.text,local.queued.text);assert.equal(renewed.created_at,local.queued.created_at);
  assert.equal(renewed.status,'in_flight');assert.ok(renewed.context_returned_at);assert.ok(renewed.expires_at>new Date().toISOString());assert.equal(scope.status,'active');assert.ok(scope.expires_at>new Date().toISOString());
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM resume_delivery_receipts WHERE resume_id=?').get(local.packet.resume_id).n,1);
  assert.equal((await callTool(tool,{session_id:f.session_id},f.env)).status,'already_delivered_this_turn');
});

test('Core revalidation cannot reset expired in-flight, returned or completed local delivery fences',async t=>{
  const f=await fixture(t),local=await stageConsolePacket(f),record=f.store.recordDeliveryReceipt;
  f.store.recordDeliveryReceipt=()=>{throw Object.assign(new Error('Synthetic receipt outage'),{statusCode:503});};
  try{assert.equal((await callTool(tool,{session_id:f.session_id},f.env)).status,'delivery_deferred');}finally{f.store.recordDeliveryReceipt=record;}
  const claimed=JSON.parse(readFileSync(local.queueFile,'utf8'));assert.equal(claimed.status,'in_flight');assert.equal(claimed.context_returned_at,undefined);
  const expired=new Date(Date.now()-1000).toISOString();writeFileSync(local.scopeFile,JSON.stringify({...local.scope,expires_at:expired}));
  for(const state of [{status:'in_flight'},{status:'in_flight',context_returned_at:expired},{status:'delivered',context_returned_at:expired,delivered_at:expired}]){
    writeFileSync(local.queueFile,JSON.stringify({...claimed,...state,expires_at:expired}));
    const queueBefore=readFileSync(local.queueFile,'utf8'),scopeBefore=readFileSync(local.scopeFile,'utf8');
    const result=await callTool(tool,{session_id:f.session_id},f.env);
    assert.equal(result.status,'delivery_reconciliation_required');assert.equal(result.resume_packet_returned,false);assert.equal(result.retryable,false);
    assert.equal(readFileSync(local.queueFile,'utf8'),queueBefore,'a successful pending read must not clear delivery evidence');assert.equal(readFileSync(local.scopeFile,'utf8'),scopeBefore);
  }
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM resume_delivery_receipts WHERE resume_id=?').get(local.packet.resume_id).n,0);
  assert.equal(resolveTaskScope(f.dataDir,f.session_id,f.env).task_id,f.alpha.task_id);
});

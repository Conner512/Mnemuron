import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../../shared/console-contract.mjs';
import {MnemuronClient,PendingResumeStore,TaskScopeStore,resolveAdapterConfig,buildHookEvent} from '../dist/client.js';

// Exercise the shipped registration/hook bodies. Only the host's identity registration helper is substituted;
// all local stores, canonical session matching, transport and Core receipts below are real.
const loader=registerHooks({resolve(specifier,context,next){
  if(specifier==='openclaw/plugin-sdk/plugin-entry')return {url:'data:text/javascript,export const definePluginEntry = entry => entry;',shortCircuit:true};
  return next(specifier,context);
}});
let plugin;
try{plugin=(await import('../dist/index.js')).default;}finally{loader.deregister();}

async function setup(t){
  const f=await memoryFixture(t),s=f.store;
  const agent=s.issueCredential({userId:f.a.auth.user_id,label:'Synthetic OpenClaw',deviceId:'synthetic-openclaw-device',agentId:'openclaw',agentInstanceId:'synthetic-openclaw-agent',
    scopes:['memory:read','capture:write','resume:read','resume:confirm']});
  const owner=s.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes:CONSOLE_WRITE_SCOPES});
  const apiKeyFile=f.root+'/openclaw.key';writeFileSync(apiKeyFile,agent.api_key,{mode:0o600});
  const input={serverUrl:f.baseUrl,allowInsecureHttp:true,apiKeyFile,outboxDir:f.root+'/capture-outbox',deviceId:agent.credential.device_id,
    agentId:agent.credential.agent_id,agentInstanceId:agent.credential.agent_instance_id,projectId:f.alpha.project_id,taskId:f.alpha.task_id,
    workstreamId:f.alpha.workstreams[0].workstream_id,rawRetentionDays:'permanent',requestTimeoutMs:1000};
  const config=resolveAdapterConfig(input),client=new MnemuronClient(config);
  const context={runId:'synthetic-real-run',sessionId:'synthetic-host-session',trigger:'user',sessionKey:'agent:main:telegram:default:direct:10001',messageProvider:'telegram',channelId:'10001',senderId:'10001'};
  const event=buildHookEvent('message_received',{content:'Synthetic existing destination session'},context,config);
  await client.submitEvent(event);
  const memory=s.saveMemory(f.a.auth,{scope:'task',task_id:f.beta.task_id,content:'Synthetic Console authorized continuation marker'}).memory;
  const hooks=new Map(),warnings=[];
  plugin.register({pluginConfig:input,logger:{info(){},warn(value){warnings.push(value);}},
    on(name,fn){const list=hooks.get(name)||[];list.push(fn);hooks.set(name,list);},registerTool(){},registerCommand(){}});
  const before=hooks.get('before_prompt_build')[0],end=async ctx=>{for(const fn of hooks.get('agent_end'))await fn({success:true,runId:ctx.runId},ctx);};
  const pending=new PendingResumeStore(config.pendingResumeDir,{workstreamId:config.workstreamId}),scopes=new TaskScopeStore(config.taskScopeDir);
  const act=async(action,payload)=>{const r=await f.request('POST','/v1/console/action',{action,payload,operation_id:randomUUID()},owner);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const authorize=async()=>{const r=await act('resume.preview',{task_id:f.beta.task_id,target_event_id:event.event_id});await act('resume.confirm',{resume_id:r.resume_id,preview_version:r.preview_version,confirmed:true});return r;};
  const status=async r=>{const result=await f.request('GET',`/v1/console/resume-status?resume_id=${r.resume_id}`,undefined,owner);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
  return {...f,s,agent,owner,input,config,client,context,event,memory,hooks,warnings,before,end,pending,scopes,authorize,status};
}

test('OpenClaw consumes Console authorization only on the exact real session, once per run, then reports actual completion',async t=>{
  const f=await setup(t),r=await f.authorize();
  const options={pendingStore:f.pending,scopeStore:f.scopes};
  const first=await f.client.pullPendingResume(f.context,options),again=await f.client.pullPendingResume(f.context,options);
  assert.equal(first.resume_id,r.resume_id);assert.equal(again.attempt_id,first.attempt_id);assert.equal(f.pending.files().length,1);
  assert.equal(first.confirmed_scope.task.task_id,f.beta.task_id);assert.equal(f.scopes.resolve(f.context),null,'receiving a packet cannot activate its task before injection');
  assert.equal((await f.status(r)).delivery.delivered,false);
  const otherContext={...f.context,runId:'other-run',sessionKey:'agent:main:telegram:default:direct:10002',channelId:'10002',senderId:'10002'};
  assert.equal(await f.before({},otherContext),undefined);assert.equal((await f.status(r)).delivery.delivered,false);
  const results=await Promise.all([f.before({},f.context),f.before({},f.context)]);
  assert.equal(results.filter(result=>result?.prependContext).length,1,'overlapping callbacks return context once');
  assert.ok(results.some(result=>result?.prependContext.includes(f.memory.content)));
  assert.equal(await f.before({},f.context),undefined,'a later duplicate callback does not inject again');
  const inflight=await f.status(r);assert.equal(inflight.status,'delivered');assert.equal(inflight.delivery.completed,false);
  assert.equal(inflight.delivery.injection.latest_attempt.session_id,f.event.session_id);
  assert.equal(inflight.delivery.injection.latest_attempt.workstream_id,f.config.workstreamId);
  assert.equal(f.scopes.resolve(f.context).task_id,f.beta.task_id);
  await f.end(f.context);
  const complete=await f.status(r);assert.equal(complete.status,'completed');assert.equal(complete.delivery.completed,true);
  assert.equal(f.s.db.prepare('SELECT count(*) n FROM resume_injection_events WHERE resume_id=?').get(r.resume_id).n,2);
  assert.equal(await f.before({},{...f.context,runId:'next-real-run'}),undefined);
});

test('OpenClaw recovers a failed first injection with the persisted exact scope and does not activate it early',async t=>{
  const f=await setup(t),r=await f.authorize(),original=MnemuronClient.prototype.submitInjectionRecord;
  let failOnce=true;
  MnemuronClient.prototype.submitInjectionRecord=async function(record,phase,...args){
    if(failOnce&&phase==='injected'){failOnce=false;throw Object.assign(new Error('Synthetic transient connection loss'),{errorCode:'NETWORK_ERROR'});}
    return original.call(this,record,phase,...args);
  };
  t.after(()=>{MnemuronClient.prototype.submitInjectionRecord=original;});
  assert.equal(await f.before({},f.context),undefined);
  assert.equal(f.scopes.resolve(f.context),null);assert.equal((await f.status(r)).delivery.delivered,false);
  const queued=f.pending.read(f.pending.files()[0]);assert.equal(queued.status,'pending');assert.equal(queued.confirmed_scope.task.task_id,f.beta.task_id);
  const recovered={...f.context,runId:'recovered-real-run'},result=await f.before({},recovered);
  assert.match(result.prependContext,/Synthetic Console authorized continuation marker/);
  assert.equal(f.scopes.resolve(recovered).task_id,f.beta.task_id);
  assert.equal((await f.status(r)).delivery.completed,false);
  await f.end(recovered);assert.equal((await f.status(r)).delivery.completed,true);
});

test('OpenClaw preserves Console authorization across temporary 401, 403 and 503 responses and retries after recovery',async t=>{
  const f=await setup(t),r=await f.authorize(),original=MnemuronClient.prototype.submitInjectionRecord;
  const failures=[401,403,503];
  MnemuronClient.prototype.submitInjectionRecord=async function(record,phase,...args){
    if(phase==='injected'&&failures.length)throw Object.assign(new Error('Synthetic temporary gateway refusal'),{statusCode:failures.shift(),errorCode:'INSUFFICIENT_SCOPE'});
    return original.call(this,record,phase,...args);
  };
  t.after(()=>{MnemuronClient.prototype.submitInjectionRecord=original;});
  for(const status of [401,403,503]){
    const context={...f.context,runId:`temporarily-refused-${status}`};
    assert.equal(await f.before({},context),undefined);
    const pending=f.pending.read(f.pending.files()[0]);
    assert.equal(pending.status,'pending',`${status} does not revoke the owner's frozen authorization`);
    assert.equal(pending.resume_id,r.resume_id);assert.equal(pending.confirmed_scope.task.task_id,f.beta.task_id);
    assert.equal(f.scopes.resolve(context),null);assert.equal((await f.status(r)).delivery.delivered,false);
  }
  const recovered={...f.context,runId:'gateway-recovered'};
  assert.ok((await f.before({},recovered))?.prependContext);await f.end(recovered);
  assert.equal((await f.status(r)).delivery.completed,true);
});

test('OpenClaw ignores a late rejection from an overlapping callback after context has already been handed off',async t=>{
  const f=await setup(t),r=await f.authorize(),original=MnemuronClient.prototype.submitInjectionRecord;
  let overlapping,release,calls=0;
  const secondEntered=new Promise(resolve=>{overlapping=resolve;}),lateFailure=new Promise(resolve=>{release=resolve;});
  MnemuronClient.prototype.submitInjectionRecord=async function(record,phase,...args){
    if(phase==='injected'){
      if(++calls===1)await secondEntered;
      else if(calls===2){overlapping();await lateFailure;throw Object.assign(new Error('Synthetic stale gateway response'),{statusCode:409,errorCode:'RESUME_CONTEXT_CHANGED'});}
    }
    return original.call(this,record,phase,...args);
  };
  t.after(()=>{release();MnemuronClient.prototype.submitInjectionRecord=original;});
  const first=f.before({},f.context),second=f.before({},f.context);
  assert.ok((await first)?.prependContext);release();assert.equal(await second,undefined);
  const current=f.pending.read(f.pending.files()[0]);assert.equal(current.status,'in_flight');assert.ok(current.handed_off_at);
  await f.end(f.context);assert.equal((await f.status(r)).delivery.completed,true);
});

test('OpenClaw discards a permanently stale Console packet so a fresh authorization can be consumed',async t=>{
  const f=await setup(t),stale=await f.authorize();
  await f.client.pullPendingResume(f.context,{pendingStore:f.pending,scopeStore:f.scopes});
  f.s.retractMemory(f.a.auth,f.memory.memory_id);
  assert.equal(await f.before({},f.context),undefined);
  assert.equal(f.pending.read(f.pending.files()[0]).status,'cancelled');assert.equal(f.scopes.resolve(f.context),null);
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM resume_injection_events WHERE resume_id=? AND phase='injected'").get(stale.resume_id).n,0);
  const fresh=await f.authorize(),next={...f.context,runId:'fresh-authorized-run'};
  const result=await f.before({},next);assert.ok(result?.prependContext);assert.equal(f.scopes.resolve(next).resume_id,fresh.resume_id);
  assert.equal((await f.status(fresh)).status,'delivered');
});

test('OpenClaw can refresh an expired local pending envelope only after Core revalidates the frozen authorization',async t=>{
  const f=await setup(t),r=await f.authorize();
  const first=await f.client.pullPendingResume(f.context,{pendingStore:f.pending,scopeStore:f.scopes}),file=f.pending.files()[0];
  f.pending.write(file,{...f.pending.read(file),expires_at:'2000-01-01T00:00:00.000Z'});
  const result=await f.before({},f.context);
  assert.ok(result?.prependContext,'a locally expired retry cannot permanently block a still-valid central authorization');
  assert.notEqual(f.pending.read(file).attempt_id,first.attempt_id);
  assert.equal((await f.status(r)).status,'delivered');
});

test('OpenClaw never polls ambiguous/internal sessions and rejects a mismatched pending response before local writes',async t=>{
  const f=await setup(t);await f.authorize();let calls=0;
  const actual=f.client.request.bind(f.client);f.client.request=async(...args)=>{calls++;return actual(...args);};
  for(const context of [{...f.context,trigger:'cron'},{...f.context,sessionId:null},{...f.context,runId:null},{...f.context,sessionKey:'internal-worker'},
    {runId:'real-run',sessionId:'host-session',trigger:'user',sessionKey:'agent:main:main'}])assert.equal(await f.client.pullPendingResume(context),null);
  assert.equal(calls,0);
  const body=await actual('POST','/v1/resume/pending',{session_id:f.event.session_id,workstream_id:f.config.workstreamId});
  f.client.request=async()=>({...body,target:{...body.target,session_id:'another-destination'}});
  await assert.rejects(f.client.pullPendingResume(f.context),error=>error.errorCode==='RESUME_PENDING_MISMATCH');
  assert.equal(f.pending.files().length,0);assert.equal(f.scopes.records().length,0);
  f.client.request=async()=>{throw Object.assign(new Error('Old Core route'),{statusCode:404});};
  assert.equal(await f.client.pullPendingResume(f.context),null);
  for(const statusCode of [401,403,503]){
    const refusal=Object.assign(new Error('Synthetic pending request refusal'),{statusCode,errorCode:'INSUFFICIENT_SCOPE'});
    f.client.request=async()=>{throw refusal;};
    await assert.rejects(f.client.pullPendingResume(f.context),error=>error===refusal,'a denied pull must reach the caller instead of claiming the queue is empty');
    assert.equal(f.pending.files().length,0);assert.equal(f.scopes.records().length,0);
  }
  f.client.request=actual;
  assert.equal((await f.client.pullPendingResume(f.context)).resume_id,body.resume_packet.resume_id,'the same authorization can be fetched after transport/access recovery');
  assert.equal(f.scopes.resolve(f.context),null);
});

test('OpenClaw completion racing the accepted injection response cannot ACK context that was never handed off',async t=>{
  const f=await setup(t),r=await f.authorize(),original=MnemuronClient.prototype.submitInjectionRecord;
  let entered,release,hold=true;
  const accepted=new Promise(resolve=>{entered=resolve;}),response=new Promise(resolve=>{release=resolve;});
  MnemuronClient.prototype.submitInjectionRecord=async function(record,phase,...args){
    const result=await original.call(this,record,phase,...args);
    if(hold&&phase==='injected'){hold=false;entered();await response;}
    return result;
  };
  t.after(()=>{release();MnemuronClient.prototype.submitInjectionRecord=original;});
  const running=f.before({},f.context);await accepted;
  assert.equal((await f.status(r)).delivery.completed,false);assert.equal(f.scopes.resolve(f.context),null);
  await f.end(f.context);
  const ended=await f.status(r);assert.equal(ended.status,'failed');assert.equal(ended.delivery.completed,false);
  assert.equal(ended.delivery.injection.latest_attempt.error.code,'context_not_handed_off');
  release();assert.equal(await running,undefined);assert.equal(f.scopes.resolve(f.context),null,'a late accepted response cannot activate context after completion');
  assert.equal(f.s.db.prepare("SELECT count(*) n FROM resume_injection_events WHERE resume_id=? AND phase='acknowledged'").get(r.resume_id).n,0);
  const next={...f.context,runId:'actual-retry-turn'};assert.ok((await f.before({},next))?.prependContext);await f.end(next);
  assert.equal((await f.status(r)).delivery.completed,true);
});

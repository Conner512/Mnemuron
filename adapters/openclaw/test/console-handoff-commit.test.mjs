// Original shipped hooks and disk stores; only transport and host registration are substituted. No sockets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {registerHooks} from 'node:module';
import {MnemuronClient,PendingResumeStore,TaskScopeStore,resolveAdapterConfig} from '../dist/client.js';

const loader=registerHooks({resolve(specifier,context,next){
  if(specifier==='openclaw/plugin-sdk/plugin-entry')return {url:'data:text/javascript,export const definePluginEntry = entry => entry;',shortCircuit:true};
  return next(specifier,context);
}});
let plugin;
try{plugin=(await import('../dist/index.js')).default;}finally{loader.deregister();}

function setup(t,{manual=false,contextOverrides={}}={}){
  const root=mkdtempSync(path.join(os.tmpdir(),'mnemuron-core-test-handoff-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const input={serverUrl:'https://synthetic.example.test',apiKeyFile:path.join(root,'key'),outboxDir:path.join(root,'outbox'),
    deviceId:'synthetic-device',agentId:'openclaw',agentInstanceId:'synthetic-instance',projectId:'default-project',taskId:'default-task',workstreamId:'synthetic-stream'};
  const config=resolveAdapterConfig(input),receipts=[],warnings=[],events=[],hooks=new Map();
  t.mock.method(MnemuronClient.prototype,'request',async()=>{throw new Error('No network permitted in this fixture');});
  t.mock.method(MnemuronClient.prototype,'submitEvent',async record=>{events.push(record);return {delivery:'synchronized'};});
  t.mock.method(MnemuronClient.prototype,'flushInjectionEventOutbox',async()=>({flushed:0}));
  t.mock.method(MnemuronClient.prototype,'submitInjectionRecord',async(record,phase)=>{receipts.push({phase,attempt:record.attempt_id});});
  t.mock.method(MnemuronClient.prototype,'queueInjectionRecord',(record,phase)=>{receipts.push({phase,attempt:record.attempt_id});});
  t.mock.method(MnemuronClient.prototype,'pullPendingResume',async()=>null);
  const logger={info(){},warn(value){warnings.push(value);}};
  plugin.register({pluginConfig:input,logger,on(name,fn){const list=hooks.get(name)||[];list.push(fn);hooks.set(name,list);},registerTool(){},registerCommand(){}});
  const context={runId:'synthetic-run',sessionId:'synthetic-session',trigger:'user',sessionKey:'agent:main:telegram:default:direct:10001',messageProvider:'telegram',channelId:'10001',senderId:'10001',...contextOverrides};
  const pending=new PendingResumeStore(config.pendingResumeDir,{workstreamId:config.workstreamId}),scopes=new TaskScopeStore(config.taskScopeDir);
  const packet={resume_id:'synthetic-resume',preview_version:1,project:{project_id:'selected-project'},task:{task_id:'selected-task'},context:{goal:'Synthetic accepted context'}};
  const previous={...packet,resume_id:'previous-resume',task:{task_id:'previous-task'}};
  scopes.stage({packet:previous,context,workstreamId:config.workstreamId});scopes.activate(context);
  pending.queue({packet,text:'Synthetic accepted context',context,workstreamId:config.workstreamId,
    ...(manual?{}:{confirmedScope:packet,authorizationSource:'console'})});
  if(manual)scopes.stage({packet,context,workstreamId:config.workstreamId});
  const before=(ctx=context)=>hooks.get('before_prompt_build')[0]({},ctx);
  const end=async(ctx=context)=>{for(const fn of hooks.get('agent_end'))await fn({success:true,runId:ctx.runId},ctx);};
  const afterTool=(ctx=context)=>hooks.get('after_tool_call')[0]({toolName:'synthetic_tool',params:{},result:{}},ctx);
  const row=()=>pending.read(pending.files()[0]);
  return {config,receipts,warnings,events,context,pending,scopes,packet,previous,before,end,afterTool,row,logger};
}

for(const failurePoint of ['stage','scope-write','marker-write']){
  test(`Console ${failurePoint} failure keeps the previous scope, never ACKs missing context and retries once`,async t=>{
    const f=setup(t);let refused=false;
    const Type=failurePoint==='marker-write'?PendingResumeStore:TaskScopeStore;
    const method=failurePoint==='stage'?'stage':'write',original=Type.prototype[method];
    t.mock.method(Type.prototype,method,function(...args){
      const record=args[1],fails=failurePoint==='stage'||failurePoint==='scope-write'&&record?.status==='prepared'||failurePoint==='marker-write'&&record?.handed_off_at;
      if(!refused&&fails){refused=true;throw Object.assign(new Error('Synthetic disk full'),{code:'ENOSPC'});}
      return original.apply(this,args);
    });
    assert.equal(await f.before(),undefined);assert.equal(refused,true);
    assert.equal(f.row().status,'pending');assert.ok(!f.row().handed_off_at);assert.equal(f.row().scope_commit,undefined);
    const restarted=new TaskScopeStore(f.config.taskScopeDir);
    assert.equal(restarted.activate(f.context).task_id,'previous-task','ordinary capture must not activate an orphan preparation');
    assert.equal(restarted.resolve(f.context).task_id,'previous-task');
    await f.end();assert.equal(f.receipts.some(r=>r.phase==='acknowledged'),false);
    const next={...f.context,runId:'retry-run'};
    assert.deepEqual(await f.before(next),{prependContext:'Synthetic accepted context'});
    assert.equal(await f.before(next),undefined);
    assert.equal(restarted.resolve(next).task_id,'selected-task');
    await f.end(next);assert.equal(f.row().status,'delivered');
    assert.equal(f.receipts.filter(r=>r.phase==='acknowledged').length,1);
  });
}

test('Console activation is committed with the marker, without calling the fallible manual activator',async t=>{
  const f=setup(t);
  t.mock.method(TaskScopeStore.prototype,'activate',()=>{throw new Error('Manual activation is unavailable');});
  assert.deepEqual(await f.before(),{prependContext:'Synthetic accepted context'});
  assert.equal(f.scopes.resolve(f.context).task_id,'selected-task');assert.ok(f.row().scope_commit);
  await f.end();assert.equal(f.receipts.filter(r=>r.phase==='acknowledged').length,1);
});

test('Console recovers the same prepared attempt after persistent pending storage failure and a manual scope switch',async t=>{
  const f=setup(t),original=PendingResumeStore.prototype.write;let blocked=false;
  const writer=t.mock.method(PendingResumeStore.prototype,'write',function(file,record){
    if(record.handed_off_at)blocked=true;
    if(blocked)throw Object.assign(new Error('Synthetic pending volume full'),{code:'ENOSPC'});
    return original.call(this,file,record);
  });
  await assert.rejects(f.before(),{code:'ENOSPC'});
  const attempt=f.row().attempt_id,preparedFile=f.scopes.files().find(file=>f.scopes.read(file).handoff);
  const prepared=f.scopes.read(preparedFile);
  assert.equal(f.row().status,'in_flight');assert.ok(!f.row().handed_off_at);assert.equal(f.row().scope_commit,undefined);
  assert.equal(f.scopes.resolve(f.context).task_id,'previous-task');
  await f.end();assert.equal(f.receipts.some(r=>r.phase==='acknowledged'),false);

  const manualPacket={...f.packet,resume_id:'intervening-manual-resume',task:{task_id:'intervening-manual-task'}};
  f.scopes.stage({packet:manualPacket,context:f.context,workstreamId:f.config.workstreamId});
  const manual=f.scopes.activate(f.context);
  const manualTime=new Date(Date.parse(prepared.handoff.committed_at)+1).toISOString();
  f.scopes.write(f.scopes.target(manualPacket.resume_id,manualPacket.preview_version),{...manual,activated_at:manualTime});
  assert.equal(f.scopes.resolve(f.context).task_id,'intervening-manual-task');

  // Restore the writer entirely: both the marker and failed-attempt cleanup were unavailable above.
  writer.mock.restore();
  assert.deepEqual(await f.before(),{prependContext:'Synthetic accepted context'});
  assert.equal(f.row().attempt_id,attempt);assert.ok(f.row().scope_commit.committed_at>manualTime);
  assert.equal(f.scopes.resolve(f.context).task_id,'selected-task');assert.equal(await f.before(),undefined);
  await f.end();assert.equal(f.receipts.filter(r=>r.phase==='acknowledged').length,1);
});

test('A late accepted response cannot prepare or commit scope after the matching terminal hook',async t=>{
  const f=setup(t);let entered,release;
  const accepted=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  const original=MnemuronClient.prototype.submitInjectionRecord;
  t.mock.method(MnemuronClient.prototype,'submitInjectionRecord',async function(record,phase){
    await original.call(this,record,phase);if(phase==='injected'){entered();await held;}
  });
  const staging=t.mock.method(TaskScopeStore.prototype,'stage');
  const running=f.before();await accepted;await f.end();release();assert.equal(await running,undefined);
  assert.equal(staging.mock.callCount(),0);assert.equal(f.row().scope_commit,undefined);
  assert.equal(f.scopes.resolve(f.context).task_id,'previous-task');
  assert.equal(f.receipts.some(r=>r.phase==='acknowledged'),false);
});

test('Overlapping callbacks prepare one scope and return context once; diagnostic logging cannot lose it',async t=>{
  const f=setup(t);let secondEntered,calls=0;
  const both=new Promise(resolve=>{secondEntered=resolve;}),original=MnemuronClient.prototype.submitInjectionRecord;
  t.mock.method(MnemuronClient.prototype,'submitInjectionRecord',async function(record,phase){
    await original.call(this,record,phase);
    if(phase==='injected'){if(++calls===1)await both;else secondEntered();}
  });
  const staging=t.mock.method(TaskScopeStore.prototype,'stage');
  f.logger.info=()=>{throw new Error('Synthetic diagnostic logger failure');};
  const results=await Promise.all([f.before(),f.before()]);
  assert.equal(results.filter(r=>r?.prependContext).length,1);assert.equal(staging.mock.callCount(),1);
  assert.equal(f.scopes.resolve(f.context).task_id,'selected-task');
  await f.end();assert.equal(f.receipts.filter(r=>r.phase==='acknowledged').length,1);
});

test('A committed scope survives failed-turn recovery, expired-envelope renewal and a failed retry commit',async t=>{
  const f=setup(t);assert.ok((await f.before())?.prependContext);
  const first=f.row().scope_commit;
  f.pending.finish(f.context,false);
  assert.deepEqual(f.row().scope_commit,first);assert.equal(f.scopes.resolve(f.context).task_id,'selected-task');
  f.pending.claim({...f.context,runId:'interrupted-retry'});f.pending.recoverInFlight();
  assert.deepEqual(f.row().scope_commit,first);assert.equal(f.scopes.resolve(f.context).task_id,'selected-task');
  const file=f.pending.files()[0];f.pending.write(file,{...f.row(),expires_at:'2000-01-01T00:00:00.000Z'});
  f.pending.queue({packet:f.packet,text:'Synthetic accepted context',context:f.context,preserveExisting:true,
    confirmedScope:f.packet,authorizationSource:'console'});
  assert.deepEqual(f.row().scope_commit,first);
  const original=PendingResumeStore.prototype.write;
  t.mock.method(PendingResumeStore.prototype,'write',function(file,record){
    if(record.handed_off_at)throw new Error('Synthetic retry commit failure');return original.call(this,file,record);
  });
  assert.equal(await f.before({...f.context,runId:'retry-run'}),undefined);
  assert.deepEqual(f.row().scope_commit,first);
  assert.equal(new TaskScopeStore(f.config.taskScopeDir).activate(f.context).task_id,'selected-task');
});

test('Prepared scope copies cannot use a receipt for another identity or destination',async t=>{
  const f=setup(t);assert.ok((await f.before())?.prependContext);
  const file=f.scopes.files().find(file=>f.scopes.read(file).handoff),original=f.scopes.read(file);
  for(const patch of [{task_id:'unapproved-task'},{project_id:'unapproved-project'},{workstream_id:'unapproved-stream'},
    {host_session_id:'another-host-session'},{sender_id:'another-sender'},
    {handoff:{...original.handoff,attempt_id:'uncommitted-attempt'}}]){
    f.scopes.write(file,{...original,...patch});
    assert.equal(f.scopes.resolve(f.context).task_id,'previous-task');
    assert.equal(f.scopes.activate(f.context).task_id,'previous-task','capture must not promote an invalid preparation');
  }
  f.scopes.write(file,original);assert.equal(f.scopes.resolve(f.context).task_id,'selected-task');
});

test('Console receipt ordering wins over an older binding even with equal or backwards wall-clock time',async t=>{
  const f=setup(t),file=f.scopes.files()[0],old=f.scopes.read(file);
  const future='2099-01-01T00:00:00.000Z';f.scopes.write(file,{...old,activated_at:future});
  assert.ok((await f.before())?.prependContext);
  assert.ok(f.row().scope_commit.committed_at>future);assert.equal(f.scopes.resolve(f.context).task_id,'selected-task');
});

test('Manual conversation bindings keep their normal activation and completion behavior',async t=>{
  const f=setup(t,{manual:true});assert.ok((await f.before())?.prependContext);
  assert.equal(f.scopes.resolve(f.context).task_id,'selected-task');assert.equal(f.row().scope_commit,undefined);
  assert.equal(await f.before(),undefined);await f.end();assert.equal(f.row().status,'delivered');
});

test('A recovered Console envelope binds the accepted current host session on the same authorized route',async t=>{
  const f=setup(t),claim=f.pending.claim(f.context);
  f.pending.fail(claim.attempt_id);
  const current={...f.context,runId:'recovered-run',sessionId:'restarted-host-session',sessionKey:'agent:main:main',accountId:'default',peerType:'direct'};
  assert.deepEqual(await f.before(current),{prependContext:'Synthetic accepted context'});
  const scope=f.scopes.resolve(current);
  assert.equal(scope.host_session_id,current.sessionId);assert.equal(scope.session_key,current.sessionKey);
  assert.equal(f.row().scope_commit.identity.host_session_id,current.sessionId);
  await f.end(current);assert.equal(f.receipts.filter(r=>r.phase==='acknowledged').length,1);
});

for(const nextSessionKey of ['agent:main:main','agent:main:telegram:default:direct:10001']){
  test(`Console scope captures sparse generic hooks on initial and later runs via ${nextSessionKey}`,async t=>{
    const f=setup(t,{contextOverrides:{sessionKey:'agent:main:main',accountId:'default',peerType:'direct'}});
    assert.ok((await f.before())?.prependContext);
    const receipt=f.row().scope_commit,firstScope=f.scopes.resolve(f.context);
    const sparse=ctx=>({runId:ctx.runId,sessionId:ctx.sessionId,sessionKey:'agent:main:main'});
    await f.afterTool(sparse(f.context));await f.end(sparse(f.context));
    assert.deepEqual(f.events.map(event=>event.task_id),['selected-task','selected-task']);
    assert.equal(f.receipts.filter(r=>r.phase==='acknowledged').length,1);

    const next={...f.context,runId:'subsequent-run',sessionId:'new-host-session',sessionKey:nextSessionKey};
    assert.equal(await f.before(next),undefined);
    const rebound=f.scopes.resolve(sparse(next));
    assert.equal(rebound.task_id,'selected-task');assert.equal(rebound.run_id,next.runId);
    assert.deepEqual(f.row().scope_commit,receipt);assert.deepEqual(rebound.handoff,firstScope.handoff);
    assert.equal(rebound.host_session_id,firstScope.host_session_id);
    assert.equal(rebound.session_key,firstScope.session_key);
    await f.afterTool(sparse(next));await f.end(sparse(next));
    assert.deepEqual(f.events.map(event=>event.task_id),Array(4).fill('selected-task'));
    assert.ok(f.events.every(event=>event.project_id==='selected-project'&&event.workstream_id==='synthetic-stream'));

    const other={...next,runId:'unrelated-run',sessionKey:'agent:main:main',channelId:'20002',senderId:'20002'};
    assert.equal(await f.before(other),undefined);
    await f.afterTool(sparse(other));await f.end(sparse(other));
    assert.deepEqual(f.events.slice(-2).map(event=>event.task_id),['default-task','default-task']);
    assert.equal(f.scopes.resolve({...sparse(next),messageProvider:'telegram',channelId:'20002',senderId:'20002'}),null);
    assert.deepEqual(f.row().scope_commit,receipt);assert.deepEqual(f.warnings,[]);
  });
}

test('Handoff preparation rejects a thenable result without writing a marker',t=>{
  const f=setup(t),claim=f.pending.claim(f.context);
  assert.throws(()=>f.pending.markHandedOff(claim.attempt_id,()=>Promise.resolve()),/must be synchronous/);
  assert.ok(!f.row().handed_off_at);assert.equal(f.row().scope_commit,undefined);
});

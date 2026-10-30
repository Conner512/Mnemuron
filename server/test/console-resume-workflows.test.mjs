import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES,CONSOLE_READ_SCOPES} from '../../shared/console-contract.mjs';
import {ConsoleResumeWorkflows} from '../lib/console/resume-workflows.mjs';

const agentScopes=['memory:read','capture:write','resume:read','resume:confirm'];
const code=expected=>error=>error.errorCode===expected;
async function fixture(t){
  const f=await memoryFixture(t),s=f.store;
  const issue=(agent_id='codex',scopes=agentScopes,user=f.a.auth.user_id)=>{
    const c=s.issueCredential({userId:user,label:`Synthetic ${agent_id}`,deviceId:`device-${randomUUID()}`,agentId:agent_id,agentInstanceId:`agent-${randomUUID()}`,scopes});
    return {...c,auth:s.authenticate(c.api_key)};
  };
  const owner=issue('mnemuron-console',CONSOLE_WRITE_SCOPES),reader=issue('mnemuron-console',CONSOLE_READ_SCOPES),agent=issue();
  const workflows=s.consoleService.resumeWorkflows||new ConsoleResumeWorkflows(s.consoleService);
  s.consoleService.resumeWorkflows=workflows;
  let clock=Date.now()-10000;
  const event=(who=agent,p={})=>{
    const e={event_id:randomUUID(),event_type:'user_message',captured_at:new Date(clock+=10).toISOString(),
      project_id:f.alpha.project_id,task_id:f.alpha.task_id,session_id:'synthetic-existing-session',workstream_id:f.alpha.workstreams[0].workstream_id,
      content:'Synthetic visible source context',...p};
    s.appendEvents(who.auth,{events:[e]});return e;
  };
  const target=event(),create=(p={},who=owner)=>workflows.apply(who.auth,'resume.preview',{task_id:f.alpha.task_id,target_event_id:target.event_id,...p});
  const confirm=(r,confirmed=true,who=owner)=>workflows.apply(who.auth,'resume.confirm',{resume_id:r.resume_id,preview_version:r.preview_version,confirmed});
  const status=(r,who=owner)=>workflows.read(who.auth,'resume-status',{resume_id:r.resume_id});
  const pending=(who=agent,p={})=>workflows.pending(who.auth,{session_id:target.session_id,workstream_id:target.workstream_id,...p});
  const receipt=(r,phase='delivered',patch={})=>({receipt_event_id:randomUUID(),receipt_id:'synthetic-receipt',preview_version:r.preview_version,
    phase,session_id:target.session_id,workstream_id:target.workstream_id,delivery_method:'codex-mcp-tool-result',occurred_at:new Date().toISOString(),
    ...(phase==='acknowledged'?{turn_id:'synthetic-real-turn'}:{}),...patch});
  // Test the exported fence and the real Store append path. Root wires the same fence at both HTTP entry points.
  const record=(r,p,who=agent)=>s.memoryTransaction(()=>{workflows.assertReceipt(who.auth,r.resume_id,p,'receipt');return s.recordDeliveryReceipt(who.auth,r.resume_id,p);});
  return {...f,s,owner,reader,agent,workflows,issue,event,target,create,confirm,status,pending,receipt,record};
}

test('Console Resume targets are real, current, supported Agent sessions and page within the owner',async t=>{
  const f=await fixture(t),second=f.issue('hermes'),secondTarget=f.event(second,{session_id:'second-session'});
  const weak=f.issue('codex',['capture:write','resume:read']);f.event(weak,{session_id:'weak-session'});
  const unsupported=f.issue('claude-code');f.event(unsupported,{session_id:'unsupported-session'});
  const foreign=f.issue('openclaw',agentScopes,f.other.auth.user_id);
  f.event(foreign,{project_id:f.foreign.project_id,task_id:f.foreign.task_id,session_id:'foreign-session'});
  const ended=f.issue('openclaw');f.event(ended,{session_id:'closed-session'});f.event(ended,{session_id:'closed-session',event_type:'session_end'});
  const expired=f.issue();f.event(expired,{session_id:'expired-session'});
  f.s.memoryTransaction(()=>f.s.db.prepare('UPDATE credentials SET expires_at=? WHERE credential_id=?').run('2000-01-01T00:00:00.000Z',expired.auth.credential_id));
  const first=f.workflows.read(f.reader.auth,'resume-targets',{limit:1}),next=f.workflows.read(f.reader.auth,'resume-targets',{offset:1,limit:1});
  assert.equal(first.total,2);assert.equal(first.next_offset,1);assert.equal(next.next_offset,null);
  assert.deepEqual(new Set([...first.targets,...next.targets].map(v=>v.target_event_id)),new Set([f.target.event_id,secondTarget.event_id]));
  assert.ok([...first.targets,...next.targets].every(v=>v.online==='not_observable'&&v.session_state==='observed_open'));
  assert.throws(()=>f.workflows.targets(f.owner.auth,{user_id:f.other.auth.user_id}),code('INVALID_CONSOLE_INPUT'));
  assert.throws(()=>f.create({},f.reader),code('INSUFFICIENT_SCOPE'));
  assert.throws(()=>f.create({target_event_id:foreign.credential.credential_id}),code('RESUME_TARGET_UNAVAILABLE'));
  assert.throws(()=>f.workflows.pending(f.owner.auth,{session_id:f.target.session_id,workstream_id:f.target.workstream_id}),code('INSUFFICIENT_SCOPE'));
});

test('Console Resume preview freezes selected branches and exact destination, with metadata-only confirmation',async t=>{
  const f=await fixture(t);f.event(f.agent,{session_id:'other-source-session',workstream_id:f.alpha.workstreams[1].workstream_id,content:'Unselected branch context'});
  const r=f.create({source_workstream_ids:[f.target.workstream_id]});
  assert.equal(r.status,'pending_confirmation');assert.equal(r.delivery_recorded,false);assert.equal(r.preview,undefined);assert.equal(r.resume_packet,undefined);
  const shown=f.status(r);assert.equal(shown.can_confirm,true);assert.equal(shown.target.credential_id,f.agent.auth.credential_id);
  assert.deepEqual(shown.preview.branch_selection.selected_workstream_ids,[f.target.workstream_id]);
  assert.ok(!JSON.stringify(shown.preview).includes('Unselected branch context'));
  assert.equal(shown.preview.console_target,undefined);assert.equal(shown.preview.console_source_revisions,undefined);
  assert.equal(f.pending().status,'empty');
  assert.equal(f.confirm(r).status,'queued');
  const queued=f.status(r);assert.equal(queued.status,'queued');assert.equal(queued.delivery.delivered,false);assert.equal(queued.delivery.completed,false);
  const first=f.pending(),repeated=f.pending();assert.equal(first.status,'pending');assert.deepEqual(repeated.resume_packet,first.resume_packet);
  assert.equal(first.resume_packet.resume_id,r.resume_id);assert.equal(first.delivery_recorded,false);
  assert.equal(f.s.db.prepare('SELECT count(*) n FROM resume_delivery_receipts').get().n,0);
  assert.equal(f.s.db.prepare('SELECT count(*) n FROM resume_injection_events').get().n,0);
  assert.equal(f.pending(f.agent,{session_id:'different-session'}).status,'empty');
  assert.equal(f.pending(f.issue()).status,'empty');
  assert.throws(()=>f.workflows.assertConfirmation(f.agent.auth,r.resume_id),code('INSUFFICIENT_SCOPE'));
  assert.throws(()=>f.workflows.assertConfirmation({...f.owner.auth,scopes:[...f.owner.auth.scopes,'resume:confirm'],console_resume:true},r.resume_id),code('INSUFFICIENT_SCOPE'));
});

test('Only the bound Agent can report actual delivery and paired completion; fetching never reports either',async t=>{
  const f=await fixture(t),r=f.create();f.confirm(r);f.pending();
  const other=f.issue(),wrong=f.receipt(r);
  assert.throws(()=>f.record(r,wrong,other),code('RESUME_TARGET_MISMATCH'));
  for(const patch of [{session_id:'another-session'},{workstream_id:'another-workstream'}])assert.throws(()=>f.record(r,{...wrong,...patch}),code('RESUME_TARGET_MISMATCH'));
  assert.throws(()=>f.record(r,{...wrong,preview_version:2}),code('RESUME_VERSION_CHANGED'));
  assert.equal(f.s.db.prepare('SELECT count(*) n FROM resume_delivery_receipts').get().n,0);
  f.record(r,wrong);assert.equal(f.status(r).status,'delivered');assert.equal(f.status(r).delivery.completed,false);assert.equal(f.pending().status,'empty');
  // An actual host completion can arrive after session_end and after the task has progressed.
  f.event(f.agent,{event_type:'session_end'});
  f.s.upsertTask(f.a.auth,{...f.alpha,goal:'Task progressed after the authorized delivery'});
  assert.equal(f.record(r,wrong).duplicate,1,'replaying the same accepted delivery cannot create a new handoff or lose its idempotent receipt');
  f.record(r,f.receipt(r,'acknowledged'));
  const result=f.status(r);assert.equal(result.status,'completed');assert.equal(result.delivery.completed,true);assert.equal(result.content_withheld,true);
  assert.equal(result.delivery.receipt.latest_receipt.session_id,f.target.session_id);
});

test('Injection ACK without injection is not completion and another protocol cannot redeliver in-flight context',async t=>{
  const f=await fixture(t),r=f.create();f.confirm(r);
  const p={event_id:randomUUID(),attempt_id:'synthetic-attempt',preview_version:r.preview_version,phase:'acknowledged',
    session_id:f.target.session_id,turn_id:'synthetic-host-turn',workstream_id:f.target.workstream_id,injection_method:'codex-hook',occurred_at:new Date().toISOString()};
  const record=value=>f.s.memoryTransaction(()=>{f.workflows.assertReceipt(f.agent.auth,r.resume_id,value,'injection');return f.s.recordInjectionEvent(f.agent.auth,r.resume_id,value);});
  record(p);assert.equal(f.status(r).status,'acknowledged_unpaired');assert.equal(f.status(r).delivery.completed,false);
  record({...p,event_id:randomUUID(),phase:'injected'});assert.equal(f.status(r).status,'completed');
  assert.throws(()=>f.record(r,f.receipt(r)),code('RESUME_ALREADY_DELIVERED'));
  const second=f.create();f.confirm(second);f.record(second,f.receipt(second));
  assert.throws(()=>f.workflows.assertReceipt(f.agent.auth,second.resume_id,{...p,phase:'injected'},'injection'),code('RESUME_ALREADY_DELIVERED'));
});

test('Revoked or ended target sessions cannot be confirmed, fetched, or used for a new delivery',async t=>{
  const f=await fixture(t),r=f.create();f.confirm(r);
  f.event(f.agent,{event_type:'session_end'});
  assert.equal(f.status(r).status,'blocked');assert.equal(f.status(r).preview,null);assert.equal(f.pending().status,'empty');
  assert.throws(()=>f.record(r,f.receipt(r)),code('RESUME_TARGET_UNAVAILABLE'));
  const reopened=f.event(f.agent,{event_type:'session_start'});const pending=f.create({target_event_id:reopened.event_id});
  f.s.memoryTransaction(()=>f.s.db.prepare('UPDATE credentials SET revoked_at=? WHERE credential_id=?').run(new Date().toISOString(),f.agent.auth.credential_id));
  assert.throws(()=>f.confirm(pending),code('RESUME_TARGET_UNAVAILABLE'));
  assert.equal(f.status(pending).can_confirm,false);assert.equal(f.status(pending).preview,null);
  assert.throws(()=>f.pending(),code('RESUME_TARGET_UNAVAILABLE'));
  assert.equal(f.confirm(pending,false).status,'cancelled');
});

test('A later session_start cannot revive an authorization bound to an earlier ended session epoch',async t=>{
  const f=await fixture(t),old=f.create({task_id:f.beta.task_id});f.confirm(old);
  f.event(f.agent,{event_type:'session_end'});assert.equal(f.pending().status,'empty');
  const reopened=f.event(f.agent,{event_type:'session_start'}),fresh=f.create({task_id:f.beta.task_id,target_event_id:reopened.event_id});f.confirm(fresh);
  assert.equal(f.pending().resume_packet.resume_id,fresh.resume_id,'the cancelled old session epoch cannot sit ahead of a fresh target authorization');
  assert.ok(f.status(old).blockers.includes('RESUME_TARGET_UNAVAILABLE'));
  assert.throws(()=>f.record(old,f.receipt(old)),code('RESUME_TARGET_UNAVAILABLE'));
  // A delayed old end event must not close the newly observed epoch merely because it arrived later.
  f.event(f.agent,{event_type:'session_end',captured_at:f.target.captured_at});
  assert.equal(f.pending().resume_packet.resume_id,fresh.resume_id);
});

test('Resume targets follow the current workstream of a session and block an obsolete queued destination',async t=>{
  const f=await fixture(t),old=f.create(),unconfirmed=f.create(),delivered=f.create();
  f.confirm(old);f.confirm(delivered);f.record(delivered,f.receipt(delivered));
  const next=f.event(f.agent,{workstream_id:f.alpha.workstreams[1].workstream_id});
  const targets=f.workflows.targets(f.owner.auth,{});
  assert.equal(targets.total,1);assert.equal(targets.targets[0].target_event_id,next.event_id);
  assert.equal(f.status(old).status,'blocked');assert.ok(f.status(old).blockers.includes('RESUME_TARGET_UNAVAILABLE'));
  assert.throws(()=>f.confirm(unconfirmed),code('RESUME_TARGET_UNAVAILABLE'));
  assert.throws(()=>f.create(),code('RESUME_TARGET_UNAVAILABLE'));
  assert.equal(f.pending().status,'empty');assert.equal(f.pending(f.agent,{workstream_id:next.workstream_id}).status,'empty');
  const fresh=f.create({target_event_id:next.event_id});f.confirm(fresh);
  assert.equal(f.pending(f.agent,{workstream_id:next.workstream_id}).resume_packet.resume_id,fresh.resume_id);
  // A previously delivered turn may truthfully finish after the session's active task/workstream changed.
  f.record(delivered,f.receipt(delivered,'acknowledged'));
  assert.equal(f.status(delivered).delivery.completed,true);
});

test('Console Resume rejects an oversized complete preview and rolls back every preview write',async t=>{
  const f=await fixture(t),content='合成完整上下文'.repeat(3000);
  f.event(f.agent,{content});
  const valid=f.create(),shown=f.status(valid);
  assert.equal(shown.preview.recent_activity.at(-1).content,content);
  assert.ok(Buffer.byteLength(JSON.stringify(shown))<262144);
  f.event(f.agent,{content:'合'.repeat(60000)});
  const counts=()=>['resumes','lifecycle_authority_bindings','audit_events'].map(table=>f.s.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
  const before=counts();
  assert.throws(()=>f.create(),code('TASK_WORKFLOW_PREVIEW_TOO_LARGE'));
  assert.deepEqual(counts(),before,'size rejection rolls back the Resume, authority binding and audit record');
  // Legacy Agent APIs retain their own contract. The new Console detail fails explicitly instead of sending an
  // oversized response that the BFF would drop, or silently cutting the frozen text the owner must review.
  const legacy=f.s.createPreview(f.agent.auth,{query:f.alpha.task_id});
  assert.throws(()=>f.status(legacy),code('TASK_WORKFLOW_PREVIEW_TOO_LARGE'));
});

test('Console Resume history and receipt windows remain bounded with exact totals and truthful completion',async t=>{
  const f=await fixture(t),r=f.create();f.confirm(r);
  for(let i=0;i<24;i++){
    const receipt_id=`failed-receipt-${i}`;
    f.record(r,f.receipt(r,'delivered',{receipt_id}));
    f.record(r,f.receipt(r,'failed',{receipt_id,error_code:'synthetic_failure',error_message:'错'.repeat(500)}));
    const base={attempt_id:`failed-injection-${i}`,preview_version:1,session_id:f.target.session_id,workstream_id:f.target.workstream_id,
      turn_id:`host-turn-${i}`,injection_method:'codex-hook',occurred_at:new Date().toISOString()};
    f.s.recordInjectionEvent(f.agent.auth,r.resume_id,{...base,event_id:randomUUID(),phase:'injected'});
    f.s.recordInjectionEvent(f.agent.auth,r.resume_id,{...base,event_id:randomUUID(),phase:'failed',error_code:'synthetic_failure',error_message:'错'.repeat(500)});
  }
  f.record(r,f.receipt(r,'delivered',{receipt_id:'completed-receipt'}));
  f.record(r,f.receipt(r,'acknowledged',{receipt_id:'completed-receipt'}));
  const result=f.status(r);
  assert.equal(result.delivery.completed,true);
  assert.equal(result.delivery.receipt.total,25);assert.equal(result.delivery.injection.total,24);
  assert.equal(result.delivery.receipt.truncated,true);assert.equal(result.delivery.injection.truncated,true);
  assert.ok(result.delivery.receipt.receipts.length>0&&result.delivery.receipt.receipts.length<=20);
  assert.ok(result.delivery.injection.attempts.length>0&&result.delivery.injection.attempts.length<=20);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<262144);
  f.s.upsertTask(f.a.auth,{...f.alpha,title:'合'.repeat(700)});
  for(let i=0;i<99;i++)f.create();
  const items=[];let offset=0;
  do{
    const history=f.workflows.history(f.owner.auth,{limit:100,offset});
    assert.equal(history.total,100);assert.ok(Buffer.byteLength(JSON.stringify(history))<262144);
    assert.ok(history.items.length>0);
    if(offset===0){assert.equal(history.truncated,true);assert.ok(history.next_offset>0&&history.next_offset<100);}
    items.push(...history.items);offset=history.next_offset;
  }while(offset!==null);
  assert.equal(items.length,100);assert.equal(new Set(items.map(v=>v.resume_id)).size,100);
  const item=items.find(v=>v.resume_id===r.resume_id);
  assert.equal(item.delivery.completed,true);assert.equal(item.delivery.receipt.total,25);
  assert.equal(item.delivery.injection.attempts,undefined);assert.equal(item.delivery.receipt.receipts,undefined);
  assert.equal(item.delivery.receipt.latest_receipt,undefined);
});

test('Expired previews and source changes withhold old context and require a fresh explicit preview',async t=>{
  const f=await fixture(t),memory=f.s.saveMemory(f.a.auth,{scope:'task',task_id:f.alpha.task_id,content:'Synthetic revocable context'}).memory;
  const r=f.create();f.confirm(r);const another=f.create();
  f.s.retractMemory(f.a.auth,memory.memory_id);
  assert.equal(f.status(r).preview,null);assert.ok(f.status(r).blockers.includes('RESUME_CONTEXT_CHANGED'));assert.equal(f.pending().status,'empty');
  assert.throws(()=>f.confirm(another),code('RESUME_CONTEXT_CHANGED'));
  const fresh=f.create();f.s.memoryTransaction(()=>f.s.db.prepare('UPDATE resumes SET expires_at=? WHERE resume_id=?').run('2000-01-01T00:00:00.000Z',fresh.resume_id));
  const expired=f.status(fresh);assert.equal(expired.status,'expired');assert.equal(expired.can_confirm,false);assert.equal(expired.preview,null);
  assert.throws(()=>f.confirm(fresh),error=>error.statusCode===409);
  const current=f.create();f.s.upsertTask(f.a.auth,{...f.alpha,title:'A changed canonical title'});
  assert.throws(()=>f.confirm(current),code('RESUME_CONTEXT_CHANGED'));
});

test('Resume history filters ownership and live snapshot/current projects before pagination',async t=>{
  const f=await fixture(t),ids=[];
  for(let i=0;i<5;i++)ids.push(f.create({task_id:f.beta.task_id}).resume_id);
  for(let i=0;i<4;i++)f.create();
  const foreign=f.issue('codex',agentScopes,f.other.auth.user_id);
  const legacy=f.s.createPreview(foreign.auth,{query:f.foreign.task_id});f.s.confirmPreview(foreign.auth,legacy.resume_id,1,true);
  f.s.memoryTransaction(()=>{f.s.db.prepare('INSERT INTO project_lifecycle VALUES (?,?,?,?,1,?)').run(f.a.auth.user_id,f.alpha.project_id,'deleted',null,new Date().toISOString());f.s.lifecycle.bumpGeneration(f.a.auth.user_id);});
  let offset=0,got=[];
  do{const result=f.workflows.history(f.owner.auth,{offset,limit:2});assert.equal(result.total,5);assert.ok(result.items.every(row=>row.preview===undefined&&row.task_id===f.beta.task_id));
    got.push(...result.items.map(row=>row.resume_id));offset=result.next_offset;}while(offset!==null);
  assert.deepEqual(new Set(got),new Set(ids));assert.equal(got.length,5);
  assert.throws(()=>f.status(legacy),code('RESUME_NOT_FOUND'));
  assert.throws(()=>f.workflows.history(f.owner.auth,{task_id:f.alpha.task_id}),code('PROJECT_DELETED'));
  assert.ok(f.workflows.history(f.owner.auth,{task_id:f.beta.task_id}).items.every(row=>row.content_withheld));
});

test('Handoff disable preserves existing drain but never creates another authorization or a failed retry',async t=>{
  const f=await fixture(t),r=f.create();f.confirm(r);
  f.s.memoryTransaction(()=>f.s.handoffPolicy.setEnabled(false));
  assert.throws(()=>f.create(),code('HANDOFF_DISABLED'));
  assert.equal(f.pending().resume_packet.resume_id,r.resume_id);
  f.record(r,f.receipt(r));assert.equal(f.status(r).status,'delivered');
  f.record(r,f.receipt(r,'failed',{error_code:'synthetic_host_failure'}));assert.equal(f.status(r).status,'failed');
  assert.equal(f.pending().status,'empty');
  assert.throws(()=>f.record(r,f.receipt(r,'delivered',{receipt_id:'new-attempt'})),code('HANDOFF_DRAIN_RETRY_DENIED'));
});

test('Legacy Agent-created Resumes retain their original confirmation and delivery contract',async t=>{
  const f=await fixture(t),r=f.s.createPreview(f.agent.auth,{query:f.alpha.task_id});
  assert.doesNotThrow(()=>f.workflows.assertConfirmation(f.agent.auth,r.resume_id));
  assert.equal(f.s.confirmPreview(f.agent.auth,r.resume_id,r.preview_version,true).status,'confirmed');
  assert.equal(f.status(r).origin,'agent');assert.equal(f.status(r).target,null);assert.equal(f.status(r).status,'confirmed');assert.equal(f.pending().status,'empty');
  const other=f.issue();assert.doesNotThrow(()=>f.workflows.assertReceipt(other.auth,r.resume_id,f.receipt(r),'receipt'));
  f.s.recordDeliveryReceipt(other.auth,r.resume_id,f.receipt(r));assert.equal(f.status(r).status,'delivered');
});

test('The new Console history detail cannot revive withdrawn content from a legacy frozen Agent preview',async t=>{
  const f=await fixture(t),memory=f.s.saveMemory(f.a.auth,{scope:'task',task_id:f.alpha.task_id,content:'Synthetic legacy content later withdrawn'}).memory;
  const r=f.s.createPreview(f.agent.auth,{query:f.alpha.task_id});f.s.confirmPreview(f.agent.auth,r.resume_id,r.preview_version,true);
  assert.ok(JSON.stringify(f.status(r).preview).includes(memory.content));
  f.s.retractMemory(f.a.auth,memory.memory_id);
  const result=f.status(r);assert.equal(result.preview,null);assert.equal(result.content_withheld,true);assert.ok(result.blockers.includes('RESUME_CONTEXT_CHANGED'));
});

test('HTTP Console confirmation, Agent pending and both raw receipt routes enforce the real target fence',async t=>{
  const f=await fixture(t);
  const call=async(method,url,payload,who=f.owner,status=200)=>{
    const result=await f.request(method,url,payload,who);assert.equal(result.status,status,JSON.stringify(result.body));return result.body;
  };
  const act=(action,payload,operation_id=randomUUID())=>call('POST','/v1/console/action',{action,payload,operation_id});
  const targets=await call('GET','/v1/console/resume-targets?limit=1',undefined,f.reader);assert.equal(targets.targets[0].target_event_id,f.target.event_id);
  const op=randomUUID(),input={task_id:f.alpha.task_id,target_event_id:f.target.event_id};
  const r=await act('resume.preview',input,op);
  assert.equal(r.resume_packet,undefined);assert.equal(r.preview,undefined);
  const confirm={preview_version:r.preview_version,confirmed:true};
  await call('POST',`/v1/resume/${r.resume_id}/confirm`,confirm,f.agent,403);
  await call('POST',`/v1/resume/${r.resume_id}/confirm`,confirm,f.owner,404);
  const route='/v1/resume/pending',destination={session_id:f.target.session_id,workstream_id:f.target.workstream_id};
  await call('POST',route,destination,f.owner,404);
  assert.equal((await call('POST',route,destination,f.agent)).status,'empty');
  const authorized=await act('resume.confirm',{resume_id:r.resume_id,...confirm});assert.equal(authorized.status,'queued');assert.equal(authorized.resume_packet,undefined);
  const packet=await call('POST',route,destination,f.agent);assert.equal(packet.resume_packet.resume_id,r.resume_id);assert.equal(packet.delivery_recorded,false);
  assert.equal((await call('POST',route,destination,f.issue())).status,'empty');
  const statusUrl=`/v1/console/resume-status?resume_id=${r.resume_id}`;
  assert.equal((await call('GET',statusUrl)).delivery.delivered,false);
  const injected={event_id:randomUUID(),attempt_id:'http-attempt',preview_version:r.preview_version,phase:'injected',
    session_id:'wrong-session',turn_id:'http-real-turn',workstream_id:f.target.workstream_id,injection_method:'codex-hook',occurred_at:new Date().toISOString()};
  await call('POST',`/v1/resume/${r.resume_id}/injection-events`,injected,f.agent,409);
  await call('POST',`/v1/resume/${r.resume_id}/delivery-receipts`,f.receipt(r),f.issue(),409);
  assert.equal(f.s.db.prepare('SELECT count(*) n FROM resume_injection_events').get().n,0);
  assert.equal(f.s.db.prepare('SELECT count(*) n FROM resume_delivery_receipts').get().n,0);
  await call('POST',`/v1/resume/${r.resume_id}/delivery-receipts`,f.receipt(r),f.agent,202);
  assert.equal((await call('GET',statusUrl)).status,'delivered');
  await call('POST',`/v1/resume/${r.resume_id}/delivery-receipts`,f.receipt(r,'acknowledged'),f.agent,202);
  assert.equal((await call('GET',statusUrl)).status,'completed');assert.equal((await call('POST',route,destination,f.agent)).status,'empty');
  f.s.memoryTransaction(()=>f.s.db.prepare('UPDATE credentials SET revoked_at=? WHERE credential_id=?').run(new Date().toISOString(),f.agent.auth.credential_id));
  const replay=await act('resume.preview',input,op);assert.equal(replay.replayed,true);assert.equal(replay.preview,undefined);assert.equal(replay.resume_packet,undefined);
  const current=await call('GET',statusUrl);assert.equal(current.preview,null);assert.equal(current.content_withheld,true);
});

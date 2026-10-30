// Real Console HTTP workflows over disposable synthetic storage. No external Agent/model/service calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {memoryFixture,businessSnapshot} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES,CONSOLE_BASIC_SCOPES,CONSOLE_READ_SCOPES} from '../../shared/console-contract.mjs';

const projectInput={project_name:'Console frozen workspace',task_title:'Prepare the first workspace',task_goal:'Keep this exact reviewed goal',workstream_name:'Owner console work'};
const confirm=p=>({preview_id:p.preview_id,preview_version:p.preview_version,confirmed:true});
const resolve=(p,decision='confirm')=>({preview_id:p.preview_id,preview_version:p.preview_version,decision});
async function setup(t){
  const f=await memoryFixture(t),issue=(user,scopes=CONSOLE_WRITE_SCOPES,agentId='mnemuron-console')=>{
    const c=f.store.issueCredential({userId:user,deviceId:'synthetic-workflow-console',agentId,agentInstanceId:randomUUID(),scopes});return {...c,auth:f.store.authenticate(c.api_key)};
  };
  const a=issue(f.a.auth.user_id),b=issue(f.other.auth.user_id),peer=issue(a.auth.user_id),basic=issue(a.auth.user_id,CONSOLE_BASIC_SCOPES),reader=issue(a.auth.user_id,CONSOLE_READ_SCOPES);
  const requestAction=(action,payload,owner=a,operation_id=randomUUID())=>f.request('POST','/v1/console/action',{action,payload,operation_id},owner);
  const act=async(action,payload,owner=a,operation_id=randomUUID())=>{const r=await requestAction(action,payload,owner,operation_id);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const requestPreview=(preview_id,owner=a)=>f.request('GET','/v1/console/task-workflow-preview?'+new URLSearchParams({preview_id}),undefined,owner);
  const read=async(preview_id,owner=a)=>{const r=await requestPreview(preview_id,owner);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const count=table=>f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  const task=taskId=>f.store.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(taskId);
  const lifecycle=async(action,projectId)=>{const p=await act('projects.lifecycle_preview',{action,project_id:projectId});
    return act(action==='delete'?'projects.lifecycle_delete':'projects.lifecycle_restore',{preview_id:p.preview_id,...(action==='delete'?{confirm_name:f.store.db.prepare('SELECT name FROM projects WHERE project_id=?').get(projectId).name}:{})});};
  // A checkpoint waiting for reconciliation (e.g. ingestion persisted evidence before its follow-up ran). The event
  // is a real captured source; only the immutable synthetic checkpoint is seeded, avoiding automatic ingest apply.
  const checkpoint=({owner=f.a,scope=f.alpha,text='Completed the synthetic checkpoint verification.',field='completed_items',safe=true,workstream=scope.workstreams[0].workstream_id}={})=>{
    const event_id=randomUUID(),checkpoint_id=randomUUID(),session_id=randomUUID(),version=f.store.db.prepare('SELECT COALESCE(MAX(version),0)+1 n FROM checkpoints WHERE user_id=? AND task_id=? AND workstream_id=?').get(owner.auth.user_id,scope.task_id,workstream).n;
    f.store.appendEvents(owner.auth,{event:{event_id,event_type:'user_message',project_id:scope.project_id,task_id:scope.task_id,workstream_id:workstream,session_id,content:'Synthetic checkpoint source'}});
    const content={latest_outcome:{source_event_id:event_id},[field]:[{text,source:'derived_from_event',source_event_id:event_id}]};
    f.store.db.prepare(`INSERT INTO checkpoints(checkpoint_id,user_id,task_id,project_id,workstream_id,session_id,version,status,trigger_type,trigger_event_id,source_fingerprint,content_json,source_event_ids_json,device_id,agent_id,agent_instance_id,generation_method,confidence,confidence_label,warnings_json,created_at)
      VALUES(?,?,?,?,?,?,?,'derived','synthetic',?,?,?,?,?,?,?,'synthetic',?,?,'[]',?)`).run(checkpoint_id,owner.auth.user_id,scope.task_id,scope.project_id,workstream,session_id,version,event_id,randomUUID(),JSON.stringify(content),JSON.stringify([event_id]),owner.auth.device_id,owner.auth.agent_id,owner.auth.agent_instance_id,safe?0.8:0.4,safe?'medium':'low',new Date().toISOString());
    return checkpoint_id;
  };
  return {...f,A:a,B:b,peer,basic,reader,issue,requestAction,act,requestPreview,read,count,task,lifecycle,checkpoint};
}
const rejected=async(promise,status,code)=>{const r=await promise;assert.equal(r.status,status,JSON.stringify(r.body));if(code)assert.equal(r.body.error_code,code,JSON.stringify(r.body));return r.body;};

test('CTW-01: bootstrap freezes a real Console actor, then creates exactly one project/task/revision with content-free retry receipts',async t=>{
  const f=await setup(t),before=businessSnapshot(f.store),credentials=f.store.db.prepare('SELECT * FROM credentials ORDER BY credential_id').all(),operation=randomUUID();
  const p=await f.act('projects.bootstrap_preview',projectInput,f.A,operation);
  assert.equal(p.status,'pending_confirmation');assert.equal(p.kind,'project_bootstrap');assert.equal(p.preview_version,1);assert.ok(!JSON.stringify(p).includes(projectInput.task_goal));
  assert.deepEqual(businessSnapshot(f.store),before,'preview creates no business records');
  const v=await f.read(p.preview_id);assert.equal(v.can_confirm,true);assert.equal(v.can_cancel,true);assert.equal(v.preview.task.goal,projectInput.task_goal);
  assert.equal(v.preview.workstream.agent_id,'mnemuron-console');assert.equal(v.preview.workstream.agent_instance_id,f.A.auth.agent_instance_id);
  assert.match(v.preview.target_session_id,/^console-session-/);assert.match(v.preview.workstream.workstream_id,/^console-workstream-/);
  const repeatedPreview=await f.act('projects.bootstrap_preview',projectInput,f.A,operation);assert.equal(repeatedPreview.preview_id,p.preview_id);assert.equal(repeatedPreview.replayed,true);
  const op=randomUUID(),saved=await f.act('projects.bootstrap_confirm',confirm(p),f.A,op),after=businessSnapshot(f.store);
  assert.equal(saved.status,'confirmed');assert.equal(saved.canonical_version,1);assert.ok(!JSON.stringify(saved).includes(projectInput.task_goal));
  assert.equal(f.task(saved.task_id).goal,projectInput.task_goal);assert.equal(after.tasks.length,before.tasks.length+1);assert.equal(after.task_canonical_revisions.length,before.task_canonical_revisions.length+1);
  for(const key of ['events','resumes','resume_delivery_receipts','memories'])assert.deepEqual(after[key],before[key],key);
  const replay=await f.act('projects.bootstrap_confirm',confirm(p),f.A,op);assert.equal(replay.replayed,true);assert.equal(replay.task_id,saved.task_id);
  await rejected(f.requestAction('projects.bootstrap_confirm',{...confirm(p),confirmed:false},f.A,op),409,'IDEMPOTENCY_CONFLICT');
  const separate=await f.act('projects.bootstrap_confirm',confirm(p));assert.equal(separate.idempotent,true);assert.equal(separate.task_id,saved.task_id);assert.deepEqual(businessSnapshot(f.store),after);
  const done=await f.read(p.preview_id);assert.equal(done.status,'confirmed');assert.equal(done.can_confirm,false,'its own legitimate creation does not invalidate the preview');
  assert.deepEqual(f.store.db.prepare('SELECT credential_id,scopes_json FROM credentials ORDER BY credential_id').all().map(r=>({...r})),credentials.map(({credential_id,scopes_json})=>({credential_id,scopes_json})),'no new credential or permanent scope grant');
  for(const row of f.store.db.prepare('SELECT result_json FROM console_operations WHERE action LIKE ?').all('%bootstrap%'))assert.ok(!row.result_json.includes(projectInput.task_goal),'all operation storage is content-free');
});

test('CTW-02: selected project bootstrap is exact, duplicate candidates cannot confirm, and project renames invalidate a frozen task creation',async t=>{
  const f=await setup(t),input={project_id:f.alpha.project_id,title:'Unique console task one',goal:'Frozen task creation goal'};
  const p=await f.act('tasks.bootstrap_preview',input),v=await f.read(p.preview_id);assert.equal(v.preview.project.project_id,f.alpha.project_id);
  const saved=await f.act('tasks.bootstrap_confirm',confirm(p));assert.equal(f.task(saved.task_id).project_id,f.alpha.project_id);
  const duplicate=await f.act('tasks.bootstrap_preview',input),d=await f.read(duplicate.preview_id);
  assert.equal(d.status,'existing_task_selection_required');assert.equal(d.can_confirm,false);assert.equal(d.preview.candidates[0].task_id,saved.task_id);
  await rejected(f.requestAction('tasks.bootstrap_confirm',confirm(duplicate)),409,'PREVIEW_CHANGED');
  const changed=await f.act('tasks.bootstrap_preview',{...input,title:'Unrelated new goal investigation'});
  f.store.upsertProject(f.a.auth,{project_id:f.alpha.project_id,name:'A concurrent project rename'});
  const before=f.count('tasks');await rejected(f.requestAction('tasks.bootstrap_confirm',confirm(changed)),409);assert.equal(f.count('tasks'),before);
  const existing=await f.act('projects.bootstrap_preview',{...projectInput,project_name:'A concurrent project rename'}),e=await f.read(existing.preview_id);
  assert.equal(e.status,'existing_project_selection_required');assert.equal(e.can_confirm,false);assert.ok(e.preview.candidates.some(c=>c.project_id===f.alpha.project_id));
});

test('CTW-03: preview expiry, version/kind checks, cancellation and operation payload conflicts never create tasks',async t=>{
  const f=await setup(t),op=randomUUID(),p=await f.act('projects.bootstrap_preview',projectInput,f.A,op),before=f.count('tasks');
  await rejected(f.requestAction('projects.bootstrap_preview',{...projectInput,task_goal:'Changed request'},f.A,op),409,'IDEMPOTENCY_CONFLICT');
  await rejected(f.requestAction('projects.bootstrap_confirm',{...confirm(p),preview_version:2}),409,'PREVIEW_CHANGED');
  await rejected(f.requestAction('tasks.bootstrap_confirm',confirm(p)),409,'PREVIEW_CHANGED');
  const cancelled=await f.act('projects.bootstrap_confirm',{...confirm(p),confirmed:false});assert.equal(cancelled.status,'cancelled');
  assert.equal((await f.read(p.preview_id)).can_confirm,false);await rejected(f.requestAction('projects.bootstrap_confirm',confirm(p)),409,'PREVIEW_CHANGED');
  const next=await f.act('projects.bootstrap_preview',{...projectInput,project_name:'Expired frozen workspace'}),clock=f.store.consoleService.taskWorkflows.clock;
  f.store.consoleService.taskWorkflows.clock=()=>Date.parse(next.expires_at)+1;
  await rejected(f.requestPreview(next.preview_id),409,'PREVIEW_EXPIRED');await rejected(f.requestAction('projects.bootstrap_confirm',confirm(next)),409,'PREVIEW_EXPIRED');
  f.store.consoleService.taskWorkflows.clock=clock;assert.equal(f.count('tasks'),before);
});

test('CTW-04: only the original live full Console credential can read or decide; arbitrary Agent identity fields and cross-owner targets are rejected',async t=>{
  const f=await setup(t),p=await f.act('projects.bootstrap_preview',projectInput);
  for(const owner of [f.basic,f.reader]){await rejected(f.requestAction('projects.bootstrap_preview',projectInput,owner),403);await rejected(f.requestPreview(p.preview_id,owner),403);}
  for(const owner of [f.B,f.peer]){await rejected(f.requestPreview(p.preview_id,owner),404,'PREVIEW_REQUIRED');await rejected(f.requestAction('projects.bootstrap_confirm',confirm(p),owner),404,'PREVIEW_REQUIRED');}
  for(const key of ['agent_id','device_id','credential_id','agent_instance_id','session_id','workstream_id'])await rejected(f.requestAction('projects.bootstrap_preview',{...projectInput,[key]:'arbitrary-agent'}),400,'INVALID_CONSOLE_INPUT');
  await rejected(f.requestAction('tasks.bootstrap_preview',{project_id:f.foreign.project_id,title:'Wrong owner',goal:'Denied'}),404,'PROJECT_NOT_FOUND');
  await rejected(f.requestAction('tasks.reconciliation_preview',{task_id:f.foreign.task_id}),404,'TASK_NOT_FOUND');
  await rejected(f.requestAction('projects.bootstrap_confirm',{...confirm(p),bootstrap_id:'override'}),400,'INVALID_CONSOLE_INPUT');
  const before=f.count('tasks');f.store.db.prepare('UPDATE credentials SET revoked_at=? WHERE credential_id=?').run(new Date().toISOString(),f.A.auth.credential_id);
  await rejected(f.requestPreview(p.preview_id),401,'INVALID_CREDENTIAL');await rejected(f.requestAction('projects.bootstrap_confirm',confirm(p)),401,'INVALID_CREDENTIAL');
  assert.throws(()=>f.store.consoleService.taskWorkflows.read(f.A.auth,'task-workflow-preview',{preview_id:p.preview_id}),{errorCode:'INVALID_CREDENTIAL'},'an in-memory auth snapshot cannot bypass current revocation');assert.equal(f.count('tasks'),before);
});

test('CTW-05: deleted projects revoke frozen content, and restored projects do not revive an old preview authority',async t=>{
  const f=await setup(t),op=randomUUID(),p=await f.act('tasks.bootstrap_preview',{project_id:f.alpha.project_id,title:'Private deleted target',goal:'Deletion content sentinel'},f.A,op);
  const rich=await f.read(p.preview_id);assert.equal(rich.preview.task.goal,'Deletion content sentinel');
  await f.lifecycle('delete',f.alpha.project_id);
  const error=await rejected(f.requestPreview(p.preview_id),409,'PROJECT_DELETED');assert.ok(!JSON.stringify(error).includes('Deletion content sentinel'));
  await rejected(f.requestAction('tasks.bootstrap_confirm',confirm(p)),409,'PROJECT_DELETED');
  const replay=await f.act('tasks.bootstrap_preview',{project_id:f.alpha.project_id,title:'Private deleted target',goal:'Deletion content sentinel'},f.A,op);
  assert.equal(replay.replayed,true);assert.ok(!JSON.stringify(replay).includes('Deletion content sentinel'),'safe ID receipt can replay without frozen text');
  await f.lifecycle('restore',f.alpha.project_id);await rejected(f.requestPreview(p.preview_id),409,'LIFECYCLE_AUTHORITY_STALE');await rejected(f.requestAction('tasks.bootstrap_confirm',confirm(p)),409,'LIFECYCLE_AUTHORITY_STALE');
  const fresh=await f.act('tasks.bootstrap_preview',{project_id:f.alpha.project_id,title:'Private deleted target',goal:'Deletion content sentinel'});assert.equal((await f.read(fresh.preview_id)).can_confirm,true);
});

test('CTW-06: confirmation and its operation receipt roll back together if the canonical write fails',async t=>{
  const f=await setup(t),p=await f.act('projects.bootstrap_preview',projectInput),before=businessSnapshot(f.store),original=f.store.insertCanonicalRevision,operation=randomUUID();
  f.store.insertCanonicalRevision=()=>{throw new Error('Synthetic canonical write failure');};
  try{await rejected(f.requestAction('projects.bootstrap_confirm',confirm(p),f.A,operation),500);}finally{f.store.insertCanonicalRevision=original;}
  assert.deepEqual(businessSnapshot(f.store),before);assert.equal(f.store.db.prepare('SELECT 1 FROM console_operations WHERE operation_id=?').get(operation),undefined);
  assert.equal((await f.read(p.preview_id)).can_confirm,true);
  const saved=await f.act('projects.bootstrap_confirm',confirm(p),f.A,operation);assert.equal(saved.status,'confirmed');assert.equal(f.task(saved.task_id).canonical_version,1);
});

test('CTW-07: safe checkpoint reconciliation is preview-only; confirmation applies precisely the frozen sources once',async t=>{
  const f=await setup(t),first=f.checkpoint(),before=f.task(f.alpha.task_id),revisions=f.count('task_canonical_revisions');
  const p=await f.act('tasks.reconciliation_preview',{task_id:f.alpha.task_id,source_checkpoint_ids:[first]}),v=await f.read(p.preview_id);
  assert.equal(v.status,'awaiting_confirmation');assert.equal(v.can_confirm,true);assert.equal(v.can_reject,true);
  assert.equal(v.preview.proposal.policy.automatic_application_eligible,true);assert.equal(v.preview.proposal.policy.automatic_application_performed,false);
  assert.deepEqual(f.task(f.alpha.task_id),before,'even safe operations do not auto-apply at Console preview');assert.equal(f.count('task_canonical_revisions'),revisions);
  const later=f.checkpoint({text:'A later decision must wait for a separate proposal.',field:'decisions',safe:false,workstream:f.alpha.workstreams[1].workstream_id});
  const frozen=await f.read(p.preview_id);assert.deepEqual(frozen.preview,v.preview,'new evidence cannot edit the shown proposal');
  const op=randomUUID(),saved=await f.act('tasks.reconciliation_resolve',resolve(p),f.A,op),after=f.task(f.alpha.task_id);
  assert.equal(saved.status,'applied');assert.equal(saved.canonical_version,before.canonical_version+1);assert.equal(JSON.parse(after.progress_json).length,1);assert.deepEqual(JSON.parse(after.decisions_json),[]);
  const revision=f.store.db.prepare('SELECT * FROM task_canonical_revisions WHERE revision_id=?').get(saved.revision_id);assert.deepEqual(JSON.parse(revision.source_checkpoint_ids_json),[first]);assert.ok(!revision.source_checkpoint_ids_json.includes(later));
  const repeated=await f.act('tasks.reconciliation_resolve',resolve(p),f.A,op);assert.equal(repeated.replayed,true);assert.equal(repeated.revision_id,saved.revision_id);
  const otherOperation=await f.act('tasks.reconciliation_resolve',resolve(p));assert.equal(otherOperation.idempotent,true);assert.equal(otherOperation.revision_id,saved.revision_id);
  assert.equal(f.count('task_canonical_revisions'),revisions+1);assert.deepEqual(f.task(f.alpha.task_id),after);assert.equal((await f.read(p.preview_id)).status,'applied');
  const next=await f.act('tasks.reconciliation_preview',{task_id:f.alpha.task_id,source_checkpoint_ids:[later]}),n=await f.read(next.preview_id);assert.equal(n.can_confirm,true);assert.equal(n.preview.proposal.operations[0].field,'decisions');
  assert.ok(!JSON.stringify(saved).includes('synthetic checkpoint verification'),'resolution receipt is content-free');
});

test('CTW-08: changed canonical state, foreign checkpoint sources and arbitrary proposal replacements cannot apply',async t=>{
  const f=await setup(t),source=f.checkpoint({field:'decisions',safe:false}),p=await f.act('tasks.reconciliation_preview',{task_id:f.alpha.task_id});
  const foreign=f.checkpoint({owner:f.other,scope:f.foreign});
  await rejected(f.requestAction('tasks.reconciliation_preview',{task_id:f.alpha.task_id,source_checkpoint_ids:[foreign]}),404);
  await rejected(f.requestAction('tasks.reconciliation_resolve',{...resolve(p),proposal_id:'arbitrary-proposal'}),400,'INVALID_CONSOLE_INPUT');
  await rejected(f.requestAction('tasks.reconciliation_preview',{task_id:f.alpha.task_id,operations:[{op:'replace_scalar',field:'title',value:'Bypass'}]}),400,'INVALID_CONSOLE_INPUT');
  f.store.upsertTask(f.a.auth,{...f.alpha,title:'Changed by the real agent',goal:'New canonical goal'});const changed=f.task(f.alpha.task_id);
  assert.equal((await f.read(p.preview_id)).can_confirm,false);await rejected(f.requestAction('tasks.reconciliation_resolve',resolve(p)),409,'PREVIEW_CHANGED');assert.deepEqual(f.task(f.alpha.task_id),changed);
  assert.ok(f.store.db.prepare('SELECT 1 FROM checkpoints WHERE checkpoint_id=?').get(source));
});

test('CTW-09: conflicting proposals expose the full frozen conflict and support reject without canonical changes',async t=>{
  const f=await setup(t),actor=f.issue(f.A.auth.user_id,['task:reconcile:read','task:reconcile:confirm'],'synthetic-reconciler'),before=f.task(f.alpha.task_id),revisions=f.count('task_canonical_revisions');
  f.store.runReconciliation(actor.auth,f.alpha.task_id,{operations:[{op:'replace_scalar',field:'title',value:'Competing title A'},{op:'replace_scalar',field:'title',value:'Competing title B'}]});
  const p=await f.act('tasks.reconciliation_preview',{task_id:f.alpha.task_id}),v=await f.read(p.preview_id);
  assert.equal(v.can_confirm,false);assert.equal(v.can_reject,true);assert.equal(v.preview.proposal.operations.length,2);assert.ok(v.preview.proposal.conflicts.length);
  await rejected(f.requestAction('tasks.reconciliation_resolve',resolve(p)),409,'RECONCILIATION_CONFLICT');
  const operation=randomUUID(),r=await f.act('tasks.reconciliation_resolve',resolve(p,'reject'),f.A,operation);assert.equal(r.status,'rejected');
  assert.equal((await f.act('tasks.reconciliation_resolve',resolve(p,'reject'),f.A,operation)).replayed,true);assert.equal((await f.read(p.preview_id)).can_reject,false);
  assert.deepEqual(f.task(f.alpha.task_id),before);assert.equal(f.count('task_canonical_revisions'),revisions);await rejected(f.requestAction('tasks.reconciliation_resolve',resolve(p)),409,'PREVIEW_CHANGED');
});

test('CTW-10: old proposal authority can only be rejected through a fresh live preview; deleted sources never leak through replays',async t=>{
  const f=await setup(t),source=f.checkpoint({text:'Private reconciliation sentinel',field:'decisions',safe:false}),op=randomUUID(),p=await f.act('tasks.reconciliation_preview',{task_id:f.alpha.task_id},f.A,op);
  await f.lifecycle('delete',f.beta.project_id);await rejected(f.requestPreview(p.preview_id),409,'LIFECYCLE_AUTHORITY_STALE');
  const fresh=await f.act('tasks.reconciliation_preview',{task_id:f.alpha.task_id}),v=await f.read(fresh.preview_id);assert.equal(v.can_confirm,false);assert.equal(v.can_reject,true);
  await rejected(f.requestAction('tasks.reconciliation_resolve',resolve(fresh)),409,'LIFECYCLE_AUTHORITY_STALE');
  assert.equal((await f.act('tasks.reconciliation_resolve',resolve(fresh,'reject'))).status,'rejected');
  await f.lifecycle('delete',f.alpha.project_id);await rejected(f.requestPreview(fresh.preview_id),409,'PROJECT_DELETED');
  const replay=await f.act('tasks.reconciliation_preview',{task_id:f.alpha.task_id},f.A,op);assert.equal(replay.replayed,true);assert.ok(!JSON.stringify(replay).includes('Private reconciliation sentinel'));
  assert.ok(f.store.db.prepare('SELECT 1 FROM checkpoints WHERE checkpoint_id=?').get(source),'sources remain retained, not purged');
});

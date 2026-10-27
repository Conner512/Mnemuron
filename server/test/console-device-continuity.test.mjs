import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {memoryFixture} from './helpers/core-memory-fixture.mjs';
import {CONSOLE_WRITE_SCOPES,CONSOLE_READ_SCOPES} from '../../shared/console-contract.mjs';

const memoryScopes=['memory:read','memory:write','capture:write'];
const continuityScopes=['resume:read','resume:confirm','task:bootstrap:preview','task:bootstrap:confirm','project:bootstrap:preview','project:bootstrap:confirm'];
const registration={label:'Synthetic Codex plugin',agent_id:'codex',device_id:'synthetic-codex',access:'read_write',task_continuity:true};

async function fixture(t){
  const f=await memoryFixture(t),key=f.root+'/console.key';
  writeFileSync(key,randomBytes(32).toString('base64url'),{mode:0o600});f.store.memoryConfig.console={key_file:key};
  const consoleKey=(user,scopes)=>f.store.issueCredential({userId:user,deviceId:'synthetic-console',agentId:'mnemuron-console',agentInstanceId:randomUUID(),scopes});
  const owner=consoleKey(f.a.auth.user_id,CONSOLE_WRITE_SCOPES),other=consoleKey(f.other.auth.user_id,CONSOLE_WRITE_SCOPES),reader=consoleKey(f.a.auth.user_id,CONSOLE_READ_SCOPES);
  const act=(action,payload,who=owner,operation_id=randomUUID())=>f.request('POST','/v1/console/action',{action,payload,operation_id},who);
  const call=async(who,method,endpoint,payload,status=200)=>{const r=await f.request(method,endpoint,payload,who);assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
  return {...f,owner,other,reader,act,call};
}

test('Console Codex continuity is explicit, bounded and rejects unsupported grants before issuance',async t=>{
  const f=await fixture(t);
  for(const agent_id of ['codex','claude-code','openclaw','hermes']){
    const base={...registration,agent_id};delete base.task_continuity;
    for(const access of ['read','read_write']){
      const r=await f.act('devices.register',{...base,access});assert.equal(r.status,200);
      const expected=access==='read'?['memory:read']:memoryScopes;
      assert.deepEqual(f.store.authenticate(r.body.api_key).scopes,expected);
      assert.equal((await f.request('POST','/v1/resume/preview',{query:f.alpha.task_id},r.body)).status,403);
      assert.equal((await f.request('POST','/v1/project-bootstrap/preview',{},r.body)).status,403);
      assert.equal((await f.request('POST','/v1/task-bootstrap/preview',{},r.body)).status,403);
    }
  }
  const before=f.store.db.prepare('SELECT count(*) n FROM credentials').get().n;
  for(const change of [{access:'read'},{agent_id:'openclaw'},{agent_id:'claude-code'},{agent_id:'hermes'},{task_continuity:'true'},{task_continuity:1},{scopes:['admin:devices']}]){
    assert.equal((await f.act('devices.register',{...registration,...change})).status,400,JSON.stringify(change));
  }
  assert.equal((await f.act('devices.register',registration,f.reader)).status,403);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM credentials').get().n,before);
});

test('Console-issued Codex key completes bootstrap and Resume with confirmation and matching delivery ACK',async t=>{
  const f=await fixture(t),issued=await f.act('devices.register',registration);
  assert.equal(issued.status,200,JSON.stringify(issued.body));const agent=issued.body;
  assert.deepEqual(f.store.authenticate(agent.api_key).scopes,[...memoryScopes,...continuityScopes]);
  const project=await f.call(agent,'POST','/v1/project-bootstrap/preview',{
    project_name:'Synthetic continuity project',task_title:'Initial synthetic task',task_goal:'Verify explicit plugin continuity',
    workstream_id:'synthetic-codex-work',workstream_name:'Codex',session_id:'synthetic-project-session',
  },201);
  assert.equal(project.status,'pending_confirmation');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM projects WHERE project_id=?').get(project.project.project_id).n,0);
  await f.call(agent,'POST',`/v1/project-bootstrap/${project.bootstrap_id}/confirm`,{
    preview_version:project.preview_version,confirmed:true,session_id:'wrong-session',
  },409);
  const confirmed=await f.call(agent,'POST',`/v1/project-bootstrap/${project.bootstrap_id}/confirm`,{
    preview_version:project.preview_version,confirmed:true,session_id:'synthetic-project-session',
  });
  assert.equal(confirmed.status,'confirmed');
  const task=await f.call(agent,'POST','/v1/task-bootstrap/preview',{
    project_query:project.project.project_id,title:'Distinct synthetic follow-up task',goal:'Verify task bootstrap authority',
    workstream_id:'synthetic-codex-followup',workstream_name:'Follow-up',session_id:'synthetic-task-session',
  },201);
  assert.equal(task.status,'pending_confirmation');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM tasks WHERE task_id=?').get(task.task.task_id).n,0);
  assert.equal((await f.call(agent,'POST',`/v1/task-bootstrap/${task.bootstrap_id}/confirm`,{
    preview_version:task.preview_version,confirmed:true,session_id:'synthetic-task-session',
  })).status,'confirmed');
  const preview=await f.call(agent,'POST','/v1/resume/preview',{query:task.task.task_id,signals:{task_id:task.task.task_id}},201);
  const receipt={preview_version:preview.preview_version,receipt_id:randomUUID(),receipt_event_id:randomUUID(),phase:'delivered',
    session_id:'synthetic-resume-session',workstream_id:'synthetic-codex-followup',delivery_method:'codex-mcp-tool-result',occurred_at:new Date().toISOString()};
  await f.call(agent,'POST',`/v1/resume/${preview.resume_id}/delivery-receipts`,receipt,409);
  assert.equal((await f.call(agent,'POST',`/v1/resume/${preview.resume_id}/confirm`,{preview_version:preview.preview_version,confirmed:true})).status,'confirmed');
  const delivered=await f.call(agent,'POST',`/v1/resume/${preview.resume_id}/delivery-receipts`,receipt,202);
  assert.equal(delivered.delivery.ack_complete,false);
  await f.call(agent,'POST',`/v1/resume/${preview.resume_id}/delivery-receipts`,{...receipt,receipt_event_id:randomUUID(),phase:'acknowledged',turn_id:'synthetic-host-turn',session_id:'different-session'},409);
  const ack=await f.call(agent,'POST',`/v1/resume/${preview.resume_id}/delivery-receipts`,{...receipt,receipt_event_id:randomUUID(),phase:'acknowledged',turn_id:'synthetic-host-turn'},202);
  assert.equal(ack.delivery.ack_complete,true);
  assert.equal((await f.call(agent,'GET',`/v1/resume/${preview.resume_id}/delivery-receipt-status`)).ack_complete,true);
  await f.call(agent,'POST','/v1/agent-instances/register',{device_id:'denied',agent_id:'codex',agent_instance_id:'denied'},403);
  await f.call(agent,'POST','/v1/tasks',{task_id:'denied'},403);
  const foreign=await f.act('devices.register',registration,f.other);assert.equal(foreign.status,200);
  await f.call(foreign.body,'GET',`/v1/resume/${preview.resume_id}/delivery-receipt-status`,undefined,404);
});

test('Codex continuity issuance replays exactly and rotation preserves scopes without upgrading other keys',async t=>{
  const f=await fixture(t),operation=randomUUID();
  const r=await f.act('devices.register',registration,f.owner,operation);assert.equal(r.status,200);
  assert.equal((await f.act('devices.register',registration,f.owner,operation)).body.api_key,r.body.api_key);
  assert.equal((await f.act('devices.register',{...registration,task_continuity:false},f.owner,operation)).status,409);
  assert.equal((await f.act('devices.rotate',{credential_id:r.body.credential.credential_id},f.other)).status,404);
  const rotated=await f.act('devices.rotate',{credential_id:r.body.credential.credential_id});assert.equal(rotated.status,200,JSON.stringify(rotated.body));
  assert.throws(()=>f.store.authenticate(r.body.api_key));
  assert.deepEqual(f.store.authenticate(rotated.body.api_key).scopes,[...memoryScopes,...continuityScopes]);
  assert.equal(rotated.body.credential.agent_instance_id,r.body.credential.agent_instance_id);
  const narrow=await f.act('devices.register',{...registration,task_continuity:false});
  const narrowRotation=await f.act('devices.rotate',{credential_id:narrow.body.credential.credential_id});assert.equal(narrowRotation.status,200);
  assert.deepEqual(f.store.authenticate(narrowRotation.body.api_key).scopes,memoryScopes);
  const managed=f.store.issueCredential({userId:f.a.auth.user_id,deviceId:'synthetic-managed',agentId:'codex',agentInstanceId:randomUUID(),scopes:[...memoryScopes,'admin:tasks']});
  assert.equal((await f.act('devices.rotate',{credential_id:managed.credential.credential_id})).status,409);
  assert.equal((await f.act('devices.revoke',{agent_instance_id:rotated.body.credential.agent_instance_id},f.other)).status,404);
  assert.equal((await f.act('devices.revoke',{agent_instance_id:rotated.body.credential.agent_instance_id})).status,200);
  assert.throws(()=>f.store.authenticate(rotated.body.api_key));
});

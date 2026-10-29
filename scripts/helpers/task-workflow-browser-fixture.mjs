// Disposable, loopback-only real Core/OAuth/BFF fixture. Stdin controls are test-only and are
// never installed as service routes. Only synthetic checkpoints require direct immutable seeding.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {memoryFixture,assertIsolatedTarget} from '../../server/test/helpers/core-memory-fixture.mjs';
import {fixture} from '../../services/oauth/test/fixture.mjs';
import {pendingAccount} from '../../services/oauth/test/helpers/identity-fixture.mjs';
import {provisionIdentities} from '../../services/oauth/src/provisioning.mjs';
import {randomSecret,writePrivate,seconds,secretHash} from '../../shared/oauth-common.mjs';

const require=createRequire(new URL('../../services/oauth/package.json',import.meta.url));
const {generate}=await import(pathToFileURL(require.resolve('otplib')));
const cleanup=[],t={after:fn=>cleanup.push(fn)},core=await memoryFixture(t);
assertIsolatedTarget(core.root,core.databasePath,core.baseUrl);
const key=path.join(core.root,'console-key');writePrivate(key,randomSecret());
core.store.memoryConfig.console={key_file:key,worker_enabled:false};
const f=await fixture(t,{start:false,mutate:c=>{
  c.identity_mode='multi_account_v1';c.login.registration_enabled=true;
  c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600,console_operations:true,
    core:{base_url:core.baseUrl},provisioning:{enabled:true,core_database:core.databasePath,credential_directory:path.join(path.dirname(c.database_file),'keys'),identity_map_file:path.join(path.dirname(c.database_file),'map.json')}};
}});
assert.equal(new URL(f.config.issuer).hostname,'127.0.0.1');writePrivate(f.config.identity.encryption_key_file,randomSecret());await f.start();
const ids=f.app.accounts,owners=[];
for(const username of ['Synthetic_Workflow_A','Synthetic_Workflow_B']){
  const o=await pendingAccount({identities:ids},username);ids.takeRecoveryCodes(o.session.token);ids.acknowledgeRecovery(o.session.token);owners.push(o);
}
provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json'),consoleOperations:true});
for(const [i,o]of owners.entries()){
  o.account=ids.byId(o.account.account_id);o.console=ids.newSession('console',{accountId:o.account.account_id});
  o.writer=core.issue(o.account.user_id,`synthetic-workflow-writer-${i}`);
  o.task={task_id:`synthetic-workflow-task-${i}`,project_id:`synthetic-workflow-project-${i}`,project_name:`Synthetic workflow project ${i}`,title:`Synthetic reconciliation task ${i}`,goal:'Synthetic reviewed workflow goal',status:'active',
    workstreams:[{workstream_id:`synthetic-workflow-primary-${i}`,name:'Synthetic primary source',status:'active'},{workstream_id:`synthetic-workflow-secondary-${i}`,name:'Synthetic secondary source',status:'active'}]};
  core.store.upsertTask(o.writer.auth,o.task);
  const credential=core.store.issueCredential({userId:o.account.user_id,label:`Synthetic Codex destination ${i}`,deviceId:`synthetic-device-${i}`,agentId:'codex',agentInstanceId:`synthetic-codex-${i}`,scopes:['memory:read','capture:write','resume:read','resume:confirm']});
  o.agent={...credential,auth:core.store.authenticate(credential.api_key)};
  o.target={event_id:randomUUID(),event_type:'user_message',project_id:o.task.project_id,task_id:o.task.task_id,session_id:`synthetic-existing-session-${i}`,workstream_id:o.task.workstreams[0].workstream_id,content:`Synthetic selected source context ${i}`};
  core.store.appendEvents(o.agent.auth,{events:[o.target,{...o.target,event_id:randomUUID(),workstream_id:o.task.workstreams[1].workstream_id,session_id:`synthetic-other-source-${i}`,content:`Synthetic unselected source sentinel ${i}`}]});
}
const scalar=(sql,...params)=>core.store.db.prepare(sql).get(...params).n;
function checkpoint(o){
  const store=core.store,scope=o.task,owner=o.writer,event_id=randomUUID(),checkpoint_id=randomUUID(),session_id=randomUUID(),workstream=scope.workstreams[0].workstream_id;
  const version=scalar('SELECT COALESCE(MAX(version),0)+1 n FROM checkpoints WHERE user_id=? AND task_id=? AND workstream_id=?',owner.auth.user_id,scope.task_id,workstream);
  store.appendEvents(owner.auth,{event:{event_id,event_type:'user_message',project_id:scope.project_id,task_id:scope.task_id,workstream_id:workstream,session_id,content:`Synthetic checkpoint source ${version}`}});
  const text=`Synthetic complete proposal ${version}`,content={latest_outcome:{source_event_id:event_id},completed_items:[{text,source:'derived_from_event',source_event_id:event_id}]};
  store.db.prepare(`INSERT INTO checkpoints(checkpoint_id,user_id,task_id,project_id,workstream_id,session_id,version,status,trigger_type,trigger_event_id,source_fingerprint,content_json,source_event_ids_json,device_id,agent_id,agent_instance_id,generation_method,confidence,confidence_label,warnings_json,created_at)
    VALUES(?,?,?,?,?,?,?,'derived','synthetic',?,?,?,?,?,?,?,'synthetic',0.8,'medium','[]',?)`).run(checkpoint_id,owner.auth.user_id,scope.task_id,scope.project_id,workstream,session_id,version,event_id,randomUUID(),JSON.stringify(content),JSON.stringify([event_id]),owner.auth.device_id,owner.auth.agent_id,owner.auth.agent_instance_id,new Date().toISOString());
  return {checkpoint_id,text};
}
function state(o){return {projects:scalar('SELECT COUNT(*) n FROM projects WHERE user_id=?',o.account.user_id),tasks:scalar('SELECT COUNT(*) n FROM tasks WHERE user_id=?',o.account.user_id),
  previews:scalar('SELECT COUNT(*) n FROM console_task_workflow_previews WHERE user_id=?',o.account.user_id),resumes:scalar('SELECT COUNT(*) n FROM resumes WHERE user_id=?',o.account.user_id),
  task:core.store.taskFromRow(core.store.db.prepare('SELECT * FROM tasks WHERE user_id=? AND task_id=?').get(o.account.user_id,o.task.task_id))};}
function ownedResume(o,id){assert.ok(typeof id==='string'&&id.length<200);const row=core.store.db.prepare('SELECT preview_version,preview_json FROM resumes WHERE user_id=? AND resume_id=?').get(o.account.user_id,id);assert.ok(row,'Synthetic owner resume exists');return row;}
let stopped=false;
async function stop(){if(stopped)return;stopped=true;for(const fn of cleanup.reverse())await fn();const removed=!fs.existsSync(core.root)&&!fs.existsSync(f.directory);
  process.stderr.write(JSON.stringify({synthetic_cleanup_complete:removed,core_storage_removed:!fs.existsSync(core.root),identity_storage_removed:!fs.existsSync(f.directory)})+'\n');process.exit(removed?0:1);}
console.log(JSON.stringify({fixture:true,url:f.config.issuer,cookie:'mnm_fixture_console',password:'Synthetic password with spaces  ',accounts:owners.map(o=>({account_id:o.account.account_id,token:o.console.token})),
  scope:{project_id:owners[0].task.project_id,task_id:owners[0].task.task_id,source_workstream_id:owners[0].target.workstream_id,target_event_id:owners[0].target.event_id}}));
const lines=readline.createInterface({input:process.stdin});
lines.on('line',async line=>{try{
  const req=JSON.parse(line);if(req.command==='stop')return stop();assert.ok([undefined,0,1].includes(req.owner));const o=owners[req.owner||0];let reply;
  if(req.command==='otp'){if(req.fresh){ids.db.prepare('DELETE FROM oauth_mfa_steps WHERE subject=?').run(o.account.subject);ids.db.prepare('DELETE FROM oauth_rate_limits WHERE key=?').run(secretHash(`console:reauth:${o.account.account_id}`));}reply={otp:await generate({secret:o.setup.secret,epoch:seconds()})};}
  else if(req.command==='state')reply=state(o);
  else if(req.command==='checkpoint')reply=checkpoint(o);
  else if(req.command==='expire-preview'){assert.ok(typeof req.preview_id==='string'&&req.preview_id.length<200);reply={changed:core.store.memoryTransaction(()=>core.store.db.prepare('UPDATE console_task_workflow_previews SET expires_at=? WHERE user_id=? AND preview_id=?').run('2000-01-01T00:00:00.000Z',o.account.user_id,req.preview_id).changes)};}
  else if(req.command==='pending'){const result=await core.request('POST','/v1/resume/pending',{session_id:o.target.session_id,workstream_id:o.target.workstream_id},o.agent);assert.equal(result.status,200);reply={status:result.body.status,resume_id:result.body.resume_packet?.resume_id,delivery_recorded:result.body.delivery_recorded};}
  else if(req.command==='receipt'){
    assert.ok(['delivered','acknowledged'].includes(req.phase));const row=ownedResume(o,req.resume_id),phase=req.phase;
    const body={receipt_event_id:randomUUID(),receipt_id:`synthetic-delivery-${req.resume_id}`,preview_version:row.preview_version,phase,session_id:o.target.session_id,workstream_id:o.target.workstream_id,
      delivery_method:'codex-mcp-tool-result',occurred_at:new Date().toISOString(),...(phase==='acknowledged'?{turn_id:'synthetic-real-completed-turn'}:{})};
    const result=await core.request('POST',`/v1/resume/${encodeURIComponent(req.resume_id)}/delivery-receipts`,body,o.agent);assert.equal(result.status,202,JSON.stringify(result.body));reply={recorded:true};
  }
  else if(req.command==='revoke-target'){core.store.db.prepare('UPDATE credentials SET revoked_at=? WHERE credential_id=?').run(new Date().toISOString(),o.agent.auth.credential_id);reply={revoked:true};}
  else if(req.command==='revoke-console'){ids.db.prepare("DELETE FROM identity_sessions WHERE account_id=? AND purpose='console'").run(o.account.account_id);reply={revoked:true};}
  else throw new Error('UNKNOWN_SYNTHETIC_COMMAND');
  console.log(JSON.stringify({command:req.command,...reply}));
}catch(error){console.log(JSON.stringify({fixture_error:error.code||error.errorCode||error.message||'FAILED'}));}});
process.on('SIGTERM',stop);process.on('SIGINT',stop);

// Project lifecycle through the ChatGPT cloud gateway write path (phase 5H, WL-02). Two real OAuth accounts in
// multi-account mode with separate cloud bindings (the A-T05 setup: identity service, provisioning and the gateway,
// all local and synthetic), against a Core whose lifecycle state was produced by the real Console delete/merge actions.
// Asserts the gateway boundary: old merged IDs route, deleted IDs and deleted-project records refuse without side
// effects, and the other account learns nothing. No live cloud service, real account or credential is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {gatewayFixture} from './fixture.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {writePrivate,randomSecret} from '../../../shared/oauth-common.mjs';
import {Browser,validatedCallback} from '../../../services/oauth/test/fixture.mjs';
import {pendingAccount} from '../../../services/oauth/test/helpers/identity-fixture.mjs';
import {provisionIdentities,identityMapSnapshot} from '../../../services/oauth/src/provisioning.mjs';
import {queueCloudBinding,prepareCloudBinding,applyCloudBinding,finishCloudBinding} from '../../../services/oauth/src/cloud-provisioning.mjs';
import {generate} from '../../../services/oauth/node_modules/otplib/dist/index.js';
import {CONSOLE_WRITE_SCOPES} from '../../../shared/console-contract.mjs';

async function authorizeOwner(f,owner){
  const browser=new Browser(f.config.issuer),verifier=randomSecret(),request={client_id:f.config.chatgpt_client.client_id,
    redirect_uri:f.config.chatgpt_client.redirect_uris[0],response_type:'code',scope:'openid offline_access memory:read project:read memory:write',
    resource:f.config.resource,state:randomSecret(),code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')};
  let r=await browser.request(`/authorize?${new URLSearchParams(request)}`);
  for(let i=0;i<12;i++){
    const location=r.headers.get('location');
    if(location){const next=new URL(location,f.config.issuer);if(next.origin!==f.config.issuer)return {callback:validatedCallback(next,f.config.issuer,request),verifier,request};r=await browser.request(next);}
    else{const csrf=r.text.match(/name="csrf" value="([^"]+)"/)?.[1],action=r.text.match(/action="([^"]+)"/)?.[1];assert.ok(csrf&&action);
      r=await browser.post(action,{csrf,...(action.endsWith('/login')?{username:owner.name,password:'Synthetic password with spaces  ',otp:await generate({secret:owner.setup.secret})}:{})});}
  }throw new Error('Synthetic flow incomplete');
}

test('WL-02: cloud gateway writes route old merged IDs, refuse deleted ones without side effects, and never cross accounts',async t=>{
  const core=await memoryFixture(t),store=core.store;Object.assign(store.runtime,{cloudMemory:true,cloudSubmittedGrant:true});
  const f=await gatewayFixture(t,{profile:'memory_readwrite',coreFixture:core,sharedOrigin:true,authMutate:c=>{
    c.cloud_memory={enabled:true,allow_submitted_revision_grant:true};c.resource_scopes.push('memory:write');c.chatgpt_client.allowed_scopes.push('memory:write');
    c.identity_mode='multi_account_v1';c.login.registration_enabled=true;c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600};
    writePrivate(c.identity.encryption_key_file,randomSecret());
  },mutate:c=>{c.cloud_memory={enabled:true,allow_submitted_revision_grant:true};c.identity_mode='multi_account_v1';
    for(const name of ['mnemuron_save_memory','mnemuron_supersede_memory','mnemuron_retract_memory','mnemuron_get_operation'])c.tools[name]={required_scope:'memory:write',profile:['memory_readwrite']};
    writePrivate(c.identity_map_file,{unknown_subject_policy:'deny',mappings:[]},{replace:true});}});
  const ids=f.app.accounts,owners=[];
  for(const name of ['Synthetic_Life_A','Synthetic_Life_B']){const a=await pendingAccount({identities:ids},name);ids.takeRecoveryCodes(a.session.token);ids.acknowledgeRecovery(a.session.token);owners.push({name,...a});}
  const directory=path.join(f.directory,'principals');provisionIdentities(ids,core.store,{credentialDirectory:directory,identityMapFile:f.gatewayConfig.identity_map_file});
  for(const o of owners){
    const op=queueCloudBinding(ids,f.config,o.account.account_id,{allowSubmittedRevisionGrant:true});
    const work=prepareCloudBinding(ids,f.config,ids.db.prepare('SELECT * FROM identity_operations WHERE operation_id=?').get(op.operation_id),directory);
    applyCloudBinding(store,work);writePrivate(work.binding.credential_file,work.binding.api_key);finishCloudBinding(ids,f.config,work);
    const tokens=await f.exchange(await authorizeOwner(f,o));assert.equal(tokens.status,200);o.token=tokens.data.access_token;
    o.call=async(name,args)=>(await f.mcp('tools/call',{name,arguments:args},o.token)).data.result.structuredContent;
    o.user=ids.byId(o.account.account_id).user_id;
  }
  writePrivate(f.gatewayConfig.identity_map_file,identityMapSnapshot(ids),{replace:true});
  // Account A's projects, records and lifecycle state (through the real Console actions).
  const [A,B]=owners;
  const seed=store.authenticate(store.issueCredential({userId:A.user,deviceId:'wl2-seed',agentId:'synthetic',agentInstanceId:'wl2-seed',scopes:['admin:tasks','memory:read','memory:write']}).api_key);
  for(const id of ['wl2-src','wl2-tgt','wl2-dead'])store.upsertProject(seed,{project_id:id,name:`WL2 ${id}`});
  const A_save=await A.call('mnemuron_save_memory',{scope:'project',project_id:'wl2-dead',memory_type:'fact',content:'WL2MARK record before the delete',operation_id:randomUUID(),cloud_read:'allow_submitted_revision'});
  assert.equal(A_save.status,'committed');
  const writer=store.authenticate(store.issueCredential({userId:A.user,deviceId:'wl2-console',agentId:'mnemuron-console',agentInstanceId:'wl2-console',scopes:[...CONSOLE_WRITE_SCOPES]}).api_key);
  const act=(action,payload)=>store.consoleService.execute(writer,{action,operation_id:randomUUID(),payload});
  let p=await act('projects.lifecycle_preview',{action:'delete',project_id:'wl2-dead'});await act('projects.lifecycle_delete',{preview_id:p.preview_id,confirm_name:'WL2 wl2-dead'});
  p=await act('projects.lifecycle_preview',{action:'merge',project_id:'wl2-src',target_project_id:'wl2-tgt'});await act('projects.merge',{preview_id:p.preview_id});
  // Full row contents (not counts), so an in-place update, a stored failure receipt or a new audit/project row also shows.
  const snapshot=()=>createHash('sha256').update(JSON.stringify(['memories','memory_revisions','memory_web_grants','memory_privacy','project_route_log','cloud_memory_operations','audit_events','projects','project_lifecycle']
    .map(tb=>store.db.prepare(`SELECT * FROM ${tb} ORDER BY rowid`).all()))).digest('hex');
  // Old merged ID: the cloud save lands in the canonical project with route provenance; the receipt is a normal commit.
  const routed=await A.call('mnemuron_save_memory',{scope:'project',project_id:'wl2-src',memory_type:'fact',content:'WL2MARK saved through the old ID',operation_id:randomUUID(),cloud_read:'allow_submitted_revision'});
  assert.equal(routed.status,'committed');
  assert.equal(store.db.prepare('SELECT project_id FROM memories WHERE memory_id=?').get(routed.memory_id).project_id,'wl2-tgt');
  assert.ok(store.db.prepare("SELECT 1 FROM project_route_log WHERE user_id=? AND requested_project_id='wl2-src' AND canonical_project_id='wl2-tgt' AND entity_id=?").get(A.user,routed.memory_id));
  // Deleted ID and a deleted-project record: refused through the gateway, nothing written.
  let before=snapshot();
  const deadArgs={scope:'project',project_id:'wl2-dead',memory_type:'fact',content:'WL2MARK never saved',operation_id:randomUUID(),cloud_read:'keep_private'};
  const deadSave=await A.call('mnemuron_save_memory',deadArgs);
  assert.deepEqual([deadSave.error?.code,deadSave.error?.retryable,deadSave.error?.next_action],['PROJECT_UNAVAILABLE',false,'refine_request'],'a save into a deleted project is refused as non-retryable, not as an outage');
  assert.equal((await A.call('mnemuron_save_memory',deadArgs)).error?.code,'PROJECT_UNAVAILABLE','retrying the same operation is refused again, not replayed from a stored receipt');
  const correction=await A.call('mnemuron_supersede_memory',{memory_id:A_save.memory_id,expected_revision:A_save.revision,content:'WL2MARK never corrected',reason:'r',operation_id:randomUUID(),cloud_read:'keep_private'});
  assert.equal(correction.error?.code,'MEMORY_NOT_FOUND','a deleted-project record is unavailable to the cloud connection');
  assert.equal((await A.call('mnemuron_get_memory',{memory_id:A_save.memory_id})).error?.code,'MEMORY_NOT_FOUND');
  assert.equal(snapshot(),before,'no record, revision, grant, privacy row or route was written by any refusal');
  // Account B: A's IDs are generic unknowns; nothing of A is readable or writable; B's own write is unaffected.
  before=snapshot();
  const crossSave=await B.call('mnemuron_save_memory',{scope:'project',project_id:'wl2-src',memory_type:'fact',content:'WL2MARK cross-account attempt',operation_id:randomUUID(),cloud_read:'keep_private'});
  assert.equal(crossSave.error?.code,'MEMORY_NOT_FOUND','another account cannot write into A\'s project (generic not found)');assert.ok(!/DELETED|CANONICAL|MERGED/.test(JSON.stringify(crossSave)),'no lifecycle state of A is disclosed');
  const crossDead=await B.call('mnemuron_save_memory',{scope:'project',project_id:'wl2-dead',memory_type:'fact',content:'WL2MARK cross-account deleted',operation_id:randomUUID(),cloud_read:'keep_private'});
  assert.equal(crossDead.error?.code,'MEMORY_NOT_FOUND');assert.ok(!/DELETED/.test(JSON.stringify(crossDead)),'B cannot learn that A deleted a project');
  const never=await B.call('mnemuron_save_memory',{scope:'project',project_id:'wl2-never-existed',memory_type:'fact',content:'WL2MARK unknown project',operation_id:randomUUID(),cloud_read:'keep_private'});
  assert.deepEqual([crossSave.error,crossDead.error],[never.error,never.error],'A\'s merged and deleted IDs look exactly like a project that never existed');
  const routedRev=routed.revision;
  assert.equal((await B.call('mnemuron_supersede_memory',{memory_id:routed.memory_id,expected_revision:routedRev,content:'WL2MARK cross-account correction',reason:'r',operation_id:randomUUID(),cloud_read:'keep_private'})).error?.code,'MEMORY_NOT_FOUND');
  assert.equal((await B.call('mnemuron_retract_memory',{memory_id:routed.memory_id,expected_revision:routedRev,reason:'r',operation_id:randomUUID()})).error?.code,'MEMORY_NOT_FOUND');
  assert.equal(snapshot(),before);
  assert.equal((await B.call('mnemuron_get_memory',{memory_id:routed.memory_id})).error?.code,'MEMORY_NOT_FOUND');
  assert.equal(((await B.call('mnemuron_search_memories',{query:'WL2MARK'})).results||[]).length,0);
  const own=await B.call('mnemuron_save_memory',{scope:'user',memory_type:'fact',content:'WL2MARK B own record',operation_id:randomUUID(),cloud_read:'keep_private'});
  assert.equal(own.status,'committed');
  // A's own reads through the gateway: the routed record is visible; the deleted record is not.
  const aRead=(await A.call('mnemuron_search_memories',{query:'WL2MARK'})).results.map(r=>r.memory_id);
  assert.ok(aRead.includes(routed.memory_id));assert.ok(!aRead.includes(A_save.memory_id));
});

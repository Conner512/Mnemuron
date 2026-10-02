import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {gatewayFixture} from './fixture.mjs';
import {memoryFixture,businessSnapshot} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {readPrivate,writePrivate,secretHash,randomSecret} from '../../../shared/oauth-common.mjs';
import {Browser,validatedCallback,listen,close,freePort} from '../../../services/oauth/test/fixture.mjs';
import {pendingAccount} from '../../../services/oauth/test/helpers/identity-fixture.mjs';
import {provisionIdentities,identityMapSnapshot} from '../../../services/oauth/src/provisioning.mjs';
import {queueCloudBinding,prepareCloudBinding,applyCloudBinding,finishCloudBinding} from '../../../services/oauth/src/cloud-provisioning.mjs';
import {generate} from '../../../services/oauth/node_modules/otplib/dist/index.js';
import {ReadonlyCoreClient} from '../src/core-client.mjs';
import {prepareTool} from '../src/tools.mjs';
import {validateGatewayConfig} from '../src/config.mjs';

test('disabled connection registry preserves legacy example configurations and enabled registry requires multi-account mode',()=>{
  const example=JSON.parse(fs.readFileSync(new URL('../config/gateway.runtime.example.json',import.meta.url),'utf8'));
  const origin='http://127.0.0.1:43980';
  Object.assign(example,{issuer:origin,resource:origin+'/mcp',authorization_server_metadata_url:origin+'/.well-known/oauth-authorization-server'});
  example.introspection.endpoint=origin+'/introspect';
  example.reverse_proxy.allowed_host=new URL(origin).host;
  for(const mode of ['bootstrap_metadata_only','oauth'])for(const tool_profile of ['auth_only','readonly']){
    for(const connection_management of [undefined,false]){
      const result=validateGatewayConfig({...example,mode,tool_profile,connection_management},{isolated:true});
      assert.equal(result.identity_mode,'legacy_owner');
      assert.notEqual(result.connection_management,true);
    }
  }
  assert.throws(()=>validateGatewayConfig({...example,connection_management:true},{isolated:true}),/connection registry gate/);
  for(const value of ['false',0,null,{},[]])assert.throws(()=>validateGatewayConfig({...example,identity_mode:'multi_account_v1',connection_management:value},{isolated:true}),/connection registry gate/);
  assert.equal(validateGatewayConfig({...example,identity_mode:'multi_account_v1',connection_management:true},{isolated:true}).connection_management,true);
});

async function setup(t,{allowGrant=true}={}){
  const core=await memoryFixture(t);Object.assign(core.store.runtime,{cloudMemory:true,cloudSubmittedGrant:allowGrant});
  const f=await gatewayFixture(t,{profile:'memory_readwrite',coreFixture:core,
    authMutate(c){c.cloud_memory={enabled:true,allow_submitted_revision_grant:allowGrant};c.resource_scopes.push('memory:write');c.chatgpt_client.allowed_scopes.push('memory:write');},
    mutate(c){c.cloud_memory={enabled:true,allow_submitted_revision_grant:allowGrant};
      for(const name of ['mnemuron_save_memory','mnemuron_supersede_memory','mnemuron_retract_memory','mnemuron_get_operation'])c.tools[name]={required_scope:'memory:write',profile:['memory_readwrite']};
      const map=readPrivate(c.identity_map_file,{json:true}),m=map.mappings[0],connection_id=secretHash(JSON.stringify([c.issuer,c.introspection.expected_oauth_client_id,m.subject]));
      const credential=core.store.issueCredential({userId:m.mnemuron_user_id,deviceId:'synthetic-cloud',agentId:'chatgpt-web',agentInstanceId:'synthetic-cloud-write',scopes:['memory:read','resume:read','memory:write']});
      core.store.cloudMemory.bind(credential.credential,{connection_id,account_id:'synthetic-account',security_version:1,allow_submitted_revision_grant:allowGrant});
      m.cloud_write={connection_id,account_id:'synthetic-account',security_version:1,agent_instance_id:credential.credential.agent_instance_id,credential_id:credential.credential.credential_id,
        credential_file:path.join(path.dirname(c.identity_map_file),'cloud-write.key'),allow_submitted_revision_grant:allowGrant};
      writePrivate(m.cloud_write.credential_file,credential.api_key);writePrivate(c.identity_map_file,map,{replace:true});
    }});
  const readonly=(await f.exchange(await f.authorize())).data;
  const token=(await f.exchange(await f.authorize({scope:'openid offline_access memory:read project:read memory:write'}))).data;
  const call=(name,args,access=token.access_token)=>f.mcp('tools/call',{name,arguments:args},access);
  return {...f,core,readonly,tokenRequest:f.token,token,call};
}
const save=(operation_id=randomUUID())=>({scope:'user',memory_type:'fact',content:'Synthetic cloud memory 1.2.3 😀',operation_id,cloud_read:'allow_submitted_revision'});

test('A-T01..06/09/19/24: OAuth scope intersection, real SDK lifecycle and no implicit readonly upgrade',async t=>{
  const f=await setup(t),before=businessSnapshot(f.core.store);
  const old=(await f.mcp('tools/list',undefined,f.readonly.access_token)).data.result.tools;
  assert.equal(old.some(x=>x.name==='mnemuron_save_memory'),false);
  assert.equal((await f.call('mnemuron_save_memory',save(),f.readonly.access_token)).status,403);
  assert.deepEqual(businessSnapshot(f.core.store),before);
  const refreshed=await f.tokenRequest({grant_type:'refresh_token',refresh_token:f.readonly.refresh_token,resource:f.config.resource});
  assert.equal(refreshed.status,200);assert.equal(refreshed.data.scope.includes('memory:write'),false);
  const upgrade=await f.tokenRequest({grant_type:'refresh_token',refresh_token:refreshed.data.refresh_token,resource:f.config.resource,scope:'openid offline_access memory:read project:read memory:write'});
  assert.equal(upgrade.status,400);assert.equal(upgrade.data.error,'invalid_scope');
  const client=new Client({name:'synthetic-sdk',version:'1'});
  await client.connect(new StreamableHTTPClientTransport(new URL(f.config.resource),{requestInit:{headers:{authorization:'Bearer '+f.token.access_token}}}));t.after(()=>client.close());
  const tools=(await client.listTools()).tools;assert.equal(tools.find(x=>x.name==='mnemuron_save_memory').annotations.readOnlyHint,false);
  assert.equal(tools.find(x=>x.name==='mnemuron_supersede_memory').annotations.destructiveHint,true);
  assert.equal(tools.find(x=>x.name==='mnemuron_retract_memory').annotations.destructiveHint,true);
  const args=save(),created=(await client.callTool({name:'mnemuron_save_memory',arguments:args})).structuredContent;
  assert.equal(created.status,'committed',JSON.stringify(created));assert.equal(created.cloud_readable,true);
  assert.deepEqual((await f.call('mnemuron_get_operation',{operation_id:args.operation_id})).data.result.structuredContent,created);
  const newClient=new Client({name:'synthetic-new-session',version:'1'});await newClient.connect(new StreamableHTTPClientTransport(new URL(f.config.resource),{requestInit:{headers:{authorization:'Bearer '+f.token.access_token}}}));t.after(()=>newClient.close());
  const read=(await newClient.callTool({name:'mnemuron_get_memory',arguments:{memory_id:created.memory_id,content_limit:8}})).structuredContent;
  assert.equal(read.content_complete,false);assert.ok(read.next_request);assert.equal(read.source_manifest.evidence_kind,'model_submitted');
  const corrected=(await f.call('mnemuron_supersede_memory',{memory_id:created.memory_id,expected_revision:created.revision,content:'Synthetic replacement',reason:'User requested correction',operation_id:randomUUID(),cloud_read:'allow_submitted_revision'})).data.result.structuredContent;
  assert.equal(corrected.status,'committed');assert.notEqual(corrected.memory_id,created.memory_id);
  assert.equal((await f.call('mnemuron_retract_memory',{memory_id:corrected.memory_id,expected_revision:corrected.revision,reason:'User requested withdrawal',operation_id:randomUUID()})).data.result.structuredContent.status,'committed');
  f.app.store.revoke({all:true});assert.equal((await f.call('mnemuron_get_operation',{operation_id:args.operation_id})).status,401);
});

test('A-T11/18/21/23: explicit private choice, bounded errors and unknown input cannot confer authority',async t=>{
  const f=await setup(t,{allowGrant:false}),op=save();
  const denied=await f.call('mnemuron_save_memory',op);assert.equal(denied.data.result.isError,true);
  assert.equal(denied.data.result.structuredContent.error.code,'CLOUD_READ_POLICY_DENIED');
  const args={...op,cloud_read:'keep_private'},r=(await f.call('mnemuron_save_memory',args)).data.result.structuredContent;
  assert.equal(r.status,'committed');assert.equal(r.cloud_readable,false);assert.equal(JSON.stringify(r).includes(args.content),false);
  assert.equal((await f.call('mnemuron_get_memory',{memory_id:r.memory_id})).data.result.structuredContent.error.code,'MEMORY_NOT_FOUND');
  const conflict=await f.call('mnemuron_save_memory',{...args,content:'changed'});assert.equal(conflict.status,200);assert.equal(conflict.data.result.structuredContent.error.code,'IDEMPOTENCY_CONFLICT');
  for(const more of [{confirmed:true},{user_id:'foreign'},{agent_id:'mnemuron-console'},{url:'http://127.0.0.1/admin'}])assert.equal((await f.call('mnemuron_save_memory',{...save(),...more})).data.result.isError,true);
  for(const bad of [f.secret,f.token.id_token,f.token.refresh_token,f.coreCredential.api_key])assert.equal((await f.call('mnemuron_save_memory',args,bad)).status,401);
  for(const secret of [args.content,f.token.access_token,f.token.refresh_token,f.secret])assert.equal(JSON.stringify(f.gatewayLogs).includes(secret),false);
});

test('private MCP save overrides account read-all while explicit shared writes stay readable',async t=>{
  const f=await setup(t),user=f.core.store.authenticate(f.coreCredential.api_key).user_id;
  const local=f.core.store.issueCredential({userId:user,deviceId:'synthetic-operator',agentId:'test',agentInstanceId:randomUUID(),scopes:['admin:tasks']});
  f.core.store.webVisibility.setPolicy(f.core.store.authenticate(local.api_key),{read_all:true,expected_revision:0});
  const args={...save(),cloud_read:'keep_private'},created=(await f.call('mnemuron_save_memory',args)).data.result.structuredContent;
  assert.equal(created.status,'committed');assert.equal(created.cloud_readable,false);
  assert.equal((await f.call('mnemuron_get_memory',{memory_id:created.memory_id})).data.result.structuredContent.error.code,'MEMORY_NOT_FOUND');
  assert.equal((await f.call('mnemuron_search_memories',{query:'Synthetic cloud memory'})).data.result.structuredContent.result_count,0);
  assert.deepEqual((await f.call('mnemuron_get_operation',{operation_id:args.operation_id})).data.result.structuredContent,created);
  const shared=(await f.call('mnemuron_save_memory',save())).data.result.structuredContent;assert.equal(shared.cloud_readable,true);
  assert.equal((await f.call('mnemuron_search_memories',{query:'Synthetic cloud memory'})).data.result.structuredContent.result_count,1);
});

test('A-T12/23: dropped post-COMMIT response is uncertain, same receipt recovers without duplicate effects',async t=>{
  const f=await setup(t),auth=await f.gateway.authorization.verify({headers:{authorization:'Bearer '+f.token.access_token}}),m=auth.mapping;
  const port=await freePort();let dropped=false;
  const proxy=http.createServer((req,res)=>{
    const outgoing=http.request(new URL(req.url,f.core.baseUrl),{method:req.method,headers:req.headers},up=>{
      if(req.url==='/v1/cloud-memory/operations'&&!dropped){dropped=true;up.resume();up.on('end',()=>res.destroy());return;}
      res.writeHead(up.statusCode,up.headers);up.pipe(res);
    });outgoing.on('error',()=>res.destroy());req.pipe(outgoing);
  });await listen(proxy,port);t.after(()=>close(proxy));
  const client=new ReadonlyCoreClient({...f.gateway.config,core:{...f.gateway.config.core,base_url:`http://127.0.0.1:${port}`,credential_file:m.cloud_write.credential_file}},m.cloud_write);
  const args=save();
  await assert.rejects(()=>prepareTool('mnemuron_save_memory',args,{config:f.gateway.config,auth,core:client,id:1}),{code:'OPERATION_STATUS_UNKNOWN'});
  const r=(await f.call('mnemuron_get_operation',{operation_id:args.operation_id})).data.result.structuredContent;
  assert.equal(r.status,'committed');assert.deepEqual((await f.call('mnemuron_save_memory',args)).data.result.structuredContent,r);
  const before=businessSnapshot(f.core.store);
  await assert.rejects(()=>prepareTool('mnemuron_save_memory',save(),{config:{...f.gateway.config,limits:{tool_response_bytes:1024}},auth,core:client,id:1}),{code:'TOOL_RESPONSE_TOO_LARGE'});
  assert.deepEqual(businessSnapshot(f.core.store),before);
  const bad=save();
  await assert.rejects(()=>prepareTool('mnemuron_save_memory',bad,{config:f.gateway.config,auth,core:{call:async(...a)=>{await client.call(...a);return {invalid:true};}},id:1}),e=>e.code==='OPERATION_STATUS_UNKNOWN'&&e.operation_id===bad.operation_id);
  assert.equal((await f.call('mnemuron_get_operation',{operation_id:bad.operation_id})).data.result.structuredContent.status,'committed');
});

async function authorizeOwner(f,owner){
  const browser=new Browser(f.config.issuer),verifier=randomSecret(),request={client_id:f.config.chatgpt_client.client_id,
    redirect_uri:f.config.chatgpt_client.redirect_uris[0],response_type:'code',scope:'openid offline_access memory:read project:read memory:write',
    resource:f.config.resource,state:randomSecret(),code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')};
  let r=await browser.request(`/authorize?${new URLSearchParams(request)}`),consent=false;
  for(let i=0;i<12;i++){
    const location=r.headers.get('location');
    if(location){const next=new URL(location,f.config.issuer);if(next.origin!==f.config.issuer){assert.equal(consent,true);return {callback:validatedCallback(next,f.config.issuer,request),verifier,request};}r=await browser.request(next);}
    else {
      assert.equal(r.status,200);const csrf=r.text.match(/name="csrf" value="([^"]+)"/)?.[1],action=r.text.match(/action="([^"]+)"/)?.[1];assert.ok(csrf&&action);
      if(action.endsWith('/confirm')){consent=true;assert.ok(r.text.includes('data-i18n="consentSubmittedGrant"'));assert.ok(r.text.includes('data-i18n="allowMemoryWrite"'));assert.ok(r.text.includes(`<strong>${owner.name}</strong>`));}
      r=await browser.post(action,{csrf,...(action.endsWith('/login')?{username:owner.name,password:'Synthetic password with spaces  ',otp:await generate({secret:owner.setup.secret})}:{})});
    }
  }throw new Error('Synthetic flow incomplete');
}
test('A-T05/08/17/24: two real OAuth accounts and separate cloud bindings isolate reads, versions and receipts',async t=>{
  const core=await memoryFixture(t);Object.assign(core.store.runtime,{cloudMemory:true,cloudSubmittedGrant:true});
  const f=await gatewayFixture(t,{profile:'memory_readwrite',coreFixture:core,sharedOrigin:true,authMutate:c=>{
    c.cloud_memory={enabled:true,allow_submitted_revision_grant:true};c.resource_scopes.push('memory:write');c.chatgpt_client.allowed_scopes.push('memory:write');
    c.identity_mode='multi_account_v1';c.login.registration_enabled=true;c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600};
    writePrivate(c.identity.encryption_key_file,randomSecret());
  },mutate:c=>{c.cloud_memory={enabled:true,allow_submitted_revision_grant:true};c.identity_mode='multi_account_v1';
    for(const name of ['mnemuron_save_memory','mnemuron_supersede_memory','mnemuron_retract_memory','mnemuron_get_operation'])c.tools[name]={required_scope:'memory:write',profile:['memory_readwrite']};
    writePrivate(c.identity_map_file,{unknown_subject_policy:'deny',mappings:[]},{replace:true});}});
  const ids=f.app.accounts,owners=[];
  for(const name of ['Synthetic_Cloud_A','Synthetic_Cloud_B']){const a=await pendingAccount({identities:ids},name);ids.takeRecoveryCodes(a.session.token);ids.acknowledgeRecovery(a.session.token);owners.push({name,...a});}
  const directory=path.join(f.directory,'principals');provisionIdentities(ids,core.store,{credentialDirectory:directory,identityMapFile:f.gatewayConfig.identity_map_file});
  for(const o of owners){
    const op=queueCloudBinding(ids,f.config,o.account.account_id,{allowSubmittedRevisionGrant:true});
    const work=prepareCloudBinding(ids,f.config,ids.db.prepare('SELECT * FROM identity_operations WHERE operation_id=?').get(op.operation_id),directory);
    applyCloudBinding(core.store,work);writePrivate(work.binding.credential_file,work.binding.api_key);finishCloudBinding(ids,f.config,work);
    const tokens=await f.exchange(await authorizeOwner(f,o));assert.equal(tokens.status,200);o.token=tokens.data.access_token;
    o.call=(name,args)=>f.mcp('tools/call',{name,arguments:args},o.token);
  }
  writePrivate(f.gatewayConfig.identity_map_file,identityMapSnapshot(ids),{replace:true});
  const op=randomUUID(),saved=await Promise.all(owners.map(o=>o.call('mnemuron_save_memory',save(op))));
  const receipts=saved.map(r=>r.data.result.structuredContent);for(const r of receipts)assert.equal(r.status,'committed');assert.notEqual(receipts[0].memory_id,receipts[1].memory_id);
  for(const [i,o] of owners.entries()){
    assert.deepEqual((await o.call('mnemuron_get_operation',{operation_id:op})).data.result.structuredContent,receipts[i]);
    const foreign=receipts[1-i];assert.equal((await o.call('mnemuron_get_memory',{memory_id:foreign.memory_id})).data.result.structuredContent.error.code,'MEMORY_NOT_FOUND');
    assert.equal((await o.call('mnemuron_retract_memory',{memory_id:foreign.memory_id,expected_revision:foreign.revision,operation_id:randomUUID(),reason:'Unauthorized guess'})).data.result.structuredContent.error.code,'MEMORY_NOT_FOUND');
    const read=(await o.call('mnemuron_search_memories',{query:'Synthetic cloud memory'})).data.result.structuredContent;
    assert.equal(read.result_count,1);assert.equal(read.results[0].memory_id,receipts[i].memory_id);
  }
  const before=businessSnapshot(core.store);
  const map=readPrivate(f.gatewayConfig.identity_map_file,{json:true});map.mappings[0].cloud_write.credential_file=map.mappings[1].cloud_write.credential_file;writePrivate(f.gatewayConfig.identity_map_file,map,{replace:true});
  assert.equal((await owners[0].call('mnemuron_save_memory',save())).status,503);assert.deepEqual(businessSnapshot(core.store),before);
  writePrivate(f.gatewayConfig.identity_map_file,identityMapSnapshot(ids),{replace:true});
  ids.db.prepare('UPDATE identity_accounts SET security_version=security_version+1 WHERE account_id=?').run(owners[0].account.account_id);
  assert.equal((await owners[0].call('mnemuron_get_operation',{operation_id:op})).status,401);
  assert.equal((await owners[1].call('mnemuron_get_operation',{operation_id:op})).status,200);
});

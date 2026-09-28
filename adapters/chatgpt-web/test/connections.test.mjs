import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {generate} from '../../../services/oauth/node_modules/otplib/dist/index.js';
import {gatewayFixture} from './fixture.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {pendingAccount} from '../../../services/oauth/test/helpers/identity-fixture.mjs';
import {Browser} from '../../../services/oauth/test/fixture.mjs';
import {provisionIdentities,identityMapSnapshot} from '../../../services/oauth/src/provisioning.mjs';
import {prepareConnectionBinding,applyConnectionBinding,finishConnectionBinding} from '../../../services/oauth/src/connection-provisioning.mjs';
import {writePrivate,randomSecret} from '../../../shared/oauth-common.mjs';

const policy={enabled:true,max_connections:20,pat_default_ttl_seconds:2592000,pat_max_ttl_seconds:7776000,secret_receipt_ttl_seconds:300,rotation_overlap_seconds:0};
const eventually=async check=>{for(let i=0;i<60;i++){if(check())return;await new Promise(r=>setTimeout(r,25));}assert.ok(check(),'bounded background activity propagation');};
async function setup(t){
 const core=await memoryFixture(t);Object.assign(core.store.runtime,{cloudMemory:true,cloudSubmittedGrant:true});
 const f=await gatewayFixture(t,{profile:'memory_readwrite',coreFixture:core,loopbackAuth:true,authMutate:c=>{
   c.cloud_memory={enabled:true,allow_submitted_revision_grant:true};c.resource_scopes.push('memory:write');c.chatgpt_client.allowed_scopes.push('memory:write');c.identity_mode='multi_account_v1';
   c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600,connection_management:policy};writePrivate(c.identity.encryption_key_file,randomSecret());
 },mutate:c=>{
   c.cloud_memory={enabled:true,allow_submitted_revision_grant:true};c.identity_mode='multi_account_v1';c.connection_management=true;
   for(const name of ['mnemuron_save_memory','mnemuron_supersede_memory','mnemuron_retract_memory','mnemuron_get_operation'])c.tools[name]={required_scope:'memory:write',profile:['memory_readwrite']};
   writePrivate(c.identity_map_file,{unknown_subject_policy:'deny',mappings:[]},{replace:true});
 }});
 const owners=[],directory=path.join(f.directory,'principals');
 for(const name of ['Synthetic_Registry_A','Synthetic_Registry_B']){
   const o=await pendingAccount({identities:f.app.accounts},name);f.app.accounts.takeRecoveryCodes(o.session.token);f.app.accounts.acknowledgeRecovery(o.session.token);owners.push({...o,name,id:o.account.account_id});
 }
 provisionIdentities(f.app.accounts,core.store,{credentialDirectory:directory,identityMapFile:f.gatewayConfig.identity_map_file});
 for(const o of owners){o.console=f.app.accounts.newSession('console',{accountId:o.id});}
 const execute=async(o,action,p,op=randomUUID())=>{
   const ids=f.app.accounts;ids.db.prepare('DELETE FROM oauth_mfa_steps WHERE subject=?').run(ids.byId(o.id).subject);
   return ids.connections.execute(o.id,ids.session(o.console.token,'console'),action,{...p,current_password:'Synthetic password with spaces  ',otp:await generate({secret:o.setup.secret})},op);
 };
 const provision=()=>{
   const ids=f.app.accounts;
   for(const op of ids.db.prepare("SELECT * FROM identity_operations WHERE kind LIKE 'connection-bind:%' AND state NOT IN ('completed','superseded')").all()){
     const work=prepareConnectionBinding(ids,op,directory);if(!work)continue;applyConnectionBinding(core.store,work);writePrivate(work.binding.credential_file,work.binding.api_key);finishConnectionBinding(ids,work);
   }
   writePrivate(f.gatewayConfig.identity_map_file,identityMapSnapshot(ids),{replace:true});
 };
 const authorize=async(o,r,{scope='openid offline_access memory:read memory:write'}={})=>{
   const ids=f.app.accounts;ids.db.prepare('DELETE FROM oauth_mfa_steps WHERE subject=?').run(ids.byId(o.id).subject);
   const verifier=randomSecret(),request={client_id:r.connection.client_id,redirect_uri:f.config.chatgpt_client.redirect_uris[0],response_type:'code',scope,resource:f.config.resource,state:randomSecret(),code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')},browser=new Browser(f.config.issuer);
   let response=await browser.request(`/authorize?${new URLSearchParams(request)}`);
   for(let i=0;i<12;i++){
     const location=response.headers.get('location');if(location){const next=new URL(location,f.config.issuer);if(next.origin!==f.config.issuer)return {callback:next,verifier};response=await browser.request(next);}
     else if(response.status!==200)return {response};else{
       const csrf=response.text.match(/name="csrf" value="([^"]+)"/)?.[1],action=response.text.match(/action="([^"]+)"/)?.[1];assert.ok(csrf&&action);
       response=await browser.post(action,{csrf,...(action.endsWith('/login')?{username:o.name,password:'Synthetic password with spaces  ',otp:await generate({secret:o.setup.secret})}:{})});
     }
   }throw new Error('Synthetic authorization loop');
 };
 const token=async(r,body)=>{const response=await fetch(f.config.issuer+'/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',connection:'close'},body:new URLSearchParams({client_id:r.connection.client_id,client_secret:r.secret,...body})});return {status:response.status,data:await response.json()};};
 const exchange=async(o,r)=>{const flow=await authorize(o,r);assert.ok(flow.callback,JSON.stringify(flow.response));return token(r,{grant_type:'authorization_code',code:flow.callback.searchParams.get('code'),code_verifier:flow.verifier,redirect_uri:f.config.chatgpt_client.redirect_uris[0],resource:f.config.resource});};
 const sdk=async(tokenValue,generic=false)=>{const c=new Client({name:'synthetic-connection-sdk',version:'1'});t.after(()=>c.close());await c.connect(new StreamableHTTPClientTransport(new URL(f.gatewayConfig.resource+(generic?'/generic':'')),{requestInit:{headers:{authorization:'Bearer '+tokenValue}}}));return c;};
 return {f,core,owners,execute,provision,authorize,exchange,token,sdk};
}
test('B-04..12: personal OAuth registry is loaded by provider, owner checked, refresh/restart/rotation/revoke and SDK reads/writes',async t=>{
 const x=await setup(t),[a,b]=x.owners,p={kind:'chatgpt_oauth',label:'Synthetic personal ChatGPT',profile:'memory_readwrite',allow_submitted_revision_grant:true};
 const r=await x.execute(a,'connections.create',p);x.provision();assert.equal(x.f.app.accounts.connections.client(r.connection.client_id),undefined);
 await x.execute(a,'connections.update',{connection_id:r.connection.connection_id,redirect_uri:x.f.config.chatgpt_client.redirect_uris[0]});x.provision();
 const foreign=await x.authorize(b,r);assert.ok(foreign.response?.status>=400||foreign.callback?.searchParams.has('error'),'private client rejects different account');
 const issued=await x.exchange(a,r);assert.equal(issued.status,200,JSON.stringify(issued.data));
 assert.equal(x.f.app.accounts.connections.detail(a.id,r.connection.connection_id).connection.health,'authorized');
 t.diagnostic('Personal OAuth login and code exchange completed');
 const client=await x.sdk(issued.data.access_token);assert.ok((await client.listTools()).tools.some(t=>t.name==='mnemuron_save_memory'));
 const saveResult=await client.callTool({name:'mnemuron_save_memory',arguments:{operation_id:randomUUID(),scope:'user',memory_type:'fact',content:'Synthetic registry memory',cloud_read:'allow_submitted_revision'}});assert.ok(saveResult.structuredContent,JSON.stringify(saveResult));const saved=saveResult.structuredContent;assert.equal(saved.status,'committed',JSON.stringify(saved));
 const read=(await client.callTool({name:'mnemuron_get_memory',arguments:{memory_id:saved.memory_id}})).structuredContent;assert.equal(read.content_complete,true);
 await eventually(()=>x.f.app.accounts.connections.detail(a.id,r.connection.connection_id).connection.health==='verified');
 const deniedIntrospection=await fetch(x.f.config.issuer+'/introspect',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',connection:'close',authorization:'Basic '+Buffer.from(r.connection.client_id+':'+r.secret).toString('base64')},body:new URLSearchParams({token:issued.data.access_token})});assert.equal(deniedIntrospection.status,401);await deniedIntrospection.arrayBuffer();
 const refreshed=await x.token(r,{grant_type:'refresh_token',refresh_token:issued.data.refresh_token,resource:x.f.config.resource});assert.equal(refreshed.status,200);
 t.diagnostic('Memory write/read and token refresh completed');
 await x.f.stop();await x.f.start();assert.equal((await x.f.introspect(refreshed.data.access_token)).data.active,true);
 t.diagnostic('Authorization service restart verified');
 const next=await x.execute(a,'connections.rotate',{connection_id:r.connection.connection_id});x.provision();assert.equal((await x.f.introspect(refreshed.data.access_token)).data.active,false);
 assert.equal((await x.token(r,{grant_type:'refresh_token',refresh_token:refreshed.data.refresh_token,resource:x.f.config.resource})).status,401);
 const fresh=await x.exchange(a,next);assert.equal(fresh.status,200);await x.sdk(fresh.data.access_token);
 t.diagnostic('Rotation and new authorization verified');
 await x.execute(a,'connections.revoke',{connection_id:r.connection.connection_id});assert.equal((await x.f.introspect(fresh.data.access_token)).data.active,false);
});
test('B-13..21: two accounts each own generic and OAuth connections; real SDK PAT lifecycle, audience and version privacy isolation',async t=>{
 const x=await setup(t),receipts=[];
 for(const o of x.owners){o.pat=await x.execute(o,'connections.create',{kind:'generic_mcp',label:'Synthetic generic',profile:'memory_readwrite',allow_submitted_revision_grant:true});o.oauth=await x.execute(o,'connections.create',{kind:'chatgpt_oauth',label:'Synthetic OAuth',profile:'readonly'});}
 x.provision();
 for(const o of x.owners){o.client=await x.sdk(o.pat.secret,true);assert.ok((await o.client.listTools()).tools.length>1);const result=await o.client.callTool({name:'mnemuron_save_memory',arguments:{operation_id:'same-operation',scope:'user',memory_type:'fact',content:'Synthetic account-isolated memory',cloud_read:'allow_submitted_revision'}});assert.ok(result.structuredContent,JSON.stringify(result));receipts.push(result.structuredContent);}
 assert.notEqual(receipts[0].memory_id,receipts[1].memory_id);
 for(const [i,o] of x.owners.entries()){
   assert.equal((await o.client.callTool({name:'mnemuron_get_memory',arguments:{memory_id:receipts[1-i].memory_id}})).structuredContent.error.code,'MEMORY_NOT_FOUND');
   assert.equal((await x.f.mcp('tools/list',{},o.pat.secret)).status,401);
   assert.equal(x.f.app.accounts.connections.list(o.id,{}).total,2);
 }
 const a=x.owners[0],next=await x.execute(a,'connections.rotate',{connection_id:a.pat.connection.connection_id});
 await assert.rejects(x.sdk(a.pat.secret,true));x.provision();const newer=await x.sdk(next.secret,true);
 assert.equal((await newer.callTool({name:'mnemuron_get_memory',arguments:{memory_id:receipts[0].memory_id}})).structuredContent.content_complete,true);
 assert.equal((await newer.callTool({name:'mnemuron_auth_status',arguments:{}})).structuredContent.mode,'personal_token');
 const corrected=(await newer.callTool({name:'mnemuron_supersede_memory',arguments:{memory_id:receipts[0].memory_id,expected_revision:receipts[0].revision,content:'Synthetic corrected generic memory',reason:'Synthetic user correction',operation_id:'correct-pat',cloud_read:'allow_submitted_revision'}})).structuredContent;
 assert.equal(corrected.status,'committed');const another=await x.sdk(next.secret,true);
 assert.equal((await another.callTool({name:'mnemuron_get_memory',arguments:{memory_id:corrected.memory_id}})).structuredContent.content_complete,true);
 assert.equal((await another.callTool({name:'mnemuron_retract_memory',arguments:{memory_id:corrected.memory_id,expected_revision:corrected.revision,reason:'Synthetic withdrawal',operation_id:'retract-pat'}})).structuredContent.status,'committed');
 await eventually(()=>x.f.app.accounts.connections.detail(a.id,a.pat.connection.connection_id).connection.health==='verified');
 await x.f.stop();await x.f.start();await x.sdk(next.secret,true);
 await x.execute(a,'connections.revoke',{connection_id:a.pat.connection.connection_id});await assert.rejects(x.sdk(next.secret,true));await x.sdk(x.owners[1].pat.secret,true);
 for(const secret of [a.pat.secret,next.secret,x.owners[1].pat.secret])assert.equal(JSON.stringify(x.f.gatewayLogs).includes(secret),false);
});

test('B-14/25: personal readonly OAuth and PAT cannot gain writes by refresh; upgrades invalidate old grants',async t=>{
 const x=await setup(t),a=x.owners[0];
 const r=await x.execute(a,'connections.create',{kind:'chatgpt_oauth',label:'Synthetic readonly',profile:'readonly'});
 await x.execute(a,'connections.update',{connection_id:r.connection.connection_id,redirect_uri:x.f.config.chatgpt_client.redirect_uris[0]});x.provision();
 const flow=await x.authorize(a,r,{scope:'openid offline_access memory:read'}),issued=await x.token(r,{grant_type:'authorization_code',code:flow.callback.searchParams.get('code'),code_verifier:flow.verifier,redirect_uri:x.f.config.chatgpt_client.redirect_uris[0],resource:x.f.config.resource});assert.equal(issued.status,200);
 const readonly=await x.sdk(issued.data.access_token);assert.equal((await readonly.callTool({name:'mnemuron_auth_status',arguments:{}})).structuredContent.tool_profile,'readonly');
 assert.ok(!(await readonly.listTools()).tools.some(t=>t.name==='mnemuron_save_memory'));
 assert.equal((await x.token(r,{grant_type:'refresh_token',refresh_token:issued.data.refresh_token,scope:'openid offline_access memory:read memory:write',resource:x.f.config.resource})).status,400);
 const pat=await x.execute(a,'connections.create',{kind:'generic_mcp',label:'Synthetic readonly PAT',profile:'readonly'});x.provision();const patClient=await x.sdk(pat.secret,true);
 assert.equal((await patClient.callTool({name:'mnemuron_auth_status',arguments:{}})).structuredContent.tool_profile,'readonly');
 await assert.rejects(patClient.callTool({name:'mnemuron_save_memory',arguments:{operation_id:'denied',scope:'user',memory_type:'fact',content:'Never stored',cloud_read:'keep_private'}}));
 await x.execute(a,'connections.update',{connection_id:r.connection.connection_id,profile:'memory_readwrite',allow_submitted_revision_grant:true});x.provision();
 assert.equal((await x.f.introspect(issued.data.access_token)).data.active,false);
 assert.notEqual((await x.token(r,{grant_type:'refresh_token',refresh_token:issued.data.refresh_token,resource:x.f.config.resource})).status,200);
 assert.equal((await x.exchange(a,r)).status,200);
});

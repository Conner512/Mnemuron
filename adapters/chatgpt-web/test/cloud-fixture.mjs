import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {generate} from '../../../services/oauth/node_modules/otplib/dist/index.js';
import {gatewayFixture} from './fixture.mjs';
import {Browser,validatedCallback} from '../../../services/oauth/test/fixture.mjs';
import {pendingAccount} from '../../../services/oauth/test/helpers/identity-fixture.mjs';
import {provisionIdentities} from '../../../services/oauth/src/provisioning.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {randomSecret,writePrivate,seconds} from '../../../shared/oauth-common.mjs';

export async function cloudFixture(t,{write=true,binding=true,enabled=true}={}) {
 t.mock.timers.enable({apis:['Date'],now:Date.now()});
 const core=await memoryFixture(t);
 const policy={enabled,allow_write:enabled&&write,max_active:10,max_ttl_days:30};
 const f=await gatewayFixture(t,{profile:'readonly',coreFixture:core,authMutate:c=>{
  c.identity_mode='multi_account_v1';c.login.registration_enabled=true;c.cloud_connections={...policy};
  c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600,
   console_basic_operations:{memory:true,security:false,oauth:true},core:{base_url:core.baseUrl}};
  writePrivate(c.identity.encryption_key_file,randomSecret());
 },mutate:c=>{c.identity_mode='multi_account_v1';c.cloud_connections={...policy};writePrivate(c.identity_map_file,{unknown_subject_policy:'deny',mappings:[]},{replace:true});}});
 const ids=f.app.accounts,owners=[];
 for(const name of ['Cloud_Example_A','Cloud_Example_B']){
  const o=await pendingAccount({identities:ids},name);ids.takeRecoveryCodes(o.session.token);ids.acknowledgeRecovery(o.session.token);owners.push({...o,name});
 }
 provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:f.gatewayConfig.identity_map_file,consoleBasicOperations:binding});
 for(const o of owners){o.record=ids.byId(o.account.account_id);o.browser=new Browser(f.config.issuer);o.console=ids.newSession('console',{accountId:o.record.account_id});o.browser.cookies.set('mnm_fixture_console:/',{name:'mnm_fixture_console',path:'/',value:o.console.token});}
 const [a,b]=owners;
 const get=async(view,owner=a)=>{const r=await owner.browser.request('/console-api/'+view);return {status:r.status,body:JSON.parse(r.text)};};
 const act=async(action,payload={},owner=a,op=randomUUID(),extra={})=>{const me=await get('me',owner),r=await owner.browser.post('/console-api/action',{csrf:me.body.csrf,account_id:owner.record.account_id,action,operation_id:op,payload:JSON.stringify(payload),...extra});return {status:r.status,body:JSON.parse(r.text)};};
 const proof=async(owner=a)=>{t.mock.timers.setTime(Date.now()+30000);return {current_password:'Synthetic password with spaces  ',otp:await generate({secret:owner.setup.secret,epoch:seconds()})};};
 const connect=async({kind='mcp',permission='readwrite',owner=a,...extra}={})=>{
  const p={kind,label:'Example connection',permission,ttl_days:2,...(kind==='chatgpt'?{redirect_uri:f.config.chatgpt_client.redirect_uris[0]}:{}),...extra,...await proof(owner)};
  const r=await act('cloud_connections.create',p,owner);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;
 };
 const call=async(token,name,args={})=>{const r=await f.mcp('tools/call',{name,arguments:args},token);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.result;};
 const authorize=async(connection,owner=a,extra={})=>{
  const verifier=randomSecret(),browser=new Browser(f.config.issuer),proofs=await proof(owner);
  const request={client_id:connection.client_id,redirect_uri:connection.connection.redirect_uri,response_type:'code',scope:connection.scopes.join(' '),resource:f.config.resource,
   state:randomSecret(),code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),...extra};
  let r=await browser.request(`/authorize?${new URLSearchParams(request)}`);
  for(let i=0;i<12;i++){
   const location=r.headers.get('location');if(location){const next=new URL(location,f.config.issuer);if(next.origin!==f.config.issuer)return {callback:validatedCallback(next,f.config.issuer,request),verifier,request};r=await browser.request(next);}
   else{if(r.status!==200)return {failed:r};const csrf=r.text.match(/name="csrf" value="([^"]+)"/)?.[1],action=r.text.match(/action="([^"]+)"/)?.[1];assert.ok(csrf&&action,r.text);
    r=await browser.post(action,{csrf,...(action.endsWith('/login')?{username:owner.name,password:proofs.current_password,otp:proofs.otp}:{})});}
  }throw new Error('OAuth redirect loop');
 };
 const exchange=(connection,auth,extra={})=>f.exchange(auth,{client_id:connection.client_id,client_secret:connection.client_secret,redirect_uri:connection.connection.redirect_uri,...extra});
 return {t,f,core,ids,a,b,get,act,proof,connect,call,authorize,exchange};
}

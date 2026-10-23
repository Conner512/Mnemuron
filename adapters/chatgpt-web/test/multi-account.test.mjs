import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {generate} from '../../../services/oauth/node_modules/otplib/dist/index.js';
import {gatewayFixture} from './fixture.mjs';
import {Browser,validatedCallback} from '../../../services/oauth/test/fixture.mjs';
import {pendingAccount} from '../../../services/oauth/test/helpers/identity-fixture.mjs';
import {provisionIdentities} from '../../../services/oauth/src/provisioning.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {randomSecret,writePrivate} from '../../../shared/oauth-common.mjs';

async function authorize(f,name,seed,{browser=new Browser(f.config.issuer),pauseOnConsent=false,forceLogin=false,stopStatus}={}) {
 const verifier=randomSecret();
 const request={client_id:f.config.chatgpt_client.client_id,redirect_uri:f.config.chatgpt_client.redirect_uris[0],response_type:'code',scope:'openid offline_access memory:read project:read',
   resource:f.config.resource,state:randomSecret(),code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),...(forceLogin?{prompt:'login'}:{})};
 let r=await browser.request(`/authorize?${new URLSearchParams(request)}`);
 for(let i=0;i<12;i++) {
  if(stopStatus&&r.status===stopStatus)return r;
  const location=r.headers.get('location');
  if(location){const next=new URL(location,f.config.issuer);if(next.origin!==f.config.issuer)return {callback:validatedCallback(next,f.config.issuer,request),verifier,request};r=await browser.request(next);}
  else {
   assert.equal(r.status,200);const csrf=r.text.match(/name="csrf" value="([^"]+)"/)?.[1],action=r.text.match(/action="([^"]+)"/)?.[1];
   assert.ok(csrf&&action,'authorization must return an actionable login or consent page');
   if(action.endsWith('/confirm'))assert.ok(r.text.includes(`<strong>${name}</strong>`),'consent identifies the actual immutable account');
   if(action.endsWith('/confirm')&&pauseOnConsent)return {browser,action,csrf,request,verifier};
   r=await browser.post(action,{csrf,...(action.endsWith('/login')?{username:name,password:'Synthetic password with spaces  ',otp:await generate({secret:seed})}:{accountId:'forged-other-owner',user_id:'forged-other-owner'})});
  }
 }
 throw new Error('Synthetic authorization did not finish');
}
test('OAUTH-01..03 ISO-05..07: real two-account OAuth and interleaved MCP reads use immutable request principals',async t=>{
 const core=await memoryFixture(t);
 const f=await gatewayFixture(t,{sharedOrigin:true,profile:'readonly',coreFixture:core,authMutate:c=>{
   c.identity_mode='multi_account_v1';c.login.registration_enabled=true;c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600};
   writePrivate(c.identity.encryption_key_file,randomSecret());
 },mutate:c=>{c.identity_mode='multi_account_v1';writePrivate(c.identity_map_file,{unknown_subject_policy:'deny',mappings:[]},{replace:true});}});
 const ids=f.app.accounts,owners=[];
 for(const asset of ['styles.css','appearance.mjs','app.mjs','catalog.mjs','session-state.mjs'])
  assert.equal((await fetch(f.config.issuer+'/assets/'+asset)).status,200);
 for(const route of ['/v1/identity','/v1/admin','/assets/private.json','/app/unknown','/console-api/export'])
  assert.equal((await fetch(f.config.issuer+route)).status,404,route);
 assert.equal((await fetch(f.config.issuer+'/login')).status,200);
 assert.equal((await fetch(f.config.issuer+'/console-api/me')).status,401);
 for(const name of ['Synthetic_A','Synthetic_B']) {
   const a=await pendingAccount({identities:ids},name);ids.takeRecoveryCodes(a.session.token);ids.acknowledgeRecovery(a.session.token);owners.push({name,...a});
 }
 provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'principals'),identityMapFile:f.gatewayConfig.identity_map_file});
 for(const owner of owners) {
   const account=ids.byId(owner.account.account_id),writer=core.issue(account.user_id,`writer-${account.account_id}`);
   owner.memory=core.store.saveMemory(writer.auth,{scope:'user',content:'Synthetic identical private memory'}).memory;
   const revision=core.store.revisions.latest(account.user_id,owner.memory.memory_id);core.store.webVisibility.set(writer.auth,owner.memory.memory_id,{allow:true,revision:revision.revision,state_hash:revision.state_hash});
   const tokens=await f.exchange(await authorize(f,owner.name,owner.setup.secret));assert.equal(tokens.status,200);owner.tokens=tokens.data;
 }
 const calls=[];
 // Interleave both accounts without exceeding the unchanged four-request subject guard.
 for(let wave=0;wave<3;wave++) calls.push(...await Promise.all(Array.from({length:4},(_,i)=>f.mcp('tools/call',{name:'mnemuron_search_memories',arguments:{query:'Synthetic identical private memory'}},owners[i%2].tokens.access_token,{headers:{'x-user-id':ids.byId(owners[1-i%2].account.account_id).user_id}}))));
 for(const [i,r] of calls.entries()){assert.equal(r.status,200);const content=JSON.stringify(r.data);assert.ok(content.includes(owners[i%2].memory.memory_id),content);assert.ok(!content.includes(owners[1-i%2].memory.memory_id));}
 ids.db.prepare("UPDATE identity_accounts SET status='disabled',security_version=security_version+1 WHERE account_id=?").run(owners[0].account.account_id);
 ids.store.revoke({subject:owners[0].setup.subject});
 assert.equal((await f.mcp('tools/list',undefined,owners[0].tokens.access_token)).status,401);
 assert.equal((await f.mcp('tools/list',undefined,owners[1].tokens.access_token)).status,200);
 const before=core.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
 const forbidden=await f.mcp('tools/call',{name:'mnemuron_save_memory',arguments:{}},owners[1].tokens.access_token);
 assert.equal(forbidden.data.result.isError,true);
 assert.equal(core.store.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n,before);
});
test('OAUTH-07: a different OAuth login invalidates the old browser session and requires a fresh authorization',async t=>{
 const core=await memoryFixture(t);
 const f=await gatewayFixture(t,{profile:'readonly',coreFixture:core,authMutate:c=>{
  c.identity_mode='multi_account_v1';c.login.registration_enabled=true;
  c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600};
  writePrivate(c.identity.encryption_key_file,randomSecret());
 },mutate:c=>{c.identity_mode='multi_account_v1';writePrivate(c.identity_map_file,{unknown_subject_policy:'deny',mappings:[]},{replace:true});}});
 const ids=f.app.accounts,owners=[];
 for(const name of ['Synthetic_Switch_A','Synthetic_Switch_B']){
  const a=await pendingAccount({identities:ids},name);ids.takeRecoveryCodes(a.session.token);ids.acknowledgeRecovery(a.session.token);owners.push({name,...a});
 }
 provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:f.gatewayConfig.identity_map_file});
 const [a,b]=owners,paused=await authorize(f,a.name,a.setup.secret,{pauseOnConsent:true});
 const switched=await authorize(f,b.name,b.setup.secret,{browser:paused.browser,forceLogin:true,stopStatus:409});
 assert.equal(JSON.parse(switched.text).error_code,'AUTHORIZATION_RESTART_REQUIRED');
 const old=await paused.browser.post(paused.action,{csrf:paused.csrf});
 assert.equal(old.status,403);
 assert.equal(f.app.store.db.prepare("SELECT COUNT(*) AS n FROM oauth_records WHERE model='Grant'").get().n,0);
});
test('OAUTH-07: switching the same browser to B cannot complete the earlier A consent',async t=>{
 const core=await memoryFixture(t);
 const f=await gatewayFixture(t,{profile:'readonly',coreFixture:core,authMutate:c=>{
  c.identity_mode='multi_account_v1';c.login.registration_enabled=true;
  c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600};
  writePrivate(c.identity.encryption_key_file,randomSecret());
 },mutate:c=>{c.identity_mode='multi_account_v1';writePrivate(c.identity_map_file,{unknown_subject_policy:'deny',mappings:[]},{replace:true});}});
 const ids=f.app.accounts,owners=[];
 for(const name of ['Synthetic_Consent_A','Synthetic_Consent_B']){
  const a=await pendingAccount({identities:ids},name);ids.takeRecoveryCodes(a.session.token);ids.acknowledgeRecovery(a.session.token);owners.push({name,...a});
 }
 provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:f.gatewayConfig.identity_map_file});
 const [a,b]=owners,paused=await authorize(f,a.name,a.setup.secret,{pauseOnConsent:true});
 const login=await paused.browser.request('/login');
 assert.equal((await paused.browser.post('/login',{csrf:login.text.match(/name="csrf" value="([^"]+)"/)[1],username:b.name,
  password:'Synthetic password with spaces  ',otp:await generate({secret:b.setup.secret})})).status,303);
 const me=JSON.parse((await paused.browser.request('/console-api/me')).text);
 assert.equal(me.account_id,b.account.account_id,'the same browser has actually switched to B');
 const old=await paused.browser.post(paused.action,{csrf:paused.csrf});
 assert.ok(old.status>=400&&old.status<500,'old consent fails closed after browser changes account');
 const grants=f.app.store.db.prepare("SELECT payload FROM oauth_records WHERE model='Grant'").all().map(r=>JSON.parse(r.payload));
 assert.equal(grants.length,0,'stale consent cannot create a grant for either account');
});

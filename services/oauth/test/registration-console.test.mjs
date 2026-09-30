import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {generate} from 'otplib';
import {fixture,Browser} from './fixture.mjs';
import {writePrivate,randomSecret} from '../../../shared/oauth-common.mjs';
import {previousStepCode} from './helpers/totp.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {provisionIdentities} from '../src/provisioning.mjs';
const csrf=page=>page.text.match(/name="csrf" value="([^"]+)"/)?.[1];
import {consoleFixture} from './helpers/identity-fixture.mjs';
test('REG-UI-01: disabled signup explains the boundary without opening enrollment or hiding the sign-in route',async t=>{
 const f=await consoleFixture(t);f.app.config.login.registration_enabled=false;
 const browser=new Browser(f.config.issuer),page=await browser.request('/register');
 assert.equal(page.status,200);assert.match(page.text,/data-policy="registration_disabled"/);assert.match(page.text,/href="\/login"/);
 assert.ok(!page.text.includes('action="/register/reserve"'));assert.ok(!page.headers.get('set-cookie'));
 assert.equal((await browser.post('/register/reserve',{code:'synthetic-invalid'})).status,403);
});
test('MFA-01..06, UI-05..06: real registration routes require invitation, CSRF and verified MFA',async t=>{
 const f=await consoleFixture(t),browser=new Browser(f.config.issuer),ids=f.app.accounts;
 const invitation=ids.issueInvitations({count:1,ttlMinutes:10,issuer:'synthetic-test'}).codes[0];
 let page=await browser.request('/register');assert.equal(page.status,200);assert.match(page.text,/autocomplete="off"/);
 assert.equal((await browser.post('/register/reserve',{csrf:'wrong',code:invitation})).status,401);
 page=await browser.request('/register');let result=await browser.post('/register/reserve',{csrf:csrf(page),code:invitation});assert.equal(result.status,303);
 page=await browser.request(result.headers.get('location'));
 assert.equal((await browser.post('/register/account',{csrf:csrf(page),username:'Synthetic_Registration',password:'Synthetic password with spaces  ',password_confirm:'Synthetic password with spaces  ',role:'admin'})).status,400);
 assert.equal(ids.db.prepare('SELECT COUNT(*) n FROM identity_accounts').get().n,0);
 result=await browser.post('/register/account',{csrf:csrf(page),username:'Synthetic_Registration',password:'Synthetic password with spaces  ',password_confirm:'Synthetic password with spaces  '});assert.equal(result.status,303);
 page=await browser.request(result.headers.get('location'));assert.match(page.text,/<svg/);assert.ok(!page.text.includes('chart.googleapis'));
 const seed=page.text.match(/id="totp-secret">([^<]+)</)[1];
 result=await browser.post('/register/totp',{csrf:csrf(page),otp:await previousStepCode(seed)});assert.equal(result.status,303);
 page=await browser.request(result.headers.get('location'));assert.match(page.text,/recovery-codes/);
 result=await browser.post('/register/ack',{csrf:csrf(page)});assert.equal(result.status,303);
 assert.equal((await browser.request('/console-api/me')).status,401);
 const core=await memoryFixture(t);
 provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'credentials'),identityMapFile:path.join(f.directory,'map.json')});
 page=await browser.request('/login');result=await browser.post('/login',{csrf:csrf(page),username:'Synthetic_Registration',password:'Synthetic password with spaces  ',otp:await generate({secret:seed})});assert.equal(result.status,303);
 result=await browser.request('/console-api/me');assert.equal(result.status,200);const me=JSON.parse(result.text);
 assert.equal(me.username,'Synthetic_Registration');assert.equal(me.production_ready,false);
 assert.equal((await browser.post('/console-api/invitations',{csrf:me.csrf})).status,403);
 assert.equal((await browser.request('/recover')).status,200);assert.match((await browser.request('/recover')).text,/blocked_policy/);
});
test('INV-15: real registration endpoint bounds payload and repeated invalid codes without creating accounts',async t=>{
 const f=await consoleFixture(t),browser=new Browser(f.config.issuer);
 const direct=await new Browser(f.config.issuer).post('/register/account',{username:'Synthetic_Blocked',password:'Synthetic password with spaces  '});
 assert.equal(direct.status,401);
 let page=await browser.request('/register');
 const tooLarge=await browser.post('/register/reserve',{csrf:csrf(page),code:'synthetic-invalid-'.repeat(1024)});
 assert.equal(tooLarge.status,413);
 for(let i=0;i<31;i++) {
  page=await browser.request('/register');
  const response=await browser.post('/register/reserve',{csrf:csrf(page),code:'synthetic-invalid-code'});
  assert.equal(response.status,i===30?429:400);
 }
 assert.equal(f.app.store.db.prepare('SELECT COUNT(*) n FROM identity_accounts').get().n,0);
 assert.ok(!JSON.stringify(f.logs).includes('synthetic-invalid-code'));
});

test('REG-MGMT-02: real signup finishes through the durable worker without granting operator or memory writes',async t=>{
 const core=await memoryFixture(t),f=await fixture(t,{start:false,mutate:c=>{
   c.identity_mode='multi_account_v1';c.login.registration_enabled=true;
   c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600,
     console_operations:false,console_management:{invitations:true,accounts:true,roles:false},core:{base_url:core.baseUrl},
     provisioning:{enabled:true,core_database:core.databasePath,credential_directory:path.join(path.dirname(c.database_file),'keys'),identity_map_file:path.join(path.dirname(c.database_file),'map.json')}};
 }});
 writePrivate(f.config.identity.encryption_key_file,randomSecret());await f.start();const ids=f.app.accounts,browser=new Browser(f.config.issuer);
 const [code]=ids.issueInvitations({count:1,ttlMinutes:5,issuer:'synthetic-server'}).codes;
 let page=await browser.request('/login');assert.match(page.text,/href="\/register"/);
 page=await browser.request('/register');assert.match(page.text,/class="auth-steps"/);assert.match(page.text,/<li aria-current="step"><span data-i18n="stepInvitation">/);
 let result=await browser.post('/register/reserve',{csrf:csrf(page),code});assert.equal(result.status,303);
 page=await browser.request('/register/account');assert.match(page.text,/registrationCredentials/);
 result=await browser.post('/register/account',{csrf:csrf(page),username:'Synthetic_Full_Signup',password:'Synthetic signup password',password_confirm:'Synthetic signup password'});assert.equal(result.status,303);
 page=await browser.request('/register/totp');const secret=page.text.match(/id="totp-secret">([^<]+)</)[1];
 assert.match(page.text,/<svg/);assert.equal((await browser.request('/console-api/me')).status,401);
 result=await browser.post('/register/totp',{csrf:csrf(page),otp:await previousStepCode(secret)});assert.equal(result.status,303);
 page=await browser.request('/register/recovery-codes');assert.match(page.text,/recovery-codes/);
 result=await browser.post('/register/ack',{csrf:csrf(page)});assert.equal(result.status,303);
 // Exercise the actual periodic worker, not a test call to provisionIdentities.
 const deadline=Date.now()+9000;let account;
 do{account=ids.db.prepare('SELECT * FROM identity_accounts WHERE username=?').get('Synthetic_Full_Signup');if(account.status==='active')break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
 assert.equal(account.status,'active');assert.equal(account.mfa_verified,1);assert.equal(account.binding_ready,1);assert.equal(account.recovery_ack,1);
 assert.equal(ids.console.operator(account.account_id),false);
 for(const b of ids.bindings(account.subject)){
   const credential=core.store.db.prepare('SELECT scopes_json FROM credentials WHERE credential_id=?').get(b.credential_id);
   assert.ok(JSON.parse(credential.scopes_json).every(s=>!s.endsWith(':write')&&!s.endsWith(':organize')));
 }
 page=await browser.request('/login');result=await browser.post('/login',{csrf:csrf(page),username:account.username,password:'Synthetic signup password',otp:await generate({secret})});assert.equal(result.status,303);
 const me=await browser.request('/console-api/me');assert.equal(me.status,200);assert.equal(JSON.parse(me.text).account_id,account.account_id);
 assert.equal((await browser.request('/console-api/accounts')).status,403);assert.equal((await browser.request('/console-api/invitations')).status,403);
 const cap=JSON.parse((await browser.request('/console-api/capabilities')).text);assert.equal(cap.writable,false);assert.equal(cap.operator,false);
 assert.match((await browser.request('/recover')).text,/blocked_policy/);
});

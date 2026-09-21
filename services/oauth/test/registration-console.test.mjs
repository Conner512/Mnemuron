import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {generate} from 'otplib';
import {fixture,Browser} from './fixture.mjs';
import {writePrivate,randomSecret,seconds} from '../../../shared/oauth-common.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {provisionIdentities} from '../src/provisioning.mjs';
const csrf=page=>page.text.match(/name="csrf" value="([^"]+)"/)?.[1];
import {consoleFixture} from './helpers/identity-fixture.mjs';
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
 result=await browser.post('/register/totp',{csrf:csrf(page),otp:await generate({secret:seed,epoch:seconds()-30})});assert.equal(result.status,303);
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

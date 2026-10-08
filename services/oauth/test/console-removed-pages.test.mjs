// Console items 5, 8 and 9: the privacy/retention, registration-code and account-management pages are gone from the
// web Console. Old URLs redirect to the overview, nothing renders for them, and the shell no longer shows the username
// in the sidebar while keeping security and sign-out reachable from the account menu. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {generate} from 'otplib';
import {Browser} from './fixture.mjs';
import {consoleFixture,pendingAccount} from './helpers/identity-fixture.mjs';
import {provisionIdentities} from '../src/provisioning.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {pages,removedPages,renderPage,routeTitle} from '../../../web/console/render.mjs';
import {featureMap} from '../../../web/console/visuals.mjs';

globalThis.document??={body:{dataset:{}},documentElement:{dataset:{}},querySelectorAll:()=>[],addEventListener:()=>{}};
const {actionPage}=await import('../../../web/console/actions.mjs');
const {connectionsView}=await import('../../../web/console/connections.mjs');

test('RMV-01: removed pages are absent from navigation, routes, feature map and renderers',()=>{
 assert.deepEqual([...removedPages].sort(),['accounts','invitations','privacy']);
 const caps={enabled:true,writable:true,operator:true,account_id:'synthetic-a',management:{invitations:true,accounts:true,roles:true}};
 for(const page of removedPages){
  assert.ok(!pages.includes(page));assert.equal(featureMap[page],undefined);assert.equal(routeTitle(`/app/${page}`),null,page);
  assert.equal(actionPage(page,{invitations:[{invitation_id:'i',effective_state:'issued'}],accounts:[{account_id:'b',status:'active'}]},caps),null,page);
 }
 const html=renderPage({title:'overview',page:'overview',account:{account_id:'synthetic-a',username:'Synthetic_Visible_Name'},csrf:'c'});
 for(const page of removedPages)assert.ok(!html.includes(`/app/${page}`),page);
 const nav=html.slice(html.indexOf('<aside class="sidebar">'),html.indexOf('</aside>'));
 assert.doesNotMatch(nav,/Synthetic_Visible_Name|account-badge/,'no username in the sidebar');
 assert.match(html,/class="account-security" href="\/app\/security"/,'security stays one click away');
 assert.match(html,/<form[^>]+action="\/console-api\/logout"/,'sign-out stays available');
 // No Console source still links a removed page (e.g. the old ChatGPT read-scope "Details" link to /app/privacy).
 const dir=new URL('../../../web/console/',import.meta.url);
 for(const file of fs.readdirSync(dir).filter(f=>/\.(mjs|css)$/.test(f))){const src=fs.readFileSync(new URL(file,dir),'utf8');
  for(const page of removedPages)assert.doesNotMatch(src,new RegExp(`/app/${page}\\b`),`${file} links /app/${page}`);}
 // The ChatGPT read scope stays explained in place, for each operator policy, without the removed page.
 for(const [policy,scope,note] of [[{active_records_uniform:true},'connReadActiveUniform','readPolicyUniformOn'],[{legacy_read_all:true},'connReadAll','readPolicyLegacyReadAll'],[{},'connReadGranted','readPolicyUniformOff']]){
  const inventory=connectionsView({system_chatgpt:{configured:true}},{read_policy:policy});
  assert.match(inventory,new RegExp(`data-i18n="${scope}"[\\s\\S]*data-i18n="${note}"[\\s\\S]*data-i18n="readPolicyOperator"`),scope);
 }
 assert.match(actionPage('system',{},{...caps,operator:false}),/operatorRequired/,'the system page stays operator-only');
});

test('RMV-02: old URLs redirect to the overview before and after sign-in, and serve no page content',async t=>{
 const core=await memoryFixture(t),f=await consoleFixture(t,{core}),ids=f.app.accounts;
 const a=await pendingAccount({identities:ids},'Synthetic_Removed_A');ids.takeRecoveryCodes(a.session.token);ids.acknowledgeRecovery(a.session.token);
 provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json')});
 const anonymous=new Browser(f.config.issuer);
 for(const page of removedPages)for(const url of [`/app/${page}`,`/app/${page}/`]){
  const r=await anonymous.request(url);assert.equal(r.status,303,url);assert.equal(r.headers.get('location'),'/app',url);
 }
 const browser=new Browser(f.config.issuer),form=await browser.request('/login');
 const login=await browser.post('/login',{csrf:form.text.match(/name="csrf" value="([^"]+)"/)[1],username:'Synthetic_Removed_A',password:'Synthetic password with spaces  ',otp:await generate({secret:a.setup.secret})});
 assert.equal(login.status,303);
 for(const page of removedPages){
  const r=await browser.request(`/app/${page}`);assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/app');assert.equal(r.text,'');
 }
 const overview=await browser.request('/app/overview');assert.equal(overview.status,200);
 for(const page of removedPages)assert.ok(!overview.text.includes(`href="/app/${page}"`),page);
});

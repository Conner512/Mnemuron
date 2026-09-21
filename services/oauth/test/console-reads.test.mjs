import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {generate} from 'otplib';
import {Browser} from './fixture.mjs';
import {consoleFixture,pendingAccount} from './helpers/identity-fixture.mjs';
import {provisionIdentities} from '../src/provisioning.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {organizer,taxonomy} from '../../../server/test/helpers/memory-models.mjs';
import {MemoryWorker,scheduleLibrary} from '../../../server/lib/memory-jobs/worker.mjs';
import {MemoryJobs} from '../../../server/lib/memory-jobs/store.mjs';
import {ConsoleCore} from '../src/console-core.mjs';

async function login(f,owner) {
 const browser=new Browser(f.config.issuer),page=await browser.request('/login');
 const result=await browser.post('/login',{csrf:page.text.match(/name="csrf" value="([^"]+)"/)[1],username:owner.name,password:'Synthetic password with spaces  ',otp:await generate({secret:owner.setup.secret})});
 assert.equal(result.status,303);return browser;
}
const json=async(browser,url)=>{const r=await browser.request(url);return {status:r.status,data:JSON.parse(r.text)};};

test('ISO-01..05 ISO-11..12 UI-07 INT-06: real console sessions isolate every read, source, summary and policy route',async t=>{
 const core=await memoryFixture(t),f=await consoleFixture(t,{core}),ids=f.app.accounts,owners=[];
 for(const name of ['Synthetic_Console_A','Synthetic_Console_B']) {
   const a=await pendingAccount({identities:ids},name);ids.takeRecoveryCodes(a.session.token);ids.acknowledgeRecovery(a.session.token);owners.push({name,...a});
 }
 provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json')});
 const model=organizer(),jobs=new MemoryJobs(core.store);
 for(const owner of owners) {
   owner.user=ids.byId(owner.account.account_id).user_id;const writer=core.issue(owner.user,`writer-${owner.user}`);owner.auth=writer.auth;
   owner.memory=core.store.saveMemory(writer.auth,{scope:'user',content:'Same synthetic console memory 😀 '.repeat(110)}).memory;
   scheduleLibrary(core.store,jobs,{userId:owner.user,organizer:model,taxonomy,type:'summary',periods:['daily'],includeOpen:true});
   owner.browser=await login(f,owner);
 }
 await new MemoryWorker(core.store,jobs,model).drain();
 for(const [index,owner] of owners.entries()) {
   const other=owners[1-index];
   for(const view of ['overview','memories','summaries','jobs','connections','audit','security','storage']) {
     const r=await json(owner.browser,`/console-api/${view}`);assert.equal(r.status,200,view);
     assert.ok(!JSON.stringify(r.data).includes(other.memory.memory_id),view);assert.ok(!JSON.stringify(r.data).includes(other.user),view);
   }
   for(const route of ['models','accounts','invitations','export','restore','../../v1/admin'])assert.notEqual((await json(owner.browser,`/console-api/${route}`)).status,200,route);
   assert.equal((await json(owner.browser,`/console-api/memories?user_id=${other.user}`)).status,400);
   const own=await json(owner.browser,`/console-api/memory?memory_id=${owner.memory.memory_id}&content_limit=64`);assert.equal(own.status,200);assert.equal(own.data.content_complete,false);
   assert.equal((await json(other.browser,`/console-api/memory?${new URLSearchParams(own.data.next_request)}`)).status,404);
   const summaries=await json(owner.browser,'/console-api/summaries'),summary=summaries.data.summaries[0];
   const detail=await json(owner.browser,`/console-api/summary?summary_id=${summary.summary_id}&revision=${summary.revision}`);
   assert.equal(detail.status,200);assert.equal(detail.data.results[0].summary_id,summary.summary_id);
   assert.ok(JSON.stringify(detail.data).includes(owner.memory.memory_id));assert.ok(!JSON.stringify(detail.data).includes(other.memory.memory_id));
   assert.equal((await json(other.browser,`/console-api/summary?summary_id=${summary.summary_id}`)).status,404);
   core.store.retractMemory(owner.auth,owner.memory.memory_id);
   assert.equal((await json(owner.browser,`/console-api/summary?summary_id=${summary.summary_id}&revision=${summary.revision}`)).status,409);
 }
});

test('ISO-10 INT-05: delayed authenticated A read is rejected after logout while B continues',async t=>{
 const core=await memoryFixture(t),f=await consoleFixture(t,{core}),ids=f.app.accounts,owners=[];
 for(const name of ['Synthetic_Late_A','Synthetic_Late_B']) {
  const a=await pendingAccount({identities:ids},name);ids.takeRecoveryCodes(a.session.token);ids.acknowledgeRecovery(a.session.token);owners.push({name,...a});
 }
 provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json')});
 for(const owner of owners){owner.user=ids.byId(owner.account.account_id).user_id;owner.memory=core.store.saveMemory(core.issue(owner.user,owner.name).auth,{scope:'user',content:'Synthetic delayed request marker'}).memory;owner.browser=await login(f,owner);}
 const [a,b]=owners,original=ConsoleCore.prototype.view;let release,entered;
 const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 ConsoleCore.prototype.view=async function(view,params){const data=await original.call(this,view,params);if(this.principal.user_id===a.user&&view==='memory'){entered();await held;}return data;};
 t.after(()=>{ConsoleCore.prototype.view=original;release();});
 const late=json(a.browser,`/console-api/memory?memory_id=${a.memory.memory_id}`);await started;
 const me=await json(a.browser,'/console-api/me');assert.equal((await a.browser.post('/console-api/logout',{csrf:me.data.csrf})).status,303);
 const own=await json(b.browser,'/console-api/memories');assert.equal(own.status,200);assert.deepEqual(own.data.results.map(m=>m.memory_id),[b.memory.memory_id]);
 release();const denied=await late;assert.equal(denied.status,401);assert.ok(!JSON.stringify(denied.data).includes(a.memory.memory_id));
});

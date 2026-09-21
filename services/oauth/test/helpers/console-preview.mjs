// Isolated manual UI fixture: actual authentication/BFF, synthetic database, loopback only.
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {generate} from 'otplib';
import {consoleFixture,pendingAccount} from './identity-fixture.mjs';
import {memoryFixture} from '../../../../server/test/helpers/core-memory-fixture.mjs';
import {organizer,taxonomy} from '../../../../server/test/helpers/memory-models.mjs';
import {MemoryJobs} from '../../../../server/lib/memory-jobs/store.mjs';
import {MemoryWorker,scheduleLibrary} from '../../../../server/lib/memory-jobs/worker.mjs';
import {provisionIdentities} from '../../src/provisioning.mjs';
import {ConsoleCore} from '../../src/console-core.mjs';
import {randomSecret} from '../../../../shared/oauth-common.mjs';
const cleanup=[],t={after:fn=>cleanup.push(fn)};
const core=await memoryFixture(t),f=await consoleFixture(t,{core}),ids=f.app.accounts;
const owner=await pendingAccount({identities:ids},'Synthetic_Visual');
ids.takeRecoveryCodes(owner.session.token);ids.acknowledgeRecovery(owner.session.token);
const second=await pendingAccount({identities:ids},'Synthetic_Visual_B');
ids.takeRecoveryCodes(second.session.token);ids.acknowledgeRecovery(second.session.token);
provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json')});
const bWriter=core.issue(ids.byId(second.account.account_id).user_id,'visual-synthetic-b-writer');
core.store.saveMemory(bWriter.auth,{scope:'user',content:'Only-B synthetic sentinel; the A detail must never appear here.'});
const writer=core.issue(ids.byId(owner.account.account_id).user_id,'visual-synthetic-writer');
for(const content of [
 '合成验证记录：蓝色纸船停在测试码头。仅用于隔离界面验收，不是个人记忆。',
 'Synthetic UI acceptance: authorization is read-only. Registration is local and invite-gated.',
 '多语言分页合成记录 😀：来源、版本与原文保持对应。'.repeat(120),
 '合成决定：未批准的操作保持关闭，不调用真实付费模型。',
 'LongSyntheticIdentifierForDesktopLayoutAndKeyboardAccessibilityWithoutAnyPersonalInformation'.repeat(6),
])core.store.saveMemory(writer.auth,{scope:'user',content});
const model=organizer(),jobs=new MemoryJobs(core.store);
for(const type of ['classification','summary']){
 scheduleLibrary(core.store,jobs,{userId:writer.auth.user_id,organizer:model,taxonomy,type,periods:['daily'],includeOpen:true});
 await new MemoryWorker(core.store,jobs,model).drain();
}
console.log(JSON.stringify({url:f.config.issuer+'/login',username:'Synthetic_Visual',password:'Synthetic password with spaces  ',fixture:true,production_ready:false}));
let hold=false,release;
const coreView=ConsoleCore.prototype.view;
ConsoleCore.prototype.view=async function(view,params){
 const result=await coreView.call(this,view,params);
 if(hold&&view==='memory'&&this.principal.user_id===writer.auth.user_id){
  console.log(JSON.stringify({synthetic_detail_held:true}));await new Promise(resolve=>{release=resolve;});
 }
 return result;
};
console.log('Commands: otp, otp-b, authorize, hold-detail, release-detail, core-off/core-on, stop. Synthetic loopback fixture only.');
const lines=readline.createInterface({input:process.stdin});
async function close(){hold=false;release?.();ConsoleCore.prototype.view=coreView;lines.close();for(const fn of cleanup.reverse())await fn();process.exit(0);}
lines.on('line',async line=>{
 if(line==='otp')console.log(JSON.stringify({synthetic_otp:await generate({secret:owner.setup.secret})}));
 if(line==='otp-b')console.log(JSON.stringify({synthetic_otp:await generate({secret:second.setup.secret})}));
 if(line==='authorize') {
  const params={client_id:f.config.chatgpt_client.client_id,redirect_uri:f.config.chatgpt_client.redirect_uris[0],response_type:'code',
   scope:'openid offline_access memory:read project:read',resource:f.config.resource,state:randomSecret(),code_challenge_method:'S256',
   code_challenge:createHash('sha256').update(randomSecret()).digest('base64url')};
  console.log(JSON.stringify({synthetic_authorize_url:f.config.issuer+'/authorize?'+new URLSearchParams(params)}));
 }
 if(line==='hold-detail'){hold=true;console.log(JSON.stringify({synthetic_hold_enabled:true}));}
 if(line==='release-detail'){hold=false;release?.();console.log(JSON.stringify({synthetic_detail_released:true}));}
 if(line==='core-off'||line==='core-on') {
  f.app.config.identity.core.base_url=line==='core-off'?'http://127.0.0.1:1':core.baseUrl;
  console.log(JSON.stringify({synthetic_core_available:line==='core-on'}));
 }
 if(line==='stop')await close();
});
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,close);

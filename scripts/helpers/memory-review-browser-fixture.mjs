// Disposable synthetic Core + OAuth services. Never reuses an operator configuration or real source data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {randomUUID} from 'node:crypto';
import {generate} from '../../services/oauth/node_modules/otplib/dist/index.js';
import {memoryFixture,assertIsolatedTarget} from '../../server/test/helpers/core-memory-fixture.mjs';
import {fixture} from '../../services/oauth/test/fixture.mjs';
import {pendingAccount} from '../../services/oauth/test/helpers/identity-fixture.mjs';
import {provisionIdentities} from '../../services/oauth/src/provisioning.mjs';
import {randomSecret,writePrivate,seconds} from '../../shared/oauth-common.mjs';

const cleanup=[],t={after:fn=>cleanup.push(fn)},core=await memoryFixture(t);
assertIsolatedTarget(core.root,core.databasePath,core.baseUrl);
const key=path.join(core.root,'console-key');writePrivate(key,randomSecret());core.store.memoryConfig.console={key_file:key,worker_enabled:false};
const f=await fixture(t,{start:false,mutate:c=>{c.identity_mode='multi_account_v1';c.login.registration_enabled=true;c.identity={
  encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600,console_operations:true,core:{base_url:core.baseUrl}};}});
writePrivate(f.config.identity.encryption_key_file,randomSecret());await f.start();assert.equal(new URL(f.config.issuer).hostname,'127.0.0.1');
const ids=f.app.accounts,owners=[];
for(const name of ['Synthetic_Review_A','Synthetic_Review_B']){const owner=await pendingAccount({identities:ids},name);ids.takeRecoveryCodes(owner.session.token);ids.acknowledgeRecovery(owner.session.token);owners.push(owner);}
provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json'),consoleOperations:true});
for(const [i,owner]of owners.entries()){owner.account=ids.byId(owner.account.account_id);owner.console=ids.newSession('console',{accountId:owner.account.account_id});owner.writer=core.issue(owner.account.user_id,'synthetic-review-browser-'+i);}
const a=owners[0],save=(content)=>core.store.saveMemory(a.writer.auth,{scope:'user',content,kind:'fact',concepts:['Synthetic Review']}).memory.memory_id;
const left=save('合成设备已升级到版本 17.12.3。仍需验证故障恢复；这不是独立核验结论。'),right=save('合成设备已升级到版本 17.12.4。下一步只验证恢复，不执行生产修改。');
core.store.saveMemory(owners[1].writer.auth,{scope:'user',content:'Synthetic other owner private body'});
core.store.appendEvents(a.writer.auth,{event:{event_id:'synthetic-browser-review-event',event_type:'user_message',session_id:'synthetic-browser-review-session',content:'事实：合成项目已经完成验收。\n```\n事实：代码示例不应抽取。\n```'}});
const sources=[left,right].map(id=>core.store.derivedMemory.currentSource(a.account.user_id,id));
const summary=core.store.memoryTransaction(()=>core.store.derivedMemory.publishSummary({job_id:randomUUID(),group_key:randomUUID(),user_id:a.account.user_id,scope_key:sources[0].scope_key,profile:'synthetic',metadata:{category:'all',window:{period:'daily'},taxonomy:{version:core.store.consoleService.taxonomy(a.account.user_id).version}}},sources,[{memory_id:left,revision:sources[0].revision,start:0,end:sources[0].content.length,quote:sources[0].content}],Date.now()));
const state=()=>({memories:core.store.db.prepare('SELECT COUNT(*) n FROM memories WHERE user_id=?').get(a.account.user_id).n,candidates:core.store.db.prepare("SELECT COUNT(*) n FROM memory_review_candidates WHERE user_id=? AND state='pending'").get(a.account.user_id).n,feedback:core.store.db.prepare('SELECT decision FROM memory_summary_reviews WHERE user_id=?').all(a.account.user_id),reviews:core.store.db.prepare('SELECT decision FROM memory_manual_reviews WHERE user_id=?').all(a.account.user_id)});
let stopped=false;async function stop(){if(stopped)return;stopped=true;for(const fn of cleanup.reverse())await fn();process.exit(!fs.existsSync(core.root)&&!fs.existsSync(f.directory)?0:1);}
console.log(JSON.stringify({fixture:true,url:f.config.issuer,cookie:'mnm_fixture_console',accounts:owners.map(o=>({account_id:o.account.account_id,token:o.console.token})),expected:{left,right,summary,...state()}}));
readline.createInterface({input:process.stdin}).on('line',async line=>{try{const request=JSON.parse(line);if(request.command==='stop')return stop();let reply;
  if(request.command==='proof')reply={current_password:'Synthetic password with spaces  ',otp:await generate({secret:a.setup.secret,epoch:seconds()+(request.future||0)})};
  else if(request.command==='state')reply=state();
  else if(request.command==='revoke'){ids.db.prepare("DELETE FROM identity_sessions WHERE account_id=? AND purpose='console'").run(a.account.account_id);reply={revoked:true};}
  else throw new Error('UNKNOWN_SYNTHETIC_COMMAND');console.log(JSON.stringify({command:request.command,...reply}));
}catch(e){console.log(JSON.stringify({fixture_error:e.errorCode||e.code||e.message}));}});
process.on('SIGTERM',stop);process.on('SIGINT',stop);

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {generate} from 'otplib';
import {Browser,fixture} from './fixture.mjs';
import {pendingAccount} from './helpers/identity-fixture.mjs';
import {provisionIdentities} from '../src/provisioning.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {randomSecret,writePrivate,seconds} from '../../../shared/oauth-common.mjs';
import {CONSOLE_WRITE_SCOPES} from '../../../shared/console-contract.mjs';
import {main as operatorCommand} from '../bin/console-operator.mjs';

async function setup(t,{maintenance=false,recovery=false,writable=true,management,basic,connections=false}={}){
 const core=await memoryFixture(t);const f=await fixture(t,{start:false,mutate:c=>{
   c.identity_mode='multi_account_v1';c.login.registration_enabled=true;
   c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600,console_operations:true,core:{base_url:core.baseUrl}};
   if(connections)c.identity.connection_management={enabled:true,max_connections:20,pat_default_ttl_seconds:2592000,pat_max_ttl_seconds:7776000,secret_receipt_ttl_seconds:300,rotation_overlap_seconds:0};
   if(management){c.identity.console_operations=false;c.identity.console_management=management;}
   if(basic){c.identity.console_operations=false;c.identity.console_basic_operations=basic;}
   if(maintenance)c.identity.provisioning={enabled:true,core_database:core.databasePath,credential_directory:path.join(path.dirname(c.database_file),'keys'),identity_map_file:path.join(path.dirname(c.database_file),'map.json')};
   if(recovery)c.identity.recovery_policy={password:['recovery_code','totp'],totp:['recovery_code','password']};
 }});
 writePrivate(f.config.identity.encryption_key_file,randomSecret());await f.start();const ids=f.app.accounts,owners=[];
 for(const name of ['Synthetic_Actions_A','Synthetic_Actions_B']){const owner=await pendingAccount({identities:ids},name);owner.name=name;owner.codes=ids.takeRecoveryCodes(owner.session.token);ids.acknowledgeRecovery(owner.session.token);owners.push(owner);}
 provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json'),consoleOperations:writable});
 for(const o of owners){o.record=ids.byId(o.account.account_id);o.browser=new Browser(f.config.issuer);o.console=ids.newSession('console',{accountId:o.record.account_id});o.browser.cookies.set('mnm_fixture_console:/',{name:'mnm_fixture_console',path:'/',value:o.console.token});}
 const [a,b]=owners;
 const get=async(view,owner=a)=>{const r=await owner.browser.request('/console-api/'+view);return {status:r.status,body:JSON.parse(r.text)};};
 const act=async(action,payload={},owner=a,operation_id=randomUUID(),extra={})=>{const me=await get('me',owner),r=await owner.browser.post('/console-api/action',{csrf:me.body.csrf,account_id:owner.record.account_id,action,operation_id,payload:JSON.stringify(payload),...extra});return {status:r.status,body:JSON.parse(r.text)};};
 const proof=async(owner=a,future=0)=>({current_password:'Synthetic password with spaces  ',otp:await generate({secret:owner.setup.secret,epoch:seconds()+future})});
 return {core,f,ids,a,b,get,act,proof};
}
test('HTTP-COMPLETION: new reads require login; system views require an operator and never widen account visibility',async t=>{
 const x=await setup(t),anonymous=new Browser(x.f.config.issuer);
 for(const view of ['attention','taxonomy','privacy-defaults','retention','capture-status','model-usage','login-history','system-health','system-version','backups']){
   assert.equal((await anonymous.request('/console-api/'+view)).status,401,view);
   assert.equal((await x.get(view)).status,['system-health','system-version','backups'].includes(view)?403:200,view);
 }
 x.ids.console.role(x.a.record.account_id,true);
 for(const view of ['system-health','system-version','backups'])assert.equal((await x.get(view)).status,200,view);
 for(const view of ['login-history','audit'])assert.equal((await x.get(view+'?user_id=other')).status,400);
 assert.equal((await x.act('privacy.defaults',{expected_revision:0,sensitivity:'secret',cloud_readable:false})).status,200);
 assert.equal((await x.get('privacy-defaults',x.b)).body.sensitivity,'sensitive');
});
test('HTTP-COMPLETION: sensitive Agent and retention actions require fresh proof and revoked sessions fail closed',async t=>{
 const x=await setup(t);const key=path.join(x.core.root,'console-features.key');writePrivate(key,randomSecret());x.core.store.memoryConfig.console={key_file:key};
 const p={label:'Synthetic agent key',agent_id:'synthetic-agent',device_id:'synthetic-local',access:'read'};
 assert.equal((await x.act('devices.register',p)).status,403);
 assert.equal((await x.act('retention.prune',{confirmed:true})).status,403);
 const created=await x.act('devices.register',{...p,...await x.proof()});assert.equal(created.status,200,JSON.stringify(created.body));
 assert.equal((await x.act('devices.rotate',{credential_id:created.body.credential.credential_id,...await x.proof(x.b)},x.b)).status,404);
 const original=x.ids.authenticate.bind(x.ids);x.ids.authenticate=async(...args)=>{const result=await original(...args);x.ids.revokeSession(x.a.console.token);return result;};
 assert.equal((await x.act('devices.rotate',{credential_id:created.body.credential.credential_id,...await x.proof(x.a,30)})).status,401);
 assert.ok(x.core.store.authenticate(created.body.api_key));
});
test('HTTP-COMPLETION: authentication history and audit filters/export pages are owner scoped and secret free',async t=>{
 const x=await setup(t);
 await x.ids.authenticate(x.a.name,'wrong','000000');await x.ids.authenticate(x.b.name,'wrong','000000');
 const history=(await x.get('login-history?limit=1')).body;assert.equal(history.entries.length,1);assert.equal(history.entries[0].action,'account.login.failed');
 const all=await x.get('audit?source=identity&action=account.login.failed&outcome=failure&limit=1');assert.equal(all.status,200);assert.equal(all.body.entries.length,1);assert.equal(all.body.source,'identity');assert.equal(all.body.core_entries,undefined);
 assert.doesNotMatch(JSON.stringify(all.body),/password_json|mfa_cipher|wrong|000000/);
 assert.equal((await x.get('audit?from=bad')).status,400);assert.equal((await x.get('audit?limit=101')).status,400);
 const old=await x.get('audit?to=2000-01-01T00:00:00.000Z');assert.deepEqual(old.body.entries,[]);assert.equal(old.body.source,'core');assert.equal(old.body.core_entries,undefined);
});
test('HTTP-COMPLETION: Agent secret recovery is bound to the login that created it',async t=>{
 const x=await setup(t);const key=path.join(x.core.root,'console-receipt.key');writePrivate(key,randomSecret());x.core.store.memoryConfig.console={key_file:key};
 const p={label:'Synthetic bounded receipt',agent_id:'synthetic-receipt',device_id:'synthetic-local',access:'read'},operation=randomUUID();
 const created=await x.act('devices.register',{...p,...await x.proof()},x.a,operation);assert.equal(created.status,200);
 const session=x.ids.newSession('console',{accountId:x.a.record.account_id});x.a.browser.cookies.set('mnm_fixture_console:/',{name:'mnm_fixture_console',path:'/',value:session.token});
 const replay=await x.act('devices.register',{...p,...await x.proof(x.a,30)},x.a,operation);assert.equal(replay.status,409);assert.equal(replay.body.api_key,undefined);
 assert.equal(x.core.store.db.prepare("SELECT count(*) n FROM credentials WHERE agent_id='synthetic-receipt'").get().n,1);
 assert.equal((await x.act('devices.register',{...p,receipt_session:'a'.repeat(64)})).status,400);
});
test('HTTP-CON-01: real BFF binds CSRF, Origin, account and write credentials before side effects',async t=>{
 const x=await setup(t),p={scope:'user',content:'Real BFF synthetic memory'};
 let r=await x.act('memory.create',p);assert.equal(r.status,200,JSON.stringify(r.body));
 assert.equal((await x.get('memories',x.b)).body.results.length,0);
 assert.equal((await x.act('memory.create',p,x.a,randomUUID(),{account_id:x.b.record.account_id})).status,409);
 assert.equal((await x.act('memory.create',p,x.a,randomUUID(),{csrf:'invalid'})).status,401);
 const me=await x.get('me');const noOrigin=await x.a.browser.request('/console-api/action',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:me.body.csrf,account_id:x.a.record.account_id,action:'memory.create',operation_id:randomUUID(),payload:JSON.stringify(p)})});assert.equal(noOrigin.status,403);
 assert.equal(x.core.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n,1);
 const asset=await x.a.browser.request('/assets/actions.mjs');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);
});

test('HTTP-CONNECTIONS: owner capability is independent, real CSRF/proof/idempotency, metadata and late session safety',async t=>{
 const x=await setup(t,{connections:true,basic:{memory:false,security:true,oauth:true}}),p={kind:'generic_mcp',label:'Synthetic HTTP connection',profile:'readonly'},operation=randomUUID();
 const capabilities=(await x.get('capabilities')).body;assert.equal(capabilities.operator,false);assert.ok(capabilities.allowed_actions.includes('connections.create'));assert.ok(!capabilities.allowed_actions.includes('models.save'));
 assert.equal((await x.act('connections.create',p)).status,403);
 assert.equal((await x.act('connections.create',p,x.a,operation,{account_id:x.b.record.account_id})).status,409);
 assert.equal((await x.act('connections.create',p,x.a,operation,{csrf:'invalid'})).status,401);
 const issued=await x.act('connections.create',{...p,...await x.proof()},x.a,operation);assert.equal(issued.status,200,JSON.stringify(issued.body));assert.match(issued.body.secret,/^mcp_pat_/);
 const replay=await x.act('connections.create',p,x.a,operation);assert.equal(replay.body.secret,issued.body.secret);
 const id=issued.body.connection.connection_id;
 assert.equal((await x.get('connections?connection_id='+id,x.b)).status,404);
 assert.equal((await x.act('connections.revoke',{connection_id:id,...await x.proof(x.b)},x.b)).status,404);
 const list=await x.get('connections');assert.equal(list.body.connections.length,1);assert.ok(!JSON.stringify(list.body).includes(issued.body.secret));assert.equal((await x.get('connections?account_id='+x.b.record.account_id)).status,400);
 const detail=await x.get('connections?connection_id='+id);assert.equal(detail.status,200);assert.ok(!JSON.stringify(detail.body).includes(issued.body.secret));
 const asset=await x.a.browser.request('/assets/connections.mjs');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);
 const me=await x.get('me');const noOrigin=await x.a.browser.request('/console-api/action',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:me.body.csrf,account_id:x.a.record.account_id,action:'connections.create',operation_id:randomUUID(),payload:JSON.stringify(p)})});assert.equal(noOrigin.status,403);
 const original=x.ids.authenticate.bind(x.ids);x.ids.authenticate=async(...args)=>{const subject=await original(...args);x.ids.revokeSession(x.a.console.token);return subject;};
 const late=await x.act('connections.rotate',{connection_id:id,...await x.proof(x.a,30)});assert.equal(late.status,401);assert.equal(x.ids.connections.row(x.a.record.account_id,id).version,1);
});
test('HTTP-BASIC-01: own memory editing is independent of paid models, scheduling, export and platform roles',async t=>{
 const x=await setup(t,{basic:{memory:true,security:true,oauth:true}});
 const caps=(await x.get('capabilities')).body;assert.equal(caps.enabled,false);assert.equal(caps.writable,true);
 assert.ok(caps.allowed_actions.includes('memory.create'));assert.ok(caps.allowed_actions.includes('security.password'));
 for(const a of ['models.save','models.test','vector.schedule','jobs.schedule','storage.import','accounts.role','connections.create']){
  assert.ok(!caps.allowed_actions.includes(a),a);assert.equal((await x.act(a,{})).status,403,a);
 }
 let r=await x.act('memory.create',{scope:'user',content:'Synthetic basic settings acceptance'});assert.equal(r.status,200);const id=r.body.memory_id;
 assert.equal((await x.get(`memory-meta?memory_id=${id}`,x.b)).status,404);
 assert.equal((await x.get(`memory?memory_id=${id}&metadata=true`,x.b)).status,404);
 assert.equal((await x.get(`memory?memory_id=${id}&metadata=true&user_id=${x.b.record.user_id}`)).status,400);
 const meta=(await x.get(`memory-meta?memory_id=${id}`)).body;
 assert.deepEqual((await x.get(`memory?memory_id=${id}&metadata=true`)).body,meta);
 assert.equal((await x.act('memory.classify',{memory_id:id,revision:meta.revision,category:'technical'})).status,200);
 assert.equal((await x.act('memory.retract',{memory_id:id,revision:meta.revision},x.b)).status,404);
 assert.equal((await x.get('export')).status,404);assert.equal((await x.get('accounts')).status,403);
 assert.equal((await x.act('security.sessions.revoke_others')).status,200);
});
test('HTTP-BASIC-02: security without Core write scopes does not grant memory or foreign access',async t=>{
 const x=await setup(t,{basic:{memory:true,security:true,oauth:true},writable:false});
 const caps=(await x.get('capabilities')).body;assert.equal(caps.writable,false);assert.ok(!caps.allowed_actions.includes('memory.create'));
 assert.ok(caps.allowed_actions.includes('security.sessions.revoke_others'));
 assert.equal((await x.act('memory.create',{scope:'user',content:'denied'})).status,403);
 assert.equal((await x.act('security.session.revoke',{session_id:x.ids.session(x.b.console.token,'console').digest})).status,404);
 assert.equal((await x.act('security.recovery_codes',await x.proof())).status,403);
 x.f.app.config.identity.console_basic_operations.security=false;
 assert.equal((await x.act('security.sessions.revoke_others')).status,403);
});
test('HTTP-CON-02: existing read-only accounts require explicit capability upgrade',async t=>{
 const x=await setup(t,{writable:false});assert.equal((await x.get('capabilities')).body.writable,false);
 assert.equal((await x.act('memory.create',{scope:'user',content:'denied'})).status,403);
 assert.equal((await x.get('accounts')).status,403);assert.equal((await x.act('invitations.issue',{count:1,ttl_minutes:1})).status,403);
 x.f.app.config.identity.console_operations=false;assert.equal((await x.act('security.sessions.revoke_others')).status,403);
});
test('HTTP-CON-03: operator invitations require fresh factors, mint unique one-time codes, and replay safely',async t=>{
 const x=await setup(t);x.ids.console.role(x.a.record.account_id,true);const operation=randomUUID(),p={count:3,ttl_minutes:7,...await x.proof()};
 const r=await x.act('invitations.issue',p,x.a,operation);assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(new Set(r.body.codes).size,3);assert.equal(r.body.codes[0].length,43);
 assert.deepEqual((await x.act('invitations.issue',p,x.a,operation)).body.codes,r.body.codes);
 const raw=JSON.stringify(x.ids.db.prepare('SELECT * FROM identity_console_operations').all());assert.ok(!raw.includes(r.body.codes[0]));
 assert.equal((await x.get('invitations',x.b)).status,403);
 const claim=x.ids.reserveInvitation(r.body.codes[0]);assert.ok(claim.token);assert.throws(()=>x.ids.reserveInvitation(r.body.codes[0]));
 const revoked=await x.act('invitations.revoke_batch',{batch_id:r.body.batch_id,...await x.proof(x.a,30)});assert.equal(revoked.status,200);assert.throws(()=>x.ids.reserveInvitation(r.body.codes[1]));
});
test('HTTP-CON-04: member cannot acquire operator role or inspect other accounts, last operator is protected',async t=>{
 const x=await setup(t);assert.equal((await x.act('accounts.role',{account_id:x.a.record.account_id,operator:true,...await x.proof()})).status,403);
 x.ids.console.role(x.a.record.account_id,true);
 const r=await x.act('accounts.role',{account_id:x.a.record.account_id,operator:false,...await x.proof()});assert.equal(r.status,409);assert.equal(r.body.error_code,'LAST_OPERATOR');
 const accounts=await x.get('accounts');assert.equal(accounts.status,200);assert.ok(!JSON.stringify(accounts.body).includes('password_json'));assert.ok(!JSON.stringify(accounts.body).includes('mfa_cipher'));
});
test('HTTP-CON-05: password change invalidates old sessions/OAuth without changing IDs, other accounts or standalone keys',async t=>{
 const x=await setup(t),Adapter=x.f.app.store.adapter();await new (Adapter)('Grant').upsert('synthetic-password-grant',{accountId:x.a.record.subject,clientId:x.f.config.chatgpt_client.client_id},600);
 const before=x.a.record.user_id;const r=await x.act('security.password',{new_password:'New synthetic password with spaces',password_confirm:'New synthetic password with spaces',...await x.proof()});
 assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.login_required,true);
 assert.equal((await x.get('me')).status,401);assert.equal((await x.get('me',x.b)).status,200);assert.equal(x.ids.byId(x.a.record.account_id).user_id,before);
 assert.equal(x.f.app.store.find('Grant','id','synthetic-password-grant'),undefined);
 const otp=await generate({secret:x.a.setup.secret,epoch:seconds()+30});
 assert.equal(await x.ids.authenticate(x.a.name,'Synthetic password with spaces  ',otp),null);
 assert.equal(await x.ids.authenticate(x.a.name,'New synthetic password with spaces',otp),x.a.record.subject);
});
test('HTTP-CON-06: TOTP replacement requires both old factors and a new-code proof bound to the original session',async t=>{
 const x=await setup(t);const started=await x.act('security.totp.begin',await x.proof());assert.equal(started.status,200,JSON.stringify(started.body));assert.match(started.body.qr_svg,/<svg/);
 assert.equal((await x.act('security.totp.complete',{enrollment_id:started.body.enrollment_id,new_otp:'000000'},x.b)).status,409);
 const otp=await generate({secret:started.body.secret});const r=await x.act('security.totp.complete',{enrollment_id:started.body.enrollment_id,new_otp:otp});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.login_required,true);
 assert.equal((await x.get('me')).status,401);assert.equal((await x.get('me',x.b)).status,200);
 assert.equal(x.ids.unseal(x.ids.byId(x.a.record.account_id).mfa_cipher,x.a.record.account_id,'totp'),started.body.secret);
});
test('HTTP-CON-07: recovery-code rotation invalidates old codes and never exposes another account’s material',async t=>{
 const x=await setup(t),old=x.ids.byId(x.a.record.account_id).recovery_hashes,before=x.ids.byId(x.b.record.account_id).recovery_hashes;
 const r=await x.act('security.recovery_codes',await x.proof());assert.equal(r.status,200);assert.equal(r.body.codes.length,8);
 assert.notEqual(x.ids.byId(x.a.record.account_id).recovery_hashes,old);assert.equal(x.ids.byId(x.b.record.account_id).recovery_hashes,before);
 assert.ok(!JSON.stringify((await x.get('security')).body).includes(r.body.codes[0]));
});
test('HTTP-CON-08: revoke sessions and grants by exact owner; arbitrary IDs do not revoke foreign state',async t=>{
 const x=await setup(t),other=x.ids.newSession('console',{accountId:x.a.record.account_id}),session=x.ids.session(other.token,'console');
 const bSession=x.ids.session(x.b.console.token,'console');assert.equal((await x.act('security.session.revoke',{session_id:bSession.digest})).status,404);
 assert.equal((await x.act('security.session.revoke',{session_id:session.digest})).status,200);assert.throws(()=>x.ids.session(other.token,'console'));
 const Adapter=x.f.app.store.adapter();for(const o of [x.a,x.b])await new (Adapter)('Grant').upsert(o.record.account_id,{accountId:o.record.subject,clientId:x.f.config.chatgpt_client.client_id},600);
 assert.equal((await x.act('oauth.revoke',{grant_id:x.b.record.account_id})).status,404);
 assert.equal((await x.act('oauth.revoke',{grant_id:x.a.record.account_id})).status,200);assert.ok(x.f.app.store.find('Grant','id',x.b.record.account_id));
});
test('HTTP-CON-09: operator account suspension revokes Core credentials and reenabling creates new isolated bindings',async t=>{
 const x=await setup(t,{maintenance:true});x.ids.console.role(x.a.record.account_id,true);const old=x.ids.bindings(x.b.record.subject),token=fs.readFileSync(old.find(b=>b.purpose==='web').credential_file,'utf8').trim();
 const r=await x.act('accounts.disable',{account_id:x.b.record.account_id,...await x.proof()});assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.status,'disabled');
 assert.throws(()=>x.core.store.authenticate(token));assert.equal((await x.get('me',x.b)).status,401);assert.equal((await x.get('me')).status,200);
 const enabled=await x.act('accounts.enable',{account_id:x.b.record.account_id,...await x.proof(x.a,30)});assert.equal(enabled.status,200,JSON.stringify(enabled.body));assert.equal(enabled.body.status,'active');
 assert.notEqual(x.ids.bindings(x.b.record.subject).find(b=>b.purpose==='web').credential_id,old.find(b=>b.purpose==='web').credential_id);
 assert.throws(()=>x.core.store.authenticate(token));
});
test('HTTP-CON-09-CLI: with the web Accounts page removed, the operator CLI disables and re-enables a member the same way',async t=>{
 const x=await setup(t,{maintenance:true});x.ids.console.role(x.a.record.account_id,true);const file=path.join(x.f.directory,'operator-accounts.json');writePrivate(file,x.f.config);
 const old=x.ids.bindings(x.b.record.subject),token=fs.readFileSync(old.find(b=>b.purpose==='web').credential_file,'utf8').trim();
 const run=async(command,account)=>{const lines=[],log=console.log;console.log=v=>lines.push(v);try{await operatorCommand([command,'--config',file,'--account-id',account,'--confirm','--isolated-fixture']);}finally{console.log=log;}return JSON.parse(lines.at(-1));};
 await assert.rejects(operatorCommand(['disable-account','--config',file,'--account-id',x.b.record.account_id,'--isolated-fixture']),'explicit confirmation is required');
 assert.equal((await run('disable-account',x.b.record.account_id)).status,'disabled');
 assert.equal(x.ids.byId(x.b.record.account_id).status,'disabled');assert.throws(()=>x.core.store.authenticate(token));assert.equal((await x.get('me',x.b)).status,401);assert.equal((await x.get('me')).status,200);
 assert.equal((await run('enable-account',x.b.record.account_id)).status,'active');
 assert.notEqual(x.ids.bindings(x.b.record.subject).find(b=>b.purpose==='web').credential_id,old.find(b=>b.purpose==='web').credential_id);assert.throws(()=>x.core.store.authenticate(token));
 // The last active operator stays protected, as on the web.
 await assert.rejects(run('disable-account',x.a.record.account_id),e=>e.code==='LAST_OPERATOR'||/LAST_OPERATOR/.test(String(e.errorCode||e.message)));
 assert.equal(x.ids.byId(x.a.record.account_id).status,'active');
 assert.equal(x.ids.db.prepare("SELECT COUNT(*) n FROM identity_audit WHERE account_id=? AND action='account.disabled'").get(x.b.record.account_id).n,1);
});
test('HTTP-CON-10: configured web recovery uses restricted session, both proofs, revocation and reprovisioning',async t=>{
 const x=await setup(t,{maintenance:true,recovery:true}),browser=new Browser(x.f.config.issuer),page=await browser.request('/recover'),csrf=page.text.match(/name="csrf" value="([^"]+)"/)[1];
 const oldBinding=x.ids.bindings(x.a.record.subject).find(b=>b.purpose==='web'),oldToken=fs.readFileSync(oldBinding.credential_file,'utf8').trim();
 const started=await browser.post('/recover/start',{csrf,action:'password',username:x.a.name,password:'',otp:await generate({secret:x.a.setup.secret}),recovery_code:x.a.codes[0]});assert.equal(started.status,303,started.text);
 assert.equal((await browser.request('/console-api/me')).status,401);const next=await browser.request('/recover/complete'),form=next.text.match(/name="csrf" value="([^"]+)"/)[1];
 const done=await browser.post('/recover/complete',{csrf:form,password:'Recovered synthetic password',password_confirm:'Recovered synthetic password'});assert.equal(done.status,303,done.text);
 assert.equal(x.ids.byId(x.a.record.account_id).status,'active');assert.throws(()=>x.core.store.authenticate(oldToken));assert.equal((await x.get('me',x.b)).status,200);
});
test('HTTP-CON-11: CLI writer upgrade validates exact account binding and does not widen ChatGPT scope',async t=>{
 const x=await setup(t,{writable:false}),configFile=path.join(x.f.directory,'operator-config.json');writePrivate(configFile,x.f.config);const old=x.ids.bindings(x.a.record.subject),web=old.find(b=>b.purpose==='web');
 const before=x.core.store.db.prepare('SELECT scopes_json FROM credentials WHERE credential_id=?').get(web.credential_id).scopes_json;
 await operatorCommand(['enable-console','--config',configFile,'--account-id',x.a.record.account_id,'--core-database',x.core.databasePath,'--confirm','--isolated-fixture']);
 assert.equal((await x.get('capabilities')).body.writable,true);assert.equal(x.core.store.db.prepare('SELECT scopes_json FROM credentials WHERE credential_id=?').get(web.credential_id).scopes_json,before);
 const binding=old.find(b=>b.purpose==='console');assert.deepEqual(x.core.store.authenticate(fs.readFileSync(binding.credential_file,'utf8').trim()).scopes,CONSOLE_WRITE_SCOPES);
});

test('HTTP-CON-12: operator authority is rechecked after awaited password/TOTP proof',async t=>{
 const x=await setup(t,{maintenance:true});x.ids.console.role(x.a.record.account_id,true);x.ids.console.role(x.b.record.account_id,true);
 const authenticate=x.ids.authenticate.bind(x.ids);
 x.ids.authenticate=async(...args)=>{const subject=await authenticate(...args);x.ids.console.role(x.a.record.account_id,false);return subject;};
 const r=await x.act('accounts.disable',{account_id:x.b.record.account_id,...await x.proof()});
 assert.equal(r.status,403);assert.equal(r.body.error_code,'OPERATOR_REQUIRED');
 assert.equal(x.ids.byId(x.b.record.account_id).status,'active');
 assert.equal(x.core.store.db.prepare('SELECT COUNT(*) n FROM credentials WHERE user_id=? AND revoked_at IS NOT NULL').get(x.b.record.user_id).n,0);
});

test('HTTP-BASIC-03: idempotent basic-only upgrade preserves account IDs, Web keys, and unrelated accounts',async t=>{
 const x=await setup(t,{writable:false,basic:{memory:true,security:true,oauth:true}}),file=path.join(x.f.directory,'basic-operator.json');writePrivate(file,x.f.config);
 const before=x.core.store.db.prepare('SELECT * FROM credentials ORDER BY credential_id').all();
 const consoleId=x.ids.bindings(x.a.record.subject).find(b=>b.purpose==='console').credential_id;
 const args=['enable-console-basic','--config',file,'--account-id',x.a.record.account_id,'--core-database',x.core.databasePath,'--confirm','--isolated-fixture'];
 await operatorCommand(args);await operatorCommand(args);
 const after=x.core.store.db.prepare('SELECT * FROM credentials ORDER BY credential_id').all();
 assert.equal(after.length,before.length);
 for(let i=0;i<after.length;i++)assert.deepEqual({...after[i],scopes_json:before[i].scopes_json,last_used_at:before[i].last_used_at},{...before[i]});
 for(const row of after)if(row.credential_id!==consoleId)assert.deepEqual(row,before.find(b=>b.credential_id===row.credential_id));
 assert.deepEqual(JSON.parse(after.find(r=>r.credential_id===consoleId).scopes_json),['memory:read','resume:read','console:read','memory:write','memory:organize']);
 const caps=(await x.get('capabilities')).body;assert.equal(caps.writable,true);assert.ok(!caps.actions.includes('models.save'));
 assert.equal((await x.act('memory.create',{scope:'user',content:'Synthetic narrow BFF memory'})).status,200);
 assert.equal((await x.act('memory.create',{scope:'user',content:'No foreign upgrade'},x.b)).status,403);
 assert.equal((await x.act('models.save',{})).status,403);assert.equal((await x.get('export')).status,404);
});

const managementOnly={invitations:true,accounts:true,roles:false};
test('HTTP-MGMT-01: scoped operator management does not require or grant general console writes',async t=>{
 const x=await setup(t,{writable:false,management:managementOnly});x.ids.console.role(x.a.record.account_id,true);
 const caps=(await x.get('capabilities')).body;
 assert.deepEqual(caps.management,managementOnly);assert.equal(caps.enabled,false);assert.equal(caps.writable,false);
 assert.equal(caps.account_id,x.a.record.account_id);assert.equal(caps.invitation_batch_limit,10);
 assert.equal((await x.get('accounts')).status,200);assert.equal((await x.get('invitations')).status,200);
 for(const action of ['memory.create','jobs.schedule','models.save','security.password','security.totp.begin','security.recovery_codes','accounts.role']){
   const r=await x.act(action,{});assert.equal(r.status,403,action);assert.equal(r.body.error_code,'BLOCKED_POLICY');
 }
 assert.equal((await x.get('export')).status,404);
 const operation=randomUUID(),payload={count:2,ttl_minutes:7,...await x.proof()};
 const issued=await x.act('invitations.issue',payload,x.a,operation);assert.equal(issued.status,200,JSON.stringify(issued.body));
 assert.equal(issued.body.codes.length,2);assert.deepEqual((await x.act('invitations.issue',payload,x.a,operation)).body.codes,issued.body.codes);
 const inventory=await x.get('invitations');assert.equal(inventory.status,200);assert.ok(!JSON.stringify(inventory.body).includes(issued.body.codes[0]));
 assert.equal((await x.get('accounts',x.b)).status,403);assert.equal((await x.get('invitations',x.b)).status,403);
 assert.equal((await x.act('invitations.issue',payload,x.b)).status,403);
 assert.equal((await x.act('invitations.issue',payload,x.a,randomUUID(),{account_id:x.b.record.account_id})).status,409);
 assert.equal((await x.act('invitations.issue',payload,x.a,randomUUID(),{csrf:'bad'})).status,401);
 x.f.app.config.identity.console_management.invitations=false;
 assert.equal((await x.act('invitations.issue',payload,x.a,operation)).status,403,'disabled policy must also block secret replay');
 assert.equal(x.core.store.db.prepare('SELECT COUNT(*) n FROM memories').get().n,0);
});
test('HTTP-MGMT-02: explicit management policy overrides legacy role access even when other operations are enabled',async t=>{
 const x=await setup(t,{management:managementOnly});x.ids.console.role(x.a.record.account_id,true);
 x.f.app.config.identity.console_operations=true;
 const r=await x.act('accounts.role',{account_id:x.b.record.account_id,operator:true,...await x.proof()});
 assert.equal(r.status,403);assert.equal(r.body.error_code,'BLOCKED_POLICY');assert.equal(x.ids.console.operator(x.b.record.account_id),false);
 x.f.app.config.identity.console_management.accounts=false;
 assert.equal((await x.get('accounts')).status,403);
 assert.equal((await x.act('accounts.disable',{account_id:x.b.record.account_id})).status,403);
});
test('HTTP-MGMT-03: scoped disable/enable preserves ownership and recreates only readonly account bindings',async t=>{
 const x=await setup(t,{maintenance:true,writable:false,management:managementOnly});x.ids.console.role(x.a.record.account_id,true);
 const before=x.ids.byId(x.b.record.account_id),old=x.ids.bindings(before.subject);
 const disabled=await x.act('accounts.disable',{account_id:before.account_id,...await x.proof()});
 assert.equal(disabled.status,200,JSON.stringify(disabled.body));assert.equal(disabled.body.status,'disabled');
 assert.equal((await x.get('me',x.b)).status,401);assert.equal((await x.get('me')).status,200);
 const enabled=await x.act('accounts.enable',{account_id:before.account_id,...await x.proof(x.a,30)});
 assert.equal(enabled.status,200,JSON.stringify(enabled.body));assert.equal(enabled.body.status,'active');
 const after=x.ids.byId(before.account_id);assert.equal(after.subject,before.subject);assert.equal(after.user_id,before.user_id);
 for(const binding of x.ids.bindings(before.subject)){
   assert.ok(!old.some(v=>v.credential_id===binding.credential_id));
   const auth=x.core.store.authenticate(fs.readFileSync(binding.credential_file,'utf8').trim());
   assert.ok(auth.scopes.every(s=>!s.endsWith(':write')&&!s.endsWith(':organize')));
 }
});
test('HTTP-DEVICES-01: agent keys are revoked only with fresh factors, only for the owner, never for managed keys',async t=>{
 const x=await setup(t,{basic:{memory:true,security:true,oauth:true}});
 assert.ok((await x.get('capabilities')).body.allowed_actions.includes('devices.revoke'));
 const issue=(owner,agentId,instance,scopes=['memory:read','capture:write'])=>x.core.store.issueCredential({userId:owner.record.user_id,deviceId:'synthetic-device',agentId,agentInstanceId:instance,scopes});
 const laptop=issue(x.a,'openclaw','synthetic-http-openclaw'),gateway=issue(x.a,'chatgpt-web','synthetic-http-gateway',['memory:read','resume:read']),foreign=issue(x.b,'hermes','synthetic-http-foreign');
 const listed=(await x.get('connections')).body,row=id=>listed.core_connections.find(c=>c.agent_instance_id===id);
 assert.equal(row('synthetic-http-openclaw').console_revocable,true);assert.equal(row('synthetic-http-gateway').managed,true);
 assert.equal(row('synthetic-http-foreign'),undefined);
 assert.deepEqual(listed.system_chatgpt,{configured:true,last_token_at:null,write_enabled:false});
 const target={agent_instance_id:'synthetic-http-openclaw'};
 assert.notEqual((await x.act('devices.revoke',target)).status,200);
 assert.notEqual((await x.act('devices.revoke',{...target,current_password:'Synthetic password with spaces  ',otp:'000000'})).status,200);
 assert.equal((await x.act('devices.revoke',{...target,...await x.proof(),note:'extra'})).status,400);
 assert.ok(x.core.store.authenticate(laptop.api_key),'failed attempts never reach Core');
 const revoked=await x.act('devices.revoke',{...target,...await x.proof()});
 assert.equal(revoked.status,200,JSON.stringify(revoked.body));assert.equal(revoked.body.status,'revoked');
 assert.throws(()=>x.core.store.authenticate(laptop.api_key));
 const managed=await x.act('devices.revoke',{agent_instance_id:'synthetic-http-gateway',...await x.proof(x.a,30)});
 assert.equal(managed.status,409);assert.equal(managed.body.error_code,'MANAGED_CONNECTION');assert.ok(x.core.store.authenticate(gateway.api_key));
 const cross=await x.act('devices.revoke',{agent_instance_id:'synthetic-http-foreign',...await x.proof(x.b)},x.b);
 assert.equal(cross.status,200,'B revokes its own device');
 assert.equal((await x.act('devices.revoke',{agent_instance_id:'synthetic-http-gateway',...await x.proof(x.b,30)},x.b)).body.error_code,'CREDENTIAL_NOT_FOUND');
 assert.ok(x.core.store.authenticate(gateway.api_key),'another account cannot reach A keys');assert.throws(()=>x.core.store.authenticate(foreign.api_key));
});
test('HTTP-CONNECTIONS-02: a ChatGPT connection names its exact callback at creation and is ready once bound',async t=>{
 const x=await setup(t,{connections:true,basic:{memory:false,security:true,oauth:true}});
 const base={kind:'chatgpt_oauth',label:'Synthetic ChatGPT plugin',profile:'readonly'},callback='https://chatgpt.com/connector_platform_oauth_redirect';
 const created=await x.act('connections.create',{...base,redirect_uri:callback,...await x.proof()});
 assert.equal(created.status,200,JSON.stringify(created.body));assert.equal(created.body.secret_kind,'oauth_client_secret');assert.ok(created.body.secret);
 const c=created.body.connection;assert.equal(c.redirect_uri,callback);assert.match(c.client_id,/^mnmc_/);assert.equal(c.provisioning,true);
 const row=x.ids.connections.row(x.a.record.account_id,c.connection_id);assert.equal(row.state,'ready');assert.equal(row.callback,callback);
 assert.equal((await x.act('connections.create',{...base,redirect_uri:'https://evil.example/callback',...await x.proof(x.a,30)})).body.error_code,'INVALID_CALLBACK');
 assert.equal((await x.act('connections.create',{kind:'generic_mcp',label:'Synthetic token',profile:'readonly',redirect_uri:callback,...await x.proof(x.b)},x.b)).status,400);
 const draft=await x.act('connections.create',{...base,label:'Synthetic draft',...await x.proof(x.b,30)},x.b);
 assert.equal(draft.status,200);assert.equal(x.ids.connections.row(x.b.record.account_id,draft.body.connection.connection_id).state,'draft');
});
test('HTTP-LIFECYCLE-01: project delete, restore and merge confirms need fresh password + OTP; factors never reach Core; previews do not',async t=>{
 const x=await setup(t),store=x.core.store,user=x.a.record.user_id;
 const admin=store.authenticate(store.issueCredential({userId:user,deviceId:'synthetic-lifecycle',agentId:'synthetic',agentInstanceId:'synthetic-lifecycle-admin',scopes:['admin:tasks','memory:write']}).api_key);
 for(const [id,name] of [['http-life-a','Synthetic Life A'],['http-life-b','Synthetic Life B']])store.upsertProject(admin,{project_id:id,name});
 const allowed=(await x.get('capabilities')).body.allowed_actions;
 for(const action of ['projects.lifecycle_preview','projects.lifecycle_delete','projects.lifecycle_restore','projects.merge'])assert.ok(allowed.includes(action),action);
 // Every payload Core receives is recorded: the factors must never be among its keys.
 const seen=[],execute=store.consoleService.execute.bind(store.consoleService);
 store.consoleService.execute=(auth,input)=>{seen.push({action:input.action,keys:Object.keys(input.payload||{}).sort()});return execute(auth,input);};
 t.after(()=>{store.consoleService.execute=execute;});
 const preview=async(payload)=>{const r=await x.act('projects.lifecycle_preview',payload);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
 let p=await preview({action:'delete',project_id:'http-life-a'});
 const confirm={preview_id:p.preview_id,confirm_name:'Synthetic Life A'};
 assert.notEqual((await x.act('projects.lifecycle_delete',confirm)).status,200,'no factors');
 assert.notEqual((await x.act('projects.lifecycle_delete',{...confirm,current_password:'Synthetic password with spaces  ',otp:'000000'})).status,200,'wrong OTP');
 assert.equal((await x.act('projects.lifecycle_delete',{...confirm,...await x.proof(),note:'extra'})).status,400,'unknown fields');
 assert.equal(store.lifecycle.projectState(user,'http-life-a'),'live','failed attempts never reach Core');
 assert.ok(!seen.some(s=>s.action==='projects.lifecycle_delete'));
 const deleted=await x.act('projects.lifecycle_delete',{...confirm,...await x.proof()});
 assert.equal(deleted.status,200,JSON.stringify(deleted.body));assert.equal(deleted.body.status,'deleted');
 p=await preview({action:'restore',project_id:'http-life-a'});
 const restored=await x.act('projects.lifecycle_restore',{preview_id:p.preview_id,...await x.proof(x.a,30)});
 assert.equal(restored.status,200,JSON.stringify(restored.body));assert.equal(restored.body.status,'restored');
 // The real limits stay in force: 5 re-authentications per account per 15 minutes (failures included) and no OTP may
 // be older than one already used. So the merge is confirmed by the second account, on its own projects.
 const userB=x.b.record.user_id,adminB=store.authenticate(store.issueCredential({userId:userB,deviceId:'synthetic-lifecycle-b',agentId:'synthetic',agentInstanceId:'synthetic-lifecycle-admin-b',scopes:['admin:tasks','memory:write']}).api_key);
 for(const [id,name] of [['http-life-c','Synthetic Life C'],['http-life-d','Synthetic Life D']])store.upsertProject(adminB,{project_id:id,name});
 const mp=await x.act('projects.lifecycle_preview',{action:'merge',project_id:'http-life-c',target_project_id:'http-life-d'},x.b);assert.equal(mp.status,200,JSON.stringify(mp.body));
 assert.notEqual((await x.act('projects.merge',{preview_id:mp.body.preview_id},x.b)).status,200,'no factors');
 const merged=await x.act('projects.merge',{preview_id:mp.body.preview_id,...await x.proof(x.b)},x.b);
 assert.equal(merged.status,200,JSON.stringify(merged.body));assert.equal(merged.body.status,'merged');
 assert.equal(store.lifecycle.resolve(userB,'http-life-c').canonical_project_id,'http-life-d');
 for(const s of seen)assert.ok(!s.keys.includes('current_password')&&!s.keys.includes('otp'),`${s.action} reached Core without factors`);
 assert.deepEqual(seen.filter(s=>s.action!=='projects.lifecycle_preview').map(s=>[s.action,s.keys]),
   [['projects.lifecycle_delete',['confirm_name','preview_id']],['projects.lifecycle_restore',['preview_id']],['projects.merge',['preview_id']]]);
 // Another account cannot preview (or learn of) A's projects.
 const foreign=await x.act('projects.lifecycle_preview',{action:'delete',project_id:'http-life-b'},x.b);
 assert.equal(foreign.body.error_code,'PROJECT_NOT_FOUND');
});
test('HTTP-LIFECYCLE-02: basic Console policy and read-only Console credentials cannot reach lifecycle actions',async t=>{
 const basic=await setup(t,{basic:{memory:true,security:true,oauth:true}});
 const allowed=(await basic.get('capabilities')).body.allowed_actions;
 for(const action of ['projects.lifecycle_preview','projects.lifecycle_delete','projects.lifecycle_restore','projects.merge']){
   assert.ok(!allowed.includes(action),action);
   const r=await basic.act(action,{preview_id:'00000000-0000-4000-8000-000000000000',...await basic.proof()});
   assert.equal(r.status,403,`${action}: ${JSON.stringify(r.body)}`);
 }
 // A read-only Console credential with a well-formed request: refused for lack of write authority, not for its input.
 const readonly=await setup(t,{writable:false});
 const r=await readonly.act('projects.lifecycle_preview',{action:'delete',project_id:'synthetic-any-project'});
 assert.equal(r.status,403,JSON.stringify(r.body));assert.equal(r.body.error_code,'CONSOLE_UPGRADE_REQUIRED');
});
test('HTTP-LIFECYCLE-03: a stale preview is reported before the factors are checked (no attempt or OTP consumed); a revoked session cannot confirm',async t=>{
 const x=await setup(t),store=x.core.store,user=x.a.record.user_id;
 const admin=store.authenticate(store.issueCredential({userId:user,deviceId:'synthetic-lifecycle-3',agentId:'synthetic',agentInstanceId:'synthetic-lifecycle-admin-3',scopes:['admin:tasks','memory:write']}).api_key);
 for(const [id,name] of [['http-stale','Synthetic Stale'],['http-stale-other','Synthetic Stale Other']])store.upsertProject(admin,{project_id:id,name});
 const stale=await x.act('projects.lifecycle_preview',{action:'delete',project_id:'http-stale'});assert.equal(stale.status,200);
 store.saveMemory(admin,{scope:'project',project_id:'http-stale-other',content:'Synthetic unrelated write after the preview'});
 const factors=await x.proof();
 const refused=await x.act('projects.lifecycle_delete',{preview_id:stale.body.preview_id,confirm_name:'Synthetic Stale',...factors});
 assert.deepEqual([refused.status,refused.body.error_code],[409,'PREVIEW_CHANGED']);
 // The same factors still work: the stale attempt never reached re-authentication. A typo in the typed name is
 // also answered before the factors are checked.
 const fresh=await x.act('projects.lifecycle_preview',{action:'delete',project_id:'http-stale'});
 const typo=await x.act('projects.lifecycle_delete',{preview_id:fresh.body.preview_id,confirm_name:'Synthetic Stal',...factors});
 assert.deepEqual([typo.status,typo.body.error_code],[409,'CONFIRMATION_MISMATCH']);
 const done=await x.act('projects.lifecycle_delete',{preview_id:fresh.body.preview_id,confirm_name:'Synthetic Stale',...factors});
 assert.equal(done.status,200,JSON.stringify(done.body));assert.equal(done.body.status,'deleted');
 // A revoked Console session cannot confirm, even with valid factors.
 const restore=await x.act('projects.lifecycle_preview',{action:'restore',project_id:'http-stale'});assert.equal(restore.status,200);
 const me=await x.get('me');x.ids.db.prepare("DELETE FROM identity_sessions WHERE account_id=? AND purpose='console'").run(x.a.record.account_id);
 const r=await x.a.browser.post('/console-api/action',{csrf:me.body.csrf,account_id:x.a.record.account_id,action:'projects.lifecycle_restore',operation_id:randomUUID(),payload:JSON.stringify({preview_id:restore.body.preview_id,...await x.proof(x.a,30)})});
 assert.equal(r.status,401);assert.equal(store.lifecycle.projectState(user,'http-stale'),'deleted');
});

test('HTTP-AUDIT: exact streams and current connection mappings are owner scoped, with independent paging',async t=>{
 const x=await setup(t,{connections:true});
 const issued=await x.act('connections.create',{kind:'generic_mcp',label:'Synthetic original name',profile:'readonly',...await x.proof()});assert.equal(issued.status,200,JSON.stringify(issued.body));
 const id=issued.body.connection.connection_id,credential=x.core.issue(x.a.record.user_id,'synthetic-audit-instance'),foreign=x.core.issue(x.b.record.user_id,'synthetic-foreign-audit');
 x.ids.db.prepare('INSERT INTO identity_connection_credentials VALUES(?,?,?,?,?,?)').run(credential.auth.credential_id,x.a.record.account_id,id,1,x.a.record.security_version,1);
 x.ids.db.prepare('UPDATE identity_connections SET label=? WHERE connection_id=?').run('Synthetic current name',id);
 x.core.store.audit({auth:credential.auth,action:'memory.read',targetType:'memory',targetId:'synthetic-target'});
 x.core.store.audit({auth:foreign.auth,action:'memory.read',targetType:'memory',targetId:'synthetic-foreign-target'});
 const core=await x.get('audit?source=core&action=memory.read&limit=1');assert.equal(core.status,200);assert.equal(core.body.entries.length,1);assert.equal(core.body.source,'core');assert.equal(core.body.core_entries,undefined);
 const c=core.body.credentials[credential.auth.credential_id];assert.equal(c.agent_instance_id,'synthetic-audit-instance');assert.equal(c.connection.connection_id,id);assert.equal(c.connection.label,'Synthetic current name');assert.equal(c.connection.credential_revoked,true);
 assert.doesNotMatch(JSON.stringify(core.body),/synthetic-foreign|key_hash|secret_cipher|api_key|PRIVATE/);
 const other=await x.get('audit?source=core&action=memory.read',x.b);assert.equal(other.body.entries.length,1);assert.equal(other.body.credentials[foreign.auth.credential_id].connection.type,'unmapped');
 for(let n=0;n<4;n++)x.ids.audit(x.a.record.account_id,'synthetic.audit.page');x.ids.audit(x.b.record.account_id,'synthetic.audit.page');
 const first=await x.get('audit?source=identity&action=synthetic.audit.page&limit=2'),second=await x.get('audit?source=identity&action=synthetic.audit.page&limit=2&offset=2');
 assert.equal(first.body.source,'identity');assert.equal(first.body.next_offset,2);assert.equal(second.body.next_offset,null);assert.equal(new Set([...first.body.entries,...second.body.entries].map(e=>e.audit_id)).size,4);assert.equal(first.body.credentials,undefined);
 assert.deepEqual((await x.get('audit?source=core&action=synthetic.audit.page')).body.entries,[]);assert.equal((await x.get('audit?source=all')).status,400);
});


test('HTTP-AUDIT: revoking a session while a Core audit read is pending rejects its late private reply',async t=>{
 const x=await setup(t),{ConsoleCore}=await import('../src/console-core.mjs'),original=ConsoleCore.prototype.view;
 let release,started;const gate=new Promise(resolve=>release=resolve),began=new Promise(resolve=>started=resolve);
 ConsoleCore.prototype.view=async function(view,...args){const data=await original.call(this,view,...args);if(view==='audit'){started();await gate;}return data;};
 t.after(()=>{ConsoleCore.prototype.view=original;release();});
 const pending=x.get('audit?source=core');await began;x.ids.revokeSession(x.a.console.token);release();
 const result=await pending;assert.equal(result.status,401);assert.equal(result.body.entries,undefined);assert.equal(result.body.credentials,undefined);
});

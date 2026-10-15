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

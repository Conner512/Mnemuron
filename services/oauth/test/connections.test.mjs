import test from 'node:test';
import assert from 'node:assert/strict';
import {generate} from 'otplib';
import {identityFixture,pendingAccount} from './helpers/identity-fixture.mjs';
import {seconds} from '../../../shared/oauth-common.mjs';
import {ConnectionRegistry,validateConnectionPolicy,exactChatgptCallback} from '../src/connections.mjs';

export const policy={enabled:true,max_connections:20,pat_default_ttl_seconds:2592000,pat_max_ttl_seconds:7776000,secret_receipt_ttl_seconds:300,rotation_overlap_seconds:0};
export async function accountFixture(t){
 const f=identityFixture(t),ids=f.identities;
 const a=await pendingAccount(f,'Synthetic_Connection_A'),b=await pendingAccount(f,'Synthetic_Connection_B');
 for(const x of [a,b])ids.db.prepare("UPDATE identity_accounts SET status='active',binding_ready=1,recovery_ack=1 WHERE account_id=?").run(x.account.account_id);
 const config={issuer:ids.issuer,resource:'http://127.0.0.1:49002/mcp',isolated:true,identity:{connection_management:policy},cloud_memory:{enabled:true,allow_submitted_revision_grant:true}};
 const registry=new ConnectionRegistry(ids,config);ids.connections=registry;
 for(const x of [a,b]){x.id=x.account.account_id;x.sessionToken=ids.newSession('console',{accountId:x.id});x.session=ids.session(x.sessionToken.token,'console');}
 const execute=async(x,action,p,op)=>{
   // Each independent synthetic request uses a fresh step, never a production MFA bypass.
   ids.db.prepare('DELETE FROM oauth_mfa_steps WHERE subject=?').run(ids.byId(x.id).subject);
   return registry.execute(x.id,x.session,action,{...p,current_password:'Synthetic password with spaces  ',otp:await generate({secret:x.setup.secret})},op);
 };
 return {...f,a,b,config,registry,execute};
}
test('B-01: bounded policies, exact callback family and draft credentials fail closed',async t=>{
 assert.throws(()=>validateConnectionPolicy({enabled:true}));
 assert.throws(()=>validateConnectionPolicy({...policy,rotation_overlap_seconds:1}));
 for(const callback of ['https://chatgpt.com.evil.test/connector_platform_oauth_redirect','https://chatgpt.com/connector_platform_oauth_redirect#fragment','https://chatgpt.com/connector_platform_oauth_redirect?next=x','https://chatgpt.com:443/connector_platform_oauth_redirect','https://chatgpt.com/%63onnector_platform_oauth_redirect'])assert.throws(()=>exactChatgptCallback(callback));
 assert.equal(exactChatgptCallback('https://chatgpt.com/connector_platform_oauth_redirect'),'https://chatgpt.com/connector_platform_oauth_redirect');
 const x=await accountFixture(t),r=await x.execute(x.a,'connections.create',{kind:'chatgpt_oauth',label:'Synthetic ChatGPT',profile:'readonly'},'create-chatgpt');
 assert.equal(r.connection.configuration_state,'draft');assert.ok(r.secret);assert.equal(x.registry.client(r.connection.client_id),undefined);
 assert.equal(x.registry.list(x.b.id,{}).total,0);assert.throws(()=>x.registry.detail(x.b.id,r.connection.connection_id),{code:'CONNECTION_NOT_FOUND'});
 const publicResult=JSON.stringify(x.registry.detail(x.a.id,r.connection.connection_id));assert.ok(!publicResult.includes(r.secret));assert.ok(!publicResult.includes('secret_cipher'));
 const db=x.store.db.prepare('SELECT secret_cipher FROM identity_connections WHERE connection_id=?').get(r.connection.connection_id);assert.ok(!db.secret_cipher.includes(r.secret));
});
test('B-02: idempotent same-login secret recovery is bounded, owner checked before replay, no plaintext lists',async t=>{
 const x=await accountFixture(t),p={kind:'generic_mcp',label:'Synthetic MCP',profile:'memory_readwrite',allow_submitted_revision_grant:true};
 const first=await x.execute(x.a,'connections.create',p,'operation-one'),again=await x.execute(x.a,'connections.create',p,'operation-one');
 assert.equal(again.secret,first.secret);assert.equal(x.registry.list(x.a.id,{}).total,1);
 await assert.rejects(x.execute(x.a,'connections.create',{...p,label:'different'},'operation-one'),{code:'IDEMPOTENCY_CONFLICT'});
 const session=x.identities.newSession('console',{accountId:x.a.id});
 await assert.rejects(x.registry.execute(x.a.id,x.identities.session(session.token,'console'),'connections.create',p,'operation-one'),{code:'SECRET_SESSION_MISMATCH'});
 x.store.db.prepare('UPDATE identity_connection_operations SET secret_expires=?').run(seconds()-1);
 const expired=await x.execute(x.a,'connections.create',p,'operation-one');assert.equal(expired.secret,undefined);assert.equal(expired.secret_expired,true);
 assert.ok(!JSON.stringify(x.registry.list(x.a.id,{})).includes(first.secret));
});
test('B-03: PAT is owner, resource, current-version and expiry bound; rotation and revoke do not affect another connection',async t=>{
 const x=await accountFixture(t),p={kind:'generic_mcp',label:'Synthetic MCP',profile:'readonly'};
 const a=await x.execute(x.a,'connections.create',p,'create-one'),b=await x.execute(x.b,'connections.create',p,'create-two');
 for(const r of [a,b])x.store.db.prepare("UPDATE identity_connections SET binding_version=version,binding_account_version=1,binding_json='{}' WHERE connection_id=?").run(r.connection.connection_id);
 const resource=x.config.resource+'/generic';assert.equal(x.registry.verifyPat(a.secret,resource).account_id,x.a.id);
 assert.equal(x.registry.verifyPat(a.secret,x.config.resource).active,false);
 assert.equal(x.registry.verifyPat('mnm_'+a.secret,resource).active,false);
 const next=await x.execute(x.a,'connections.rotate',{connection_id:a.connection.connection_id},'rotate-one');
 assert.equal(x.registry.verifyPat(a.secret,resource).active,false);
 x.store.db.prepare('UPDATE identity_connections SET binding_version=version WHERE connection_id=?').run(a.connection.connection_id);
 assert.equal(x.registry.verifyPat(next.secret,resource).active,true);assert.equal(x.registry.verifyPat(b.secret,resource).active,true);
 await x.execute(x.a,'connections.revoke',{connection_id:a.connection.connection_id},'revoke-one');assert.equal(x.registry.verifyPat(next.secret,resource).active,false);
 assert.equal(x.registry.verifyPat(b.secret,resource).active,true);
 x.store.db.prepare('UPDATE identity_connection_tokens SET expires=?').run(seconds()-1);assert.equal(x.registry.verifyPat(b.secret,resource).active,false);
});

test('B-22: concurrent idempotency, quotas, paging, expiry counts, fresh proof and revoked secret cleanup',async t=>{
 const x=await accountFixture(t),p={kind:'generic_mcp',label:'Synthetic shared name',profile:'readonly'};
 const proof={...p,current_password:'Synthetic password with spaces  ',otp:await generate({secret:x.a.setup.secret})};
 const outcomes=await Promise.allSettled([x.registry.execute(x.a.id,x.a.session,'connections.create',proof,'concurrent'),x.registry.execute(x.a.id,x.a.session,'connections.create',proof,'concurrent')]);
 assert.ok(outcomes.some(o=>o.status==='fulfilled'));assert.equal(x.registry.list(x.a.id).total,1);
 const first=outcomes.find(o=>o.status==='fulfilled').value;
 await assert.rejects(x.execute(x.b,'connections.rotate',{connection_id:first.connection.connection_id},'other-owner'),{code:'CONNECTION_NOT_FOUND'});
 await x.execute(x.a,'connections.create',{...p,label:'Synthetic second'},'second');
 x.config.identity.connection_management={...policy,max_connections:2};
 await assert.rejects(x.execute(x.a,'connections.create',p,'third'),{code:'CONNECTION_QUOTA'});
 const list=x.registry.list(x.a.id,{limit:'1'});assert.equal(list.total,2);assert.equal(list.next_offset,1);assert.equal(x.registry.list(x.a.id,{limit:1,offset:1}).next_offset,null);
 assert.equal(x.registry.list(x.a.id,{search:'shared'}).total,1);
 assert.throws(()=>x.registry.list(x.a.id,{account_id:x.b.id}));assert.throws(()=>x.registry.list(x.a.id,{limit:500}));
 await x.execute(x.a,'connections.revoke',{connection_id:first.connection.connection_id},'revoke');
 const replay=await x.execute(x.a,'connections.create',p,'concurrent');assert.equal(replay.secret,undefined);assert.equal(replay.connection.configuration_state,'revoked');
 x.store.db.prepare('UPDATE identity_connection_tokens SET expires=?').run(seconds()-1);
 assert.equal(x.registry.list(x.a.id,{section:'active'}).total,0);assert.equal(x.registry.list(x.a.id,{section:'history'}).total,2);assert.equal(x.registry.list(x.a.id).counts.active,0);
});

test('B/C: pending bindings filter as draft; metadata and guides contain no recoverable credentials',async t=>{
 const x=await accountFixture(t),r=await x.execute(x.a,'connections.create',{kind:'generic_mcp',label:'Synthetic pending binding',profile:'readonly'},'pending');
 assert.equal(x.registry.list(x.a.id,{state:'draft'}).total,1);
 assert.equal(x.registry.list(x.a.id,{state:'ready'}).total,0);
 let d=x.registry.detail(x.a.id,r.connection.connection_id);
 assert.equal(d.connection.has_secret,true);assert.equal(d.guide.resource,x.config.resource+'/generic');
 assert.ok(d.guide.tools.includes('mnemuron_get_memory'));assert.ok(!d.guide.tools.includes('mnemuron_save_memory'));
 assert.equal(d.guide.timeout_seconds,30);assert.ok(!JSON.stringify(d).includes(r.secret));
 x.store.db.prepare("UPDATE identity_connections SET binding_version=version,binding_account_version=1,binding_json='{}' WHERE connection_id=?").run(r.connection.connection_id);
 assert.equal(x.registry.list(x.a.id,{state:'ready'}).total,1);
 const claims=x.registry.verifyPat(r.secret,x.config.resource+'/generic');x.registry.markTool(claims);
 assert.equal(x.registry.detail(x.a.id,r.connection.connection_id).connection.health,'verified');
 x.registry.markTool(claims,{failed:true});d=x.registry.detail(x.a.id,r.connection.connection_id);
 assert.equal(d.connection.health,'degraded');assert.equal(d.connection.last_error_code,'TOOL_FAILED');assert.ok(d.connection.last_successful_tool_at);
 x.store.db.prepare('UPDATE identity_accounts SET security_version=security_version+1 WHERE account_id=?').run(x.a.id);
 assert.equal(x.registry.list(x.a.id,{state:'draft'}).total,1);
 assert.equal(x.registry.list(x.a.id).counts.pending,1);
 assert.equal(x.registry.verifyPat(r.secret,x.config.resource+'/generic').active,false);
});

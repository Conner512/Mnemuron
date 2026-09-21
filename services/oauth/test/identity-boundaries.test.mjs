import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {generate} from 'otplib';
import {identityFixture} from './helpers/identity-fixture.mjs';
import {seconds,secretHash} from '../../../shared/oauth-common.mjs';
import {fixture} from './fixture.mjs';
import {createAuthorizationServer} from '../src/server.mjs';

async function prepared(f,name='Synthetic_A') {
 const issued=f.identities.issueInvitations({count:1,ttlMinutes:10,issuer:'synthetic-operator'});
 const session=f.identities.reserveInvitation(issued.codes[0]);
 await f.identities.prepareRegistration(session.token,name,'Synthetic password with spaces  ');
 return {issued,session,setup:f.identities.enrollment(session.token)};
}
function finishInProcess(f,session,otp) {
 const script=`import {AuthStore} from ${JSON.stringify(new URL('../src/sqlite-adapter.mjs',import.meta.url).href)};
 import {IdentityRepository} from ${JSON.stringify(new URL('../src/identity-repository.mjs',import.meta.url).href)};
 let input='';for await(const chunk of process.stdin)input+=chunk;const p=JSON.parse(input);
 const store=new AuthStore(p.file,{identity:true});try {
 const ids=new IdentityRepository(store,{keyFile:p.keyFile,issuer:p.issuer,batchLimit:10,sessionTtl:3600});
 console.log(JSON.stringify(await ids.verifyEnrollment(p.token,p.otp)));
 } catch(e){console.log(JSON.stringify({error:e.code||'REFUSED'}));} finally{store.close();}`;
 return new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe']});let out='';
   child.stdout.on('data',c=>out+=c);child.on('error',reject);
   child.on('close',code=>code===0?resolve(JSON.parse(out)):reject(new Error('Synthetic child failed')));
   child.stdin.end(JSON.stringify({file:path.join(f.directory,'oauth.sqlite3'),keyFile:f.keyFile,issuer:f.identities.issuer,token:session.token,otp}));
 });
}

test('INV-08/14: concurrent processes and lost completion response consume once and return the same account',async t=>{
 const f=identityFixture(t),p=await prepared(f),otp=await generate({secret:p.setup.secret,epoch:seconds()-30});
 const replies=await Promise.all([finishInProcess(f,p.session,otp),finishInProcess(f,p.session,otp)]);
 assert.ok(replies.every(r=>r.account_id===replies[0].account_id && r.status==='provisioning'),JSON.stringify(replies));
 const retry=await f.identities.verifyEnrollment(p.session.token,otp);
 assert.equal(retry.account_id,replies[0].account_id);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM identity_accounts').get().n,1);
 assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_audit WHERE action='registration.mfa_verified'").get().n,1);
 assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM identity_invitations WHERE state='consumed'").get().n,1);
 const codes=f.identities.takeRecoveryCodes(p.session.token);assert.equal(codes.length,8);
 assert.throws(()=>f.identities.takeRecoveryCodes(p.session.token));
});
test('INV-10/11: commit rechecks expiry and an abandoned unverified reservation can be reclaimed without inheriting identity',async t=>{
 const f=identityFixture(t),p=await prepared(f),otp=await generate({secret:p.setup.secret,epoch:seconds()-30});
 const pending=f.identities.verifyEnrollment(p.session.token,otp);
 f.store.db.prepare("UPDATE identity_invitations SET reserved_until=? WHERE digest=?").run(seconds()-1,secretHash(p.issued.codes[0]));
 await assert.rejects(pending);
 assert.equal(f.identities.eligible(p.setup.subject),false);
 const replacement=f.identities.reserveInvitation(p.issued.codes[0]);
 await f.identities.prepareRegistration(replacement.token,'Synthetic_A','Another synthetic password');
 const next=f.identities.enrollment(replacement.token);
 assert.notEqual(next.subject,p.setup.subject);assert.notEqual(next.secret,p.setup.secret);
 assert.equal(f.identities.account(p.setup.subject).status,'registration_expired');
 assert.throws(()=>f.identities.registrationState(p.session.token));
});
test('MFA-04..06/10: local enrollment display is one-time and pending accounts cannot exchange factors',async t=>{
 const f=identityFixture(t),a=await prepared(f),b=await prepared(f,'Synthetic_B');
 assert.equal(f.identities.enrollment(a.session.token).already_shown,true);
 for(const token of ['000000',await generate({secret:a.setup.secret,epoch:seconds()-120}),await generate({secret:b.setup.secret})])
   await assert.rejects(()=>f.identities.verifyEnrollment(a.session.token,token));
 const result=await f.identities.verifyEnrollment(a.session.token,await generate({secret:a.setup.secret,epoch:seconds()-30}));
 assert.equal(result.status,'provisioning');assert.throws(()=>f.identities.enrollment(a.session.token));
 assert.equal(f.identities.account(b.setup.subject).mfa_verified,0);
});
test('INV-13/15 MFA-12: duplicate normalized username, disabled role input, revoked batch and immutable consumed history',async t=>{
 const f=identityFixture(t),a=await prepared(f);
 const issue=f.identities.issueInvitations({count:2,ttlMinutes:1,issuer:'synthetic-operator'}),b=f.identities.reserveInvitation(issue.codes[0]);
 await assert.rejects(()=>f.identities.prepareRegistration(b.token,'synthetic_a','Synthetic password with spaces  '));
 await assert.rejects(()=>f.identities.prepareRegistration(b.token,'模拟用户','Synthetic password with spaces  '));
 await assert.rejects(()=>f.identities.prepareRegistration(b.token,'Synthetic_B','too short'));
 await f.identities.verifyEnrollment(a.session.token,await generate({secret:a.setup.secret,epoch:seconds()-30}));
 assert.equal(f.identities.revokeBatch(a.issued.batch_id),0);
 assert.equal(f.identities.revokeBatch(issue.batch_id),2);
 assert.throws(()=>f.identities.reserveInvitation(issue.codes[1]));
 assert.equal(f.identities.registrationState(a.session.token).status,'provisioning');
});
test('multi-account startup rejects an in-worktree encryption key before opening its database',async t=>{
 const f=await fixture(t,{start:false});
 f.config.identity_mode='multi_account_v1';
 f.config.database_file=path.join(f.directory,'unopened-identity.sqlite3');
 f.config.identity={encryption_key_file:path.resolve('never-created-identity-key')};
 assert.throws(()=>createAuthorizationServer(f.config,{isolated:true}),{errorCode:'PRIVATE_PATH_IN_SOURCE'});
 assert.equal(fs.existsSync(f.config.database_file),false);
 assert.equal(fs.existsSync(f.config.database_file+'.process-lock'),false);
});

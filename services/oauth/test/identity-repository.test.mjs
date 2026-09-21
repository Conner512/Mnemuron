import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generate} from 'otplib';
import {AuthStore} from '../src/sqlite-adapter.mjs';
import {IdentityRepository} from '../src/identity-repository.mjs';
import {Accounts,createOwner} from '../src/accounts.mjs';
import {randomSecret,writePrivate,readPrivate,seconds} from '../../../shared/oauth-common.mjs';

import {identityFixture,pendingAccount} from './helpers/identity-fixture.mjs';

test('INV-01..06: strict TTL/count validation and metadata-only invitations',t=>{
 const f=identityFixture(t);
 for(const ttl of [0,-1,1441,1.5,NaN,Infinity]) assert.throws(()=>f.identities.issueInvitations({count:1,ttlMinutes:ttl,issuer:'test'}));
 for(const count of [0,-1,1.5,11]) assert.throws(()=>f.identities.issueInvitations({count,ttlMinutes:1,issuer:'test'}));
 assert.equal(f.identities.listInvitations().length,0);
 const a=f.identities.issueInvitations({count:10,ttlMinutes:1,issuer:'test'});
 const b=f.identities.issueInvitations({count:1,ttlMinutes:1440,issuer:'test'});
 assert.equal(new Set([...a.codes,...b.codes]).size,11);
 assert.ok(a.codes.every(c=>/^[A-Za-z0-9_-]{43}$/.test(c)));
 const dump=JSON.stringify(f.identities.listInvitations());assert.ok(a.codes.every(c=>!dump.includes(c)));
 assert.equal(f.identities.listInvitations()[0].expires-f.identities.listInvitations()[0].created,60);
});
test('INV-09..13, MFA-02..05: pending MFA, reservation ownership, replay and expiry',async t=>{
 const f=identityFixture(t);const r=f.identities.issueInvitations({count:2,ttlMinutes:1,issuer:'test'});
 const s=f.identities.reserveInvitation(r.codes[0]);assert.throws(()=>f.identities.reserveInvitation(r.codes[0]));
 await f.identities.prepareRegistration(s.token,'Synthetic_A','Synthetic password with spaces  ');
 const setup=f.identities.enrollment(s.token);assert.equal(f.identities.eligible(setup.subject),false);
 assert.equal(await f.identities.authenticate('Synthetic_A','Synthetic password with spaces  ','000000'),null);
 await assert.rejects(()=>f.identities.verifyEnrollment('wrong-session','123456'));
 f.store.db.prepare('UPDATE identity_invitations SET expires=?').run(seconds()-1);
 await assert.rejects(()=>f.identities.verifyEnrollment(s.token,generate({secret:setup.secret})));
 assert.equal(f.identities.eligible(setup.subject),false);
 assert.throws(()=>f.identities.reserveInvitation(r.codes[1]));
});
test('MFA-07..12, INV-14: encrypted secrets, pending provisioning and recovery acknowledgement',async t=>{
 const f=identityFixture(t);const {session,setup,account}=await pendingAccount(f);
 assert.equal(account.status,'provisioning');assert.equal(f.identities.eligible(setup.subject),false);
 const row=f.store.db.prepare('SELECT * FROM identity_accounts').get();
 assert.ok(!JSON.stringify(row).includes(setup.secret));assert.ok(!JSON.stringify(row).includes('Synthetic password'));
 assert.throws(()=>f.identities.enrollment(session.token));
 const codes=f.identities.takeRecoveryCodes(session.token);assert.equal(codes.length,8);
 assert.throws(()=>f.identities.takeRecoveryCodes(session.token));
 f.identities.acknowledgeRecovery(session.token);
 assert.equal(f.identities.registrationState(session.token).status,'provisioning');
 assert.equal(f.identities.registrationState(session.token).account_id,account.account_id);
});
test('BASE-03..06: repeatable legacy migration preserves subject, hashes and Core binding',async t=>{
 const f=identityFixture(t);const file=path.join(f.directory,'legacy.json');
 await createOwner(file,'Legacy_Name','Synthetic legacy password');const owner=readPrivate(file,{json:true});
 owner.mfa.verified=true;writePrivate(file,owner,{replace:true});
 const mapping={issuer:f.identities.issuer,subject:owner.subject,mnemuron_user_id:'existing-user',agent_instance_id:'existing-web',enabled:true};
 const first=f.identities.importLegacy(owner,mapping);
 const again=f.identities.importLegacy(owner,mapping);assert.equal(first.account_id,again.account_id);
 const row=f.identities.account(owner.subject);assert.equal(row.user_id,'existing-user');assert.equal(row.subject,owner.subject);
 assert.deepEqual(JSON.parse(row.password_json),owner.password);assert.equal(f.identities.eligible(owner.subject),false);
 assert.throws(()=>f.identities.importLegacy({...owner,subject:randomSecret()},mapping));
 assert.throws(()=>new AuthStore(path.join(f.directory,'oauth.sqlite3')));
});
test('ISO-13: revoking A does not erase B browser sessions or CSRF',t=>{
 const f=identityFixture(t);
 for(const subject of ['account-A','account-B']) {
 f.store.db.prepare('INSERT INTO oauth_records(model,id,payload,expires) VALUES(?,?,?,?)').run('Session',subject,JSON.stringify({accountId:subject}),seconds()+100);
 f.store.csrf(subject,100);
 }
 f.store.revoke({subject:'account-A'});
 assert.ok(f.store.find('Session','id','account-B'));
 assert.equal(f.store.find('Session','id','account-A'),undefined);
 assert.ok(f.store.db.prepare('SELECT 1 FROM oauth_csrf WHERE uid=?').get('account-B'));
});

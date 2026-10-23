import test from 'node:test';
import assert from 'node:assert/strict';
import {generate} from 'otplib';
import path from 'node:path';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {provisionIdentities} from '../src/provisioning.mjs';
import {identityFixture,pendingAccount} from './helpers/identity-fixture.mjs';
import {RecoveryService} from '../src/recovery.mjs';
import {readPrivate,seconds} from '../../../shared/oauth-common.mjs';
test('REC-01..04 REC-07..08: missing proof policy denies; synthetic approved proofs issue restricted one-use recovery',async t=>{
 const f=identityFixture(t),core=await memoryFixture(t),a=await pendingAccount(f),codes=f.identities.takeRecoveryCodes(a.session.token);
 f.identities.acknowledgeRecovery(a.session.token);
 const options={credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json')};
 provisionIdentities(f.identities,core.store,options);
 const defaultRecovery=new RecoveryService(f.identities);
 await assert.rejects(()=>defaultRecovery.begin({username:'Synthetic_A',action:'password',recoveryCode:codes[0]}),e=>e.code==='BLOCKED_POLICY');
 const recovery=new RecoveryService(f.identities,{policy:{password:['totp','recovery_code'],totp:['password','recovery_code']}});
 const token=await recovery.begin({username:'Synthetic_A',action:'password',otp:await generate({secret:a.setup.secret}),recoveryCode:codes[0]});
 assert.throws(()=>f.identities.session(token.token,'console'));
 await assert.rejects(()=>recovery.begin({username:'Synthetic_B',action:'password',otp:'000000',recoveryCode:codes[0]}));
 await assert.rejects(async()=>recovery.begin({username:'Synthetic_A',action:'password',otp:await generate({secret:a.setup.secret}),recoveryCode:codes[0]}));
 assert.throws(()=>f.identities.registrationState(a.session.token));
 const revokeCore=async({user_id,credential_ids})=>{
   for(const id of credential_ids)core.store.db.prepare('UPDATE credentials SET revoked_at=? WHERE user_id=? AND credential_id=?').run(new Date().toISOString(),user_id,id);
   return true;
 };
 await assert.rejects(()=>recovery.complete(token.token,{password:'Synthetic changed password'},{revokeCore:async()=>{throw new Error('synthetic unavailable');}}));
 assert.equal(f.identities.byId(a.account.account_id).status,'recovery_pending');
 const result=await recovery.complete(token.token,{password:'Synthetic changed password'},{revokeCore});
 assert.equal(result.login_required,true);assert.equal(result.status,'provisioning');
 provisionIdentities(f.identities,core.store,options);
 assert.equal(f.identities.byId(a.account.account_id).status,'active');
});
test('REC-02..10: synthetic TOTP recovery is owner-bound, atomic, revokes only A and requires fresh login',async t=>{
 const f=identityFixture(t),core=await memoryFixture(t),ids=f.identities,owners=[];
 for(const name of ['Synthetic_Recovery_A','Synthetic_Recovery_B']){const a=await pendingAccount(f,name),codes=ids.takeRecoveryCodes(a.session.token);ids.acknowledgeRecovery(a.session.token);owners.push({...a,name,codes});}
 const options={credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json')};provisionIdentities(ids,core.store,options);
 f.store.identity=ids;
 const [a,b]=owners;
 for(const owner of owners){owner.row=ids.byId(owner.account.account_id);owner.console=ids.newSession('console',{accountId:owner.row.account_id});
  const Adapter=f.store.adapter();await new Adapter('AccessToken').upsert(owner.name,{accountId:owner.row.subject},300);
  await new Adapter('RefreshToken').upsert(owner.name,{accountId:owner.row.subject},300);}
 const aKey=readPrivate(ids.bindings(a.row.subject)[0].credential_file),bKey=readPrivate(ids.bindings(b.row.subject)[0].credential_file);
 const recovery=new RecoveryService(ids,{policy:{password:['totp','recovery_code'],totp:['password','recovery_code']}});
 await assert.rejects(()=>recovery.begin({username:b.name,action:'totp',password:'Synthetic password with spaces  ',recoveryCode:a.codes[0]}));
 const outcomes=await Promise.allSettled([0,1].map(()=>recovery.begin({username:a.name,action:'totp',password:'Synthetic password with spaces  ',recoveryCode:a.codes[0]})));
 assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);const token=outcomes.find(r=>r.status==='fulfilled').value;
 assert.throws(()=>ids.session(a.console.token,'console'));assert.ok(ids.session(b.console.token,'console'));
 for(const model of ['AccessToken','RefreshToken']){assert.equal(f.store.find(model,'id',a.name),undefined);assert.ok(f.store.find(model,'id',b.name));}
 const next=recovery.enrollment(token.token);
 const revokeCore=async({user_id,credential_ids})=>{for(const id of credential_ids)core.store.db.prepare('UPDATE credentials SET revoked_at=? WHERE user_id=? AND credential_id=?').run(new Date().toISOString(),user_id,id);return true;};
 const result=await recovery.complete(token.token,{otp:await generate({secret:next.secret,epoch:seconds()})},{revokeCore});
 assert.equal(result.login_required,true);assert.throws(()=>ids.session(token.token,'console'));
 assert.throws(()=>core.store.authenticate(aKey));assert.ok(core.store.authenticate(bKey));
 provisionIdentities(ids,core.store,options);assert.equal(ids.byId(a.row.account_id).user_id,a.row.user_id);assert.equal(ids.byId(a.row.account_id).subject,a.row.subject);
 assert.equal(await ids.authenticate(a.name,'Synthetic password with spaces  ',await generate({secret:a.setup.secret})),null);
 const audit=JSON.stringify(f.store.db.prepare('SELECT * FROM identity_audit').all());
 assert.ok(![aKey,bKey,next.secret,...a.codes].some(secret=>audit.includes(secret)));
});

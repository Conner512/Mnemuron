import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {identityFixture,pendingAccount} from './helpers/identity-fixture.mjs';
import {AuthStore} from '../src/sqlite-adapter.mjs';
import {IdentityRepository} from '../src/identity-repository.mjs';
import {IdentityMaintenance} from '../src/identity-maintenance.mjs';

// Two independently opened SQLite connections model concurrent operator commands. External-worker mode keeps
// these fixtures local to the identity database: no Core credentials, real accounts or worker processes are used.
async function operators(t){
  const f=identityFixture(t),ids=f.identities,accounts=[];
  for(const name of ['Synthetic_Operator_A','Synthetic_Operator_B']){
    const a=await pendingAccount(f,name);ids.takeRecoveryCodes(a.session.token);ids.acknowledgeRecovery(a.session.token);
    ids.db.prepare("UPDATE identity_accounts SET status='active',binding_ready=1 WHERE account_id=?").run(a.account.account_id);
    ids.console.role(a.account.account_id,true);accounts.push(a.account.account_id);
  }
  const peerStore=new AuthStore(path.join(f.directory,'oauth.sqlite3'),{identity:true});t.after(()=>peerStore.close());
  const peer=new IdentityRepository(peerStore,{keyFile:f.keyFile,issuer:ids.issuer,batchLimit:10,sessionTtl:3600});
  const config={identity:{provisioning:{enabled:true,mode:'external_worker'}}};
  return {ids,peer,a:accounts[0],b:accounts[1],maintenance:new IdentityMaintenance(ids,config),peerMaintenance:new IdentityMaintenance(peer,config)};
}
const lastOperator=error=>error.code==='LAST_OPERATOR';
const activeOperators=ids=>ids.db.prepare("SELECT COUNT(*) n FROM identity_console_roles r JOIN identity_accounts a ON a.account_id=r.account_id WHERE a.status='active'").get().n;

// Force the competing command to commit after the first command's preflight/read but before its write lock.
// This makes the old check-then-mutate race deterministic rather than relying on process scheduling or sleeps.
function beforeNextTransaction(store,competing){
  const transaction=store.transaction.bind(store);
  store.transaction=callback=>{store.transaction=transaction;competing();return transaction(callback);};
}

test('operator disable/disable race: the second mutation cannot disable the last active operator',async t=>{
  const x=await operators(t),session=x.ids.newSession('console',{accountId:x.a});
  x.ids.console.protectLastOperator(x.a);x.peer.console.protectLastOperator(x.b); // Both preflights passed.
  let winner;
  beforeNextTransaction(x.ids.store,()=>{winner=x.peerMaintenance.setState(x.b,'disable');});
  await assert.rejects(x.maintenance.setState(x.a,'disable'),lastOperator);
  assert.equal((await winner).status,'revocation_pending');
  assert.equal(activeOperators(x.ids),1);assert.equal(x.ids.byId(x.a).status,'active');assert.equal(x.ids.byId(x.b).status,'disabled');
  assert.equal(x.ids.session(session.token,'console').account_id,x.a,'rejected disable preserves the last operator session');
  assert.equal(x.ids.db.prepare("SELECT COUNT(*) n FROM identity_audit WHERE account_id=? AND action='account.disabled'").get(x.a).n,0);
  assert.equal(x.ids.db.prepare("SELECT COUNT(*) n FROM identity_operations WHERE account_id=? AND kind LIKE 'console-disable:%'").get(x.a).n,0);
});

test('operator disable/revoke race: a role revocation winning the lock blocks the final account disable',async t=>{
  const x=await operators(t);
  x.ids.console.protectLastOperator(x.a);x.peer.console.protectLastOperator(x.b);
  beforeNextTransaction(x.ids.store,()=>x.peer.store.transaction(()=>x.peer.console.role(x.b,false)));
  await assert.rejects(x.maintenance.setState(x.a,'disable'),lastOperator);
  assert.equal(activeOperators(x.ids),1);assert.equal(x.ids.byId(x.a).status,'active');assert.equal(x.ids.console.operator(x.b),false);
});

test('operator revoke/disable race: a disable winning the lock blocks the final role revocation',async t=>{
  const x=await operators(t);let winner;
  beforeNextTransaction(x.ids.store,()=>{winner=x.peerMaintenance.setState(x.b,'disable');});
  assert.throws(()=>x.ids.store.transaction(()=>x.ids.console.role(x.a,false)),lastOperator);
  assert.equal((await winner).status,'revocation_pending');
  assert.equal(activeOperators(x.ids),1);assert.equal(x.ids.console.operator(x.a),true);assert.equal(x.ids.byId(x.a).status,'active');
});

test('operator disabled-account retry preserves the last active operator and does not increment security version again',async t=>{
  const x=await operators(t);
  assert.equal((await x.maintenance.setState(x.b,'disable')).status,'revocation_pending');
  const version=x.ids.byId(x.b).security_version;
  assert.equal((await x.maintenance.setState(x.b,'disable')).status,'revocation_pending');
  assert.equal(x.ids.byId(x.b).security_version,version);assert.equal(activeOperators(x.ids),1);
  await assert.rejects(x.maintenance.setState(x.a,'disable'),lastOperator);
});

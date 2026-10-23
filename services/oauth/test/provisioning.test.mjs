import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {AuthStore} from '../src/sqlite-adapter.mjs';
import {IdentityRepository} from '../src/identity-repository.mjs';
import {identityFixture,pendingAccount} from './helpers/identity-fixture.mjs';
import {provisionIdentities} from '../src/provisioning.mjs';
import {memoryFixture,businessSnapshot} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {readPrivate} from '../../../shared/oauth-common.mjs';
import {ReadonlyCoreClient} from '../../../adapters/chatgpt-web/src/core-client.mjs';

test('BASE-06 MFA-08..09: interrupted Core commit recovers same credential without data rewrites',async t=>{
 const f=identityFixture(t),core=await memoryFixture(t);const {session,account}=await pendingAccount(f);
 const before=businessSnapshot(core.store);f.identities.takeRecoveryCodes(session.token);f.identities.acknowledgeRecovery(session.token);
 const options={credentialDirectory:path.join(f.directory,'credentials'),identityMapFile:path.join(f.directory,'map.json')};
 assert.throws(()=>provisionIdentities(f.identities,core.store,{...options,afterCore:()=>{throw new Error('synthetic crash');}}));
 assert.equal(f.identities.registrationState(session.token).status,'provisioning');
 const ids=core.store.db.prepare('SELECT credential_id FROM credentials WHERE user_id=? ORDER BY credential_id').all(f.identities.byId(account.account_id).user_id);
 assert.equal(ids.length,2);provisionIdentities(f.identities,core.store,options);provisionIdentities(f.identities,core.store,options);
 assert.deepEqual(core.store.db.prepare('SELECT credential_id FROM credentials WHERE user_id=? ORDER BY credential_id').all(f.identities.byId(account.account_id).user_id),ids);
 assert.deepEqual(businessSnapshot(core.store),before);assert.equal(f.identities.registrationState(session.token).status,'active');
});
test('ISO-01..07 OAUTH-01: two provisioned owners use separate credentials under interleaved HTTP',async t=>{
 const f=identityFixture(t),core=await memoryFixture(t),accounts=[];
 for(const name of ['Synthetic_A','Synthetic_B']) {const a=await pendingAccount(f,name);f.identities.takeRecoveryCodes(a.session.token);f.identities.acknowledgeRecovery(a.session.token);accounts.push(a);}
 const options={credentialDirectory:path.join(f.directory,'credentials'),identityMapFile:path.join(f.directory,'map.json')};
 provisionIdentities(f.identities,core.store,options);const maps=readPrivate(options.identityMapFile,{json:true}).mappings;
 const memories=maps.map(m=>{const author=core.issue(m.mnemuron_user_id,'writer-'+m.account_id);
   const memory=core.store.saveMemory(author.auth,{scope:'user',content:'synthetic same query',operation_id:'same-operation'}).memory;
   const latest=core.store.revisions.latest(author.auth.user_id,memory.memory_id);core.store.webVisibility.set(author.auth,memory.memory_id,{allow:true,revision:latest.revision,state_hash:latest.state_hash});return memory;});
 const clients=maps.map(m=>new ReadonlyCoreClient({core:{base_url:core.baseUrl,credential_file:m.credential_file,timeout_ms:5000,max_response_bytes:262144}}));
 const results=await Promise.all(Array.from({length:20},(_,i)=>clients[i%2].call('mnemuron_search_memories',{query:'synthetic same query'},maps[i%2])));
 for(const [i,r] of results.entries())assert.deepEqual(r.results.map(m=>m.memory_id),[memories[i%2].memory_id]);
 await assert.rejects(()=>clients[0].call('mnemuron_get_memory',{memory_id:memories[1].memory_id},maps[0]),e=>e.code==='MEMORY_NOT_FOUND');
 await assert.rejects(()=>clients[0].checkIdentity(maps[1]),e=>e.code==='CORE_AUTH_UNAVAILABLE');
 assert.throws(()=>core.store.registerAgent(core.a.auth,{user_id:maps[0].mnemuron_user_id,device_id:'test',agent_id:'test',agent_instance_id:'test'}));
});
test('BASE-06: a terminated provisioning process resumes its persisted intent from a new repository instance',async t=>{
 const f=identityFixture(t),core=await memoryFixture(t),a=await pendingAccount(f);
 f.identities.takeRecoveryCodes(a.session.token);f.identities.acknowledgeRecovery(a.session.token);
 const options={credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json')};
 const script=`import {AuthStore} from ${JSON.stringify(new URL('../src/sqlite-adapter.mjs',import.meta.url).href)};
 import {IdentityRepository} from ${JSON.stringify(new URL('../src/identity-repository.mjs',import.meta.url).href)};
 import {provisionIdentities} from ${JSON.stringify(new URL('../src/provisioning.mjs',import.meta.url).href)};
 import {MnemuronStore} from ${JSON.stringify(new URL('../../../server/lib/store.mjs',import.meta.url).href)};
 let text='';for await(const c of process.stdin)text+=c;const p=JSON.parse(text);
 const store=new AuthStore(p.file,{identity:true}),ids=new IdentityRepository(store,{keyFile:p.keyFile,issuer:p.issuer,batchLimit:10,sessionTtl:3600});
 const core=new MnemuronStore(p.core);provisionIdentities(ids,core,{...p.options,afterCore:()=>process.exit(73)});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000,
  input:JSON.stringify({file:path.join(f.directory,'oauth.sqlite3'),keyFile:f.keyFile,issuer:f.identities.issuer,core:core.databasePath,options})});
 assert.equal(child.status,73,'controlled process termination after Core commit');
 const row=f.identities.byId(a.account.account_id);
 assert.equal(row.status,'provisioning');assert.equal(row.binding_ready,0);
 const credentials=core.store.db.prepare('SELECT credential_id FROM credentials WHERE user_id=? ORDER BY credential_id').all(row.user_id);
 assert.equal(credentials.length,2);
 const restarted=new AuthStore(path.join(f.directory,'oauth.sqlite3'),{identity:true});
 try {
  const ids=new IdentityRepository(restarted,{keyFile:f.keyFile,issuer:f.identities.issuer,batchLimit:10,sessionTtl:3600});
  assert.equal(provisionIdentities(ids,core.store,options).completed,1);
  assert.equal(ids.byId(a.account.account_id).status,'active');
  assert.equal(provisionIdentities(ids,core.store,options).completed,0);
 } finally {restarted.close();}
 assert.deepEqual(core.store.db.prepare('SELECT credential_id FROM credentials WHERE user_id=? ORDER BY credential_id').all(row.user_id),credentials);
});

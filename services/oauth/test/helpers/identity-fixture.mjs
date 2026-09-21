import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generate} from 'otplib';
import {AuthStore} from '../../src/sqlite-adapter.mjs';
import {IdentityRepository} from '../../src/identity-repository.mjs';
import {randomSecret,writePrivate,seconds} from '../../../../shared/oauth-common.mjs';
import {fixture} from '../fixture.mjs';
export function identityFixture(t) {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mnemuron-identity-test-'));fs.chmodSync(directory,0o700);
 const keyFile=path.join(directory,'key');writePrivate(keyFile,randomSecret());
 const store=new AuthStore(path.join(directory,'oauth.sqlite3'),{identity:true});
 const identities=new IdentityRepository(store,{keyFile,issuer:'http://127.0.0.1:49001',batchLimit:10,sessionTtl:3600});
 t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});return {directory,keyFile,store,identities};
}
export async function pendingAccount(f,name='Synthetic_A') {
 const [code]=f.identities.issueInvitations({count:1,ttlMinutes:10,issuer:'synthetic-operator'}).codes;
 const session=f.identities.reserveInvitation(code);
 await f.identities.prepareRegistration(session.token,name,'Synthetic password with spaces  ');
 const setup=f.identities.enrollment(session.token);
 await f.identities.verifyEnrollment(session.token,await generate({secret:setup.secret,epoch:seconds()-30}));
 return {session,setup,account:f.identities.registrationState(session.token)};
}
export async function consoleFixture(t,{core}={}) {
 const f=await fixture(t,{start:false,mutate:c=>{
   c.identity_mode='multi_account_v1';c.login.registration_enabled=true;
   c.identity={encryption_key_file:path.join(path.dirname(c.database_file),'identity-key'),invitation_batch_limit:10,console_session_ttl_seconds:3600,...(core?{core:{base_url:core.baseUrl}}:{})};
 }});
 writePrivate(f.config.identity.encryption_key_file,randomSecret());await f.start();return f;
}

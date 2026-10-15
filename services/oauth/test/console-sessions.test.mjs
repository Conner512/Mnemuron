// Console item 6: truthful session details. A new Console sign-in stores only coarse device/browser/OS families
// reported by the browser; sessions from before that stay unknown; the browser viewing the Security page never
// describes another session; no raw User-Agent, IP address or location is stored or returned. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {generate} from 'otplib';
import {Browser} from './fixture.mjs';
import {consoleFixture,identityFixture,pendingAccount} from './helpers/identity-fixture.mjs';
import {provisionIdentities} from '../src/provisioning.mjs';
import {IdentityMaintenance} from '../src/identity-maintenance.mjs';
import {clientSnapshot,storedClient} from '../src/session-client.mjs';
import {memoryFixture} from '../../../server/test/helpers/core-memory-fixture.mjs';
import {secretHash,randomSecret,seconds} from '../../../shared/oauth-common.mjs';

globalThis.document??={body:{dataset:{}},documentElement:{dataset:{},lang:'en'},querySelectorAll:()=>[],addEventListener:()=>{}};
const {actionPage}=await import('../../../web/console/actions.mjs');

const UA={
  chromeWindows:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edgeWindows:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  firefoxLinux:'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0',
  safariMac:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  safariIphone:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  chromeIphone:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1',
  firefoxIphone:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/142.0 Mobile/15E148 Safari/605.1.15',
  safariIpad:'Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  samsungPhone:'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  chromeAndroidTablet:'Mozilla/5.0 (Linux; Android 15; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  chromeOs:'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  operaMac:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0',
};

test('SES-01: the snapshot keeps three coarse families, honors browser precedence, and is unknown for anything doubtful',()=>{
  const cases=[[UA.chromeWindows,'desktop','chrome','windows'],[UA.edgeWindows,'desktop','edge','windows'],[UA.firefoxLinux,'desktop','firefox','linux'],
    [UA.safariMac,'desktop','safari','macos'],[UA.safariIphone,'mobile','safari','ios'],[UA.chromeIphone,'mobile','chrome','ios'],[UA.firefoxIphone,'mobile','firefox','ios'],
    [UA.safariIpad,'tablet','safari','ipados'],[UA.samsungPhone,'mobile','samsung','android'],[UA.chromeAndroidTablet,'tablet','chrome','android'],
    [UA.chromeOs,'desktop','chrome','chromeos'],[UA.operaMac,'desktop','opera','macos']];
  for(const [ua,device,browser,os] of cases)assert.deepEqual(clientSnapshot(ua),{device,browser,os},ua);
  const unknown={device:'unknown',browser:'unknown',os:'unknown'};
  for(const ua of [undefined,'',['array'],'x'.repeat(513),`${UA.chromeWindows}é`,'curl/8.9.1','SyntheticBot/1.0'])assert.deepEqual(clientSnapshot(ua),unknown,String(ua).slice(0,40));
  assert.deepEqual(clientSnapshot('Mozilla/5.0 (Windows NT 10.0) '+'x'.repeat(480)),{device:'desktop',browser:'unknown',os:'windows'},'a bounded string with an unknown browser keeps only what is recognized');
  // Stored values are re-validated: anything outside the enumerations reads back as not recorded.
  assert.deepEqual(storedClient({device:'desktop',browser:'Chrome 140.0.1',os:'windows'}),{...unknown,recorded:false});
  assert.deepEqual(storedClient(null),{...unknown,recorded:false});
});

class ClientBrowser extends Browser{
  constructor(origin,headers){super(origin);this.extra=headers;}
  request(target,options={}){return super.request(target,{...options,headers:{...this.extra,...options.headers}});}
}

test('SES-02: each session keeps its own sign-in snapshot; legacy sessions stay unknown; no UA, IP or location is stored or returned',async t=>{
  const core=await memoryFixture(t),f=await consoleFixture(t,{core,identity:{console_operations:true}}),ids=f.app.accounts;
  const a=await pendingAccount({identities:ids},'Synthetic_Sessions_A');ids.takeRecoveryCodes(a.session.token);ids.acknowledgeRecovery(a.session.token);
  provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json'),consoleOperations:true});
  const account=ids.byId(a.account.account_id);
  // A session that existed before snapshots were recorded (inserted the way the previous release did).
  const legacyDigest=secretHash(randomSecret());
  ids.db.prepare('INSERT INTO identity_sessions(digest,purpose,account_id,security_version,csrf_digest,expires,created) VALUES(?,?,?,?,?,?,?)').run(legacyDigest,'console',account.account_id,account.security_version,secretHash(randomSecret()),seconds()+3600,seconds()-60);
  // Spoofed forwarding and geography headers must have no effect on anything stored or shown.
  const spoof={'x-forwarded-for':'203.0.113.77','cf-ipcountry':'ZZ','x-real-ip':'198.51.100.9','cf-ipcity':'Synthetic City'};
  const signIn=async(ua,future=0)=>{const b=new ClientBrowser(f.config.issuer,{'user-agent':ua,...spoof}),form=await b.request('/login');
    const r=await b.post('/login',{csrf:form.text.match(/name="csrf" value="([^"]+)"/)[1],username:'Synthetic_Sessions_A',password:'Synthetic password with spaces  ',otp:await generate({secret:a.setup.secret,epoch:seconds()+future})});
    assert.equal(r.status,303);return b;};
  const desktop=await signIn(UA.edgeWindows);
  await new Promise(r=>setTimeout(r,1100));// distinct creation seconds keep the listing order deterministic
  const phone=await signIn(UA.safariIphone,30);// next time step: the first code is single-use
  // The phone reviews the sessions; the desktop session must still read as the desktop snapshot, not the phone.
  const view=JSON.parse((await phone.request('/console-api/security')).text);
  const rows=view.sessions;assert.equal(rows.length,3);
  const [newest,older,legacy]=rows;
  assert.deepEqual([newest.current,newest.device,newest.browser,newest.os,newest.client_recorded],[true,'mobile','safari','ios',true]);
  assert.deepEqual([older.current,older.device,older.browser,older.os,older.client_recorded],[false,'desktop','edge','windows',true]);
  assert.deepEqual([legacy.session_id,legacy.device,legacy.browser,legacy.os,legacy.client_recorded],[legacyDigest,'unknown','unknown','unknown',false],'a legacy session is never filled in from the current browser');
  const fromDesktop=JSON.parse((await desktop.request('/console-api/security')).text).sessions;
  assert.deepEqual(fromDesktop.map(s=>[s.device,s.browser,s.current]),[['mobile','safari',false],['desktop','edge',true],['unknown','unknown',false]],'the same stored snapshots from the other client');
  const serialized=JSON.stringify(view);
  for(const leak of ['203.0.113.77','198.51.100.9','ZZ','Synthetic City','Mozilla','iPhone OS','Edg/','location'])assert.ok(!serialized.includes(leak),`security view does not return ${leak}`);
  // Storage: only the enumerations; no raw User-Agent, IP or geography anywhere in the identity database.
  assert.deepEqual(ids.db.prepare('SELECT device,browser,os FROM identity_session_clients ORDER BY device').all().map(r=>({...r})),[{device:'desktop',browser:'edge',os:'windows'},{device:'mobile',browser:'safari',os:'ios'}]);
  for(const {name} of ids.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()){
    const dump=JSON.stringify(ids.db.prepare(`SELECT * FROM "${name}"`).all());
    for(const leak of ['Mozilla/5.0','203.0.113.77','198.51.100.9','Synthetic City'])assert.ok(!dump.includes(leak),`${name} stores no ${leak}`);
  }
  // Revoking a session removes its snapshot; revoking the others leaves only the current one.
  const me=JSON.parse((await phone.request('/console-api/me')).text);
  const act=(action,payload)=>phone.post('/console-api/action',{csrf:me.csrf,account_id:me.account_id,action,operation_id:crypto.randomUUID(),payload:JSON.stringify(payload)});
  const revoked=await act('security.session.revoke',{session_id:older.session_id});assert.equal(revoked.status,200,revoked.text);
  assert.equal(ids.db.prepare('SELECT COUNT(*) n FROM identity_session_clients WHERE digest=?').get(older.session_id).n,0);
  const me2=JSON.parse((await phone.request('/console-api/me')).text);
  assert.equal((await phone.post('/console-api/action',{csrf:me2.csrf,account_id:me2.account_id,action:'security.sessions.revoke_others',operation_id:crypto.randomUUID(),payload:'{}'})).status,200);
  assert.deepEqual(ids.db.prepare('SELECT device FROM identity_session_clients').all().map(r=>r.device),['mobile']);
  assert.equal((await desktop.request('/console-api/security')).status,401,'the revoked desktop session no longer works');
});

test('SES-03: the Security page shows readable families, marks legacy sessions unknown and states what is not collected',()=>{
  const caps={enabled:true,writable:true,allowed_actions:['security.session.revoke','security.sessions.revoke_others']};
  const html=actionPage('security',{account:{username:'s'},sessions:[
    {session_id:'s1',created:1,expires:2,current:true,device:'tablet',browser:'samsung',os:'android',client_recorded:true},
    {session_id:'s2',created:1,expires:2,current:false,device:'unknown',browser:'unknown',os:'unknown',client_recorded:false},
    {session_id:'s3',created:1,expires:2,current:false,device:'<b>',browser:'chrome',os:'windows',client_recorded:true}]},caps);
  assert.match(html,/data-i18n="device_tablet"[^]*data-i18n="browser_samsung"[^]*data-i18n="os_android"/);
  assert.match(html,/data-i18n="clientNotRecorded"/);assert.match(html,/data-i18n="sessionClientNote"/);
  assert.doesNotMatch(html,/<b>/,'unexpected values are escaped');
});

async function activeSynthetic(f,name){
  const a=await pendingAccount(f,name);f.identities.takeRecoveryCodes(a.session.token);f.identities.acknowledgeRecovery(a.session.token);
  f.identities.db.prepare("UPDATE identity_accounts SET status='active',binding_ready=1 WHERE account_id=?").run(a.account.account_id);
  return a;
}

test('SES-04: invalid stored families fail closed and expiry deletes snapshots without adding them to bootstrap sessions',async t=>{
  const f=identityFixture(t),ids=f.identities,a=await activeSynthetic(f,'Synthetic_Snapshot_Cleanup');
  const client={device:'desktop',browser:'firefox',os:'linux'};
  const valid=ids.newSession('console',{accountId:a.account.account_id,client}),bad=ids.newSession('console',{accountId:a.account.account_id,client});
  const login=ids.newSession('login',{client}),registration=ids.newSession('registration',{client});
  for(const bootstrap of [login,registration])assert.equal(ids.db.prepare('SELECT 1 FROM identity_session_clients WHERE digest=?').get(secretHash(bootstrap.token)),undefined);
  ids.db.prepare('UPDATE identity_session_clients SET browser=? WHERE digest=?').run('Chrome/140.0.0.0',secretHash(bad.token));
  const row=ids.console.sessions(a.account.account_id,secretHash(valid.token)).find(s=>s.session_id===secretHash(bad.token));
  assert.deepEqual([row.device,row.browser,row.os,row.client_recorded],['unknown','unknown','unknown',false]);
  ids.db.prepare('UPDATE identity_sessions SET expires=? WHERE digest=?').run(seconds()-1,secretHash(valid.token));
  f.store.cleanup();
  assert.equal(ids.db.prepare('SELECT 1 FROM identity_session_clients WHERE digest=?').get(secretHash(valid.token)),undefined);
  assert.equal(ids.db.prepare('SELECT COUNT(*) n FROM identity_session_clients').get().n,1,'only the expired session snapshot is deleted');
});

test('SES-05: password change and account disable delete only the affected account snapshots',async t=>{
  const f=identityFixture(t),ids=f.identities,a=await activeSynthetic(f,'Synthetic_Snapshot_Password'),b=await activeSynthetic(f,'Synthetic_Snapshot_Disable');
  const client={device:'mobile',browser:'safari',os:'ios'};
  const current=ids.newSession('console',{accountId:a.account.account_id,client});ids.newSession('console',{accountId:a.account.account_id,client});
  const other=ids.newSession('console',{accountId:b.account.account_id,client});
  const result=await ids.console.execute(a.account.account_id,ids.session(current.token,'console'),'security.password',{
    current_password:'Synthetic password with spaces  ',otp:await generate({secret:a.setup.secret}),
    new_password:'A different synthetic password',password_confirm:'A different synthetic password'
  },'synthetic-snapshot-password');
  assert.equal(result.login_required,true);assert.throws(()=>ids.session(current.token,'console'));
  assert.deepEqual(ids.db.prepare('SELECT digest FROM identity_session_clients').all().map(s=>s.digest),[secretHash(other.token)]);
  assert.equal(ids.session(other.token,'console').account_id,b.account.account_id,'another owner remains signed in');
  const maintenance=new IdentityMaintenance(ids,{identity:{provisioning:{enabled:true,mode:'external_worker'}}});
  assert.equal((await maintenance.setState(b.account.account_id,'disable')).status,'revocation_pending');
  assert.equal(ids.db.prepare('SELECT COUNT(*) n FROM identity_session_clients').get().n,0);assert.throws(()=>ids.session(other.token,'console'));
});

test('SES-06: new HTTP logins with empty or oversized browser headers store only an unknown snapshot',async t=>{
  const core=await memoryFixture(t),f=await consoleFixture(t,{core}),ids=f.app.accounts;
  for(const [suffix,ua] of [['Empty',''],['Oversized',UA.chromeWindows+'x'.repeat(513)]]){
    const name=`Synthetic_Unknown_${suffix}`,a=await pendingAccount({identities:ids},name);ids.takeRecoveryCodes(a.session.token);ids.acknowledgeRecovery(a.session.token);
    provisionIdentities(ids,core.store,{credentialDirectory:path.join(f.directory,'keys'),identityMapFile:path.join(f.directory,'map.json')});
    const browser=new ClientBrowser(f.config.issuer,{'user-agent':ua}),form=await browser.request('/login');
    const login=await browser.post('/login',{csrf:form.text.match(/name="csrf" value="([^"]+)"/)[1],username:name,password:'Synthetic password with spaces  ',otp:await generate({secret:a.setup.secret})});
    assert.equal(login.status,303,login.text);
    const view=JSON.parse((await browser.request('/console-api/security')).text);assert.equal(view.sessions.length,1);
    const row=view.sessions[0];assert.deepEqual([row.device,row.browser,row.os,row.client_recorded],['unknown','unknown','unknown',true]);
    assert.deepEqual({...ids.db.prepare('SELECT device,browser,os FROM identity_session_clients WHERE digest=?').get(row.session_id)},{device:'unknown',browser:'unknown',os:'unknown'});
  }
});

import {IdentityConsole} from './identity-console.mjs';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv,scrypt} from 'node:crypto';
import {promisify} from 'node:util';
import {generateSecret,generateURI,verify} from 'otplib';
import {BoundaryError,readSecret,randomSecret,secretHash,equalSecret,seconds,requireConfig} from '../../../shared/oauth-common.mjs';

const derive=promisify(scrypt);
const SCRYPT={N:65536,r:8,p:1,maxmem:128*1024*1024};
const denied=()=>new BoundaryError(400,'REGISTRATION_UNAVAILABLE');
export function usernameKey(value) {
  if(typeof value!=='string' || !/^[A-Za-z0-9_.@-]{1,100}$/.test(value)) throw new BoundaryError(400,'INVALID_USERNAME');
  // Preserve the legacy ASCII spelling; uniqueness is ASCII case insensitive.
  return value.toLowerCase();
}
export async function passwordRecord(value) {
  if(typeof value!=='string' || value.length<14 || value.length>1024) throw new BoundaryError(400,'INVALID_PASSWORD');
  const salt=randomSecret();const hash=(await derive(value,salt,64,SCRYPT)).toString('base64url');
  return {algorithm:'scrypt',salt,hash,N:SCRYPT.N,r:SCRYPT.r,p:SCRYPT.p};
}

export class IdentityRepository {
  constructor(store,{keyFile,issuer,batchLimit,sessionTtl}={}) {
    this.store=store;this.db=store.db;this.issuer=issuer;this.batchLimit=batchLimit;this.sessionTtl=sessionTtl;
    this.key=Buffer.from(readSecret(keyFile),'base64url');requireConfig(this.key.length===32,'identity encryption key');
    requireConfig(typeof issuer==='string' && new URL(issuer).origin===issuer,'identity issuer');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_accounts (
        account_id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL UNIQUE,
        username TEXT NOT NULL,username_key TEXT NOT NULL UNIQUE,password_json TEXT NOT NULL,mfa_cipher TEXT NOT NULL,
        mfa_verified INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,security_version INTEGER NOT NULL DEFAULT 1,
        recovery_hashes TEXT NOT NULL DEFAULT '[]',recovery_cipher TEXT,recovery_ack INTEGER NOT NULL DEFAULT 0,
        binding_ready INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,UNIQUE(issuer,subject));
      CREATE TABLE IF NOT EXISTS identity_invitations (
        invitation_id TEXT PRIMARY KEY,batch_id TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,issuer TEXT NOT NULL,
        created INTEGER NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL,session_digest TEXT,
        reserved_until INTEGER,account_id TEXT);
      CREATE TABLE IF NOT EXISTS identity_sessions (
        digest TEXT PRIMARY KEY,purpose TEXT NOT NULL,account_id TEXT,security_version INTEGER,
        csrf_digest TEXT NOT NULL,expires INTEGER NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS identity_bindings (
        account_id TEXT NOT NULL,purpose TEXT NOT NULL,credential_id TEXT NOT NULL UNIQUE,
        agent_instance_id TEXT NOT NULL,credential_file TEXT NOT NULL,checked INTEGER NOT NULL,
        PRIMARY KEY(account_id,purpose));
      CREATE TABLE IF NOT EXISTS identity_operations (
        operation_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,
        payload_cipher TEXT,last_error TEXT,created INTEGER NOT NULL,UNIQUE(account_id,kind));
      CREATE TABLE IF NOT EXISTS identity_audit (
        audit_id TEXT PRIMARY KEY,account_id TEXT,action TEXT NOT NULL,outcome TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS identity_recovery_claims (
        account_id TEXT NOT NULL,digest TEXT NOT NULL,session_digest TEXT NOT NULL,PRIMARY KEY(account_id,digest));
    `);
    this.console = new IdentityConsole(this);
  }
  seal(value,account,purpose) {
    const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(`identity-v1|${account}|${purpose}`));
    const body=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
    return JSON.stringify({v:1,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),body:body.toString('base64url')});
  }
  unseal(value,account,purpose) {
    const data=JSON.parse(value);if(data.v!==1) throw new Error('Unsupported identity encryption version');
    const cipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(data.iv,'base64url'));
    cipher.setAAD(Buffer.from(`identity-v1|${account}|${purpose}`));cipher.setAuthTag(Buffer.from(data.tag,'base64url'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data.body,'base64url')),cipher.final()]).toString());
  }
  audit(account,action,outcome='success') {
    this.db.prepare('INSERT INTO identity_audit VALUES(?,?,?,?,?)').run(randomUUID(),account,action,outcome,seconds());
  }
  account(subject) {return this.db.prepare('SELECT * FROM identity_accounts WHERE issuer=? AND subject=?').get(this.issuer,subject);}
  byId(id) {return this.db.prepare('SELECT * FROM identity_accounts WHERE account_id=?').get(id);}
  eligible(subject) {const a=this.account(subject);return !!a && a.status==='active' && a.mfa_verified===1 && a.binding_ready===1 && a.recovery_ack===1;}
  principal(subject) {
    const a=this.account(subject);if(!this.eligible(subject)) throw new BoundaryError(403,'SUBJECT_DENIED');
    return Object.freeze({account_id:a.account_id,issuer:a.issuer,subject:a.subject,user_id:a.user_id,security_version:a.security_version});
  }
  newSession(purpose,{accountId=null,ttl}={}) {
    const lifetime=ttl??this.sessionTtl;
    if(!Number.isInteger(lifetime)||lifetime<60||lifetime>28800) throw new BoundaryError(503,'SESSION_POLICY_REQUIRED');
    const token=randomSecret(),csrf=randomSecret();const a=accountId?this.byId(accountId):null;
    this.db.prepare('INSERT INTO identity_sessions VALUES(?,?,?,?,?,?,?)').run(secretHash(token),purpose,accountId,a?.security_version??null,secretHash(csrf),seconds()+lifetime,seconds());
    return {token,csrf};
  }
  session(token,purpose,{csrf}={}) {
    if(typeof token!=='string'||token.length>256) throw new BoundaryError(401,'SESSION_REQUIRED');
    const row=this.db.prepare('SELECT * FROM identity_sessions WHERE digest=? AND purpose=? AND expires>?').get(secretHash(token),purpose,seconds());
    if(!row || (csrf!==undefined && !equalSecret(row.csrf_digest,secretHash(csrf)))) throw new BoundaryError(401,'SESSION_REQUIRED');
    if(row.account_id) {
      const a=this.byId(row.account_id);
      if(!a||a.security_version!==row.security_version || (purpose==='console'&&!this.eligible(a.subject))) throw new BoundaryError(401,'SESSION_REQUIRED');
    }
    return row;
  }
  revokeSession(token) {this.db.prepare('DELETE FROM identity_sessions WHERE digest=?').run(secretHash(token));}
  formCsrf(token,purpose) {
    const row=this.session(token,purpose),csrf=randomSecret();
    this.db.prepare('UPDATE identity_sessions SET csrf_digest=? WHERE digest=?').run(secretHash(csrf),row.digest);return csrf;
  }
  issueInvitations({count,ttlMinutes,issuer}) {
    if(!Number.isInteger(this.batchLimit)||this.batchLimit<1||this.batchLimit>1000) throw new BoundaryError(503,'BATCH_POLICY_REQUIRED');
    if(!Number.isInteger(count)||count<1||count>this.batchLimit||!Number.isInteger(ttlMinutes)||ttlMinutes<1||ttlMinutes>1440
      ||typeof issuer!=='string'||!issuer.trim()||issuer.length>128) throw new BoundaryError(400,'INVALID_INVITATION_PARAMETERS');
    const batch_id=randomUUID(),now=seconds();const codes=Array.from({length:count},randomSecret);
    this.store.transaction(()=>{
      for(const code of codes) this.db.prepare('INSERT INTO identity_invitations(invitation_id,batch_id,digest,issuer,created,expires,state) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(),batch_id,secretHash(code),issuer,now,now+ttlMinutes*60,'issued');
      this.audit(null,'invitation.issue');
    });
    return {batch_id,codes,expires:now+ttlMinutes*60};
  }
  listInvitations() {return this.db.prepare('SELECT invitation_id,batch_id,issuer,created,expires,state FROM identity_invitations ORDER BY created, rowid').all();}
  revokeBatch(batchId) {return this.store.transaction(()=>{
    const changed=this.db.prepare("UPDATE identity_invitations SET state='revoked' WHERE batch_id=? AND state IN ('issued','reserved')").run(batchId).changes;
    this.audit(null,'invitation.batch_revoke');return changed;
  });}
  reserveInvitation(code) {
    if(typeof code!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(code)) throw denied();
    return this.store.transaction(()=>{
      const i=this.db.prepare('SELECT * FROM identity_invitations WHERE digest=?').get(secretHash(code)),now=seconds();
      if(!i||i.expires<=now||!(i.state==='issued'||i.state==='reserved'&&i.reserved_until<=now)) throw denied();
      if(i.account_id) {
        const abandoned=this.byId(i.account_id);
        if(!abandoned||abandoned.status!=='pending_mfa'||abandoned.mfa_verified||abandoned.binding_ready)throw denied();
        // Keep the failed identity and audit, but never transfer its password or factor to a new claimant.
        this.db.prepare("UPDATE identity_accounts SET status='registration_expired',security_version=security_version+1,username_key=? WHERE account_id=?")
          .run(`expired:${abandoned.account_id}`,abandoned.account_id);
        this.db.prepare('DELETE FROM identity_sessions WHERE account_id=?').run(abandoned.account_id);
        this.audit(abandoned.account_id,'registration.expired');
      }
      const session=this.newSession('registration',{ttl:Math.max(60,Math.min(600,i.expires-now))});
      this.db.prepare("UPDATE identity_invitations SET state='reserved',session_digest=?,reserved_until=?,account_id=NULL WHERE invitation_id=?")
        .run(secretHash(session.token),Math.min(now+600,i.expires),i.invitation_id);
      return session;
    });
  }
  reservation(token) {
    const s=this.session(token,'registration');const i=this.db.prepare('SELECT * FROM identity_invitations WHERE session_digest=?').get(s.digest);
    if(!i||!['reserved','consumed'].includes(i.state)||i.state==='reserved'&&(i.expires<=seconds()||i.reserved_until<=seconds())) throw denied();
    return {s,i};
  }
  async prepareRegistration(token,username,password) {
    const key=usernameKey(username);this.reservation(token);const record=await passwordRecord(password);
    return this.store.transaction(()=>{
      const {s,i}=this.reservation(token);if(i.account_id) throw denied();
      if(this.db.prepare('SELECT 1 FROM identity_accounts WHERE username_key=?').get(key)) throw denied();
      const id=randomUUID(),subject=randomUUID(),userId=`user-${id}`;
      this.db.prepare(`INSERT INTO identity_accounts(account_id,issuer,subject,user_id,username,username_key,password_json,mfa_cipher,status,created)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,this.issuer,subject,userId,username,key,JSON.stringify(record),this.seal(generateSecret(),id,'totp'),'pending_mfa',seconds());
      this.db.prepare('UPDATE identity_sessions SET account_id=?,security_version=1 WHERE digest=?').run(id,s.digest);
      this.db.prepare('UPDATE identity_invitations SET account_id=? WHERE invitation_id=?').run(id,i.invitation_id);
      this.audit(id,'registration.prepared');return {account_id:id,status:'pending_mfa'};
    });
  }
  enrollment(token) {
    return this.store.transaction(()=>{
      const {s}=this.reservation(token),a=this.byId(s.account_id);
      if(!a||a.status!=='pending_mfa'||a.mfa_verified) throw denied();
      if(this.db.prepare("SELECT 1 FROM identity_audit WHERE account_id=? AND action='registration.totp_displayed'").get(a.account_id))
        return {subject:a.subject,already_shown:true};
      const secret=this.unseal(a.mfa_cipher,a.account_id,'totp');this.audit(a.account_id,'registration.totp_displayed');
      return {subject:a.subject,secret,uri:generateURI({issuer:'Mnemuron',label:a.username,secret})};
    });
  }
  async verifyEnrollment(token,otp) {
    const {s,i}=this.reservation(token),a=this.byId(s.account_id);
    if(a?.mfa_verified&&i.state==='consumed'&&['provisioning','active'].includes(a.status))return {account_id:a.account_id,status:a.status};
    if(!a||a.status!=='pending_mfa'||typeof otp!=='string'||!/^\d{6}$/.test(otp)) throw denied();
    const result=await verify({secret:this.unseal(a.mfa_cipher,a.account_id,'totp'),token:otp,epochTolerance:30});
    if(!result.valid) throw denied();
    const codes=Array.from({length:8},randomSecret);
    return this.store.transaction(()=>{
      const {i}=this.reservation(token),current=this.byId(a.account_id);
      if(current.mfa_verified&&i.state==='consumed'&&['provisioning','active'].includes(current.status))return {account_id:a.account_id,status:current.status};
      if(current.status!=='pending_mfa'||i.state!=='reserved'||!this.store.consumeStep(a.subject,result.epoch)) throw denied();
      this.db.prepare("UPDATE identity_accounts SET mfa_verified=1,status='provisioning',recovery_hashes=?,recovery_cipher=? WHERE account_id=?")
        .run(JSON.stringify(codes.map(secretHash)),this.seal(codes,a.account_id,'recovery-display'),a.account_id);
      this.db.prepare("UPDATE identity_invitations SET state='consumed' WHERE invitation_id=?").run(i.invitation_id);
      this.queueProvision(a.account_id);this.audit(a.account_id,'registration.mfa_verified');
      return {account_id:a.account_id,status:'provisioning'};
    });
  }
  takeRecoveryCodes(token) {
    return this.store.transaction(()=>{
      const {s}=this.reservation(token),a=this.byId(s.account_id);
      if(!a?.recovery_cipher) throw new BoundaryError(409,'RECOVERY_CODES_ALREADY_SHOWN');
      const codes=this.unseal(a.recovery_cipher,a.account_id,'recovery-display');
      this.db.prepare('UPDATE identity_accounts SET recovery_cipher=NULL WHERE account_id=?').run(a.account_id);
      this.audit(a.account_id,'registration.recovery_shown');return codes;
    });
  }
  acknowledgeRecovery(token) {
    return this.store.transaction(()=>{
      const {s}=this.reservation(token),a=this.byId(s.account_id);
      if(!a?.mfa_verified||a.recovery_cipher) throw denied();
      this.db.prepare('UPDATE identity_accounts SET recovery_ack=1 WHERE account_id=?').run(a.account_id);
      this.activate(a.account_id);this.audit(a.account_id,'registration.recovery_ack');
    });
  }
  registrationState(token) {
    const {s}=this.reservation(token),a=this.byId(s.account_id);
    return a?{account_id:a.account_id,status:a.status,recovery_ack:!!a.recovery_ack,recovery_available:!!a.recovery_cipher}:{status:'reserved'};
  }
  activate(id) {this.db.prepare("UPDATE identity_accounts SET status='active' WHERE account_id=? AND status='provisioning' AND mfa_verified=1 AND recovery_ack=1 AND binding_ready=1").run(id);}
  queueProvision(id) {
    this.db.prepare("INSERT OR IGNORE INTO identity_operations(operation_id,account_id,kind,state,created) VALUES(?,?,?,'pending',?)").run(randomUUID(),id,`provision:${this.byId(id).security_version}`,seconds());
  }
  importLegacy(owner,mapping) {
    requireConfig(owner.subject===mapping.subject&&mapping.issuer===this.issuer&&typeof mapping.mnemuron_user_id==='string'&&mapping.mnemuron_user_id.length>0,'legacy identity mismatch');
    requireConfig(owner.password?.algorithm==='scrypt'&&owner.password.N===SCRYPT.N&&owner.password.r===8&&owner.password.p===1&&typeof owner.mfa?.secret==='string','legacy credentials');
    const key=usernameKey(owner.username);
    return this.store.transaction(()=>{
      const old=this.account(owner.subject);
      if(old){requireConfig(old.user_id===mapping.mnemuron_user_id && old.username===owner.username,'legacy identity mismatch');return {account_id:old.account_id,status:old.status};}
      const id=randomUUID();
      this.db.prepare(`INSERT INTO identity_accounts(account_id,issuer,subject,user_id,username,username_key,password_json,mfa_cipher,mfa_verified,status,recovery_hashes,recovery_ack,created)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,this.issuer,owner.subject,mapping.mnemuron_user_id,owner.username,key,JSON.stringify(owner.password),this.seal(owner.mfa.secret,id,'totp'),owner.mfa.verified?1:0,owner.enabled&&mapping.enabled?'provisioning':'disabled',JSON.stringify(owner.recovery_hashes||[]),1,seconds());
      this.queueProvision(id);this.audit(id,'migration.legacy_imported');return {account_id:id,status:this.byId(id).status};
    });
  }
  async authenticate(username,password,otp) {
    let key;try{key=usernameKey(username);}catch{return null;}
    const a=this.db.prepare('SELECT * FROM identity_accounts WHERE username_key=?').get(key);
    const record=a?JSON.parse(a.password_json):{salt:'synthetic-constant-cost-unknown-user',hash:''};
    const value=typeof password==='string'&&password.length<=1024?password:'';
    const hash=(await derive(value,record.salt,64,SCRYPT)).toString('base64url');
    if(!a||!equalSecret(hash,record.hash)||!this.eligible(a.subject)||!/^\d{6}$/.test(otp||'')) return null;
    const result=await verify({secret:this.unseal(a.mfa_cipher,a.account_id,'totp'),token:otp,epochTolerance:30});
    if(!result.valid) return null;
    return this.store.transaction(()=>{
      const current=this.byId(a.account_id);
      if(!this.eligible(a.subject)||current.security_version!==a.security_version||current.password_json!==a.password_json||current.mfa_cipher!==a.mfa_cipher||!this.store.consumeStep(a.subject,result.epoch)) return null;
      this.audit(a.account_id,'account.login');return a.subject;
    });
  }
  bindings(subject) {
    const a=this.account(subject);if(!this.eligible(subject)) throw new BoundaryError(403,'SUBJECT_DENIED');
    return this.db.prepare('SELECT purpose,credential_id,agent_instance_id,credential_file FROM identity_bindings WHERE account_id=? AND checked=1').all(a.account_id);
  }
  finishProvision(id,bindings,operationId) {
    return this.store.transaction(()=>{
      const a=this.byId(id),operation=this.db.prepare('SELECT * FROM identity_operations WHERE operation_id=? AND account_id=?').get(operationId,id);
      requireConfig(a&&operation?.kind===`provision:${a.security_version}`&&['provisioning','active'].includes(a.status),'current provisioning epoch');
      requireConfig(bindings.length===2&&new Set(bindings.map(b=>b.purpose)).size===2&&bindings.every(b=>['web','console'].includes(b.purpose)),'two distinct core bindings');
      for(const b of bindings) this.db.prepare(`INSERT INTO identity_bindings VALUES(?,?,?,?,?,1) ON CONFLICT(account_id,purpose) DO UPDATE SET credential_id=excluded.credential_id,agent_instance_id=excluded.agent_instance_id,credential_file=excluded.credential_file,checked=1`)
        .run(id,b.purpose,b.credential_id,b.agent_instance_id,b.credential_file);
      this.db.prepare('UPDATE identity_accounts SET binding_ready=1 WHERE account_id=?').run(id);
      this.db.prepare("UPDATE identity_operations SET state='completed',last_error=NULL WHERE account_id=? AND operation_id=?").run(id,operationId);
      this.activate(id);this.audit(id,'identity.provisioned');
    });
  }
}

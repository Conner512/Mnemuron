import {scrypt,randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {generateSecret,generateURI,verify} from 'otplib';
import {BoundaryError,secretHash,equalSecret,seconds} from '../../../shared/oauth-common.mjs';
import {usernameKey,passwordRecord} from './identity-repository.mjs';
const derive=promisify(scrypt);
const fail=()=>{throw new BoundaryError(400,'RECOVERY_UNAVAILABLE');};

// No constructor default approves a proof combination. HTTP/CLI remain blocked
// until an operator provides an independently approved policy integration.
export class RecoveryService {
  constructor(identities,{policy=null}={}) {this.ids=identities;this.db=identities.db;this.policy=policy;}
  proofs(action) {
    const required=this.policy?.[action];
    if(!['password','totp'].includes(action)||!Array.isArray(required)||required.length!==2||!required.includes('recovery_code')
      ||!required.includes(action==='password'?'totp':'password'))throw new BoundaryError(403,'BLOCKED_POLICY');
    return required;
  }
  async begin({username,action,password,otp,recoveryCode}) {
    const required=this.proofs(action),key=usernameKey(username);
    this.ids.store.limit(`recovery:${key}`,5,900);
    const a=this.db.prepare('SELECT * FROM identity_accounts WHERE username_key=?').get(key);
    if(!a||!this.ids.eligible(a.subject)||typeof recoveryCode!=='string'||recoveryCode.length>256)fail();
    const digest=secretHash(recoveryCode),hashes=JSON.parse(a.recovery_hashes);
    if(!hashes.some(h=>equalSecret(h,digest)))fail();
    let epoch;
    if(required.includes('password')) {
      const p=JSON.parse(a.password_json),supplied=typeof password==='string'&&password.length<=1024?password:'';
      const actual=(await derive(supplied,p.salt,64,{N:p.N,r:p.r,p:p.p,maxmem:128*1024*1024})).toString('base64url');
      if(!equalSecret(actual,p.hash))fail();
    }
    if(required.includes('totp')) {
      if(!/^\d{6}$/.test(otp||''))fail();
      const result=await verify({secret:this.ids.unseal(a.mfa_cipher,a.account_id,'totp'),token:otp,epochTolerance:30});
      if(!result.valid)fail();epoch=result.epoch;
    }
    return this.ids.store.transaction(()=>{
      const current=this.ids.byId(a.account_id);
      if(!this.ids.eligible(a.subject)||current.security_version!==a.security_version||!JSON.parse(current.recovery_hashes).includes(digest))fail();
      if(epoch!==undefined&&!this.ids.store.consumeStep(a.subject,epoch))fail();
      this.db.prepare("UPDATE identity_accounts SET status='recovery_pending',security_version=security_version+1,recovery_hashes=? WHERE account_id=?")
        .run(JSON.stringify(hashes.filter(h=>h!==digest)),a.account_id);
      const s=this.ids.newSession('recovery',{accountId:a.account_id,ttl:600});
      this.db.prepare('INSERT INTO identity_recovery_claims VALUES(?,?,?)').run(a.account_id,digest,secretHash(s.token));
      const id=randomUUID(),payload={session_digest:secretHash(s.token),action,...(action==='totp'?{totp_secret:generateSecret()}:{}),prior_security_version:a.security_version};
      this.db.prepare('INSERT INTO identity_operations(operation_id,account_id,kind,state,payload_cipher,created) VALUES(?,?,?,?,?,?)')
        .run(id,a.account_id,`recovery:${id}`,'proof_verified',this.ids.seal(payload,a.account_id,'recovery'),seconds());
      this.ids.audit(a.account_id,'recovery.proof_verified');return {token:s.token,csrf:s.csrf,restricted:true,action};
    });
  }
  operation(token) {
    const s=this.ids.session(token,'recovery');
    const rows=this.db.prepare("SELECT * FROM identity_operations WHERE account_id=? AND kind LIKE 'recovery:%'").all(s.account_id);
    const op=rows.map(row=>({...row,payload:this.ids.unseal(row.payload_cipher,s.account_id,'recovery')})).find(row=>row.payload.session_digest===s.digest);
    if(!op)fail();return op;
  }
  enrollment(token) {
    const op=this.operation(token);if(op.payload.action!=='totp'||op.state!=='proof_verified')fail();
    const a=this.ids.byId(op.account_id);return {uri:generateURI({issuer:'Mnemuron',label:a.username,secret:op.payload.totp_secret}),secret:op.payload.totp_secret};
  }
  async complete(token,{password,otp},{revokeCore}={}) {
    let op=this.operation(token),a=this.ids.byId(op.account_id);this.proofs(op.payload.action);
    if(op.state==='completed')return {status:a.status,login_required:true};
    if(typeof revokeCore!=='function')throw new BoundaryError(503,'REVOCATION_DEPENDENCY_REQUIRED');
    if(op.state==='proof_verified') {
      let record,epoch;
      if(op.payload.action==='password')record=await passwordRecord(password);
      else {
        if(!/^\d{6}$/.test(otp||''))fail();const v=await verify({secret:op.payload.totp_secret,token:otp,epochTolerance:30});
        if(!v.valid)fail();epoch=v.epoch;
      }
      this.ids.store.transaction(()=>{
        const current=this.operation(token);if(current.state!=='proof_verified')fail();
        if(record)this.db.prepare('UPDATE identity_accounts SET password_json=? WHERE account_id=?').run(JSON.stringify(record),a.account_id);
        else {
          if(!this.ids.store.consumeStep(a.subject,epoch))fail();
          this.db.prepare('UPDATE identity_accounts SET mfa_cipher=?,mfa_verified=1 WHERE account_id=?').run(this.ids.seal(op.payload.totp_secret,a.account_id,'totp'),a.account_id);
        }
        this.db.prepare("UPDATE identity_operations SET state='revocation_pending' WHERE operation_id=?").run(op.operation_id);
        this.ids.audit(a.account_id,'recovery.credentials_prepared');
      });
    }
    // A durable paused account invalidates introspection and console sessions even
    // when the independent Core revocation is interrupted. No success is claimed.
    try {
      this.ids.store.revoke({subject:a.subject});
      const bindings=this.db.prepare('SELECT credential_id FROM identity_bindings WHERE account_id=?').all(a.account_id);
      if(await revokeCore({user_id:a.user_id,credential_ids:bindings.map(b=>b.credential_id)})!==true)throw new Error('Core revocation unverified');
    }catch {
      this.db.prepare("UPDATE identity_operations SET last_error='REVOCATION_INCOMPLETE' WHERE operation_id=?").run(op.operation_id);
      throw new BoundaryError(503,'REVOCATION_INCOMPLETE');
    }
    this.ids.store.transaction(()=>{
      this.operation(token);
      this.db.prepare("UPDATE identity_accounts SET status='provisioning',binding_ready=0 WHERE account_id=? AND status='recovery_pending'").run(a.account_id);
      this.ids.queueProvision(a.account_id);
      this.db.prepare("UPDATE identity_operations SET state='completed',last_error=NULL WHERE operation_id=?").run(op.operation_id);
      this.ids.audit(a.account_id,'recovery.completed');
    });
    return {status:'provisioning',login_required:true};
  }
}

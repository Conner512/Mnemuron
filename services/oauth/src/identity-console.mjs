import {randomUUID,createHmac} from 'node:crypto';
import {generateSecret,generateURI,verify} from 'otplib';
import {BoundaryError,secretHash,randomSecret,seconds} from '../../../shared/oauth-common.mjs';
import {passwordRecord} from './identity-repository.mjs';
import {fingerprint} from '../../../server/lib/console/state.mjs';
const fail=(code='INVALID_CONSOLE_INPUT',status=400)=>{throw new BoundaryError(status,code);};
const input=(p,keys)=>{if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!keys.includes(k)))fail();};
const identifier=value=>{if(typeof value!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(value))fail();return value;};

export class IdentityConsole {
  constructor(ids){this.ids=ids;this.db=ids.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS identity_console_roles(account_id TEXT PRIMARY KEY,role TEXT NOT NULL CHECK(role='operator'),created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS identity_console_operations(account_id TEXT NOT NULL,operation_id TEXT NOT NULL,action TEXT NOT NULL,request_hash TEXT NOT NULL,
        result_cipher TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(account_id,operation_id));
      CREATE TABLE IF NOT EXISTS identity_console_enrollments(enrollment_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,session_digest TEXT NOT NULL,security_version INTEGER NOT NULL,
        secret_cipher TEXT NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL);`);
  }
  operator(account){return !!this.db.prepare('SELECT 1 FROM identity_console_roles WHERE account_id=?').get(account);}
  requireOperator(account){if(!this.operator(account))fail('OPERATOR_REQUIRED',403);}
  role(account,enabled){if(!this.ids.byId(account))fail('ACCOUNT_NOT_FOUND',404);
    if(enabled)this.db.prepare("INSERT OR IGNORE INTO identity_console_roles VALUES(?,'operator',?)").run(account,seconds());
    else {this.protectLastOperator(account);this.db.prepare('DELETE FROM identity_console_roles WHERE account_id=?').run(account);}
  }
  protectLastOperator(account){if(this.operator(account)&&this.db.prepare("SELECT COUNT(*) n FROM identity_console_roles r JOIN identity_accounts a ON a.account_id=r.account_id WHERE a.status='active'").get().n<=1)fail('LAST_OPERATOR',409);}
  overview(account){return {operator:this.operator(account),operation_access:'own_account_only',security_actions:['security.password','security.totp.begin','security.totp.complete','security.recovery_codes','security.session.revoke','security.sessions.revoke_others']};}
  listAccounts(actor){this.requireOperator(actor);return this.db.prepare("SELECT a.account_id,a.username,a.status,a.mfa_verified,a.binding_ready,a.created,COALESCE(r.role,'member') role FROM identity_accounts a LEFT JOIN identity_console_roles r ON r.account_id=a.account_id ORDER BY a.created DESC LIMIT 500").all();}
  invitations(actor){this.requireOperator(actor);return this.db.prepare('SELECT invitation_id,batch_id,issuer,created,expires,state FROM identity_invitations ORDER BY created DESC,rowid DESC LIMIT 1000').all().map(r=>({...r,effective_state:['issued','reserved'].includes(r.state)&&r.expires<=seconds()?'expired':r.state}));}
  sessions(account,current){return this.db.prepare("SELECT digest,purpose,created,expires FROM identity_sessions WHERE account_id=? AND purpose='console' AND expires>? ORDER BY created DESC").all(account,seconds()).map(r=>({session_id:r.digest,purpose:r.purpose,created:r.created,expires:r.expires,current:r.digest===current}));}
  grants(subject){return this.db.prepare("SELECT id,payload,expires FROM oauth_records WHERE model='Grant' AND json_extract(payload,'$.accountId')=? AND expires>?").all(subject,seconds()).map(r=>({grant_id:r.id,client_id:JSON.parse(r.payload).clientId,expires:r.expires}));}
  requestHash(account,operation,action,p){return createHmac('sha256',this.ids.key).update(JSON.stringify(['console-intent-v1',account,operation,action,fingerprint(p)])).digest('hex');}
  previous(account,operation,action,p){identifier(operation);const row=this.db.prepare('SELECT * FROM identity_console_operations WHERE account_id=? AND operation_id=?').get(account,operation);if(!row)return null;
    if(row.action!==action||row.request_hash!==this.requestHash(account,operation,action,p))fail('IDEMPOTENCY_CONFLICT',409);
    if(row.created+600<seconds())return {status:'completed',secret_expired:true,operation_id:operation,replayed:true};
    return {...this.ids.unseal(row.result_cipher,account,`console:${operation}`),operation_id:operation,replayed:true};}
  record(account,operation,action,p,result){this.db.prepare('INSERT INTO identity_console_operations VALUES(?,?,?,?,?,?)').run(account,operation,action,this.requestHash(account,operation,action,p),this.ids.seal(result,account,`console:${operation}`),seconds());this.ids.audit(account,`console.${action}`);return {...result,operation_id:operation};}
  async proof(account,p){const before=this.ids.byId(account);if(!this.ids.eligible(before?.subject))fail('SESSION_REQUIRED',401);
    this.ids.store.limit(`console:reauth:${account}`,5,900);
    const subject=await this.ids.authenticate(before.username,p.current_password,p.otp);
    if(subject!==before.subject)fail('REAUTHENTICATION_FAILED',403);
    const after=this.ids.byId(account);if(after.security_version!==before.security_version)fail('SESSION_REQUIRED',401);return after;}
  async execute(account,session,action,p,operation,{lifecycle}={}) {
    const actor=this.ids.byId(account);if(!this.ids.eligible(actor?.subject)||session.security_version!==actor.security_version)fail('SESSION_REQUIRED',401);
    if(action.startsWith('invitations.')||action.startsWith('accounts.'))this.requireOperator(account);
    const previous=this.previous(account,operation,action,p);if(previous)return previous;
    const privileged=!['security.session.revoke','security.sessions.revoke_others','oauth.revoke','security.totp.complete'].includes(action);
    // Fixed per-action field sets prevent mass assignment (especially roles/owner IDs).
    const fields={
      'security.password':['new_password','password_confirm'], 'security.totp.begin':[], 'security.totp.complete':['enrollment_id','new_otp'],
      'security.recovery_codes':[], 'security.session.revoke':['session_id'], 'security.sessions.revoke_others':[], 'oauth.revoke':['grant_id'],
      'invitations.issue':['count','ttl_minutes'], 'invitations.revoke':['invitation_id'], 'invitations.revoke_batch':['batch_id'],
      'accounts.disable':['account_id'], 'accounts.enable':['account_id'], 'accounts.role':['account_id','operator']
    }[action];if(!fields)fail('UNKNOWN_ACTION',404);input(p,[...fields,...(privileged?['current_password','otp']:[])]);
    let verified=actor;if(privileged)verified=await this.proof(account,p);
    // Verify the exact original session again after every awaited factor check.
    const currentSession=this.db.prepare("SELECT * FROM identity_sessions WHERE digest=? AND account_id=? AND purpose='console' AND expires>?").get(session.digest,account,seconds());
    if(!currentSession||currentSession.security_version!==verified.security_version)fail('SESSION_REQUIRED',401);
    if(action.startsWith('invitations.')||action.startsWith('accounts.'))this.requireOperator(account);
    let newPassword,newTotp;
    if(action==='security.password'){if(p.new_password!==p.password_confirm)fail('PASSWORD_CONFIRMATION_FAILED');newPassword=await passwordRecord(p.new_password);}
    if(action==='security.totp.complete'){
      const e=this.enrollment(account,session,p.enrollment_id);if(!/^\d{6}$/.test(p.new_otp||''))fail('INVALID_OTP');
      const secret=this.ids.unseal(e.secret_cipher,account,'console-totp');const check=await verify({secret,token:p.new_otp,epochTolerance:30});if(!check.valid)fail('INVALID_OTP');newTotp={e,secret,epoch:check.epoch};
    }
    if(['accounts.disable','accounts.enable'].includes(action)){
      if(typeof lifecycle!=='function')fail('IDENTITY_MAINTENANCE_REQUIRED',503);identifier(p.account_id);if(p.account_id===account)fail('SELF_ADMIN_STATE_DENIED',409);
      this.protectLastOperator(p.account_id);
      // The local maintenance dependency never accepts data/SQL supplied by the browser.
      const result=await lifecycle(p.account_id,action==='accounts.disable'?'disable':'enable');
      return this.ids.store.transaction(()=>this.record(account,operation,action,p,result));
    }
    if(action==='oauth.revoke'){
      if(!this.grants(actor.subject).some(g=>g.grant_id===p.grant_id))fail('GRANT_NOT_FOUND',404);
      return this.ids.store.transaction(()=>{this.ids.store.revokeGrant(p.grant_id);return this.record(account,operation,action,p,{status:'revoked',grant_id:p.grant_id});});
    }
    let invalidates=false;
    const result=this.ids.store.transaction(()=>{
      const current=this.ids.byId(account),s=this.db.prepare('SELECT * FROM identity_sessions WHERE digest=? AND expires>?').get(session.digest,seconds());
      if(!s||!this.ids.eligible(current.subject)||current.security_version!==verified.security_version)fail('SESSION_REQUIRED',401);
      const prior=this.previous(account,operation,action,p);if(prior)return prior;
      if(action.startsWith('invitations.')||action.startsWith('accounts.'))this.requireOperator(account);
      let out;
      if(action==='security.password'){
        this.db.prepare('UPDATE identity_accounts SET password_json=?,security_version=security_version+1 WHERE account_id=?').run(JSON.stringify(newPassword),account);invalidates=true;out={status:'changed',login_required:true};
      } else if(action==='security.totp.begin'){
        const enrollment_id=randomUUID(),secret=generateSecret();this.db.prepare("UPDATE identity_console_enrollments SET state='superseded' WHERE account_id=? AND state='pending'").run(account);
        this.db.prepare("INSERT INTO identity_console_enrollments VALUES(?,?,?,?,?,?,'pending')").run(enrollment_id,account,session.digest,verified.security_version,this.ids.seal(secret,account,'console-totp'),seconds()+600);
        out={status:'verification_required',enrollment_id,secret,uri:generateURI({issuer:'Mnemuron',label:actor.username,secret}),expires_in_seconds:600};
      } else if(action==='security.totp.complete'){
        this.enrollment(account,session,p.enrollment_id);
        this.db.prepare('UPDATE identity_accounts SET mfa_cipher=?,mfa_verified=1,security_version=security_version+1 WHERE account_id=?').run(this.ids.seal(newTotp.secret,account,'totp'),account);
        this.db.prepare('INSERT OR REPLACE INTO oauth_mfa_steps VALUES(?,?)').run(actor.subject,newTotp.epoch);
        this.db.prepare("UPDATE identity_console_enrollments SET state='completed' WHERE enrollment_id=?").run(p.enrollment_id);invalidates=true;out={status:'changed',login_required:true};
      } else if(action==='security.recovery_codes'){
        const codes=Array.from({length:8},randomSecret);this.db.prepare('UPDATE identity_accounts SET recovery_hashes=? WHERE account_id=?').run(JSON.stringify(codes.map(secretHash)),account);out={status:'rotated',codes};
      } else if(action==='security.session.revoke'){
        identifier(p.session_id);const changed=this.db.prepare("DELETE FROM identity_sessions WHERE account_id=? AND digest=? AND purpose='console'").run(account,p.session_id).changes;
        if(!changed)fail('SESSION_NOT_FOUND',404);out={status:'revoked',login_required:p.session_id===session.digest};
      } else if(action==='security.sessions.revoke_others'){
        out={status:'revoked',count:this.db.prepare("DELETE FROM identity_sessions WHERE account_id=? AND digest<>? AND purpose='console'").run(account,session.digest).changes};
      } else if(action==='invitations.issue'){
        // issueInvitations owns a transaction; use the nested-safe store primitive.
        out={status:'issued',...this.ids.issueInvitations({count:p.count,ttlMinutes:p.ttl_minutes,issuer:account})};
      } else if(action==='invitations.revoke'){
        identifier(p.invitation_id);const count=this.db.prepare("UPDATE identity_invitations SET state='revoked' WHERE invitation_id=? AND state IN ('issued','reserved')").run(p.invitation_id).changes;out={status:'revoked',count};
      } else if(action==='invitations.revoke_batch')out={status:'revoked',count:this.ids.revokeBatch(identifier(p.batch_id))};
      else if(action==='accounts.role'){
        identifier(p.account_id);if(typeof p.operator!=='boolean')fail();this.role(p.account_id,p.operator);out={status:'updated',account_id:p.account_id,operator:p.operator};
      }
      if(invalidates)this.db.prepare('DELETE FROM identity_sessions WHERE account_id=?').run(account);
      return this.record(account,operation,action,p,out);
    });
    if(invalidates)this.ids.store.revoke({subject:actor.subject});
    return result;
  }
  enrollment(account,session,enrollmentId){identifier(enrollmentId);const e=this.db.prepare("SELECT * FROM identity_console_enrollments WHERE enrollment_id=? AND account_id=? AND session_digest=? AND security_version=? AND expires>? AND state='pending'").get(enrollmentId,account,session.digest,session.security_version,seconds());if(!e)fail('ENROLLMENT_EXPIRED',409);return e;}
}

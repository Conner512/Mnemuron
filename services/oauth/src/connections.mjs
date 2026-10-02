import {randomUUID} from 'node:crypto';
import {BoundaryError,randomSecret,secretHash,seconds,requireConfig} from '../../../shared/oauth-common.mjs';

const fail=(code='INVALID_CONNECTION_INPUT',status=400)=>{throw new BoundaryError(status,code);};
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const fields=(p,allowed)=>{if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!allowed.includes(k)))fail();};
export const connectionActions=['connections.create','connections.update','connections.rotate','connections.disable','connections.enable','connections.revoke'];
export function validateConnectionPolicy(p){
 if(p===undefined)return;
 requireConfig(p&&typeof p==='object'&&!Array.isArray(p)&&typeof p.enabled==='boolean','connection management policy');
 requireConfig(Object.keys(p).every(k=>['enabled','max_connections','pat_default_ttl_seconds','pat_max_ttl_seconds','secret_receipt_ttl_seconds','rotation_overlap_seconds'].includes(k)),'connection policy fields');
 if(!p.enabled)return;
 for(const [key,min,max] of [['max_connections',1,100],['pat_default_ttl_seconds',60,7776000],['pat_max_ttl_seconds',60,7776000],['secret_receipt_ttl_seconds',30,300]])requireConfig(Number.isSafeInteger(p[key])&&p[key]>=min&&p[key]<=max,'bounded '+key);
 requireConfig(p.pat_default_ttl_seconds<=p.pat_max_ttl_seconds&&p.rotation_overlap_seconds===0,'no permanent or overlapping credentials');
}
export function exactChatgptCallback(value,{isolated=false}={}){
 let url;try{url=new URL(value);}catch{fail('INVALID_CALLBACK');}
 if(typeof value!=='string'||url.href!==value||url.username||url.password||url.hash||url.search||value.includes('%'))fail('INVALID_CALLBACK');
 if(isolated&&url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.pathname==='/callback')return value;
 if(url.protocol!=='https:'||url.host!=='chatgpt.com'||!(url.pathname==='/connector_platform_oauth_redirect'||/^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)))fail('INVALID_CALLBACK');
 return value;
}
export function initializeConnections(db){db.exec(`
 CREATE TABLE IF NOT EXISTS identity_connections (
 connection_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,description TEXT NOT NULL,
 profile TEXT NOT NULL,state TEXT NOT NULL,health TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,secret_cipher TEXT,
 callback TEXT,allow_submitted_revision_grant INTEGER NOT NULL,version INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,
 last_authorized INTEGER,last_success INTEGER,last_error TEXT,binding_json TEXT,binding_version INTEGER,binding_account_version INTEGER);
 CREATE INDEX IF NOT EXISTS identity_connections_owner ON identity_connections(account_id,state,updated,connection_id);
 CREATE TABLE IF NOT EXISTS identity_connection_tokens (
 token_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,connection_id TEXT NOT NULL,digest TEXT NOT NULL UNIQUE,
 version INTEGER NOT NULL,security_version INTEGER NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER);
 CREATE INDEX IF NOT EXISTS identity_connection_tokens_parent ON identity_connection_tokens(account_id,connection_id,version);
 CREATE TABLE IF NOT EXISTS identity_connection_operations (
 account_id TEXT NOT NULL,operation_id TEXT NOT NULL,action TEXT NOT NULL,request_hash TEXT NOT NULL,session_digest TEXT NOT NULL,
 result_json TEXT NOT NULL,secret_cipher TEXT,secret_expires INTEGER NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(account_id,operation_id));
 CREATE TABLE IF NOT EXISTS identity_connection_activity (
 event_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,connection_id TEXT NOT NULL,action TEXT NOT NULL,outcome TEXT NOT NULL,created INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS identity_connection_activity_parent ON identity_connection_activity(account_id,connection_id,created);
 CREATE TABLE IF NOT EXISTS identity_connection_credentials (
 credential_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,connection_id TEXT NOT NULL,version INTEGER NOT NULL,security_version INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
`);}

export class ConnectionRegistry {
 constructor(ids,config={}){this.ids=ids;this.db=ids.db;this.config=config;initializeConnections(this.db);ids.store.connections=this;}
 enabled(){return this.config.identity?.connection_management?.enabled===true;}
 policy(){const p=this.config.identity?.connection_management;validateConnectionPolicy(p);if(!p?.enabled)fail('CONNECTION_POLICY_REQUIRED',403);return p;}
 capabilities(){return {enabled:this.enabled(),actions:this.enabled()?connectionActions:[],policy:this.enabled()?this.policy():null,
   allow_submitted_revision_grant:this.config.cloud_memory?.allow_submitted_revision_grant===true,write_enabled:this.config.cloud_memory?.enabled===true,other_agent:'not_implemented',physical_device_verified:false};}
 owner(account){const a=this.ids.byId(account);if(!a||!this.ids.eligible(a.subject))fail('SESSION_REQUIRED',401);return a;}
 row(account,id){const r=this.db.prepare('SELECT * FROM identity_connections WHERE account_id=? AND connection_id=?').get(account,id);if(!r)fail('CONNECTION_NOT_FOUND',404);return r;}
 current(r){const a=r&&this.ids.byId(r.account_id);return !!a&&this.ids.eligible(a.subject)&&r.state==='ready'&&r.binding_version===r.version&&r.binding_account_version===a.security_version&&!!r.binding_json;}
 activeGrants(r){if(r.kind!=='chatgpt_oauth'||!this.current(r))return [];
   return this.db.prepare("SELECT g.id grant_id,g.expires FROM oauth_records g WHERE g.model='Grant' AND g.expires>? AND json_extract(g.payload,'$.accountId')=? AND json_extract(g.payload,'$.clientId')=? AND EXISTS(SELECT 1 FROM json_each(g.payload,'$.resources') s WHERE s.key=? AND instr(' '||s.value||' ',' memory:read ')>0) ORDER BY g.expires DESC LIMIT 50").all(seconds(),this.ids.byId(r.account_id).subject,r.client_id,this.config.resource);}
 public(r){const expired=r.kind==='generic_mcp'&&!!this.db.prepare('SELECT 1 FROM identity_connection_tokens WHERE connection_id=? AND version=?').get(r.connection_id,r.version)&&!this.db.prepare('SELECT 1 FROM identity_connection_tokens WHERE connection_id=? AND version=? AND revoked IS NULL AND expires>?').get(r.connection_id,r.version,seconds());
   return {connection_id:r.connection_id,kind:r.kind,label:r.label,description:r.description,profile:r.profile,
     configuration_state:r.state==='ready'&&!this.current(r)?'draft':r.state,provisioning:r.state==='ready'&&!this.current(r),health:expired?'unknown':r.health,expired,
     client_id:r.kind==='chatgpt_oauth'?r.client_id:null,...(r.kind==='chatgpt_oauth'?{active_grant_count:this.activeGrants(r).length}:{}),redirect_uri:r.callback,version:r.version,created_at:r.created,updated_at:r.updated,
     has_secret:r.state!=='revoked'&&(r.kind==='chatgpt_oauth'?!!r.secret_cipher:!!this.db.prepare('SELECT 1 FROM identity_connection_tokens WHERE connection_id=? AND version=? AND revoked IS NULL').get(r.connection_id,r.version)),
     last_authorized_at:r.last_authorized,last_successful_tool_at:r.last_success,last_error_code:r.last_error,
     allow_submitted_revision_grant:!!r.allow_submitted_revision_grant,physical_device_verified:false};}
 list(account,q={}){
   const owner=this.owner(account);fields(q,['kind','profile','state','search','offset','limit','section']);
   const limit=q.limit===undefined?20:Number(q.limit),offset=q.offset===undefined?0:Number(q.offset);
   if(!Number.isInteger(limit)||limit<1||limit>50||!Number.isInteger(offset)||offset<0||offset>100000||q.search!==undefined&&(typeof q.search!=='string'||q.search.length>120))fail();
   const clauses=['c.account_id=?'],args=[account];
   for(const [key,choices] of [['kind',['chatgpt_oauth','generic_mcp']],['profile',['readonly','memory_readwrite']],['state',['draft','ready','disabled','revoked']]])if(q[key]){
     if(!choices.includes(q[key]))fail();
     if(key==='state'){
       clauses.push("(CASE WHEN c.state='ready' AND (c.binding_json IS NULL OR c.binding_version IS NULL OR c.binding_version<>c.version OR c.binding_account_version IS NULL OR c.binding_account_version<>?) THEN 'draft' ELSE c.state END)=?");args.push(owner.security_version,q[key]);
     }else{clauses.push(`c.${key}=?`);args.push(q[key]);}
   }
   if(q.search){clauses.push('instr(lower(c.label),lower(?))>0');args.push(q.search);}
   const expired="(c.kind='generic_mcp' AND EXISTS(SELECT 1 FROM identity_connection_tokens t WHERE t.connection_id=c.connection_id AND t.version=c.version) AND NOT EXISTS(SELECT 1 FROM identity_connection_tokens t WHERE t.connection_id=c.connection_id AND t.version=c.version AND t.revoked IS NULL AND t.expires>"+seconds()+'))';
   if(q.section==='history')clauses.push(`(c.state='revoked' OR ${expired})`);else if(q.section==='active')clauses.push(`c.state<>'revoked' AND NOT ${expired}`);else if(q.section)fail();
   const where=clauses.join(' AND '),total=this.db.prepare(`SELECT COUNT(*) n FROM identity_connections c WHERE ${where}`).get(...args).n;
   const rows=this.db.prepare(`SELECT c.* FROM identity_connections c WHERE ${where} ORDER BY c.updated DESC,c.connection_id LIMIT ? OFFSET ?`).all(...args,limit,offset);
   const current=`c.state NOT IN ('revoked','disabled') AND NOT ${expired}`;
   const counts=this.db.prepare(`SELECT COUNT(*) total,SUM(${current}) active,SUM(${current} AND c.profile='readonly') readonly,SUM(${current} AND c.profile='memory_readwrite') memory_readwrite,SUM(NOT ${expired} AND (c.state='draft' OR (c.state='ready' AND (c.binding_version IS NULL OR c.binding_version<>c.version OR c.binding_account_version<>?)))) pending FROM identity_connections c WHERE c.account_id=?`).get(this.ids.byId(account).security_version,account);
   // Inventory totals describe saved configurations; authorization totals must use live, owner-bound evidence.
   const grant=scope=>`EXISTS(SELECT 1 FROM oauth_records g,json_each(g.payload,'$.resources') s WHERE g.model='Grant' AND g.expires>:now AND json_extract(g.payload,'$.accountId')=:subject AND json_extract(g.payload,'$.clientId')=c.client_id AND s.key=:resource AND instr(' '||s.value||' ',' memory:read ')>0 AND instr(' '||s.value||' ',' ${scope} ')>0)`;
   const usable=`c.state='ready' AND c.binding_json IS NOT NULL AND c.binding_version=c.version AND c.binding_account_version=:security AND ((c.kind='chatgpt_oauth' AND ${grant('memory:read')}) OR (c.kind='generic_mcp' AND EXISTS(SELECT 1 FROM identity_connection_tokens t WHERE t.connection_id=c.connection_id AND t.account_id=c.account_id AND t.version=c.version AND t.security_version=:security AND t.revoked IS NULL AND t.expires>:now)))`;
   const authorization=this.db.prepare(`WITH inventory AS (SELECT c.*,COALESCE((${usable}),0) usable,(c.profile='memory_readwrite' AND (c.kind='generic_mcp' OR ${grant('memory:write')})) write_granted,(${expired}) expired FROM identity_connections c WHERE c.account_id=:account)
     SELECT SUM(usable) usable,SUM(usable AND NOT write_granted) readonly,SUM(usable AND write_granted) memory_readwrite,SUM(state IN ('draft','ready') AND NOT expired AND NOT usable) pending,SUM(usable AND health='verified') verified FROM inventory`).get({account,subject:owner.subject,security:owner.security_version,now:seconds(),resource:this.config.resource});
   return {connections:rows.map(r=>this.public(r)),total,offset,limit,next_offset:offset+rows.length<total?offset+rows.length:null,counts:Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,v??0])),authorization_counts:Object.fromEntries(Object.entries(authorization).map(([k,v])=>[k,v??0])),count_scope:'all_owned_logical_connections',capabilities:this.capabilities()};
 }
 detail(account,id){this.owner(account);const r=this.row(account,id);
   const grants=this.activeGrants(r);
   return {connection:{...this.public(r),active_grant_count:grants.length},guide:{transport:'Streamable HTTP',url:this.config.resource+(r.kind==='generic_mcp'?'/generic':''),resource:this.config.resource+(r.kind==='generic_mcp'?'/generic':''),authentication:r.kind==='generic_mcp'?'Personal resource token (custom Authorization header required)':'OAuth authorization_code + PKCE S256',token_endpoint_auth_method:r.kind==='chatgpt_oauth'?'client_secret_post':null,scopes:this.scopes(r),secret_placeholder:'<YOUR_PRIVATE_SECRET>',callback_source:'Copy the exact callback from the ChatGPT connection management screen; no wildcard.',not_a_universal_client_config:true,
     ...(r.kind==='chatgpt_oauth'?{oauth_scopes:this.oauthScopes(r),issuer:this.config.issuer,discovery_url:this.config.issuer+'/.well-known/openid-configuration?client_id='+encodeURIComponent(r.client_id),authorization_url:this.config.issuer+'/authorize',token_url:this.config.issuer+'/token'}:{}),timeout_seconds:30,
     tools:['mnemuron_auth_status','mnemuron_search_memories','mnemuron_get_memory',...(r.profile==='memory_readwrite'?['mnemuron_save_memory','mnemuron_supersede_memory','mnemuron_retract_memory','mnemuron_get_operation']:[])]},
     grants,
     keys:this.db.prepare('SELECT token_id,version,created,expires,revoked FROM identity_connection_tokens WHERE account_id=? AND connection_id=? ORDER BY created DESC,token_id LIMIT 50').all(account,id),
     activity:this.db.prepare('SELECT action,outcome,created FROM identity_connection_activity WHERE account_id=? AND connection_id=? ORDER BY created DESC,rowid DESC LIMIT 50').all(account,id),details_limit:50};
 }
 activity(r,action,outcome='success'){this.db.prepare('INSERT INTO identity_connection_activity VALUES(?,?,?,?,?,?)').run(randomUUID(),r.account_id,r.connection_id,action,outcome,seconds());this.ids.audit(r.account_id,action,outcome);}
 scopes(r){return ['memory:read',...(r.profile==='memory_readwrite'?['memory:write']:[])];}
 oauthScopes(r){return ['openid','offline_access',...this.scopes(r)];}
 discoveryScopes(id){const r=this.clientRow(id);
   if(!this.enabled()||!this.current(r)||!r.callback)fail('CONNECTION_NOT_FOUND',404);
   return this.oauthScopes(r).filter(scope=>scope!=='memory:write'||this.config.cloud_memory?.enabled===true);
 }
 client(id){const r=this.db.prepare("SELECT * FROM identity_connections WHERE client_id=? AND kind='chatgpt_oauth'").get(id);
   if(!this.enabled()||!this.current(r)||!r.callback)return undefined;
   return {client_id:r.client_id,client_secret:this.ids.unseal(r.secret_cipher,r.account_id,`connection-client:${r.connection_id}`),redirect_uris:[r.callback],
     token_endpoint_auth_method:'client_secret_post',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:this.oauthScopes(r).join(' '),id_token_signed_response_alg:'RS256'};
 }
 clientRow(id){return this.db.prepare("SELECT * FROM identity_connections WHERE client_id=? AND kind='chatgpt_oauth'").get(id);}
 permitsClient(id,subject){const r=this.clientRow(id);return !!r&&this.enabled()&&this.current(r)&&!!r.callback&&this.ids.byId(r.account_id)?.subject===subject;}
 claims(id,subject){if(!this.permitsClient(id,subject))return null;const r=this.clientRow(id);return {connection_id:r.connection_id,connection_version:r.version,connection_profile:r.profile,cloud_submitted_revision_grant:!!r.allow_submitted_revision_grant&&this.config.cloud_memory?.allow_submitted_revision_grant===true};}
 verifyPat(token,resource){
   if(!this.enabled()||resource!==this.config.resource+'/generic'||typeof token!=='string'||!/^mcp_pat_[A-Za-z0-9_-]{43}$/.test(token))return {active:false};
   const t=this.db.prepare('SELECT * FROM identity_connection_tokens WHERE digest=? AND revoked IS NULL AND expires>?').get(secretHash(token),seconds());
   const r=t&&this.db.prepare('SELECT * FROM identity_connections WHERE connection_id=? AND account_id=?').get(t.connection_id,t.account_id),a=r&&this.ids.byId(r.account_id);
   if(!t||!this.current(r)||r.kind!=='generic_mcp'||r.version!==t.version||a.security_version!==t.security_version)return {active:false};
   return {active:true,iss:this.config.issuer,aud:resource,sub:a.subject,account_id:a.account_id,security_version:a.security_version,client_id:r.client_id,token_kind:'connection_pat',token_type:'Bearer',token_id:t.token_id,exp:t.expires,scope:this.scopes(r).join(' '),connection_id:r.connection_id,connection_version:r.version,connection_profile:r.profile,cloud_submitted_revision_grant:!!r.allow_submitted_revision_grant&&this.config.cloud_memory?.allow_submitted_revision_grant===true};
 }
 markAuthorized(id,subject){if(!this.permitsClient(id,subject))return;const r=this.clientRow(id);this.db.prepare("UPDATE identity_connections SET health=CASE WHEN health='verified' THEN health ELSE 'authorized' END,last_authorized=? WHERE connection_id=?").run(seconds(),r.connection_id);this.activity(r,'connection.authorized');}
 markTool(claims,{failed=false}={}){const r=this.db.prepare('SELECT * FROM identity_connections WHERE connection_id=? AND account_id=?').get(claims.connection_id,claims.account_id);if(!r||!this.current(r)||r.version!==claims.connection_version)return false;
   if(failed){this.db.prepare("UPDATE identity_connections SET health='degraded',last_error='TOOL_FAILED' WHERE connection_id=?").run(r.connection_id);this.activity(r,'connection.tool_failed','failed');}
   else{this.db.prepare("UPDATE identity_connections SET health='verified',last_success=?,last_error=NULL WHERE connection_id=?").run(seconds(),r.connection_id);this.activity(r,'connection.tool_succeeded');}return true;}
 queue(r){const id=randomUUID(),kind=`connection-bind:${r.connection_id}:${r.version}`;
   this.db.prepare('INSERT OR IGNORE INTO identity_operations VALUES(?,?,?,?,?,?,?)').run(id,r.account_id,kind,'pending',null,null,seconds());}
 invalidate(r){this.ids.store.revoke({subject:this.ids.byId(r.account_id).subject,clientId:r.client_id});this.db.prepare('UPDATE identity_connection_tokens SET revoked=COALESCE(revoked,?) WHERE account_id=? AND connection_id=?').run(seconds(),r.account_id,r.connection_id);
   this.db.prepare("UPDATE identity_connection_operations SET secret_cipher=NULL WHERE account_id=? AND json_extract(result_json,'$.connection.connection_id')=?").run(r.account_id,r.connection_id);
   this.db.prepare('UPDATE identity_connection_credentials SET revoked=1 WHERE account_id=? AND connection_id=?').run(r.account_id,r.connection_id);}
 currentSession(account,session){const a=this.owner(account),s=this.db.prepare("SELECT * FROM identity_sessions WHERE digest=? AND account_id=? AND purpose='console' AND expires>?").get(session.digest,account,seconds());if(!s||s.security_version!==a.security_version||session.security_version!==a.security_version)fail('SESSION_REQUIRED',401);return a;}
 previous(account,session,action,p,operation){const row=this.db.prepare('SELECT * FROM identity_connection_operations WHERE account_id=? AND operation_id=?').get(account,operation);if(!row)return null;
   if(row.action!==action||row.request_hash!==this.ids.console.requestHash(account,operation,action,p))fail('IDEMPOTENCY_CONFLICT',409);
   if(row.session_digest!==session.digest)fail('SECRET_SESSION_MISMATCH',403);
   const out=JSON.parse(row.result_json),current=this.row(account,out.connection.connection_id);
   return {...out,connection:this.public(current),replayed:true,...(row.secret_cipher&&row.secret_expires>seconds()&&out.connection.version===current.version&&!['revoked','disabled'].includes(current.state)?{secret:this.ids.unseal(row.secret_cipher,account,`connection-result:${operation}:${session.digest}`),secret_expires_at:row.secret_expires}:{secret_expired:true})};}
 async execute(account,session,action,input,operation){
   const policy=this.policy();this.currentSession(account,session);if(!connectionActions.includes(action)||typeof operation!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(operation))fail();
   const allowed=action==='connections.create'?['kind','label','description','profile','allow_submitted_revision_grant','ttl_seconds','redirect_uri']:action==='connections.update'?['connection_id','label','description','profile','redirect_uri','allow_submitted_revision_grant','ttl_seconds']:['connection_id','ttl_seconds'];
   fields(input,[...allowed,'current_password','otp']);const {current_password,otp,...p}=input;
   const prior=this.previous(account,session,action,p,operation);if(prior)return prior;
   if(p.connection_id)this.row(account,p.connection_id);
   await this.ids.console.proof(account,{current_password,otp});this.currentSession(account,session);
   return this.ids.store.transaction(()=>{
     const a=this.currentSession(account,session),prior=this.previous(account,session,action,p,operation);if(prior)return prior;
     let r,secret;
     if(action==='connections.create'){
       if(!['chatgpt_oauth','generic_mcp'].includes(p.kind)||!text(p.label,80)||p.description!==undefined&&(!text(p.description,400)&&p.description!==''))fail();
       if(this.db.prepare("SELECT COUNT(*) n FROM identity_connections WHERE account_id=? AND state<>'revoked'").get(account).n>=policy.max_connections)fail('CONNECTION_QUOTA',409);
       const id=secretHash(randomSecret());r={connection_id:id,account_id:account,kind:p.kind,label:p.label.trim(),description:p.description||'',profile:p.profile,state:p.kind==='generic_mcp'||p.redirect_uri!==undefined?'ready':'draft',health:'never_used',client_id:`mnmc_${randomSecret()}`,secret_cipher:null,
         callback:p.redirect_uri===undefined?null:p.kind==='chatgpt_oauth'?exactChatgptCallback(p.redirect_uri,{isolated:this.config.isolated}):fail(),allow_submitted_revision_grant:p.allow_submitted_revision_grant===true?1:0,version:1,created:seconds(),updated:seconds()};
       if(r.kind==='chatgpt_oauth'){secret=randomSecret();r.secret_cipher=this.ids.seal(secret,account,`connection-client:${id}`);}
       this.validateProfile(r,p);
       const keys=Object.keys(r);this.db.prepare(`INSERT INTO identity_connections(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>r[k]));
     }else{
       r=this.row(account,p.connection_id);if(r.state==='revoked')fail('CONNECTION_REVOKED',409);
       if(action==='connections.update'){
         if(p.label!==undefined){if(!text(p.label,80))fail();r.label=p.label.trim();}if(p.description!==undefined){if(!text(p.description,400)&&p.description!=='')fail();r.description=p.description;}
         if(p.profile!==undefined)r.profile=p.profile;
         if(p.allow_submitted_revision_grant!==undefined){if(typeof p.allow_submitted_revision_grant!=='boolean')fail();r.allow_submitted_revision_grant=p.allow_submitted_revision_grant?1:0;}
         if(p.redirect_uri!==undefined){if(r.kind!=='chatgpt_oauth')fail();r.callback=exactChatgptCallback(p.redirect_uri,{isolated:this.config.isolated});}
       }
       this.validateProfile(r,p);this.invalidate(r);r.version++;r.updated=seconds();r.health='never_used';r.last_error=null;
       if(action==='connections.disable')r.state='disabled';else if(action==='connections.revoke')r.state='revoked';else if(action==='connections.enable'||action==='connections.update')r.state=r.kind==='generic_mcp'||r.callback?'ready':'draft';
       if(action==='connections.revoke')r.secret_cipher=null;
       if(['connections.rotate','connections.enable'].includes(action)&&r.kind==='chatgpt_oauth'){secret=randomSecret();r.secret_cipher=this.ids.seal(secret,account,`connection-client:${r.connection_id}`);}
       this.db.prepare('UPDATE identity_connections SET label=?,description=?,profile=?,state=?,health=?,version=?,updated=?,callback=?,secret_cipher=?,allow_submitted_revision_grant=?,last_error=NULL WHERE account_id=? AND connection_id=?').run(r.label,r.description,r.profile,r.state,r.health,r.version,r.updated,r.callback,r.secret_cipher,r.allow_submitted_revision_grant,account,r.connection_id);
     }
     if(!['disabled','revoked'].includes(r.state)){
       if(r.kind==='generic_mcp'){
         const ttl=p.ttl_seconds??policy.pat_default_ttl_seconds;if(!Number.isSafeInteger(ttl)||ttl<60||ttl>policy.pat_max_ttl_seconds)fail('INVALID_TOKEN_LIFETIME');
         secret=`mcp_pat_${randomSecret()}`;this.db.prepare('INSERT INTO identity_connection_tokens VALUES(?,?,?,?,?,?,?,?,NULL)').run(randomUUID(),account,r.connection_id,secretHash(secret),r.version,a.security_version,seconds(),seconds()+ttl);
       }
       this.queue(r);
     }
     const out={status:r.state,connection:this.public(this.row(account,r.connection_id)),operation_id:operation,secret_kind:secret?(r.kind==='generic_mcp'?'personal_token':'oauth_client_secret'):null,
       expires_at:r.kind==='generic_mcp'?this.db.prepare('SELECT MAX(expires) exp FROM identity_connection_tokens WHERE account_id=? AND connection_id=? AND version=?').get(account,r.connection_id,r.version).exp:null};
     this.db.prepare('INSERT INTO identity_connection_operations VALUES(?,?,?,?,?,?,?,?,?)').run(account,operation,action,this.ids.console.requestHash(account,operation,action,p),session.digest,JSON.stringify(out),secret?this.ids.seal(secret,account,`connection-result:${operation}:${session.digest}`):null,seconds()+policy.secret_receipt_ttl_seconds,seconds());
     this.activity(r,action);return {...out,...(secret?{secret,secret_expires_at:seconds()+policy.secret_receipt_ttl_seconds}:{})};
   });
 }
 validateProfile(r,p){if(!['readonly','memory_readwrite'].includes(r.profile)||p.allow_submitted_revision_grant!==undefined&&typeof p.allow_submitted_revision_grant!=='boolean')fail();
   if(r.profile==='memory_readwrite'&&this.config.cloud_memory?.enabled!==true)fail('CLOUD_WRITE_NOT_ENABLED',403);
   if(r.allow_submitted_revision_grant&&(r.profile!=='memory_readwrite'||!this.config.cloud_memory?.allow_submitted_revision_grant))fail('CLOUD_READ_POLICY_DENIED',403);}
 cleanup(){this.db.prepare('UPDATE identity_connection_operations SET secret_cipher=NULL WHERE secret_expires<=? AND secret_cipher IS NOT NULL').run(seconds());}
}

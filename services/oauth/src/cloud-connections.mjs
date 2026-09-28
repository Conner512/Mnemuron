import {randomUUID} from 'node:crypto';
import {BoundaryError,randomSecret,secretHash,seconds} from '../../../shared/oauth-common.mjs';
import {connectionScopes,connectionPolicy} from '../../../shared/cloud-contract.mjs';

const fail=(code,status=400)=>{throw new BoundaryError(status,code);};
const identifier=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const fields=(p,allowed)=>{if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!allowed.includes(k)))fail('INVALID_CONNECTION_INPUT');};
export class CloudConnections {
  constructor(ids,config) {
    this.ids=ids;this.db=ids.db;this.config=config;
    this.db.exec(`CREATE TABLE IF NOT EXISTS identity_cloud_connections (
      connection_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,
      permission TEXT NOT NULL,client_id TEXT NOT NULL UNIQUE,secret_cipher TEXT,token_hash TEXT UNIQUE,
      redirect_uri TEXT,created INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER,security_version INTEGER NOT NULL,
      last_used INTEGER);
      CREATE INDEX IF NOT EXISTS identity_cloud_owner ON identity_cloud_connections(account_id,created,connection_id);`);
  }
  policy(){return connectionPolicy(this.config);}
  active(row){const a=row&&this.ids.byId(row.account_id);return !!a&&this.policy().enabled&&this.ids.eligible(a.subject)&&!row.revoked&&row.expires>seconds()&&row.security_version===a.security_version&&(!this.isWriter(row)||this.policy().allow_write);}
  isWriter(row){return row?.permission==='readwrite';}
  row(id){return this.db.prepare('SELECT * FROM identity_cloud_connections WHERE connection_id=?').get(id);}
  client(id){const row=this.db.prepare("SELECT * FROM identity_cloud_connections WHERE client_id=? AND kind='chatgpt'").get(id);return this.active(row)?row:null;}
  clientAllowed(id,subject){const row=this.client(id);return !!row&&(!subject||this.ids.account(subject)?.account_id===row.account_id);}
  clientDefinition(id) {const r=this.client(id);if(!r)return undefined;
    return {client_id:r.client_id,client_secret:this.ids.unseal(r.secret_cipher,r.account_id,`client:${r.connection_id}`),
      client_secret_expires_at:r.expires,client_name:r.label,token_endpoint_auth_method:'client_secret_post',redirect_uris:[r.redirect_uri],
      grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:connectionScopes(r.permission,true).join(' '),id_token_signed_response_alg:'RS256'};
  }
  presentation(r){const a=this.ids.byId(r.account_id);return {connection_id:r.connection_id,kind:r.kind,label:r.label,permission:r.permission,
    client_id:r.kind==='chatgpt'?r.client_id:undefined,mcp_url:this.config.resource+(this.isWriter(r)?'?access=readwrite':''),redirect_uri:r.redirect_uri,created:r.created,expires:r.expires,last_used:r.last_used,
    status:r.revoked?'revoked':r.expires<=seconds()?'expired':r.security_version!==a?.security_version?'reauthorize':this.active(r)?'active':'disabled'};}
  list(account,{status='active',offset=0,limit=20,kind='',query=''}={}) {
    if(!['active','history','all'].includes(status)||!Number.isSafeInteger(offset)||offset<0||offset>100000||!Number.isSafeInteger(limit)||limit<1||limit>50)fail('INVALID_CONNECTION_FILTER');
    if(!['','chatgpt','mcp'].includes(kind)||typeof query!=='string'||query.length>100)fail('INVALID_CONNECTION_FILTER');
    const a=this.ids.byId(account),now=seconds(),live='revoked IS NULL AND expires>? AND security_version=?';
    let filter=status==='all'?'1=1':status==='active'?`(${live})`:`NOT (${live})`,args=status==='all'?[account]:[account,now,a.security_version];
    if(kind){filter+=' AND kind=?';args.push(kind);}
    if(query){filter+=' AND (instr(lower(label),lower(?))>0 OR instr(connection_id,?)>0)';args.push(query,query);}
    const count=this.db.prepare(`SELECT COUNT(*) n FROM identity_cloud_connections WHERE account_id=? AND ${filter}`).get(...args).n;
    const rows=this.db.prepare(`SELECT * FROM identity_cloud_connections WHERE account_id=? AND ${filter} ORDER BY created DESC,connection_id LIMIT ? OFFSET ?`).all(...args,limit,offset);
    const active=this.db.prepare(`SELECT COUNT(*) n FROM identity_cloud_connections WHERE account_id=? AND ${live}`).get(account,now,a.security_version).n;
    return {items:rows.map(r=>this.presentation(r)),total:count,active_count:active,offset,limit,next_offset:offset+rows.length<count?offset+rows.length:null};
  }
  callback(uri) {
    if(typeof uri!=='string'||uri.length>2048||/[\s*]/.test(uri))fail('INVALID_REDIRECT_URI');
    let u;try{u=new URL(uri);}catch{fail('INVALID_REDIRECT_URI');}
    if(u.username||u.password||u.hash||u.search||u.href!==uri)fail('INVALID_REDIRECT_URI');
    if(this.config.isolated){if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname))fail('INVALID_REDIRECT_URI');}
    else if(u.protocol!=='https:'||u.hostname!=='chatgpt.com'||u.port||!(u.pathname==='/connector_platform_oauth_redirect'||/^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(u.pathname)))fail('INVALID_REDIRECT_URI');
    return uri;
  }
  async execute(account,session,action,p,operation,{enableWriter}={}) {
    if(!this.policy().enabled)fail('CLOUD_CONNECTIONS_DISABLED',403);
    if(!identifier(operation))fail('INVALID_OPERATION_ID');
    const allowed=action==='cloud_connections.create'?['kind','label','permission','ttl_days','redirect_uri']:['connection_id'];
    fields(p,[...allowed,'current_password','otp']);
    if(!['cloud_connections.create','cloud_connections.rotate','cloud_connections.revoke'].includes(action))fail('UNKNOWN_ACTION',404);
    const old=this.ids.console.previous(account,operation,action,p);if(old){this.checkSession(account,session);return {...old,...(old.connection_id?{connection:this.presentation(this.row(old.connection_id))}:{})};}
    let row;
    if(action==='cloud_connections.create'){
      if(!['chatgpt','mcp'].includes(p.kind)||typeof p.label!=='string'||!p.label.trim()||p.label.length>100||/[\u0000-\u001f]/.test(p.label)||!['readonly','readwrite'].includes(p.permission))fail('INVALID_CONNECTION_INPUT');
      if(!Number.isSafeInteger(p.ttl_days)||p.ttl_days<1||p.ttl_days>this.policy().max_ttl_days)fail('INVALID_CONNECTION_TTL');
      if(p.kind==='chatgpt')this.callback(p.redirect_uri);else if(p.redirect_uri)fail('INVALID_REDIRECT_URI');
      row={connection_id:randomUUID(),account_id:account,kind:p.kind,label:p.label.trim(),permission:p.permission,expires:seconds()+p.ttl_days*86400,redirect_uri:p.redirect_uri||null};
    }else {row=this.row(p.connection_id);if(!row||row.account_id!==account)fail('CONNECTION_NOT_FOUND',404);}
    if(action!=='cloud_connections.revoke'&&this.isWriter(row)&&!this.policy().allow_write)fail('CLOUD_WRITE_DISABLED',403);
    await this.ids.console.proof(account,p);this.checkSession(account,session);
    if(action!=='cloud_connections.revoke'&&this.isWriter(row)){
      if(typeof enableWriter!=='function')fail('CLOUD_WRITE_BINDING_REQUIRED',503);
      await enableWriter();this.checkSession(account,session);
    }
    return this.ids.store.transaction(()=>{
      const actor=this.checkSession(account,session),previous=this.ids.console.previous(account,operation,action,p);if(previous)return previous;
      let result;
      if(action==='cloud_connections.revoke'){
        this.db.prepare('UPDATE identity_cloud_connections SET revoked=COALESCE(revoked,?) WHERE connection_id=? AND account_id=?').run(seconds(),row.connection_id,account);
        this.ids.store.revoke({subject:actor.subject,clientId:row.client_id});result={status:'revoked',connection_id:row.connection_id};
      }else{
        if(action==='cloud_connections.create'&&this.list(account).active_count>=this.policy().max_active)fail('CONNECTION_LIMIT',409);
        if(action==='cloud_connections.rotate'){
          const current=this.row(row.connection_id);if(current.revoked)fail('CONNECTION_REVOKED',409);
          if(current.expires<=seconds())fail('CONNECTION_EXPIRED',409);
          this.ids.store.revoke({subject:actor.subject,clientId:current.client_id});
        }
        // Rotation changes client_id too, so the provider cannot serve a cached old secret.
        const client_id=`mnmconn_${randomSecret()}`,secret=randomSecret(),token=`mnmc_${randomSecret()}`;
        const cipher=row.kind==='chatgpt'?this.ids.seal(secret,account,`client:${row.connection_id}`):null;
        this.db.prepare(`INSERT INTO identity_cloud_connections VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,NULL)
          ON CONFLICT(connection_id) DO UPDATE SET client_id=excluded.client_id,secret_cipher=excluded.secret_cipher,token_hash=excluded.token_hash,security_version=excluded.security_version`)
          .run(row.connection_id,account,row.kind,row.label,row.permission,client_id,cipher,row.kind==='mcp'?secretHash(token):null,row.redirect_uri,seconds(),row.expires,actor.security_version);
        result={status:action.endsWith('create')?'created':'rotated',connection_id:row.connection_id,resource:this.config.resource,
          connection:this.presentation(this.row(row.connection_id)),scopes:connectionScopes(row.permission,row.kind==='chatgpt'),
          ...(row.kind==='chatgpt'?{client_id,client_secret:secret}:{access_token:token,token_type:'Bearer'}),
          secret_replay_seconds:600};
      }
      return this.ids.console.record(account,operation,action,p,result);
    });
  }
  checkSession(account,s){const a=this.ids.byId(account),row=this.db.prepare("SELECT 1 FROM identity_sessions WHERE digest=? AND account_id=? AND purpose='console' AND security_version=? AND expires>?").get(s.digest,account,s.security_version,seconds());if(!row||!this.ids.eligible(a?.subject)||a.security_version!==s.security_version)fail('SESSION_REQUIRED',401);return a;}
  inspectToken(token) {
    if(typeof token!=='string'||!/^mnmc_[A-Za-z0-9_-]{43}$/.test(token))return {active:false};
    const r=this.db.prepare("SELECT * FROM identity_cloud_connections WHERE token_hash=? AND kind='mcp'").get(secretHash(token));
    if(!this.active(r))return {active:false};const a=this.ids.byId(r.account_id);this.used(r);
    return {active:true,iss:this.config.issuer,aud:this.config.resource,exp:r.expires,iat:r.created,client_id:r.client_id,sub:a.subject,
      account_id:a.account_id,security_version:a.security_version,scope:connectionScopes(r.permission).join(' '),token_type:'Bearer',token_kind:'access_token',
      mnemuron_connection_id:r.connection_id,mnemuron_connection_kind:'mcp',mnemuron_connection_verified:true};
  }
  used(r){this.db.prepare('UPDATE identity_cloud_connections SET last_used=? WHERE connection_id=? AND (last_used IS NULL OR last_used<?)').run(seconds(),r.connection_id,seconds()-60);}
  extraClaims(token){const r=this.client(token.clientId);if(!r||!this.clientAllowed(token.clientId,token.accountId))return {};return {mnemuron_connection_id:r.connection_id,mnemuron_connection_kind:'chatgpt',mnemuron_connection_verified:true};}
}
export function oauthClient(config,accounts,id) {
  if(id===config.chatgpt_client.client_id)return {client_id:id,redirect_uris:config.chatgpt_client.redirect_uris,scopes:config.chatgpt_client.allowed_scopes,legacy:true};
  const r=accounts.connections?.client(id);return r?{client_id:id,redirect_uris:[r.redirect_uri],scopes:connectionScopes(r.permission,true),legacy:false,row:r}:null;
}

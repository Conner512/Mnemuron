import QRCode from 'qrcode';
import {BoundaryError,parseForm,readBody,sendJson} from '../../../shared/oauth-common.mjs';
import {routeTitle,sendPage,label,escapeHtml,serveAsset} from '../../../web/console/render.mjs';
import {text} from '../../../web/console/catalog.mjs';

const field=(name,key,{type='text',autocomplete='off',pattern,maxlength=1024,value=''}={})=>`<label for="${name}" data-i18n="${key}">${text(key)}</label><input id="${name}" name="${name}" type="${type}" autocomplete="${autocomplete}" maxlength="${maxlength}"${pattern?` pattern="${pattern}" inputmode="numeric"`:''} value="${escapeHtml(value)}" required>${type==='password'?`<button type="button" data-password-toggle="${name}" data-i18n="showPassword">${text('showPassword')}</button>`:''}`;
const form=(action,csrf,fields,submit='continue')=>`<form method="post" action="${action}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">${fields}<button class="primary" type="submit" data-i18n="${submit}">${text(submit)}</button></form>`;
const redirect=(response,to)=>{response.writeHead(303,{location:to,'cache-control':'no-store'});response.end();};
const names=(config,purpose)=>`${config.isolated?'mnm_fixture_':'__Host-mnm_'}${purpose}`;
function cookie(request,config,purpose) {
  const name=names(config,purpose),values=(request.headers.cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(`${name}=`));
  if(values.length!==1)return '';return values[0].slice(name.length+1);
}
function setCookie(response,config,purpose,token,maxAge=600) {
  response.setHeader('set-cookie',`${names(config,purpose)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.isolated?'':'; Secure'}`);
}
function paramsOnly(body,names) {if([...body.keys()].some(k=>!names.includes(k)))throw new BoundaryError(400,'UNEXPECTED_FIELD');}

export async function consoleRequest(request,response,{config,accounts,store,url,coreFor,invalidateAuthorization}) {
  if(serveAsset(request,response,url.pathname))return true;
  if(!['/register','/login','/recover','/app'].some(p=>url.pathname===p||url.pathname.startsWith(p+'/'))&&!url.pathname.startsWith('/console-api/'))return false;
  if(config.identity_mode!=='multi_account_v1')throw new BoundaryError(503,'IDENTITY_UPGRADE_REQUIRED');
  const ids=accounts,pathname=url.pathname;
  let body;
  if(request.method==='POST') {
    if(request.headers.origin!==config.issuer)throw new BoundaryError(403,'ORIGIN_DENIED');
    if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers['content-type']||''))throw new BoundaryError(415,'FORM_REQUIRED');
    body=parseForm(await readBody(request,Math.min(8192,config.limits.request_body_bytes)));
  }
  const show=(title,content)=>{sendPage(response,{title,body:content,auth:true});return true;};
  const submit=(purpose,allowed)=>{
    paramsOnly(body,['csrf',...allowed]);const token=cookie(request,config,purpose);
    ids.session(token,purpose,{csrf:body.get('csrf')||''});return token;
  };
  if(pathname==='/recover') {
    if(request.method!=='GET')throw new BoundaryError(403,'BLOCKED_POLICY');
    return show('recover',`<div class="policy-box" data-policy="blocked_policy">${label('blocked','h2')}${label('securityNote','p')}</div><a href="/login" data-i18n="signIn">${text('signIn')}</a>`);
  }
  if(pathname.startsWith('/register')) {
    if(!config.login.registration_enabled)throw new BoundaryError(403,'REGISTRATION_DISABLED');
    if(pathname==='/register'&&request.method==='GET') {
      const s=ids.newSession('registration_start',{ttl:600});setCookie(response,config,'registration_start',s.token);
      return show('register',label('inviteNote','p')+form('/register/reserve',s.csrf,field('code','invitation',{maxlength:43})));
    }
    if(pathname==='/register/reserve'&&request.method==='POST') {
      const old=submit('registration_start',['code']);store.limit(`registration:peer:${request.socket.remoteAddress}`,30,900);
      const s=ids.reserveInvitation(body.get('code'));ids.revokeSession(old);setCookie(response,config,'registration',s.token);
      redirect(response,'/register/account');return true;
    }
    const token=cookie(request,config,'registration');const state=ids.registrationState(token);
    if(pathname==='/register/account'&&request.method==='GET'&&state.status==='reserved')
      return show('register',form('/register/account',ids.formCsrf(token,'registration'),field('username','username',{autocomplete:'username',maxlength:100})+field('password','password',{type:'password',autocomplete:'new-password'})+field('password_confirm','passwordConfirm',{type:'password',autocomplete:'new-password'})));
    if(pathname==='/register/account'&&request.method==='POST') {
      submit('registration',['username','password','password_confirm']);
      store.limit(`registration:account:${String(body.get('username')||'').toLowerCase()}`,10,900);
      if(body.get('password')!==body.get('password_confirm'))throw new BoundaryError(400,'PASSWORD_CONFIRMATION_FAILED');
      await ids.prepareRegistration(token,body.get('username'),body.get('password'));redirect(response,'/register/totp');return true;
    }
    if(pathname==='/register/totp'&&request.method==='GET') {
      const setup=ids.enrollment(token),qr=setup.uri?await QRCode.toString(setup.uri,{type:'svg',errorCorrectionLevel:'M',margin:4}):null;
      return show('totp',(qr?label('totpNote','p')+`<div class="qr" role="img" aria-label="TOTP QR">${qr}</div><code class="secret" id="totp-secret">${escapeHtml(setup.secret)}</code><button type="button" data-copy="totp-secret" data-i18n="copy">${text('copy')}</button>`:label('alreadyShown','p'))+
        form('/register/totp',ids.formCsrf(token,'registration'),field('otp','otp',{autocomplete:'one-time-code',pattern:'[0-9]{6}',maxlength:6}),'verify'));
    }
    if(pathname==='/register/totp'&&request.method==='POST') {
      submit('registration',['otp']);store.limit(`enroll:${state.account_id}`,10,900);
      await ids.verifyEnrollment(token,body.get('otp'));redirect(response,'/register/recovery-codes');return true;
    }
    if(pathname==='/register/recovery-codes'&&request.method==='GET') {
      const codes=state.recovery_available?ids.takeRecoveryCodes(token):null;
      if(!['provisioning','active'].includes(state.status))throw new BoundaryError(400,'REGISTRATION_UNAVAILABLE');
      return show('recoveryCodes',(codes?label('recoveryNote','p')+`<ul class="recovery-codes">${codes.map(c=>`<li>${escapeHtml(c)}</li>`).join('')}</ul>`:label('alreadyShown','p'))+form('/register/ack',ids.formCsrf(token,'registration'),'','acknowledge'));
    }
    if(pathname==='/register/ack'&&request.method==='POST') {
      submit('registration',[]);ids.acknowledgeRecovery(token);redirect(response,'/register/status');return true;
    }
    if(pathname==='/register/status'&&request.method==='GET') return show(state.status==='active'?'registered':'pending',
      label(state.status==='active'?'registered':'pendingNote','p')+`<p><code>${escapeHtml(state.status)}</code></p><a href="${state.status==='active'?'/login':'/register/status'}" data-i18n="${state.status==='active'?'signIn':'retry'}">${text(state.status==='active'?'signIn':'retry')}</a>`);
    throw new BoundaryError(404,'NOT_FOUND');
  }
  if(pathname==='/login') {
    if(request.method==='GET') {
      const s=ids.newSession('login',{ttl:600});setCookie(response,config,'login',s.token);
      return show('consoleLogin',label('consoleLoginNote','p')+label('authNote','p')+form('/login',s.csrf,field('username','username',{autocomplete:'username',maxlength:100})+field('password','password',{type:'password',autocomplete:'current-password'})+field('otp','otp',{autocomplete:'one-time-code',pattern:'[0-9]{6}',maxlength:6}),'signIn')+`<div class="form-links"><a href="/register" data-i18n="register">${text('register')}</a><a href="/recover" data-i18n="recover">${text('recover')}</a></div>`);
    }
    if(request.method==='POST') {
      const old=submit('login',['username','password','otp']);
      store.limit(`login:account:${String(body.get('username')||'').toLowerCase()}`,config.limits.login_attempts_per_account_per_15min,900);
      store.limit(`login:peer:${request.socket.remoteAddress}`,100,900);
      const subject=await ids.authenticate(body.get('username'),body.get('password'),body.get('otp'));
      if(!subject)throw new BoundaryError(401,'LOGIN_FAILED');
      await invalidateAuthorization(subject);
      const s=ids.newSession('console',{accountId:ids.account(subject).account_id});ids.revokeSession(old);
      const previous=cookie(request,config,'console');if(previous)ids.revokeSession(previous);
      setCookie(response,config,'console',s.token,config.identity.console_session_ttl_seconds);redirect(response,'/app');return true;
    }
  }
  const token=cookie(request,config,'console');let session;
  try{session=ids.session(token,'console');}catch(error){if(routeTitle(pathname)&&request.method==='GET'){redirect(response,'/login');return true;}throw error;}
  const account=ids.byId(session.account_id),principal=ids.principal(account.subject);
  if(routeTitle(pathname)&&request.method==='GET') {
    sendPage(response,{title:routeTitle(pathname),page:routeTitle(pathname),account,csrf:ids.formCsrf(token,'console')});return true;
  }
  if(pathname==='/console-api/me'&&request.method==='GET') {
    sendJson(response,200,{account_id:principal.account_id,username:account.username,mfa_verified:!!account.mfa_verified,security_version:principal.security_version,csrf:ids.formCsrf(token,'console'),production_ready:false});return true;
  }
  if(pathname==='/console-api/logout'&&request.method==='POST') {
    submit('console',[]);ids.revokeSession(token);await invalidateAuthorization();setCookie(response,config,'console','',0);response.setHeader('clear-site-data','"cache"');redirect(response,'/login');return true;
  }
  if(pathname==='/console-api/security'&&request.method==='GET') {
    const sessions=ids.db.prepare("SELECT purpose,created,expires FROM identity_sessions WHERE account_id=? AND purpose='console' AND expires>strftime('%s','now')").all(account.account_id);
    sendJson(response,200,{username:account.username,mfa_verified:!!account.mfa_verified,security_version:account.security_version,sessions,recovery_policy:'blocked_policy',operations:'blocked_policy'});return true;
  }
  if(pathname==='/console-api/connections'&&request.method==='GET') {
    const grants=store.db.prepare("SELECT payload,expires FROM oauth_records WHERE model='Grant' AND json_extract(payload,'$.accountId')=? AND expires>strftime('%s','now')").all(account.subject)
      .map(row=>({client_id:JSON.parse(row.payload).clientId,expires:row.expires}));
    const core=await coreFor(account.subject).view('connections',{});ids.session(token,'console');
    sendJson(response,200,{connections:grants,core_connections:core.connections,physical_device_verified:false,operations:'blocked_policy'});return true;
  }
  if(pathname==='/console-api/audit'&&request.method==='GET') {
    const core=await coreFor(account.subject).view('audit',{});ids.session(token,'console');
    sendJson(response,200,{entries:ids.db.prepare('SELECT audit_id,action,outcome,created FROM identity_audit WHERE account_id=? ORDER BY created DESC,rowid DESC LIMIT 100').all(account.account_id),core_entries:core.entries,read_only:true});return true;
  }
  if(['/console-api/models','/console-api/invitations','/console-api/accounts'].includes(pathname))throw new BoundaryError(403,'BLOCKED_POLICY');
  if(coreFor && request.method==='GET' && /^\/console-api\/(overview|memories|summaries|summary|jobs|storage|memory)$/.test(pathname)) {
    const core=coreFor(account.subject),view=pathname.slice('/console-api/'.length);
    const result=await core.view(view,Object.fromEntries(url.searchParams));
    ids.session(token,'console'); // Do not send a response after revocation raced an awaited Core read.
    ids.audit(account.account_id,`console.read.${view}`);sendJson(response,200,result);return true;
  }
  if(pathname.startsWith('/console-api/')&&request.method!=='GET')throw new BoundaryError(403,'BLOCKED_POLICY');
  throw new BoundaryError(404,'NOT_FOUND');
}

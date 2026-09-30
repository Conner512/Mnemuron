import {translate as t,syncAppearance} from './appearance.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const l=(k,tag='span')=>`<${tag} data-i18n="${k}">${esc(t(k))}</${tag}>`;
const date=v=>v?new Date(v*1000).toLocaleString(document.documentElement.lang):'—';
const choices=(name,key,items,value='')=>`<label>${l(key)}<select name="${name}">${items.map(([v,k])=>`<option value="${esc(v)}" data-i18n="${k}" ${v===value?'selected':''}>${esc(t(k))}</option>`).join('')}</select></label>`;
const field=(name,key,value='',extra='')=>`<label>${l(key)}<input name="${name}" value="${esc(value)}" ${extra}></label>`;
const pair=(key,value)=>`<dt>${l(key)}</dt><dd>${esc(value??'—')}</dd>`;
const enabled=c=>c.allowed_actions?.includes('connections.create')===true;
const kindKeys={chatgpt_oauth:'connChatGPT',generic_mcp:'connGeneric',agent_placeholder:'connAgent'};
// Keys the platform manages (console, ChatGPT web gateway) are listed but never revoked here.
const MANAGED=['mnemuron-console','chatgpt-web'];
const agentKeys={chatgpt:'agent_chatgpt',openclaw:'agent_openclaw',hermes:'agent_hermes',mnemuron:'agent_mnemuron','mnemuron-console':'agent_console','chatgpt-web':'agent_chatgpt_web'};
const agentName=c=>agentKeys[c.agent_id]?l(agentKeys[c.agent_id]):`<span>${esc(c.agent_id)}</span>`;
// OAuth times are epoch seconds, Core times ISO strings.
const ms=v=>v==null||v===''?0:typeof v==='number'?(v<1e12?v*1000:v):Date.parse(v)||0;
const when=v=>{const n=ms(v);return n?new Date(n).toLocaleString(document.documentElement.lang):'—';};
const writes=c=>c.scopes.some(s=>s==='memory:write'||s==='capture:write');
const valuePair=(key,valueKey)=>`<dt>${l(key)}</dt><dd>${l(valueKey)}</dd>`;
const credential=c=>{const state=c.state||(c.revoked_at?'revoked':'active'),managed=c.managed??MANAGED.includes(c.agent_id);
  return {...c,scopes:Array.isArray(c.scopes)?c.scopes:[],state,managed,console_revocable:c.console_revocable??(state==='active'&&!managed)};};

/** One inventory for every kind of connection, so the counts match what the page lists. */
export function connectionInventory(data,caps={}){
 const grants=(data.legacy_connections||[]).flatMap(c=>c.grants||[]),creds=(data.core_connections||[]).map(credential);
 const firsts=grants.map(g=>ms(g.created)).filter(Boolean);
 // Last sign of use: the gateway key's last Core call or the last token ChatGPT obtained.
 const last=Math.max(0,...creds.filter(c=>c.agent_id==='chatgpt-web'&&c.state==='active').map(c=>ms(c.last_used_at)),ms(data.system_chatgpt?.last_token_at));
 const chatgpt={configured:data.system_chatgpt?.configured===true||grants.length>0,authorized:grants.length>0,grants,first:firsts.length?Math.min(...firsts):0,last,read_all:caps.web_policy?.read_all===true};
 const devices=creds.filter(c=>c.state==='active'&&!c.managed),managed=creds.filter(c=>c.state==='active'&&c.managed),history=creds.filter(c=>c.state!=='active');
 const r=data.counts||{},web=chatgpt.authorized?1:0;
 return {chatgpt,devices,managed,history,counts:{active:web+(r.active||0)+devices.length,readonly:web+(r.readonly||0)+devices.filter(c=>!writes(c)).length,
   readwrite:(r.memory_readwrite||0)+devices.filter(writes).length,pending:r.pending||0}};
}
function chatgptCard(c,caps){
 if(!c.configured)return '';
 const revoke=caps.allowed_actions?.includes('oauth.revoke');
 const rows=c.grants.map(g=>`<tr><td>${esc(when(g.created))}</td><td>${esc(when(g.expires))}</td><td>${(g.scopes||[]).filter(s=>s!=='openid').map(s=>`<code>${esc(s)}</code>`).join(' ')||'—'}</td>
   <td>${revoke?`<button type="button" data-console-action="oauth.revoke" data-id="${esc(g.grant_id)}">${l('connRevokeGrant')}</button>`:''}</td></tr>`).join('');
 return `<section class="card connection-chatgpt"><header class="section-head"><h2>${l('connChatGPTWeb')}</h2><span class="state-dot" data-state="${c.authorized?'enabled':'disabled'}">${l(c.authorized?'connAuthorized':'connNotAuthorized')}</span></header>
 ${l('connChatGPTWebNote','p')}<dl class="metadata-grid">${valuePair('access','readOnly')}<dt>${l('connReadScope')}</dt><dd>${l(c.read_all?'connReadAll':'connReadGranted')} · <a href="/app/privacy">${l('connAdjust')}</a></dd>
 <dt>${l('connGrantsLabel')}</dt><dd>${esc(c.grants.length)}</dd>${pair('connFirstAuthorized',c.first?when(c.first):null)}${pair('connLastActivity',c.last?when(c.last):null)}</dl>
 ${rows?`<details class="connection-grants"><summary>${l('connGrantList')}</summary><div class="table-scroll"><table><thead><tr>${['connAuthorizedAt','expires','scope','actions'].map(k=>`<th>${l(k)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></details>`:''}</section>`;
}
function devicesCard(devices,caps){
 const revoke=caps.allowed_actions?.includes('devices.revoke');
 const rows=devices.map(c=>`<tr><td><strong>${agentName(c)}</strong><small>${esc([c.label,c.device_id].filter(Boolean).join(' · '))}</small></td><td>${l(writes(c)?'connReadWrite':'readOnly')}</td><td>${esc(when(c.last_used_at))}</td><td>${esc(when(c.created_at))}</td>
   <td><div class="actions"><button type="button" class="quiet" data-inspect="core_connections" data-id="${esc(c.credential_id)}">${l('inspectDetails')}</button>${revoke&&c.console_revocable?`<button type="button" data-console-action="devices.revoke" data-id="${esc(c.agent_instance_id)}">${l('connRevokeDevice')}</button>`:''}</div></td></tr>`).join('');
 return `<section class="card connection-devices"><header class="section-head"><h2>${l('connDevices')}</h2></header>${l('connDevicesNote','p')}
 <div class="table-scroll"><table class="connection-table"><thead><tr>${['connAgentColumn','access','lastUsed','created','actions'].map(k=>`<th>${l(k)}</th>`).join('')}</tr></thead><tbody>${rows||`<tr><td colspan="5"><div class="empty">${l('connNoDevices')}</div></td></tr>`}</tbody></table></div></section>`;
}
function systemDetails(data,inv){
 const list=rows=>rows.length?`<ul class="connection-credentials">${rows.map(c=>`<li><span>${agentName(c)}<small>${esc(c.label||'')}</small></span><span>${l(c.state==='active'?'lastUsed':c.state==='expired'?'connExpired':'connState_revoked')} ${esc(when(c.state==='active'?c.last_used_at:c.revoked_at||c.expires_at))}</span></li>`).join('')}</ul>`:l('empty','p');
 return `<details class="card connection-system"><summary>${l('connSystem')}</summary>${l('connSystemNote','p')}${data.system_unavailable?l('unavailable','p'):''}
 <h3>${l('connManaged')}</h3>${l('connManagedNote','p')}${list(inv.managed)}<h3>${l('connHistoryCreds')}</h3>${list(inv.history)}
 ${(data.historical_grants||[]).length?`<h3>${l('connUnmatchedHistory')}</h3><p>${l('connUnmatchedNote')}</p>${data.historical_grants.map(g=>`<code>${esc(g.client_id)}</code>`).join(' ')}`:''}</details>`;
}
export function connectionsView(data,caps,q={}){
 const inv=connectionInventory(data,caps);
 const stats=[['active','connActive'],['readonly','readOnly'],['readwrite','connReadWrite'],['pending','connPending']].map(([key,label])=>`<article class="card connection-stat">${l(label)}<strong>${esc(inv.counts[key])}</strong></article>`).join('');
 const rows=(data.connections||[]).map(c=>`<tr><td><button type="button" class="connection-label" title="${esc(c.label)}" data-connection-detail="${esc(c.connection_id)}">${esc(c.label)}</button><small>${l(kindKeys[c.kind]||'connSystem')}</small></td><td>${l(c.profile==='memory_readwrite'?'connReadWrite':'readOnly')}</td><td>${l(c.expired?'connExpired':c.provisioning?'connPending':`connState_${c.configuration_state}`)}<small>${l(`connHealth_${c.health||'unknown'}`)}</small></td><td>${esc(date(c.last_successful_tool_at))}</td><td><button type="button" data-connection-detail="${esc(c.connection_id)}">${l('connConfigure')}</button></td></tr>`).join('');
 return `<section class="connection-intro"><div>${l('connIntro','p')}${l('connHealthNote','small')}</div>${enabled(caps)?`<button type="button" class="primary" data-connection-new>${l('addConnection')}</button>`:`<p class="policy-box">${l('connPolicy')}</p>`}</section>
 <div class="connection-stats">${stats}</div>${chatgptCard(inv.chatgpt,caps)}${devicesCard(inv.devices,caps)}
 <section class="card connection-list"><header class="section-head"><h2>${l('connPersonal')}</h2></header>${l('connPersonalNote','p')}<form id="connection-filters" class="toolbar">
 ${field('search','connSearch',q.search||'','maxlength="120" autocomplete="off"')}${choices('kind','connType',[['','connAll'],['chatgpt_oauth','connChatGPT'],['generic_mcp','connGeneric']],q.kind)}
 ${choices('profile','access',[['','connAll'],['readonly','readOnly'],['memory_readwrite','connReadWrite']],q.profile)}${choices('state','state',[['','connAll'],['draft','connState_draft'],['ready','connState_ready'],['disabled','connState_disabled'],['revoked','connState_revoked']],q.state)}
 ${choices('section','connSection',[['active','connCurrent'],['history','connHistory']],q.section||'active')}<button type="submit">${l('refresh')}</button><button type="button" data-connection-reset>${l('resetFilters')}</button></form>
 <div class="table-scroll"><table class="connection-table"><thead><tr>${['label','access','state','lastUsed','actions'].map(k=>`<th>${l(k)}</th>`).join('')}</tr></thead><tbody>${rows||`<tr><td colspan="5"><div class="empty">${l('connEmpty')}</div></td></tr>`}</tbody></table></div><div class="library-footer"><p>${l('connFilteredCount')}: ${esc(data.total??'—')}</p><div class="pagination">${data.offset?`<button type="button" data-connection-page="${Math.max(0,data.offset-(data.limit||20))}">${l('previous')}</button>`:''}${data.next_offset!=null?`<button type="button" data-connection-page="${data.next_offset}">${l('next')}</button>`:''}</div></div></section>
 ${systemDetails(data,inv)}`;
}
export function mountConnections({api,mutate,getCaps,reload,isActive}){
 const dialog=document.createElement('dialog');dialog.id='connection-dialog';dialog.className='connection-dialog';dialog.setAttribute('aria-labelledby','connection-title');
 dialog.innerHTML=`<div class="dialog-header"><h2 id="connection-title">${l('addConnection')}</h2><button type="button" data-connection-close data-i18n-aria-label="close" aria-label="${esc(t('close'))}">×</button></div><div class="connection-content"></div>`;document.body.append(dialog);
 const body=dialog.querySelector('.connection-content');let sequence=0,focus,working=false,intent=null,secret=null,saved=false,secretTimer,form={},q={section:'active'},operation,lastSemantic;
 function wipe(){clearTimeout(secretTimer);secret=null;saved=false;intent=null;form={};operation=null;lastSemantic=null;body.replaceChildren();}
 function clear(){sequence++;working=false;wipe();dialog.close();}
 function finish(){if(working)return;if(secret&&!saved&&!window.confirm(t('connDiscardSecret')))return;clear();focus?.focus();focus=null;}
 function open(){sequence++;wipe();focus=document.activeElement;if(!dialog.open)dialog.showModal();}
 function syncGrant(){const control=body.querySelector('[name=allow_submitted_revision_grant]');if(control){control.disabled=body.querySelector('[name=profile]')?.value!=='memory_readwrite';if(control.disabled)control.checked=false;}}
 function paint(html){body.innerHTML=html;syncAppearance();syncGrant();body.querySelector('input:not([type="hidden"]),button')?.focus();}
 body.addEventListener('change',event=>{if(event.target.name==='profile')syncGrant();});
 const buttons=(label='continue')=>`<div class="actions"><button type="submit" class="primary">${l(label)}</button><button type="button" data-connection-close>${l('cancel')}</button></div><p data-connection-error role="alert"></p>`;
 const proof=()=>`<fieldset class="reauth"><legend>${l('reauthenticate')}</legend>${field('current_password','currentPassword','','type="password" autocomplete="current-password" maxlength="1024" required')}${field('otp','otp','','inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required')}${l('otpFreshNote','p')}</fieldset>`;
 function selectType(){intent={step:'type'};paint(`<p class="eyebrow">1 / 4</p>${l('connChooseType','p')}<div class="connection-types"><button type="button" class="card" data-connection-kind="chatgpt_oauth">${l('connChatGPT','strong')}${l('connChatGPTNote','small')}</button><button type="button" class="card" data-connection-kind="generic_mcp">${l('connGeneric','strong')}${l('connGenericNote','small')}</button><div class="card" aria-disabled="true">${l('connAgent','strong')}${l('connAgentNote','small')}</div></div>`);}
 function basic(){intent={step:'basic'};const c=getCaps().connection_management;
   paint(`<p class="eyebrow">2 / 4</p><form data-connection-form>${field('label','label',form.label||'','maxlength="80" required')}${field('description','connDescription',form.description||'','maxlength="400"')}${choices('profile','access',[['readonly','readOnly'],...(c?.write_enabled?[['memory_readwrite','connReadWrite']]:[])],form.profile||'readonly')}
   ${c?.allow_submitted_revision_grant?`<label class="check-field"><input type="checkbox" name="allow_submitted_revision_grant" ${form.allow_submitted_revision_grant?'checked':''}>${l('connVersionGrant')}</label>`:''}${l('connPrivacyNote','p')}
   ${form.kind==='generic_mcp'?field('ttl_days','connTokenDays',form.ttl_days??Math.floor(c.policy.pat_default_ttl_seconds/86400),`type="number" min="1" max="${Math.floor(c.policy.pat_max_ttl_seconds/86400)}" step="1" required`)+l('connGenericNote','p'):l('connClientLifetime','p')}
   <button type="button" data-connection-back="type">${l('connBack')}</button>${buttons()}</form>`);
 }
 function confirmCreate(){intent={step:'create',action:'connections.create'};paint(`<p class="eyebrow">3 / 4</p><h3>${esc(form.label)}</h3><p>${l(kindKeys[form.kind])} · ${l(form.profile==='memory_readwrite'?'connReadWrite':'readOnly')}</p>${l('connGenerateNote','p')}<form data-connection-form>${proof()}<button type="button" data-connection-back="basic">${l('connBack')}</button>${buttons('connGenerate')}</form>`);}
 async function verifiedSession(){const me=await api('me');if(!isActive()||me.account_id!==getCaps().account_id||me.security_version!==getCaps().security_version){clear();throw new Error('STALE_ACCOUNT');}return me;}
 function showSecret(result){
   secret=result.secret;delete result.secret;saved=false;intent={step:'secret',connection:result.connection};
   paint(`<p class="eyebrow">4 / 4</p><h3>${esc(result.connection.label)}</h3>${l('connSecretNote','p')}<dl class="metadata-grid">${result.connection.client_id?pair('connClientId',result.connection.client_id):''}${pair('expires',result.expires_at?date(result.expires_at):t('connUntilRevoked'))}</dl><label>${l('connSecret')}<input type="password" readonly autocomplete="off" id="connection-secret"></label><div class="actions"><button type="button" data-connection-show>${l('showPassword')}</button><button type="button" data-connection-copy-secret>${l('connCopySecret')}</button></div><p class="connection-copy-status"></p><button type="button" class="primary" data-connection-secret-saved>${l('connSavedContinue')}</button>`);
   body.querySelector('#connection-secret').value=secret||'';
   secretTimer=setTimeout(()=>{secret=null;body.querySelector('#connection-secret')?.remove();const output=body.querySelector('.connection-copy-status');if(output)output.textContent=t('connSecretExpired');},Math.max(0,Math.min(300,(result.secret_expires_at||Date.now()/1000+300)-Date.now()/1000))*1000);
 }
 async function detail(id,{alreadyOpen=false}={}){
   if(!alreadyOpen)open();else sequence++;const seq=sequence;paint(l('loading','p'));
   try{const data=await api('connections',{connection_id:id});if(seq!==sequence||!isActive()||!dialog.open)return;const c=data.connection;intent={step:'detail',connection:c,data};
     paint(`<h3 class="connection-detail-label">${esc(c.label)}</h3><p>${l(kindKeys[c.kind])} · ${l(c.profile==='memory_readwrite'?'connReadWrite':'readOnly')} · ${l(c.expired?'connExpired':`connState_${c.configuration_state}`)} · ${l(`connHealth_${c.health}`)}</p>
     <section><h3>${l('connGuide')}</h3>${l('connHealthNote','p')}<dl class="metadata-grid">${pair('mcpEndpoint',data.guide.url)}${pair('connTransport',data.guide.transport)}${c.client_id?pair('connClientId',c.client_id):''}${pair('scope',data.guide.scopes.join(' '))}</dl>
       <button type="button" data-connection-copy-url>${l('connCopyUrl')}</button><button type="button" data-connection-copy-params>${l('connCopyParams')}</button><button type="button" data-connection-copy-id>${l('connCopyId')}</button>
       ${l(c.kind==='chatgpt_oauth'?'connOAuthSteps':'connGenericSteps','p')}${c.kind==='chatgpt_oauth'?`<dl class="metadata-grid">${pair('connCallback',c.redirect_uri||t('connCallbackMissing'))}${pair('connAuthUrl',data.guide.authorization_url)}${pair('connTokenUrl',data.guide.token_url)}${pair('connTokenAuth',data.guide.token_endpoint_auth_method)}</dl>`:''}
       <dl class="metadata-grid">${pair('connResource',data.guide.resource)}${pair('connTimeout',data.guide.timeout_seconds)}</dl><p>${l('connToolList')}: ${(data.guide.tools||[]).map(n=>`<code>${esc(n)}</code>`).join(' · ')}</p>${l('connTroubleshooting','p')}</section>
     <section><h3>${l('connCredentials')}</h3><p>${l('connRotateNote')}</p><div class="actions">${getCaps().connection_management?.enabled&&c.configuration_state!=='revoked'?['update','rotate',c.configuration_state==='disabled'?'enable':'disable','revoke'].map(action=>`<button type="button" data-connection-action="${action}">${l(`connAction_${action}`)}</button>`).join(''):''}</div>
       <p>${l('connGrantCount')}: ${data.grants.length} · ${l('connKeyCount')}: ${data.keys.length}</p>${data.grants.map(g=>`<p>${l('expires')} ${esc(date(g.expires))} ${getCaps().allowed_actions?.includes('oauth.revoke')?`<button type="button" data-connection-grant="${esc(g.grant_id)}">${l('connRevokeGrant')}</button>`:''}</p>`).join('')}${data.keys.map(k=>`<p>${l('revisions')} ${k.version} · ${l('expires')} ${esc(date(k.expires))} · ${l(k.revoked?'connState_revoked':k.expires*1000<Date.now()?'connExpired':'connState_ready')}</p>`).join('')}</section>
     <section><h3>${l('connActivity')}</h3>${data.activity.map(e=>`<p>${esc(date(e.created))} · ${esc(t(e.action))} · ${esc(e.outcome)}</p>`).join('')||l('connNoActivity','p')}</section><p class="connection-copy-status"></p><button type="button" data-connection-refresh>${l('refresh')}</button>`);
   }catch(e){if(seq===sequence&&isActive())paint(`<p role="alert">${esc(t(e.message))}</p><button type="button" data-connection-close>${l('close')}</button>`);}
 }
 function action(name){const c=intent.connection;operation=crypto.randomUUID();lastSemantic=null;intent={step:'action',action:`connections.${name}`,connection:c};const cm=getCaps().connection_management;
   const fields=name==='update'?field('label','label',c.label,'maxlength="80" required')+field('description','connDescription',c.description||'','maxlength="400"')+choices('profile','access',[['readonly','readOnly'],...(cm.write_enabled?[['memory_readwrite','connReadWrite']]:[])],c.profile)+(c.kind==='chatgpt_oauth'?field('redirect_uri','connCallback',c.redirect_uri||'','maxlength="2048" type="url" required'):'')+(cm.allow_submitted_revision_grant?`<label class="check-field"><input type="checkbox" name="allow_submitted_revision_grant" ${c.allow_submitted_revision_grant?'checked':''}>${l('connVersionGrant')}</label>`:''):'';
   paint(`<h3>${l(`connAction_${name}`)} · ${esc(c.label)}</h3>${l(name==='revoke'?'connRevokeNote':name==='disable'?'connDisableNote':'connRotateNote','p')}<form data-connection-form>${fields}${proof()}${buttons('confirm')}</form>`);
 }
 dialog.addEventListener('submit',async event=>{
   if(!event.target.matches('[data-connection-form]'))return;event.preventDefault();if(working||!intent)return;const fd=new FormData(event.target);
   if(intent.step==='basic'){form={...form,label:String(fd.get('label')),description:String(fd.get('description')||''),profile:String(fd.get('profile')),allow_submitted_revision_grant:fd.has('allow_submitted_revision_grant'),...(fd.has('ttl_days')?{ttl_days:Number(fd.get('ttl_days'))}:{})};if(form.profile==='readonly')form.allow_submitted_revision_grant=false;confirmCreate();return;}
   if(!['create','action','grant'].includes(intent.step))return;const seq=sequence,current=intent;let p;
   if(current.step==='create'){const {ttl_days,...base}=form;p={...base,...(form.kind==='generic_mcp'?{ttl_seconds:ttl_days*86400}:{})};}
   else if(current.step==='grant')p={grant_id:current.grant_id};
   else {p={connection_id:current.connection.connection_id};if(current.action==='connections.update'){for(const k of ['label','description','profile','redirect_uri'])if(fd.has(k))p[k]=String(fd.get(k));p.allow_submitted_revision_grant=p.profile==='memory_readwrite'&&fd.has('allow_submitted_revision_grant');}}
   const semantic=JSON.stringify(p);if(lastSemantic!==null&&lastSemantic!==semantic)operation=crypto.randomUUID();operation||=crypto.randomUUID();lastSemantic=semantic;
   if(current.step!=='grant')Object.assign(p,{current_password:String(fd.get('current_password')||''),otp:String(fd.get('otp')||'')});working=true;const controls=[...dialog.querySelectorAll('button,input,select')];controls.forEach(c=>c.disabled=true);
   try{const result=await mutate(current.action,p,operation);if(seq!==sequence||!isActive()||!dialog.open)return;event.target.reset();form={};if(result.secret)showSecret(result);else {saved=true;secret=null;await detail(result.connection?.connection_id||current.connection.connection_id,{alreadyOpen:true});}await reload();}
   catch(e){if(seq===sequence&&isActive()){const output=body.querySelector('[data-connection-error]');if(output)output.textContent=`${t(e.message)} · ${t('operationId')}: ${operation}`;}}
   finally{p.current_password='';p.otp='';working=false;controls.forEach(c=>c.disabled=false);}
 });
 document.addEventListener('click',async event=>{
   const b=event.target.closest('button');if(!b)return;
   if(b.hasAttribute('data-connection-new')){if(!enabled(getCaps()))return;open();operation=crypto.randomUUID();selectType();return;}
   if(b.dataset.connectionDetail){void detail(b.dataset.connectionDetail);return;}
   if(b.dataset.connectionKind){form.kind=b.dataset.connectionKind;basic();return;}
   if(b.dataset.connectionBack){b.dataset.connectionBack==='type'?selectType():basic();return;}
   if(b.hasAttribute('data-connection-close')){finish();return;}
   if(b.hasAttribute('data-connection-show')&&secret){const input=body.querySelector('#connection-secret');input.type=input.type==='password'?'text':'password';b.innerHTML=l(input.type==='password'?'showPassword':'hidePassword');return;}
   if(b.hasAttribute('data-connection-secret-saved')){const id=intent.connection.connection_id;saved=true;secret=null;clearTimeout(secretTimer);void detail(id,{alreadyOpen:true});return;}
   if(b.dataset.connectionAction){action(b.dataset.connectionAction);return;}
   if(b.dataset.connectionGrant){const c=intent.connection;operation=crypto.randomUUID();lastSemantic=null;intent={step:'grant',action:'oauth.revoke',connection:c,grant_id:b.dataset.connectionGrant};paint(`<h3>${l('connRevokeGrant')}</h3>${l('connRevokeGrantNote','p')}<form data-connection-form>${buttons('confirm')}</form>`);return;}
   if(b.hasAttribute('data-connection-refresh')){void detail(intent.connection.connection_id,{alreadyOpen:true});return;}
   if(b.dataset.connectionPage!==undefined){q={...q,offset:Number(b.dataset.connectionPage)};await reload();return;}
   if(b.hasAttribute('data-connection-reset')){q={section:'active'};await reload();return;}
   if(['data-connection-copy-secret','data-connection-copy-url','data-connection-copy-id','data-connection-copy-params'].some(k=>b.hasAttribute(k))){
     const seq=sequence;try{await verifiedSession();if(seq!==sequence||!dialog.open)return;let value;
       if(b.hasAttribute('data-connection-copy-secret'))value=secret;
       else if(b.hasAttribute('data-connection-copy-id'))value=intent.connection.connection_id;
       else if(b.hasAttribute('data-connection-copy-url'))value=intent.data.guide.url;
       else value=JSON.stringify({format:'mnemuron-neutral-connection-parameters-v1',transport:'Streamable HTTP',url:intent.data.guide.url,resource:intent.data.guide.resource,timeout_seconds:intent.data.guide.timeout_seconds,scopes:intent.data.guide.scopes,authentication:intent.data.guide.authentication,...(intent.connection.client_id?{client_id:intent.connection.client_id,client_secret:'<YOUR_PRIVATE_SECRET>',token_endpoint_auth_method:'client_secret_post',authorization_url:intent.data.guide.authorization_url,token_url:intent.data.guide.token_url}:{headers:{Authorization:'Bearer <YOUR_PRIVATE_TOKEN>'}})},null,2);
       if(value){await navigator.clipboard.writeText(value);if(seq===sequence)body.querySelector('.connection-copy-status').textContent=t('copied');}
     }catch{if(seq===sequence&&dialog.open)body.querySelector('.connection-copy-status').textContent=t('unavailable');}
   }
 });
 document.addEventListener('submit',event=>{if(event.target.id==='connection-filters'){event.preventDefault();q=Object.fromEntries(new FormData(event.target));q.offset=0;void reload();}if(event.target.action?.endsWith('/console-api/logout'))clear();});
 dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});dialog.addEventListener('close',()=>{sequence++;wipe();});
 window.addEventListener('focus',()=>{if(dialog.open)void verifiedSession().catch(()=>clear());});
 window.addEventListener('pagehide',clear);
 return {clear,query:()=>q};
}

import {translate as t,syncAppearance} from './appearance.mjs';
import {icon} from './visuals.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const l=(k,tag='span')=>`<${tag} data-i18n="${k}">${esc(t(k))}</${tag}>`;
const date=v=>v?new Date(v*1000).toLocaleString(document.documentElement.lang):'—';
const choices=(name,key,items,value='')=>`<label>${l(key)}<select name="${name}">${items.map(([v,k])=>`<option value="${esc(v)}" data-i18n="${k}" ${v===value?'selected':''}>${esc(t(k))}</option>`).join('')}</select></label>`;
const field=(name,key,value='',extra='')=>`<label>${l(key)}<input name="${name}" value="${esc(value)}" ${extra}></label>`;
const pair=(key,value)=>`<dt>${l(key)}</dt><dd>${esc(value??'—')}</dd>`;
const enabled=c=>c.allowed_actions?.includes('connections.create')===true;
const kindKeys={chatgpt_oauth:'connChatGPT',generic_mcp:'connGeneric',agent_placeholder:'connAgent'};
const healthKey=c=>c.kind==='chatgpt_oauth'&&c.active_grant_count===0&&c.health==='verified'?'connHistoricalSuccess':`connHealth_${c.health||'unknown'}`;
// Keys the platform manages (console, ChatGPT web gateway) are listed but never revoked here.
const MANAGED=['mnemuron-console','chatgpt-web'];
const agentKeys={chatgpt:'agent_chatgpt',openclaw:'agent_openclaw',hermes:'agent_hermes',mnemuron:'agent_mnemuron','mnemuron-console':'agent_console','chatgpt-web':'agent_chatgpt_web'};
const agentName=c=>agentKeys[c.agent_id]?l(agentKeys[c.agent_id]):`<span>${esc(c.agent_id)}</span>`;
// OAuth times are epoch seconds, Core times ISO strings.
const ms=v=>v==null||v===''?0:typeof v==='number'?(v<1e12?v*1000:v):Date.parse(v)||0;
const when=v=>{const n=ms(v);return n?new Date(n).toLocaleString(document.documentElement.lang):'—';};
const writes=c=>c.scopes.some(s=>s==='memory:write'||s==='capture:write');
const credential=c=>{const state=c.state||(c.revoked_at?'revoked':'active'),managed=c.managed??MANAGED.includes(c.agent_id);
  return {...c,scopes:Array.isArray(c.scopes)?c.scopes:[],state,managed,console_revocable:c.console_revocable??(state==='active'&&!managed)};};

// ChatGPT's standard connector callback; a connector showing its own callback can replace it.
export const CHATGPT_CALLBACK='https://chatgpt.com/connector_platform_oauth_redirect';
// A destructive submit says exactly what it does and is styled as such; Back returns without changing anything.
export const connectionFormActions=(label='continue',back,{danger=false}={})=>`<div class="actions connection-form-actions">${back?`<button type="button" data-connection-back="${back}">${l('connBack')}</button>`:''}<button type="submit" class="${danger?'primary danger':'primary'}">${l(label)}</button><button type="button" data-connection-close>${l('cancel')}</button></div><p data-connection-error role="alert"></p>`;
const STEPS=['connStepApp','connStepDetails','connStepVerify','connStepSave'];
/** Named wizard progress: where the owner is, and what remains. */
export const connectionSteps=n=>`<ol class="connection-steps" data-i18n-aria-label="connStepsLabel" aria-label="${esc(t('connStepsLabel'))}">${STEPS.map((k,i)=>`<li${i+1===n?' aria-current="step"':i+1<n?' data-done':''}><span class="connection-step-number" aria-hidden="true">${i+1}</span>${l(k)}</li>`).join('')}</ol>`;
const chip=(key,state)=>`<span class="connection-chip"${state?` data-state="${esc(state)}"`:''}>${l(key)}</span>`;
// Row/detail state, using the shared state-dot colours: green usable, amber waiting, red stopped.
const stateKey=c=>c.expired?'connExpired':c.provisioning?'connPending':c.kind==='chatgpt_oauth'&&c.configuration_state==='ready'&&c.active_grant_count===0?'connAwaitingAuthorization':`connState_${c.configuration_state}`;
const stateTone=c=>c.expired?'expired':['revoked','disabled'].includes(c.configuration_state)?c.configuration_state:c.provisioning||c.configuration_state==='draft'||stateKey(c)==='connAwaitingAuthorization'?'review_required':'ready';
const warning=key=>`<p class="connection-warning" role="note">${icon('warning')}${l(key)}</p>`;
/** Values ChatGPT's "new plugin" form asks for, in its order. Secrets never come from here. */
export function pluginValues(c,guide={}){
 return {label:c.label,description:c.description||t(c.profile==='memory_readwrite'?'connPluginDescWrite':'connPluginDescRead'),url:guide.url,client_id:c.client_id,
   token_auth:guide.token_endpoint_auth_method,scopes:(guide.oauth_scopes||guide.scopes||[]).join(' '),callback:c.redirect_uri,
   authorization_url:guide.authorization_url,token_url:guide.token_url,issuer:guide.issuer,resource:guide.resource,discovery_url:guide.discovery_url};
}
/** The ChatGPT plugin form: every field with a copy button; the one-time secret only right after it is issued. */
export function chatgptPluginForm(c,guide={},{withSecret=false}={}){
 const v=pluginValues(c,guide);
 const row=(key,field)=>`<div class="plugin-field"><dt>${l(key)}</dt><dd><code>${esc(v[field]||'—')}</code>${v[field]?`<button type="button" class="quiet" data-connection-copy="${field}">${l('copy')}</button>`:''}</dd></div>`;
 return `<p class="connection-hint">${l('connPluginManual')}</p><p><a href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer">${l('connOpenChatGPT')}</a></p><ol class="plugin-steps">${l('connPluginStep1','li')}${l('connPluginStep2','li')}${l('connPluginStep3','li')}</ol><dl class="plugin-form">
 <div class="plugin-field"><dt>${l('connPluginIcon')}</dt><dd><button type="button" class="quiet" data-connection-icon>${l('connDownloadIcon')}</button></dd></div>
 ${row('connPluginName','label')}${row('connDescription','description')}${row('mcpEndpoint','url')}<div class="plugin-field"><dt>${l('connPluginAuth')}</dt><dd><code>OAuth</code></dd></div><div class="plugin-field"><dt>${l('connPluginRegistration')}</dt><dd>${l('connPluginStaticClient')}</dd></div>${row('connClientId','client_id')}
 <div class="plugin-field"><dt>${l('connClientSecret')}</dt><dd>${withSecret?`<input type="password" readonly autocomplete="off" id="connection-secret" data-i18n-aria-label="connClientSecret" aria-label="${esc(t('connClientSecret'))}"><button type="button" class="quiet" data-connection-show>${l('showPassword')}</button><button type="button" class="quiet" data-connection-copy-secret>${l('connCopySecret')}</button>`:l('connSecretHidden')}</dd></div>
 ${row('connTokenAuth','token_auth')}${row('connBaseScopes','scopes')}${row('connDiscoveryUrl','discovery_url')}${row('connCallback','callback')}</dl>${l('connScopedDiscoveryNote','p')}${c.profile==='memory_readwrite'?`<p class="policy-box">${l('connWriteConsentCheck')}</p>`:''}<details class="plugin-advanced"><summary>${l('connTechnical')}</summary>${l('connPluginDiscovery','p')}<dl class="plugin-form">${row('connAuthUrl','authorization_url')}${row('connTokenUrl','token_url')}${row('connIssuer','issuer')}${row('connResource','resource')}</dl></details>`;
}
/** Connection status for the guide: what the owner should do next. */
export function pluginStatus(c){
 if(c.configuration_state==='revoked'||c.configuration_state==='disabled')return `connState_${c.configuration_state}`;
 if(c.provisioning)return 'connStatus_provisioning';if(!c.redirect_uri||c.configuration_state==='draft')return 'connStatus_callback';
 if(c.active_grant_count===0)return 'connStatus_ready';if(c.health==='degraded')return 'connStatus_degraded';
 return c.health==='verified'?'connStatus_verified':c.health==='authorized'?'connStatus_authorized':'connStatus_ready';
}
// The Mnemuron mark (corner quotes and seal) as a 512 px PNG for client icons, drawn locally.
function downloadIcon(){
 const size=512,canvas=document.createElement('canvas');canvas.width=canvas.height=size;const g=canvas.getContext('2d');
 g.fillStyle='#F5F1E8';g.fillRect(0,0,size,size);
 const w=5,ink='#1C1B18',px=u=>Math.round(size/2+(u-24)*size*0.7/43);
 for(const [x0,y0,x1,y1,colour] of [[5-w/2,5-w/2,5+w/2,19+w/2,ink],[5-w/2,5-w/2,19+w/2,5+w/2,ink],[43-w/2,29-w/2,43+w/2,43+w/2,ink],[29-w/2,43-w/2,43+w/2,43+w/2,ink],[15,15,33,33,'#AE3F2C']]){
   g.fillStyle=colour;g.fillRect(px(x0),px(y0),px(x1)-px(x0),px(y1)-px(y0));}
 canvas.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='mnemuron-icon.png';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);},'image/png');
}

/** One inventory for every kind of connection, so the counts match what the page lists. */
export function connectionInventory(data,caps={}){
 const grants=(data.legacy_connections||[]).flatMap(c=>c.grants||[]),creds=(data.core_connections||[]).map(credential);
 const firsts=grants.map(g=>ms(g.created)).filter(Boolean);
 // Last sign of use: the gateway key's last Core call or the last token ChatGPT obtained.
 const last=Math.max(0,...creds.filter(c=>c.agent_id==='chatgpt-web'&&c.state==='active').map(c=>ms(c.last_used_at)),ms(data.system_chatgpt?.last_token_at));
 // Write needs both the account's cloud binding and an authorization that actually granted memory:write.
 const chatgpt={configured:data.system_chatgpt?.configured===true||grants.length>0,authorized:grants.length>0,grants,first:firsts.length?Math.min(...firsts):0,last,read_scope:caps.read_policy?.active_records_uniform===true?'connReadActiveUniform':caps.read_policy?.legacy_read_all===true?'connReadAll':'connReadGranted',
   write_enabled:data.system_chatgpt?.write_enabled===true,write:grants.some(g=>(g.scopes||[]).includes('memory:write'))};
 const devices=creds.filter(c=>c.state==='active'&&!c.managed),managed=creds.filter(c=>c.state==='active'&&c.managed),history=creds.filter(c=>c.state!=='active');
 const r=data.authorization_counts||{},web=chatgpt.authorized?1:0,webWrite=web&&chatgpt.write?1:0;
 return {chatgpt,devices,managed,history,counts:{active:web+(r.usable||0)+devices.length,readonly:web-webWrite+(r.readonly||0)+devices.filter(c=>!writes(c)).length,
   readwrite:webWrite+(r.memory_readwrite||0)+devices.filter(writes).length,pending:r.pending||0}};
}
function chatgptCard(c,caps){
 if(!c.configured)return '';
 const revoke=caps.allowed_actions?.includes('oauth.revoke');
 const rows=c.grants.map(g=>`<tr><td>${esc(when(g.created))}</td><td>${esc(when(g.expires))}</td><td>${(g.scopes||[]).filter(s=>s!=='openid').map(s=>`<code>${esc(s)}</code>`).join(' ')||'—'}</td>
   <td>${revoke?`<button type="button" data-console-action="oauth.revoke" data-id="${esc(g.grant_id)}">${l('connRevokeGrant')}</button>`:''}</td></tr>`).join('');
 // Read-only summary of the existing system connection: nothing here changes a grant except the explicit per-grant revoke.
 const fact=(key,value)=>`<div class="connection-fact"><dt>${l(key)}</dt><dd>${value}</dd></div>`;
 return `<section class="card connection-chatgpt"><header class="section-head"><div class="connection-title">${icon('connections')}<h2>${l('connChatGPTWeb')}</h2></div><span class="state-dot" data-state="${c.authorized?'enabled':'disabled'}">${l(c.authorized?'connAuthorized':'connNotAuthorized')}</span></header>
 ${l('connChatGPTWebNote','p')}<dl class="connection-facts">${fact('access',l(c.write?'connReadWrite':'readOnly'))}${fact('connWriteAccess',l(c.write?'connWriteGranted':c.write_enabled?'connWritePending':'connWriteOff'))}${fact('connReadScope',`${l(c.read_scope)} <a href="/app/privacy">${l('connReadDetails')}</a>`)}</dl>
 <dl class="connection-meta"><div><dt>${l('connGrantsLabel')}</dt><dd>${esc(c.grants.length)}</dd></div><div><dt>${l('connFirstAuthorized')}</dt><dd>${esc(c.first?when(c.first):'—')}</dd></div><div><dt>${l('connLastActivity')}</dt><dd>${esc(c.last?when(c.last):'—')}</dd></div></dl>
 ${rows?`<details class="connection-grants"><summary>${l('connGrantList')}</summary>${revoke?l('connRevokeGrantNote','p'):''}<div class="table-scroll"><table><thead><tr>${['connAuthorizedAt','expires','scope','actions'].map(k=>`<th>${l(k)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div></details>`:''}
 ${enabled(caps)?`<div class="connection-card-actions">${l('connChatGPTAddHint','p')}<button type="button" data-connection-new data-connection-start="chatgpt_oauth">${icon('plus')}${l('connNewChatGPT')}</button></div>`:''}</section>`;
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
 const stats=[['active','connAuthorizedCount'],['readonly','readOnly'],['readwrite','connReadWrite'],['pending','connPendingAuthorization']].map(([key,label])=>`<article class="card connection-stat">${l(label)}<strong>${esc(inv.counts[key])}</strong></article>`).join('');
 const rows=(data.connections||[]).map(c=>`<tr><td><button type="button" class="connection-label" title="${esc(c.label)}" data-connection-detail="${esc(c.connection_id)}">${esc(c.label)}</button><small>${l(kindKeys[c.kind]||'connSystem')}</small></td><td>${l(c.profile==='memory_readwrite'?'connReadWrite':'readOnly')}</td><td><span class="state-dot" data-state="${stateTone(c)}">${l(stateKey(c))}</span><small>${l(healthKey(c))}</small></td><td>${esc(date(c.last_successful_tool_at))}</td><td><button type="button" data-connection-detail="${esc(c.connection_id)}">${l('connConfigure')}</button></td></tr>`).join('');
 return `<section class="connection-intro"><div>${l('connIntro','p')}${l('connHealthNote','small')}</div>${enabled(caps)?`<button type="button" class="primary" data-connection-new>${l('addConnection')}</button>`:`<p class="policy-box">${l('connPolicy')}</p>`}</section>
 <div class="connection-stats">${stats}</div><p class="connection-hint">${l('connCountsNote')}</p>${chatgptCard(inv.chatgpt,caps)}${devicesCard(inv.devices,caps)}
 <section class="card connection-list"><header class="section-head"><h2>${l('connPersonal')}</h2></header>${l('connPersonalNote','p')}<form id="connection-filters" class="toolbar">
 ${field('search','connSearch',q.search||'','maxlength="120" autocomplete="off"')}${choices('kind','connType',[['','connAll'],['chatgpt_oauth','connChatGPT'],['generic_mcp','connGeneric']],q.kind)}
 ${choices('profile','access',[['','connAll'],['readonly','readOnly'],['memory_readwrite','connReadWrite']],q.profile)}${choices('state','state',[['','connAll'],['draft','connState_draft'],['ready','connState_ready'],['disabled','connState_disabled'],['revoked','connState_revoked']],q.state)}
 ${choices('section','connSection',[['active','connCurrent'],['history','connHistory']],q.section||'active')}<div class="connection-filter-actions"><button type="submit">${l('connApplyFilters')}</button><button type="button" class="quiet" data-connection-reset>${l('resetFilters')}</button></div></form>
 <div class="table-scroll"><table class="connection-table"><thead><tr>${['label','access','state','lastUsed','actions'].map(k=>`<th>${l(k)}</th>`).join('')}</tr></thead><tbody>${rows||`<tr><td colspan="5"><div class="empty">${l('connEmpty')}</div></td></tr>`}</tbody></table></div><div class="library-footer"><p>${l('connFilteredCount')}: ${esc(data.total??'—')}</p><div class="pagination">${data.offset?`<button type="button" data-connection-page="${Math.max(0,data.offset-(data.limit||20))}">${l('previous')}</button>`:''}${data.next_offset!=null?`<button type="button" data-connection-page="${data.next_offset}">${l('next')}</button>`:''}</div></div></section>
 ${systemDetails(data,inv)}`;
}
export function mountConnections({api,mutate,getCaps,reload,isActive}){
 const dialog=document.createElement('dialog');dialog.id='connection-dialog';dialog.className='connection-dialog';dialog.setAttribute('aria-labelledby','connection-title');
 dialog.innerHTML=`<div class="dialog-header"><h2 id="connection-title">${l('addConnection')}</h2><button type="button" data-connection-close data-i18n-aria-label="close" aria-label="${esc(t('close'))}">×</button></div><div class="connection-content"></div>`;document.body.append(dialog);
 const body=dialog.querySelector('.connection-content');let sequence=0,mode='add',focus,working=false,intent=null,secret=null,saved=false,secretTimer,secretDeadline=0,pollTimer,form={},q={section:'active'},operation,lastSemantic,polls=0;
 function expireSecret(){secret=null;const input=body.querySelector('#connection-secret');if(input){input.value='';input.remove();}body.querySelectorAll('[data-connection-copy-secret],[data-connection-show]').forEach(b=>b.disabled=true);const output=body.querySelector('.connection-copy-status');if(output)output.textContent=t('connSecretExpired');}
 function wipe(){clearTimeout(secretTimer);clearTimeout(pollTimer);secret=null;secretDeadline=0;saved=false;intent=null;form={};operation=null;lastSemantic=null;polls=0;body.replaceChildren();}
 function clear(){sequence++;working=false;wipe();dialog.close();}
 function finish(){if(working)return;if(secret&&!saved&&!window.confirm(t('connDiscardSecret')))return;clear();focus?.focus();focus=null;}
 function open(){sequence++;wipe();focus=document.activeElement;if(!dialog.open)dialog.showModal();}
 function syncGrant(){const control=body.querySelector('[name=allow_submitted_revision_grant]');if(control){control.disabled=body.querySelector('[name=profile]')?.value!=='memory_readwrite';if(control.disabled)control.checked=false;}}
 // The title says whether the owner is adding a new connection or managing an existing one.
 function paint(html){dialog.querySelector('#connection-title').innerHTML=l(mode==='manage'?'connManageTitle':'addConnection');body.innerHTML=html;syncAppearance();syncGrant();body.querySelector('input:not([type="hidden"]),button')?.focus();}
 body.addEventListener('change',event=>{if(event.target.name==='profile')syncGrant();});
 const buttons=connectionFormActions;
 const proof=()=>`<fieldset class="reauth"><legend>${l('reauthenticate')}</legend>${field('current_password','currentPassword','','type="password" autocomplete="current-password" maxlength="1024" required')}${field('otp','otp','','inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required')}${l('otpFreshNote','p')}</fieldset>`;
 // Each choice says what it is for and what the owner needs ready; the unimplemented one stays visibly unavailable.
 const typeChoice=(kind,glyph,title,note,need,extra='')=>`<button type="button" class="card" data-connection-kind="${kind}"${form.kind===kind?' aria-pressed="true"':''}><span class="connection-type-head">${icon(glyph)}${l(title,'strong')}${extra}</span>${l(note,'small')}<small class="connection-need">${l('connNeedLabel')}: ${l(need)}</small></button>`;
 function selectType(){intent={step:'type'};paint(`${connectionSteps(1)}${l('connChooseType','p')}<div class="connection-types">${typeChoice('chatgpt_oauth','connections','connChatGPT','connChatGPTNote','connChatGPTNeed',`<span class="connection-tag">${l('connRecommended')}</span>`)}${typeChoice('generic_mcp','models','connGeneric','connGenericNote','connGenericNeed')}<div class="card" aria-disabled="true"><span class="connection-type-head">${icon('lock')}${l('connAgent','strong')}</span>${l('connAgentNote','small')}</div></div><div class="actions connection-form-actions"><button type="button" data-connection-close>${l('cancel')}</button></div>`);}
 function basic(){intent={step:'basic'};const c=getCaps().connection_management;if(form.kind==='chatgpt_oauth'&&form.label===undefined)form.label='Mnemuron';
   paint(`${connectionSteps(2)}<p class="connection-kind-line">${l(kindKeys[form.kind])}</p><form data-connection-form>${field('label','label',form.label||'','maxlength="80" required')}${field('description','connDescription',form.description||'','maxlength="400"')}${choices('profile','access',[['readonly','readOnly'],...(c?.write_enabled?[['memory_readwrite','connReadWrite']]:[])],form.profile||'readonly')}
   ${form.kind==='chatgpt_oauth'?field('redirect_uri','connCallback',form.redirect_uri||CHATGPT_CALLBACK,'type="url" maxlength="2048" required')+l('connCallbackDefaultNote','p'):''}
   ${c?.allow_submitted_revision_grant?`<label class="check-field"><input type="checkbox" name="allow_submitted_revision_grant" ${form.allow_submitted_revision_grant?'checked':''}>${l('connVersionGrant')}</label>`:''}${l('connPrivacyNote','p')}
   ${form.kind==='generic_mcp'?field('ttl_days','connTokenDays',form.ttl_days??Math.floor(c.policy.pat_default_ttl_seconds/86400),`type="number" min="1" max="${Math.floor(c.policy.pat_max_ttl_seconds/86400)}" step="1" required`)+l('connGenericNote','p'):l('connClientLifetime','p')}
   ${buttons('continue','type')}</form>`);
 }
 function confirmCreate(){intent={step:'create',action:'connections.create'};paint(`${connectionSteps(3)}<h3 class="connection-detail-label">${esc(form.label)}</h3><p class="connection-chips">${chip(kindKeys[form.kind])}${chip(form.profile==='memory_readwrite'?'connReadWrite':'readOnly')}</p>${form.kind==='chatgpt_oauth'?`<dl class="metadata-grid">${pair('connCallback',form.redirect_uri)}</dl>`:''}${l('connGenerateNote','p')}<form data-connection-form>${proof()}${buttons('connGenerate','basic')}</form>`);}
 async function verifiedSession(){const me=await api('me');if(!isActive()||me.account_id!==getCaps().account_id||me.security_version!==getCaps().security_version){clear();throw new Error('STALE_ACCOUNT');}return me;}
 function showSecret(result){
   secret=result.secret;delete result.secret;saved=false;intent={step:'secret',connection:result.connection};
   clearTimeout(secretTimer);secretDeadline=Math.min(Date.now()+300000,(result.secret_expires_at||Date.now()/1000+300)*1000);
   if(result.connection.kind==='chatgpt_oauth'){
     paint(`${connectionSteps(4)}<h3 class="connection-detail-label">${esc(result.connection.label)}</h3>${l('connPluginIntro','p')}<div data-plugin-guide>${chatgptPluginForm(result.connection,{}, {withSecret:true})}</div><p data-guide-message role="status">${l('loading')}</p><button type="button" data-connection-retry-guide hidden>${l('refresh')}</button>${l('connSecretNote','p')}<p class="connection-copy-status" role="status"></p><button type="button" class="primary" data-connection-secret-saved>${l('connSavedContinue')}</button>`);
     void loadSecretGuide();
   }else paint(`${connectionSteps(4)}<h3 class="connection-detail-label">${esc(result.connection.label)}</h3>${l('connSecretNote','p')}<dl class="metadata-grid">${result.connection.client_id?pair('connClientId',result.connection.client_id):''}${pair('expires',result.expires_at?date(result.expires_at):t('connUntilRevoked'))}</dl><label>${l('connSecret')}<input type="password" readonly autocomplete="off" id="connection-secret"></label><div class="actions"><button type="button" data-connection-show>${l('showPassword')}</button><button type="button" data-connection-copy-secret>${l('connCopySecret')}</button></div><p class="connection-copy-status"></p><button type="button" class="primary" data-connection-secret-saved>${l('connSavedContinue')}</button>`);
   const input=body.querySelector('#connection-secret');if(input)input.value=secret||'';
   secretTimer=setTimeout(expireSecret,Math.max(0,secretDeadline-Date.now()));
 }
 async function loadSecretGuide(){
   const seq=sequence,current=intent;if(current?.step!=='secret')return;
   const retry=body.querySelector('[data-connection-retry-guide]');retry.disabled=true;
   try{const data=await api('connections',{connection_id:current.connection.connection_id});if(seq!==sequence||intent!==current||!isActive()||!dialog.open)return;
     if(data.connection.version!==current.connection.version||!data.connection.has_secret||['revoked','disabled'].includes(data.connection.configuration_state)){expireSecret();return;}
     current.data=data;body.querySelector('[data-plugin-guide]').innerHTML=chatgptPluginForm(current.connection,data.guide,{withSecret:!!secret&&Date.now()<secretDeadline});syncAppearance();
     const input=body.querySelector('#connection-secret');if(input)input.value=secret||'';
     body.querySelector('[data-guide-message]').textContent='';retry.hidden=true;
   }catch{if(seq===sequence&&intent===current&&dialog.open){body.querySelector('[data-guide-message]').textContent=t('connGuideUnavailable');retry.hidden=false;}}
   finally{retry.disabled=false;}
 }
 async function detail(id,{alreadyOpen=false,background=false}={}){
   mode='manage';clearTimeout(pollTimer);if(!alreadyOpen)open();else sequence++;const seq=sequence,current=intent;if(!background)paint(l('loading','p'));
   try{const data=await api('connections',{connection_id:id});if(seq!==sequence||!isActive()||!dialog.open)return;const c=data.connection;intent={step:'detail',connection:c,data};
     if(background&&JSON.stringify(current?.data)===JSON.stringify(data)){scheduleDetail(c);return;}
     const scroll=dialog.scrollTop,focused=background&&document.activeElement?.closest('button')?.outerHTML;
     const plugin=c.kind==='chatgpt_oauth'?`<p class="plugin-status" data-status="${esc(pluginStatus(c))}">${l(pluginStatus(c))}</p><section><h3>${l('connPluginTitle')}</h3>${chatgptPluginForm(c,data.guide)}<p class="connection-copy-status"></p></section>`:'';
     const manage=getCaps().connection_management?.enabled&&c.configuration_state!=='revoked',button=action=>`<button type="button" data-connection-action="${action}">${l(`connAction_${action}`)}</button>`;
     paint(`<h3 class="connection-detail-label">${esc(c.label)}</h3><p class="connection-chips">${chip(kindKeys[c.kind])}${chip(c.profile==='memory_readwrite'?'connReadWrite':'readOnly')}${chip(c.expired?'connExpired':`connState_${c.configuration_state}`,stateTone(c))}${chip(`connHealth_${c.health}`)}</p>
     ${plugin}<section><h3>${l(c.kind==='chatgpt_oauth'?'connTechnical':'connGuide')}</h3>${l('connHealthNote','p')}<dl class="metadata-grid">${pair('mcpEndpoint',data.guide.url)}${pair('connTransport',data.guide.transport)}${c.client_id?pair('connClientId',c.client_id):''}${pair('scope',data.guide.scopes.join(' '))}</dl>
       <button type="button" data-connection-copy-url>${l('connCopyUrl')}</button><button type="button" data-connection-copy-params>${l('connCopyParams')}</button><button type="button" data-connection-copy-id>${l('connCopyId')}</button>
       ${l(c.kind==='chatgpt_oauth'?'connOAuthSteps':'connGenericSteps','p')}${c.kind==='chatgpt_oauth'?`<dl class="metadata-grid">${pair('connCallback',c.redirect_uri||t('connCallbackMissing'))}${pair('connAuthUrl',data.guide.authorization_url)}${pair('connTokenUrl',data.guide.token_url)}${pair('connTokenAuth',data.guide.token_endpoint_auth_method)}</dl>`:''}
       <dl class="metadata-grid">${pair('connResource',data.guide.resource)}${pair('connTimeout',data.guide.timeout_seconds)}</dl><p>${l('connToolList')}: ${(data.guide.tools||[]).map(n=>`<code>${esc(n)}</code>`).join(' · ')}</p>${l('connTroubleshooting','p')}</section>
     <section><h3>${l('connCredentials')}</h3><p>${l('connRotateNote')}</p><div class="actions">${manage?['update','rotate',...(c.configuration_state==='disabled'?['enable']:[])].map(button).join(''):''}</div>
       <p>${l('connGrantCount')}: ${data.grants.length} · ${l('connKeyCount')}: ${data.keys.length}</p>${data.grants.map(g=>`<p>${l('expires')} ${esc(date(g.expires))} ${getCaps().allowed_actions?.includes('oauth.revoke')?`<button type="button" data-connection-grant="${esc(g.grant_id)}">${l('connRevokeGrant')}</button>`:''}</p>`).join('')}${data.keys.map(k=>`<p>${l('revisions')} ${k.version} · ${l('expires')} ${esc(date(k.expires))} · ${l(k.revoked?'connState_revoked':k.expires*1000<Date.now()?'connExpired':'connState_ready')}</p>`).join('')}</section>
     <section><h3>${l('connActivity')}</h3>${data.activity.map(e=>`<p>${esc(date(e.created))} · ${esc(t(e.action))} · ${esc(e.outcome)}</p>`).join('')||l('connNoActivity','p')}</section>
     ${manage?`<section class="connection-danger"><h3>${l('connDangerZone')}</h3>${l('connDangerNote','p')}<div class="actions">${[...(c.configuration_state==='disabled'?[]:['disable']),'revoke'].map(button).join('')}</div></section>`:''}<p class="connection-copy-status"></p><button type="button" data-connection-refresh>${l('refresh')}</button>`);
     if(background){if(focused)[...body.querySelectorAll('button')].find(b=>b.outerHTML===focused)?.focus({preventScroll:true});dialog.scrollTop=scroll;}scheduleDetail(c);
   }catch(e){if(seq===sequence&&isActive()){if(background){const output=body.querySelector('.connection-copy-status');if(output)output.textContent=t('connStatusUnavailable');}else paint(`<p role="alert">${esc(t(e.message))}</p><button type="button" data-connection-detail="${esc(id)}">${l('refresh')}</button><button type="button" data-connection-close>${l('close')}</button>`);}}
 }
 function scheduleDetail(c){const seq=sequence;if(c.kind==='chatgpt_oauth'&&!['connState_revoked','connState_disabled','connStatus_verified','connStatus_callback'].includes(pluginStatus(c))&&polls<20){polls++;pollTimer=setTimeout(()=>{if(seq===sequence&&dialog.open&&intent?.step==='detail')void detail(c.connection_id,{alreadyOpen:true,background:true});},3000);}}
 function action(name){clearTimeout(pollTimer);sequence++;const c=intent.connection;operation=crypto.randomUUID();lastSemantic=null;intent={step:'action',action:`connections.${name}`,connection:c};const cm=getCaps().connection_management;
   const fields=name==='update'?field('label','label',c.label,'maxlength="80" required')+field('description','connDescription',c.description||'','maxlength="400"')+choices('profile','access',[['readonly','readOnly'],...(cm.write_enabled?[['memory_readwrite','connReadWrite']]:[])],c.profile)+(c.kind==='chatgpt_oauth'?field('redirect_uri','connCallback',c.redirect_uri||'','maxlength="2048" type="url" required'):'')+(cm.allow_submitted_revision_grant?`<label class="check-field"><input type="checkbox" name="allow_submitted_revision_grant" ${c.allow_submitted_revision_grant?'checked':''}>${l('connVersionGrant')}</label>`:''):'';
   const danger=name==='revoke'||name==='disable';
   paint(`<h3>${l(`connAction_${name}`)} · ${esc(c.label)}</h3>${danger?warning(name==='revoke'?'connRevokeNote':'connDisableNote'):l('connRotateNote','p')}<form data-connection-form>${fields}${proof()}${buttons(danger?`connConfirm_${name}`:'confirm','detail',{danger})}</form>`);
 }
 // The draft survives Continue and Back alike; nothing is sent until the confirmed create.
 function keepBasic(fd){form={...form,label:String(fd.get('label')),description:String(fd.get('description')||''),profile:String(fd.get('profile')),allow_submitted_revision_grant:fd.has('allow_submitted_revision_grant'),...(fd.has('ttl_days')&&fd.get('ttl_days')!==''?{ttl_days:Number(fd.get('ttl_days'))}:{}),...(fd.has('redirect_uri')?{redirect_uri:String(fd.get('redirect_uri')).trim()}:{})};if(form.profile==='readonly')form.allow_submitted_revision_grant=false;}
 dialog.addEventListener('submit',async event=>{
   if(!event.target.matches('[data-connection-form]'))return;event.preventDefault();if(working||!intent)return;const fd=new FormData(event.target);
   if(intent.step==='basic'){keepBasic(fd);confirmCreate();return;}
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
   if(b.hasAttribute('data-connection-new')){if(!enabled(getCaps()))return;open();mode='add';operation=crypto.randomUUID();if(b.dataset.connectionStart){form.kind=b.dataset.connectionStart;basic();}else selectType();return;}
   if(b.hasAttribute('data-connection-icon')){downloadIcon();return;}
   if(b.hasAttribute('data-connection-retry-guide')){void loadSecretGuide();return;}
   if(b.dataset.connectionDetail){void detail(b.dataset.connectionDetail);return;}
   if(b.dataset.connectionKind){if(form.kind!==b.dataset.connectionKind)form={};form.kind=b.dataset.connectionKind;basic();return;}
   if(b.dataset.connectionBack){if(working)return;const back=b.dataset.connectionBack;
     // Back from a confirmation discards its unsent proof and returns to the unchanged connection.
     if(back==='detail'){if(intent?.connection)void detail(intent.connection.connection_id,{alreadyOpen:true});return;}
     const draft=intent?.step==='basic'&&body.querySelector('[data-connection-form]');if(draft)keepBasic(new FormData(draft));back==='type'?selectType():basic();return;}
   if(b.hasAttribute('data-connection-close')){finish();return;}
   if(b.hasAttribute('data-connection-show')&&secret){const seq=sequence;try{await verifiedSession();if(seq!==sequence||!dialog.open)return;if(Date.now()>=secretDeadline){expireSecret();return;}const input=body.querySelector('#connection-secret');if(input){input.type=input.type==='password'?'text':'password';b.innerHTML=l(input.type==='password'?'showPassword':'hidePassword');}}catch{clear();}return;}
   if(b.hasAttribute('data-connection-secret-saved')){const id=intent.connection.connection_id;saved=true;secret=null;clearTimeout(secretTimer);void detail(id,{alreadyOpen:true});return;}
   if(b.dataset.connectionAction){action(b.dataset.connectionAction);return;}
   if(b.dataset.connectionGrant){clearTimeout(pollTimer);sequence++;const c=intent.connection;operation=crypto.randomUUID();lastSemantic=null;intent={step:'grant',action:'oauth.revoke',connection:c,grant_id:b.dataset.connectionGrant};paint(`<h3>${l('connRevokeGrant')}</h3>${warning('connRevokeGrantNote')}<form data-connection-form>${buttons('connConfirm_grant','detail',{danger:true})}</form>`);return;}
   if(b.hasAttribute('data-connection-refresh')){polls=0;void detail(intent.connection.connection_id,{alreadyOpen:true});return;}
   if(b.dataset.connectionPage!==undefined){q={...q,offset:Number(b.dataset.connectionPage)};await reload();return;}
   if(b.hasAttribute('data-connection-reset')){q={section:'active'};await reload();return;}
   if(b.dataset.connectionCopy||['data-connection-copy-secret','data-connection-copy-url','data-connection-copy-id','data-connection-copy-params'].some(k=>b.hasAttribute(k))){
     const seq=sequence;try{await verifiedSession();if(seq!==sequence||!dialog.open)return;let value;
       if(b.dataset.connectionCopy)value=pluginValues(intent.connection,intent.data?.guide||{})[b.dataset.connectionCopy];
       else if(b.hasAttribute('data-connection-copy-secret')){if(Date.now()>=secretDeadline){expireSecret();return;}value=secret;}
       else if(b.hasAttribute('data-connection-copy-id'))value=intent.connection.connection_id;
       else if(b.hasAttribute('data-connection-copy-url'))value=intent.data.guide.url;
       else value=JSON.stringify({format:'mnemuron-neutral-connection-parameters-v1',transport:'Streamable HTTP',url:intent.data.guide.url,resource:intent.data.guide.resource,timeout_seconds:intent.data.guide.timeout_seconds,scopes:intent.data.guide.oauth_scopes||intent.data.guide.scopes,authentication:intent.data.guide.authentication,...(intent.connection.client_id?{client_id:intent.connection.client_id,client_secret:'<YOUR_PRIVATE_SECRET>',token_endpoint_auth_method:intent.data.guide.token_endpoint_auth_method,authorization_url:intent.data.guide.authorization_url,token_url:intent.data.guide.token_url}:{headers:{Authorization:'Bearer <YOUR_PRIVATE_TOKEN>'}})},null,2);
       if(value){await navigator.clipboard.writeText(value);if(seq===sequence)body.querySelector('.connection-copy-status').textContent=t('copied');}
     }catch{if(seq===sequence&&dialog.open)body.querySelector('.connection-copy-status').textContent=t('unavailable');}
   }
 });
 document.addEventListener('submit',event=>{if(event.target.id==='connection-filters'){event.preventDefault();q=Object.fromEntries(new FormData(event.target));q.offset=0;void reload();}if(event.target.getAttribute('action')==='/console-api/logout')clear();});
 dialog.addEventListener('cancel',event=>{event.preventDefault();finish();});dialog.addEventListener('close',()=>{sequence++;wipe();});
 window.addEventListener('focus',()=>{if(dialog.open){const seq=sequence;void verifiedSession().then(()=>{if(seq===sequence&&dialog.open&&intent?.step==='detail'&&!working){polls=0;return detail(intent.connection.connection_id,{alreadyOpen:true,background:true});}}).catch(()=>clear());}});
 window.addEventListener('pagehide',clear);
 return {clear,query:()=>q};
}

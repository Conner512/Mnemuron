import {translate as t,syncAppearance} from './appearance.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const l=(k,tag='span')=>`<${tag} data-i18n="${k}">${esc(t(k))}</${tag}>`;
const date=v=>v?new Date(v*1000).toLocaleString(document.documentElement.lang):'—';
const choices=(name,key,items,value='')=>`<label>${l(key)}<select name="${name}">${items.map(([v,k])=>`<option value="${esc(v)}" data-i18n="${k}" ${v===value?'selected':''}>${esc(t(k))}</option>`).join('')}</select></label>`;
const field=(name,key,value='',extra='')=>`<label>${l(key)}<input name="${name}" value="${esc(value)}" ${extra}></label>`;
const pair=(key,value)=>`<dt>${l(key)}</dt><dd>${esc(value??'—')}</dd>`;
const enabled=c=>c.allowed_actions?.includes('connections.create')===true;
const kindKeys={chatgpt_oauth:'connChatGPT',generic_mcp:'connGeneric',agent_placeholder:'connAgent'};
export function connectionsView(data,caps,q={}){
 const counts=data.counts||{};
 const stats=[['active','connActive'],['readonly','readOnly'],['memory_readwrite','connReadWrite'],['pending','connPending']].map(([key,label])=>`<article class="card connection-stat">${l(label)}<strong>${esc(counts[key]??'—')}</strong></article>`).join('');
 const rows=(data.connections||[]).map(c=>`<tr><td><button type="button" class="connection-label" title="${esc(c.label)}" data-connection-detail="${esc(c.connection_id)}">${esc(c.label)}</button><small>${l(kindKeys[c.kind]||'connSystem')}</small></td><td>${l(c.profile==='memory_readwrite'?'connReadWrite':'readOnly')}</td><td>${l(c.expired?'connExpired':c.provisioning?'connPending':`connState_${c.configuration_state}`)}<small>${l(`connHealth_${c.health||'unknown'}`)}</small></td><td>${esc(date(c.last_successful_tool_at))}</td><td><button type="button" data-connection-detail="${esc(c.connection_id)}">${l('connConfigure')}</button></td></tr>`).join('');
 return `<section class="connection-intro"><div>${l('connIntro','p')}${l('connHealthNote','small')}</div>${enabled(caps)?`<button type="button" class="primary" data-connection-new>${l('addConnection')}</button>`:`<p class="policy-box">${l('connPolicy')}</p>`}</section>
 <div class="connection-stats">${stats}</div><section class="card connection-list"><form id="connection-filters" class="toolbar">
 ${field('search','connSearch',q.search||'','maxlength="120" autocomplete="off"')}${choices('kind','connType',[['','connAll'],['chatgpt_oauth','connChatGPT'],['generic_mcp','connGeneric']],q.kind)}
 ${choices('profile','access',[['','connAll'],['readonly','readOnly'],['memory_readwrite','connReadWrite']],q.profile)}${choices('state','state',[['','connAll'],['draft','connState_draft'],['ready','connState_ready'],['disabled','connState_disabled'],['revoked','connState_revoked']],q.state)}
 ${choices('section','connSection',[['active','connCurrent'],['history','connHistory']],q.section||'active')}<button type="submit">${l('refresh')}</button><button type="button" data-connection-reset>${l('resetFilters')}</button></form>
 <div class="table-scroll"><table class="connection-table"><thead><tr>${['label','access','state','lastUsed','actions'].map(k=>`<th>${l(k)}</th>`).join('')}</tr></thead><tbody>${rows||`<tr><td colspan="5"><div class="empty">${l('connEmpty')}</div></td></tr>`}</tbody></table></div><div class="library-footer"><p>${l('connFilteredCount')}: ${esc(data.total??'—')}</p><div class="pagination">${data.offset?`<button type="button" data-connection-page="${Math.max(0,data.offset-(data.limit||20))}">${l('previous')}</button>`:''}${data.next_offset!=null?`<button type="button" data-connection-page="${data.next_offset}">${l('next')}</button>`:''}</div></div></section>
 <details class="card connection-system"><summary>${l('connSystem')}</summary><p>${l('connSystemNote')}</p>${data.system_unavailable?l('unavailable','p'):''}
 ${(data.legacy_connections||[]).map(c=>`<section><h3>${l('connLegacy')}</h3><p>${l('connLegacyNote')}</p>${(c.grants||[]).map(g=>`<dl class="metadata-grid">${pair('oauthClient',g.client_id)}${pair('expires',date(g.expires))}</dl>${caps.allowed_actions?.includes('oauth.revoke')?`<button type="button" data-console-action="oauth.revoke" data-id="${esc(g.grant_id)}">${l('connRevokeGrant')}</button>`:''}`).join('')}</section>`).join('')}
 ${(data.core_connections||[]).map(c=>`<details><summary>${esc(c.label||c.agent_id)}</summary><dl class="metadata-grid">${pair('agentId',c.agent_id)}${pair('operationId',c.credential_id)}</dl></details>`).join('')}
 ${(data.historical_grants||[]).length?`<details><summary>${l('connUnmatchedHistory')}</summary><p>${l('connUnmatchedNote')}</p>${data.historical_grants.map(g=>`<code>${esc(g.client_id)}</code>`).join('')}</details>`:''}</details>`;
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

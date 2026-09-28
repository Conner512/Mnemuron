import {translate as t,syncAppearance} from './appearance.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const l=k=>`<span data-i18n="${k}">${esc(t(k))}</span>`;
export const actionButton=(action,key,values={})=>`<button type="button" data-console-action="${action}" ${Object.entries(values).map(([k,v])=>`data-${k}="${esc(v)}"`).join(' ')}>${l(key)}</button>`;
const time=v=>v?new Date(typeof v==='number'&&v<1e12?v*1000:v).toLocaleString(document.documentElement.lang):'—';
const tag=v=>`<span class="tag">${esc(v)}</span>`;
const connectionState=value=>['active','revoked','expired','reauthorize','disabled'].includes(value)?value:'disabled';
const table=(rows,head,row)=>rows?.length?`<div class="table-scroll"><table><thead><tr>${head.map(k=>`<th>${l(k)}</th>`).join('')}</tr></thead><tbody>${rows.map(row).join('')}</tbody></table>`:`<div class="empty">${l('empty')}</div>`;
const card=(title,body)=>`<section class="card"><h2>${l(title)}</h2>${body}</section>`;
const buttons=items=>`<div class="actions action-toolbar">${items.join('')}</div>`;
export const canAct=(caps,action)=>Array.isArray(caps.allowed_actions)?caps.allowed_actions.includes(action):caps.enabled===true&&(/^(security|oauth)\./.test(action)||caps.writable===true);
const inspect=(collection,id)=>`<button type="button" data-inspect="${collection}" data-id="${esc(id)}">${l('inspectDetails')}</button>`;
const pager=data=>`<div class="pagination">${data.offset?`<button type="button" data-offset="${Math.max(0,data.offset-(data.limit||25))}">${l('previous')}</button>`:''}${data.next_offset!=null?`<button type="button" data-offset="${data.next_offset}">${l('next')}</button>`:''}</div>`;
// Managed cloud connections are separate from OAuth authorizations and legacy Core credentials.
export function connectionPage(data,caps) {
 const cloud=data.cloud||{items:[],total:0},status=data.cloud_status||'active',can=a=>canAct(caps,a);
 const source=data.core_connections||[];
 const historical=c=>!!c.revoked_at||!!(c.expires_at&&Date.parse(c.expires_at)<=Date.now());
 const managed=c=>{let scopes=[];try{scopes=JSON.parse(c.scopes_json||'[]');}catch{}return ['mnemuron-console','chatgpt-web','mnemuron'].includes(c.agent_id)||scopes.some(s=>!['memory:read','memory:write'].includes(s));};
 const legacyRows=rows=>table(rows,['connectionName','connectionType','status','actions'],c=>`<tr><td>${esc(c.label)}<small>${esc(c.credential_id)}</small></td><td>${esc(c.agent_id)}</td><td>${l(c.revoked_at?'revoked':historical(c)?'connectionExpired':'active')}</td><td>${buttons([inspect('core_connections',c.credential_id),...(!managed(c)&&!historical(c)&&can('connections.rotate')?[actionButton('connections.rotate','rotateKey',{id:c.credential_id}),actionButton('connections.revoke','revoke',{id:c.credential_id})]:[])])}${managed(c)?`<small>${l('managedConnection')}</small>`:''}</td></tr>`);
 return `<section class="card connection-hub"><div class="connection-intro"><div><p class="eyebrow">${l('cloudConnectionLabel')}</p><h2>${l('cloudConnections')}</h2><p>${l('cloudConnectionNote')}</p></div><button class="primary" type="button" data-connection-wizard>${l('addConnection')}</button></div>
 <div class="connection-types">${[['chatgpt','chatgptPlugin','chatgptConnectNote','OAuth 2.1'],['mcp','generalMcp','generalMcpNote','Streamable HTTP'],['agents','agentTemplates','agentTemplatesNote','Coming later']].map(([kind,key,note,protocol])=>`<button type="button" class="connection-type" data-connection-guide="${kind}"><span class="tag">${kind==='agents'?l('comingSoon'):esc(protocol)}</span><strong>${l(key)}</strong><span>${l(note)}</span><span class="connection-type-link">${l(kind==='agents'?'comingSoon':'setupGuide')} →</span></button>`).join('')}</div>
 ${!can('cloud_connections.create')?`<p class="policy-box">${l('cloudDisabledNote')}</p>`:''}
 <div class="connection-toolbar"><div class="connection-tabs" role="group" aria-label="${esc(t('status'))}">${['active','history','all'].map(v=>`<button type="button" data-connection-status="${v}" aria-pressed="${status===v}">${l(v==='active'?'activeConnections':v==='history'?'connectionHistory':'allConnections')}</button>`).join('')}</div><form id="connection-search-form"><label class="sr-only" for="connection-query">${l('findConnection')}</label><input id="connection-query" name="query" maxlength="100" value="${esc(data.cloud_query||'')}" placeholder="${esc(t('findConnection'))}" data-i18n-placeholder="findConnection"><label class="sr-only" for="connection-kind">${l('connectionType')}</label><select id="connection-kind" name="kind">${[['','allConnectionTypes'],['chatgpt','chatgptPlugin'],['mcp','generalMcp']].map(([v,k])=>`<option value="${v}" ${v===(data.cloud_kind||'')?'selected':''} data-i18n="${k}">${esc(t(k))}</option>`).join('')}</select><button type="submit">${l('filter')}</button></form></div>
 ${table(cloud.items,['connectionName','access','status','lastVerified','actions'],c=>`<tr><td><strong>${esc(c.label)}</strong><small>${l(c.kind==='chatgpt'?'chatgptPlugin':'generalMcp')} · ${esc(c.connection_id.slice(0,8))}</small></td><td><span class="tag">${l(c.permission==='readwrite'?'readwrite':'readonly')}</span></td><td><span class="tag">${l('connectionState_'+connectionState(c.status))}</span><small>${l('expires')}: ${esc(time(c.expires))}</small></td><td>${c.last_used?esc(time(c.last_used)):l('notVerifiedYet')}</td><td>${buttons([`<button type="button" data-connection-guide="${esc(c.kind)}" data-id="${esc(c.connection_id)}">${l('setupGuide')}</button>`,...(!['revoked','expired'].includes(c.status)&&can('cloud_connections.rotate')?[actionButton('cloud_connections.rotate','rotateKey',{id:c.connection_id})]:[]),...(c.status!=='revoked'&&can('cloud_connections.revoke')?[actionButton('cloud_connections.revoke','revoke',{id:c.connection_id})]:[])])}</td></tr>`)}<div class="library-footer"><p>${l('matchingConnections')}: ${Number(cloud.total)||0}</p>${pager(cloud)}</div></section>
 <details class="card connection-secondary"><summary>${l('chatgptGrants')} <span class="tag">${data.connections?.length||0}</span></summary><p>${l('oauthGrantsNote')}</p>${table(data.connections,['oauthClient','expires','actions'],g=>`<tr><td>${esc(cloud.items.find(c=>c.client_id===g.client_id)?.label||g.client_id)}</td><td>${esc(time(g.expires))}</td><td>${buttons([inspect('connections',g.grant_id),...(can('oauth.revoke')?[actionButton('oauth.revoke','revoke',{id:g.grant_id})]:[])])}</td></tr>`)}</details>
 ${(source.some(c=>!historical(c)&&!managed(c))||can('connections.create'))?`<details class="card connection-secondary" data-legacy-connections><summary>${l('legacyAgentConnections')}</summary>${can('connections.create')?actionButton('connections.create','legacyAgentKey'):''}<p>${l('legacyConnectionNote')}</p>${legacyRows(source.filter(c=>!historical(c)&&!managed(c)))}</details>`:''}
 <details class="card connection-secondary"><summary>${l('systemConnections')} <span class="tag">${source.filter(c=>managed(c)&&!historical(c)).length}</span></summary><p>${l('systemConnectionNote')}</p>${legacyRows(source.filter(c=>managed(c)&&!historical(c)))}</details>
 <details class="card connection-secondary"><summary>${l('legacyConnectionHistory')} <span class="tag">${source.filter(historical).length}</span></summary><p>${l('historyPreservedNote')}</p>${legacyRows(source.filter(historical))}</details>${data.core_truncated?`<p class="policy-box">${l('boundedConnectionsNote')}</p>`:''}`;
}
export function connectionGuide(kind,resource,connection={}) {
 resource=connection.mcp_url||resource;
 if(kind==='agents')return `<p class="policy-box">${l('agentTemplatesNote')}</p><div class="connection-placeholder-grid">${['Codex','Claude Code','Cursor','OpenClaw','Hermes'].map(name=>`<div><strong>${name}</strong><span>${l('comingSoon')}</span></div>`).join('')}</div><p>${l('agentGenericFallback')}</p>`;
 const snippet={mcpServers:{mnemuron:{url:resource,headers:{Authorization:'Bearer <YOUR_MCP_ACCESS_TOKEN>'}}}};
 return `<p>${l(kind==='chatgpt'?'chatgptGuideIntro':'mcpGuideIntro')}</p><dl class="metadata-grid"><dt>${l('mcpEndpoint')}</dt><dd><code>${esc(resource||'—')}</code></dd><dt>${l('transport')}</dt><dd>Streamable HTTP</dd><dt>${l('authentication')}</dt><dd>${kind==='chatgpt'?'OAuth 2.1 / PKCE S256':'Authorization: Bearer'}</dd>${connection.client_id?`<dt>Client ID</dt><dd><code>${esc(connection.client_id)}</code></dd>`:''}${connection.redirect_uri?`<dt>${l('redirectUri')}</dt><dd><code>${esc(connection.redirect_uri)}</code></dd>`:''}</dl>
 <ol class="connection-steps">${(kind==='chatgpt'?['chatgptStep1','chatgptStep2','chatgptStep3','chatgptStep4']:['mcpStep1','mcpStep2','mcpStep3']).map(k=>`<li>${l(k)}</li>`).join('')}</ol>
 ${kind==='mcp'?`<p>${l('mcpExampleNote')}</p><pre class="configuration-example">${esc(JSON.stringify(snippet,null,2))}</pre>`:''}
 <p class="policy-box">${l('cloudScopeNote')}</p><p>${l('cloudEndpointNote')}</p><p>${l('cloudSecretNote')}</p>${connection.connection_id?`<p>${l('existingSecretNote')}</p>`:''}`;
}

export function actionPage(page,data,caps) {
  const management=caps.management??{invitations:caps.enabled,accounts:caps.enabled,roles:caps.enabled};
  if(['invitations','accounts'].includes(page)){
    if(!caps.operator)return card(page,`<p class="policy-box">${l('operatorRequired')}</p>`);
    if(!management[page])return card(page,`<p class="policy-box">${l('managementDisabled')}</p>`);
  }
  const writable=caps.enabled===true&&caps.writable===true,can=action=>canAct(caps,action);
  const onlyRead=()=>`<p class="policy-box">${l(caps.enabled?'consoleUpgradeRequired':'viewWithoutWrite')}</p>`;
  if(page==='models')return `<div class="columns">${(data.models||[]).map(m=>card(m.kind,`${tag(t(m.config.enabled?'enabled':'disabled'))}<p>${esc(m.config.model||t('modelNotConfigured'))}</p><code>${esc(m.config.base_url||'—')}</code><p>${l('dailyRequests')}: ${esc(m.config.daily_requests??'—')} · ${l('hasKey')}: ${l(m.has_key?'yes':'no')}</p>${buttons([inspect('models',m.kind),...(can('models.save')?[actionButton('models.save','configure',{kind:m.kind})]:[]),...(m.config.enabled&&can('models.test')?[actionButton('models.test','testModel',{kind:m.kind}),actionButton('models.disable','disable',{kind:m.kind})]:[])])}${!can('models.save')?onlyRead():''}`)).join('')}</div>${card('modelBoundary',`<p>${l('modelBoundaryNote')}</p>${can('vector.schedule')?actionButton('vector.schedule','rebuildIndex'):''}${!data.vector_enabled?`<p>${l('vectorNotConfigured')}</p>`:''}`)}`;
  if(page==='jobs')return card('jobs',`${writable?buttons([actionButton('jobs.schedule','organize',{type:'classification'}),actionButton('jobs.schedule','summarize',{type:'summary'})]):onlyRead()}
    <p>${l('scheduleStatus')}: ${l(data.settings?.schedule_enabled?'enabled':'disabled')} · ${l('workerStatus')}: ${l(data.worker_enabled?'enabled':'disabled')}</p>${!data.worker_enabled?`<p class="policy-box">${l('workerDisabledNote')}</p>`:''}
    ${table(data.jobs,['scope','state','progress','error','actions'],j=>`<tr><td><button type="button" data-job-detail="${esc(j.job_id)}">${esc(j.job_type)}</button><small>${esc(j.job_id)}</small></td><td>${tag(j.state)}</td><td>${j.processed} / ${j.total}</td><td>${esc(j.last_error_code||'—')}</td><td>${writable?buttons([...(j.state!=='succeeded'&&j.state!=='cancelled'?[actionButton('jobs.cancel','cancelJob',{id:j.job_id})]:[]),...(['dead_letter','blocked_auth','blocked_budget','blocked_config','review_required','retry_wait','cancelled'].includes(j.state)?[actionButton('jobs.retry','retry',{id:j.job_id})]:[])]):''}</td></tr>`)}
    ${data.vector?`<p>${l('vectorIndex')}: ${tag(data.vector.state)} ${esc(data.vector.error_code||'')}</p>`:''}${pager(data)}<button type="button" data-retry>${l('refresh')}</button>`);
  if(page==='connections')return connectionPage(data,caps);
  if(page==='security')return `<div class="columns">${card('accountSecurity',`<p>${esc(data.username)}</p>${tag(t(data.mfa_verified?'passwordTotp':'pending'))}${buttons([['security.password','changePassword'],['security.totp.begin','changeTotp'],['security.recovery_codes','rotateRecovery']].filter(([a])=>can(a)).map(([a,k])=>actionButton(a,k)))}${!can('security.password')?onlyRead():''}<p>${l('securityOperationsNote')}</p><a href="/recover">${l('recover')} →</a>`)}${card('sessions',`${can('security.sessions.revoke_others')?buttons([actionButton('security.sessions.revoke_others','revokeOtherSessions')]):''}${table(data.sessions,['created','expires','actions'],s=>`<tr><td>${esc(time(s.created))}${s.current?`<small>${l('currentSession')}</small>`:''}</td><td>${esc(time(s.expires))}</td><td>${buttons([inspect('sessions',s.session_id),...(can('security.session.revoke')?[actionButton('security.session.revoke','revoke',{id:s.session_id})]:[])])}</td></tr>`)}`)}</div>`;
  if(page==='invitations')return card('invitations',`${buttons([actionButton('invitations.issue','issue')])}<p>${l('invitationLimits')} ${esc(data.batch_limit)}</p><p>${l('invitationPrivateNote')}</p>${table(data.invitations,['invitationIdentifier','state','expires','actions'],i=>`<tr><td>${esc(i.invitation_id)}<small>${esc(i.batch_id)}</small></td><td>${tag(t(i.effective_state))}</td><td>${esc(time(i.expires))}</td><td>${['issued','reserved'].includes(i.effective_state)?buttons([actionButton('invitations.revoke','revoke',{id:i.invitation_id}),actionButton('invitations.revoke_batch','revokeBatch',{id:i.batch_id})]):''}</td></tr>`)}<button type="button" data-retry>${l('refresh')}</button>`);
  if(page==='accounts')return card('accounts',`<p>${l('accountAdminNote')}</p>${!management.roles?`<p class="policy-box">${l('rolesServerOnly')}</p>`:''}${table(data.accounts,['username','state','role','actions'],a=>`<tr><td>${esc(a.username)}${a.account_id===caps.account_id?`<small>${l('currentAccount')}</small>`:''}<small>${esc(a.account_id)}</small></td><td>${tag(t(a.status))}${a.maintenance_state==='revocation_pending'?`<small>${l('revocation_pending')}</small>`:''}<small>${l('mfaStatus')}: ${l(a.mfa_verified?'verified':'pending')} · ${l('bindingStatus')}: ${l(a.binding_ready?'ready':'pending')}</small></td><td>${tag(t(a.role))}</td><td>${buttons([...(a.account_id!==caps.account_id&&data.maintenance_enabled&&a.maintenance_state!=='revocation_pending'&&['active','disabled'].includes(a.status)?[actionButton(a.status==='active'?'accounts.disable':'accounts.enable',a.status==='active'?'disable':'enable',{id:a.account_id})]:[]),...(management.roles?[actionButton('accounts.role',a.role==='operator'?'revokeOperator':'grantOperator',{id:a.account_id,operator:String(a.role!=='operator')})]:[])])}</td></tr>`)}${!data.maintenance_enabled?`<p>${l('maintenanceRequired')}</p>`:''}<button type="button" data-retry>${l('refresh')}</button>`);
  if(page==='storage')return card('personalExport',`<p>${l('portableNote')}</p>${writable?buttons([actionButton('storage.export','export'),actionButton('storage.import','importMemories')]):onlyRead()}${table(Object.entries(data.counts||{}),['scope','memoryCount'],([k,n])=>`<tr><td>${esc(k)}</td><td>${n}</td></tr>`)}<p class="policy-box">${l('databaseRestoreNote')}</p>`);
  return null;
}
const field=(name,key,{value='',type='text',required=true,max=4096,min,upper,step}={})=>`<label>${l(key)}<input name="${name}" type="${type}" value="${esc(value)}" maxlength="${max}"${min!==undefined?` min="${min}"`:''}${upper!==undefined?` max="${upper}"`:''}${step!==undefined?` step="${step}"`:''} ${required?'required':''} ${type==='password'?'autocomplete="off"':''}></label>`;
const area=(name,key,value='')=>`<label>${l(key)}<textarea name="${name}" maxlength="4096" rows="7" required>${esc(value)}</textarea></label>`;
const select=(name,key,items,value)=>`<label>${l(key)}<select name="${name}">${items.map(v=>`<option data-i18n="${esc(v)}" value="${esc(v)}" ${v===value?'selected':''}>${esc(t(v))}</option>`).join('')}</select></label>`;
const check=(name,key,value=false)=>`<label class="check-field"><input type="checkbox" name="${name}" ${value?'checked':''}>${l(key)}</label>`;
const reauth=()=>`<fieldset class="reauth"><legend>${l('reauthenticate')}</legend>${field('current_password','currentPassword',{type:'password',max:1024})}${field('otp','otp',{max:6})}<p>${l('otpFreshNote')}</p></fieldset>`;
const modalActions=(submit='save')=>`<div class="actions"><button type="submit" class="primary">${l(submit)}</button><button type="button" data-operation-close>${l('cancel')}</button></div><p data-operation-error role="alert"></p>`;

export function mountActions({api,mutate,getData,getCaps,reload,isActive}) {
  const modal=document.createElement('dialog');modal.id='operation-dialog';modal.setAttribute('aria-labelledby','operation-title');modal.innerHTML='<div class="dialog-header"><h2 id="operation-title"></h2><button type="button" data-operation-close aria-label="Close">×</button></div><div id="operation-content"></div>';document.body.append(modal);
  const content=modal.querySelector('#operation-content');let intent=null,opId=null,lastPayload=null,returnFocus=null,sequence=0,working=false;
  function open(title){sequence++;returnFocus=document.activeElement;modal.querySelector('h2').textContent=t(title);content.innerHTML=`<p>${l('loading')}</p>`;if(!modal.open)modal.showModal();}
  function result(data){
    if(data.connection_id&&(data.client_secret||data.access_token)){
      intent=null;content.innerHTML=`<p class="policy-box">${l('saveConnectionSecret')}</p>`+connectionGuide(data.connection.kind,data.resource,data.connection);
      const block=document.createElement('pre');block.id='new-connection-credentials';block.className='operation-result';block.textContent=JSON.stringify(data.client_secret?{client_id:data.client_id,client_secret:data.client_secret}:{access_token:data.access_token,token_type:'Bearer'},null,2);
      const copy=document.createElement('button');copy.type='button';copy.dataset.copy=block.id;copy.textContent=t('copy');content.prepend(block,copy);
      const close=document.createElement('button');close.type='button';close.dataset.operationClose='';close.textContent=t('close');content.append(close);syncAppearance();return;
    }
    content.replaceChildren();const pre=document.createElement('pre');pre.className='operation-result';const {qr_svg,...display}=data;pre.textContent=JSON.stringify(display,null,2);content.append(pre);
    if(data.codes&&data.batch_id){
      const note=document.createElement('p');note.textContent=t('invitationSavedNote');
      const codes=document.createElement('pre');codes.id='issued-invitation-codes';codes.className='operation-result';codes.textContent=data.codes.join('\n');
      const copy=document.createElement('button');copy.type='button';copy.dataset.copy=codes.id;copy.textContent=t('copy');
      content.prepend(note,codes,copy);pre.textContent=JSON.stringify({...display,codes:undefined},null,2);
    }
    if(data.login_required){const a=document.createElement('a');a.href='/login';a.textContent=t('signIn');content.append(a);}
    if(data.qr_svg){const qr=document.createElement('div');qr.className='qr';qr.innerHTML=data.qr_svg;content.prepend(qr);}
    if(data.enrollment_id){const f=document.createElement('form');f.innerHTML=field('new_otp','otp',{max:6})+modalActions('verify');content.append(f);intent={action:'security.totp.complete',enrollment_id:data.enrollment_id};opId=crypto.randomUUID();lastPayload=null;}
    else {intent=null;const b=document.createElement('button');b.type='button';b.dataset.operationClose='';b.textContent=t('close');content.append(b);}
  }
  function inspectResult(data){
    intent=null;const row=data.job||data,values={...row,...row.config};
    const fields={kind:'scope',job_type:'jobType',state:'state',enabled:'enabled',model:'modelName',base_url:'baseUrl',protocol:'protocol',revision:'revisions',daily_requests:'dailyRequests',has_key:'hasKey',client_id:'oauthClient',grant_id:'operationId',credential_id:'operationId',label:'label',agent_id:'agentId',device_id:'deviceId',agent_instance_id:'agentInstance',scope:'scope',scopes:'scope',scopes_json:'scope',purpose:'scope',created:'created',created_at:'created',updated_at:'updated',expires:'expires',expires_at:'expires',last_used_at:'lastUsed',session_id:'sessionIdentifier',current:'currentSession',total:'sourceCount',processed:'processedCount',attempt_count:'attemptCount',last_error_code:'error',result_ref:'resultReference'};
    const dateFields=new Set(['created','created_at','updated_at','expires','expires_at','last_used_at']);
    const dl=document.createElement('dl');dl.className='metadata-grid';
    for(const [key,label] of Object.entries(fields))if(values[key]!==undefined){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=t(label);const v=values[key];dd.textContent=v===null?'—':dateFields.has(key)?time(v):typeof v==='boolean'?t(v?'yes':'no'):Array.isArray(v)?v.join(', '):String(v);dl.append(dt,dd);}
    const raw=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=t('technicalDetails');pre.className='operation-result';pre.textContent=JSON.stringify(data,null,2);raw.append(summary,pre);
    const close=document.createElement('button');close.type='button';close.dataset.operationClose='';close.textContent=t('close');content.replaceChildren(dl,raw,close);
  }
  function guide(kind,id){
    if(working)return;const connection=getData().cloud?.items.find(c=>c.connection_id===id)||{};
    open(kind==='agents'?'agentTemplates':'setupGuide');intent=null;content.innerHTML=connectionGuide(kind,getCaps().resource,connection)+
      (kind!=='agents'&&!id?`<div class="actions">${canAct(getCaps(),'cloud_connections.create')?actionButton('cloud_connections.create','generateConnection',{kind}):`<p class="policy-box">${l('cloudDisabledNote')}</p>`}</div>`:'')+`<button type="button" data-operation-close>${l('close')}</button>`;syncAppearance();
  }
  function wizard(){if(working)return;open('addConnection');intent=null;content.innerHTML=`<p>${l('chooseConnectionType')}</p><div class="connection-types">${[['chatgpt','chatgptPlugin'],['mcp','generalMcp'],['agents','agentTemplates']].map(([kind,key])=>`<button class="connection-type" type="button" data-connection-guide="${kind}"><strong>${l(key)}</strong><span>${l(kind==='agents'?'comingSoon':'setupGuide')} →</span></button>`).join('')}</div><button type="button" data-operation-close>${l('close')}</button>`;syncAppearance();}
  async function begin(action,button){if(working)return;open(action);const seq=sequence;opId=crypto.randomUUID();lastPayload=null;intent={action,id:button.dataset.id,kind:button.dataset.kind,operator:button.dataset.operator};
    try{
      let fields='',data=getData();
      if(action==='cloud_connections.create'){
        const kind=intent.kind==='chatgpt'?'chatgpt':'mcp';intent.kind=kind;const policy=getCaps().cloud_connections||{};
        const writable=policy.allow_write&&canAct(getCaps(),'memory.create');
        fields=`<p>${l(kind==='chatgpt'?'chatgptGenerateNote':'mcpGenerateNote')}</p>`+field('label','connectionName',{max:100})+select('permission','access',writable?['readonly','readwrite']:['readonly'],'readonly')+field('ttl_days','ttlDays',{type:'number',value:Math.min(30,policy.max_ttl_days||30),min:1,upper:policy.max_ttl_days||30,step:1})+
          (kind==='chatgpt'?field('redirect_uri','redirectUri',{max:2048}):'')+`<p class="policy-box">${l('cloudScopeNote')}</p>`+reauth();
      }else if(action==='cloud_connections.rotate'||action==='cloud_connections.revoke'){
        const c=data.cloud?.items.find(c=>c.connection_id===intent.id);if(!c)throw new Error('CONNECTION_NOT_FOUND');
        fields=`<p><strong>${esc(c.label)}</strong></p><p>${l(action.endsWith('rotate')?'connectionRotateNote':'connectionRevokeNote')}</p>`+reauth();
      }else if(action==='memory.create')fields=area('content','content')+select('memory_type','memoryType',['fact','goal','constraint','decision','completed','blocker','remaining','next_step'],'fact')+field('topic','topic',{required:false,max:120})+select('scope','scope',['user','project','task','workstream','session'],'user')+field('target_id','scopeTarget',{required:false,max:128})+select('sensitivity','sensitivity',['sensitive','internal','public','secret'],'sensitive');
      else if(action.startsWith('memory.')){
        const meta=await api('memory',{memory_id:intent.id,metadata:'true'});if(seq!==sequence||!isActive())return;intent.meta=meta;
        if(action==='memory.correct'){
          const page=await api('memory',{memory_id:intent.id,content_limit:4096,revision:meta.revision});if(seq!==sequence||!isActive())return;
          if(!page.content_complete)throw new Error('EDIT_REQUIRES_COMPLETE_RECORD');fields=area('content','content',page.memory.content)+field('reason','reason',{required:false})+field('topic','topic',{value:meta.topic||'',required:false,max:120});
        } else if(action==='memory.classify')fields=select('category','category',getCaps().taxonomy.categories,meta.category);
        else if(action==='memory.sensitivity')fields=select('sensitivity','sensitivity',['sensitive','internal','public','secret'],meta.sensitivity)+`<p>${l('sensitivityNote')}</p>`;
        else if(action==='memory.visibility')fields=check('allow','allowChatGPT',meta.web_allowed)+`<p>${l('grantRevisionNote')}</p>`;
        else fields=field('reason','reason',{required:false})+`<p>${l('retractNote')}</p>`;
      } else if(action==='jobs.schedule'){
        intent.type=button.dataset.type||'classification';const status=await api('jobs');if(seq!==sequence||!isActive())return;const settings=status.settings||{revision:0,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,schedule_enabled:false};
        intent.settings_revision=settings.revision;fields=select('type','jobType',['classification','summary'],intent.type)+field('timezone','timezone',{value:settings.timezone})+check('include_open','includeOpen')+check('schedule_enabled','enablePeriodic',settings.schedule_enabled)+`<p>${l('organizeCostNote')}</p>`;
      } else if(action==='models.save'){
        const model=data.models.find(m=>m.kind===intent.kind),c=model?.config||{};intent.revision=model?.revision||0;
        fields=check('enabled','enabled',c.enabled)+select('protocol','protocol',['openai_compatible','ollama'],c.protocol||'openai_compatible')+field('base_url','baseUrl',{value:c.base_url||'',max:2048})+field('model','modelName',{value:c.model||''})+field('profile_revision','modelRevision',{value:c.profile_revision||'1'})+
          field('api_key','apiKey',{type:'password',required:false,max:16384})+check('remove_key','removeKey')+(intent.kind==='embedder'?field('dimensions','dimensions',{type:'number',value:c.dimensions||''}):'')+
          field('daily_requests','dailyRequests',{type:'number',value:c.daily_requests||100})+field('output_tokens','outputTokens',{type:'number',value:c.output_tokens||4096})+field('batch_size','batchSize',{type:'number',value:c.batch_size||5})+
          select('sensitivity','modelSensitivity',['public','internal','sensitive'],c.sensitivities?.includes('sensitive')?'sensitive':c.sensitivities?.includes('internal')?'internal':'public')+check('egress_approved','approveEgress',c.egress_approved)+check('query_approved','approveQuery',c.query_approved)+(intent.kind==='organizer'?check('native_schema','nativeSchema',c.native_schema!==false):'')+`<p>${l('keyWriteOnlyNote')}</p>`;
      } else if(action==='connections.create')fields=field('label','label',{max:120})+field('agent_id','agentId',{max:128})+field('device_id','deviceId',{max:128})+select('access','access',['read','read_write'],'read');
      else if(action==='security.password')fields=field('new_password','newPassword',{type:'password',max:1024})+field('password_confirm','passwordConfirm',{type:'password',max:1024})+reauth();
      else if(action==='security.totp.begin'||action==='security.recovery_codes')fields=reauth();
      else if(action==='invitations.issue')fields=`<p>${l('invitationPrivateNote')}</p>`+field('count','count',{type:'number',value:1,min:1,upper:getCaps().invitation_batch_limit,step:1})+field('ttl_minutes','ttlMinutes',{type:'number',value:60,min:1,upper:1440,step:1})+reauth();
      else if(action.startsWith('invitations.')||action.startsWith('accounts.'))fields=`<p>${esc(data.accounts?.find(a=>a.account_id===intent.id)?.username||'')} <code>${esc(intent.id)}</code></p>${action==='accounts.disable'?`<p class="policy-box">${l('disableAccountNote')}</p>`:action==='accounts.enable'?`<p>${l('enableAccountNote')}</p>`:''}`+reauth();
      else if(action==='storage.import')fields=`<p>${l('portableNote')}</p><label>${l('file')}<input type="file" name="file" accept="application/json,.json" required></label><label class="check-field"><input type="checkbox" name="confirm_import" required>${l('confirmImport')}</label>`;
      else fields=`<p>${l(action==='storage.export'?'exportPrivacyNote':action==='models.test'?'probeCostNote':'confirmAction')}</p><code>${esc(intent.id||intent.kind||'')}</code>`;
      if(seq!==sequence||!isActive())return;content.innerHTML=`<form id="operation-form">${fields}${modalActions(action==='storage.export'?'export':'confirm')}</form>`;syncAppearance();content.querySelector('input,textarea,select,button')?.focus();
    }catch(e){if(seq!==sequence||!isActive())return;content.innerHTML=`<p role="alert">${esc(t(e.message))}</p><button type="button" data-operation-close>${l('close')}</button>`;}
  }
  function payload(fd){const a=intent.action,p={};
    if(a==='cloud_connections.create'){Object.assign(p,{kind:intent.kind,label:fd.get('label'),permission:fd.get('permission'),ttl_days:Number(fd.get('ttl_days')),current_password:fd.get('current_password'),otp:fd.get('otp')});if(intent.kind==='chatgpt')p.redirect_uri=fd.get('redirect_uri');}
    else if(a==='cloud_connections.rotate'||a==='cloud_connections.revoke')Object.assign(p,{connection_id:intent.id,current_password:fd.get('current_password'),otp:fd.get('otp')});
    else if(a==='memory.create'){Object.assign(p,{content:fd.get('content'),memory_type:fd.get('memory_type'),scope:fd.get('scope'),sensitivity:fd.get('sensitivity')});if(fd.get('topic'))p.topic=fd.get('topic');if(p.scope!=='user')p[`${p.scope}_id`]=fd.get('target_id');}
    else if(a.startsWith('memory.')){Object.assign(p,{memory_id:intent.id,revision:intent.meta.revision});if(a==='memory.correct'){p.content=fd.get('content');p.topic=fd.get('topic')||null;p.memory_type=intent.meta.memory_type;}if(fd.get('reason'))p.reason=fd.get('reason');if(a==='memory.classify')p.category=fd.get('category');if(a==='memory.sensitivity')p.sensitivity=fd.get('sensitivity');if(a==='memory.visibility'){p.allow=fd.has('allow');p.state_hash=intent.meta.state_hash;}}
    else if(a==='jobs.schedule')Object.assign(p,{type:fd.get('type'),timezone:fd.get('timezone'),periods:['daily','weekly'],include_open:fd.has('include_open'),schedule_enabled:fd.has('schedule_enabled'),settings_revision:intent.settings_revision});
    else if(a==='jobs.cancel'||a==='jobs.retry')p.job_id=intent.id;
    else if(a==='models.save'){
      p.kind=intent.kind;p.expected_revision=intent.revision;const sensitivity=fd.get('sensitivity');p.config={enabled:fd.has('enabled'),protocol:fd.get('protocol'),base_url:fd.get('base_url'),model:fd.get('model'),profile_revision:fd.get('profile_revision'),daily_requests:Number(fd.get('daily_requests')),output_tokens:Number(fd.get('output_tokens')),batch_size:Number(fd.get('batch_size')),sensitivities:sensitivity==='public'?['public']:sensitivity==='internal'?['public','internal']:['public','internal','sensitive'],egress_approved:fd.has('egress_approved'),query_approved:fd.has('query_approved'),native_schema:intent.kind==='organizer'?fd.has('native_schema'):true};if(intent.kind==='embedder')p.config.dimensions=Number(fd.get('dimensions'));if(fd.get('api_key'))p.api_key=fd.get('api_key');if(fd.has('remove_key'))p.remove_key=true;
    } else if(a==='models.test'||a==='models.disable'){p.kind=intent.kind;if(a==='models.disable')p.expected_revision=getData().models.find(m=>m.kind===intent.kind).revision;}
    else if(a==='connections.create')for(const k of ['label','agent_id','device_id','access'])p[k]=fd.get(k);
    else if(a.startsWith('connections.'))p.credential_id=intent.id;
    else if(a==='oauth.revoke')p.grant_id=intent.id;
    else if(a==='security.password'){p.new_password=fd.get('new_password');p.password_confirm=fd.get('password_confirm');}
    else if(a==='security.totp.complete'){p.enrollment_id=intent.enrollment_id;p.new_otp=fd.get('new_otp');}
    else if(a==='security.session.revoke')p.session_id=intent.id;
    else if(a==='invitations.issue'){p.count=Number(fd.get('count'));p.ttl_minutes=Number(fd.get('ttl_minutes'));}
    else if(a==='invitations.revoke')p.invitation_id=intent.id;
    else if(a==='invitations.revoke_batch')p.batch_id=intent.id;
    else if(a.startsWith('accounts.')){p.account_id=intent.id;if(a==='accounts.role')p.operator=intent.operator==='true';}
    if(fd.has('current_password')){p.current_password=fd.get('current_password');p.otp=fd.get('otp');}return p;
  }
  async function exportFile(){let p={},records=[],pages=0,bytes=0;do{const page=await api('export',p);if(!isActive())throw new Error('STALE_ACCOUNT');bytes+=new TextEncoder().encode(JSON.stringify(page.records)).length;if(bytes>16*1024*1024)throw new Error('EXPORT_SIZE_LIMIT');records.push(...page.records);p=page.next_request;if(++pages>10000)throw new Error('EXPORT_PAGE_LIMIT');}while(p);
    const blob=new Blob([JSON.stringify({format:'mnemuron-personal-portable-v1',records},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='mnemuron-personal-memories.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return {status:'exported',records:records.length,includes_credentials:false};}
  async function importFile(fd){const file=fd.get('file');if(!file||file.size>16*1024*1024)throw new Error('IMPORT_FILE_TOO_LARGE');const doc=JSON.parse(await file.text());if(doc.format!=='mnemuron-personal-portable-v1'||!Array.isArray(doc.records)||!doc.records.length)throw new Error('INVALID_IMPORT');
    // Preflight every record before sending any chunk. No SQL, credentials or scopes from files are executable.
    for(const r of doc.records)if(typeof r.content!=='string'||r.content.length>4096||!r.content.trim())throw new Error('IMPORT_CONTENT_TOO_LONG');
    let created=0,existing=0;
    for(const [i,r] of doc.records.entries()){if(!isActive())throw new Error('STALE_ACCOUNT');try{const res=await mutate('storage.import',{format:doc.format,records:[r],confirm_personal_scope:true},`${opId}.${i}`);created+=res.created;existing+=res.existing;}
      catch(e){throw new Error(`${t('importPartial')}: ${i}/${doc.records.length} · ${e.message}`);}}
    return {status:'imported',created,existing,originals_overwritten:false};
  }
  modal.addEventListener('submit',async event=>{event.preventDefault();if(!intent||working)return;const fd=new FormData(event.target),action=intent.action;const seq=sequence;working=true;
    const controls=[...event.target.querySelectorAll('button,input,select,textarea')];controls.forEach(c=>c.disabled=true);
    try{let data;if(action==='storage.export')data=await exportFile();else if(action==='storage.import')data=await importFile(fd);else{const p=payload(fd),serialized=JSON.stringify(p);if(lastPayload!==null&&lastPayload!==serialized)opId=crypto.randomUUID();lastPayload=serialized;data=await mutate(action,p,opId);}
      if(seq!==sequence||!isActive())return;event.target.reset();result(data);if(!data.login_required)await reload();
    }catch(e){if(seq!==sequence||!isActive())return;const error=content.querySelector('[data-operation-error]');if(error)error.textContent=`${t(e.message)} · ${t('operationId')}: ${opId}`;}
    finally{working=false;controls.forEach(c=>c.disabled=false);}
  });
  document.addEventListener('click',event=>{const g=event.target.closest('[data-connection-guide]');if(g){guide(g.dataset.connectionGuide,g.dataset.id);return;}if(event.target.closest('[data-connection-wizard]')){wizard();return;}const b=event.target.closest('[data-console-action]');if(b){void begin(b.dataset.consoleAction,b);return;}if(event.target.closest('[data-operation-close]')&&!working)modal.close();
    const inspection=event.target.closest('[data-inspect]');if(inspection){const keys={models:'kind',connections:'grant_id',core_connections:'credential_id',sessions:'session_id'};const key=keys[inspection.dataset.inspect];if(!key)return;const item=getData()[inspection.dataset.inspect]?.find(row=>String(row[key])===inspection.dataset.id);if(item){open('inspectDetails');inspectResult(item);}return;}
    const job=event.target.closest('[data-job-detail]');if(job){open('jobs');const seq=sequence;void api('jobs',{job_id:job.dataset.jobDetail}).then(data=>{if(seq===sequence&&modal.open&&isActive())inspectResult(data);}).catch(e=>{if(seq===sequence&&modal.open&&isActive())content.textContent=t(e.message);});}});
  modal.addEventListener('cancel',event=>{if(working)event.preventDefault();});
  modal.addEventListener('close',()=>{sequence++;intent=null;opId=null;lastPayload=null;content.replaceChildren();returnFocus?.focus();returnFocus=null;});
  return {clear(){sequence++;intent=null;opId=null;lastPayload=null;working=false;content.replaceChildren();modal.close();}};
}

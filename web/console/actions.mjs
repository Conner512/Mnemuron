import {translate as t,syncAppearance} from './appearance.mjs';
import {connectionsView} from './connections.mjs';
import {icon} from './visuals.mjs';

// Settings and operations pages. Views are markup only; every write goes through
// mountActions below (explicit dialog, fresh operation ID, server-side authorization).
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const l=k=>`<span data-i18n="${k}">${esc(t(k))}</span>`;
export const actionButton=(action,key,values={})=>`<button type="button" data-console-action="${action}" ${Object.entries(values).map(([k,v])=>`data-${k}="${esc(v)}"`).join(' ')}>${l(key)}</button>`;
const time=v=>v?new Date(typeof v==='number'&&v<1e12?v*1000:v).toLocaleString(document.documentElement.lang):'—';
const tag=(v,kind='')=>`<span class="tag"${kind?` data-state="${esc(kind)}"`:''}>${esc(v)}</span>`;
const state=v=>`<span class="state-dot" data-state="${esc(v)}">${esc(t(v))}</span>`;
const table=(rows,head,row)=>rows?.length?`<div class="table-scroll"><table><thead><tr>${head.map(k=>`<th>${l(k)}</th>`).join('')}</tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>`:`<div class="empty">${icon('library')}${l('empty')}</div>`;
const section=(title,body,{aside='',className=''}={})=>`<section class="card ${className}"><header class="section-head"><h2>${l(title)}</h2>${aside}</header>${body}</section>`;
const buttons=items=>items.length?`<div class="actions action-toolbar">${items.join('')}</div>`:'';
const kv=pairs=>`<dl class="metadata-grid">${pairs.map(([k,v])=>`<dt>${l(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;
const note=key=>`<p class="policy-box">${l(key)}</p>`;
const refresh=()=>`<button type="button" class="quiet" data-retry>${l('refresh')}</button>`;
export const canAct=(caps,action)=>Array.isArray(caps.allowed_actions)?caps.allowed_actions.includes(action):caps.enabled===true&&(/^(security|oauth)\./.test(action)||caps.writable===true);
const inspect=(collection,id)=>`<button type="button" class="quiet" data-inspect="${collection}" data-id="${esc(id)}">${l('inspectDetails')}</button>`;
const pager=data=>`<div class="pagination">${data.offset?`<button type="button" data-offset="${Math.max(0,data.offset-(data.limit||25))}">${l('previous')}</button>`:''}${data.next_offset!=null?`<button type="button" data-offset="${data.next_offset}">${l('next')}</button>`:''}</div>`;
const progress=(done,total)=>{const n=Number(done)||0,m=Number(total)||0,w=m>0?Math.min(100,Math.round(n/m*100)):0;return `<span class="progress"><svg viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="track" width="100" height="4" rx="2"/><rect class="fill" width="${w}" height="4" rx="2"/></svg><span>${n} / ${m}</span></span>`;};

export function actionPage(page,data,caps,connectionQuery={}) {
  const management=caps.management??{invitations:caps.enabled,accounts:caps.enabled,roles:caps.enabled};
  if(['invitations','accounts','system'].includes(page)){
    if(!caps.operator)return section(page,note('operatorRequired'));
    if(page!=='system'&&!management[page])return section(page,note('managementDisabled'));
  }
  const writable=caps.enabled===true&&caps.writable===true,can=action=>canAct(caps,action);
  const onlyRead=()=>note(caps.enabled?'consoleUpgradeRequired':'viewWithoutWrite');

  if(page==='models')return `<div class="card-grid">${(data.models||[]).map(m=>section(m.kind,
      kv([['modelName',esc(m.config.model||t('modelNotConfigured'))],['baseUrl',`<code>${esc(m.config.base_url||'—')}</code>`],['dailyRequests',esc(m.config.daily_requests??'—')],['hasKey',l(m.has_key?'yes':'no')]])+
      buttons([inspect('models',m.kind),...(can('models.save')?[actionButton('models.save','configure',{kind:m.kind})]:[]),...(m.config.enabled&&can('models.test')?[actionButton('models.test','testModel',{kind:m.kind}),actionButton('models.disable','disable',{kind:m.kind})]:[])])+(!can('models.save')?onlyRead():''),
      {aside:state(m.config.enabled?'enabled':'disabled'),className:'model-card'})).join('')}</div>`+
    section('modelBoundary',`<p>${l('modelBoundaryNote')}</p>${can('vector.schedule')?buttons([actionButton('vector.schedule','rebuildIndex')]):''}${!data.vector_enabled?`<p class="muted">${l('vectorNotConfigured')}</p>`:''}`);

  if(page==='jobs')return section('jobs',`<div class="status-line">${l('scheduleStatus')} ${state(data.settings?.schedule_enabled?'enabled':'disabled')}<span aria-hidden="true">·</span>${l('workerStatus')} ${state(data.worker_enabled?'enabled':'disabled')}${data.vector?`<span aria-hidden="true">·</span>${l('vectorIndex')} ${state(data.vector.state)} ${esc(data.vector.error_code||'')}`:''}</div>
    ${writable?buttons([actionButton('jobs.schedule','organize',{type:'classification'}),actionButton('jobs.schedule','summarize',{type:'summary'})]):onlyRead()}
    ${!data.worker_enabled?note('workerDisabledNote'):''}
    ${table(data.jobs,['scope','state','progress','error','actions'],j=>`<tr><td><button type="button" class="link-button" data-job-detail="${esc(j.job_id)}">${esc(t(j.job_type))}</button><small><code>${esc(j.job_id)}</code></small></td><td>${state(j.state)}</td><td>${progress(j.processed,j.total)}</td><td>${esc(j.last_error_code||'—')}</td><td>${writable?buttons([...(j.state!=='succeeded'&&j.state!=='cancelled'?[actionButton('jobs.cancel','cancelJob',{id:j.job_id})]:[]),...(['dead_letter','blocked_auth','blocked_budget','blocked_config','review_required','retry_wait','cancelled'].includes(j.state)?[actionButton('jobs.retry','retry',{id:j.job_id})]:[])]):''}</td></tr>`)}
    <div class="section-foot">${pager(data)}</div>`,{aside:refresh()});

  if(page==='connections')return connectionsView(data,caps,connectionQuery);

  if(page==='security')return `<div class="columns">${section('accountSecurity',`<div class="identity-row"><span class="avatar" aria-hidden="true">${esc([...(data.username||'·')][0])}</span><div><strong>${esc(data.username)}</strong>${tag(t(data.mfa_verified?'passwordTotp':'pending'))}</div></div>
      ${buttons([['security.password','changePassword'],['security.totp.begin','changeTotp'],['security.recovery_codes','rotateRecovery']].filter(([a])=>can(a)).map(([a,k])=>actionButton(a,k)))}${!can('security.password')?onlyRead():''}<p class="muted">${l('securityOperationsNote')}</p><a href="/recover">${l('recover')} →</a>`)}
    ${section('sessions',table(data.sessions,['created','expires','actions'],s=>`<tr><td>${esc(time(s.created))}${s.current?`<small>${l('currentSession')}</small>`:''}</td><td>${esc(time(s.expires))}</td><td>${buttons([inspect('sessions',s.session_id),...(can('security.session.revoke')?[actionButton('security.session.revoke','revoke',{id:s.session_id})]:[])])}</td></tr>`),{aside:can('security.sessions.revoke_others')?actionButton('security.sessions.revoke_others','revokeOtherSessions'):''})}</div>`;

  if(page==='invitations')return section('invitations',`<p class="muted">${l('invitationLimits')} ${esc(data.batch_limit)} · ${l('invitationPrivateNote')}</p>${table(data.invitations,['invitationIdentifier','state','expires','actions'],i=>`<tr><td><code>${esc(i.invitation_id)}</code><small>${esc(i.batch_id)}</small></td><td>${state(i.effective_state)}</td><td>${esc(time(i.expires))}</td><td>${['issued','reserved'].includes(i.effective_state)?buttons([actionButton('invitations.revoke','revoke',{id:i.invitation_id}),actionButton('invitations.revoke_batch','revokeBatch',{id:i.batch_id})]):''}</td></tr>`)}`,{aside:`${refresh()}${actionButton('invitations.issue','issue')}`});

  if(page==='accounts')return section('accounts',`<p class="muted">${l('accountAdminNote')}</p>${!management.roles?note('rolesServerOnly'):''}${table(data.accounts,['username','state','role','actions'],a=>`<tr><td><strong>${esc(a.username)}</strong>${a.account_id===caps.account_id?`<small>${l('currentAccount')}</small>`:''}<small><code>${esc(a.account_id)}</code></small></td><td>${state(a.status)}${a.maintenance_state==='revocation_pending'?`<small>${l('revocation_pending')}</small>`:''}<small>${l('mfaStatus')}: ${l(a.mfa_verified?'verified':'pending')} · ${l('bindingStatus')}: ${l(a.binding_ready?'ready':'pending')}</small></td><td>${tag(t(a.role))}</td><td>${buttons([...(a.account_id!==caps.account_id&&data.maintenance_enabled&&a.maintenance_state!=='revocation_pending'&&['active','disabled'].includes(a.status)?[actionButton(a.status==='active'?'accounts.disable':'accounts.enable',a.status==='active'?'disable':'enable',{id:a.account_id})]:[]),...(management.roles?[actionButton('accounts.role',a.role==='operator'?'revokeOperator':'grantOperator',{id:a.account_id,operator:String(a.role!=='operator')})]:[])])}</td></tr>`)}${!data.maintenance_enabled?`<p class="muted">${l('maintenanceRequired')}</p>`:''}`,{aside:refresh()});

  if(page==='storage')return `<div class="columns">${section('personalExport',`<p>${l('portableNote')}</p>${writable?buttons([actionButton('storage.export','export'),actionButton('storage.import','importMemories')]):onlyRead()}${note('databaseRestoreNote')}`)}
    ${section('storage',kv(Object.entries(data.counts||{}).map(([k,n])=>[k,`<strong class="figure">${esc(n)}</strong>`])))}</div>`;

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
  function result(data){content.replaceChildren();const pre=document.createElement('pre');pre.className='operation-result';const {qr_svg,...display}=data;pre.textContent=JSON.stringify(display,null,2);content.append(pre);
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
  async function begin(action,button){if(working)return;open(action);const seq=sequence;opId=crypto.randomUUID();lastPayload=null;intent={action,id:button.dataset.id,kind:button.dataset.kind,operator:button.dataset.operator};
    try{
      let fields='',data=getData();
      if(action==='memory.create')fields=area('content','content')+select('memory_type','memoryType',['fact','goal','constraint','decision','completed','blocker','remaining','next_step'],'fact')+field('topic','topic',{required:false,max:120})+select('scope','scope',['user','project','task','workstream','session'],'user')+field('target_id','scopeTarget',{required:false,max:128})+select('sensitivity','sensitivity',['sensitive','internal','public','secret'],'sensitive');
      else if(action==='memory.web_policy'){
        // The page read the current policy; its revision guards against a change made in another tab.
        intent.enable=button.dataset.enabled==='true';intent.revision=(data.web_policy??getCaps().web_policy)?.revision??0;
        fields=`<p>${l(intent.enable?'webPolicyEnableNote':'webPolicyDisableNote')}</p>`+(intent.enable?`<label class="check-field"><input type="checkbox" name="confirm_web_policy" required>${l('webPolicyConfirm')}</label>`:'');
      }
      else if(action.startsWith('memory.')){
        const meta=await api('memory',{memory_id:intent.id,metadata:'true'});if(seq!==sequence||!isActive())return;intent.meta=meta;
        if(action==='memory.correct'){
          const page=await api('memory',{memory_id:intent.id,content_limit:4096,revision:meta.revision});if(seq!==sequence||!isActive())return;
          if(!page.content_complete)throw new Error('EDIT_REQUIRES_COMPLETE_RECORD');fields=area('content','content',page.memory.content)+field('reason','reason',{required:false})+field('topic','topic',{value:meta.topic||'',required:false,max:120});
        } else if(action==='memory.classify')fields=select('category','category',getCaps().taxonomy.categories,meta.category);
        else if(action==='memory.sensitivity')fields=select('sensitivity','sensitivity',['sensitive','internal','public','secret'],meta.sensitivity)+`<p>${l('sensitivityNote')}</p>`;
        else if(action==='memory.visibility')fields=check('allow','allowChatGPT',meta.web_allowed)+`<p>${l('grantRevisionNote')}</p>`+(getCaps().web_policy?.read_all?`<p class="policy-box">${l('webPolicyActiveNote')}</p>`:'');
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
      } else if(action==='security.password')fields=field('new_password','newPassword',{type:'password',max:1024})+field('password_confirm','passwordConfirm',{type:'password',max:1024})+reauth();
      else if(action==='security.totp.begin'||action==='security.recovery_codes')fields=reauth();
      else if(action==='invitations.issue')fields=`<p>${l('invitationPrivateNote')}</p>`+field('count','count',{type:'number',value:1,min:1,upper:getCaps().invitation_batch_limit,step:1})+field('ttl_minutes','ttlMinutes',{type:'number',value:60,min:1,upper:1440,step:1})+reauth();
      else if(action.startsWith('invitations.')||action.startsWith('accounts.'))fields=`<p>${esc(data.accounts?.find(a=>a.account_id===intent.id)?.username||'')} <code>${esc(intent.id)}</code></p>${action==='accounts.disable'?`<p class="policy-box">${l('disableAccountNote')}</p>`:action==='accounts.enable'?`<p>${l('enableAccountNote')}</p>`:''}`+reauth();
      else if(action==='storage.import')fields=`<p>${l('portableNote')}</p><label>${l('file')}<input type="file" name="file" accept="application/json,.json" required></label><label class="check-field"><input type="checkbox" name="confirm_import" required>${l('confirmImport')}</label>`;
      else fields=`<p>${l(action==='storage.export'?'exportPrivacyNote':action==='models.test'?'probeCostNote':'confirmAction')}</p><code>${esc(intent.id||intent.kind||'')}</code>`;
      if(seq!==sequence||!isActive())return;content.innerHTML=`<form id="operation-form">${fields}${modalActions(action==='storage.export'?'export':'confirm')}</form>`;syncAppearance();content.querySelector('input,textarea,select,button')?.focus();
    }catch(e){if(seq!==sequence||!isActive())return;content.innerHTML=`<p role="alert">${esc(t(e.message))}</p><button type="button" data-operation-close>${l('close')}</button>`;}
  }
  function payload(fd){const a=intent.action,p={};
    if(a==='memory.create'){Object.assign(p,{content:fd.get('content'),memory_type:fd.get('memory_type'),scope:fd.get('scope'),sensitivity:fd.get('sensitivity')});if(fd.get('topic'))p.topic=fd.get('topic');if(p.scope!=='user')p[`${p.scope}_id`]=fd.get('target_id');}
    else if(a==='memory.web_policy'){p.read_all=intent.enable;p.expected_revision=intent.revision;}
    else if(a.startsWith('memory.')){Object.assign(p,{memory_id:intent.id,revision:intent.meta.revision});if(a==='memory.correct'){p.content=fd.get('content');p.topic=fd.get('topic')||null;p.memory_type=intent.meta.memory_type;}if(fd.get('reason'))p.reason=fd.get('reason');if(a==='memory.classify')p.category=fd.get('category');if(a==='memory.sensitivity')p.sensitivity=fd.get('sensitivity');if(a==='memory.visibility'){p.allow=fd.has('allow');p.state_hash=intent.meta.state_hash;}}
    else if(a==='jobs.schedule')Object.assign(p,{type:fd.get('type'),timezone:fd.get('timezone'),periods:['daily','weekly'],include_open:fd.has('include_open'),schedule_enabled:fd.has('schedule_enabled'),settings_revision:intent.settings_revision});
    else if(a==='jobs.cancel'||a==='jobs.retry')p.job_id=intent.id;
    else if(a==='models.save'){
      p.kind=intent.kind;p.expected_revision=intent.revision;const sensitivity=fd.get('sensitivity');p.config={enabled:fd.has('enabled'),protocol:fd.get('protocol'),base_url:fd.get('base_url'),model:fd.get('model'),profile_revision:fd.get('profile_revision'),daily_requests:Number(fd.get('daily_requests')),output_tokens:Number(fd.get('output_tokens')),batch_size:Number(fd.get('batch_size')),sensitivities:sensitivity==='public'?['public']:sensitivity==='internal'?['public','internal']:['public','internal','sensitive'],egress_approved:fd.has('egress_approved'),query_approved:fd.has('query_approved'),native_schema:intent.kind==='organizer'?fd.has('native_schema'):true};if(intent.kind==='embedder')p.config.dimensions=Number(fd.get('dimensions'));if(fd.get('api_key'))p.api_key=fd.get('api_key');if(fd.has('remove_key'))p.remove_key=true;
    } else if(a==='models.test'||a==='models.disable'){p.kind=intent.kind;if(a==='models.disable')p.expected_revision=getData().models.find(m=>m.kind===intent.kind).revision;}
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
      if(seq!==sequence||!isActive())return;event.target.reset();if(!data.login_required)await reload();
      if(seq!==sequence||!isActive())return;result(data);
    }catch(e){if(seq!==sequence||!isActive())return;const error=content.querySelector('[data-operation-error]');if(error)error.textContent=`${t(e.message)} · ${t('operationId')}: ${opId}`;}
    finally{working=false;controls.forEach(c=>c.disabled=false);}
  });
  document.addEventListener('click',event=>{const b=event.target.closest('[data-console-action]');if(b){void begin(b.dataset.consoleAction,b);return;}if(event.target.closest('[data-operation-close]')&&!working)modal.close();
    const inspection=event.target.closest('[data-inspect]');if(inspection){const keys={models:'kind',connections:'grant_id',core_connections:'credential_id',sessions:'session_id'};const key=keys[inspection.dataset.inspect];if(!key)return;const item=getData()[inspection.dataset.inspect]?.find(row=>String(row[key])===inspection.dataset.id);if(item){open('inspectDetails');inspectResult(item);}return;}
    const job=event.target.closest('[data-job-detail]');if(job){open('jobs');const seq=sequence;void api('jobs',{job_id:job.dataset.jobDetail}).then(data=>{if(seq===sequence&&modal.open&&isActive())inspectResult(data);}).catch(e=>{if(seq===sequence&&modal.open&&isActive())content.textContent=t(e.message);});}});
  modal.addEventListener('cancel',event=>{if(working)event.preventDefault();});
  modal.addEventListener('close',()=>{sequence++;intent=null;opId=null;lastPayload=null;content.replaceChildren();returnFocus?.focus();returnFocus=null;});
  return {clear(){sequence++;intent=null;opId=null;lastPayload=null;working=false;content.replaceChildren();modal.close();}};
}

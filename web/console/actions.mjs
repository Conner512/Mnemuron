import {translate as t,syncAppearance} from './appearance.mjs';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const l=k=>`<span data-i18n="${k}">${esc(t(k))}</span>`;
export const actionButton=(action,key,values={})=>`<button type="button" data-console-action="${action}" ${Object.entries(values).map(([k,v])=>`data-${k}="${esc(v)}"`).join(' ')}>${l(key)}</button>`;
const time=v=>v?new Date(typeof v==='number'&&v<1e12?v*1000:v).toLocaleString(document.documentElement.lang):'—';
const tag=v=>`<span class="tag">${esc(v)}</span>`;
const table=(rows,head,row)=>rows?.length?`<div class="table-scroll"><table><thead><tr>${head.map(k=>`<th>${l(k)}</th>`).join('')}</tr></thead><tbody>${rows.map(row).join('')}</tbody></table>`:`<div class="empty">${l('empty')}</div>`;
const card=(title,body)=>`<section class="card"><h2>${l(title)}</h2>${body}</section>`;
const buttons=items=>`<div class="actions action-toolbar">${items.join('')}</div>`;
export function actionPage(page,data,caps) {
  if(!caps.enabled)return null;
  const writable=caps.writable;
  const onlyRead=()=>`<p class="policy-box">${l('consoleUpgradeRequired')}</p>`;
  if(page==='models')return `<div class="columns">${(data.models||[]).map(m=>card(m.kind,(m.config.enabled?`${tag('enabled')}<p>${esc(m.config.model)}</p><code>${esc(m.config.base_url)}</code><p>${l('dailyRequests')}: ${m.config.daily_requests} · ${l('hasKey')}: ${l(m.has_key?'yes':'no')}</p>`:`${tag(t('modelNotConfigured'))}`)+buttons(writable?[actionButton('models.save','configure',{kind:m.kind}),...(m.config.enabled?[actionButton('models.test','testModel',{kind:m.kind}),actionButton('models.disable','disable',{kind:m.kind})]:[])]:[onlyRead()]))).join('')}</div>${card('modelBoundary',`<p>${l('modelBoundaryNote')}</p>${writable?actionButton('vector.schedule','rebuildIndex'):''}${!data.vector_enabled?`<p>${l('vectorNotConfigured')}</p>`:''}`)}`;
  if(page==='jobs')return card('jobs',`${writable?buttons([actionButton('jobs.schedule','organize',{type:'classification'}),actionButton('jobs.schedule','summarize',{type:'summary'})]):onlyRead()}
    <p>${l('scheduleStatus')}: ${l(data.settings?.schedule_enabled?'enabled':'disabled')} · ${l('workerStatus')}: ${l(data.worker_enabled?'enabled':'disabled')}</p>${!data.worker_enabled?`<p class="policy-box">${l('workerDisabledNote')}</p>`:''}
    ${table(data.jobs,['scope','state','progress','error','actions'],j=>`<tr><td><button type="button" data-job-detail="${esc(j.job_id)}">${esc(j.job_type)}</button><small>${esc(j.job_id)}</small></td><td>${tag(j.state)}</td><td>${j.processed} / ${j.total}</td><td>${esc(j.last_error_code||'—')}</td><td>${writable?buttons([...(j.state!=='succeeded'&&j.state!=='cancelled'?[actionButton('jobs.cancel','cancelJob',{id:j.job_id})]:[]),...(['dead_letter','blocked_auth','blocked_budget','blocked_config','review_required','retry_wait','cancelled'].includes(j.state)?[actionButton('jobs.retry','retry',{id:j.job_id})]:[])]):''}</td></tr>`)}
    ${data.vector?`<p>${l('vectorIndex')}: ${tag(data.vector.state)} ${esc(data.vector.error_code||'')}</p>`:''}<button type="button" data-retry>${l('refresh')}</button>`);
  if(page==='connections')return card('chatgptGrants',`${table(data.connections,['identity','expires','actions'],g=>`<tr><td>${esc(g.client_id)}</td><td>${esc(time(g.expires))}</td><td>${actionButton('oauth.revoke','revoke',{id:g.grant_id})}</td></tr>`)}<p>${l('consentNote')}</p><p>${l('mcpEndpoint')}: <code>${esc(caps.resource)}</code></p>`)+
    card('agentConnections',`${writable?buttons([actionButton('connections.create','addConnection')]):onlyRead()}${table(data.core_connections,['identity','scope','state','actions'],c=>{let scopes=[];try{scopes=JSON.parse(c.scopes_json||'[]');}catch{}const managed=['mnemuron-console','chatgpt-web','mnemuron'].includes(c.agent_id)||scopes.some(s=>!['memory:read','memory:write'].includes(s));return `<tr><td>${esc(c.label)}<small>${esc(c.credential_id)}</small></td><td>${esc(c.agent_id)}</td><td>${l(c.revoked_at?'revoked':c.expires_at&&Date.parse(c.expires_at)<=Date.now()?'expired':'active')}</td><td>${!managed&&!c.revoked_at&&writable?buttons([actionButton('connections.rotate','rotateKey',{id:c.credential_id}),actionButton('connections.revoke','revoke',{id:c.credential_id})]):l('managedConnection')}</td></tr>`;})}`);
  if(page==='security')return `<div class="columns">${card('accountSecurity',`<p>${esc(data.username)}</p>${tag(t('passwordTotp'))}${buttons([actionButton('security.password','changePassword'),actionButton('security.totp.begin','changeTotp'),actionButton('security.recovery_codes','rotateRecovery')])}<p>${l('securityOperationsNote')}</p><a href="/recover">${l('recover')} →</a>`)}${card('sessions',`${buttons([actionButton('security.sessions.revoke_others','revokeOtherSessions')])}${table(data.sessions,['created','expires','actions'],s=>`<tr><td>${esc(time(s.created))}${s.current?`<small>${l('currentSession')}</small>`:''}</td><td>${esc(time(s.expires))}</td><td>${actionButton('security.session.revoke','revoke',{id:s.session_id})}</td></tr>`)}`)}</div>`;
  if(page==='invitations')return caps.operator?card('invitations',`${buttons([actionButton('invitations.issue','issue')])}<p>${l('invitationLimits')} ${data.batch_limit}</p>${table(data.invitations,['identity','state','expires','actions'],i=>`<tr><td>${esc(i.invitation_id)}<small>${esc(i.batch_id)}</small></td><td>${tag(i.effective_state)}</td><td>${esc(time(i.expires))}</td><td>${['issued','reserved'].includes(i.state)?buttons([actionButton('invitations.revoke','revoke',{id:i.invitation_id}),actionButton('invitations.revoke_batch','revokeBatch',{id:i.batch_id})]):''}</td></tr>`)}`):card('invitations',`<p>${l('operatorRequired')}</p>`);
  if(page==='accounts')return caps.operator?card('accounts',`<p>${l('accountAdminNote')}</p>${table(data.accounts,['username','state','role','actions'],a=>`<tr><td>${esc(a.username)}<small>${esc(a.account_id)}</small></td><td>${tag(a.status)}</td><td>${tag(a.role)}</td><td>${buttons([...(data.maintenance_enabled&&['active','disabled'].includes(a.status)?[actionButton(a.status==='active'?'accounts.disable':'accounts.enable',a.status==='active'?'disable':'enable',{id:a.account_id})]:[]),actionButton('accounts.role',a.role==='operator'?'revokeOperator':'grantOperator',{id:a.account_id,operator:String(a.role!=='operator')})])}</td></tr>`)}${!data.maintenance_enabled?`<p>${l('maintenanceRequired')}</p>`:''}`):card('accounts',`<p>${l('operatorRequired')}</p>`);
  if(page==='storage')return card('personalExport',`<p>${l('portableNote')}</p>${writable?buttons([actionButton('storage.export','export'),actionButton('storage.import','importMemories')]):onlyRead()}${table(Object.entries(data.counts||{}),['scope','memoryCount'],([k,n])=>`<tr><td>${esc(k)}</td><td>${n}</td></tr>`)}<p class="policy-box">${l('databaseRestoreNote')}</p>`);
  return null;
}
const field=(name,key,{value='',type='text',required=true,max=4096}={})=>`<label>${l(key)}<input name="${name}" type="${type}" value="${esc(value)}" maxlength="${max}" ${required?'required':''} ${type==='password'?'autocomplete="off"':''}></label>`;
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
    if(data.login_required){const a=document.createElement('a');a.href='/login';a.textContent=t('signIn');content.append(a);}
    if(data.qr_svg){const qr=document.createElement('div');qr.className='qr';qr.innerHTML=data.qr_svg;content.prepend(qr);}
    if(data.enrollment_id){const f=document.createElement('form');f.innerHTML=field('new_otp','otp',{max:6})+modalActions('verify');content.append(f);intent={action:'security.totp.complete',enrollment_id:data.enrollment_id};opId=crypto.randomUUID();lastPayload=null;}
    else {intent=null;const b=document.createElement('button');b.type='button';b.dataset.operationClose='';b.textContent=t('close');content.append(b);}
  }
  async function begin(action,button){if(working)return;open(action);const seq=sequence;opId=crypto.randomUUID();lastPayload=null;intent={action,id:button.dataset.id,kind:button.dataset.kind,operator:button.dataset.operator};
    try{
      let fields='',data=getData();
      if(action==='memory.create')fields=area('content','content')+select('memory_type','memoryType',['fact','goal','constraint','decision','completed','blocker','remaining','next_step'],'fact')+field('topic','topic',{required:false,max:120})+select('scope','scope',['user','project','task','workstream','session'],'user')+field('target_id','scopeTarget',{required:false,max:128})+select('sensitivity','sensitivity',['sensitive','internal','public','secret'],'sensitive');
      else if(action.startsWith('memory.')){
        const meta=await api('memory-meta',{memory_id:intent.id});if(seq!==sequence||!isActive())return;intent.meta=meta;
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
      else if(action==='invitations.issue')fields=field('count','count',{type:'number',value:1})+field('ttl_minutes','ttlMinutes',{type:'number',value:60})+reauth();
      else if(action.startsWith('invitations.')||action.startsWith('accounts.'))fields=`<p><code>${esc(intent.id)}</code></p>`+reauth();
      else if(action==='storage.import')fields=`<p>${l('portableNote')}</p><label>${l('file')}<input type="file" name="file" accept="application/json,.json" required></label><label class="check-field"><input type="checkbox" name="confirm_import" required>${l('confirmImport')}</label>`;
      else fields=`<p>${l(action==='storage.export'?'exportPrivacyNote':action==='models.test'?'probeCostNote':'confirmAction')}</p><code>${esc(intent.id||intent.kind||'')}</code>`;
      if(seq!==sequence||!isActive())return;content.innerHTML=`<form id="operation-form">${fields}${modalActions(action==='storage.export'?'export':'confirm')}</form>`;syncAppearance();content.querySelector('input,textarea,select,button')?.focus();
    }catch(e){if(seq!==sequence||!isActive())return;content.innerHTML=`<p role="alert">${esc(t(e.message))}</p><button type="button" data-operation-close>${l('close')}</button>`;}
  }
  function payload(fd){const a=intent.action,p={};
    if(a==='memory.create'){Object.assign(p,{content:fd.get('content'),memory_type:fd.get('memory_type'),scope:fd.get('scope'),sensitivity:fd.get('sensitivity')});if(fd.get('topic'))p.topic=fd.get('topic');if(p.scope!=='user')p[`${p.scope}_id`]=fd.get('target_id');}
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
  document.addEventListener('click',event=>{const b=event.target.closest('[data-console-action]');if(b){void begin(b.dataset.consoleAction,b);return;}if(event.target.closest('[data-operation-close]')&&!working)modal.close();
    const job=event.target.closest('[data-job-detail]');if(job){open('jobs');const seq=sequence;void api('job',{job_id:job.dataset.jobDetail}).then(data=>{if(seq===sequence&&modal.open&&isActive())result(data);}).catch(e=>{if(seq===sequence&&modal.open&&isActive())content.textContent=t(e.message);});}});
  modal.addEventListener('cancel',event=>{if(working)event.preventDefault();});
  modal.addEventListener('close',()=>{sequence++;intent=null;opId=null;lastPayload=null;content.replaceChildren();returnFocus?.focus();returnFocus=null;});
  return {clear(){sequence++;intent=null;opId=null;lastPayload=null;working=false;content.replaceChildren();modal.close();}};
}

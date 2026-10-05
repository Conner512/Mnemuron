import {translate as t,syncAppearance} from './appearance.mjs';
import {connectionsView} from './connections.mjs';
import {icon,revisionDifference,categoryName} from './visuals.mjs';

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

  if(page==='models'){
    const p=data.processing||{},blocked=items=>(items||[]).map(code=>`<p class="muted">${esc(t(code))}</p>`).join('');
    const launch=(action,key,ready,values={})=>can(action)?actionButton(action,key,values).replace('<button ',`<button ${ready?'':'disabled '}`):'';
    const verification=v=>`<div class="model-verification" role="status"><strong>${l(!v?'probeNotRun':v.state==='verified'?'probeVerified':v.state==='running'?'probeRunning':'probeFailed')}</strong>${v?`<p>${esc(time(v.updated_at))}${v.error_code?` · ${esc(t(v.error_code))}`:''}</p>${v.checks?.length?`<p>${v.checks.map(c=>esc(t(c))).join(' · ')}</p>`:''}${v.skipped?.length?`<p>${l('probeSkipped')}: ${v.skipped.map(c=>esc(t(c))).join(' · ')}</p>`:''}`:''}</div>`;
    return `<div class="card-grid">${(data.models||[]).map(m=>section(m.kind,
      `<p>${l(m.kind==='organizer'?'organizerPurpose':'embedderPurpose')}</p>`+
      kv([['modelName',esc(m.config.model||t('modelNotConfigured'))],['baseUrl',`<code>${esc(m.config.base_url||'—')}</code>`],['dailyRequests',esc(m.config.daily_requests??'—')],['hasKey',l(m.has_key?'yes':'no')],...(m.kind==='embedder'?[['dimensions',esc(m.config.dimensions??'—')]]:[])])+verification(m.verification)+
      buttons([...(can('models.save')?[actionButton('models.save','configure',{kind:m.kind})]:[]),...(m.config.enabled&&can('models.test')?[actionButton('models.test','testCapabilities',{kind:m.kind})]:[]),...(m.config.enabled&&can('models.disable')?[actionButton('models.disable','disable',{kind:m.kind})]:[]),inspect('models',m.kind)])+(!can('models.save')?onlyRead():''),
      {aside:state(m.config.enabled?'enabled':'disabled'),className:'model-card'})).join('')}</div>`+
      section('modelPipeline',`<p>${l('modelPipelineNote')}</p><div class="card-grid model-pipeline">${['classification','summary','vector'].map(kind=>{
        const step=p[kind]||{},vector=kind==='vector';return `<div data-model-stage="${kind}"><h3>${l(kind)}</h3>${state(step.ready?'ready':'notReady')}${blocked(step.blockers)}${vector?kv([['indexedDocuments',esc(step.indexed_documents??0)],['state',esc(t(step.state||'not_started'))],['semanticReadiness',l(step.search_ready?'ready':'notReady')]])+blocked(step.search_blockers)+blocked(step.error_code?[step.error_code]:[]):''}${buttons([launch(vector?'vector.schedule':'jobs.schedule',vector?'rebuildIndex':kind==='summary'?'summarize':'organize',step.ready===true,vector?{}:{type:kind})])}</div>`;
      }).join('')}</div><div class="section-foot"><a href="/app/jobs">${l('viewJobs')} →</a><a href="/app/summaries">${l('viewSummaries')} →</a></div>`)+
      section('modelBoundary',`<p>${l('modelBoundaryNote')}</p><p>${l('modelProbeBoundary')}</p>`);
  }

  if(page==='jobs')return section('jobs',`<div class="status-line">${l('scheduleStatus')} ${state(data.settings?.schedule_enabled?'enabled':'disabled')}<span aria-hidden="true">·</span>${l('workerStatus')} ${state(data.worker_enabled?'enabled':'disabled')}${data.vector?`<span aria-hidden="true">·</span>${l('vectorIndex')} ${state(data.vector.state)} ${esc(data.vector.error_code||'')}`:''}</div>
    ${can('jobs.schedule')?buttons([actionButton('jobs.schedule','organize',{type:'classification'}),actionButton('jobs.schedule','summarize',{type:'summary'})]):onlyRead()}
    ${!data.worker_enabled?note('workerDisabledNote'):''}
    ${table(data.jobs,['scope','state','progress','error','actions'],j=>`<tr><td><button type="button" class="link-button" data-job-detail="${esc(j.job_id)}">${esc(t(j.job_type))}</button><small><code>${esc(j.job_id)}</code></small></td><td><span class="state-dot" data-state="${esc(j.state)}">${l('jobState_'+j.state)}</span></td><td>${progress(j.processed,j.total)}</td>
      <td>${j.last_error_code?`<span class="job-error">${esc(t(j.last_error_code))}</span><small><code>${esc(j.last_error_code)}</code></small>${j.stale_taxonomy&&j.last_error_code!=='RESCHEDULED'?`<small class="job-hint">${l('jobStaleTaxonomyHint')}</small>`:''}`:'—'}</td>
      <td>${buttons([...(can('jobs.cancel')&&j.state!=='succeeded'&&j.state!=='cancelled'?[actionButton('jobs.cancel','cancelJob',{id:j.job_id})]:[]),...(can('jobs.retry')&&j.last_error_code!=='RESCHEDULED'&&['dead_letter','blocked_auth','blocked_budget','blocked_config','review_required','retry_wait','cancelled'].includes(j.state)?[j.stale_taxonomy?actionButton('jobs.retry','rescheduleWithCategories',{id:j.job_id,stale:'true'}):actionButton('jobs.retry','retry',{id:j.job_id})]:[])])}</td></tr>`)}
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

/** Read-only inspectors share the session-bound transport; no actions, tokens or data in storage. */
export function mountFeatureReads({api,isActive,getAuditParams}){
  const modal=document.createElement('dialog');modal.id='feature-dialog';modal.setAttribute('aria-labelledby','feature-read-title');
  modal.innerHTML=`<div class="dialog-header"><h2 id="feature-read-title"></h2><button type="button" data-feature-close>${l('close')}</button></div><div data-feature-content></div>`;document.body.append(modal);
  const content=modal.querySelector('[data-feature-content]');let seq=0,focus,next=null,compare=null,exporting=false;
  const valid=n=>n===seq&&isActive()&&modal.open;
  function open(title){seq++;focus=document.activeElement;next=null;compare=null;modal.querySelector('h2').textContent=t(title);content.innerHTML=`<p>${l('loading')}</p>`;if(!modal.open)modal.showModal();return seq;}
  async function inspect(view,params={},fresh=true){const n=fresh?open(view):++seq;content.innerHTML=`<p>${l('loading')}</p>`;
    try{const data=await api(view,params);if(!valid(n))return;const pre=document.createElement('pre');pre.className='operation-result';pre.textContent=JSON.stringify(data,null,2);content.replaceChildren(pre);
      next=data.next_offset!=null?{view,params:{...params,offset:data.next_offset}}:null;if(next){const b=document.createElement('button');b.type='button';b.dataset.featureNext='';b.textContent=t('next');content.append(b);}
    }catch(e){if(valid(n))content.textContent=t(e.message);}
  }
  async function versionText(memory_id,revision,n){let params={memory_id,revision},parts=[],bytes=0,steps=0;
    do{const d=await api('memory-versions',params);if(!valid(n))throw new Error('STALE_ACCOUNT');bytes+=d.content.length;if(bytes>1024*1024||++steps>256)throw new Error('DETAIL_SIZE_LIMIT');parts.push(d.content);params=d.next_request;if(!params&&d.content_complete!==true)throw new Error('INCOMPLETE_CONTENT');}while(params);
    return parts.join('');
  }
  async function compareMemory(memory,previous){const n=open('compareVersions');
    try{const [right,left]=await Promise.all([api('memory-versions',{memory_id:memory,limit:100}),previous?api('memory-versions',{memory_id:previous,limit:100}):Promise.resolve(null)]);if(!valid(n))return;
      compare={memory,previous:previous||memory};const choices=rows=>rows.map(r=>String(r.revision));const rightChoices=choices(right.versions),leftChoices=choices((left||right).versions);
      content.innerHTML=`<p>${l('compareVersionNote')}</p><form data-version-compare><div class="columns">${select('left','previousRecord',leftChoices,leftChoices[previous?0:Math.min(1,leftChoices.length-1)])}${select('right','currentRecord',rightChoices,rightChoices[0])}</div><button type="submit">${l('compareVersions')}</button></form><div class="columns" data-comparison></div>`;
      if(right.next_offset!=null||left?.next_offset!=null)content.insertAdjacentHTML('afterbegin',`<p>${l('latestHundredVersions')}</p>`);
      syncAppearance();content.querySelector('form').requestSubmit();
    }catch(e){if(valid(n))content.textContent=t(e.message);}
  }
  modal.addEventListener('submit',event=>{if(!event.target.matches('[data-version-compare]'))return;event.preventDefault();const n=++seq,pair={...compare},fd=new FormData(event.target),out=content.querySelector('[data-comparison]');out.textContent=t('loading');
    void Promise.all([versionText(pair.previous,Number(fd.get('left')),n),versionText(pair.memory,Number(fd.get('right')),n)]).then(values=>{if(!valid(n))return;out.replaceChildren();revisionDifference(...values).forEach((value,i)=>{const section=document.createElement('section'),title=document.createElement('h3'),pre=document.createElement('pre'),change=document.createElement(i?'ins':'del');title.textContent=t(i?'currentRecord':'previousRecord');pre.className='body-content';change.textContent=value.changed;pre.append(document.createTextNode(value.prefix),change,document.createTextNode(value.suffix));section.append(title,pre);out.append(section);});}).catch(e=>{if(valid(n))out.textContent=t(e.message);});
  });
  document.addEventListener('click',event=>{
    const read=event.target.closest('[data-feature-read]');if(read){void inspect(read.dataset.featureRead,JSON.parse(read.dataset.featureParams||'{}'));return;}
    const compareButton=event.target.closest('[data-compare-memory]');if(compareButton){void compareMemory(compareButton.dataset.compareMemory,compareButton.dataset.previousMemory);return;}
    if(event.target.closest('[data-feature-close]'))modal.close();
    if(event.target.closest('[data-feature-next]')&&next)void inspect(next.view,next.params,false);
    if(event.target.closest('[data-audit-export]')&&!exporting){const target=document.querySelector('[data-audit-result]');exporting=true;const generation=seq;
      void(async()=>{let offset=0,entries=[],size=0,requests=0;const filters=getAuditParams();
        for(;;){const data=await api('audit',{...filters,offset,limit:100});if(!isActive()||generation!==seq)throw new Error('STALE_ACCOUNT');
          const page=[...(data.entries||[]).map(e=>({...e,source:'identity'})),...(data.core_entries||[]).map(e=>({...e,source:'core'}))];size+=JSON.stringify(page).length;
          if(size>16*1024*1024||++requests>100)throw new Error('EXPORT_SIZE_LIMIT');entries.push(...page);if(data.next_offset==null)break;offset=data.next_offset;}
        const unique=[...new Map(entries.map(e=>[e.source+':'+e.audit_id,e])).values()];const blob=new Blob([JSON.stringify({format:'mnemuron-own-audit-v1',snapshot:'bounded_live_listing',filters,entries:unique},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
        a.href=url;a.download='mnemuron-account-audit.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);if(target)target.textContent=t('auditExportDone')+' '+unique.length;
      })().catch(e=>{if(target&&isActive())target.textContent=t(e.message);}).finally(()=>{exporting=false;});
    }
  });
  modal.addEventListener('close',()=>{seq++;next=null;compare=null;content.replaceChildren();focus?.isConnected&&focus.focus();focus=null;});
  return {clear(){seq++;next=null;compare=null;content.replaceChildren();modal.close();}};
}

export function mountActions({api,mutate,getData,getCaps,getFacets=()=>null,getSelection=()=>({memory_ids:[]}),reload,isActive}) {
  const modal=document.createElement('dialog');modal.id='operation-dialog';modal.setAttribute('aria-labelledby','operation-title');modal.innerHTML='<div class="dialog-header"><h2 id="operation-title"></h2><button type="button" data-operation-close aria-label="Close">×</button></div><div id="operation-content"></div>';document.body.append(modal);
  const content=modal.querySelector('#operation-content');let intent=null,opId=null,lastPayload=null,returnFocus=null,sequence=0,working=false;
  function open(title){sequence++;returnFocus=document.activeElement;modal.querySelector('h2').textContent=t(title);content.innerHTML=`<p>${l('loading')}</p>`;if(!modal.open)modal.showModal();}
  const MEMORY_RESULTS={'memory.create':'resultCreated','memory.correct':'resultCorrected','memory.retract':'resultRetracted','memory.sensitivity':'resultSensitivity','memory.visibility':'resultVisibility','memory.web_policy':'resultWebPolicy','memory.batch_retract':'resultBatchRetract','memory.batch_classify':'resultBatchClassify'};
  function result(data){content.replaceChildren();const pre=document.createElement('pre');pre.className='operation-result';const {qr_svg,...display}=data;pre.textContent=JSON.stringify(display,null,2);
    const summary=MEMORY_RESULTS[intent?.action];
    if(summary){
      // A plain confirmation first; the receipt stays available for support under technical details.
      const box=document.createElement('div');box.className='policy-box';box.setAttribute('role','status');
      if(Array.isArray(data.results)){const ok=data.results.filter(r=>r.ok).length,failed=data.results.filter(r=>!r.ok);
        const head=document.createElement('p');head.textContent=`${t(summary)} ${ok}${failed.length?` · ${t('resultFailedCount')} ${failed.length}`:''}`;box.append(head);
        if(failed.length){const list=document.createElement('ul');for(const r of failed){const li=document.createElement('li');li.textContent=`${intent.snippets?.[r.memory_id]||r.memory_id} — ${t(r.error_code)}`;list.append(li);}box.append(list);}
      }else{const p=document.createElement('p');p.textContent=t(summary);box.append(p);}
      if(data.replayed){const p=document.createElement('p');p.className='muted';p.textContent=t('replayedResult');box.append(p);}
      const raw=document.createElement('details'),label=document.createElement('summary');label.textContent=t('technicalDetails');raw.append(label,pre);content.append(box,raw);
    }else content.append(pre);
    if(intent?.action==='models.test'||intent?.action==='models.save'||intent?.action==='jobs.schedule'||intent?.action==='vector.schedule'){
      const message=document.createElement('p');message.className='policy-box';message.textContent=t(data.status==='verified'?'modelProbePassed':data.status==='saved'?'modelSavedNext':data.status==='no_work'?'modelNoWork':'modelQueued');content.prepend(message);
    }
    if(intent?.action==='jobs.retry'){
      const message=document.createElement('p');message.className='policy-box';message.setAttribute('role','status');
      message.textContent=data.status==='rescheduled'?`${t('rescheduledResult')} ${data.jobs.length} · ${t('supersededResult')} ${data.superseded}`:data.status==='no_work'?t('rescheduledNoWork'):t('modelQueued');content.prepend(message);
    }
    if(data.codes&&data.batch_id){
      const note=document.createElement('p');note.textContent=t('invitationSavedNote');
      const codes=document.createElement('pre');codes.id='issued-invitation-codes';codes.className='operation-result';codes.textContent=data.codes.join('\n');
      const copy=document.createElement('button');copy.type='button';copy.dataset.copy=codes.id;copy.textContent=t('copy');
      content.prepend(note,codes,copy);pre.textContent=JSON.stringify({...display,codes:undefined},null,2);
    }
    if(intent?.action==='storage.import'&&data.status==='imported'){
      const note=document.createElement('p');note.className='policy-box';note.setAttribute('role','status');note.textContent=`${t('importDone')}: ${t('importCreated')} ${data.created} · ${t('importExisting')} ${data.existing}`;
      const next=document.createElement('a');next.className='button primary';next.href='/app/memories?origin=imported';next.textContent=t('organizeImported');content.prepend(note,next);
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
  // ---- Organize: one flow for every category move — choose → preview → confirm → result, with undo.
  // Previews are reads; the confirm sends the preview token, so nothing changes that was not shown.
  let flow=null;
  const caps=()=>getCaps(),can=action=>canAct(caps(),action);
  const labelOf=(id,labels=caps().category_labels||{})=>categoryName(t,labels,id);
  const options=(ids,current,labels)=>ids.map(c=>`<option value="${esc(c)}"${c===current?' selected':''}>${esc(labelOf(c,labels))}</option>`).join('');
  const live=text=>{const node=document.getElementById('live-status');if(node)node.textContent=text;};
  function busy(on){working=on;for(const c of content.querySelectorAll('button,input,select,textarea'))c.disabled=on||c.hasAttribute('data-keep-disabled');}
  const fail=(e,seq)=>{if(seq!==sequence||!isActive())return;const node=content.querySelector('[data-operation-error]');const text=t(e.message);if(node)node.textContent=text;else content.insertAdjacentHTML('beforeend',`<p role="alert">${esc(text)}</p>`);live(text);};
  const fresh=seq=>seq===sequence&&isActive()&&modal.open;
  function selectionNote(sel){
    if(sel.memory_ids)return `<p>${l('selectedMemories')} <strong>${sel.memory_ids.length}</strong></p>`;
    const parts=[sel.query&&`“${esc(sel.query)}”`,sel.filter_category&&esc(labelOf(sel.filter_category)),sel.topic&&esc(sel.topic),sel.origin&&esc(t(sel.origin==='imported'?'importedOrigin':'otherOrigin'))].filter(Boolean);
    return `<p>${l('allMatchingSelected')}</p><p class="muted">${parts.length?parts.join(' · '):l('allActiveMemories')}</p>`;
  }
  function chooseStep(initial='uncategorized'){
    content.innerHTML=`<form data-organize-step="choose">${selectionNote(flow.selection)}<label>${l('moveToCategory')}<select name="category">${options(caps().taxonomy?.categories||[],initial)}</select></label>`+
      (can('category.create')?`<details class="organize-new"><summary>${l('orCreateCategory')}</summary><label>${l('newCategoryName')}<input name="new_label" maxlength="40" autocomplete="off"></label></details>`:'')+
      `<div class="actions"><button type="submit" class="primary">${l('previewChange')}</button><button type="button" data-operation-close>${l('cancel')}</button></div><p data-operation-error role="alert"></p></form>`;
    syncAppearance();content.querySelector('select')?.focus();
  }
  const selectionParams=sel=>({...(sel.memory_ids?{memory_ids:sel.memory_ids}:{}),...(sel.query?{query:sel.query}:{}),...(sel.filter_category?{filter_category:sel.filter_category}:{}),...(sel.topic?{topic:sel.topic}:{}),...(sel.origin?{origin:sel.origin}:{}),...(sel.all?{all:true}:{})});
  async function previewStep(seq,notice=''){
    content.innerHTML=`<p role="status">${l('loading')}</p>`;
    const sel=selectionParams(flow.selection),{memory_ids,filter_category,all,...rest}=sel;
    const p=await api('memories',{part:'preview',target:flow.category,...rest,...(memory_ids?{memory_ids:memory_ids.join(',')}:{}),...(filter_category?{category:filter_category}:{}),...(all?{all:'true'}:{})});
    if(!fresh(seq))return;flow.preview=p;flow.opId=crypto.randomUUID();
    const warn=p.over_limit?'organizeOverLimit':p.truncated?'organizeTruncated':!p.matched?'SELECTION_EMPTY':!p.changed?'organizeNothing':null,ready=p.applicable&&p.changed>0;
    if(p.over_limit||p.truncated){
      // Nothing can be applied: say exactly how many match, what the limit is, and what to do next.
      content.innerHTML=`<div class="organize-preview organize-blocked">${notice?`<p class="policy-box" role="status">${l(notice)}</p>`:''}
        <p class="organize-headline" id="organize-limit">${p.over_limit?`<strong class="figure">${p.total}</strong> ${l('organizeMatchCount')} · ${l('organizeLimitIs')} <strong>${p.limit}</strong>`:l('organizeTruncatedHeadline')}</p>
        <p class="policy-box" role="alert">${l(warn)}</p><h3>${l('organizeNextStep')}</h3><ul class="organize-facts"><li>${l('organizeNarrowHint')}</li><li>${l('organizeSelectHint')}</li></ul></div>
        <form data-organize-step="confirm"><div class="actions"><button type="submit" class="primary" disabled data-keep-disabled aria-describedby="organize-limit">${l('confirmMoveBlocked')}</button><button type="button" data-organize-narrow>${l('organizeNarrow')}</button><button type="button" data-organize-back>${l('goBack')}</button><button type="button" data-operation-close>${l('cancel')}</button></div><p data-operation-error role="alert"></p></form>`;
      syncAppearance();content.querySelector('[data-organize-narrow]')?.focus();return;
    }
    content.innerHTML=`<div class="organize-preview">${notice?`<p class="policy-box" role="status">${l(notice)}</p>`:''}
      <p class="organize-headline"><strong class="figure">${p.changed}</strong> ${l('organizeWillMove')} <strong>${esc(labelOf(p.category))}</strong></p>
      ${p.unchanged||p.missing?`<ul class="organize-facts">${p.unchanged?`<li>${p.unchanged} ${l('organizeAlready')}</li>`:''}${p.missing?`<li>${p.missing} ${l('organizeMissing')}</li>`:''}</ul>`:''}
      ${p.by_category.length?`<h3>${l('organizeFrom')}</h3><ul class="organize-breakdown">${p.by_category.map(c=>`<li><span class="category-pill" data-category="${esc(c.category)}">${esc(labelOf(c.category))}</span><strong>${c.count}</strong></li>`).join('')}</ul>`:''}
      ${p.sample.length?`<h3>${l('organizeSample')}</h3><ol class="organize-sample">${p.sample.map(m=>`<li>${esc(m.content)}</li>`).join('')}</ol>`:''}
      ${warn?`<p class="policy-box" role="alert">${l(warn)}</p>`:`<p class="muted">${l('organizeUndoHint')}</p>`}</div>
      <form data-organize-step="confirm"><div class="actions"><button type="submit" class="primary"${ready?'':' disabled data-keep-disabled'}>${l('confirmMove')}</button><button type="button" data-organize-back>${l('goBack')}</button><button type="button" data-operation-close>${l('cancel')}</button></div><p data-operation-error role="alert"></p></form>`;
    syncAppearance();content.querySelector('[data-organize-step="confirm"] button:not([disabled])')?.focus();
  }
  function resultStep(data){
    const text=`${t('organizeDone')} ${data.changed} ${t('organizeDoneTo')} ${labelOf(data.category)}`;
    content.innerHTML=`<div class="organize-result" role="status"><p class="organize-headline">${l('organizeDone')} <strong class="figure">${data.changed}</strong> ${l('organizeDoneTo')} <strong>${esc(labelOf(data.category))}</strong></p>${data.unchanged?`<p>${data.unchanged} ${l('organizeUnchangedResult')}</p>`:''}${data.replayed?`<p class="muted">${l('replayedResult')}</p>`:''}</div>
      <div class="actions">${data.undo_available&&can('memory.organize_undo')?`<button type="button" data-organize-undo="${esc(data.batch_id)}">${l('undo')}</button>`:''}<a class="button" href="/app/memories?category=${encodeURIComponent(data.category)}">${l('showCategory')}</a><button type="button" class="primary" data-operation-close>${l('close')}</button></div><p data-operation-error role="alert"></p>`;
    syncAppearance();live(text);content.querySelector('.primary')?.focus();
  }
  async function runUndo(seq,batch){
    try{busy(true);const data=await mutate('memory.organize_undo',{batch_id:batch},flow.undoOp||(flow.undoOp=crypto.randomUUID()));if(!fresh(seq))return;await reload({});if(!fresh(seq))return;
      content.innerHTML=`<div role="status"><p class="organize-headline">${l('undoResult')} <strong class="figure">${data.restored}</strong></p>${data.skipped_count?`<p>${data.skipped_count} ${l('undoSkipped')}</p>`:''}${data.restored_category?`<p>${l('categoryRestored')} <strong>${esc(labelOf(data.restored_category))}</strong></p>`:''}</div><div class="actions"><button type="button" class="primary" data-operation-close>${l('close')}</button></div>`;
      syncAppearance();live(`${t('undoResult')} ${data.restored}`);
    }catch(e){fail(e,seq);}finally{busy(false);}
  }
  async function manager(seq,message='',undoBatch=null){
    content.innerHTML=`<p role="status">${l('loading')}</p>`;
    const [tax,f]=await Promise.all([api('taxonomy'),api('memories',{part:'facets'}).catch(()=>null)]);if(!fresh(seq))return;
    const counts=new Map((f?.categories||[]).map(c=>[c.category,c.count])),labels=tax.labels||{};
    flow={kind:'manage',revision:tax.revision,categories:tax.categories,labels,counts};
    content.innerHTML=`${message?`<p class="policy-box" role="status">${esc(message)}${undoBatch&&can('memory.organize_undo')?` <button type="button" data-organize-undo="${esc(undoBatch)}">${l('undo')}</button>`:''}</p>`:''}
      <ul class="category-manager">${tax.categories.map(c=>`<li data-manage-category="${esc(c)}"><span class="category-pill" data-category="${esc(c)}">${esc(labelOf(c,labels))}</span><small>${counts.has(c)?counts.get(c):'—'} ${l('categoryCount')}</small>${c==='uncategorized'?`<small class="muted">${l('categoryFixed')}</small>`:`<span class="actions">${can('category.rename')?`<button type="button" class="quiet" data-category-rename="${esc(c)}">${l('renameCategory')}</button>`:''}${can('category.delete')?`<button type="button" class="quiet" data-category-delete="${esc(c)}">${l('deleteCategory')}</button>`:''}</span>`}</li>`).join('')}</ul>
      ${can('category.create')?`<form data-organize-step="create" class="category-create"><label>${l('newCategoryName')}<input name="label" maxlength="40" required autocomplete="off"></label><button type="submit">${l('createCategory')}</button></form>`:''}
      <p class="muted">${l('categoryManagerNote')}</p><p data-operation-error role="alert"></p><div class="actions"><button type="button" data-operation-close>${l('close')}</button></div>`;
    syncAppearance();if(message)live(message);
  }
  async function managerWrite(seq,action,payload,done){
    try{busy(true);const data=await mutate(action,{...payload,expected_revision:flow.revision},crypto.randomUUID());if(!fresh(seq))return;await reload({keepSelection:true});if(!fresh(seq))return;await done(data);}
    catch(e){if(!fresh(seq))return;if(e.message==='SETTINGS_VERSION_CHANGED'){await manager(seq,t('SETTINGS_VERSION_CHANGED')).catch(error=>fail(error,seq));return;}fail(e,seq);}
    finally{busy(false);}
  }
  async function organizeBegin(action,button){
    open(action==='memory.organize'?'moveToCategory':action);const seq=sequence;intent=null;
    try{
      if(action==='category.manage')return await manager(seq);
      if(action==='memory.organize_undo'){flow={kind:'undo',batch:button.dataset.id};
        content.innerHTML=`<form data-organize-step="undo"><p>${l('undoNote')}</p><div class="actions"><button type="submit" class="primary">${l('undo')}</button><button type="button" data-operation-close>${l('cancel')}</button></div><p data-operation-error role="alert"></p></form>`;syncAppearance();return;}
      const selection=button.dataset.id?{memory_ids:[button.dataset.id]}:getSelection();
      if(selection.memory_ids&&(!selection.memory_ids.length||selection.memory_ids.length>100))throw new Error('INVALID_SELECTION');
      flow={kind:'organize',selection};let current='uncategorized';
      if(button.dataset.id){const meta=await api('memory-meta',{memory_id:button.dataset.id});if(!fresh(seq))return;current=meta.category;}
      chooseStep(current);
    }catch(e){if(!fresh(seq))return;content.innerHTML=`<p role="alert">${esc(t(e.message))}</p><button type="button" data-operation-close>${l('close')}</button>`;}
  }
  modal.addEventListener('submit',event=>{
    const step=event.target.dataset?.organizeStep;if(!step||!flow)return;event.preventDefault();if(working)return;const seq=sequence,fd=new FormData(event.target);
    if(step==='choose')void(async()=>{try{busy(true);const label=String(fd.get('new_label')||'').trim();flow.category=String(fd.get('category'));
        if(label){const tax=await api('taxonomy');if(!fresh(seq))return;const created=await mutate('category.create',{label,expected_revision:tax.revision},crypto.randomUUID());if(!fresh(seq))return;
          await reload({keepSelection:true});if(!fresh(seq))return;flow.category=created.category;}
        await previewStep(seq);}catch(e){fail(e,seq);}finally{busy(false);}})();
    if(step==='confirm')void(async()=>{try{busy(true);const data=await mutate('memory.organize',{category:flow.category,...selectionParams(flow.selection),preview_token:flow.preview.preview_token},flow.opId);
        if(!fresh(seq))return;await reload({});if(!fresh(seq))return;resultStep(data);}
      catch(e){if(!fresh(seq))return;if(e.message==='PREVIEW_CHANGED'){await previewStep(seq,'PREVIEW_CHANGED').catch(error=>fail(error,seq));return;}fail(e,seq);}finally{busy(false);}})();
    if(step==='undo')void runUndo(seq,flow.batch);
    if(step==='create')void managerWrite(seq,'category.create',{label:String(fd.get('label')||'')},data=>manager(seq,`${t('categoryCreated')}: ${data.label}`));
    if(step==='rename')void managerWrite(seq,'category.rename',{category:event.target.dataset.category,label:String(fd.get('label')||'')},data=>manager(seq,`${t('categoryRenamed')}: ${data.label}`));
    if(step==='delete')void managerWrite(seq,'category.delete',{category:event.target.dataset.category,move_to:String(fd.get('move_to'))},data=>manager(seq,`${t('categoryDeleted')} ${data.moved}`,data.batch_id));
  });
  modal.addEventListener('click',event=>{
    if(!flow||working)return;const seq=sequence;
    if(event.target.closest('[data-organize-back]')){chooseStep(flow.category);return;}
    if(event.target.closest('[data-organize-narrow]')){modal.close();const field=document.querySelector('#search-form [name=category]')?.closest('label')?.querySelector('.select-trigger,select')||document.querySelector('[data-search-input]');field?.focus();return;}
    const undo=event.target.closest('[data-organize-undo]');if(undo){void runUndo(seq,undo.dataset.organizeUndo);return;}
    if(event.target.closest('[data-manage-back]')){void manager(seq).catch(e=>fail(e,seq));return;}
    const rename=event.target.closest('[data-category-rename]'),remove=event.target.closest('[data-category-delete]');
    if(rename||remove){const id=(rename||remove).dataset[rename?'categoryRename':'categoryDelete'],row=content.querySelector(`[data-manage-category="${CSS.escape(id)}"]`);if(!row)return;
      row.innerHTML=rename?`<form data-organize-step="rename" data-category="${esc(id)}"><label>${l('renameCategory')}<input name="label" maxlength="40" required autocomplete="off" value="${esc(labelOf(id,flow.labels))}"></label><div class="actions"><button type="submit" class="primary">${l('save')}</button><button type="button" data-manage-back>${l('cancel')}</button></div></form>`
        :`<form data-organize-step="delete" data-category="${esc(id)}"><p><strong>${esc(labelOf(id,flow.labels))}</strong> · ${flow.counts.has(id)?flow.counts.get(id):'—'} ${l('categoryCount')}</p><label>${l('deleteCategoryNote')}<select name="move_to">${options(flow.categories.filter(c=>c!==id),'uncategorized',flow.labels)}</select></label><p class="muted">${l('deleteCategoryBoundary')}</p><div class="actions"><button type="submit" class="primary">${l('deleteAndMove')}</button><button type="button" data-manage-back>${l('goBack')}</button></div></form>`;
      syncAppearance();row.querySelector('input,select')?.focus();}
  });
  const ORGANIZE_FLOW=['memory.organize','memory.organize_undo','category.manage'];
  async function begin(action,button){if(working)return;if(ORGANIZE_FLOW.includes(action))return organizeBegin(action,button);open(action);const seq=sequence;opId=crypto.randomUUID();lastPayload=null;intent={action,id:button.dataset.id,kind:button.dataset.kind,operator:button.dataset.operator};
    try{
      let fields='',data=getData();
      if(action==='memory.create'){
        const defaults=await api('privacy-defaults');if(seq!==sequence||!isActive())return;
        fields=area('content','content')+select('memory_type','memoryType',['fact','goal','constraint','decision','completed','blocker','remaining','next_step'],'fact')+field('topic','topic',{required:false,max:120})+select('scope','scope',['user','project','task','workstream','session'],'user')+field('target_id','scopeTarget',{required:false,max:128})+select('sensitivity','sensitivity',['sensitive','internal','public','secret'],defaults.sensitivity);
      }
      else if(action.startsWith('memory.batch_')){
        // The same selection the toolbar counts (kept across pages), not only this page's checked boxes.
        const picked=getSelection(),ids=picked.memory_ids?.length?picked.memory_ids:[...document.querySelectorAll('[data-batch-memory]:checked')].map(n=>n.dataset.batchMemory);if(!ids.length||ids.length>50)throw new Error('BATCH_SELECTION_REQUIRED');
        const metas=await Promise.all(ids.map(memory_id=>api('memory-meta',{memory_id})));if(seq!==sequence||!isActive())return;
        intent.items=metas.map(m=>({memory_id:m.memory_id,revision:m.revision}));
        // Show what is being changed, not only identifiers: the visible rows carry each memory's text.
        const shown=new Map((data.results||[]).map(r=>[r.memory_id,r.content]));intent.snippets=Object.fromEntries(metas.map(m=>[m.memory_id,[...String(picked.snippets?.[m.memory_id]||shown.get(m.memory_id)||'')].slice(0,120).join('')]));
        fields=`<p><strong>${metas.length}</strong> ${l(action==='memory.batch_retract'?'batchRetractCount':'batchClassifyCount')}</p><ol class="batch-confirm-list">${metas.map(m=>`<li>${esc(intent.snippets[m.memory_id]||m.memory_id)} <small>${l('revisions')} ${m.revision}</small></li>`).join('')}</ol>`+
          (action==='memory.batch_classify'?select('category','category',getCaps().taxonomy.categories,'uncategorized'):field('reason','reason',{required:false})+`<p>${l('retractNote')}</p>`);
      }
      else if(['taxonomy.save','privacy.defaults','retention.save'].includes(action)){
        const view={'taxonomy.save':'taxonomy','privacy.defaults':'privacy-defaults','retention.save':'retention'}[action],current=await api(view);if(seq!==sequence||!isActive())return;intent.revision=current.revision;
        if(action==='taxonomy.save')fields=area('categories','taxonomyCategories',current.categories.join('\n'))+`<p>${l('taxonomyEditNote')}</p>`;
        if(action==='privacy.defaults')fields=select('sensitivity','defaultSensitivity',['sensitive','internal','public','secret'],current.sensitivity)+`<p>${l('privacyDefaultsBoundary')}</p>`;
        if(action==='retention.save')fields=select('retention_mode','retentionMode',['limited','permanent'],current.raw_retention_days==='permanent'?'permanent':'limited')+field('raw_retention_days','eventRetentionDays',{type:'number',value:current.raw_retention_days==='permanent'?30:current.raw_retention_days,min:1,upper:3650})+`<p>${l('retentionBoundary')}</p>`;
      }
      else if(action==='retention.prune')fields=`<p>${l('pruneBoundary')}</p><label class="check-field"><input name="confirmed" type="checkbox" required>${l('confirmPrune')}</label>`+reauth();
      else if(action==='devices.register')fields=field('label','label',{max:120})+field('agent_id','agentId',{max:128})+field('device_id','deviceId',{max:128})+select('access','access',['read','read_write'],'read')+`<p>${l('agentKeyBoundary')}</p>`+reauth();
      else if(action==='devices.rotate')fields=`<p>${l('rotateAgentNote')}</p><code>${esc(intent.id)}</code>`+reauth();
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
        intent.settings_revision=settings.revision;fields=select('type','jobType',['classification','summary'],intent.type)+field('timezone','timezone',{value:settings.timezone})+select('periods','summaryPeriods',['daily','weekly','daily_weekly'],settings.periods?.length===1?settings.periods[0]:'daily_weekly')+check('include_open','includeOpen')+check('schedule_enabled','enablePeriodic',settings.schedule_enabled)+`<p>${l('organizeCostNote')}</p>`;
      } else if(action==='models.save'){
        const model=data.models.find(m=>m.kind===intent.kind),c=model?.config||{};intent.revision=model?.revision||0;
        fields=`<p>${l(intent.kind==='organizer'?'organizerPurpose':'embedderPurpose')}</p><fieldset><legend>${l('modelEndpoint')}</legend>`+check('enabled','enabled',c.enabled)+select('protocol','protocol',['openai_compatible','ollama'],c.protocol||'openai_compatible')+field('base_url','baseUrl',{value:c.base_url||'',max:2048})+`<p class="muted">${l('modelUrlHelp')}</p>`+field('model','modelName',{value:c.model||''})+
          field('api_key','apiKey',{type:'password',required:false,max:16384})+check('remove_key','removeKey')+`<p class="muted">${l('keyWriteOnlyNote')}</p>`+(intent.kind==='embedder'?field('dimensions','dimensions',{type:'number',value:c.dimensions||'',min:1,upper:65536,step:1})+`<p>${l('dimensionsHelp')}</p>`:'')+`</fieldset><fieldset><legend>${l('modelLimits')}</legend>`+
          field('daily_requests','dailyRequests',{type:'number',value:c.daily_requests||100,min:1,upper:10000,step:1})+field('batch_size','batchSize',{type:'number',value:c.batch_size||5,min:1,upper:20,step:1})+
          (intent.kind==='organizer'?field('output_tokens','outputTokens',{type:'number',value:c.output_tokens||4096,min:128,upper:32768,step:1}):`<input type="hidden" name="output_tokens" value="${esc(c.output_tokens||4096)}">`)+field('profile_revision','modelRevision',{value:c.profile_revision||'1',max:160})+
          (intent.kind==='organizer'?check('native_schema','nativeSchema',c.native_schema!==false):'')+`</fieldset><fieldset><legend>${l('modelPrivacy')}</legend>`+select('sensitivity','modelSensitivity',['public','internal','sensitive'],c.sensitivities?.includes('sensitive')?'sensitive':c.sensitivities?.includes('internal')?'internal':'public')+check('egress_approved','approveEgress',c.egress_approved)+(intent.kind==='embedder'?check('query_approved','approveQuery',c.query_approved):'')+`<p>${l('modelSecretExcluded')}</p></fieldset>`;
      } else if(action==='models.test'){
        fields=`<p>${l('probeCostNote')}</p><p>${l(intent.kind==='organizer'?'organizerProbeNote':'embedderProbeNote')}</p>`;
      } else if(action==='vector.schedule'){
        fields=`<p>${l('vectorScheduleNote')}</p>`;
      } else if(action==='security.password')fields=field('new_password','newPassword',{type:'password',max:1024})+field('password_confirm','passwordConfirm',{type:'password',max:1024})+reauth();
      else if(action==='security.totp.begin'||action==='security.recovery_codes')fields=reauth();
      else if(action==='invitations.issue')fields=`<p>${l('invitationPrivateNote')}</p>`+field('count','count',{type:'number',value:1,min:1,upper:getCaps().invitation_batch_limit,step:1})+field('ttl_minutes','ttlMinutes',{type:'number',value:60,min:1,upper:1440,step:1})+reauth();
      else if(action.startsWith('invitations.')||action.startsWith('accounts.'))fields=`<p>${esc(data.accounts?.find(a=>a.account_id===intent.id)?.username||'')} <code>${esc(intent.id)}</code></p>${action==='accounts.disable'?`<p class="policy-box">${l('disableAccountNote')}</p>`:action==='accounts.enable'?`<p>${l('enableAccountNote')}</p>`:''}`+reauth();
      else if(action==='devices.revoke'){const device=(data.core_connections||[]).find(c=>c.agent_instance_id===intent.id);
        fields=`<p>${l('connRevokeDeviceNote')}</p><p><strong>${esc(device?.agent_id||'')}</strong> ${esc(device?.label||'')} <code>${esc(intent.id)}</code></p>`+reauth();}
      else if(action==='storage.import')fields=`<p>${l('portableNote')}</p><label>${l('file')}<input type="file" name="file" accept="application/json,.json" required></label><label class="check-field"><input type="checkbox" name="confirm_import" required>${l('confirmImport')}</label>`;
      else if(action==='jobs.retry'&&button.dataset.stale==='true'){modal.querySelector('h2').textContent=t('rescheduleWithCategories');fields=`<p>${l('rescheduleNote')}</p><code>${esc(intent.id)}</code>`;}
      else fields=`<p>${l(action==='storage.export'?'exportPrivacyNote':action==='models.test'?'probeCostNote':'confirmAction')}</p><code>${esc(intent.id||intent.kind||'')}</code>`;
      if(seq!==sequence||!isActive())return;content.innerHTML=`<form id="operation-form">${fields}${modalActions(action==='storage.export'?'export':'confirm')}</form>`;syncAppearance();content.querySelector('input,textarea,select,button')?.focus();
    }catch(e){if(seq!==sequence||!isActive())return;content.innerHTML=`<p role="alert">${esc(t(e.message))}</p><button type="button" data-operation-close>${l('close')}</button>`;}
  }
  function payload(fd){const a=intent.action,p={};
    if(a==='memory.create'){Object.assign(p,{content:fd.get('content'),memory_type:fd.get('memory_type'),scope:fd.get('scope'),sensitivity:fd.get('sensitivity')});if(fd.get('topic'))p.topic=fd.get('topic');if(p.scope!=='user')p[`${p.scope}_id`]=fd.get('target_id');}
    else if(a.startsWith('memory.batch_')){p.items=intent.items;if(a==='memory.batch_classify')p.category=fd.get('category');else if(fd.get('reason'))p.reason=fd.get('reason');}
    else if(a==='taxonomy.save'){p.expected_revision=intent.revision;p.categories=String(fd.get('categories')).split(/[\s,，]+/).filter(Boolean);}
    else if(a==='privacy.defaults'){p.expected_revision=intent.revision;p.sensitivity=fd.get('sensitivity');p.cloud_readable=false;}
    else if(a==='retention.save'){p.expected_revision=intent.revision;p.raw_retention_days=fd.get('retention_mode')==='permanent'?'permanent':Number(fd.get('raw_retention_days'));}
    else if(a==='retention.prune'){p.confirmed=fd.has('confirmed');p.batch_size=100;}
    else if(a==='devices.register')Object.assign(p,{label:fd.get('label'),agent_id:fd.get('agent_id'),device_id:fd.get('device_id'),access:fd.get('access')});
    else if(a==='devices.rotate')p.credential_id=intent.id;
    else if(a==='memory.web_policy'){p.read_all=intent.enable;p.expected_revision=intent.revision;}
    else if(a.startsWith('memory.')){Object.assign(p,{memory_id:intent.id,revision:intent.meta.revision});if(a==='memory.correct'){p.content=fd.get('content');p.topic=fd.get('topic')||null;p.memory_type=intent.meta.memory_type;}if(fd.get('reason'))p.reason=fd.get('reason');if(a==='memory.classify')p.category=fd.get('category');if(a==='memory.sensitivity')p.sensitivity=fd.get('sensitivity');if(a==='memory.visibility'){p.allow=fd.has('allow');p.state_hash=intent.meta.state_hash;}}
    else if(a==='jobs.schedule')Object.assign(p,{type:fd.get('type'),timezone:fd.get('timezone'),periods:fd.get('periods')==='daily_weekly'?['daily','weekly']:[fd.get('periods')],include_open:fd.has('include_open'),schedule_enabled:fd.has('schedule_enabled'),settings_revision:intent.settings_revision});
    else if(a==='jobs.cancel'||a==='jobs.retry')p.job_id=intent.id;
    else if(a==='models.save'){
      p.kind=intent.kind;p.expected_revision=intent.revision;const sensitivity=fd.get('sensitivity');p.config={enabled:fd.has('enabled'),protocol:fd.get('protocol'),base_url:fd.get('base_url'),model:fd.get('model'),profile_revision:fd.get('profile_revision'),daily_requests:Number(fd.get('daily_requests')),output_tokens:Number(fd.get('output_tokens')),batch_size:Number(fd.get('batch_size')),sensitivities:sensitivity==='public'?['public']:sensitivity==='internal'?['public','internal']:['public','internal','sensitive'],egress_approved:fd.has('egress_approved'),query_approved:fd.has('query_approved'),native_schema:intent.kind==='organizer'?fd.has('native_schema'):true};if(intent.kind==='embedder')p.config.dimensions=Number(fd.get('dimensions'));if(fd.get('api_key'))p.api_key=fd.get('api_key');if(fd.has('remove_key'))p.remove_key=true;
    } else if(a==='models.test'||a==='models.disable'){p.kind=intent.kind;if(a==='models.test')p.mode='capabilities';else p.expected_revision=getData().models.find(m=>m.kind===intent.kind).revision;}
    else if(a==='oauth.revoke')p.grant_id=intent.id;
    else if(a==='devices.revoke')p.agent_instance_id=intent.id;
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
  async function importFile(fd){const file=fd.get('file');if(!file||file.size>16*1024*1024)throw new Error('IMPORT_FILE_TOO_LARGE');
    // A parser message ("Unexpected end of JSON input") means nothing to a person: report what is wrong with the file.
    let doc;try{doc=JSON.parse(await file.text());}catch{throw new Error('IMPORT_INVALID_JSON');}
    if(doc?.format!=='mnemuron-personal-portable-v1')throw new Error('INVALID_IMPORT');if(!Array.isArray(doc.records)||!doc.records.length)throw new Error('IMPORT_EMPTY');
    // Preflight every record before sending any chunk. No SQL, credentials or scopes from files are executable.
    for(const r of doc.records)if(typeof r.content!=='string'||r.content.length>4096||!r.content.trim())throw new Error('IMPORT_CONTENT_TOO_LONG');
    // Up to 20 records per request (the Core limit), bounded by size. Each chunk commits atomically; a
    // re-run of the same file reports already imported records as existing instead of duplicating them.
    const chunks=[];let chunk=[],bytes=0;
    for(const r of doc.records){const n=new TextEncoder().encode(JSON.stringify(r)).length;if(chunk.length&&(chunk.length>=20||bytes+n>40000)){chunks.push(chunk);chunk=[];bytes=0;}chunk.push(r);bytes+=n;}
    if(chunk.length)chunks.push(chunk);
    const status=document.createElement('p');status.setAttribute('role','status');status.dataset.importProgress='';content.querySelector('form')?.append(status);
    let created=0,existing=0,done=0;
    for(const [i,records] of chunks.entries()){if(!isActive())throw new Error('STALE_ACCOUNT');
      for(let attempt=0;;attempt++){
        try{const res=await mutate('storage.import',{format:doc.format,records,confirm_personal_scope:true},`${opId}.c${i}`);created+=res.created;existing+=res.existing;done+=records.length;status.textContent=`${t('importProgress')} ${done} / ${doc.records.length}`;break;}
        catch(e){
          // The console write limit is a fixed one-minute window and rejects before Core runs anything:
          // wait it out and resend the same chunk under the same operation ID.
          if(e.message==='RATE_LIMITED'&&attempt<3&&isActive()){status.textContent=`${t('importProgress')} ${done} / ${doc.records.length} · ${t('importRateWait')}`;await new Promise(r=>setTimeout(r,61000));continue;}
          throw new Error(`${t('importPartial')}: ${done}/${doc.records.length} · ${t(e.message)} · ${t('importResumeNote')}`);
        }}}
    return {status:'imported',created,existing,total:doc.records.length,originals_overwritten:false};
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
  modal.addEventListener('close',()=>{sequence++;intent=null;flow=null;opId=null;lastPayload=null;content.replaceChildren();returnFocus?.focus();returnFocus=null;});
  return {clear(){sequence++;intent=null;flow=null;opId=null;lastPayload=null;working=false;content.replaceChildren();modal.close();}};
}

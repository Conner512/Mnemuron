import {collectAuditExport} from './audit.mjs';
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
// Coarse sign-in snapshot as stored for that session; never the browser viewing this page.
const clientKey=(s,k)=>`${k}_${/^[a-z]{1,16}$/.test(s[k])?s[k]:'unknown'}`;
const sessionClient=s=>s.client_recorded?['device','browser','os'].map(k=>l(clientKey(s,k))).join(' · '):l('clientNotRecorded');
const inspect=(collection,id)=>`<button type="button" class="quiet" data-inspect="${collection}" data-id="${esc(id)}">${l('inspectDetails')}</button>`;
const pager=data=>`<div class="pagination">${data.offset?`<button type="button" data-offset="${Math.max(0,data.offset-(data.limit||25))}">${l('previous')}</button>`:''}${data.next_offset!=null?`<button type="button" data-offset="${data.next_offset}">${l('next')}</button>`:''}</div>`;
const progress=(done,total)=>{const n=Number(done)||0,m=Number(total)||0,w=m>0?Math.min(100,Math.round(n/m*100)):0;return `<span class="progress"><svg viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="track" width="100" height="4" rx="2"/><rect class="fill" width="${w}" height="4" rx="2"/></svg><span>${n} / ${m}</span></span>`;};

const ownerLabels={processing:'后台处理',classification:'自动分类',summary:'摘要生成',entities:'实体提取',vector_build:'向量构建',vector_search:'语义检索',memory:'记忆业务',handoff:'接续交接',capture:'捕获提取',conversation:'会话提取',cloud_write:'Cloud 记忆写入',cloud_submitted_grants:'提交版本可读授权',connections:'个人连接管理'};
const ownerActions=['features.save','schedule.save','processing.preview','processing.start','processing.pause','processing.resume','processing.cancel'];
const ownerButton=(action,label,data={})=>`<button type="button" data-console-action="${esc(action)}" ${Object.entries(data).map(([k,v])=>`data-${k}="${esc(v)}"`).join(' ')}>${esc(label)}</button>`;
function ownerView(o){if(!o)return '<p role="alert">功能状态暂时不可用，请重试。</p>';
 return `<section class="card"><h2>功能与处理</h2><p>当前账户是唯一所有者。保存配置、允许功能、开始处理是独立操作。历史数据须先预览并确认；注册码保留后台管理。</p><p>配置版本 ${esc(o.revision)} · ${o.flags.processing?'后台待命':'后台处理已暂停'} · 自动历史补处理：关闭</p><dl class="metadata-grid">${Object.entries(ownerLabels).map(([k,label])=>`<dt>${esc(label)}</dt><dd>${o.effective[k]?.effective?'可用':'不可用'}${o.effective[k]?.blockers?.length?' · '+esc(o.effective[k].blockers.map(c=>({FEATURE_DISABLED:'开关已关闭',PROCESSING_PAUSED:'后台已暂停',NOT_CONFIGURED:'模型未配置',EGRESS_DENIED:'尚未同意模型外发',QUERY_EGRESS_DENIED:'尚未同意查询外发',VECTOR_DISABLED:'向量基础设施未配置',VECTOR_NOT_READY:'索引尚未就绪',MEMORY_DISABLED:'记忆业务已关闭',CONVERSATION_NOT_CONFIGURED:'未配置会话提取范围',CLOUD_WRITE_NOT_CONFIGURED:'未配置 Cloud 写入'}[c]||t(c))).join(' / ')):''}</dd>`).join('')}</dl><div class="actions">${ownerButton('features.save','修改功能开关')}${ownerButton('schedule.save','设置新记录自动规则')}${ownerButton('processing.preview','预览有限批次')}</div><p>自动规则：${o.schedule.enabled?'已启用，仅限保存规则后新建的记忆':o.schedule.error_code?'已暂停 · '+t(o.schedule.error_code):'关闭'}；隔离的旧可运行任务：${esc(o.legacy_runnable_jobs)}</p></section><section class="card"><h2>处理批次</h2><p>暂停会停止后续请求与发布。已经发送的数据无法撤回。向量构建完成后仍须单独激活。</p>${o.runs.length?o.runs.map(r=>`<article class="policy-box"><strong>${esc(ownerLabels[r.kind]||r.kind)}</strong> · ${esc(r.state)} · 调用 ${esc(r.used)}/${esc(r.budget)} · ${esc(r.count)} 条 · ${esc(r.model||'')}<p><code class="owner-digest">${esc(r.manifest_digest)}</code></p>${r.error_code?`<p role="status">${esc(r.error_code)}</p>`:''}<div class="actions">${r.state==='preview'?ownerButton('processing.start','确认并开始',{id:r.run_id}):''}${['running','queued'].includes(r.state)?ownerButton('processing.pause','暂停',{id:r.run_id}):''}${['paused','blocked'].includes(r.state)?ownerButton('processing.resume','确认恢复',{id:r.run_id}):''}${!['completed','cancelled'].includes(r.state)?ownerButton('processing.cancel','取消',{id:r.run_id}):''}</div></article>`).join(''):'<p>尚无授权批次。</p>'}</section>`;
}
export function actionPage(page,data,caps,connectionQuery={}) {
  if(page==='system'&&caps.owner_mode)return ownerView(data.features?.['system-health']?.owner);
  if(page==='system'&&!caps.operator)return section(page,note('operatorRequired'));
  const writable=caps.enabled===true&&caps.writable===true,can=action=>canAct(caps,action);
  const onlyRead=()=>note(caps.enabled?'consoleUpgradeRequired':'viewWithoutWrite');

  if(page==='models'){
    const p=data.processing||{},blocked=items=>(items||[]).map(code=>`<p class="muted">${esc(t(code))}</p>`).join('');
    const launch=(action,key,ready,values={})=>can(action)?actionButton(action,key,values).replace('<button ',`<button ${ready?'':'disabled '}`):'';
    // First run: a frozen manifest, a finite call budget, a confirmed build and an explicit activation (or rollback).
    const firstRun=step=>{const fr=step.first_run||{},b=fr.budget;
      const facts=fr.generation?kv([['vectorCollection',`<code>${esc(fr.collection)}</code>`],['dimensions',esc(fr.dimensions)],['manifestCount',esc(fr.manifest.count)],['manifestDigest',`<code class="digest">${esc(fr.manifest.digest)}</code>`],
        ['manifestProgress',`${esc(fr.manifest.indexed)} ${l('indexedShort')} · ${esc(fr.manifest.pending)} ${l('pendingShort')} · ${esc(fr.manifest.stale)} ${l('staleShort')}`],['state',l('firstRunState_'+fr.build)+(fr.error_code?` · ${esc(t(fr.error_code))}`:'')],['serving',l(fr.serving?'yes':'no')]]):'';
      // With manual call limits the first-run total is a record that keeps counting, not the enforced cap.
      const budget=b?kv([['firstRunBudget',`${esc(b.used)} / ${esc(b.total)}`+(p.quotas?.embedder?.mode==='manual'?` <small class="muted">${l('supersededByCallLimits')}</small>`:'')]]):'';
      // Once a first run embedded records its budget belongs to it: re-activate it instead of preparing again.
      const embedded=!!(fr.manifest?.indexed||fr.manifest?.stale||fr.manifest?.excluded);
      const actions=[...(embedded?[]:[launch('vector.prepare','prepareFirstRun',step.ready===true&&!fr.serving)]),
        ...(fr.generation&&fr.state==='building'&&fr.build!=='pending'?[launch('vector.schedule','startFirstRunBuild',true,{generation:fr.generation})]:[]),
        ...(fr.generation&&['ready','retired'].includes(fr.state)&&!fr.serving?[launch('vector.activate','activateIndex',true,{generation:fr.generation})]:[]),
        ...(fr.generation&&fr.serving?[launch('vector.deactivate','deactivateIndex',true,{generation:fr.generation})]:[])];
      return `<div class="first-run" data-first-run><h4>${l('firstRun')}</h4><p class="muted">${l('firstRunNote')}</p>${budget}${facts}${buttons(actions)}</div>`;};
    const verification=v=>`<div class="model-verification" role="status"><strong>${l(!v?'probeNotRun':v.state==='verified'?'probeVerified':v.state==='running'?'probeRunning':'probeFailed')}</strong>${v?`<p>${esc(time(v.updated_at))}${v.error_code?` · ${esc(t(v.error_code))}`:''}</p>${v.checks?.length?`<p>${v.checks.map(c=>esc(t(c))).join(' · ')}</p>`:''}${v.skipped?.length?`<p>${l('probeSkipped')}: ${v.skipped.map(c=>esc(t(c))).join(' · ')}</p>`:''}`:''}</div>`;
    // Enforced call limits as the server reports them: "No limit" is shown as such, never as a number.
    const limit=x=>x?`${esc(x.used)} ${l('usedOfLimit')} / ${x.limit===null?l('noLimit'):esc(x.limit)}`:'—';
    const limits=q=>q?`<div class="call-limits" data-call-limits="${esc(q.kind)}"><h4>${l('callLimits')}</h4>`+kv([['limitSource',l('limitMode_'+q.mode)],['dailyCallLimit',limit(q.daily)],['totalCallLimit',limit(q.total)]])+blocked(q.exhausted)+`</div>`:'';
    return `<div class="card-grid">${(data.models||[]).map(m=>section(m.kind,
      `<p>${l(m.kind==='organizer'?'organizerPurpose':'embedderPurpose')}</p>`+
      kv([['modelName',`<span class="model-name">${esc(m.config.model||t('modelNotConfigured'))}</span>`+(m.kind==='embedder'&&m.config.dimensions?` <span class="model-dimensions" data-model-dimensions>${esc(m.config.dimensions)} ${l('dimensionsShort')}</span>`:'')],['baseUrl',`<code>${esc(m.config.base_url||'—')}</code>`],['dailyRequests',esc(m.config.daily_requests??'—')+(p.quotas?.[m.kind]?.mode==='manual'?` <small class="muted">${l('supersededByCallLimits')}</small>`:'')],['hasKey',l(m.has_key?'yes':'no')]])+verification(m.verification)+limits(p.quotas?.[m.kind])+
      buttons([...(can('models.save')?[actionButton('models.save','configure',{kind:m.kind})]:[]),...(can('models.quota')?[actionButton('models.quota','setCallLimits',{kind:m.kind})]:[]),...(m.config.enabled&&can('models.test')?[actionButton('models.test','testCapabilities',{kind:m.kind})]:[]),...(m.config.enabled&&can('models.disable')?[actionButton('models.disable','disable',{kind:m.kind})]:[]),inspect('models',m.kind)])+(!can('models.save')?onlyRead():''),
      {aside:state(m.config.enabled?'enabled':'disabled'),className:'model-card'})).join('')}</div>`+
      section('modelPipeline',`<p>${l('modelPipelineNote')}</p><div class="card-grid model-pipeline">${['classification','summary','vector'].map(kind=>{
        const step=p[kind]||{},vector=kind==='vector';return `<div data-model-stage="${kind}"><h3>${l(kind)}</h3>${state(step.ready?'ready':'notReady')}${blocked(step.blockers)}${vector?kv([['indexedDocuments',esc(step.indexed_documents??0)],['state',esc(t(step.state||'not_started'))],['semanticReadiness',l(step.search_ready?'ready':'notReady')]])+blocked(step.search_blockers)+blocked(step.error_code?[step.error_code]:[]):''}${vector?firstRun(step):''}${buttons([...(vector&&step.first_run?.budget?[]:[launch(vector?'vector.schedule':'jobs.schedule',vector?'rebuildIndex':kind==='summary'?'summarize':'organize',step.ready===true,vector?{}:{type:kind})])])}</div>`;
      }).join('')}</div><div class="section-foot"><a href="/app/jobs">${l('viewJobs')} →</a><a href="/app/summaries">${l('viewSummaries')} →</a></div>`)+
      section('modelBoundary',`<p>${l('modelBoundaryNote')}</p><p>${l('modelProbeBoundary')}</p>`);
  }

  if(page==='jobs')return section('jobs',`<div class="status-line">${l('scheduleStatus')} ${state(data.settings?.schedule_enabled?'enabled':'disabled')}<span aria-hidden="true">·</span>${l('workerStatus')} ${state(data.worker_enabled?'enabled':'disabled')}${data.vector?`<span aria-hidden="true">·</span>${l('vectorIndex')} ${state(data.vector.state)} ${esc(data.vector.error_code||'')}`:''}</div>
    ${can('jobs.schedule')?(data.processing?.classification?.blockers?.some(code=>['NOT_CONFIGURED','EGRESS_DENIED'].includes(code))
      // Without a usable model these buttons can only fail: say why and where to fix it instead.
      ?`<div class="actions action-toolbar">${[['organize','classification'],['summarize','summary']].map(([k,type])=>`<button type="button" data-console-action="jobs.schedule" data-type="${type}" disabled>${l(k)}</button>`).join('')}</div><p class="policy-box">${l('jobsNotReady')} ${data.processing.classification.blockers.filter(code=>code!=='WORKER_DISABLED').map(code=>esc(t(code))).join(' · ')} · <a href="/app/models">${l('classifyOpenModels')}</a></p>`
      :buttons([actionButton('jobs.schedule','organize',{type:'classification'}),actionButton('jobs.schedule','summarize',{type:'summary'})])):onlyRead()}
    ${!data.worker_enabled?note('workerDisabledNote'):''}
    ${table(data.jobs,['scope','state','progress','error','actions'],j=>`<tr><td><button type="button" class="link-button" data-job-detail="${esc(j.job_id)}">${esc(t(j.job_type))}</button><small><code>${esc(j.job_id)}</code></small></td><td><span class="state-dot" data-state="${esc(j.state)}">${l('jobState_'+j.state)}</span></td><td>${progress(j.processed,j.total)}</td>
      <td>${j.last_error_code?`<span class="job-error">${esc(t(j.last_error_code))}</span><small><code>${esc(j.last_error_code)}</code></small>${j.stale_taxonomy&&j.last_error_code!=='RESCHEDULED'?`<small class="job-hint">${l('jobStaleTaxonomyHint')}</small>`:''}`:'—'}</td>
      <td>${buttons([...(can('jobs.cancel')&&j.state!=='succeeded'&&j.state!=='cancelled'?[actionButton('jobs.cancel','cancelJob',{id:j.job_id})]:[]),...(can('jobs.retry')&&j.last_error_code!=='RESCHEDULED'&&['dead_letter','blocked_auth','blocked_budget','blocked_config','review_required','retry_wait','cancelled'].includes(j.state)?[j.stale_taxonomy?actionButton('jobs.retry','rescheduleWithCategories',{id:j.job_id,stale:'true'}):actionButton('jobs.retry','retry',{id:j.job_id})]:[])])}</td></tr>`)}
    <div class="section-foot">${pager(data)}</div>`,{aside:refresh()});

  if(page==='connections')return connectionsView(data,caps,connectionQuery);

  if(page==='security')return `<div class="columns">${section('accountSecurity',`<div class="identity-row"><span class="avatar" aria-hidden="true">${esc([...(data.username||'·')][0])}</span><div><strong>${esc(data.username)}</strong>${tag(t(data.mfa_verified?'passwordTotp':'pending'))}</div></div>
      ${buttons([['security.password','changePassword'],['security.totp.begin','changeTotp'],['security.recovery_codes','rotateRecovery']].filter(([a])=>can(a)).map(([a,k])=>actionButton(a,k)))}${!can('security.password')?onlyRead():''}<p class="muted">${l('securityOperationsNote')}</p><a href="/recover">${l('recover')} →</a>`)}
    ${section('sessions',`<p class="muted">${l('sessionClientNote')}</p>`+table(data.sessions,['created','sessionClient','expires','actions'],s=>`<tr><td>${esc(time(s.created))}${s.current?`<small>${l('currentSession')}</small>`:''}</td><td>${sessionClient(s)}</td><td>${esc(time(s.expires))}</td><td>${buttons([inspect('sessions',s.session_id),...(can('security.session.revoke')?[actionButton('security.session.revoke','revoke',{id:s.session_id})]:[])])}</td></tr>`),{aside:can('security.sessions.revoke_others')?actionButton('security.sessions.revoke_others','revokeOtherSessions'):''})}</div>`;



  if(page==='storage')return `<div class="columns">${section('personalExport',`<p>${l('portableNote')}</p>${writable?buttons([actionButton('storage.export','export'),actionButton('storage.import','importMemories')]):onlyRead()}${note('databaseRestoreNote')}`)}
    ${section('storage',kv(Object.entries(data.counts||{}).map(([k,n])=>[k,`<strong class="figure">${esc(n)}</strong>`])))}</div>`;

  return null;
}
const field=(name,key,{value='',type='text',required=true,max=4096,min,upper,step}={})=>`<label>${l(key)}<input name="${name}" type="${type}" value="${esc(value)}" maxlength="${max}"${min!==undefined?` min="${min}"`:''}${upper!==undefined?` max="${upper}"`:''}${step!==undefined?` step="${step}"`:''} ${required?'required':''} ${type==='password'?'autocomplete="off"':''}></label>`;
const area=(name,key,value='')=>`<label>${l(key)}<textarea name="${name}" maxlength="4096" rows="7" required>${esc(value)}</textarea></label>`;
const select=(name,key,items,value)=>`<label>${l(key)}<select name="${name}">${items.map(v=>`<option data-i18n="${esc(v)}" value="${esc(v)}" ${v===value?'selected':''}>${esc(t(v))}</option>`).join('')}</select></label>`;
const check=(name,key,value=false)=>`<label class="check-field"><input type="checkbox" name="${name}" ${value?'checked':''}>${l(key)}</label>`;
const reauth=()=>`<fieldset class="reauth"><legend>${l('reauthenticate')}</legend>${field('current_password','currentPassword',{type:'password',max:1024})}${field('otp','otp',{max:6})}<p>${l('otpFreshNote')}</p></fieldset>`;
// Model-list discovery inside the model form: a non-submit control, so drafts are kept and no model name is needed.
const discoveryBlock=()=>`<div class="model-discovery" data-model-discovery>${check('discover_consent','discoverConsent')}<div class="actions"><button type="button" data-discover-models>${l('discoverModels')}</button></div>
  <p class="muted" data-discover-key></p><div data-discover-choice></div><p data-discover-status role="status" aria-live="polite"></p><p class="muted">${l('discoverManualNote')}</p></div>`;
const modalActions=(submit='save')=>`<div class="actions"><button type="submit" class="primary">${l(submit)}</button><button type="button" data-operation-close>${l('cancel')}</button></div><p data-operation-error role="alert"></p>`;

/** Read-only inspectors share the session-bound transport; no actions, tokens or data in storage. */
export function mountFeatureReads({api,isActive,getAuditParams}){
  const modal=document.createElement('dialog');modal.id='feature-dialog';modal.setAttribute('aria-labelledby','feature-read-title');
  modal.innerHTML=`<div class="dialog-header"><h2 id="feature-read-title"></h2><button type="button" data-feature-close>${l('close')}</button></div><div data-feature-content></div>`;document.body.append(modal);
  const content=modal.querySelector('[data-feature-content]');let seq=0,focus,next=null,compare=null,exporting=false,exportSeq=0;
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
    if(event.target.closest('[data-audit-export]')&&!exporting){const target=document.querySelector('[data-audit-result]'),button=event.target.closest('[data-audit-export]');exporting=true;const generation=++exportSeq;
      const current=()=>isActive()&&generation===exportSeq;
      button.disabled=true;if(target)target.textContent=t('loading');
      void(async()=>{const doc=await collectAuditExport(params=>api('audit',params),getAuditParams(),current);if(!current())return;
        const blob=new Blob([JSON.stringify(doc,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');
        a.href=url;a.download=`mnemuron-${doc.source}-audit.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);if(target?.isConnected)target.textContent=t('auditExportDone')+' '+doc.entries.length;
      })().catch(e=>{if(target?.isConnected&&current())target.textContent=t(e.message);}).finally(()=>{if(generation===exportSeq){exporting=false;if(button.isConnected)button.disabled=false;}});
    }
  });
  modal.addEventListener('close',()=>{seq++;next=null;compare=null;content.replaceChildren();focus?.isConnected&&focus.focus();focus=null;});
  return {invalidateAudit(){exportSeq++;exporting=false;},clear(){seq++;exportSeq++;exporting=false;next=null;compare=null;content.replaceChildren();modal.close();}};
}

// Project/task editing. Full list values come from paged reads; a list changes only by explicitly removing
// shown values and adding new lines, so values the person never touched are never resent or rewritten.
const PROJECT_FIELDS=['aliases','git_remotes','repo_fingerprints','path_hints'];
const VALUE_MAX={aliases:2048,git_remotes:2048,repo_fingerprints:2048,path_hints:4096};
const listEditor=(field,items)=>`<fieldset class="list-editor" data-list-field="${field}"><legend>${l(`field_${field}`)} <small class="figure">${items.length}</small></legend>
  ${items.length?`<ul>${items.map((item,i)=>`<li>${item.too_large?`<span class="muted">${l('valueTooLarge')}</span>`:`<label class="check-field"><input type="checkbox" name="remove_${field}" value="${i}"><span class="list-value">${esc(item.value)}</span></label>`}</li>`).join('')}</ul><p class="muted">${l('removeValuesHint')}</p>`:`<p class="muted">${l('noValues')}</p>`}
  <label>${l('addValues')}<textarea name="add_${field}" rows="2" maxlength="${50*(VALUE_MAX[field]+1)}"></textarea></label></fieldset>`;
function listChanges(fd,lists,fields){
  const add={},remove={};
  for(const field of fields){
    const removed=fd.getAll(`remove_${field}`).map(Number).map(i=>lists[field][i]).filter(item=>item&&!item.too_large).map(item=>item.value);
    const added=String(fd.get(`add_${field}`)||'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
    if(removed.length)remove[field]=removed;if(added.length)add[field]=added;
  }
  return {...(Object.keys(add).length?{add}:{}),...(Object.keys(remove).length?{remove}:{})};
}
export function mountActions({api,mutate,getData,getCaps,getFacets=()=>null,getSelection=()=>({memory_ids:[]}),reload,isActive}) {
  // Every page of one field, all at one revision; a revision change mid-read means the record changed.
  async function listValues(kind,id,field,current){const items=[];let offset=0,revision;
    for(let pages=0;offset!==null;pages++){if(pages>20)throw new Error('DETAIL_SIZE_LIMIT');
      const page=await api('metadata-values',{kind,id,field,offset,limit:10});if(!current())throw new Error('STALE_ACCOUNT');
      if(revision!==undefined&&page.revision!==revision)throw new Error(kind==='project'?'PROJECT_VERSION_CHANGED':'TASK_VERSION_CHANGED');
      revision=page.revision;items.push(...page.items);offset=page.next_offset;}
    return {items,revision};}
  const modal=document.createElement('dialog');modal.id='operation-dialog';modal.setAttribute('aria-labelledby','operation-title');modal.innerHTML='<div class="dialog-header"><h2 id="operation-title"></h2><button type="button" data-operation-close aria-label="Close">×</button></div><div id="operation-content"></div>';document.body.append(modal);
  const content=modal.querySelector('#operation-content');let intent=null,opId=null,lastPayload=null,returnFocus=null,sequence=0,working=false;
  function open(title){sequence++;returnFocus=document.activeElement;modal.querySelector('h2').textContent=t(title);content.innerHTML=`<p>${l('loading')}</p>`;if(!modal.open)modal.showModal();}
  const MEMORY_RESULTS={'memory.create':'resultCreated','memory.correct':'resultCorrected','memory.retract':'resultRetracted','memory.sensitivity':'resultSensitivity','memory.batch_retract':'resultBatchRetract','memory.batch_classify':'resultBatchClassify'};
  function result(data){content.replaceChildren();
    if(ownerActions.includes(intent?.action)){
      const message=document.createElement('p');message.setAttribute('role','status');message.textContent=data.status==='preview'?`预览已生成：${data.count} 条，模型 ${data.model}，最多 ${data.budget} 次调用。未发送内容。关闭此窗口后可检查批次并确认开始。`:data.status==='saved'?'配置已保存。本次保存没有启动处理。':data.status==='queued'?'批次已获授权，等待后台处理。':data.status==='paused'?'批次已暂停，不再领取或发布结果。':'批次已取消，已经发送的请求无法撤回。';content.append(message);intent=null;const close=document.createElement('button');close.type='button';close.dataset.operationClose='';close.textContent=t('close');content.append(close);close.focus();return;
    }
const pre=document.createElement('pre');pre.className='operation-result';const {qr_svg,...display}=data;pre.textContent=JSON.stringify(display,null,2);
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
    if(intent?.action==='models.test'||intent?.action==='models.save'||intent?.action==='jobs.schedule'||intent?.action?.startsWith('vector.')){
      const message=document.createElement('p');message.className='policy-box';message.textContent=t(data.status==='verified'?'modelProbePassed':data.status==='saved'?'modelSavedNext':data.status==='no_work'?'modelNoWork':
        data.status==='prepared'?'firstRunPrepared':data.status==='activated'?'indexActivated':data.status==='deactivated'?'indexDeactivated':'modelQueued');content.prepend(message);
    }
    if(intent?.action==='models.quota'){const message=document.createElement('p');message.className='policy-box';message.setAttribute('role','status');message.textContent=t('callLimitsSaved');content.prepend(message);}
    if(intent?.action==='jobs.retry'){
      const message=document.createElement('p');message.className='policy-box';message.setAttribute('role','status');
      message.textContent=data.status==='rescheduled'?`${t('rescheduledResult')} ${data.jobs.length} · ${t('supersededResult')} ${data.superseded}`:data.status==='no_work'?t('rescheduledNoWork'):t('modelQueued');content.prepend(message);
    }
    if(intent?.action==='storage.import'&&data.status==='imported'){
      const note=document.createElement('p');note.className='policy-box';note.setAttribute('role','status');note.textContent=`${t('importDone')}: ${t('importCreated')} ${data.created} · ${t('importExisting')} ${data.existing}`;
      const next=document.createElement('a');next.className='button primary';next.href='/app/memories?origin=imported';next.textContent=t('organizeImported');content.prepend(note,next);
    }
    if(data.login_required){const a=document.createElement('a');a.href='/login';a.textContent=t('signIn');content.append(a);}
    if(data.qr_svg){const qr=document.createElement('div');qr.className='qr';qr.innerHTML=data.qr_svg;content.prepend(qr);}
    if(data.enrollment_id){const f=document.createElement('form');f.innerHTML=field('new_otp','otp',{max:6})+modalActions('verify');content.append(f);intent={action:'security.totp.complete',enrollment_id:data.enrollment_id};opId=crypto.randomUUID();lastPayload=null;}
    else {intent=null;const b=document.createElement('button');b.type='button';b.dataset.operationClose='';b.textContent=t('close');content.append(b);}
    // Replacing a submitted form removes its focused submit button. Keep keyboard users in
    // the dialog and announce the concise outcome rather than leaving focus on document.body.
    if(data.enrollment_id)content.querySelector('input')?.focus();
    else {const outcome=content.querySelector('[role="status"],.policy-box')||pre;outcome.tabIndex=-1;outcome.focus({preventScroll:true});}
  }
  function inspectResult(data){
    intent=null;const row=data.job||data,values={...row,...row.config};
    const fields={kind:'scope',job_type:'jobType',state:'state',enabled:'enabled',model:'modelName',base_url:'baseUrl',protocol:'protocol',revision:'revisions',daily_requests:'dailyRequests',has_key:'hasKey',client_id:'oauthClient',grant_id:'operationId',credential_id:'operationId',label:'label',agent_id:'agentId',device_id:'deviceId',agent_instance_id:'agentInstance',scope:'scope',scopes:'scope',scopes_json:'scope',purpose:'scope',created:'created',created_at:'created',updated_at:'updated',expires:'expires',expires_at:'expires',last_used_at:'lastUsed',session_id:'sessionIdentifier',current:'currentSession',total:'sourceCount',processed:'processedCount',attempt_count:'attemptCount',last_error_code:'error',result_ref:'resultReference'};
    const dateFields=new Set(['created','created_at','updated_at','expires','expires_at','last_used_at']);
    const dl=document.createElement('dl');dl.className='metadata-grid';
    for(const [key,label] of Object.entries(fields))if(values[key]!==undefined){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=t(label);const v=values[key];dd.textContent=v===null?'—':dateFields.has(key)?time(v):typeof v==='boolean'?t(v?'yes':'no'):Array.isArray(v)?v.join(', '):String(v);dl.append(dt,dd);}
    // A session shows the families stored at its sign-in, or "not recorded" for sessions from before that; location is never collected.
    if(row.session_id!==undefined){const put=(label,value)=>{const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=t(label);dd.textContent=value;dl.append(dt,dd);};
      for(const k of ['device','browser','os'])put(`session_${k}`,row.client_recorded?t(clientKey(row,k)):t('clientNotRecorded'));put('sessionLocation',t('locationNotRecorded'));}
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
      syncAppearance();live(`${t('undoResult')} ${data.restored}`);content.querySelector('.primary')?.focus();
    }catch(e){fail(e,seq);}finally{busy(false);}
  }
  async function manager(seq,message='',undoBatch=null){
    content.innerHTML=`<p role="status">${l('loading')}</p>`;
    const [tax,f]=await Promise.all([api('taxonomy'),api('memories',{part:'facets'}).catch(()=>null)]);if(!fresh(seq))return;
    const counts=new Map((f?.categories||[]).map(c=>[c.category,c.count])),labels=tax.labels||{};
    flow={kind:'manage',revision:tax.revision,categories:tax.categories,labels,descriptions:tax.descriptions||{},counts};
    content.innerHTML=`${message?`<p class="policy-box" role="status">${esc(message)}${undoBatch&&can('memory.organize_undo')?` <button type="button" data-organize-undo="${esc(undoBatch)}">${l('undo')}</button>`:''}</p>`:''}
      <ul class="category-manager">${tax.categories.map(c=>`<li data-manage-category="${esc(c)}"><span class="category-pill" data-category="${esc(c)}">${esc(labelOf(c,labels))}</span><small>${counts.has(c)?counts.get(c):'—'} ${l('categoryCount')}</small>${c==='uncategorized'?`<small class="muted">${l('categoryFixed')}</small>`:`<span class="actions">${can('category.rename')?`<button type="button" class="quiet" data-category-rename="${esc(c)}">${l('renameCategory')}</button>`:''}${can('category.delete')?`<button type="button" class="quiet" data-category-delete="${esc(c)}">${l('deleteCategory')}</button>`:''}</span>`}</li>`).join('')}</ul>
      ${can('category.create')?`<form data-organize-step="create" class="category-create"><label>${l('newCategoryName')}<input name="label" maxlength="40" required autocomplete="off"></label><label>${l('categoryDescription')}<textarea name="description" maxlength="600" rows="3" placeholder="${esc(t('categoryDescriptionHint'))}"></textarea></label><button type="submit">${l('createCategory')}</button></form>`:''}
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
    if(step==='create')void managerWrite(seq,'category.create',{label:String(fd.get('label')||''),description:String(fd.get('description')||'')},data=>manager(seq,`${t('categoryCreated')}: ${data.label}`));
    if(step==='rename')void managerWrite(seq,'category.rename',{category:event.target.dataset.category,label:String(fd.get('label')||''),...(String(fd.get('description')||'')!==(flow.descriptions[event.target.dataset.category]||'')?{description:String(fd.get('description')||'')}:{})},data=>manager(seq,`${t('categoryRenamed')}: ${data.label}`));
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
      row.innerHTML=rename?`<form data-organize-step="rename" data-category="${esc(id)}"><label>${l('renameCategory')}<input name="label" maxlength="40" required autocomplete="off" value="${esc(labelOf(id,flow.labels))}"></label><label>${l('categoryDescription')}<textarea name="description" maxlength="600" rows="3" placeholder="${esc(t('categoryDescriptionHint'))}">${esc(flow.descriptions[id]||'')}</textarea></label><p class="muted">${l('categorySemanticNote')}</p><div class="actions"><button type="submit" class="primary">${l('save')}</button><button type="button" data-manage-back>${l('cancel')}</button></div></form>`
        :`<form data-organize-step="delete" data-category="${esc(id)}"><p><strong>${esc(labelOf(id,flow.labels))}</strong> · ${flow.counts.has(id)?flow.counts.get(id):'—'} ${l('categoryCount')}</p><label>${l('deleteCategoryNote')}<select name="move_to">${options(flow.categories.filter(c=>c!==id),'uncategorized',flow.labels)}</select></label><p class="muted">${l('deleteCategoryBoundary')}</p><div class="actions"><button type="submit" class="primary">${l('deleteAndMove')}</button><button type="button" data-manage-back>${l('goBack')}</button></div></form>`;
      syncAppearance();row.querySelector('input,select')?.focus();}
  });
  // Project lifecycle (5G): delete, restore, merge. Preview first (no factors), then a confirm that needs the typed name
  // (delete) and a fresh password + OTP. A stale preview is refreshed in place without using the factors (the BFF answers
  // staleness before checking them); the person's typed name and factors are kept. Every reply is ignored unless it
  // belongs to the newest request of this dialog (latest-response guard); Back and Cancel write nothing.
  const LIFECYCLE_FLOW={'projects.lifecycle_delete':'delete','projects.lifecycle_restore':'restore','projects.merge':'merge'};
  const projectName=id=>(getData().projects||[]).find(p=>p.project_id===id)?.name||id;
  function impactView(preview){
    const i=preview.impact||{},tt=i.totals||{};
    const facts=[['taskCount',tt.tasks],['impactMemories',`${tt.active_memories??0} / ${tt.memories??0}`],['impactRevisions',tt.revisions],['impactCheckpoints',tt.checkpoints],['impactEvents',tt.events],
      ['impactSummaries',tt.summaries],['impactVectors',tt.vector_indexed_memories],['impactEntities',tt.entities],['impactEntityProposals',tt.entity_proposals],['impactPendingEntities',tt.pending_entity_proposals],['impactPending',(tt.pending_bootstrap_previews||0)+(tt.pending_resume_previews||0)+(tt.pending_reconciliation_proposals||0)],['impactJobs',tt.queued_jobs]];
    const members=(i.members||[]).map(m=>`<li><strong>${esc(m.name)}</strong> <code>${esc(m.project_id)}</code>${m.archived?` <span class="tag" data-state="archived">${l('consoleArchived')}</span>`:''} <small class="muted">${l('taskCount')} ${esc(m.tasks)} · ${l('impactMemories')} ${esc(m.memories)}</small></li>`).join('');
    const conflicts=(i.conflicts||[]).map(c=>`<li>${c.kind==='same_task_title'?`${l('conflictSameTitle')}: <strong>${esc(c.title)}</strong>`:`${l('conflictName')}: <strong>${esc(c.value)}</strong>`}</li>`).join('');
    return `<section class="lifecycle-impact" aria-label="${esc(t('impactTitle'))}"><h3>${l('impactTitle')}</h3>${kv(facts.map(([k,v])=>[k,esc(v??0)]))}
      <h4>${l('impactMembers')} <small class="figure">${esc(i.members_total??0)}</small></h4><ul class="lifecycle-members">${members}</ul>${i.members_truncated?`<p class="muted">${l('impactTruncated')}</p>`:''}
      ${preview.action==='merge'?`<h4>${l('impactConflicts')} <small class="figure">${esc(i.conflicts_total??0)}</small></h4>${conflicts?`<ul class="lifecycle-conflicts">${conflicts}</ul>`:`<p class="muted">${l('noConflicts')}</p>`}${i.conflicts_truncated?`<p class="muted">${l('impactTruncated')}</p>`:''}<p class="policy-box">${l('mergeConflictNote')}</p><p class="policy-box">${l('mergeNoUndo')}</p>`:''}
      <p class="policy-box">${l(preview.action==='delete'?'deleteRetentionNote':preview.action==='restore'?'restoreLifecycleNote':'mergeRetentionNote')}</p></section>`;
  }
  async function lifecycleBegin(action,button){
    open(action);const seq=sequence;intent=null;
    flow={kind:'lifecycle',action:LIFECYCLE_FLOW[action],confirm:action,project:button.dataset.id,previews:0,searches:0};
    try{if(flow.action==='merge')await targetStep(seq);else await lifecyclePreview(seq);}
    catch(e){if(!fresh(seq))return;content.innerHTML=`<p role="alert">${esc(t(e.message))}</p><button type="button" data-operation-close>${l('close')}</button>`;}
  }
  async function targetStep(seq,query=''){
    clearTimeout(lifecycleTimer);flow.target=null;flow.targetsReady=false;
    content.innerHTML=`<form data-lifecycle-step="target"><p>${l('mergeSourceNote')} <strong>${esc(projectName(flow.project))}</strong> <code>${esc(flow.project)}</code></p>
      <label>${l('mergeTargetSearch')}<input name="query" maxlength="200" autocomplete="off" value="${esc(query)}" data-lifecycle-search></label>
      <fieldset class="lifecycle-targets"><legend>${l('mergeTarget')}</legend><div data-lifecycle-targets><p class="muted">${l('loading')}</p></div></fieldset>
      <div class="actions"><button type="submit" class="primary" data-lifecycle-preview disabled>${l('previewMerge')}</button><button type="button" data-operation-close>${l('cancel')}</button></div><p data-operation-error role="alert"></p></form>`;
    syncAppearance();content.querySelector('[data-lifecycle-search]')?.focus();await searchTargets(seq,query);
  }
  async function searchTargets(seq,query){
    if(!fresh(seq)||flow?.kind!=='lifecycle')return;
    const mine=++flow.searches,box=content.querySelector('[data-lifecycle-targets]');if(!box)return;
    const current=()=>fresh(seq)&&flow?.kind==='lifecycle'&&mine===flow.searches&&content.querySelector('[data-lifecycle-targets]')===box;
    targetSearchPending(box);
    try{
      const data=await api('projects',{archived:'any',limit:20,...(query.trim()?{query:query.trim()}:{})});
      if(!current())return;
      // Selection may have changed while the reply was in flight. Retain only the exact checked ID
      // that remains in this latest owner-scoped eligible result, never a similarly named project.
      const selected=box.querySelector('input[name="target"]:checked')?.value,focused=box.contains(document.activeElement)?document.activeElement.value:null;
      const eligible=(data.projects||[]).filter(p=>p.project_id!==flow.project);
      flow.target=eligible.some(p=>p.project_id===selected)?selected:null;flow.targetsReady=true;
      box.innerHTML=eligible.length?`<ul class="lifecycle-target-list">${eligible.map(p=>`<li><label class="check-field"><input type="radio" name="target" value="${esc(p.project_id)}"${p.project_id===flow.target?' checked':''}><span><strong>${esc(p.name)}</strong> <code>${esc(p.project_id)}</code>${p.archived?` <span class="tag" data-state="archived">${l('consoleArchived')}</span>`:''}</span></label></li>`).join('')}</ul>${data.next_offset!=null?`<p class="muted">${l('mergeTargetMore')}</p>`:''}`:`<p class="muted">${l('noEligibleTargets')}</p>`;
      content.querySelector('[data-lifecycle-preview]').disabled=!flow.target;
      if(focused)([...box.querySelectorAll('input[name="target"]')].find(input=>input.value===focused)||content.querySelector('[data-lifecycle-search]'))?.focus({preventScroll:true});
    }catch(e){if(current())throw e;}
    finally{if(current())box.setAttribute('aria-busy','false');}
  }
  function targetSearchPending(box){
    flow.targetsReady=false;box.setAttribute('aria-busy','true');content.querySelector('[data-lifecycle-preview]').disabled=true;
  }
  // While a preview loads, its inputs and submit/refresh controls are disabled: Cancel, Escape and Back stay usable
  // (a preview writes no material state, and a late reply is ignored by the guards below).
  let lifecycleTimer=null;
  const previewLoading=on=>{for(const c of content.querySelectorAll('[data-lifecycle-refresh],[data-lifecycle-preview],[data-lifecycle-search],.lifecycle-targets input'))c.disabled=on;syncConfirm(on);};
  // The confirm button is usable only while a current preview is shown and nothing is loading.
  const syncConfirm=(loading=false)=>{for(const c of content.querySelectorAll('[data-lifecycle-step="confirm"] button[type=submit]'))c.disabled=loading||!flow?.preview;};
  async function lifecyclePreview(seq,{message='',keep=null}={}){
    const mine=++flow.previews;flow.preview=null;previewLoading(true);
    try{
      const data=await mutate('projects.lifecycle_preview',{action:flow.action,project_id:flow.project,...(flow.action==='merge'?{target_project_id:flow.target}:{})},crypto.randomUUID());
      if(!fresh(seq)||mine!==flow.previews)return;
      flow.preview=data;flow.opId=crypto.randomUUID();
      const named=flow.action==='delete'?`<label>${l('typeProjectName')} <strong>${esc(data.project_name)}</strong><input name="confirm_name" autocomplete="off" required maxlength="2000"></label>`:'';
      content.innerHTML=`<form data-lifecycle-step="confirm" data-preview-id="${esc(data.preview_id)}">${message?`<p class="policy-box" role="status" tabindex="-1" data-lifecycle-message>${esc(message)}</p>`:''}
        <p><strong>${esc(data.project_name)}</strong> <code>${esc(data.project_id)}</code>${data.target_project_id?` → <code>${esc(data.target_project_id)}</code>`:''}</p>
        ${impactView(data)}${named}${reauth()}
        <div class="actions"><button type="submit" class="${flow.action==='restore'?'primary':'primary danger'}">${l(flow.action==='delete'?'confirmDeleteProject':flow.action==='restore'?'confirmRestoreProject':'confirmMergeProject')}</button>
          <button type="button" data-lifecycle-refresh>${l('refreshPreview')}</button>${flow.action==='merge'?`<button type="button" data-lifecycle-back>${l('back')}</button>`:''}<button type="button" data-operation-close>${l('cancel')}</button></div>
        <p class="muted">${l('previewExpires')} <time>${esc(time(data.expires_at))}</time></p><p data-operation-error role="alert"></p></form>`;
      syncAppearance();
      if(keep)for(const [name,value] of Object.entries(keep)){const input=content.querySelector(`[name="${name}"]`);if(input)input.value=value;}
      (content.querySelector('[data-lifecycle-message]')||content.querySelector('input,button'))?.focus();if(message)live(message);
    }finally{if(fresh(seq)&&flow&&mine===flow.previews)previewLoading(false);}
  }
  async function lifecycleConfirm(seq,fd){
    const preview=flow.preview;if(!preview)return;
    const keep=Object.fromEntries(['confirm_name','current_password','otp'].filter(k=>fd.has(k)).map(k=>[k,String(fd.get(k))]));
    let focusAfter=null;
    const payload={preview_id:preview.preview_id,...(flow.action==='delete'?{confirm_name:keep.confirm_name||''}:{}),current_password:keep.current_password||'',otp:keep.otp||''};
    busy(true);
    try{
      const data=await mutate(flow.confirm,payload,flow.opId);
      // The change happened even if the dialog was closed meanwhile: the list is refreshed either way.
      if(!fresh(seq)){if(isActive())void reload().catch(()=>{});return;}
      await reload();if(!fresh(seq))return;
      const key={deleted:'projectDeletedResult',restored:'projectRestoredResult',merged:'projectMergedResult'}[data.status]||'operationDone';
      content.innerHTML=`<div class="lifecycle-result"><p class="policy-box" role="status" tabindex="-1" data-lifecycle-result>${l(key)} <strong>${esc(preview.project_name)}</strong>${data.target_project_id?` → <code>${esc(data.target_project_id)}</code>`:''}</p>
        ${data.status==='merged'?`<p class="muted">${l('mergeNoUndo')}</p>`:''}${data.status==='deleted'?`<p class="muted">${l('deletedRestoreHint')}</p>`:''}<div class="actions"><button type="button" data-operation-close>${l('close')}</button></div></div>`;
      syncAppearance();content.querySelector('[data-lifecycle-result]')?.focus();live(`${t(key)} ${preview.project_name}`);
    }catch(e){
      if(!fresh(seq))return;
      // The authenticator code is single-use: it is kept only after a name mismatch, which the BFF answers before checking
      // the factors. After any other error it may have been used, so it is cleared and asked for again.
      const mismatch=e.message==='CONFIRMATION_MISMATCH';
      if(!mismatch){delete keep.otp;const otp=content.querySelector('[name="otp"]');if(otp)otp.value='';}
      if(['REAUTHENTICATION_FAILED','INVALID_OTP','RATE_LIMITED','SESSION_REQUIRED'].includes(e.message)){delete keep.current_password;const pw=content.querySelector('[name="current_password"]');if(pw)pw.value='';}
      // A stale or expired preview: refresh it, keeping the typed name (and password).
      if(['PREVIEW_CHANGED','PREVIEW_EXPIRED'].includes(e.message)){busy(false);await lifecyclePreview(seq,{message:t(e.message==='PREVIEW_EXPIRED'?'previewRefreshedExpired':'previewRefreshedChanged'),keep}).catch(error=>fail(error,seq));return;}
      // One announcement (the alert region), and focus where the fix is needed.
      const node=content.querySelector('[data-operation-error]');if(node)node.textContent=t(e.message);
      focusAfter=mismatch?'[name="confirm_name"]':'[name="current_password"]';
    }finally{working=false;if(fresh(seq)){busy(false);syncConfirm();if(focusAfter)content.querySelector(focusAfter)?.focus();}}
  }
  modal.addEventListener('submit',event=>{
    const step=event.target.dataset?.lifecycleStep;if(!step||flow?.kind!=='lifecycle')return;event.preventDefault();if(working)return;const seq=sequence,fd=new FormData(event.target);
    if(step==='target'){const target=fd.get('target');if(!target||!flow.targetsReady||content.querySelector('[data-lifecycle-preview]')?.disabled)return;flow.target=String(target);void lifecyclePreview(seq).catch(e=>fail(e,seq));}
    if(step==='confirm')void lifecycleConfirm(seq,fd);
  });
  modal.addEventListener('input',event=>{
    if(flow?.kind!=='lifecycle')return;
    if(event.target.matches('[data-lifecycle-search]')){const seq=sequence,input=event.target,value=input.value,box=content.querySelector('[data-lifecycle-targets]');clearTimeout(lifecycleTimer);flow.searches++;if(box)targetSearchPending(box);
      lifecycleTimer=setTimeout(()=>{if(fresh(seq)&&content.querySelector('[data-lifecycle-search]')===input)void searchTargets(seq,value).catch(e=>fail(e,seq));},200);}
  });
  modal.addEventListener('change',event=>{if(flow?.kind==='lifecycle'&&event.target.name==='target'){const b=content.querySelector('[data-lifecycle-preview]');if(b)b.disabled=!flow.targetsReady;}});
  modal.addEventListener('click',event=>{
    if(flow?.kind!=='lifecycle'||working)return;const seq=sequence;
    if(event.target.closest('[data-lifecycle-refresh]')){const form=content.querySelector('[data-lifecycle-step="confirm"]'),fd=form?new FormData(form):null;
      const keep=fd?Object.fromEntries(['confirm_name','current_password','otp'].filter(k=>fd.has(k)).map(k=>[k,String(fd.get(k))])):null;void lifecyclePreview(seq,{message:t('previewRefreshed'),keep}).catch(e=>fail(e,seq));return;}
    if(event.target.closest('[data-lifecycle-back]')){flow.previews++;void targetStep(seq).catch(e=>fail(e,seq));}
  });
  const ORGANIZE_FLOW=['memory.organize','memory.organize_undo','category.manage'];
  async function begin(action,button){if(working)return;if(ORGANIZE_FLOW.includes(action))return organizeBegin(action,button);if(Object.hasOwn(LIFECYCLE_FLOW,action))return lifecycleBegin(action,button);open(action);const seq=sequence;opId=crypto.randomUUID();lastPayload=null;intent={action,id:button.dataset.id,kind:button.dataset.kind,operator:button.dataset.operator};
    try{
      let fields='',data=getData();
      if(ownerActions.includes(action)){
        modal.querySelector('h2').textContent={'features.save':'功能开关','schedule.save':'新记录自动规则','processing.preview':'预览有限批次','processing.start':'确认并开始处理','processing.resume':'确认恢复处理','processing.pause':'暂停处理','processing.cancel':'取消批次'}[action];
        const o=(await api('system-health')).owner;if(!o)throw new Error('OWNER_REQUIRED');intent.owner=o;intent.revision=o.revision;
        if(action==='features.save')fields='<p>只保存功能配置。任何配置变更都会暂停已有批次，打开开关不会启动历史处理。</p>'+Object.entries(ownerLabels).map(([key,label])=>`<label class="check-field"><input type="checkbox" name="${key}" ${o.flags[key]?'checked':''}>${esc(label)}</label>`).join('')+select('read_policy','ChatGPT 读取策略',o.read_policy_options.map(x=>x.value),o.preferences.read_policy)+`<p>${o.read_policy_options.map(x=>esc(x.value)+'：当前可读 '+esc(x.active_readable)+' 条活动记忆').join('；')}。不扩大现有连接权限，secret 和生命周期边界始终保留。</p>`+select('retrieval_mode','默认检索模式',['lexical','hybrid','semantic'],o.preferences.retrieval_mode)+reauth();
        else if(action==='schedule.save')fields='<p>仅处理本次保存后新建的记录，不补旧记录或旧修订。保存不会立即执行。后续执行仍需后台与各通道开关、模型外发许可和额度均可用。</p>'+check('enabled','启用自动规则',o.schedule.enabled)+['classification','summary','entities','vector'].map(k=>check(k,ownerLabels[k]||'向量构建',o.schedule.kinds.includes(k))).join('')+field('interval_minutes','间隔（分钟）',{type:'number',value:o.schedule.interval_minutes,min:5,upper:10080})+field('max_items','每轮最多记录数',{type:'number',value:o.schedule.max_items,min:1,upper:100})+field('budget','每轮最多模型调用数',{type:'number',value:o.schedule.budget,min:1,upper:1000})+reauth();
        else if(action==='processing.preview')fields='<p>预览只生成冻结清单，不发送正文，不启动处理。最多选择100条当前可用、非 secret 且已获外发许可的记录。</p>'+select('kind','处理类型',['classification','summary','entities','vector'],'classification')+field('limit','最多记录数',{type:'number',value:10,min:1,upper:100})+field('budget','最多模型调用数（含重试）',{type:'number',value:10,min:1,upper:1000})+field('from','创建时间起点（ISO 8601）',{required:false})+field('to','创建时间终点（ISO 8601）',{required:false});
        else {const run=o.runs.find(r=>r.run_id===intent.id);if(!run)throw new Error('RUN_NOT_FOUND');intent.run=run;fields=`<p>${esc(run.kind)} · ${esc(run.count)} 条 · ${esc(run.model)} · 已用/上限 ${esc(run.used)}/${esc(run.budget)}</p><p>敏感度：${esc(JSON.stringify(run.sensitivities))}；排除 ${esc(run.excluded)} 条${run.truncated?'；范围内还有未选记录':''}</p><code class="owner-digest">${esc(run.manifest_digest)}</code><p>${['processing.start','processing.resume'].includes(action)?'确认后仅处理此冻结清单，可能向上述已配置模型发送内容。':'停止后不会自动恢复；已发送请求无法撤回。'}</p>`+(['processing.start','processing.resume'].includes(action)?reauth():'');}
      }
      else if(action==='memory.create'){
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
      else if(action==='taxonomy.save'){
        const current=await api('taxonomy');if(seq!==sequence||!isActive())return;intent.revision=current.revision;
        fields=area('categories','taxonomyCategories',current.categories.join('\n'))+`<p>${l('taxonomyEditNote')}</p>`;
      }
      else if(action==='projects.update'){
        const row=(getData().projects||[]).find(p=>p.project_id===intent.id);if(!row)throw new Error('PROJECT_NOT_FOUND');
        const current=()=>seq===sequence&&isActive(),lists={};let revision=null;
        for(const name of PROJECT_FIELDS){const r=await listValues('project',intent.id,name,current);if(revision!==null&&r.revision!==revision)throw new Error('PROJECT_VERSION_CHANGED');revision=r.revision;lists[name]=r.items;}
        if(!current())return;
        // The list row and the full values must describe the same revision; otherwise the page is stale.
        if(revision!==row.revision)throw new Error('PROJECT_VERSION_CHANGED');
        Object.assign(intent,{revision,lists,name:row.name,nameComplete:row.name_complete!==false});
        fields=(intent.nameComplete?field('name','projectName',{value:row.name,max:200}):`<p class="policy-box">${l('nameTooLongToEdit')}</p>`)+PROJECT_FIELDS.map(name=>listEditor(name,lists[name])).join('');
      }
      else if(action==='tasks.update'){
        const current=()=>seq===sequence&&isActive(),d=await api('task-detail',{task_id:intent.id});if(!current())return;
        const aliases=await listValues('task',intent.id,'aliases',current);if(!current())return;
        if(aliases.revision!==d.canonical_version)throw new Error('TASK_VERSION_CHANGED');
        Object.assign(intent,{version:d.canonical_version,task:d,lists:{aliases:aliases.items}});
        fields=`<p class="muted">${l('projectName')}: ${esc(d.project_name??t('unknown'))}${d.project_name_complete===false?'…':''}</p>`+
          (d.title_complete?field('title','taskTitle',{value:d.title,max:2000}):`<p class="policy-box">${l('fieldTooLongToEdit')}</p>`)+
          (d.goal_complete?`<label>${l('taskGoal')}<textarea name="goal" maxlength="8000" rows="6" required>${esc(d.goal)}</textarea></label>`:`<p class="policy-box">${l('fieldTooLongToEdit')}</p>`)+
          (d.status_editable?select('status','status',['active','paused','completed','archived'],d.status):`<p class="policy-box">${l('statusNotEditable')}</p>`)+
          listEditor('aliases',aliases.items)+
          `<p class="policy-box">${l('taskRetainedNote')} ${Object.entries(d.retained||{}).map(([k,n])=>`${l(`field_${k}`)} ${esc(n)}`).join(' · ')}</p>`;
      }
      else if(action==='projects.archive'||action==='projects.restore'){
        const row=(getData().projects||[]).find(p=>p.project_id===intent.id);
        fields=`<p><strong>${esc(row?.name||'')}</strong> <code>${esc(intent.id)}</code></p><p class="policy-box">${l(action==='projects.archive'?'archiveProjectNote':'restoreProjectNote')}</p>`;
      }
      else if(action==='devices.register')fields=field('label','label',{max:120})+field('agent_id','agentId',{max:128})+field('device_id','deviceId',{max:128})+select('access','access',['read','read_write'],'read')+`<p>${l('agentKeyBoundary')}</p>`+reauth();
      else if(action==='devices.rotate')fields=`<p>${l('rotateAgentNote')}</p><code>${esc(intent.id)}</code>`+reauth();
      else if(action.startsWith('memory.')){
        const meta=await api('memory',{memory_id:intent.id,metadata:'true'});if(seq!==sequence||!isActive())return;intent.meta=meta;
        if(action==='memory.correct'){
          const page=await api('memory',{memory_id:intent.id,content_limit:4096,revision:meta.revision});if(seq!==sequence||!isActive())return;
          if(!page.content_complete)throw new Error('EDIT_REQUIRES_COMPLETE_RECORD');fields=area('content','content',page.memory.content)+field('reason','reason',{required:false})+field('topic','topic',{value:meta.topic||'',required:false,max:120});
        } else if(action==='memory.classify')fields=select('category','category',getCaps().taxonomy.categories,meta.category);
        else if(action==='memory.sensitivity')fields=select('sensitivity','sensitivity',['sensitive','internal','public','secret'],meta.sensitivity)+`<p>${l('sensitivityNote')}</p>`;
        else fields=field('reason','reason',{required:false})+`<p>${l('retractNote')}</p>`;
      } else if(action==='jobs.schedule'){
        intent.type=button.dataset.type||'classification';const status=await api('jobs');if(seq!==sequence||!isActive())return;const settings=status.settings||{revision:0,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,schedule_enabled:false};
        intent.settings_revision=settings.revision;fields=select('type','jobType',['classification','summary'],intent.type)+field('timezone','timezone',{value:settings.timezone})+select('periods','summaryPeriods',['daily','weekly','daily_weekly'],settings.periods?.length===1?settings.periods[0]:'daily_weekly')+check('include_open','includeOpen')+check('schedule_enabled','enablePeriodic',settings.schedule_enabled)+`<p>${l('organizeCostNote')}</p>`;
      } else if(action==='models.save'){
        const model=data.models.find(m=>m.kind===intent.kind),c=model?.config||{};intent.revision=model?.revision||0;
        fields=`<p>${l(intent.kind==='organizer'?'organizerPurpose':'embedderPurpose')}</p><fieldset><legend>${l('modelEndpoint')}</legend>`+check('enabled','enableModel',c.enabled)+select('protocol','protocol',['openai_compatible','ollama'],c.protocol||'openai_compatible')+field('base_url','baseUrl',{value:c.base_url||'',max:2048})+`<p class="muted">${l('modelUrlHelp')}</p>`+field('model','modelName',{value:c.model||''})+
          field('api_key','apiKey',{type:'password',required:false,max:16384})+check('remove_key','removeKey')+`<p class="muted">${l('keyWriteOnlyNote')}</p>`+discoveryBlock()+(intent.kind==='embedder'?field('dimensions','dimensions',{type:'number',value:c.dimensions||'',min:1,upper:65536,step:1})+`<p>${l('dimensionsHelp')}</p>`:'')+`</fieldset><fieldset><legend>${l('modelLimits')}</legend>`+
          field('daily_requests','dailyRequests',{type:'number',value:c.daily_requests||100,min:1,upper:10000,step:1})+field('batch_size','batchSize',{type:'number',value:c.batch_size||5,min:1,upper:20,step:1})+
          (intent.kind==='organizer'?field('output_tokens','outputTokens',{type:'number',value:c.output_tokens||4096,min:128,upper:32768,step:1}):`<input type="hidden" name="output_tokens" value="${esc(c.output_tokens||4096)}">`)+field('profile_revision','modelRevision',{value:c.profile_revision||'1',max:160})+
          (intent.kind==='organizer'?check('native_schema','nativeSchema',c.native_schema!==false):'')+`</fieldset><fieldset><legend>${l('modelPrivacy')}</legend>`+select('sensitivity','modelSensitivity',['public','internal','sensitive'],c.sensitivities?.includes('sensitive')?'sensitive':c.sensitivities?.includes('internal')?'internal':'public')+check('egress_approved','approveEgress',c.egress_approved)+(intent.kind==='embedder'?check('query_approved','approveQuery',c.query_approved):'')+`<p>${l('modelSecretExcluded')}</p></fieldset>`;
      } else if(action==='models.quota'){
        const q=(data.processing??getData().processing)?.quotas?.[intent.kind];if(!q)throw new Error('unavailable');intent.revision=q.mode==='manual'?q.revision:0;
        // Each limit is an explicit choice; the number only applies with "Limit to". A legacy limit is offered as the starting value.
        const choice=(name,key,x)=>select(`${name}_mode`,key,['limit_unlimited','limit_limited'],x.limit===null?'limit_unlimited':'limit_limited')+
          field(name,'callLimitValue',{type:'number',value:x.limit??'',required:false,min:0,upper:name==='daily_limit'?1000000:1000000000,step:1});
        fields=`<p>${l('callLimitsNote')}</p>`+choice('daily_limit','dailyCallLimitMode',q.daily)+choice('total_limit','totalCallLimitMode',q.total)+`<p class="policy-box">${l('callLimitsBoundary')}</p>`;
      } else if(action==='models.test'){
        fields=`<p>${l('probeCostNote')}</p><p>${l(intent.kind==='organizer'?'organizerProbeNote':'embedderProbeNote')}</p>`;
      } else if(action==='vector.prepare'){
        fields=`<p>${l('firstRunPrepareNote')}</p>`+field('budget_calls','firstRunBudgetField',{type:'number',min:1,upper:150,step:1})+`<p class="policy-box">${l('firstRunSendNote')}</p>`;
      } else if(action==='vector.schedule'&&button.dataset.generation){
        const fr=(data.processing??getData().processing)?.vector?.first_run||{};intent.generation=button.dataset.generation;intent.digest=fr.manifest?.digest;
        fields=`<p>${l('firstRunBuildNote')}</p>`+kv([['manifestCount',esc(fr.manifest?.count)],['manifestDigest',`<code class="digest">${esc(fr.manifest?.digest)}</code>`],['firstRunBudget',`${esc(fr.budget?.used)} / ${esc(fr.budget?.total)}`]])+
          field('expected_count','firstRunExpectedCount',{type:'number',min:1,upper:1000000,step:1})+`<p class="policy-box">${l('firstRunSendNote')}</p>`;
      } else if(action==='vector.activate'||action==='vector.deactivate'){
        intent.generation=button.dataset.generation;fields=`<p>${l(action==='vector.activate'?'activateIndexNote':'deactivateIndexNote')}</p><code>${esc(intent.generation)}</code>`;
      } else if(action==='vector.schedule'){
        fields=`<p>${l('vectorScheduleNote')}</p>`;
      } else if(action==='security.password')fields=field('new_password','newPassword',{type:'password',max:1024})+field('password_confirm','passwordConfirm',{type:'password',max:1024})+reauth();
      else if(action==='security.totp.begin'||action==='security.recovery_codes')fields=reauth();
      else if(action==='devices.revoke'){const device=(data.core_connections||[]).find(c=>c.agent_instance_id===intent.id);
        fields=`<p>${l('connRevokeDeviceNote')}</p><p><strong>${esc(device?.agent_id||'')}</strong> ${esc(device?.label||'')} <code>${esc(intent.id)}</code></p>`+reauth();}
      else if(action==='storage.import')fields=`<p>${l('portableNote')}</p><label>${l('file')}<input type="file" name="file" accept="application/json,.json" required></label><label class="check-field"><input type="checkbox" name="confirm_import" required>${l('confirmImport')}</label>`;
      else if(action==='jobs.retry'&&button.dataset.stale==='true'){modal.querySelector('h2').textContent=t('rescheduleWithCategories');fields=`<p>${l('rescheduleNote')}</p><code>${esc(intent.id)}</code>`;}
      else fields=`<p>${l(action==='storage.export'?'exportPrivacyNote':action==='models.test'?'probeCostNote':'confirmAction')}</p><code>${esc(intent.id||intent.kind||'')}</code>`;
      if(seq!==sequence||!isActive())return;content.innerHTML=`<form id="operation-form">${fields}${modalActions(action==='storage.export'?'export':'confirm')}</form>`;syncAppearance();discoveryReset();
      // What each control showed when rendered. HTML normalizes initial values (a text input drops CR/LF, a
      // textarea drops one leading newline), so an untouched field is detected against this, not the stored text.
      intent.baseline=Object.fromEntries([...content.querySelectorAll('#operation-form input[name],#operation-form textarea[name],#operation-form select[name]')].filter(c=>c.type!=='checkbox').map(c=>[c.name,c.value]));
      content.querySelector('input,textarea,select,button')?.focus();
    }catch(e){if(seq!==sequence||!isActive())return;content.innerHTML=`<p role="alert">${esc(t(e.message))}</p><button type="button" data-operation-close>${l('close')}</button>`;}
  }
  function payload(fd){const a=intent.action,p={};
    if(ownerActions.includes(a)){
      if(a==='features.save'){p.expected_revision=intent.revision;p.flags=Object.fromEntries(Object.keys(ownerLabels).map(k=>[k,fd.has(k)]));p.read_policy=fd.get('read_policy');p.retrieval_mode=fd.get('retrieval_mode');}
      else if(a==='schedule.save')Object.assign(p,{expected_revision:intent.revision,enabled:fd.has('enabled'),kinds:['classification','summary','entities','vector'].filter(k=>fd.has(k)),interval_minutes:Number(fd.get('interval_minutes')),max_items:Number(fd.get('max_items')),budget:Number(fd.get('budget'))});
      else if(a==='processing.preview'){Object.assign(p,{kind:fd.get('kind'),limit:Number(fd.get('limit')),budget:Number(fd.get('budget'))});for(const k of ['from','to'])if(fd.get(k))p[k]=fd.get(k);}
      else {p.run_id=intent.id;if(['processing.start','processing.resume'].includes(a))p.digest=intent.run.manifest_digest;}
      if(['features.save','schedule.save','processing.start','processing.resume'].includes(a)){p.current_password=fd.get('current_password');p.otp=fd.get('otp');}return p;
    }
    if(a==='memory.create'){Object.assign(p,{content:fd.get('content'),memory_type:fd.get('memory_type'),scope:fd.get('scope'),sensitivity:fd.get('sensitivity')});if(fd.get('topic'))p.topic=fd.get('topic');if(p.scope!=='user')p[`${p.scope}_id`]=fd.get('target_id');}
    else if(a.startsWith('memory.batch_')){p.items=intent.items;if(a==='memory.batch_classify')p.category=fd.get('category');else if(fd.get('reason'))p.reason=fd.get('reason');}
    else if(a==='taxonomy.save'){p.expected_revision=intent.revision;p.categories=String(fd.get('categories')).split(/[\s,，]+/).filter(Boolean);}
    // Only fields the person actually changed are sent (compared with the rendered baseline); the server merges
    // everything else from the stored record, so untouched names, titles and goals stay exactly as stored.
    else if(a==='projects.update'){p.project_id=intent.id;p.expected_revision=intent.revision;const edited=name=>fd.has(name)&&fd.get(name)!==intent.baseline[name];
      if(intent.nameComplete&&edited('name'))p.name=String(fd.get('name')).trim();Object.assign(p,listChanges(fd,intent.lists,PROJECT_FIELDS));}
    else if(a==='tasks.update'){const d=intent.task,edited=name=>fd.has(name)&&fd.get(name)!==intent.baseline[name];p.task_id=intent.id;p.expected_canonical_version=intent.version;
      if(d.title_complete&&edited('title'))p.title=fd.get('title');
      if(d.goal_complete&&edited('goal'))p.goal=fd.get('goal');
      if(d.status_editable&&edited('status'))p.status=fd.get('status');
      Object.assign(p,listChanges(fd,intent.lists,['aliases']));}
    else if(a==='projects.archive'||a==='projects.restore')p.project_id=intent.id;
    else if(a==='devices.register')Object.assign(p,{label:fd.get('label'),agent_id:fd.get('agent_id'),device_id:fd.get('device_id'),access:fd.get('access')});
    else if(a==='devices.rotate')p.credential_id=intent.id;
    else if(a.startsWith('memory.')){Object.assign(p,{memory_id:intent.id,revision:intent.meta.revision});if(a==='memory.correct'){p.content=fd.get('content');p.topic=fd.get('topic')||null;p.memory_type=intent.meta.memory_type;}if(fd.get('reason'))p.reason=fd.get('reason');if(a==='memory.classify')p.category=fd.get('category');if(a==='memory.sensitivity')p.sensitivity=fd.get('sensitivity');}
    else if(a==='jobs.schedule')Object.assign(p,{type:fd.get('type'),timezone:fd.get('timezone'),periods:fd.get('periods')==='daily_weekly'?['daily','weekly']:[fd.get('periods')],include_open:fd.has('include_open'),schedule_enabled:fd.has('schedule_enabled'),settings_revision:intent.settings_revision});
    else if(a==='jobs.cancel'||a==='jobs.retry')p.job_id=intent.id;
    else if(a==='models.save'){
      p.kind=intent.kind;p.expected_revision=intent.revision;const sensitivity=fd.get('sensitivity');p.config={enabled:fd.has('enabled'),protocol:fd.get('protocol'),base_url:fd.get('base_url'),model:fd.get('model'),profile_revision:fd.get('profile_revision'),daily_requests:Number(fd.get('daily_requests')),output_tokens:Number(fd.get('output_tokens')),batch_size:Number(fd.get('batch_size')),sensitivities:sensitivity==='public'?['public']:sensitivity==='internal'?['public','internal']:['public','internal','sensitive'],egress_approved:fd.has('egress_approved'),query_approved:fd.has('query_approved'),native_schema:intent.kind==='organizer'?fd.has('native_schema'):true};if(intent.kind==='embedder')p.config.dimensions=Number(fd.get('dimensions'));if(fd.get('api_key'))p.api_key=fd.get('api_key');if(fd.has('remove_key'))p.remove_key=true;
    } else if(a==='models.quota'){p.kind=intent.kind;p.expected_revision=intent.revision;
      // "No limit" is sent as null. Anything but plain digits is sent as typed, so the server refuses it rather than reading 0 or null.
      for(const name of ['daily_limit','total_limit']){const raw=String(fd.get(name)??'').trim();p[name]=fd.get(`${name}_mode`)==='limit_unlimited'?null:/^\d{1,16}$/.test(raw)?Number(raw):raw;}
    } else if(a==='vector.prepare')p.budget_calls=Number(fd.get('budget_calls'));
    else if(a==='vector.schedule'&&intent.generation)Object.assign(p,{generation:intent.generation,expected_count:Number(fd.get('expected_count')),expected_digest:intent.digest});
    else if(a==='vector.activate'||a==='vector.deactivate')p.generation=intent.generation;
    else if(a==='models.test'||a==='models.disable'){p.kind=intent.kind;if(a==='models.test')p.mode='capabilities';else p.expected_revision=getData().models.find(m=>m.kind===intent.kind).revision;}
    else if(a==='oauth.revoke')p.grant_id=intent.id;
    else if(a==='devices.revoke')p.agent_instance_id=intent.id;
    else if(a==='security.password'){p.new_password=fd.get('new_password');p.password_confirm=fd.get('password_confirm');}
    else if(a==='security.totp.complete'){p.enrollment_id=intent.enrollment_id;p.new_otp=fd.get('new_otp');}
    else if(a==='security.session.revoke')p.session_id=intent.id;
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
  // Model-list discovery in the model form. Each request carries an identity: editing the address, protocol or key,
  // a newer request, saving, closing or an account change makes an older reply stale, and it is ignored.
  let discovery=0;
  const discoveryBox=()=>intent?.action==='models.save'?content.querySelector('[data-model-discovery]'):null;
  function discoveryKey(form){
    const model=getData().models?.find(m=>m.kind===intent.kind),fd=new FormData(form);let same=false;
    try{same=!!model?.config?.base_url&&new URL(String(fd.get('base_url'))).origin===new URL(model.config.base_url).origin;}catch{}
    return fd.get('api_key')?'typed':fd.has('remove_key')?'none':model?.has_key&&same?'saved':'none';
  }
  // Consent is per attempt: any change of address, protocol or key (and every new form) clears it. A superseded request
  // no longer holds the button; a click while it is still running is answered by the server as pending.
  function discoveryReset(){const box=discoveryBox();if(!box)return;discovery++;
    box.querySelector('[data-discover-choice]').replaceChildren();box.querySelector('[data-discover-status]').textContent='';
    const consent=box.querySelector('[name=discover_consent]');if(consent)consent.checked=false;
    const button=box.querySelector('[data-discover-models]');if(button)button.disabled=false;
    const form=content.querySelector('#operation-form');if(form)box.querySelector('[data-discover-key]').textContent=t({saved:'discoverKeySaved',typed:'discoverKeyTyped',none:'discoverKeyNone'}[discoveryKey(form)]);}
  function discoveryShow(box,form,r){
    const status=box.querySelector('[data-discover-status]'),choice=box.querySelector('[data-discover-choice]');choice.replaceChildren();
    if(!r.models.length){status.textContent=t('discoverEmpty');return;}
    const label=document.createElement('label'),title=document.createElement('span'),list=document.createElement('select');
    title.textContent=t('discoverPick');list.name='discovered_model';list.dataset.discoveredModel='';
    const prompt=document.createElement('option');prompt.value='';prompt.textContent=t('discoverPickPrompt');list.append(prompt);
    // Provider IDs are text, never markup or translation keys.
    for(const id of r.models){const option=document.createElement('option');option.value=id;option.textContent=id;list.append(option);}
    const typed=String(form.elements.model?.value||'');if(r.models.includes(typed))list.value=typed;
    list.addEventListener('change',()=>{if(list.value)form.elements.model.value=list.value;});
    label.append(title,list);choice.append(label);
    const parts=[`${t('discoverFound')} ${r.total}`];if(r.truncated)parts.push(`${t('discoverShowing')} ${r.count}`);if(r.dropped)parts.push(`${t('discoverDropped')} ${r.dropped}`);
    if(typed&&!r.models.includes(typed))parts.push(t('discoverKeptModel'));status.textContent=parts.join(' · ');
  }
  content.addEventListener('input',event=>{if(discoveryBox()&&['protocol','base_url','api_key','remove_key'].includes(event.target.name))discoveryReset();});
  content.addEventListener('change',event=>{if(discoveryBox()&&['protocol','remove_key'].includes(event.target.name))discoveryReset();});
  content.addEventListener('click',async event=>{
    const button=event.target.closest('[data-discover-models]'),box=discoveryBox();if(!button||!box||working)return;
    const form=content.querySelector('#operation-form'),fd=new FormData(form),status=box.querySelector('[data-discover-status]');
    if(!fd.has('discover_consent')){status.textContent=t('MODEL_DISCOVERY_CONSENT_REQUIRED');box.querySelector('[name=discover_consent]')?.focus();return;}
    const key=discoveryKey(form),p={kind:intent.kind,expected_revision:intent.revision,protocol:fd.get('protocol'),base_url:String(fd.get('base_url')||''),key_source:key,consent:true};
    if(key==='typed')p.api_key=fd.get('api_key');
    const mine=++discovery,seq=sequence;box.querySelector('[data-discover-choice]').replaceChildren();status.textContent=t('discoverRunning');button.disabled=true;
    // The consent covered this one request; another needs a new tick.
    box.querySelector('[name=discover_consent]').checked=false;
    try{const r=await mutate('models.discover',p,crypto.randomUUID());if(mine!==discovery||seq!==sequence||!isActive()||!modal.open)return;discoveryShow(box,form,r);}
    catch(e){if(mine===discovery&&seq===sequence&&isActive()&&modal.open)status.textContent=t(e.message);}
    finally{if(button.isConnected&&mine===discovery)button.disabled=false;}
  });
  modal.addEventListener('submit',async event=>{event.preventDefault();if(!intent||working)return;discovery++;const fd=new FormData(event.target),action=intent.action;const seq=sequence;working=true;
    const controls=[...event.target.querySelectorAll('button,input,select,textarea')];controls.forEach(c=>c.disabled=true);
    try{let data;if(action==='storage.export')data=await exportFile();else if(action==='storage.import')data=await importFile(fd);else{const p=payload(fd),serialized=JSON.stringify(p);if(lastPayload!==null&&lastPayload!==serialized)opId=crypto.randomUUID();lastPayload=serialized;data=await mutate(action,p,opId);}
      if(seq!==sequence||!isActive())return;event.target.reset();if(!data.login_required)await reload();
      if(seq!==sequence||!isActive())return;result(data);
    }catch(e){if(seq!==sequence||!isActive())return;const error=content.querySelector('[data-operation-error]');if(error)error.textContent=`${t(e.message)} · ${t('operationId')}: ${opId}`;}
    finally{working=false;controls.forEach(c=>c.disabled=false);}
  });
  document.addEventListener('click',event=>{const b=event.target.closest('[data-console-action]');if(b){void begin(b.dataset.consoleAction,b);return;}if(event.target.closest('[data-operation-close]')&&!working){modal.close();restoreFocus();returnFocus=null;}
    const inspection=event.target.closest('[data-inspect]');if(inspection){const keys={models:'kind',connections:'grant_id',core_connections:'credential_id',sessions:'session_id'};const key=keys[inspection.dataset.inspect];if(!key)return;const item=getData()[inspection.dataset.inspect]?.find(row=>String(row[key])===inspection.dataset.id);if(item){open('inspectDetails');inspectResult(item);}return;}
    const job=event.target.closest('[data-job-detail]');if(job){open('jobs');const seq=sequence;void api('jobs',{job_id:job.dataset.jobDetail}).then(data=>{if(seq===sequence&&modal.open&&isActive())inspectResult(data);}).catch(e=>{if(seq===sequence&&modal.open&&isActive())content.textContent=t(e.message);});}});
  modal.addEventListener('cancel',event=>{event.preventDefault();if(!working){modal.close();restoreFocus();returnFocus=null;}});
  // A save reloads the page content behind the dialog, so the trigger may be gone by now. Prefer the trigger,
  // then its re-rendered twin (same action and record), then any control for that record, then the pressed list
  // view, then the main region: keyboard focus never falls back to the document body.
  function restoreFocus(){
    const trigger=returnFocus,action=trigger?.dataset?.consoleAction,id=trigger?.dataset?.id,kind=trigger?.dataset?.kind,type=trigger?.dataset?.type,root=document.getElementById('console-root');
    // A re-rendered twin is the same action for the same record (data-id) or the same model role (data-kind).
    const twin=action&&id!==undefined?root?.querySelector(`[data-console-action="${CSS.escape(action)}"][data-id="${CSS.escape(id)}"]`)
      :action&&kind!==undefined?root?.querySelector(`[data-console-action="${CSS.escape(action)}"][data-kind="${CSS.escape(kind)}"]`)
      :action&&type!==undefined?root?.querySelector(`[data-console-action="${CSS.escape(action)}"][data-type="${CSS.escape(type)}"]`)
      :action?root?.querySelector(`[data-console-action="${CSS.escape(action)}"]:not([data-id]):not([data-kind]):not([data-type])`):null;
    const sibling=id?root?.querySelector(`[data-id="${CSS.escape(id)}"]`):null;
    const target=trigger?.isConnected?trigger:twin||sibling||root?.querySelector('[data-project-view][aria-pressed="true"]')||document.getElementById('main');
    target?.focus();
  }
  modal.addEventListener('close',()=>{if(modal.open)return;clearTimeout(lifecycleTimer);sequence++;intent=null;flow=null;opId=null;lastPayload=null;content.replaceChildren();if(returnFocus)restoreFocus();returnFocus=null;});
  return {clear(){sequence++;intent=null;flow=null;opId=null;lastPayload=null;working=false;returnFocus=null;content.replaceChildren();modal.close();}};
}

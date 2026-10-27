import {collectAuditExport} from './audit.mjs';
import {translate as t,syncAppearance} from './appearance.mjs';
import {connectionsView} from './connections.mjs';
import {agentsView} from './agents.mjs';
import {icon,revisionDifference,kindGroup,KIND_OF_GROUP} from './visuals.mjs';

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
// Refresh: the standard button, as everywhere else on the console.
const refresh=()=>`<button type="button" class="refresh-button" data-retry>${l('refresh')}</button>`;
export const canAct=(caps,action)=>Array.isArray(caps.allowed_actions)?caps.allowed_actions.includes(action):caps.enabled===true&&(/^(security|oauth)\./.test(action)||caps.writable===true);
// Coarse sign-in snapshot as stored for that session; never the browser viewing this page.
const clientKey=(s,k)=>`${k}_${/^[a-z]{1,16}$/.test(s[k])?s[k]:'unknown'}`;
const sessionClient=s=>s.client_recorded?['device','browser','os'].map(k=>l(clientKey(s,k))).join(' · '):l('clientNotRecorded');
const inspect=(collection,id)=>`<button type="button" class="quiet" data-inspect="${collection}" data-id="${esc(id)}">${l('inspectDetails')}</button>`;
const pager=data=>`<div class="pagination">${data.offset?`<button type="button" data-offset="${Math.max(0,data.offset-(data.limit||25))}">${l('previous')}</button>`:''}${data.next_offset!=null?`<button type="button" data-offset="${data.next_offset}">${l('next')}</button>`:''}</div>`;
const progress=(done,total)=>{const n=Number(done)||0,m=Number(total)||0,w=m>0?Math.min(100,Math.round(n/m*100)):0;return `<span class="progress"><svg viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="track" width="100" height="4" rx="2"/><rect class="fill" width="${w}" height="4" rx="2"/></svg><span>${n} / ${m}</span></span>`;};

const ownerLabels={processing:'后台整理',summary:'摘要',traits:'补全关键词',vector_build:'手动构建向量索引',vector_search:'语义检索',vector_catch_up:'新记忆自动进语义索引',memory:'记忆功能',handoff:'任务接续',capture:'从事件提取记忆',conversation:'从对话提取',cloud_write:'ChatGPT 保存和修正记忆',cloud_submitted_grants:'ChatGPT 写入后自己可读',connections:'在控制台管理连接'};
const ownerActions=['features.save','schedule.save','processing.preview','processing.start','processing.pause','processing.resume','processing.cancel','processing.delete','processing.clear'];
const ownerButton=(action,label,data={})=>`<button type="button" data-console-action="${esc(action)}" ${Object.entries(data).map(([k,v])=>`data-${k}="${esc(v)}"`).join(' ')}>${esc(label)}</button>`;
// Owner pages (single-owner deployments). The switches, background processing, the default retrieval mode and the
// ChatGPT read policy each have their own page; every change still goes through features.save with re-authentication.
const BLOCKERS={FEATURE_DISABLED:'开关已关闭',PROCESSING_PAUSED:'需要先打开“后台整理”',NOT_CONFIGURED:'模型未配置',EGRESS_DENIED:'尚未同意模型外发',QUERY_EGRESS_DENIED:'尚未同意查询外发',
  VECTOR_DISABLED:'向量库未配置',VECTOR_NOT_READY:'语义索引尚未就绪',MEMORY_DISABLED:'需要先打开“记忆业务”',CONVERSATION_NOT_CONFIGURED:'未配置会话提取范围',CLOUD_WRITE_NOT_CONFIGURED:'未配置 Cloud 写入',PROBE_REQUIRED:'模型测试未通过'};
const blockerText=code=>BLOCKERS[code]||t(code);
const tone=(text,kind='')=>`<span class="tag" data-tone="${esc(kind)}">${esc(text)}</span>`;
// Requested state and whether it is in effect; an enabled switch with blockers is "not in effect" with the reasons.
function flagState(o,key){const e=o.effective?.[key]||{},reasons=(e.blockers||[]).filter(c=>c!=='FEATURE_DISABLED');
  // Tags name a state (已开启 / 已关闭 / 未生效), never a verb that could be mistaken for the 开启 / 关闭 buttons beside them.
  return !o.flags[key]?{label:'已关闭',kind:'',reasons:[]}:e.effective?{label:'已开启',kind:'good',reasons:[]}:{label:'未生效',kind:'warn',reasons};}
const catchUpDetail=c=>c?`待索引 ${c.pending??'未知'} 条${c.error_code?` · 上次失败：${t(c.error_code)}`:''}`:'';
const ownerUnavailable='<p role="alert">功能状态暂时不可用，请重试。</p>';
// One switch edit opens a form with just these flags; the rest are sent back unchanged. A button that says what it
// does (开启 / 关闭 / 暂停) carries its target state, so the form is pre-set to that change instead of the current state.
const flagButton=(label,flags,target)=>ownerButton('features.save',label,{section:'flags',flags:flags.join(','),...(target?{target}:{})});
const switchRows=(o,keys,purpose={})=>`<ul class="flag-list">${keys.map(key=>{const f=flagState(o,key);
  return `<li data-flag="${esc(key)}"><div><strong>${esc(ownerLabels[key])}</strong>${purpose[key]?`<p class="muted">${esc(purpose[key])}</p>`:''}${f.reasons.length?`<p class="flag-blocked">${esc(f.reasons.map(blockerText).join(' / '))}</p>`:''}</div>${tone(f.label,f.kind)}</li>`;}).join('')}</ul>`;
const RUN_KINDS={summary:'摘要',traits:'补全关键词',vector:'语义索引',entities:'实体提取（已停用）',classification:'自动分类（已停用）'};
const runKind=k=>RUN_KINDS[k]||ownerLabels[k]||k;
// What a startable preview holds: its memories by title (first 100), folded so the run list stays short.
const runItems=(r,open=false)=>r.items?.length?`<details class="run-items"${open?' open':''}><summary>查看清单（${esc(r.count)} 条）</summary><ol>${r.items.map(i=>`<li>${esc(i.title)}</li>`).join('')}</ol>${r.count>r.items.length?`<p class="muted">只列出前 ${esc(r.items.length)} 条。</p>`:''}</details>`:'';
const clock=ms=>{const d=new Date(ms);return Number.isFinite(d.getTime())?d.toLocaleString(document.documentElement.lang||'zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—';};
const RUN_STATES={expired:'已过期',preview:'待确认',queued:'排队中',running:'运行中',paused:'已暂停',blocked:'受阻',completed:'已完成',cancelled:'已取消'};
// Processing capabilities. Each card: one switch (with the flags it owns), what it needs (checked against the owner
// view's blockers and the model list), what it is doing, and processing of existing memories.
const CAPABILITIES=[
  {key:'vector_catch_up',flags:['vector_search','vector_catch_up'],title:'语义检索',purpose:'新记忆和修正自动进入语义索引，搜索时按意思找。',model:'embedder'},
  {key:'summary',flags:['summary'],title:'摘要',purpose:'按项目、任务或会话，每天和每周各生成一份摘要，只摘录原记忆里的原话。',model:'organizer',run:'summary'},
  {key:'traits',flags:['traits'],title:'补全关键词',purpose:'给没有类型、关键词或重要度的记忆自动补上，直接写入，不用逐条确认；写入方已经填的不会被覆盖，可以在修订记忆时改。',model:'organizer',run:'traits'}];
const NEED_TEXT={NOT_CONFIGURED:['模型未配置','/app/models'],EGRESS_DENIED:['尚未同意发送记忆给模型','/app/models'],QUERY_EGRESS_DENIED:['尚未同意发送查询给模型','/app/models'],
  PROBE_REQUIRED:['模型测试未通过','/app/models'],VECTOR_DISABLED:['向量库未配置','/app/health'],VECTOR_NOT_READY:['还没有可用的语义索引','/app/health'],
  PROCESSING_PAUSED:['后台整理已暂停','#processing-master'],MEMORY_DISABLED:['记忆功能已关闭','#processing-other']};
function needsList(o,cap,models){const m=models?.find(x=>x.kind===cap.model),blockers=[...new Set(cap.flags.flatMap(k=>o.effective?.[k]?.blockers||[]))].filter(c=>c!=='FEATURE_DISABLED');
  const items=[];const has=code=>blockers.includes(code);
  const model=m?.config?.enabled?`${cap.model==='embedder'?'嵌入模型':'整理模型'} ${m.config.model||''}${m.verification?.state==='verified'?' · 测试通过':''}`:'';
  if(!has('NOT_CONFIGURED')&&!has('PROBE_REQUIRED')&&model)items.push([true,model]);
  if(!has('EGRESS_DENIED')&&!has('QUERY_EGRESS_DENIED')&&m?.config?.enabled)items.push([true,'已同意发送给模型']);
  if(!blockers.some(c=>/BUDGET_EXHAUSTED/.test(c))&&m?.config?.enabled)items.push([true,'调用额度未用完']);
  if(cap.model==='embedder'&&!has('VECTOR_DISABLED')&&!has('VECTOR_NOT_READY'))items.push([true,'向量库和语义索引可用']);
  for(const code of blockers){const [text,href]=NEED_TEXT[code]||[blockerText(code),'/app/models'];items.push([false,text,href]);}
  return `<ul class="needs">${items.map(([ok,text,href])=>`<li class="${ok?'ok':'no'}">${esc(text)}${!ok&&href?` <a href="${esc(href)}">去设置</a>`:''}</li>`).join('')}</ul>`;}
function capabilityCard(o,cap,models){const f=flagState(o,cap.key),runs=(o.runs||[]).filter(r=>r.kind===(cap.run||'vector')&&r.state!=='preview'),last=runs[0];
  const status=cap.model==='embedder'?[['语义索引',o.flags.vector_catch_up?catchUpDetail(o.vector_catch_up)||'—':'新记忆不会进入索引'],['默认检索',RETRIEVAL_MODES[o.preferences?.retrieval_mode]||'—']]
    :[['新记忆',o.flags[cap.key]&&o.schedule?.enabled&&o.schedule.kinds?.includes(cap.run)?`自动处理（每 ${o.schedule.interval_minutes} 分钟，每轮最多 ${o.schedule.max_items} 条）`:'不会自动处理'],['最近一次',last?`${RUN_STATES[last.state]||last.state} · ${last.count} 条 · 调用 ${last.used}/${last.budget}`:'还没有运行过']];
  // The automatic rule leaves no run when there is nothing to do, so the card says when it last looked and what it found.
  const auto=o.flags[cap.key]&&o.schedule?.enabled&&o.schedule.kinds?.includes(cap.run),check=o.schedule?.checks?.[cap.run];
  if(cap.model!=='embedder'&&auto)status.push(['自动检查',check?`${clock(check.at)} · ${check.found?`处理了 ${check.found} 条新记忆`:'没有需要处理的新记忆'}`:`等待第一次检查（${o.schedule.next_at?clock(o.schedule.next_at)+' 前后':'最晚 '+o.schedule.interval_minutes+' 分钟内'}）`]);
  const index=o.vector_index||{},built=cap.model==='embedder'?(o.runs||[]).find(r=>r.kind==='vector'&&r.state==='completed'&&r.generation&&r.generation!==index.serving_generation):null;
  if(cap.model==='embedder')status.push(['重建索引',built?'新索引已建好，等待启用':index.spare_collections?'可以重建':'需要先在 Qdrant 预建一个空集合（见健康页）']);
  const actions=[flagButton(o.flags[cap.key]?'关闭':'开启',cap.flags,o.flags[cap.key]?'off':'on'),...(cap.model==='embedder'?[ownerButton('features.save','修改检索模式',{section:'retrieval'}),
    ...(built?[actionButton('vector.activate','activateIndex',{generation:built.generation})]:index.spare_collections?[ownerButton('processing.preview','重建索引',{kind:'vector'})]:[])]
    :[ownerButton('processing.preview',cap.run==='traits'?'补全历史记忆':'补处理历史记忆',{kind:cap.run})])];
  return `<section class="card capability" id="cap-${esc(cap.key)}" data-capability="${esc(cap.key)}"><header class="section-head"><div><h2>${esc(cap.title)}</h2><p class="muted">${esc(cap.purpose)}</p></div>${tone(f.label,f.kind)}</header>
    <div class="capability-body"><div><h3 class="capability-label">需要</h3>${needsList(o,cap,models)}</div><div><h3 class="capability-label">状态</h3><dl class="metadata-grid">${status.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div></div>
    <div class="actions">${actions.join('')}</div></section>`;}
// Host records for model requests (server console/hosts.mjs): a model hostname pointed at a fixed address, e.g. a relay
// on the local network. Model requests use the record instead of DNS.
function hostsCard(hosts,can,system=[],apply=null){if(!hosts)return '';
  const row=(h,source,time)=>`<tr data-host="${esc(h.hostname)}"><td><code>${esc(h.hostname)}</code></td><td><code>${esc(h.address)}</code></td><td><span class="tag">${source}</span></td><td>${time}</td>
    <td>${buttons([...(can('hosts.set')?[actionButton('hosts.set','hostEdit',{id:h.hostname})]:[]),...(can('hosts.remove')?[actionButton('hosts.remove','hostRemove',{id:h.hostname})]:[])])}</td></tr>`;
  // Records (Mnemuron's block in /etc/hosts) first, then the server's other lines; editing one of those takes it over.
  const all=[...hosts.map(h=>row(h,'Mnemuron',esc(clock(Date.parse(h.updated_at))))),...system.map(h=>row(h,l('hostSourceSystem'),'—'))];
  const rows=all.length?`<div class="table-scroll"><table class="hosts-table"><thead><tr><th>域名</th><th>解析到</th><th>来源</th><th>修改时间</th><th>操作</th></tr></thead><tbody>${all.join('')}</tbody></table></div>`:`<p class="muted">还没有解析记录，按正常 DNS 解析。</p>`;
  const status=!apply?.writes_file||!apply.revision?'':apply.pending?tone('正在写入 /etc/hosts',''):apply.state==='failed'?tone(`写入 /etc/hosts 失败 ${apply.error||''}`,'bad'):tone('已写入 /etc/hosts','good');
  return `<section class="card" id="model-hosts"><header class="section-head"><h2>${l('hostsTitle')}</h2>${status}${can('hosts.set')?actionButton('hosts.set','hostAdd'):''}</header><p class="muted">${l('hostsNote')}</p>${rows}</section>`;
}
// Job queue by batch (server memory-jobs batches): one row per planned round with its overall progress in percent;
// cancelling a batch cancels its unfinished jobs.
const BATCH_STATE=b=>b.running?'leased':b.waiting?'pending':b.failed?'dead_letter':b.succeeded===b.jobs?'succeeded':b.cancelled===b.jobs?'cancelled':'succeeded';
function batchTable(batches,can){
  return table(batches,['scope','state','progress','batchIssues','actions'],b=>{const done=b.succeeded+b.cancelled+b.failed,pct=b.jobs?Math.round(b.succeeded/b.jobs*100):0,s=BATCH_STATE(b);
    const parts=[b.running&&`${b.running} 个进行中`,b.waiting&&`${b.waiting} 个等待`,b.succeeded&&`${b.succeeded} 个完成`,b.failed&&`${b.failed} 个失败`,b.cancelled&&`${b.cancelled} 个已取消`].filter(Boolean).join(' · ');
    return `<tr data-batch="${esc(b.batch_id)}"><td><button type="button" class="link-button batch-toggle" data-batch-toggle="${esc(b.batch_id)}" aria-expanded="false"><span class="batch-caret" aria-hidden="true">▸</span>${esc(t(b.job_type))}</button><small>${esc(new Date(b.created_at).toLocaleString('zh-CN'))} · 共 ${esc(b.jobs)} 个</small></td>
      <td><span class="state-dot" data-state="${esc(s)}">${l('jobState_'+s)}</span><small>${esc(parts)}</small></td>
      <td><span class="progress batch-progress"><svg viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false"><rect class="track" width="100" height="4" rx="2"/><rect class="fill" width="${pct}" height="4" rx="2"/></svg><span>${pct}%</span></span></td>
      <td>${b.error_codes.length?b.error_codes.map(c=>`<span class="job-error">${esc(t(c))}</span>`).join(' '):'—'}</td>
      <td>${done<b.jobs&&can('jobs.cancel_batch')?buttons([actionButton('jobs.cancel_batch','cancelBatch',{id:b.batch_id})]):'—'}</td></tr>`;});
}
// A batch's jobs, one page (BATCH_PAGE) at a time, shown under its row: what each covers (project/task and day), state,
// progress and error; a job opens its detail. The footer says which page of how many.
export const BATCH_PAGE=10;
const PERIOD={daily:'每日',weekly:'每周'};
const jobScope=j=>{const s=j.scope||{},w=j.window;const where=s.kind==='project'?`项目 ${s.project_name||s.project_id||''}`:s.kind==='task'?`任务 ${s.task_title||s.task_id||''}`:s.kind==='workstream'?`工作流 ${s.workstream_name||s.workstream_id||''}`:s.kind==='session'?'会话':s.kind==='user'?'全部记忆':'—';
  return `${where}${w?.local_start?` · ${w.local_start}${PERIOD[w.period]?`（${PERIOD[w.period]}）`:''}`:''}`;};
export function batchJobsView(d){
  const pages=Math.max(1,Math.ceil(d.total/(d.limit||BATCH_PAGE))),current=Math.floor(d.offset/(d.limit||BATCH_PAGE))+1;
  const rows=d.jobs.map(j=>`<tr><td><button type="button" class="link-button" data-job-detail="${esc(j.job_id)}">${esc(jobScope(j))}</button></td><td><span class="state-dot" data-state="${esc(j.state)}">${l('jobState_'+j.state)}</span></td>
    <td>${progress(j.processed,j.total)}</td><td>${j.last_error_code?`<span class="job-error">${esc(t(j.last_error_code))}</span>`:'—'}</td><td>${esc(clock(j.updated_at))}</td></tr>`).join('');
  return `<table class="batch-jobs"><thead><tr><th>内容</th><th>状态</th><th>进度</th><th>问题</th><th>更新</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="pagination batch-pager"><span class="muted">第 ${current} / ${pages} 页 · 共 ${esc(d.total)} 个</span>${d.offset>0?`<button type="button" data-batch-page="${Math.max(0,d.offset-(d.limit||BATCH_PAGE))}">${l('previous')}</button>`:''}${d.next_offset!=null?`<button type="button" data-batch-page="${d.next_offset}">${l('next')}</button>`:''}</div>`;
}
const RUN_PURPOSE={summary:'把选中的历史记忆按项目和日期分组，生成摘要',traits:'为记忆补全类型、关键词和重要度',vector:'把全部活动记忆重新嵌入一个新的语义索引'};
const span=(a,b)=>{const m=Math.max(0,Math.round((b-a)/60000));return m<1?'不到 1 分钟':m<60?`${m} 分钟`:`${Math.floor(m/60)} 小时 ${m%60} 分钟`;};
// What a run did and when: purpose, start and end (or how long it has been going), memories, jobs, model calls and model.
function runFacts(r){
  const end=r.finished_at?esc(clock(r.finished_at)):['running','queued'].includes(r.state)?'进行中':r.state==='paused'?'已暂停':'—';
  const facts=[['开始',r.started_at?esc(clock(r.started_at)):'—'],['结束',end],['用时',r.started_at?esc(span(r.started_at,r.finished_at||Date.now())):'—'],
    ['记忆',`${esc(r.count)} 条${r.excluded?`（排除 ${esc(r.excluded)} 条）`:''}`],...(r.jobs?[['任务',`${esc(r.jobs)} 个，完成 ${esc(r.jobs_done)} 个${r.jobs_failed?`，失败 ${esc(r.jobs_failed)} 个`:''}`]]:[]),
    ['模型调用',`${esc(r.used)} / ${esc(r.budget)} 次`],['模型',esc(r.model||'—')],...(r.generation?[['索引',`第 ${esc(r.generation)} 代`]]:[])];
  return `<p class="muted">${esc(RUN_PURPOSE[r.kind]||'')}</p><dl class="run-facts">${facts.map(([k,v])=>`<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
}
// Run history, last on the processing page. Finished runs (completed, cancelled, expired previews) can be deleted one by
// one or all at once; what they wrote stays.
const runFinished=r=>r.expired||['completed','cancelled'].includes(r.state);
function runsCard(o){if(!o)return '';
  // Previews are an internal step of the one-step confirmation, and entity/classification runs belong to retired features.
  const shown=(o.runs||[]).filter(r=>r.state!=='preview'&&['summary','traits','vector'].includes(r.kind));
  const runs=shown.length?shown.map(r=>`<article class="policy-box run-row" data-run-state="${r.expired?'expired':esc(r.state)}"><strong>${esc(runKind(r.kind))}</strong> · ${esc(RUN_STATES[r.expired?'expired':r.state]||r.state)}${runFacts(r)}${r.error_code?`<p role="status">${esc(t(r.error_code))}</p>`:''}${runItems(r)}<details class="tech-details"><summary>技术信息</summary><code class="owner-digest">${esc(r.manifest_digest)}</code></details>${r.expired?'<p class="muted">预览只在 15 分钟内有效，过期后需要重新预览。</p>':''}<div class="actions">${r.state==='preview'&&!r.expired?ownerButton('processing.start','确认并开始',{id:r.run_id}):''}${r.expired&&['summary','traits','vector'].includes(r.kind)?ownerButton('processing.preview','重新预览',{kind:r.kind}):''}${['running','queued'].includes(r.state)?ownerButton('processing.pause','暂停',{id:r.run_id}):''}${['paused','blocked'].includes(r.state)?ownerButton('processing.resume','确认恢复',{id:r.run_id}):''}${!['completed','cancelled'].includes(r.state)&&!r.expired?ownerButton('processing.cancel','取消',{id:r.run_id}):''}${runFinished(r)?ownerButton('processing.delete','删除',{id:r.run_id}):''}</div></article>`).join(''):'<p class="muted">还没有运行记录。</p>';
  return `<section class="card" id="processing-runs"><header class="section-head"><h2>运行记录</h2>${shown.some(runFinished)?ownerButton('processing.clear','清空已结束的记录'):''}</header>${runs}</section>`;
}
function processingPage(o,models){if(!o)return ownerUnavailable;
  return `<section class="card" id="processing-master"><header class="section-head"><div><h2>后台整理</h2><p class="muted">总开关。关闭后下面三项都暂停；修改需要输入密码确认，任何修改都会暂停正在运行的批次。</p></div>${tone(o.flags.processing?'已开启':'已暂停',o.flags.processing?'good':'warn')}</header><div class="actions">${flagButton(o.flags.processing?'暂停':'开启','processing'.split(','),o.flags.processing?'off':'on')}</div></section>
    ${CAPABILITIES.map(cap=>capabilityCard(o,cap,models)).join('')}
    <section class="card" id="processing-pacing" data-pacing><header class="section-head"><h2>自动处理节奏</h2>${tone(o.schedule.enabled?'已开启':o.schedule.error_code?'已暂停':'未开启',o.schedule.enabled?'good':o.schedule.error_code?'warn':'')}</header><p class="muted">打开上面的摘要或补全关键词后，新记忆按这个节奏自动处理：每 ${esc(o.schedule.interval_minutes)} 分钟一轮，每轮最多 ${esc(o.schedule.max_items)} 条、${esc(o.schedule.budget)} 次调用。${o.schedule.error_code?`暂停原因：${esc(t(o.schedule.error_code))}；重新保存对应开关即可恢复。`:''}</p><div class="actions">${ownerButton('schedule.save','修改节奏')}</div></section>
    <section class="card" id="processing-other"><header class="section-head"><h2>其他开关</h2></header>${switchRows(o,['memory','vector_build'],{memory:'关闭后不能保存、修正和撤回任何记忆',vector_build:'通过手动批次构建一个新的语义索引（日常用不到，新记忆由“语义检索”自动加入）'})}<div class="actions">${flagButton('修改',['memory','vector_build'])}</div></section>`;
}
const RETRIEVAL_MODES={lexical:'关键词',hybrid:'混合（关键词 + 语义）',semantic:'仅语义'};
function retrievalCard(o){if(!o)return '';const mode=o.preferences?.retrieval_mode;
  return `<section class="card" data-retrieval-mode="${esc(mode)}"><header class="section-head"><h2>默认检索模式</h2>${tone(RETRIEVAL_MODES[mode]||mode||'—',mode==='lexical'?'':'good')}</header><p class="muted">控制台、ChatGPT 和其他助手在没有指定检索方式时都用这个模式。混合检索同时用关键词和语义，嵌入模型不可用时自动退回关键词。</p><div class="actions">${ownerButton('features.save','修改检索模式',{section:'retrieval'})}</div></section>`;}
function readPolicyCard(o){if(!o)return '';const current=o.preferences?.read_policy,names={chatgpt_per_memory_v1:'逐条授权',active_uniform_v1:'全部活动记忆'};
  return `<section class="card" data-read-policy="${esc(current)}"><header class="section-head"><h2>ChatGPT 读取策略</h2>${tone(names[current]||current||'—')}</header><p class="muted">${(o.read_policy_options||[]).map(x=>`${esc(names[x.value]||x.value)}：当前可读 ${esc(x.active_readable)} 条活动记忆`).join('；')}。不会扩大连接本身的权限，生命周期边界始终保留。</p><div class="actions">${ownerButton('features.save','修改读取策略',{section:'read_policy'})}</div></section>`;}
// Connections: every connection (ChatGPT, coding assistants, other apps) in one list, then what ChatGPT may read and
// write and what is taken from coding assistants (owner mode). Other deployments show the list only.
// Connections: the agent page (agents.mjs): every connection, then per-agent setup. Each agent's own rules sit in its
// panel's settings: ChatGPT's read and write rules, the capture switches for agents that upload activity.
function connectionsPage(data,caps,q,o){
  const capture=o?agentCards(data,o):'';
  return agentsView(data,caps,o?{chatgpt:chatgptCards(data,o),'codex:plugin':capture,openclaw:capture,hermes:capture}:{},q)+(o?tunnelCards(data.features?.tunnel,caps):'');}
// Public access through Cloudflare Tunnels (server tunnel/settings.mjs): one card per tunnel with its connection, token
// fingerprint and apply state. The main tunnel cannot be removed; every change asks for the password and an authenticator code.
const TUNNEL_STATES={pending:'等待应用',applied:'已生效',rolled_back:'未连上，已恢复原令牌',failed:'应用失败'};
const TUNNEL_SOURCE={web:'网页',server:'服务器（命令行或安装时配置）'};
const tunnelSource=by=>!by?'—':TUNNEL_SOURCE[by]||(by.startsWith('cli:')?`命令行（${by.slice(4)}）`:by);
// One tunnel as a panel inside the public entry card: name, connection state and its service in the head; the
// details in two columns; its actions at the foot.
function tunnelCard(d,can){
  const c=d.connection||{},time=v=>v?esc(new Date(v).toLocaleString('zh-CN')):'',removeFailed=d.state==='removing'&&d.apply_state==='failed';
  const conn=d.state==='removing'?tone(removeFailed?'删除失败，可重试':'正在删除',removeFailed?'bad':'warn'):!c.reachable?tone('读不到 cloudflared','bad'):c.ready?tone(`已连接 · ${c.connections??'—'} 条线路`,'good'):tone('未连接','bad');
  const facts=[['连接器令牌',d.configured?`<code>${esc(d.token_fingerprint)}</code> <small class="muted">${esc(tunnelSource(d.updated_by))}</small>`:'<span class="muted">还没有读到服务器上的令牌</span>'],
    ['Tunnel ID',d.tunnel_id?`<code>${esc(d.tunnel_id)}</code>`:'—'],['账户 ID',d.account_id?`<code>${esc(d.account_id)}</code>`:'—'],
    ['路由配置',c.config_version!=null?`v${esc(c.config_version)}`:'—'],
    ['应用状态',d.apply_state?`${esc(TUNNEL_STATES[d.apply_state]||d.apply_state)}${d.apply_error?` <code>${esc(d.apply_error)}</code>`:''}${d.applied_at?` · ${time(d.applied_at)}`:''}`:'—'],
    ['最近修改',d.updated_by?`${esc(tunnelSource(d.updated_by))} · ${time(d.updated_at)}`:'—']];
  const buttons=d.state==='removing'?(removeFailed&&!d.main&&can('tunnel.remove')?[actionButton('tunnel.remove','tunnelRemove',{id:d.id})]:[]):[can('tunnel.token')?actionButton('tunnel.token','tunnelSetToken',{id:d.id}):'',d.configured&&can('tunnel.reapply')?actionButton('tunnel.reapply','tunnelReapply',{id:d.id}):'',
    !d.main&&can('tunnel.remove')?actionButton('tunnel.remove','tunnelRemove',{id:d.id}):''].filter(Boolean);
  return `<article class="tunnel-item" data-tunnel="${esc(d.id)}"><header><div><h3>${esc(d.name)}</h3><small class="muted"><code>${esc(d.unit)}</code> · 指标端口 ${esc(d.metrics_port)}</small></div>${conn}</header>
    <dl class="tunnel-facts">${facts.map(([k,v])=>`<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>${buttons.length?`<div class="actions">${buttons.join('')}</div>`:''}</article>`;
}
// Public entry: one card like the other sections, its add button in the card head and one panel per tunnel.
function tunnelCards(d,caps){
  const can=a=>caps.allowed_actions?.includes(a);
  const body=!d?.tunnels?'<p class="muted">暂时读不到 Tunnel 状态。</p>':`<div class="tunnel-list">${d.tunnels.map(x=>tunnelCard(x,can)).join('')}</div>`;
  return `<section class="card" id="tunnels"><header class="section-head"><h2>公网入口</h2>${d?.tunnels&&can('tunnel.add')?actionButton('tunnel.add','tunnelAdd'):''}</header>${body}</section>`;
}
// Configuration changes from the console and the CLI (server config/center.mjs), newest first.
const CONFIG_SOURCE={web:'网页',cli:'命令行'};
const configValue=v=>v===null||v===undefined?'—':typeof v==='boolean'?(v?'开':'关'):typeof v==='object'?esc(JSON.stringify(v)):esc(String(v));
// Configuration changes (server config/center.mjs) on the audit page: web and CLI edits to the same settings, newest first.
export function configHistoryCard(d){
  if(!d)return '';
  return `<section class="card" data-config-history><header class="section-head"><h2>配置变更</h2><button type="button" class="refresh-button" data-retry>${l('refresh')}</button></header>
    <p class="muted">网页和命令行（mnemuron-config）对配置的修改，按时间倒序。</p>
    ${(d.history||[]).length?`<div class="table-scroll"><table><thead><tr><th>时间</th><th>来源</th><th>配置项</th><th>修改</th></tr></thead><tbody>${d.history.map(h=>`<tr><td>${esc(new Date(h.at).toLocaleString('zh-CN'))}</td>
      <td><span class="tag" data-source="${esc(h.source)}">${esc(CONFIG_SOURCE[h.source]||h.source)}</span>${h.actor&&h.actor!=='console'?` <small><code>${esc(h.actor)}</code></small>`:''}</td><td><code>${esc(h.key)}</code></td><td>${configValue(h.old)} → ${configValue(h.new)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">还没有配置变更。</p>'}</section>`;
}
function chatgptCards(data,o){
  return (o?`<div class="card-grid">${readPolicyCard(o)}<section class="card" data-chatgpt-write><header class="section-head"><h2>能写什么</h2></header>${switchRows(o,['cloud_write','cloud_submitted_grants','connections'],
    {cloud_write:'ChatGPT 可以新建和修正记忆',cloud_submitted_grants:'它保存的记忆，之后它自己能读到',connections:'允许在控制台新建、停用和轮换连接'})}<div class="actions">${flagButton('修改',['cloud_write','cloud_submitted_grants','connections'])}</div></section></div>`:'')+
    `${activityLine(data.features?.attention?.activity_7d,'chatgpt','写入')}<p class="section-foot"><a href="/app/audit?group=memory">查看 ChatGPT 的读写记录 →</a></p>`;}
// Coding assistants: what they upload and the capture switches (owner mode).
function agentCards(data,o){
  return activityLine(data.features?.attention?.activity_7d,'agents','提取')+(o?`<section class="card" data-agent-switches><header class="section-head"><h2>从助手那里收什么</h2></header>${switchRows(o,['capture','conversation','handoff'],
    {capture:'助手上传的事件里，用户明确说明的事实会变成记忆',conversation:'对话里“请记住……”这类话会保存',handoff:'自动生成检查点和交接包，换设备或换助手继续'})}<p class="muted">原始事件保留 30 天；上传时会去掉密钥。</p><div class="actions">${flagButton('修改',['capture','conversation','handoff'])}</div></section>`:'');}
// Health: every check states its result and, when something is wrong, what to do. Unknown parts say so.
const HEALTH_FIX={VECTOR_AUTH_FAILED:'向量库拒绝了密钥：在 PVE 上重新签发 Qdrant 密钥（无需重启）。',VECTOR_COLLECTION_MISSING:'向量库里缺少预建的集合：检查 Qdrant 集合名称。',
  BUDGET_EXHAUSTED:'调用额度已用完：在“模型与额度”里调高额度。',NOT_CONFIGURED:'嵌入模型未配置或已停用：在“模型与额度”里配置。',NETWORK_ERROR:'连不上模型服务：检查服务地址和网络。'};
// Each check says where it is fixed (href): the page and section holding that setting.
const GO={models:'/app/models',hosts:'/app/models#model-hosts',processing:'/app/processing#processing-master',pacing:'/app/processing#processing-pacing',
  summary:'/app/processing#cap-summary',traits:'/app/processing#cap-traits',vector:'/app/processing#cap-vector_catch_up',runs:'/app/processing#processing-runs',
  library:'/app/memories',tunnel:'/app/connections#tunnels',audit:'/app/audit?group=system'};
export function healthChecks(f={}){const h=f['system-health'],v=f['system-version'],m=f.models,o=h?.owner,checks=[];
  const add=(level,title,detail,fix='',href='',hint='')=>checks.push({level,title,detail,fix,href,hint});
  if(!h)add('unknown','服务状态','暂时读不到服务状态','稍后点“重新检查”');
  else{add(h.services?.core==='ready'?'ok':'bad','核心服务',h.services?.core==='ready'?'正在运行，数据库可读':'数据库不可读','检查 mnemuron 服务和数据库文件',GO.audit);
    add(h.services?.search==='ready'?'ok':'warn','关键词索引',h.services?.search==='ready'?'已就绪':`状态：${h.services?.search||'未知'}`,'索引会在后台自动重建',GO.library);}
  if(v)add('ok','数据库',`结构版本 ${v.schema_version} · Node ${v.node}`);
  // Models: configured, tested and within their call limits.
  // The organizer is only needed while summaries or keyword filling are on; the embedder always (semantic search).
  const model=(kind,name,need,needed=true)=>{const x=m?.models?.find(y=>y.kind===kind),probe=x?.verification;
    if(!m)return needed?add('unknown',name,'暂时读不到模型状态','',GO.models):undefined;
    if(!x?.config?.enabled)return add(needed?'warn':'ok',name,needed?`未启用：${need}不可用`:`未配置（${need}会用到）`,needed?'在“模型与额度”里配置':'',GO.models);
    add(probe?.state==='verified'?'ok':'warn',name,`${x.config.model||''} · ${probe?.state==='verified'?'最近一次测试通过':'尚未通过测试'}`,probe?.state==='verified'?'':'在“模型与额度”里点“测试实际能力”',GO.models);};
  model('organizer','整理模型','摘要和补全关键词',o?.flags?.summary===true||o?.flags?.traits===true);model('embedder','嵌入模型','语义检索');
  if(o){const c=o.vector_catch_up||{},on=o.flags?.vector_catch_up===true,serving=!(o.effective?.vector_search?.blockers||[]).includes('VECTOR_NOT_READY');
    const blockers=Object.values(o.effective||{}).flatMap(e=>e?.blockers||[]),exhausted=[...new Set(blockers.filter(x=>/BUDGET_EXHAUSTED/.test(x)))];
    add(exhausted.length?'bad':'ok','调用额度',exhausted.length?exhausted.map(blockerText).join(' / '):'整理和嵌入模型的额度都还有余量',exhausted.length?HEALTH_FIX.BUDGET_EXHAUSTED:'',GO.models);
    add(o.flags?.processing?'ok':'warn','后台整理',o.flags?.processing?'已开启':'已暂停：语义索引、摘要和补全关键词都不会运行',o.flags?.processing?'':'在“整理能力”页打开“后台整理”',GO.processing);
    // Capabilities: on and able to run, or why not.
    const cap=(flag,name,href)=>{const e=o.effective?.[flag];if(!o.flags?.[flag])return add('ok',name,'未开启（按需打开）','',href);
      add(e?.effective?'ok':'warn',name,e?.effective?'已开启，正常运行':`已开启但不能运行：${(e?.blockers||[]).map(blockerText).join(' / ')||'原因未知'}`,e?.effective?'':'打开对应卡片查看缺少什么',href);};
    cap('summary','摘要',GO.summary);cap('traits','补全关键词',GO.traits);
    if(!serving)add('warn','语义索引','还没有可用的语义索引','在“整理能力”的语义检索卡片里重建索引并启用',GO.vector);
    else if(c.error_code)add('bad','语义索引',`增量索引失败：${t(c.error_code)}`,HEALTH_FIX[c.error_code]||'查看“整理能力”页的语义检索卡片',GO.vector);
    else if(!on)add('warn','语义索引','增量索引未开启：新记忆不会进入语义索引','在“整理能力”页打开“后台整理”和“语义检索”',GO.vector);
    else add(c.pending?'warn':'ok','语义索引',c.pending?`待索引 ${c.pending} 条，正在补齐`:'所有活动记忆都已索引','',GO.vector);
    const spare=o.vector_index?.spare_collections;
    if(spare!==null&&spare!==undefined)add('ok','重建语义索引',spare?`有 ${spare} 个备用集合，可以重建`:'没有备用集合（日常用不到）','',GO.vector,'需要重建时先在 Qdrant 预建一个空集合，加入运行配置的 precreated_collections，并让向量库密钥能访问它');
    const s=o.schedule||{};
    add(s.error_code?'warn':'ok','自动处理节奏',s.error_code?`已暂停：${t(s.error_code)}`:s.enabled?`每 ${s.interval_minutes} 分钟一轮，每轮最多 ${s.max_items} 条`:'未开启：新记忆不会自动摘要或补全关键词',s.error_code?'重新保存对应开关即可恢复':'',GO.pacing);}
  const failed=f.attention?.counts?.failed_jobs;
  if(Number.isFinite(failed))add(failed?'warn':'ok','整理任务',failed?`${failed} 个任务失败`:'没有失败的任务',failed?'在“整理能力”页的任务队列里查看原因并重试':'',GO.runs);
  const tunnels=f.tunnel?.tunnels;
  if(tunnels?.length){const down=tunnels.filter(x=>x.state!=='removing'&&!x.connection?.ready),failedApply=tunnels.filter(x=>['failed','rolled_back'].includes(x.apply_state));
    add(down.length?'bad':failedApply.length?'warn':'ok','公网入口',down.length?`${down.map(x=>x.name).join('、')} 未连接`:failedApply.length?`${failedApply.map(x=>x.name).join('、')} 上次更换令牌没有生效`:`${tunnels.length} 个 Tunnel 已连接`,down.length||failedApply.length?'在“连接”页的公网入口里查看':'',GO.tunnel);}
  const ha=f.models?.hosts_apply;
  if(ha?.writes_file&&ha.revision)add(ha.state==='failed'?'bad':ha.pending?'warn':'ok','自定义解析',ha.state==='failed'?`写入 /etc/hosts 失败：${ha.error||''}`:ha.pending?'正在写入 /etc/hosts':'已写入 /etc/hosts',ha.state==='failed'?'在“模型与额度”的自定义解析里重新保存':'',GO.hosts);
  return checks;
}
const HEALTH_LEVELS={ok:['正常','good'],warn:['提醒','warn'],bad:['需要处理','bad'],unknown:['未知','']};
const HEALTH_ORDER={bad:0,warn:1,unknown:2,ok:3};
// Health groups, in page order; a check not listed falls into the first.
const HEALTH_GROUPS=[['服务',['服务状态','核心服务','关键词索引','数据库']],['模型',['整理模型','嵌入模型','调用额度','自定义解析']],
  ['自动整理',['后台整理','摘要','补全关键词','自动处理节奏','整理任务']],['语义检索',['语义索引','重建语义索引']],['连接',['公网入口']]];
// Health: problems first in their own group, then the rest by area. One compact card per check: a status dot, the
// title and a one-line state (full text on hover); problems also say how to fix. A card with a setting opens it.
function healthView(data){const checks=healthChecks(data.features||{});
  const problems=checks.filter(c=>c.level==='bad'||c.level==='warn').sort((a,b)=>HEALTH_ORDER[a.level]-HEALTH_ORDER[b.level]);
  const tile=c=>{const problem=c.level==='bad'||c.level==='warn',hint=[c.detail,c.hint].filter(Boolean).join('；');
    const body=`<span class="health-dot" data-level="${esc(c.level)}" aria-hidden="true"></span><span class="health-tile-body"><strong>${esc(c.title)}</strong><span class="health-detail" title="${esc(hint)}">${esc(c.detail)}</span>${problem&&c.fix?`<span class="health-fix">${esc(c.fix)}</span>`:''}</span>${problem?tone(...HEALTH_LEVELS[c.level]):c.level==='unknown'?tone(...HEALTH_LEVELS.unknown):''}`;
    return c.href?`<a class="health-tile" data-health="${esc(c.level)}" href="${esc(c.href)}">${body}<span class="health-go" aria-hidden="true">›</span></a>`:`<div class="health-tile" data-health="${esc(c.level)}">${body}</div>`;};
  const group=(name,list,extra='')=>list.length?`<section class="health-group${extra}"><h3>${esc(name)}${extra?` <span>${list.length}</span>`:''}</h3><div class="health-tiles">${list.map(tile).join('')}</div></section>`:'';
  const rest=checks.filter(c=>!problems.includes(c)),home=c=>HEALTH_GROUPS.findIndex(([,titles])=>titles.includes(c.title));
  const groups=HEALTH_GROUPS.map(([name],i)=>group(name,rest.filter(c=>Math.max(0,home(c))===i))).join('');
  return `<div class="health-head"><h2>检查项</h2>${tone(problems.length?`${problems.length} 项需要注意`:'全部正常',problems.length?'warn':'good')}${refresh()}</div>${group('需要注意',problems,' is-problems')}${groups}`;
}
// Overview status: four tiles (active memories, semantic index, today's calls, health) and one list of what needs
// attention, built from the same health checks as the health page plus the attention counts.
const num=n=>Number.isFinite(n)?n.toLocaleString():'—';
export function overviewStatus(data){const f=data.features||{},o=f['system-health']?.owner,c=o?.vector_catch_up,attention=f.attention?.counts||{};
  const active=(data.insights?.statuses||[]).find(r=>r.value==='active')?.count,embedder=f['model-usage']?.models?.find(m=>m.kind==='embedder');
  const problems=healthChecks(f).filter(x=>x.level==='warn'||x.level==='bad');
  const tile=(label,value,sub,href,kind='')=>`<a class="status-tile" href="${href}" data-tone="${kind}"><span class="status-label">${esc(label)}</span><strong class="status-value">${esc(value)}</strong><span class="status-sub">${esc(sub)}</span></a>`;
  const index=!o?['—','状态未知','']:c?.error_code?['失败',t(c.error_code),'bad']:!o.flags?.vector_catch_up?[num(active),'增量索引未开启','warn']
    :c?.pending?[`${num(Math.max(0,(active||0)-c.pending))}/${num(active)}`,`待索引 ${c.pending} 条`,'warn']:[`${num(active)}/${num(active)}`,'全部已索引','good'];
  const calls=embedder?.configured?[`${num(embedder.used)}/${embedder.limit===null?'不限':num(embedder.limit)}`,`总量 ${num(embedder.total?.used)} / ${embedder.total?.limit===null||embedder.total?.limit===undefined?'不限':num(embedder.total.limit)}`]:['—','嵌入模型未配置'];
  const worst=problems.some(x=>x.level==='bad')?'bad':problems.length?'warn':'good';
  // Failed jobs are a health check (整理任务), so they are not listed twice here.
  const extra=[[attention.stale_summaries,'份摘要已过期','/app/summaries'],[attention.pending_reconciliation,'项任务对账待确认','/app/projects']].filter(([n])=>n>0);
  const items=[...problems.map(x=>`<li data-health="${esc(x.level)}"><span class="health-dot" data-level="${esc(x.level)}" aria-hidden="true"></span><div><strong>${esc(x.title)}</strong><p>${esc(x.detail)}</p>${x.fix?`<p class="muted">${esc(x.fix)}</p>`:''}</div><a href="${esc(x.href||'/app/health')}">${x.href?'去处理':'查看'}</a></li>`),
    ...extra.map(([n,text,href])=>`<li data-health="warn"><span class="health-dot" data-level="warn" aria-hidden="true"></span><div><strong>${esc(n)} ${esc(text)}</strong></div><a href="${href}">处理</a></li>`)];
  return `${mapCard(f,active)?`<div class="overview-hero">${mapCard(f,active)}${streamCard()}</div>`:''}<div class="status-strip">${tile('活动记忆',num(active),`共 ${num(data.counts?.memories)} 条记录（含历史版本）`,'/app/memories')}${tile('语义索引',index[0],index[1],'/app/processing',index[2])}${tile('今日嵌入调用',calls[0],calls[1],'/app/models')}${tile('系统健康',problems.length?`${problems.length} 项`:'正常',problems.length?'需要注意':'所有检查通过','/app/health',worst)}</div>
    ${pipelineCard(data,f,active)}
    <section class="card attention-card"><header class="section-head"><h2>需要注意</h2></header>${items.length?`<ul class="health-list">${items.join('')}</ul>`:'<p class="muted">目前没有需要处理的事。</p>'}</section>`;
}
// Memory map (overview hero): each writer-chosen kind has its own colour; records without a kind are grey.
const GROUP_NAMES={fact:'事实',pref:'偏好',flow:'工作流程',proj:'架构',bug:'问题',pat:'模式',none:'未标注类型'};
// The parts of the map card that follow the chosen window and hidden types: figures, legend (type toggles), hint.
function mapParts(graph,{days,hidden,indexed}){
  const base=mapWindow(graph,{days}),shown=mapWindow(graph,{days,hidden}),plan=mapAnchors(shown),keywords=new Set(shown.memories.flatMap(m=>(m.concepts||[]).map(conceptKey))).size;
  const groups=Object.keys(GROUP_NAMES).map(k=>[k,base.memories.filter(m=>kindGroup(m.kind)===k).length]).filter(([,n])=>n);
  const big=(value,label)=>`<div class="map-figure"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  const figures=`${big(num(shown.memories.length),days?`近 ${days} 天的记忆`:'活动记忆')}${big(num(keywords),keywords?'关键词':'关键词（尚未补全）')}${big(indexed,'语义已索引')}`;
  const legend=`${groups.map(([k,n])=>`<li><button type="button" class="node-key map-kind" data-group="${k}" data-map-kind="${k}" aria-pressed="${hidden.has(k)?'false':'true'}" title="${hidden.has(k)?'点击显示':'点击隐藏'}这一类">${esc(GROUP_NAMES[k])} <span>${num(n)}</span></button></li>`).join('')}${plan.mode==='concepts'?'<li class="node-key" data-group="entity">关键词</li>':plan.mode==='topics'?'<li class="node-key" data-group="entity">主题</li>':''}`;
  const how=plan.aggregate?'记忆较多，只画关键词：圆越大记忆越多，线越粗越常一起出现':plan.mode==='concepts'?'紫色节点是共同的关键词，彩色节点是类型':plan.mode==='topics'?'还没有共同的关键词：紫色节点是主题':'还没有共同的关键词，记忆按类型聚在一起';
  const hint=`${esc(daysLabel(days))}${graph.truncated&&!days?` · 只取最近 ${num(graph.memories.length)} 条`:''} · ${esc(how)} · 光点：最近的读写`;
  const empty=shown.memories.length?'':graph.memories.length?`<p class="map-empty">${days?`近 ${days} 天没有记忆，换个时间范围看看。`:'所有类型都被隐藏了，点下面的类型重新显示。'}</p>`:'<p class="map-empty">还没有活动记忆。ChatGPT、编程助手或控制台写入后，会出现在这张图上。</p>';
  return {figures,legend,hint,empty,graph:shown};}
const mapRange=days=>`<div class="map-range" role="group" aria-label="时间范围">${MAP_DAY_CHOICES.map(d=>`<button type="button" data-map-days="${d}" aria-pressed="${d===days}">${esc(daysLabel(d))}</button>`).join('')}
  <label class="map-custom${MAP_DAY_CHOICES.includes(days)?'':' is-active'}"><span class="sr-only">自定义天数</span><input type="number" min="1" max="3650" step="1" inputmode="numeric" placeholder="自定义天数" data-map-custom value="${MAP_DAY_CHOICES.includes(days)?'':esc(days)}"></label></div>`;
function mapCard(f,active){const g=f.attention?.graph,o=f['system-health']?.owner,c=o?.vector_catch_up;
  if(!g)return '';const days=mapDays();
  const indexed=!o||!o.flags?.vector_catch_up||c?.error_code?'—':`${Math.round(100*Math.max(0,(active||0)-(c?.pending||0))/Math.max(1,active||0))}%`;
  const parts=mapParts(g,{days,hidden:new Set(),indexed});
  return `<section class="card map-card" data-memory-map data-indexed="${esc(indexed)}">${mapControls()}<canvas data-map-canvas role="img" aria-label="记忆网络：大圆点是关键词或主题，小圆点是记忆，颜色表示类型"></canvas>
    <div class="map-figures" data-map-figures>${parts.figures}</div>${mapRange(days)}
    <div data-map-empty>${parts.empty}</div>
    <ul class="map-legend" data-map-legend>${parts.legend}</ul>
    <p class="map-hint" data-map-hint>${parts.hint}</p></section>`;}
function streamCard(){return `<section class="card live-stream" data-live-stream><header class="section-head"><h2>实时动态</h2><div><button type="button" class="quiet" data-stream-refresh>刷新</button><a href="/app/audit">全部审计</a></div></header>
  <ol class="stream-events" data-stream-list><li class="muted">正在读取最近的记忆读写…</li></ol><p class="muted stream-note">打开概览、点刷新或切回这个页面时更新。</p></section>`;}
// Memory pipeline for the last 7 days: written → scrubbed → typed → keywords → semantic index → used.
function pipelineCard(data,f,active){const a=f.attention?.activity_7d,o=f['system-health']?.owner,g=f.attention?.graph;if(!a)return '';
  const s=a.sources,u=a.uses,written=s.chatgpt+s.agents+s.console+s.import+s.other,on=k=>o?.flags?.[k]===true;
  const unmarked=(data.insights?.kinds||[]).find(r=>r.value==='none')?.count||0,c=o?.vector_catch_up;
  const days=(data.insights?.activity||[]).slice(-14),max=Math.max(1,...days.map(d=>d.count));
  const spark=days.length?`<svg class="stage-spark" viewBox="0 0 ${days.length*6} 24" preserveAspectRatio="none" aria-hidden="true">${days.map((d,i)=>`<rect x="${i*6}" y="${24-Math.max(1,Math.round(22*d.count/max))}" width="4" height="${Math.max(1,Math.round(22*d.count/max))}" rx="1"/>`).join('')}</svg>`:'';
  const withConcepts=(g?.memories||[]).filter(m=>m.concepts?.length).length,reads=u.chatgpt.search+u.chatgpt.read+u.agents.search+u.agents.read+u.console.search+u.console.read;
  const stage=(group,label,value,note,href,extra='')=>`<a class="pipe-stage" data-group="${group}" href="${href}"><span class="pipe-label">${esc(label)}</span><strong>${esc(value)}</strong>${extra}<span class="pipe-note">${esc(note)}</span></a>`;
  return `<section class="card pipeline-card"><header class="section-head"><h2>记忆流水线 <small>最近 7 天，从写入到被读取</small></h2><a href="/app/processing">整理能力</a></header><div class="pipe">
    ${stage('proj','写入',num(written),`ChatGPT ${num(s.chatgpt)} · 编程助手 ${num(s.agents)} · 控制台和导入 ${num(s.console+s.import)}`,'/app/memories',spark)}
    ${stage('fact','脱敏',num(a.redacted??0),a.redacted?'写入前替换了密钥或令牌':'没有发现密钥','/app/audit?group=system')}
    ${stage('flow','类型',`${num(Math.max(0,(active||0)-unmarked))}/${num(active)}`,'写入的 Agent 标注类型','/app/memories?kind=none')}
    ${stage('entity','关键词',`${num(withConcepts)}/${num(g?.memories.length||0)}`,on('traits')?'新记忆自动补全关键词':'补全关键词已关闭','/app/processing#cap-traits')}
    ${stage('proj','语义索引',c?.error_code?'失败':on('vector_catch_up')?`${num(Math.max(0,(active||0)-(c?.pending||0)))}/${num(active)}`:'未开启',c?.pending?`待索引 ${num(c.pending)} 条`:on('vector_catch_up')?'新记忆自动加入':'新记忆不会进入语义索引','/app/processing')}
    ${stage('pref','被读取',num(reads),`搜索 ${num(u.chatgpt.search+u.agents.search+u.console.search)} · 读取 ${num(u.chatgpt.read+u.agents.read+u.console.read)}`,'/app/audit?group=memory')}
  </div></section>`;}
// Live stream: the latest memory reads and writes from the audit log. Every console read is itself audited, so the
// list refreshes on demand (open, refresh, tab shown again; at most once a minute), never on a timer.
const VERB={'memory.query':'搜索了记忆','memory.read':'读取了'};
function streamItems(d){const creds=d.credentials||{},mems=d.memories||{};
  return (d.entries||[]).filter(e=>e.kind==='read'||e.kind==='write').slice(0,8).map(e=>{const c=e.credential_id&&creds[e.credential_id],conn=c?.connection;
    const who=conn?.type==='personal'&&!conn.missing?conn.label:conn?.purpose==='console'?'控制台':conn?.purpose==='web'?'ChatGPT':c?.label||'未知来源';
    const memory=e.target_type==='memory'&&e.target_id?mems[e.target_id]:null,title=memory?.title||'';
    const verb=VERB[e.action]||(e.kind==='write'?'写入了':'读取了'),date=new Date(typeof e.created_at==='number'?e.created_at*1000:e.created_at);
    return {memory_id:e.target_type==='memory'?e.target_id:null,kind:e.kind,refs:e.query?.result_refs||[],
      html:`<li class="stream-event" data-kind="${esc(e.kind)}"><time>${Number.isFinite(date.getTime())?date.toLocaleTimeString(document.documentElement.lang,{hour:'2-digit',minute:'2-digit'}):''}</time><div><p><strong>${esc(who)}</strong> ${esc(verb)}${title?` <span class="stream-title">「${esc(title)}」</span>`:e.action==='memory.query'?`，命中 ${num(e.query?.result_refs?.length||0)} 条`:''}</p><span class="node-key" data-group="${e.kind==='write'?'proj':'pref'}">${e.kind==='write'?'写入':'读取'}</span></div></li>`};});}
export function mountOverview({api,root,data,isActive,openMemory}){
  const canvas=root.querySelector('[data-memory-map] [data-map-canvas]'),list=root.querySelector('[data-stream-list]'),graph=data.features?.attention?.graph,card=canvas?.closest('[data-memory-map]'),panel=card?.querySelector('[data-map-panel]');
  // Window (days, remembered in this browser) and hidden types drive what the map draws; both redraw in place.
  let days=mapDays();const hidden=new Set();
  const show=i=>{if(!panel)return;panel.hidden=i<0;panel.innerHTML=i<0?'':anchorPanel(map.graph,map.plan,i);};
  const insets=()=>{const c=card.getBoundingClientRect(),f=card.querySelector('[data-map-figures]')?.getBoundingClientRect(),l=card.querySelector('[data-map-legend]')?.getBoundingClientRect();
    const r=card.querySelector('.map-range')?.getBoundingClientRect();
    return {top:f?Math.round(Math.max(f.bottom,r&&r.left<c.left+c.width/2?r.bottom:0)-c.top+16):undefined,bottom:l&&l.height?Math.round(c.bottom-l.top+14):undefined};};
  const map=canvas&&graph?memoryMap(canvas,mapWindow(graph,{days,hidden}),{onSelect:show,onMemory:openMemory,tip:card.querySelector('[data-map-tip]'),insets,panelWidth:316}):null;let last=0;
  const refresh=()=>{if(!map)return;const parts=mapParts(graph,{days,hidden,indexed:card.dataset.indexed||'—'});
    card.querySelector('[data-map-figures]').innerHTML=parts.figures;card.querySelector('[data-map-legend]').innerHTML=parts.legend;card.querySelector('[data-map-hint]').innerHTML=parts.hint;card.querySelector('[data-map-empty]').innerHTML=parts.empty;
    for(const b of card.querySelectorAll('[data-map-days]'))b.setAttribute('aria-pressed',String(Number(b.dataset.mapDays)===days));
    card.querySelector('.map-custom')?.classList.toggle('is-active',!MAP_DAY_CHOICES.includes(days));map.setGraph(parts.graph);};
  if(map){wireControls(card,map);panel?.addEventListener('click',event=>{if(event.target.closest('[data-map-close]')){map.select(-1);show(-1);return;}const b=event.target.closest('[data-map-pick]');if(b){const i=Number(b.dataset.mapPick);map.select(i);show(i);}});
    card.addEventListener('click',event=>{const d=event.target.closest('[data-map-days]');if(d){days=Number(d.dataset.mapDays);saveMapDays(days);const input=card.querySelector('[data-map-custom]');if(input)input.value='';refresh();return;}
      const k=event.target.closest('[data-map-kind]');if(k){hidden.has(k.dataset.mapKind)?hidden.delete(k.dataset.mapKind):hidden.add(k.dataset.mapKind);refresh();}});
    card.querySelector('[data-map-custom]')?.addEventListener('change',event=>{const v=Number(event.target.value);if(!Number.isInteger(v)||v<1||v>3650){event.target.value='';return;}days=v;saveMapDays(days);refresh();});}
  const load=async(force=false)=>{if(!list||!isActive()||(!force&&Date.now()-last<60000))return;last=Date.now();
    try{const items=streamItems(await api('audit',{group:'memory',limit:20}));if(!list.isConnected)return;
      list.innerHTML=items.length?items.map(i=>i.html).join(''):'<li class="muted">最近没有记忆读写。</li>';map?.replay(items);}
    catch{if(list.isConnected)list.innerHTML='<li class="muted">暂时读不到审计记录，稍后点刷新。</li>';}};
  root.querySelector('[data-stream-refresh]')?.addEventListener('click',()=>load(true));
  const visible=()=>{if(!list?.isConnected){document.removeEventListener('visibilitychange',visible);return;}if(!document.hidden)load();};
  document.addEventListener('visibilitychange',visible);void load(true);
}
// Connection points of the memory map. Shared keywords first: a keyword used by at least two memories becomes a
// connection point and every memory links to each of its keywords and loosely to its type hub. Without shared keywords,
// shared topics play that role; without either, memories gather around their type hubs.
// When many memories are shown (more than MAP_AGGREGATE_AT), memory dots are left out: only keywords are drawn, sized by
// how many memories carry them and linked by how often two keywords appear together (edges), so the map never fills up.
// The number of connection points follows the canvas size (max).
const TOPIC_ANCHORS=14,MAP_AGGREGATE_AT=150;
const topicLabel=(topic,all)=>{const parts=String(topic).split('/').filter(Boolean),last=parts.at(-1)||String(topic);
  return all.filter(x=>String(x).split('/').filter(Boolean).at(-1)===last).length>1&&parts.length>1?parts.slice(-2).join('/'):last;};
const conceptKey=c=>String(c).trim().toLowerCase();
export function mapAnchors(graph,{max=TOPIC_ANCHORS,aggregate=graph.memories.length>MAP_AGGREGATE_AT}={}){
  const groups=[...new Set(graph.memories.map(m=>kindGroup(m.kind)))],counts=new Map(),spelled=new Map();
  for(const m of graph.memories)for(const c of new Set((m.concepts||[]).map(conceptKey)))counts.set(c,(counts.get(c)||0)+1);
  for(const m of graph.memories)for(const c of m.concepts||[])if(!spelled.has(conceptKey(c)))spelled.set(conceptKey(c),String(c).trim());
  const concepts=[...counts].filter(([,n])=>n>1).sort((a,b)=>b[1]-a[1]||(a[0]<b[0]?-1:1)).slice(0,max).map(([c])=>c);
  const hubs=()=>groups.map(k=>({kind:'hub',group:k,label:GROUP_NAMES[k],count:graph.memories.filter(m=>kindGroup(m.kind)===k).length}));
  // Co-occurrence of connection points across memories: [a,b,count] with a<b.
  const edgesOf=links=>{const pairs=new Map();for(const ls of links){const ids=ls.filter(([,w])=>w===1).map(([e])=>e);
      for(let i=0;i<ids.length;i++)for(let j=i+1;j<ids.length;j++){const key=Math.min(ids[i],ids[j])+','+Math.max(ids[i],ids[j]);pairs.set(key,(pairs.get(key)||0)+1);}}
    return [...pairs].map(([key,n])=>[...key.split(',').map(Number),n]);};
  if(concepts.length){
    const anchors=concepts.map(c=>({kind:'concept',label:spelled.get(c),title:spelled.get(c),count:counts.get(c)}));
    const mine=m=>[...new Set((m.concepts||[]).map(conceptKey))].map(c=>concepts.indexOf(c)).filter(i=>i>=0);
    if(aggregate){const links=graph.memories.map(m=>mine(m).map(i=>[i,1]));return {mode:'concepts',aggregate:true,anchors,links,edges:edgesOf(links)};}
    const hub=k=>concepts.length+groups.indexOf(k);
    return {mode:'concepts',anchors:[...anchors,...hubs()],
      links:graph.memories.map(m=>{const ids=mine(m);return ids.length?[...ids.map(i=>[i,1]),[hub(kindGroup(m.kind)),.3]]:[[hub(kindGroup(m.kind)),1]];})};
  }
  const sizes=new Map();
  for(const m of graph.memories)if(m.topic)sizes.set(m.topic,(sizes.get(m.topic)||0)+1);
  const topics=[...sizes].filter(([,n])=>n>1).sort((a,b)=>b[1]-a[1]||(a[0]<b[0]?-1:1)).slice(0,max).map(([topic])=>topic);
  const names=topics.map(x=>topicLabel(x,topics)),topicAnchors=topics.map((topic,i)=>({kind:'topic',label:names[i],title:topic,count:sizes.get(topic)}));
  if(aggregate){const links=graph.memories.map(m=>{const t=topics.indexOf(m.topic);return t>=0?[[t,1]]:[];});
    return topics.length?{mode:'topics',aggregate:true,anchors:topicAnchors,links,edges:[]}:{mode:'kinds',aggregate:true,anchors:hubs(),links:graph.memories.map(m=>[[groups.indexOf(kindGroup(m.kind)),1]]),edges:[]};}
  const hub=k=>topics.length+groups.indexOf(k);
  return {mode:topics.length?'topics':'kinds',anchors:[...topicAnchors,...hubs()],links:graph.memories.map(m=>{const t=topics.indexOf(m.topic);return t>=0?[[t,1],[hub(kindGroup(m.kind)),.3]]:[[hub(kindGroup(m.kind)),1]];})};
}
// The memories a map shows: a recent window (days, 0 = all) by each memory's latest activity day, minus hidden types.
export function mapWindow(graph,{days=30,hidden=new Set(),today=new Date()}={}){
  const cutoff=days>0?new Date(today.getTime()-(days-1)*86400000).toISOString().slice(0,10):null;
  return {...graph,memories:graph.memories.filter(m=>(!cutoff||!m.day||m.day>=cutoff)&&!hidden.has(kindGroup(m.kind))),entities:[],links:[]};
}
const MAP_DAYS_KEY='mnm.map.days',MAP_DAY_CHOICES=[7,30,90,0];
const mapDays=()=>{try{const v=Number(localStorage.getItem(MAP_DAYS_KEY));return Number.isInteger(v)&&v>=0&&v<=3650&&localStorage.getItem(MAP_DAYS_KEY)!==null?v:30;}catch{return 30;}};
const saveMapDays=v=>{try{localStorage.setItem(MAP_DAYS_KEY,String(v));}catch{}};
const daysLabel=d=>d?`近 ${d} 天`:'全部';
// What a chosen connection point holds: its memories by kind, the points it shares memories with, and where to
// browse them in the library. Built from the map data only (no extra read).
export function anchorPanel(graph,plan,i){const a=plan.anchors[i];if(!a)return '';
  const mine=plan.links.map((ls,m)=>ls.some(([e,w])=>e===i&&(w===1||a.kind==='hub'))?m:-1).filter(m=>m>=0),groups={},shared={};
  for(const m of mine){const k=kindGroup(graph.memories[m].kind);groups[k]=(groups[k]||0)+1;for(const [e] of plan.links[m])if(e!==i)shared[e]=(shared[e]||0)+1;}
  // A keyword lists the keywords it appears with; a kind hub lists the keywords (or topics) inside it.
  const near=a.kind==='topic'?[]:Object.entries(shared).filter(([e])=>a.kind!=='concept'||plan.anchors[e].kind==='concept').sort((x,y)=>y[1]-x[1]).slice(0,5),kind={entity:'实体',concept:'关键词',topic:'主题',hub:'类型'}[a.kind];
  const href=a.kind==='topic'?`/app/memories?topic=${encodeURIComponent(a.title)}`:a.kind==='concept'?`/app/memories?concept=${encodeURIComponent(a.label)}`:a.kind==='hub'?`/app/memories?kind=${encodeURIComponent(KIND_OF_GROUP[a.group]||'none')}`:`/app/memories?query=${encodeURIComponent(a.label)}`;
  return `<header><span class="node-key" data-group="${a.kind==='hub'?esc(a.group):'entity'}">${esc(kind)}</span><button type="button" class="quiet map-panel-close" data-map-close aria-label="关闭">×</button></header>
    <h3 title="${esc(a.title||a.label)}">${esc(a.title||a.label)}</h3><p class="muted">图上 ${num(mine.length)} 条记忆</p>
    ${a.kind==='hub'?'':`<div class="entity-groups">${Object.entries(groups).map(([k,n])=>`<span class="node-key" data-group="${k}">${esc(GROUP_NAMES[k])} <span>${num(n)}</span></span>`).join('')}</div>`}
    ${near.length?`<h4>${a.kind==='hub'?(plan.mode==='concepts'?'这个类型里的关键词':'这个类型里的主题'):'常一起出现'}</h4><ul class="entity-picks">${near.map(([e,n])=>`<li><button type="button" class="quiet" data-map-pick="${e}"><span class="node-key" data-group="${plan.anchors[e].kind==='hub'?esc(plan.anchors[e].group):'entity'}">${esc(plan.anchors[e].label)}</span><span>${num(n)} 条</span></button></li>`).join('')}</ul>`:''}
    <div class="actions"><a class="button" href="${href}">在记忆库里查看</a></div>`;}
// Canvas drawing: connection points are glowing somas sized by how many memories they hold (entities and topics in
// violet, kind hubs in their kind colour); memories are small dots in their kind colour; links curve.
// Hover names a node; a click on a connection point highlights what it holds, a click on a memory opens it; drag
// pans, pinch / ctrl+wheel or the zoom buttons zoom.
function memoryMap(canvas,initialGraph,{onSelect=null,onMemory=null,tip=null,top:topInset=null,insets=null,panelWidth=0}={}){const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches,token=n=>getComputedStyle(canvas).getPropertyValue(n).trim();
  const colour={pref:'--c-pref',proj:'--c-proj',flow:'--c-flow',fact:'--c-fact',bug:'--c-bug',pat:'--c-pat',none:'--c-none'};let graph=initialGraph,plan=mapAnchors(graph);
  let nodes=[],links=[],W=0,H=0,dpr=1,pulses=[],frame=0,events=[],cursor=0,timer=0,selected=-1,hover=-1,view={s:1,x:0,y:0},drag=null,lit=null;
  function layout(){const r=canvas.getBoundingClientRect();W=r.width;H=r.height;dpr=devicePixelRatio||1;canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);
    // More room, more connection points (8–30); fewer on a phone so labels do not collide.
    plan=mapAnchors(graph,{max:Math.max(8,Math.min(30,Math.round(W*H/36000)))});
    let seed=7;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
    // insets(): the space the card's overlays (figures, legend) take, measured; otherwise a fixed estimate.
    const measured=insets?.()||{},top=measured.top??topInset??Math.min(110,H*.24),bottom=measured.bottom??(W<560?100:56),cy=top+(H-top-bottom)/2,ry=(H-top-bottom)/2,inner=plan.anchors.filter(a=>a.kind!=='hub'),outer=plan.anchors.filter(a=>a.kind==='hub');
    const place=(list,i,rx,rr)=>list.length>1?[W/2+Math.cos(i/list.length*6.283+.4)*rx,cy+Math.sin(i/list.length*6.283+.4)*rr]:[W/2,cy];
    nodes=plan.anchors.map(a=>{const ring=a.kind==='hub'&&inner.length?outer:inner.length?inner:outer,far=a.kind==='hub'&&inner.length;
      const [x,y]=place(ring,ring.indexOf(a),W*(far?.4:.26),ry*(far?.85:.6));return {...a,anchor:true,x:x+(rnd()-.5)*30,y:y+(rnd()-.5)*20,r:Math.min(far?9:15,3.5+Math.sqrt(a.count)*.9)};});
    const n0=nodes.length;
    // Aggregated: keywords only, linked by co-occurrence (w = shared memories); otherwise every memory is a dot.
    if(plan.aggregate){const most=Math.max(1,...plan.edges.map(([,,n])=>n));links=plan.edges.map(([a,b,n])=>[a,b,n/most]);for(const p of nodes)p.r=Math.min(22,4+Math.sqrt(p.count)*1.1);}
    else{graph.memories.forEach((m,i)=>{const a=nodes[plan.links[i][0]?.[0]];nodes.push({anchor:false,id:m.id,group:kindGroup(m.kind),topic:m.topic,x:(a?a.x:W/2)+(rnd()-.5)*90,y:(a?a.y:cy)+(rnd()-.5)*90,r:2.6});});
      links=plan.links.flatMap((es,i)=>es.map(([e,w])=>[n0+i,e,w]));}
    const n=nodes.length,steps=n>250?110:170,span=Math.min(W,(H-top-bottom)*1.7);
    for(let it=0;it<steps;it++){for(let a=0;a<n;a++)for(let b=a+1;b<n;b++){const A=nodes[a],B=nodes[b],dx=A.x-B.x,dy=A.y-B.y,d=Math.hypot(dx,dy)||1,want=A.anchor&&B.anchor?span*(A.kind==='hub'||B.kind==='hub'?.34:.3):A.anchor||B.anchor?A.r+B.r+16:15;
        if(d<want){const k=(want-d)/d*.08;A.x+=dx*k;A.y+=dy*k;B.x-=dx*k;B.y-=dy*k;}}
      for(const [a,b,w] of links){const A=nodes[a],B=nodes[b],dx=B.x-A.x,dy=B.y-A.y,d=Math.hypot(dx,dy)||1,rest=plan.aggregate?span*(.34-.14*w):w<1?span*.22:(plan.mode==='kinds'?40:52),k=(d-rest)/d*.04*(plan.aggregate?.3+w*.7:w);
        A.x+=dx*k;A.y+=dy*k;B.x-=dx*k*(plan.aggregate?1:.12);B.y-=dy*k*(plan.aggregate?1:.12);}
      for(const p of nodes){p.x+=(W/2-p.x)*.0012;p.y+=(cy-p.y)*.0012;p.x=Math.max(24,Math.min(W-24,p.x));p.y=Math.max(top,Math.min(H-bottom,p.y));}}
    fit(top,bottom);}
  // Stretch the finished layout over the whole free area (labels of connection points kept inside on the right).
  function fit(top,bottom){if(nodes.length<2)return;const pad=28,label=p=>p.anchor?Math.min(18,p.label.length)*6.6+p.r+12:p.r;
    const minX=Math.min(...nodes.map(p=>p.x-p.r)),maxX=Math.max(...nodes.map(p=>p.x+label(p))),minY=Math.min(...nodes.map(p=>p.y-p.r)),maxY=Math.max(...nodes.map(p=>p.y+p.r));
    const sx=(W-2*pad)/Math.max(1,maxX-minX),sy=(H-top-bottom)/Math.max(1,maxY-minY),k=Math.min(sx,sy),kx=Math.min(sx,k*1.8),ky=Math.min(sy,k*1.8);
    const ox=pad+((W-2*pad)-(maxX-minX)*kx)/2,oy=top+((H-top-bottom)-(maxY-minY)*ky)/2;
    for(const p of nodes){p.x=ox+(p.x-minX)*kx;p.y=oy+(p.y-minY)*ky;}}
  const bend=(A,B,i)=>{const s=(i%2?1:-1)*.16;return [(A.x+B.x)/2-(B.y-A.y)*s,(A.y+B.y)/2+(B.x-A.x)*s];};
  const highlight=()=>{lit=selected<0?null:new Set([selected,...links.filter(([a,b])=>b===selected||plan.aggregate&&a===selected).map(([a,b])=>a===selected?b:a)]);};
  function draw(){const g=canvas.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,W,H);g.setTransform(dpr*view.s,0,0,dpr*view.s,dpr*view.x,dpr*view.y);
    // Sticky board (--map-style: outline): pastel fills with ink outlines, no glow; otherwise glowing nodes.
    const ink=token('--text'),line=token('--line-strong'),ent=token('--c-ent'),bg=token('--surface'),flat=token('--map-style')==='outline',blur=n=>{g.shadowBlur=flat?0:n;};
    links.forEach(([a,b,w],i)=>{const A=nodes[a],B=nodes[b],[qx,qy]=bend(A,B,i),on=lit&&(b===selected||plan.aggregate&&a===selected);g.strokeStyle=on?(flat?ink:B.kind==='hub'?token(colour[B.group]):ent):line;g.globalAlpha=on?.8:lit?.07:plan.aggregate?.18+.4*w:(w<1?.13:.32)*(flat?.7:1);g.lineWidth=(plan.aggregate?1+3*w:on?1.4:1)/view.s;g.beginPath();g.moveTo(A.x,A.y);g.quadraticCurveTo(qx,qy,B.x,B.y);g.stroke();});g.globalAlpha=1;
    pulses=pulses.filter(p=>p.k<1);for(const p of pulses){const A=nodes[p.a],B=nodes[p.b],[qx,qy]=bend(A,B,p.i),k=p.k,u=1-k,x=u*u*A.x+2*u*k*qx+k*k*B.x,y=u*u*A.y+2*u*k*qy+k*k*B.y;
      g.fillStyle=p.colour;g.shadowColor=p.colour;blur(14);g.beginPath();g.arc(x,y,flat?3.6:2.8,0,7);g.fill();g.shadowBlur=0;if(flat){g.strokeStyle=ink;g.lineWidth=1.4/view.s;g.stroke();}p.k+=.016;}
    nodes.forEach((p,i)=>{if(p.anchor)return;const c=token(colour[p.group]);g.globalAlpha=lit&&!lit.has(i)?.2:1;g.fillStyle=c;g.shadowColor=c;blur(7);g.beginPath();g.arc(p.x,p.y,(i===hover?p.r+1.6:p.r)+(flat?.6:0),0,7);g.fill();g.shadowBlur=0;if(flat){g.strokeStyle=ink;g.lineWidth=1/view.s;g.stroke();}
      if(i===hover){g.strokeStyle=ink;g.lineWidth=1.2/view.s;g.beginPath();g.arc(p.x,p.y,p.r+4,0,7);g.stroke();}g.globalAlpha=1;});
    g.font=`${flat?600:500} ${10/Math.sqrt(view.s)}px "Martian Mono",ui-monospace,monospace`;g.lineJoin='round';
    nodes.forEach((p,i)=>{if(!p.anchor)return;const c=p.kind==='hub'?token(colour[p.group]):ent,r=p.r,chosen=i===selected,dim=lit&&!chosen&&(plan.aggregate?!lit.has(i):!links.some(([a,b])=>b===i&&lit.has(a)));g.globalAlpha=dim?.35:1;
      if(!flat){const halo=g.createRadialGradient(p.x,p.y,0,p.x,p.y,r*3.2);halo.addColorStop(0,c+'55');halo.addColorStop(1,c+'00');g.fillStyle=halo;g.beginPath();g.arc(p.x,p.y,r*3.2,0,7);g.fill();}
      g.strokeStyle=chosen||i===hover||flat?ink:c;g.globalAlpha=chosen||i===hover?1:dim?.2:.5;g.lineWidth=(chosen?2:1.2)/view.s;g.beginPath();g.arc(p.x,p.y,r+(chosen?6:i===hover?5:3.5),0,7);g.stroke();g.globalAlpha=dim?.35:1;
      if(flat){g.fillStyle=ink;g.beginPath();g.arc(p.x+2/view.s,p.y+2/view.s,r+1,0,7);g.fill();g.globalAlpha=dim?.35:1;g.fillStyle=c;g.beginPath();g.arc(p.x,p.y,r+1,0,7);g.fill();g.strokeStyle=ink;g.lineWidth=2/view.s;g.stroke();}
      else{const core=g.createRadialGradient(p.x-r*.3,p.y-r*.3,0,p.x,p.y,r);core.addColorStop(0,'#FFFFFF');core.addColorStop(.45,c);core.addColorStop(1,c);g.fillStyle=core;g.beginPath();g.arc(p.x,p.y,r,0,7);g.fill();}
      const label=p.label.length>18?p.label.slice(0,17)+'…':p.label,width=g.measureText(label).width,right=(p.x+r+8+width)*view.s+view.x>W-8,lx=right?p.x-r-8-width:p.x+r+8,ly=p.y+3.5;
      g.strokeStyle=bg;g.lineWidth=4/view.s;g.globalAlpha=dim?.3:.9;g.strokeText(label,lx,ly);g.globalAlpha=dim?.3:flat?1:p.kind==='hub'?.65:.85;g.fillStyle=ink;g.fillText(label,lx,ly);g.globalAlpha=1;});}
  function loop(){if(!canvas.isConnected){clearInterval(timer);return;}draw();frame=pulses.length&&!document.hidden?requestAnimationFrame(loop):0;}
  const start=()=>{if(!frame&&!reduce)frame=requestAnimationFrame(loop);};
  function pulse(item){const i=item.memory_id?nodes.findIndex(n=>n.id===item.memory_id):-1,targets=i>=0?[i]:item.refs.map(id=>nodes.findIndex(n=>n.id===id)).filter(x=>x>=0).slice(0,3);
    const col=token(item.kind==='write'?'--c-proj':'--c-pref');for(const target of targets)links.forEach(([a,b],li)=>{if(a===target)pulses.push({a,b,i:li,k:0,colour:col});});start();}
  // Pointer handling in screen space; nodes live in map space (view: scale s, offset x/y).
  const point=event=>{const b=canvas.getBoundingClientRect();return [event.clientX-b.left,event.clientY-b.top];};
  const hitAt=(px,py)=>{const x=(px-view.x)/view.s,y=(py-view.y)/view.s,reach=r=>r+8/view.s,nearest=keep=>{let best=-1,bd=Infinity;
      nodes.forEach((p,i)=>{if(!keep(p))return;const d=Math.hypot(p.x-x,p.y-y);if(d<reach(p.r)&&d<bd){best=i;bd=d;}});return best;};
    const anchor=nearest(p=>p.anchor);return anchor>=0?anchor:nearest(p=>!p.anchor);};
  const showTip=(i,px,py)=>{if(!tip)return;if(i<0){tip.hidden=true;return;}const p=nodes[i];
    tip.textContent=p.anchor?`${{entity:'实体',concept:'关键词',topic:'主题',hub:'类型'}[p.kind]}：${p.title||p.label} · ${num(p.count)} 条 · 点击查看`:`${GROUP_NAMES[p.group]}${p.topic?' · '+p.topic:''} · 点击打开这条记忆`;
    tip.hidden=false;tip.style.transform=`translate(${Math.round(Math.min(px+14,W-tip.offsetWidth-8))}px,${Math.round(Math.max(8,py-tip.offsetHeight-10))}px)`;};
  // A panel on the right covers part of the map: a chosen point under it slides into view on the left.
  const reveal=i=>{if(i<0||!panelWidth||W<panelWidth*2)return;const sx=nodes[i].x*view.s+view.x;if(sx>W-panelWidth-24)view={...view,x:view.x-(sx-(W-panelWidth)/2)};};
  const choose=i=>{selected=i;highlight();reveal(i);draw();onSelect?.(i);};
  const zoomAt=(f,px=W/2,py=H/2)=>{const s=Math.min(6,Math.max(.6,view.s*f));view={s,x:px-(px-view.x)*s/view.s,y:py-(py-view.y)*s/view.s};draw();};
  canvas.addEventListener('pointerdown',event=>{if(event.button)return;const [px,py]=point(event);drag={px,py,x:view.x,y:view.y,moved:false};canvas.setPointerCapture(event.pointerId);});
  canvas.addEventListener('pointermove',event=>{const [px,py]=point(event);
    if(drag){const dx=px-drag.px,dy=py-drag.py;if(!drag.moved&&Math.hypot(dx,dy)>4){drag.moved=true;showTip(-1);canvas.dataset.dragging='';}if(drag.moved){view={...view,x:drag.x+dx,y:drag.y+dy};draw();return;}}
    const i=hitAt(px,py);if(i!==hover){hover=i;draw();}canvas.dataset.hover=i>=0?'node':'';showTip(i,px,py);});
  canvas.addEventListener('pointerup',event=>{const d=drag;drag=null;delete canvas.dataset.dragging;if(!d||d.moved)return;const [px,py]=point(event),i=hitAt(px,py);
    if(i<0){if(selected>=0)choose(-1);return;}if(nodes[i].anchor)choose(i);else onMemory?.(nodes[i].id);});
  canvas.addEventListener('pointerleave',()=>{if(drag)return;hover=-1;showTip(-1);draw();});
  canvas.addEventListener('wheel',event=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();const [px,py]=point(event);zoomAt(Math.exp(-event.deltaY*.01),px,py);},{passive:false});
  canvas.addEventListener('dblclick',event=>{const [px,py]=point(event);zoomAt(1.6,px,py);});
  layout();draw();
  new ResizeObserver(()=>{if(!canvas.isConnected)return;layout();draw();}).observe(canvas);
  return {get plan(){return plan;},get graph(){return graph;},setGraph(next){graph=next;selected=-1;hover=-1;lit=null;view={s:1,x:0,y:0};pulses=[];layout();draw();onSelect?.(-1);},
    select(i){selected=i;highlight();reveal(i);draw();},zoom(f){zoomAt(f);},reset(){view={s:1,x:0,y:0};draw();},
    replay(items){events=items.filter(x=>x.memory_id||x.refs.length);cursor=0;clearInterval(timer);if(reduce||!events.length)return;
    timer=setInterval(()=>{if(!canvas.isConnected){clearInterval(timer);return;}if(!document.hidden)pulse(events[cursor++%events.length]);},2400);}};
}
// Map controls shared by the overview and entity maps: zoom buttons, the hover tip and (overview) the info panel.
const mapControls=(panel=true)=>`<div class="map-zoom" role="group" aria-label="缩放"><button type="button" data-map-zoom="in" aria-label="放大">+</button><button type="button" data-map-zoom="out" aria-label="缩小">−</button><button type="button" data-map-zoom="reset">复位</button></div><div class="map-tip" data-map-tip hidden></div>${panel?'<aside class="map-panel" data-map-panel hidden></aside>':''}`;
function wireControls(card,map){card.addEventListener('click',event=>{const z=event.target.closest('[data-map-zoom]');if(!z)return;z.dataset.mapZoom==='reset'?map.reset():map.zoom(z.dataset.mapZoom==='in'?1.4:1/1.4);});}
const activityLine=(a,key,writeLabel)=>a?`<p class="activity-line" data-activity="${esc(key)}">最近 7 天：搜索 <strong>${num(a.uses[key].search)}</strong> 次 · 读取 <strong>${num(a.uses[key].read)}</strong> 次 · ${esc(writeLabel)} <strong>${num(a.sources[key])}</strong> 条</p>`:'';
// Entities: names that recur across memories (people, devices, projects, vendors) with their aliases.
// Usage: calls per model kind for the last 14 days, today's and total limits, and recent search volume.
// Usage on the models page (moved from its own page): totals, searches and the 14-day call chart. Per-model calls are on
// the model cards above, so they are not repeated here.
function usageOverview(d){if(!d)return '';const history=d.history||[];
  const W=640,H=200,left=34,bottom=26,top=10,max=Math.max(4,...history.flatMap(r=>[r.organizer||0,r.embedder||0])),step=Math.pow(10,Math.floor(Math.log10(max))),ceil=Math.ceil(max/step)*step;
  const y=v=>H-bottom-(v/ceil)*(H-bottom-top),slot=(W-left-8)/Math.max(1,history.length),bar=Math.max(3,slot*0.32);
  const grid=[0,ceil/2,ceil].map(v=>`<line x1="${left}" x2="${W-8}" y1="${y(v)}" y2="${y(v)}" class="chart-grid"/><text x="${left-6}" y="${y(v)+4}" text-anchor="end">${num(v)}</text>`).join('');
  const bars=history.map((r,i)=>{const x=left+i*slot+slot/2;return `<rect x="${x-bar-1}" y="${y(r.organizer||0)}" width="${bar}" height="${H-bottom-y(r.organizer||0)}" class="bar-organizer"><title>${r.day} 整理 ${r.organizer||0}</title></rect><rect x="${x+1}" y="${y(r.embedder||0)}" width="${bar}" height="${H-bottom-y(r.embedder||0)}" class="bar-embedder"><title>${r.day} 嵌入 ${r.embedder||0}</title></rect>${(history.length-1-i)%2===0?`<text x="${x}" y="${H-8}" text-anchor="middle">${r.day.slice(5)}</text>`:''}`;}).join('');
  const total=history.reduce((n,r)=>n+(r.organizer||0)+(r.embedder||0),0);
  return `<div class="usage-overview"><div class="status-strip" data-count="2">${[['近 14 天模型调用',num(total),'整理 + 嵌入'],['近 7 天记忆搜索',num(d.searches_7d),'来自所有连接']].map(([a,b,c])=>`<div class="status-tile"><span class="status-label">${a}</span><strong class="status-value">${b}</strong><span class="status-sub">${c}</span></div>`).join('')}</div>
    <section class="card"><header class="section-head"><h2>近 14 天调用</h2><span class="chart-legend"><span class="legend-organizer">整理</span><span class="legend-embedder">嵌入</span></span></header><div class="chart-scroll"><svg class="usage-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="近 14 天每天的整理和嵌入调用次数">${grid}${bars}</svg></div><p class="muted">按 UTC 日期统计；计入你的调用额度的请求都算在内。</p></section></div>`;
}
export function actionPage(page,data,caps,connectionQuery={}) {
  const owner=caps.owner_mode?data.features?.['system-health']?.owner:null;
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
      kv([['modelUsedBy',l('modelUsedBy_'+m.kind)],['modelName',`<span class="model-name">${esc(m.config.model||t('modelNotConfigured'))}</span>`+(m.kind==='embedder'&&m.config.dimensions?` <span class="model-dimensions" data-model-dimensions>${esc(m.config.dimensions)} ${l('dimensionsShort')}</span>`:'')],['baseUrl',`<code>${esc(m.config.base_url||'—')}</code>`],['dailyRequests',p.quotas?.[m.kind]?.mode==='manual'?(p.quotas[m.kind].daily?.limit==null?l('noLimit'):esc(p.quotas[m.kind].daily.limit)):esc(m.config.daily_requests??'—')],['hasKey',l(m.has_key?'yes':'no')]])+verification(m.verification)+limits(p.quotas?.[m.kind])+
      buttons([...(can('models.save')?[actionButton('models.save','configure',{kind:m.kind})]:[]),...(can('models.quota')?[actionButton('models.quota','setCallLimits',{kind:m.kind})]:[]),...(m.config.enabled&&can('models.test')?[actionButton('models.test','testCapabilities',{kind:m.kind})]:[]),...(m.config.enabled&&can('models.disable')?[actionButton('models.disable','disable',{kind:m.kind})]:[]),inspect('models',m.kind)])+(!can('models.save')?onlyRead():''),
      {aside:state(m.config.enabled?'enabled':'disabled'),className:'model-card'})).join('')}</div>`+hostsCard(data.hosts,can,data.system_hosts,data.hosts_apply)+usageOverview(data.features?.['model-usage'])+
      // Owner mode runs processing from the capability cards (processing page), so this page keeps only the models; other
      // deployments still start summaries and the index here.
      (caps.owner_mode?'':section('modelPipeline',`<p>${l('modelPipelineNote')}</p><div class="card-grid model-pipeline">${['summary','vector'].map(kind=>{
        const step=p[kind]||{},vector=kind==='vector';return `<div data-model-stage="${kind}"><h3>${l(kind)}</h3>${state(step.ready?'ready':'notReady')}${blocked(step.blockers)}${vector?kv([['indexedDocuments',esc(step.indexed_documents??0)],['state',esc(t(step.state||'not_started'))],['semanticReadiness',l(step.search_ready?'ready':'notReady')]])+blocked(step.search_blockers)+blocked(step.error_code?[step.error_code]:[]):''}${vector&&!caps.owner_mode?firstRun(step):''}${buttons([...(vector&&step.first_run?.budget?[]:[launch(vector?'vector.schedule':'jobs.schedule',vector?'rebuildIndex':'summarize',step.ready===true,vector?{}:{type:kind})])])}</div>`;
      }).join('')}</div><div class="section-foot"><a href="/app/processing">${l('viewJobs')} →</a><a href="/app/summaries">${l('viewSummaries')} →</a></div>`));
  }

  if(page==='jobs')return (caps.owner_mode?processingPage(owner,data.features?.models?.models):'')+section('jobQueue',`<div class="status-line">${l('scheduleStatus')} ${state(data.settings?.schedule_enabled?'enabled':'disabled')}<span aria-hidden="true">·</span>${l('workerStatus')} ${state(data.worker_enabled?'enabled':'disabled')}${data.vector?`<span aria-hidden="true">·</span>${l('vectorIndex')} ${state(data.vector.state)} ${esc(data.vector.error_code||'')}`:''}</div>
    ${can('jobs.schedule')?(data.processing?.summary?.blockers?.some(code=>['NOT_CONFIGURED','EGRESS_DENIED'].includes(code))
      // Without a usable model the button can only fail: say why and where to fix it instead.
      ?`<div class="actions action-toolbar"><button type="button" data-console-action="jobs.schedule" data-type="summary" disabled>${l('summarize')}</button></div><p class="policy-box">${l('jobsNotReady')} ${data.processing.summary.blockers.filter(code=>code!=='WORKER_DISABLED').map(code=>esc(t(code))).join(' · ')} · <a href="/app/models">${l('classifyOpenModels')}</a></p>`
      :buttons([actionButton('jobs.schedule','summarize',{type:'summary'})])):caps.owner_mode?'':onlyRead()}
    ${!data.worker_enabled?note('workerDisabledNote'):''}
    ${data.batches?batchTable(data.batches,can):table(data.jobs,['scope','state','progress','error','actions'],j=>`<tr><td><button type="button" class="link-button" data-job-detail="${esc(j.job_id)}">${esc(t(j.job_type))}</button><small><code>${esc(j.job_id)}</code></small></td><td><span class="state-dot" data-state="${esc(j.state)}">${l('jobState_'+j.state)}</span></td><td>${progress(j.processed,j.total)}</td>
      <td>${j.last_error_code?`<span class="job-error">${esc(t(j.last_error_code))}</span><small><code>${esc(j.last_error_code)}</code></small>${j.stale_taxonomy&&j.last_error_code!=='RESCHEDULED'?`<small class="job-hint">${l('jobStaleTaxonomyHint')}</small>`:''}`:'—'}</td>
      <td>${buttons([...(can('jobs.cancel')&&j.state!=='succeeded'&&j.state!=='cancelled'?[actionButton('jobs.cancel','cancelJob',{id:j.job_id})]:[]),...(can('jobs.retry')&&j.last_error_code!=='RESCHEDULED'&&['dead_letter','blocked_auth','blocked_budget','blocked_config','review_required','retry_wait','cancelled'].includes(j.state)?[j.stale_taxonomy?actionButton('jobs.retry','rescheduleWithCategories',{id:j.job_id,stale:'true'}):actionButton('jobs.retry','retry',{id:j.job_id})]:[])])}</td></tr>`)}
    <div class="section-foot">${pager(data)}</div>`,{aside:refresh()})+(caps.owner_mode?runsCard(owner):'');

  if(page==='connections')return caps.owner_mode?connectionsPage(data,caps,connectionQuery,owner):agentsView(data,caps,{},connectionQuery);

  if(page==='security')return `<div class="columns">${section('accountSecurity',`<div class="identity-row"><span class="avatar" aria-hidden="true">${esc([...(data.username||'·')][0])}</span><div><strong>${esc(data.username)}</strong>${tag(t(data.mfa_verified?'passwordTotp':'pending'))}</div></div>
      ${buttons([['security.password','changePassword'],['security.totp.begin','changeTotp'],['security.recovery_codes','rotateRecovery']].filter(([a])=>can(a)).map(([a,k])=>actionButton(a,k)))}${!can('security.password')?onlyRead():''}<p class="muted">${l('securityOperationsNote')}</p><a href="/recover">${l('recover')} →</a>`)}
    ${section('sessions',`<p class="muted">${l('sessionClientNote')}</p>`+table(data.sessions,['created','sessionClient','expires','actions'],s=>`<tr><td>${esc(time(s.created))}${s.current?`<small>${l('currentSession')}</small>`:''}</td><td>${sessionClient(s)}</td><td>${esc(time(s.expires))}</td><td>${buttons([inspect('sessions',s.session_id),...(can('security.session.revoke')?[actionButton('security.session.revoke','revoke',{id:s.session_id})]:[])])}</td></tr>`),{aside:can('security.sessions.revoke_others')?actionButton('security.sessions.revoke_others','revokeOtherSessions'):''})}</div>`;



  // Health: the checks, then the data counts beside personal export and import.
  if(page==='storage'){const COUNTS={memories:'记忆',sources:'来源',events:'原始事件',revisions:'修订版本'};
    return healthView(data)+`<div class="card-grid health-extras">${section('dataCounts',`<dl class="metadata-grid">${Object.entries(data.counts||{}).map(([k,n])=>`<dt>${esc(COUNTS[k]||k)}</dt><dd><strong class="figure">${esc(n)}</strong></dd>`).join('')}</dl>`)}
    ${section('personalExport',`<p>${l('portableNote')}</p>${writable?buttons([actionButton('storage.export','export'),actionButton('storage.import','importMemories')]):onlyRead()}${note('databaseRestoreNote')}`)}</div>`;}

  return null;
}
const field=(name,key,{value='',type='text',required=true,max=4096,min,upper,step}={})=>`<label>${l(key)}<input name="${name}" type="${type}" value="${esc(value)}" maxlength="${max}"${min!==undefined?` min="${min}"`:''}${upper!==undefined?` max="${upper}"`:''}${step!==undefined?` step="${step}"`:''} ${required?'required':''} ${type==='password'?'autocomplete="off"':''}></label>`;
const area=(name,key,value='')=>`<label>${l(key)}<textarea name="${name}" maxlength="4096" rows="7" required>${esc(value)}</textarea></label>`;
// Type, strength and concepts of a memory (writer-chosen traits); left unchanged when the form keeps the shown values.
const KIND_VALUES=['fact','preference','workflow','architecture','bug','pattern'];
const traitFields=m=>`<label>${l('kind')}<select name="kind"><option value="" ${m.kind?'':'selected'} data-i18n="kind_none">${esc(t('kind_none'))}</option>${KIND_VALUES.map(v=>`<option value="${v}" data-i18n="kind_${v}" ${v===m.kind?'selected':''}>${esc(t('kind_'+v))}</option>`).join('')}</select></label>`
  +field('strength','strength',{type:'number',value:m.strength??'',required:false,min:1,upper:10,step:1})
  +field('concepts','concepts',{value:(m.concepts||[]).join(', '),required:false,max:400})+`<p class="muted">${l('conceptsHelp')}</p>`;
const traitValues=fd=>{const out={},kind=String(fd.get('kind')||''),strength=String(fd.get('strength')||'').trim(),concepts=String(fd.get('concepts')||'').split(/[,，、]/).map(c=>c.trim()).filter(Boolean);
  if(kind)out.kind=kind;if(strength)out.strength=Number(strength);out.concepts=concepts.slice(0,8);return out;};
const select=(name,key,items,value)=>`<label>${l(key)}<select name="${name}">${items.map(v=>`<option data-i18n="${esc(v)}" value="${esc(v)}" ${v===value?'selected':''}>${esc(t(v))}</option>`).join('')}</select></label>`;
const check=(name,key,value=false)=>`<label class="check-field"><input type="checkbox" name="${name}" ${value?'checked':''}>${l(key)}</label>`;
// Configuration changes ask for the current password only (the authenticator code was checked at sign-in); changes to the
// sign-in factors themselves also ask for a fresh code.
const reauth=(otp=false)=>`<fieldset class="reauth"><legend>${l('reauthenticate')}</legend>${field('current_password','currentPassword',{type:'password',max:1024})}${otp?`${field('otp','otp',{max:6})}<p>${l('otpFreshNote')}</p>`:`<p>${l('reauthPasswordNote')}</p>`}</fieldset>`;
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
  const MEMORY_RESULTS={'memory.create':'resultCreated','memory.correct':'resultCorrected','memory.retract':'resultRetracted','memory.batch_retract':'resultBatchRetract'};
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
  // ---- Multi-step dialogs (project lifecycle) share these helpers. The category organize flow was retired with
  // categories: memories are filed by their writer-chosen type.
  let flow=null;
  const caps=()=>getCaps(),can=action=>canAct(caps(),action);
  const live=text=>{const node=document.getElementById('live-status');if(node)node.textContent=text;};
  function busy(on){working=on;for(const c of content.querySelectorAll('button,input,select,textarea'))c.disabled=on||c.hasAttribute('data-keep-disabled');}
  const fail=(e,seq)=>{if(seq!==sequence||!isActive())return;const node=content.querySelector('[data-operation-error]');const text=t(e.message);if(node)node.textContent=text;else content.insertAdjacentHTML('beforeend',`<p role="alert">${esc(text)}</p>`);live(text);};
  const fresh=seq=>seq===sequence&&isActive()&&modal.open;
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
    const payload={preview_id:preview.preview_id,...(flow.action==='delete'?{confirm_name:keep.confirm_name||''}:{}),current_password:keep.current_password||''};
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
  async function begin(action,button){if(working)return;if(Object.hasOwn(LIFECYCLE_FLOW,action))return lifecycleBegin(action,button);open(action);const seq=sequence;opId=crypto.randomUUID();lastPayload=null;intent={action,id:button.dataset.id,kind:button.dataset.kind,operator:button.dataset.operator,section:button.dataset.section,flags:button.dataset.flags?button.dataset.flags.split(',').filter(k=>Object.hasOwn(ownerLabels,k)):null,target:['on','off'].includes(button.dataset.target)?button.dataset.target:null};
    try{
      let fields='',data=getData();
      if(ownerActions.includes(action)){
        modal.querySelector('h2').textContent={'features.save':{retrieval:'默认检索模式',read_policy:'ChatGPT 读取策略'}[intent.section]||'功能开关','schedule.save':'新记录自动规则','processing.preview':'预览有限批次','processing.start':'确认并开始处理','processing.resume':'确认恢复处理','processing.pause':'暂停处理','processing.cancel':'取消批次','processing.delete':'删除运行记录','processing.clear':'清空运行记录'}[action];
        const o=(await api('system-health')).owner;if(!o)throw new Error('OWNER_REQUIRED');intent.owner=o;intent.revision=o.revision;
        // One form per section; the other settings are sent back unchanged (see payload).
        if(action==='features.save'&&intent.section==='retrieval')fields=`<p>控制台、ChatGPT 和其他助手在没有指定检索方式时使用的模式。</p><label>默认检索模式<select name="retrieval_mode">${Object.entries(RETRIEVAL_MODES).map(([k,v])=>`<option value="${k}" ${k===o.preferences.retrieval_mode?'selected':''}>${esc(v)}</option>`).join('')}</select></label>`+reauth();
        else if(action==='features.save'&&intent.section==='read_policy')fields=`<p>不扩大现有连接权限，生命周期边界始终保留。</p><label>ChatGPT 读取策略<select name="read_policy">${o.read_policy_options.map(x=>`<option value="${esc(x.value)}" ${x.value===o.preferences.read_policy?'selected':''}>${esc({chatgpt_per_memory_v1:'逐条授权',active_uniform_v1:'全部活动记忆'}[x.value]||x.value)}（当前可读 ${esc(x.active_readable)} 条）</option>`).join('')}</select></label>`+reauth();
        // A switch button edits only the flags it names; every other flag is sent back unchanged (see payload).
        // A 开启 / 关闭 / 暂停 button states its change: no checkbox to tick (a ticked box read as "confirm" and kept the
        // switch on). Other switch edits (修改) still list their flags as checkboxes.
        else if(action==='features.save'){const keys=intent.flags||Object.keys(ownerLabels),state=on=>`<span class="state-pill" data-state="${on?'on':'off'}">${on?'开启':'关闭'}</span>`;
          fields=intent.target?`<ul class="flag-change">${keys.map(key=>`<li><strong>${esc(ownerLabels[key])}</strong><span class="flag-transition">${state(o.flags[key]===true)}<span aria-hidden="true">→</span>${state(intent.target==='on')}</span></li>`).join('')}</ul>`
            +`<p class="muted">${intent.target==='on'?'打开开关不会启动历史处理；新记忆按“自动处理节奏”处理。':'关闭后新记忆不再自动处理；已经确认的结果保留。'}任何修改都会暂停正在运行的处理批次。</p>`+reauth()
            :'<p>勾选＝开启，取消勾选＝关闭；改过的项会高亮。任何修改都会暂停正在运行的处理批次；打开开关不会启动历史处理。</p>'+`<fieldset class="flag-fieldset"><legend>开关</legend>${keys.map(key=>`<label class="check-field flag-row"><input type="checkbox" name="${key}" ${o.flags[key]?'checked':''} data-was="${o.flags[key]?'on':'off'}"><span class="flag-name">${esc(ownerLabels[key])}</span><span class="flag-now">现在 <span class="state-pill" data-state="${o.flags[key]?'on':'off'}">${o.flags[key]?'已开启':'已关闭'}</span></span></label>`).join('')}</fieldset>`+reauth();}
        else if(action==='schedule.save')fields='<p>开启了哪些能力，由各能力卡片上的开关决定；这里只设置自动处理新记忆的节奏。</p>'+field('interval_minutes','间隔（分钟）',{type:'number',value:o.schedule.interval_minutes,min:5,upper:10080})+field('max_items','每轮最多记录数',{type:'number',value:o.schedule.max_items,min:1,upper:100})+field('budget','每轮最多模型调用数',{type:'number',value:o.schedule.budget,min:1,upper:1000})+reauth();
        // One step: the button freezes the batch right away (nothing is sent yet) and this dialog shows what it holds; one
        // password confirmation starts it. There is no separate preview to come back to, so nothing can expire in between.
        else if(action==='processing.preview'){const kind=['summary','traits','vector'].includes(intent.kind)?intent.kind:'summary',rebuild=kind==='vector';
          const limits={summary:[100,100],traits:[2000,300],vector:[5000,6000]}[kind];let run;
          // A batch can only start with the master switch and its own switch on: say which one is off before freezing anything.
          const off=[...(!o.flags.processing?['processing']:[]),...(!o.flags[kind==='vector'?'vector_build':kind]?[kind==='vector'?'vector_build':kind]:[])];
          if(!off.length){try{run=await mutate('processing.preview',{kind,limit:limits[0],budget:limits[1]},crypto.randomUUID());}
            catch(e){if(e.message!=='MANIFEST_EMPTY')throw e;}}
          if(seq!==sequence||!isActive())return;
          modal.querySelector('h2').textContent=rebuild?'重建语义索引':kind==='traits'?'补全历史记忆':'补处理历史记忆';
          if(off.length){intent.empty=true;fields=`<p class="policy-box" role="status">要先在这一页打开${off.map(k=>`“${esc(ownerLabels[k])}”`).join('和')}，才能开始。打开后再点一次即可。</p>`;}
          else if(!run){intent.empty=true;fields=`<p class="policy-box" role="status">${kind==='traits'?'没有需要补全的记忆：所有有效记忆都已经有类型和重要度。':'没有需要处理的历史记忆。'}</p>`;}
          else{intent.action='processing.start';intent.id=run.run_id;intent.run={...run,manifest_digest:run.digest};
            fields=`<dl class="run-facts"><div><dt>处理类型</dt><dd>${esc(runKind(kind))}</dd></div><div><dt>记忆</dt><dd>${esc(run.count)} 条${run.excluded?`（排除 ${esc(run.excluded)} 条）`:''}</dd></div><div><dt>模型</dt><dd>${esc(run.model||'—')}</dd></div><div><dt>最多调用</dt><dd>${esc(run.budget)} 次</dd></div></dl>`
              +(run.truncated?`<p class="muted">还有更多记忆，这一批先处理前 ${esc(run.count)} 条，跑完可以再点一次。</p>`:'')+runItems(run)
              +`<p>${rebuild?'会把全部活动记忆重新嵌入到一个新的语义索引，完成后点“启用新索引”才会切换；旧索引保留，可随时切回。':kind==='traits'?'确认后在后台跑完，结果直接写入，不用逐条确认；写入方已经填的不会被覆盖。':'确认后在后台跑完，会把这些记忆发送给上面的模型。'}</p>`+reauth();}
        }
        else if(action==='processing.clear'){const n=o.runs.filter(r=>r.state!=='preview'?['completed','cancelled'].includes(r.state):r.expires_at<Date.now()).length;
          fields=`<p>删除 ${esc(n)} 条已结束的运行记录（已完成、已取消、已过期）。运行中、已暂停和受阻的批次保留。</p><p class="muted">只删除记录，已经写入的摘要、关键词和索引不受影响。</p>`;}
        else {const run=o.runs.find(r=>r.run_id===intent.id);if(!run)throw new Error('RUN_NOT_FOUND');intent.run=run;
          const starting=['processing.start','processing.resume'].includes(action),expired=action==='processing.start'&&(run.expired||run.expires_at<Date.now());
          const facts=`<dl class="run-facts"><div><dt>处理类型</dt><dd>${esc(runKind(run.kind))}</dd></div><div><dt>记忆</dt><dd>${esc(run.count)} 条${run.excluded?`（排除 ${esc(run.excluded)} 条）`:''}</dd></div><div><dt>模型</dt><dd>${esc(run.model||'—')}</dd></div><div><dt>调用上限</dt><dd>已用 ${esc(run.used)} / ${esc(run.budget)}</dd></div></dl>`
            +(run.truncated?'<p class="muted">范围内还有未选入的记忆，处理完可以再补一批。</p>':'')+runItems(run)
            +`<details class="tech-details"><summary>技术信息</summary><p class="muted">清单校验码（确认时用来核对清单没有变化）</p><code class="owner-digest">${esc(run.manifest_digest)}</code></details>`;
          // An expired preview cannot start: say so and offer a fresh preview of the same kind instead of a password form that fails.
          fields=expired?facts+`<p class="policy-box" role="alert">这份预览已过期（预览只在 15 分钟内有效）。请重新预览，生成新的清单后再确认。</p><div class="actions">${['summary','traits','vector'].includes(run.kind)?ownerButton('processing.preview','重新预览',{kind:run.kind}):''}</div>`
            :facts+`<p>${starting?'确认后只处理这份冻结清单，会把清单里的记忆发送给上面的模型。':action==='processing.delete'?'只删除这条记录，已经写入的结果不受影响。':'停止后不会自动恢复；已发送的请求无法撤回。'}</p>`+(starting?reauth():'');
          if(expired)intent.expired=true;}
      }
      else if(action==='memory.create'){
        fields=area('content','content')+traitFields({})+select('memory_type','taskTypeField',['fact','goal','constraint','decision','completed','blocker','remaining','next_step'],'fact')+field('topic','topic',{required:false,max:120})+select('scope','scope',['user','project','task','workstream','session'],'user')+field('target_id','scopeTarget',{required:false,max:128});
      }
      else if(action.startsWith('memory.batch_')){
        // The same selection the toolbar counts (kept across pages), not only this page's checked boxes.
        const picked=getSelection(),ids=picked.memory_ids?.length?picked.memory_ids:[...document.querySelectorAll('[data-batch-memory]:checked')].map(n=>n.dataset.batchMemory);if(!ids.length||ids.length>50)throw new Error('BATCH_SELECTION_REQUIRED');
        const metas=await Promise.all(ids.map(memory_id=>api('memory-meta',{memory_id})));if(seq!==sequence||!isActive())return;
        intent.items=metas.map(m=>({memory_id:m.memory_id,revision:m.revision}));
        // Show what is being changed, not only identifiers: the visible rows carry each memory's text.
        const shown=new Map((data.results||[]).map(r=>[r.memory_id,r.content]));intent.snippets=Object.fromEntries(metas.map(m=>[m.memory_id,[...String(picked.snippets?.[m.memory_id]||shown.get(m.memory_id)||'')].slice(0,120).join('')]));
        fields=`<p><strong>${metas.length}</strong> ${l('batchRetractCount')}</p><ol class="batch-confirm-list">${metas.map(m=>`<li>${esc(intent.snippets[m.memory_id]||m.memory_id)} <small>${l('revisions')} ${m.revision}</small></li>`).join('')}</ol>`+
          field('reason','reason',{required:false})+`<p>${l('retractNote')}</p>`;
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
      else if(action==='tunnel.add')fields=field('name','tunnelName',{max:40})+`<label>${l('tunnelToken')}<textarea name="token" rows="4" maxlength="4096" required autocomplete="off" spellcheck="false"></textarea></label><p class="policy-box">${l('tunnelAddNote')}</p>`+reauth(true);
      else if(action==='tunnel.remove'){const row=(getData().features?.tunnel?.tunnels||[]).find(x=>x.id===intent.id);fields=`<p><strong>${esc(row?.name||'')}</strong> <code>${esc(intent.id)}</code></p><p class="policy-box">${l('tunnelRemoveNote')}</p>`+reauth(true);}
      else if(action==='tunnel.token')fields=`<label>${l('tunnelToken')}<textarea name="token" rows="4" maxlength="4096" required autocomplete="off" spellcheck="false"></textarea></label><p class="policy-box">${l('tunnelTokenNote')}</p>`+reauth(true);
      else if(action==='tunnel.reapply')fields=`<p>${l('tunnelReapplyNote')}</p>`+reauth(true);
      else if(action.startsWith('memory.')){
        const meta=await api('memory',{memory_id:intent.id,metadata:'true'});if(seq!==sequence||!isActive())return;intent.meta=meta;
        if(action==='memory.correct'){
          const page=await api('memory',{memory_id:intent.id,content_limit:4096,revision:meta.revision});if(seq!==sequence||!isActive())return;
          if(!page.content_complete)throw new Error('EDIT_REQUIRES_COMPLETE_RECORD');fields=area('content','content',page.memory.content)+field('reason','reason',{required:false})+field('topic','topic',{value:meta.topic||'',required:false,max:120})+traitFields(meta);
        } else fields=field('reason','reason',{required:false})+`<p>${l('retractNote')}</p>`;
      } else if(action==='jobs.schedule'){
        intent.type='summary';const status=await api('jobs');if(seq!==sequence||!isActive())return;const settings=status.settings||{revision:0,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,schedule_enabled:false};
        intent.settings_revision=settings.revision;fields=`<input type="hidden" name="type" value="summary">`+field('timezone','timezone',{value:settings.timezone})+select('periods','summaryPeriods',['daily','weekly','daily_weekly'],settings.periods?.length===1?settings.periods[0]:'daily_weekly')+check('include_open','includeOpen')+check('schedule_enabled','enablePeriodic',settings.schedule_enabled)+`<p>${l('organizeCostNote')}</p>`;
      } else if(action==='models.save'){
        const model=data.models.find(m=>m.kind===intent.kind),c=model?.config||{};intent.revision=model?.revision||0;
        fields=`<p>${l(intent.kind==='organizer'?'organizerPurpose':'embedderPurpose')}</p><fieldset><legend>${l('modelEndpoint')}</legend>`+check('enabled','enableModel',c.enabled)+select('protocol','protocol',['openai_compatible','ollama'],c.protocol||'openai_compatible')+field('base_url','baseUrl',{value:c.base_url||'',max:2048})+`<p class="muted">${l('modelUrlHelp')}</p>`+field('model','modelName',{value:c.model||''})+
          field('api_key','apiKey',{type:'password',required:false,max:16384})+check('remove_key','removeKey')+`<p class="muted">${l('keyWriteOnlyNote')}</p>`+discoveryBlock()+(intent.kind==='embedder'?field('dimensions','dimensions',{type:'number',value:c.dimensions||'',min:1,upper:65536,step:1})+`<p>${l('dimensionsHelp')}</p>`:'')+`</fieldset><fieldset><legend>${l('modelLimits')}</legend>`+
          ((data.processing??getData().processing)?.quotas?.[intent.kind]?.mode==='manual'?`<input type="hidden" name="daily_requests" value="${esc(c.daily_requests||100)}"><p class="muted">${l('dailyLimitInCallLimits')}</p>`
            :field('daily_requests','dailyRequests',{type:'number',value:c.daily_requests||100,min:1,upper:10000,step:1}))+field('batch_size','batchSize',{type:'number',value:c.batch_size||5,min:1,upper:20,step:1})+
          (intent.kind==='organizer'?field('output_tokens','outputTokens',{type:'number',value:c.output_tokens||4096,min:128,upper:32768,step:1}):`<input type="hidden" name="output_tokens" value="${esc(c.output_tokens||4096)}">`)+field('profile_revision','modelRevision',{value:c.profile_revision||'1',max:160})+
          (intent.kind==='organizer'?check('native_schema','nativeSchema',c.native_schema!==false):'')+`</fieldset><fieldset><legend>${l('modelPrivacy')}</legend>`+check('egress_approved','approveEgress',c.egress_approved)+(intent.kind==='embedder'?check('query_approved','approveQuery',c.query_approved):'')+`<p>${l('modelSecretExcluded')}</p></fieldset>`;
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
      } else if(action==='security.password')fields=field('new_password','newPassword',{type:'password',max:1024})+field('password_confirm','passwordConfirm',{type:'password',max:1024})+reauth(true);
      else if(action==='security.totp.begin'||action==='security.recovery_codes')fields=reauth(true);
      else if(action==='devices.revoke'){const device=(data.core_connections||[]).find(c=>c.agent_instance_id===intent.id);
        fields=`<p>${l('connRevokeDeviceNote')}</p><p><strong>${esc(device?.agent_id||'')}</strong> ${esc(device?.label||'')} <code>${esc(intent.id)}</code></p>`+reauth();}
      else if(action==='storage.import')fields=`<p>${l('portableNote')}</p><label>${l('file')}<input type="file" name="file" accept="application/json,.json" required></label><label class="check-field"><input type="checkbox" name="confirm_import" required>${l('confirmImport')}</label>`;
      else if(action==='hosts.set'){const d=getData(),h=[...(d.hosts||[]),...(d.system_hosts||[])].find(x=>x.hostname===intent.id);
        fields=(h?`<p><code>${esc(h.hostname)}</code></p><input type="hidden" name="hostname" value="${esc(h.hostname)}">`:field('hostname','hostName',{max:253}))+field('address','hostAddress',{value:h?.address||'',max:64})+`<p class="muted">${l('hostSetNote')}</p>`+reauth();}
      else if(action==='hosts.remove')fields=`<p><code>${esc(intent.id)}</code></p><p>${l('hostRemoveNote')}</p>`+reauth();
      else if(action==='jobs.cancel_batch'){const b=(getData().batches||[]).find(x=>x.batch_id===intent.id);
        fields=`<p>取消这一批里还没完成的 ${esc(b?b.jobs-b.succeeded-b.cancelled-b.failed:'')} 个任务；已经完成的结果保留，已发出的请求无法撤回。</p>`;}
      else if(action==='jobs.retry'&&button.dataset.stale==='true'){modal.querySelector('h2').textContent=t('rescheduleWithCategories');fields=`<p>${l('rescheduleNote')}</p><code>${esc(intent.id)}</code>`;}
      else fields=`<p>${l(action==='storage.export'?'exportPrivacyNote':action==='models.test'?'probeCostNote':'confirmAction')}</p><code>${esc(intent.id||intent.kind||'')}</code>`;
      if(seq!==sequence||!isActive())return;content.innerHTML=`<form id="operation-form">${fields}${modalActions(action==='storage.export'?'export':'confirm')}</form>`;if(intent.expired||intent.empty)content.querySelector('#operation-form>.actions:last-of-type button.primary')?.remove();syncAppearance();discoveryReset();
      // What each control showed when rendered. HTML normalizes initial values (a text input drops CR/LF, a
      // textarea drops one leading newline), so an untouched field is detected against this, not the stored text.
      intent.baseline=Object.fromEntries([...content.querySelectorAll('#operation-form input[name],#operation-form textarea[name],#operation-form select[name]')].filter(c=>c.type!=='checkbox').map(c=>[c.name,c.value]));
      content.querySelector('input,textarea,select,button')?.focus();
    }catch(e){if(seq!==sequence||!isActive())return;content.innerHTML=`<p role="alert">${esc(t(e.message))}</p><button type="button" data-operation-close>${l('close')}</button>`;}
  }
  function payload(fd){const a=intent.action,p={};
    if(ownerActions.includes(a)){
      if(a==='features.save'){const o=intent.owner,section=intent.section||'flags';p.expected_revision=intent.revision;
        const edited=section==='flags'?(intent.flags||Object.keys(ownerLabels)):[];
        p.flags=Object.fromEntries(Object.keys(ownerLabels).map(k=>[k,edited.includes(k)?(intent.target?intent.target==='on':fd.has(k)):o.flags[k]===true]));
        p.read_policy=section==='read_policy'?fd.get('read_policy'):o.preferences.read_policy;p.retrieval_mode=section==='retrieval'?fd.get('retrieval_mode'):o.preferences.retrieval_mode;}
      else if(a==='schedule.save')Object.assign(p,{expected_revision:intent.revision,enabled:intent.owner.schedule.enabled===true&&(intent.owner.schedule.kinds||[]).some(k=>k!=='vector'),kinds:(intent.owner.schedule.kinds||[]).filter(k=>k!=='vector'),interval_minutes:Number(fd.get('interval_minutes')),max_items:Number(fd.get('max_items')),budget:Number(fd.get('budget'))});
      else if(a==='processing.preview'){Object.assign(p,{kind:fd.get('kind'),limit:Number(fd.get('limit')),budget:Number(fd.get('budget'))});for(const k of ['from','to'])if(fd.get(k))p[k]=fd.get(k);}
      else if(a==='processing.clear'){}
      else {p.run_id=intent.id;if(['processing.start','processing.resume'].includes(a))p.digest=intent.run.manifest_digest;}
      if(['features.save','schedule.save','processing.start','processing.resume'].includes(a)){p.current_password=fd.get('current_password');}return p;
    }
    if(a==='memory.create'){Object.assign(p,{content:fd.get('content'),memory_type:fd.get('memory_type'),scope:fd.get('scope')},traitValues(fd));if(fd.get('topic'))p.topic=fd.get('topic');if(p.scope!=='user')p[`${p.scope}_id`]=fd.get('target_id');}
    else if(a.startsWith('memory.batch_')){p.items=intent.items;if(fd.get('reason'))p.reason=fd.get('reason');}
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
    else if(a==='tunnel.add')Object.assign(p,{name:String(fd.get('name')||'').trim(),token:String(fd.get('token')||'').trim()});
    else if(a==='tunnel.token')Object.assign(p,{id:intent.id,token:String(fd.get('token')||'').trim()});
    else if(a==='tunnel.reapply'||a==='tunnel.remove')p.id=intent.id;
    else if(a.startsWith('memory.')){Object.assign(p,{memory_id:intent.id,revision:intent.meta.revision});if(a==='memory.correct'){p.content=fd.get('content');p.topic=fd.get('topic')||null;p.memory_type=intent.meta.memory_type;Object.assign(p,traitValues(fd));}if(fd.get('reason'))p.reason=fd.get('reason');}
    else if(a==='jobs.schedule')Object.assign(p,{type:fd.get('type'),timezone:fd.get('timezone'),periods:fd.get('periods')==='daily_weekly'?['daily','weekly']:[fd.get('periods')],include_open:fd.has('include_open'),schedule_enabled:fd.has('schedule_enabled'),settings_revision:intent.settings_revision});
    else if(a==='jobs.cancel'||a==='jobs.retry')p.job_id=intent.id;
    else if(a==='jobs.cancel_batch')p.batch_id=intent.id;
    else if(a==='hosts.set')Object.assign(p,{hostname:String(fd.get('hostname')||'').trim(),address:String(fd.get('address')||'').trim()});
    else if(a==='hosts.remove')p.hostname=intent.id;
    else if(a==='models.save'){
      p.kind=intent.kind;p.expected_revision=intent.revision;p.config={enabled:fd.has('enabled'),protocol:fd.get('protocol'),base_url:fd.get('base_url'),model:fd.get('model'),profile_revision:fd.get('profile_revision'),daily_requests:Number(fd.get('daily_requests')),output_tokens:Number(fd.get('output_tokens')),batch_size:Number(fd.get('batch_size')),egress_approved:fd.has('egress_approved'),query_approved:fd.has('query_approved'),native_schema:intent.kind==='organizer'?fd.has('native_schema'):true};if(intent.kind==='embedder')p.config.dimensions=Number(fd.get('dimensions'));if(fd.get('api_key'))p.api_key=fd.get('api_key');if(fd.has('remove_key'))p.remove_key=true;
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
    if(fd.has('current_password')){p.current_password=fd.get('current_password');if(fd.has('otp'))p.otp=fd.get('otp');}return p;
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
  async function loadBatch(box,offset){if(!box)return;
    try{const d=await api('jobs',{batch_id:box.dataset.batchJobs,offset,limit:BATCH_PAGE});if(box.isConnected&&isActive()){box.innerHTML=batchJobsView(d);syncAppearance();}}
    catch(e){if(box.isConnected&&e.name!=='AbortError')box.innerHTML=`<p class="muted" role="status">${esc(t(e.message))}</p>`;}}
  document.addEventListener('click',event=>{const b=event.target.closest('[data-console-action]');if(b){void begin(b.dataset.consoleAction,b);return;}if(event.target.closest('[data-operation-close]')&&!working){modal.close();restoreFocus();returnFocus=null;}
    const inspection=event.target.closest('[data-inspect]');if(inspection){const keys={models:'kind',connections:'grant_id',core_connections:'credential_id',sessions:'session_id'};const key=keys[inspection.dataset.inspect];if(!key)return;const item=getData()[inspection.dataset.inspect]?.find(row=>String(row[key])===inspection.dataset.id);if(item){open('inspectDetails');inspectResult(item);}return;}
    const toggle=event.target.closest('[data-batch-toggle]');if(toggle){const row=toggle.closest('tr'),open=row.nextElementSibling?.classList.contains('batch-detail');
      if(open){row.nextElementSibling.remove();toggle.setAttribute('aria-expanded','false');return;}
      const detail=document.createElement('tr');detail.className='batch-detail';detail.innerHTML=`<td colspan="5"><div data-batch-jobs="${esc(toggle.dataset.batchToggle)}"><p class="muted">加载中…</p></div></td>`;
      row.after(detail);toggle.setAttribute('aria-expanded','true');void loadBatch(detail.querySelector('[data-batch-jobs]'),0);return;}
    const batchPage=event.target.closest('[data-batch-page]');if(batchPage){void loadBatch(batchPage.closest('[data-batch-jobs]'),Number(batchPage.dataset.batchPage));return;}
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

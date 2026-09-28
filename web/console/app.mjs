import {actionButton,actionPage,mountActions,canAct} from './actions.mjs';
import {translate as t, syncAppearance} from './appearance.mjs';
import {icon, overviewView, appearanceView} from './visuals.mjs';
import {SessionState} from './session-state.mjs';
import {mountConnections} from './connections.mjs';
const root=document.getElementById('console-root'),dialog=document.getElementById('memory-dialog'),detail=document.getElementById('memory-content');
const state=new SessionState(document.body.dataset.account);
const page=document.body.dataset.page;
let capabilities={enabled:false,writable:false},actions,connections;
let requestSequence=0,detailSequence=0,currentData=null,detailData=null,lastFocus=null,query='',searchMode='lexical',offset=0,detailKind='memory';
let category='',status='',detailStack=[];
function readLocation(){const p=new URLSearchParams(location.search);query=p.get('query')||'';searchMode=p.get('mode')||'lexical';category=p.get('category')||'';status=p.get('status')||'';const n=Number(p.get('offset')||0);offset=Number.isSafeInteger(n)&&n>=0?n:0;}
readLocation();
function saveLocation(){const p=new URLSearchParams();if(query)p.set('query',query);if(searchMode!=='lexical')p.set('mode',searchMode);if(category)p.set('category',category);if(status)p.set('status',status);if(offset)p.set('offset',offset);history.replaceState(null,'',location.pathname+(p.size?'?'+p:''));}
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const l=(key,tag='span')=>`<${tag} data-i18n="${key}">${esc(t(key))}</${tag}>`;
const tag=v=>`<span class="tag">${esc(v)}</span>`;
const disabled=key=>`<button type="button" disabled title="${esc(t('blocked'))}" data-i18n="${key}">${esc(t(key))}</button>`;
const date=value=>value?new Date(typeof value==='number'&&value<1e12?value*1000:value).toLocaleString(document.documentElement.lang):'—';
function clear() {actions?.clear();connections?.clear();state.clear();requestSequence++;detailSequence++;currentData=null;detailData=null;detailStack=[];query='';category='';status='';searchMode='lexical';offset=0;detail.replaceChildren();dialog.close();root.replaceChildren();document.body.removeAttribute('data-csrf');for(const input of document.querySelectorAll('input'))input.value='';}
async function api(view,params={}) {
 const ticket=state.ticket();try {
   const response=await fetch(`/console-api/${view}?${new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined))}`,{credentials:'same-origin',cache:'no-store',signal:ticket.controller.signal});
   if(response.status===401){clear();location.replace('/login');throw new Error('SESSION_REQUIRED');}
   const data=await response.json();if(!state.accepts(ticket))throw new Error('STALE_ACCOUNT');
   if(!response.ok)throw new Error(data.error_code||'UNAVAILABLE');return data;
 } finally {state.finish(ticket);}
}
const empty=()=>`<div class="empty"><span class="empty-icon">${icon('memories')}</span>${l('empty','p')}</div>`;
function memoryRows(rows=[]) {return rows.length?rows.map(m=>`<div class="memory-row"><span class="glyph" aria-hidden="true">${icon('memories')}</span><button type="button" class="memory-link" data-memory="${esc(m.memory_id)}"><span>${esc([...String(m.content||m.summary||m.memory_id)].slice(0,160).join(''))}</span><small>${esc(m.memory_type||'')} · ${esc(date(m.created_at))}</small></button>${tag(m.status||'active')}<span aria-hidden="true">↗</span></div>`).join(''):empty();}
// Keep the overview compact; the library gets a real column grid with only
// fields returned by the owner-scoped API (no invented revision/grant badges).
function memoryTable(rows=[]) {
 if(!rows.length)return empty();
 return `<div class="table-scroll"><table class="memory-table"><colgroup><col class="memory-content-col"><col class="memory-category-col"><col class="memory-state-col"><col class="memory-date-col"></colgroup><thead><tr><th>${l('memories')}</th><th>${l('category')}</th><th>${l('status')}</th><th>${l('created')}</th></tr></thead><tbody>${rows.map(m=>`<tr><td><div class="library-memory"><span class="glyph" aria-hidden="true">${icon('memories')}</span><button type="button" class="memory-link" data-memory="${esc(m.memory_id)}"><span class="memory-preview">${esc([...String(m.content||m.summary||m.memory_id)].slice(0,160).join(''))}</span><small>${esc(t(m.memory_type||'fact'))}</small></button></div></td><td><span class="category-pill">${esc(t(m.category||'uncategorized'))}</span></td><td><span class="tag lifecycle-tag" data-status="${esc(m.status||'active')}">${esc(t(m.status||'active'))}</span></td><td class="memory-date">${esc(date(m.created_at))}</td></tr>`).join('')}</tbody></table></div>`;
}
function table(rows,columns){return rows?.length?`<div class="table-scroll"><table><thead><tr>${columns.map(([key,label])=>`<th data-i18n="${label||key}">${esc(t(label||key))}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${columns.map(([key])=>`<td>${esc(r[key]??'—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`:empty();}
const pagination=data=>`<div class="pagination">${offset?`<button type="button" data-offset="${Math.max(0,offset-(data.limit||25))}">${l('previous')}</button>`:''}${data.next_offset!=null?`<button type="button" data-offset="${data.next_offset}">${l('next')}</button>`:''}</div>`;
const options=(values,current)=>values.map(([value,key])=>`<option value="${esc(value)}" ${value===current?'selected':''} data-i18n="${esc(key)}">${esc(t(key))}</option>`).join('');
function policy(note='blockedNote',items=[]) {if(canAct(capabilities,'jobs.schedule')&&items.includes('organize'))return actionButton('jobs.schedule','organize',{type:'classification'});return `<div class="policy-box"><span class="tag">${l('blocked')}</span>${l(note,'p')}<div class="actions">${items.map(disabled).join('')}</div></div>`;}
function summaryRow(s){const content=`<strong>${esc(t(s.category))}</strong><small>${esc(s.summary_id)}</small><small>${l('revisions')} ${s.revision} · ${l('sourceCount')} ${s.coverage}</small>`;
 return `<div class="memory-row">${s.status==='current'?`<button type="button" class="memory-link" data-summary="${esc(s.summary_id)}" data-revision="${s.revision}">${content}</button>`:`<div class="memory-link">${content}<small>${l('summaryNotCurrent')}</small><a href="/app/memories?category=${encodeURIComponent(s.category)}">${l('browseMemories')}</a></div>`}${tag(t(s.status))}</div>`;}
function render(data) {
 const managing=capabilities.operator&&capabilities.management?.[page];
 const pageActions={memories:['memory.create','memory.correct'],summaries:['jobs.schedule'],jobs:['jobs.schedule','jobs.cancel'],models:['models.save'],connections:['oauth.revoke','connections.create'],security:['security.password','security.sessions.revoke_others'],storage:['storage.export','storage.import']};
 const interactive=page==='appearance'||(pageActions[page]||[]).some(a=>canAct(capabilities,a));
 let html='';const heading=`<div class="page-heading"><div><p class="eyebrow" data-i18n="workspaceLabel">${esc(t('workspaceLabel'))}</p>${l(page==='overview'?'hero':page,'h1')}${l(page==='overview'?'heroNote':`pageNote_${page}`,'p')}</div>${page==='overview'?`<a class="button browse-link" href="/app/memories">${icon('search')}${l('browseMemories')}</a>`:`<div class="page-heading-actions"><span class="tag">${l(managing?'operatorManagement':interactive?'interactive':'readOnly')}</span>${page==='memories'&&canAct(capabilities,'memory.create')?actionButton('memory.create','newMemory'):''}</div>`}</div>`;
 if(page==='overview')html=overviewView(data,{t,memoryRows});
 else if(page==='memories')html=`<form class="toolbar memory-filters" id="search-form"><label class="query-field">${l('query')}<span class="query-input">${icon('search')}<input name="query" value="${esc(query)}" maxlength="2000" autocomplete="off" data-i18n-placeholder="search" placeholder="${esc(t('search'))}"></span></label><label class="filter-mode">${l('searchMode')}<select name="search_mode">${options(['lexical','hybrid','semantic'].map(v=>[v,v]),searchMode)}</select></label><label class="filter-category">${l('category')}<select name="category">${options([['','allCategories'],...(capabilities.taxonomy?.categories||[]).map(v=>[v,v])],category)}</select></label><label class="filter-status">${l('status')}<select name="status">${options([['','allStatuses'],...['active','superseded','retracted'].map(v=>[v,v])],status)}</select></label><button class="primary filter-submit" type="submit">${icon('search')}${l('search')}</button><button type="button" class="filter-reset" data-reset-filters>${l('resetFilters')}</button></form><section class="card memory-library">${new URLSearchParams(location.search).get('focus')==='sources'?`<p class="library-note">${l('inspectSourcesNote')}</p>`:''}${data.truncated||data.retrieval?.window_limited?`<p class="policy-box library-note">${l('boundedSearchNote')} (${esc(data.retrieval?.candidate_limit)})</p>`:''}<div id="memory-rows">${memoryTable(data.results)}</div><div class="library-footer"><p>${l('memoryCount')} · ${data.results?.length??0}${!canAct(capabilities,'memory.create')?` <span aria-hidden="true">/</span> ${l('readOnly')}`:''}</p>${pagination(data)}</div></section>`;
 else if(page==='summaries')html=`<div class="columns"><section class="card">${l('summaries','h2')}${data.summaries?.length?data.summaries.map(summaryRow).join(''):empty()}${pagination(data)}</section><section class="card">${l('category','h2')}${(data.categories||[]).map(c=>`<a class="category-link" href="/app/memories?category=${encodeURIComponent(c.category)}&amp;status=active"><span>${esc(t(c.category))}</span>${tag(c.count)}</a>`).join('')||empty()}${policy('blockedNote',['organize'])}</section></div>`;
 else if(page==='jobs')html=`<section class="card">${table(data.jobs,[['job_id','identity'],['job_type','scope'],['state','state'],['processed','complete'],['total','sourceCount'],['last_error_code','error']])}${policy('blockedNote',['organize'])}</section>`;
 else if(page==='security')html=`<div class="columns"><section class="card"><h2>${esc(data.username)}</h2><span class="tag">${l(data.mfa_verified?'passwordTotp':'pending')}</span>${l('securityNote','p')}<a href="/recover">${l('recover')} →</a></section><section class="card">${table(data.sessions?.map(s=>({...s,created:date(s.created),expires:date(s.expires)})),[['purpose','scope'],['created','created'],['expires','state']])}</section></div>`;
 else if(page==='audit')html=`<section class="card"><button type="button" data-retry>${l('refresh')}</button>${table([...data.entries||[],...(data.core_entries||[]).map(e=>({...e,created:e.created_at}))].map(e=>({...e,created:date(e.created)})),[['action','scope'],['outcome','state'],['created','created'],['audit_id','operationId']])}${pagination(data)}</section>`;
 else if(page==='storage')html=`<section class="card">${l('storageNote','p')}${table(Object.entries(data.counts||{}).map(([kind,count])=>({kind,count})),[['kind','scope'],['count','memoryCount']])}${policy('storageNote',['export','restore'])}</section>`;
 else if(page==='appearance')html=appearanceView(t);
 else if(['models','invitations','accounts'].includes(page))html=`<section class="card">${policy(page==='models'?'modelsNote':'platformNote',[page==='models'?'configure':page==='invitations'?'issue':'manage'])}</section>`;
 const implementation=actionPage(page,data,capabilities,connections?.query());if(implementation!==null)html=implementation;
 root.innerHTML=heading+(capabilities.unavailable?`<p class="policy-box" role="status">${l('capabilitiesUnavailable')}</p>`:'')+html;
 syncAppearance();
}
async function load() {
 const sequence=++requestSequence;
 if(page==='appearance'||['invitations','accounts'].includes(page)&&(!capabilities.operator||!(capabilities.management?.[page]??capabilities.enabled))){currentData={};render(currentData);return;}
 try {
   const data=await api(page,page==='connections'?connections.query():page==='memories'?{offset,limit:25,...(query?{query,mode:searchMode}:{}),...(category?{category}:{}),...(status?{status}:{})}:['jobs','summaries','audit'].includes(page)?{offset,limit:25}:{});
   if(sequence!==requestSequence||!state.account)return;currentData=data;render(data);
 }catch(e){if(sequence!==requestSequence||!state.account||e.name==='AbortError')return;
   root.innerHTML=`<div class="page-heading">${l(page,'h1')}</div><div class="card" role="alert">${l(e.message==='BLOCKED_POLICY'?'blocked':'unavailable','h2')}${l('errorNote','p')}<button type="button" data-retry>${l('retry')}</button></div>`;}
}
function showDetail(data) {
 detail.innerHTML=`<div class="detail-meta">${tag(data.memory?.memory_type)}<span class="tag">${l('revisions')} ${data.revision}</span>${tag(data.memory?.status)}</div><div class="body-content">${esc(data.memory?.content)}</div><p>${l('contentRange')} ${data.content_offset+1}–${data.content_offset+[...String(data.memory?.content||'')].length} / ${data.content_length} ${data.content_complete?l('endOfContent'):''}</p><div class="pagination">${detailStack.length>1?`<button type="button" data-detail-back>${l('previous')}</button>`:''}${data.next_request?`<button type="button" data-detail-next>${l('next')}</button>`:''}</div>${l('sources','h3')}${(data.source_manifest?.sources||[]).map(s=>`<div class="detail-source"><strong>${esc(s.source_kind||s.source_id)}</strong><small>${esc(s.source_id)}</small><details><summary>${l('sourceMetadata')}</summary><pre>${esc(JSON.stringify(s,null,2))}</pre></details></div>`).join('')||empty()}${data.next_source_request?`<button type="button" data-source-next>${l('nextSources')}</button>`:''}<div class="actions">${[['memory.correct','editMemory'],['memory.retract','retractMemory'],['memory.classify','classifyMemory'],['memory.sensitivity','sensitivity'],['memory.visibility','webVisibility']].filter(([a])=>canAct(capabilities,a)).map(([a,k])=>actionButton(a,k,{id:data.memory.memory_id})).join('')}</div>`;
 const lifecycle=data.memory?.lifecycle||{};
 for(const [id,key] of [[lifecycle.supersedes_memory_id,'previousRecord'],[lifecycle.superseded_by_memory_id,'replacementRecord']])if(id){const b=document.createElement('button');b.type='button';b.dataset.memory=id;b.textContent=t(key);detail.append(b);}
 if(data.memory?.status!=='active')detail.querySelector('.actions')?.remove();
}
function beginDetail(kind,title) {
 detailKind=kind;
 detailStack=[];
 if(!dialog.open)lastFocus=document.activeElement;
 detail.innerHTML=l('loading','p');
 const heading=document.getElementById('detail-title');heading.dataset.i18n=title;heading.textContent=t(title);
 if(!dialog.open)dialog.showModal();
}
async function openMemory(params,first=false,back=false) {
 const sequence=++detailSequence;
 if(first)beginDetail('memory','detail');
 try{const data=await api('memory',params);if(!state.account||sequence!==detailSequence)return;detailData=data;if(!back)detailStack.push({kind:'memory',params:{...params,revision:data.revision,source_version:data.source_manifest?.source_version}});showDetail(data);}
 catch(e){if(!state.account||sequence!==detailSequence||e.name==='AbortError')return;detailData=null;detail.innerHTML=`<div role="alert">${l(/VERSION_CHANGED|MANIFEST_CHANGED/.test(e.message)?'changed':'unavailable','p')}</div>`;}
}
async function openSummary(params,first=false,back=false) {
 const sequence=++detailSequence;
 if(first)beginDetail('summary','summaries');
 try {
   const data=await api('summary',params);if(!state.account||sequence!==detailSequence)return;detailData=data;if(!back)detailStack.push({kind:'summary',params});
   const summary=data.results[0];
   detail.innerHTML=`<div class="detail-meta">${tag(summary.category)}${l('revisions')} ${summary.revision}</div>${summary.claims.map(c=>`<article class="detail-source"><p class="body-content">${esc(c.quote)}</p><button type="button" data-memory="${esc(c.memory_id)}" data-revision="${c.revision}">${l('sources')} · ${esc(c.memory_id)}</button></article>`).join('')||empty()}${l(data.complete?'endOfContent':'next','p')}${detailStack.length>1?`<button type="button" data-detail-back>${l('previous')}</button>`:''}${data.next_request?`<button type="button" data-detail-next>${l('next')}</button>`:''}`;
 }catch(e){if(!state.account||sequence!==detailSequence||e.name==='AbortError')return;detailData=null;detail.innerHTML=`<div role="alert">${l(/VERSION_CHANGED|MANIFEST_CHANGED/.test(e.message)?'changed':'unavailable','p')}</div>`;}
}
document.addEventListener('click',event=>{
 const memory=event.target.closest('[data-memory]');if(memory){void openMemory({memory_id:memory.dataset.memory,content_limit:1024,include_history:'true',...(memory.dataset.revision?{revision:memory.dataset.revision}:{})},true);return;}
 const summary=event.target.closest('[data-summary]');if(summary){void openSummary({summary_id:summary.dataset.summary,revision:summary.dataset.revision},true);return;}
 if(event.target.closest('[data-close]')){dialog.close();return;}
 if(event.target.closest('[data-detail-back]')&&detailStack.length>1){detailStack.pop();const prior=detailStack.at(-1);void (prior.kind==='summary'?openSummary:openMemory)(prior.params,false,true);return;}
 if(event.target.closest('[data-detail-next]')&&detailData?.next_request)void (detailKind==='summary'?openSummary:openMemory)(detailData.next_request);
 if(event.target.closest('[data-source-next]')&&detailData?.next_source_request)void openMemory(detailData.next_source_request);
 const pagination=event.target.closest('[data-offset]');if(pagination){offset=Number(pagination.dataset.offset);saveLocation();void load();}
 if(event.target.closest('[data-reset-filters]')){query='';category='';status='';searchMode='lexical';offset=0;saveLocation();void load();}
 if(event.target.closest('[data-retry]'))void load();
});
document.addEventListener('submit',event=>{
 if(event.target.id==='search-form'){event.preventDefault();const f=new FormData(event.target);query=String(f.get('query')||'');searchMode=String(f.get('search_mode')||'lexical');category=String(f.get('category')||'');status=String(f.get('status')||'');offset=0;saveLocation();void load();}
 if(event.target.action?.endsWith('/console-api/logout')){requestSequence++;detailSequence++;for(const c of state.controllers)c.abort();root.replaceChildren();detail.replaceChildren();dialog.close();currentData=null;detailData=null;}
});
dialog.addEventListener('close',()=>{detailSequence++;detailData=null;detailStack=[];detail.replaceChildren();lastFocus?.focus();lastFocus=null;});
window.addEventListener('pagehide',clear);
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
document.addEventListener('appearancechange',()=>{
 // Language changes translate chrome only; do not replace a form, drawer, user content or a pending request.
 document.title=`Mnemuron · ${t(page)}`;
 const mode=document.querySelector('[data-current-mode]');if(mode){mode.dataset.i18n=document.documentElement.dataset.mode;mode.textContent=t(mode.dataset.i18n);}
});

async function mutate(action,payload,operation_id) {
 const me=await api('me');if(me.account_id!==state.account){clear();location.replace('/login');throw new Error('STALE_ACCOUNT');}
 document.body.dataset.csrf=me.csrf;for(const input of document.querySelectorAll('input[name="csrf"]'))input.value=me.csrf;
 const ticket=state.ticket();try{
  const body=new URLSearchParams({csrf:me.csrf,account_id:state.account,action,operation_id,payload:JSON.stringify(payload)});
  const response=await fetch('/console-api/action',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'content-type':'application/x-www-form-urlencoded'},body,signal:ticket.controller.signal});
  const data=await response.json();if(!state.accepts(ticket))throw new Error('STALE_ACCOUNT');
  if(response.status===401){
    // Another tab may rotate the form CSRF. Confirm the session instead of logging
    // out a valid owner; never automatically replay a mutation.
    const refreshed=await api('me');if(refreshed.account_id!==state.account){clear();location.replace('/login');throw new Error('STALE_ACCOUNT');}
    throw new Error('CSRF_REFRESH_REQUIRED');
  }
  if(!response.ok)throw new Error(data.error_code||'UNAVAILABLE');
  if(data.login_required){clear();location.replace('/login');}
  return data;
 }finally{state.finish(ticket);}
}
actions=mountActions({api,mutate,getData:()=>currentData||{},getCaps:()=>capabilities,reload:async()=>{if(dialog.open)dialog.close();await load();},isActive:()=>!!state.account});
connections=mountConnections({api,mutate,getCaps:()=>capabilities,reload:load,isActive:()=>!!state.account});

try {
 const me=await api('me');if(me.account_id!==state.account){clear();location.replace('/login');}
 else{try{capabilities={...await api('capabilities'),security_version:me.security_version};}catch{capabilities={enabled:false,writable:false,unavailable:true};}for(const field of document.querySelectorAll('input[name="csrf"]'))field.value=me.csrf;await load();}
}catch(e){if(state.account)root.innerHTML=`<div class="card" role="alert">${l('unavailable','h2')}${l('errorNote','p')}</div>`;}

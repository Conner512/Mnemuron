import {actionButton,actionPage,mountActions} from './actions.mjs';
import {translate as t, syncAppearance} from './appearance.mjs';
import {icon, overviewView, appearanceView} from './visuals.mjs';
import {SessionState} from './session-state.mjs';
const root=document.getElementById('console-root'),dialog=document.getElementById('memory-dialog'),detail=document.getElementById('memory-content');
const state=new SessionState(document.body.dataset.account);
const page=document.body.dataset.page;
let capabilities={enabled:false,writable:false},actions;
let requestSequence=0,detailSequence=0,currentData=null,detailData=null,lastFocus=null,query='',searchMode='lexical',offset=0,detailKind='memory';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const l=(key,tag='span')=>`<${tag} data-i18n="${key}">${esc(t(key))}</${tag}>`;
const tag=v=>`<span class="tag">${esc(v)}</span>`;
const disabled=key=>`<button type="button" disabled title="${esc(t('blocked'))}" data-i18n="${key}">${esc(t(key))}</button>`;
const date=value=>value?new Date(typeof value==='number'&&value<1e12?value*1000:value).toLocaleString(document.documentElement.lang):'—';
function clear() {actions?.clear();state.clear();requestSequence++;detailSequence++;currentData=null;detailData=null;query='';searchMode='lexical';offset=0;detail.replaceChildren();dialog.close();root.replaceChildren();document.body.removeAttribute('data-csrf');for(const input of document.querySelectorAll('input'))input.value='';}
async function api(view,params={}) {
 const ticket=state.ticket();try {
   const response=await fetch(`/console-api/${view}?${new URLSearchParams(params)}`,{credentials:'same-origin',cache:'no-store',signal:ticket.controller.signal});
   if(response.status===401){clear();location.replace('/login');throw new Error('SESSION_REQUIRED');}
   const data=await response.json();if(!state.accepts(ticket))throw new Error('STALE_ACCOUNT');
   if(!response.ok)throw new Error(data.error_code||'UNAVAILABLE');return data;
 } finally {state.finish(ticket);}
}
const empty=()=>`<div class="empty"><span class="empty-icon">${icon('memories')}</span>${l('empty','p')}</div>`;
function memoryRows(rows=[]) {return rows.length?rows.map(m=>`<div class="memory-row"><span class="glyph" aria-hidden="true">${icon('memories')}</span><button type="button" class="memory-link" data-memory="${esc(m.memory_id)}"><span>${esc([...String(m.content||m.summary||m.memory_id)].slice(0,160).join(''))}</span><small>${esc(m.memory_type||'')} · ${esc(date(m.created_at))}</small></button>${tag(m.status||'active')}<span aria-hidden="true">↗</span></div>`).join(''):empty();}
function table(rows,columns){return rows?.length?`<table><thead><tr>${columns.map(([key,label])=>`<th data-i18n="${label||key}">${esc(t(label||key))}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${columns.map(([key])=>`<td>${esc(r[key]??'—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`:empty();}
function policy(note='blockedNote',items=[]) {if(capabilities.writable&&items.includes('organize'))return actionButton('jobs.schedule','organize',{type:'classification'});return `<div class="policy-box"><span class="tag">${l('blocked')}</span>${l(note,'p')}<div class="actions">${items.map(disabled).join('')}</div></div>`;}
function render(data) {
 let html='';const heading=`<div class="page-heading"><div><p class="eyebrow" data-i18n="workspaceLabel">${esc(t('workspaceLabel'))}</p>${l(page==='overview'?'hero':page,'h1')}${l(page==='overview'?'heroNote':`pageNote_${page}`,'p')}</div>${page==='overview'?`<a class="button browse-link" href="/app/memories">${icon('search')}${l('browseMemories')}</a>`:`<span class="tag">${l(capabilities.writable?'interactive':'readOnly')}</span>`}</div>`;
 if(page==='overview')html=overviewView(data,{t,memoryRows});
 else if(page==='memories')html=`<section class="card"><form class="toolbar" id="search-form"><label>${l('query')}<input name="query" value="${esc(query)}" maxlength="2000" autocomplete="off"></label><label>${l('searchMode')}<select name="search_mode">${['lexical','hybrid','semantic'].map(v=>`<option value="${v}" data-i18n="${v}" ${v===searchMode?'selected':''}>${esc(t(v))}</option>`).join('')}</select></label><button class="primary" type="submit" data-i18n="search">${esc(t('search'))}</button>${capabilities.writable?actionButton('memory.create','newMemory'):disabled('newMemory')}</form><div id="memory-rows">${memoryRows(data.results)}</div><div class="pagination">${offset?`<button type="button" data-offset="${Math.max(0,offset-25)}">${l('previous')}</button>`:''}${data.next_offset!==null&&data.next_offset!==undefined?`<button type="button" data-offset="${data.next_offset}">${l('next')}</button>`:''}</div></section>`;
 else if(page==='summaries')html=`<div class="columns"><section class="card">${l('summaries','h2')}${data.summaries?.length?data.summaries.map(s=>`<div class="memory-row"><button type="button" class="memory-link" data-summary="${esc(s.summary_id)}" data-revision="${s.revision}"><strong>${esc(s.category)}</strong><small>${esc(s.summary_id)}</small><small>${l('revisions')} ${s.revision} · ${l('sourceCount')} ${s.coverage}</small></button>${tag(s.status)}</div>`).join(''):empty()}</section><section class="card">${table(data.categories,[['category','scope'],['count','memoryCount']])}${policy('blockedNote',['organize'])}</section></div>`;
 else if(page==='jobs')html=`<section class="card">${table(data.jobs,[['job_id','identity'],['job_type','scope'],['state','state'],['processed','complete'],['total','sourceCount'],['last_error_code','error']])}${policy('blockedNote',['organize'])}</section>`;
 else if(page==='connections')html=`<section class="card">${table(data.connections?.map(c=>({...c,expires:date(c.expires)})),[['client_id','identity'],['expires','state']])}${l('connections','h2')}${table(data.core_connections,[['label','identity'],['agent_id','scope'],['last_used_at','created']])}${policy('blockedNote',['revoke'])}${l('consentNote','p')}</section>`;
 else if(page==='security')html=`<div class="columns"><section class="card"><h2>${esc(data.username)}</h2><span class="tag">${l(data.mfa_verified?'passwordTotp':'pending')}</span>${l('securityNote','p')}<a href="/recover">${l('recover')} →</a></section><section class="card">${table(data.sessions?.map(s=>({...s,created:date(s.created),expires:date(s.expires)})),[['purpose','scope'],['created','created'],['expires','state']])}</section></div>`;
 else if(page==='audit')html=`<section class="card">${table([...data.entries||[],...(data.core_entries||[]).map(e=>({...e,created:e.created_at}))].map(e=>({...e,created:date(e.created)})),[['action','scope'],['outcome','state'],['created','created']])}</section>`;
 else if(page==='storage')html=`<section class="card">${l('storageNote','p')}${table(Object.entries(data.counts||{}).map(([kind,count])=>({kind,count})),[['kind','scope'],['count','memoryCount']])}${policy('storageNote',['export','restore'])}</section>`;
 else if(page==='appearance')html=appearanceView(t);
 else if(['models','invitations','accounts'].includes(page))html=`<section class="card">${policy(page==='models'?'modelsNote':'platformNote',[page==='models'?'configure':page==='invitations'?'issue':'manage'])}</section>`;
 const implementation=actionPage(page,data,capabilities);if(implementation!==null)html=implementation;
 root.innerHTML=heading+html;
 syncAppearance();
}
async function load() {
 const sequence=++requestSequence;
 if(page==='appearance'||!capabilities.enabled&&['models','invitations','accounts'].includes(page)||!capabilities.operator&&['invitations','accounts'].includes(page)){currentData={};render(currentData);return;}
 try {
   const data=await api(page,page==='memories'?query?{query,mode:searchMode}:{offset}:{});
   if(sequence!==requestSequence||!state.account)return;currentData=data;render(data);
 }catch(e){if(sequence!==requestSequence||!state.account||e.name==='AbortError')return;
   root.innerHTML=`<div class="page-heading">${l(page,'h1')}</div><div class="card" role="alert">${l(e.message==='BLOCKED_POLICY'?'blocked':'unavailable','h2')}${l('errorNote','p')}<button type="button" data-retry>${l('retry')}</button></div>`;}
}
function showDetail(data) {
 detail.innerHTML=`<div class="detail-meta">${tag(data.memory?.memory_type)}<span class="tag">${l('revisions')} ${data.revision}</span>${tag(data.memory?.status)}</div><div class="body-content">${esc(data.memory?.content)}</div><p>${data.content_complete?l('complete'):`${data.content_offset} / ${data.content_length}`}</p><div class="pagination">${data.next_request?`<button type="button" data-detail-next>${l('next')}</button>`:''}</div>${l('sources','h3')}${(data.source_manifest?.sources||[]).map(s=>`<div class="detail-source"><strong>${esc(s.source_kind||s.source_id)}</strong><small>${esc(s.source_id)}</small><pre>${esc(JSON.stringify(s,null,2))}</pre></div>`).join('')||empty()}${data.next_source_request?`<button type="button" data-source-next>${l('next')}</button>`:''}${capabilities.writable?`<div class="actions">${[['memory.correct','editMemory'],['memory.retract','retractMemory'],['memory.classify','classifyMemory'],['memory.sensitivity','sensitivity'],['memory.visibility','webVisibility']].map(([a,k])=>actionButton(a,k,{id:data.memory.memory_id})).join('')}</div>`:''}`;
}
function beginDetail(kind,title) {
 detailKind=kind;
 if(!dialog.open)lastFocus=document.activeElement;
 detail.innerHTML=l('loading','p');
 const heading=document.getElementById('detail-title');heading.dataset.i18n=title;heading.textContent=t(title);
 if(!dialog.open)dialog.showModal();
}
async function openMemory(params,first=false) {
 const sequence=++detailSequence;
 if(first)beginDetail('memory','detail');
 try{const data=await api('memory',params);if(!state.account||sequence!==detailSequence)return;detailData=data;showDetail(data);}
 catch(e){if(!state.account||sequence!==detailSequence||e.name==='AbortError')return;detailData=null;detail.innerHTML=`<div role="alert">${l(/VERSION_CHANGED|MANIFEST_CHANGED/.test(e.message)?'changed':'unavailable','p')}</div>`;}
}
async function openSummary(params,first=false) {
 const sequence=++detailSequence;
 if(first)beginDetail('summary','summaries');
 try {
   const data=await api('summary',params);if(!state.account||sequence!==detailSequence)return;detailData=data;
   const summary=data.results[0];
   detail.innerHTML=`<div class="detail-meta">${tag(summary.category)}${l('revisions')} ${summary.revision}</div>${summary.claims.map(c=>`<article class="detail-source"><p class="body-content">${esc(c.quote)}</p><button type="button" data-memory="${esc(c.memory_id)}" data-revision="${c.revision}">${l('sources')} · ${esc(c.memory_id)}</button></article>`).join('')||empty()}${l(data.complete?'complete':'next','p')}${data.next_request?`<button type="button" data-detail-next>${l('next')}</button>`:''}`;
 }catch(e){if(!state.account||sequence!==detailSequence||e.name==='AbortError')return;detailData=null;detail.innerHTML=`<div role="alert">${l(/VERSION_CHANGED|MANIFEST_CHANGED/.test(e.message)?'changed':'unavailable','p')}</div>`;}
}
document.addEventListener('click',event=>{
 const memory=event.target.closest('[data-memory]');if(memory){void openMemory({memory_id:memory.dataset.memory,content_limit:1024,include_history:'true',...(memory.dataset.revision?{revision:memory.dataset.revision}:{})},true);return;}
 const summary=event.target.closest('[data-summary]');if(summary){void openSummary({summary_id:summary.dataset.summary,revision:summary.dataset.revision},true);return;}
 if(event.target.closest('[data-close]')){dialog.close();return;}
 if(event.target.closest('[data-detail-next]')&&detailData?.next_request)void (detailKind==='summary'?openSummary:openMemory)(detailData.next_request);
 if(event.target.closest('[data-source-next]')&&detailData?.next_source_request)void openMemory(detailData.next_source_request);
 const pagination=event.target.closest('[data-offset]');if(pagination){offset=Number(pagination.dataset.offset);void load();}
 if(event.target.closest('[data-retry]'))void load();
});
document.addEventListener('submit',event=>{
 if(event.target.id==='search-form'){event.preventDefault();query=String(new FormData(event.target).get('query')||'');searchMode=String(new FormData(event.target).get('search_mode')||'lexical');offset=0;void load();}
 if(event.target.action?.endsWith('/console-api/logout')){requestSequence++;detailSequence++;for(const c of state.controllers)c.abort();root.replaceChildren();detail.replaceChildren();dialog.close();currentData=null;detailData=null;}
});
dialog.addEventListener('close',()=>{detailSequence++;detailData=null;detail.replaceChildren();lastFocus?.focus();lastFocus=null;});
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

try {
 const me=await api('me');if(me.account_id!==state.account){clear();location.replace('/login');}
 else{try{capabilities=await api('capabilities');}catch{}for(const field of document.querySelectorAll('input[name="csrf"]'))field.value=me.csrf;await load();}
}catch(e){if(state.account)root.innerHTML=`<div class="card" role="alert">${l('unavailable','h2')}${l('errorNote','p')}</div>`;}

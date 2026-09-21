import {translate as t} from './appearance.mjs';
import {SessionState} from './session-state.mjs';
const root=document.getElementById('console-root'),dialog=document.getElementById('memory-dialog'),detail=document.getElementById('memory-content');
const state=new SessionState(document.body.dataset.account);
const page=document.body.dataset.page;
let requestSequence=0,detailSequence=0,currentData=null,detailData=null,lastFocus=null,query='',offset=0,detailKind='memory';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const l=(key,tag='span')=>`<${tag} data-i18n="${key}">${esc(t(key))}</${tag}>`;
const tag=v=>`<span class="tag">${esc(v)}</span>`;
const disabled=key=>`<button type="button" disabled title="${esc(t('blocked'))}" data-i18n="${key}">${esc(t(key))}</button>`;
const date=value=>value?new Date(typeof value==='number'?value*1000:value).toLocaleString(document.documentElement.lang):'—';
function clear() {state.clear();requestSequence++;detailSequence++;currentData=null;detailData=null;query='';offset=0;detail.replaceChildren();dialog.close();root.replaceChildren();document.body.removeAttribute('data-csrf');for(const input of document.querySelectorAll('input'))input.value='';}
async function api(view,params={}) {
 const ticket=state.ticket();try {
   const response=await fetch(`/console-api/${view}?${new URLSearchParams(params)}`,{credentials:'same-origin',cache:'no-store',signal:ticket.controller.signal});
   if(response.status===401){clear();location.replace('/login');throw new Error('SESSION_REQUIRED');}
   const data=await response.json();if(!state.accepts(ticket))throw new Error('STALE_ACCOUNT');
   if(!response.ok)throw new Error(data.error_code||'UNAVAILABLE');return data;
 } finally {state.finish(ticket);}
}
const empty=()=>`<div class="empty">${l('empty')}</div>`;
function memoryRows(rows=[]) {return rows.length?rows.map(m=>`<div class="memory-row"><span class="glyph" aria-hidden="true">▤</span><button type="button" class="memory-link" data-memory="${esc(m.memory_id)}"><span>${esc([...String(m.content||m.summary||m.memory_id)].slice(0,160).join(''))}</span><small>${esc(m.memory_type||'')} · ${esc(date(m.created_at))}</small></button>${tag(m.status||'active')}<span aria-hidden="true">↗</span></div>`).join(''):empty();}
function table(rows,columns){return rows?.length?`<table><thead><tr>${columns.map(([key,label])=>`<th data-i18n="${label||key}">${esc(t(label||key))}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${columns.map(([key])=>`<td>${esc(r[key]??'—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`:empty();}
function policy(note='blockedNote',actions=[]) {return `<div class="policy-box"><span class="tag">${l('blocked')}</span>${l(note,'p')}<div class="actions">${actions.map(disabled).join('')}</div></div>`;}
function render(data) {
 let html='';const heading=`<div class="page-heading"><div><p class="eyebrow" data-i18n="workspaceLabel">${esc(t('workspaceLabel'))}</p>${l(page==='overview'?'hero':page,'h1')}${l(page==='overview'?'heroNote':'noDemo','p')}</div><span class="tag">${l('readOnly')}</span></div>`;
 if(page==='overview')html=`<section class="hero"><div><p class="eyebrow" data-i18n="heroLabel">${esc(t('heroLabel'))}</p><h2>Mnemuron · ${l('workspace')}</h2>${l('consentNote','p')}<a href="/app/connections">${l('connections')} →</a></div><div class="orb" aria-hidden="true">M</div></section><div class="metrics">${[['memories','memoryCount'],['sources','sourceCount'],['summaries','summaryCount'],['jobs','jobCount']].map(([key,label])=>`<div class="card metric">${tag('↗')}${l(label)}<strong>${Number.isInteger(data.counts?.[key])?data.counts[key]:'—'}</strong>${l('workspace','small')}</div>`).join('')}</div><div class="columns"><section class="card"><div class="card-heading">${l('recent','h2')}<a href="/app/memories">${l('viewAll')} →</a></div>${memoryRows(data.recent)}</section><section class="card">${l('policy','h2')}${policy('consentNote')}${l('pendingPolicies','p')}<div class="actions">${disabled('newMemory')}${disabled('organize')}${disabled('export')}</div></section></div>`;
 else if(page==='memories')html=`<section class="card"><form class="toolbar" id="search-form"><label>${l('query')}<input name="query" value="${esc(query)}" maxlength="2000" autocomplete="off"></label><button class="primary" type="submit" data-i18n="search">${esc(t('search'))}</button>${disabled('newMemory')}</form><div id="memory-rows">${memoryRows(data.results)}</div><div class="pagination">${offset?`<button type="button" data-offset="${Math.max(0,offset-25)}">${l('previous')}</button>`:''}${data.next_offset!==null&&data.next_offset!==undefined?`<button type="button" data-offset="${data.next_offset}">${l('next')}</button>`:''}</div></section>`;
 else if(page==='summaries')html=`<div class="columns"><section class="card">${l('summaries','h2')}${data.summaries?.length?data.summaries.map(s=>`<div class="memory-row"><button type="button" class="memory-link" data-summary="${esc(s.summary_id)}" data-revision="${s.revision}"><strong>${esc(s.category)}</strong><small>${esc(s.summary_id)}</small><small>${l('revisions')} ${s.revision} · ${l('sourceCount')} ${s.coverage}</small></button>${tag(s.status)}</div>`).join(''):empty()}</section><section class="card">${table(data.categories,[['category','scope'],['count','memoryCount']])}${policy('blockedNote',['organize'])}</section></div>`;
 else if(page==='jobs')html=`<section class="card">${table(data.jobs,[['job_id','identity'],['job_type','scope'],['state','state'],['processed','complete'],['total','sourceCount'],['last_error_code','error']])}${policy('blockedNote',['organize'])}</section>`;
 else if(page==='connections')html=`<section class="card">${table(data.connections?.map(c=>({...c,expires:date(c.expires)})),[['client_id','identity'],['expires','state']])}${l('connections','h2')}${table(data.core_connections,[['label','identity'],['agent_id','scope'],['last_used_at','created']])}${policy('blockedNote',['revoke'])}${l('consentNote','p')}</section>`;
 else if(page==='security')html=`<div class="columns"><section class="card"><h2>${esc(data.username)}</h2><span class="tag">${l(data.mfa_verified?'passwordTotp':'pending')}</span>${l('securityNote','p')}<a href="/recover">${l('recover')} →</a></section><section class="card">${table(data.sessions?.map(s=>({...s,created:date(s.created),expires:date(s.expires)})),[['purpose','scope'],['created','created'],['expires','state']])}</section></div>`;
 else if(page==='audit')html=`<section class="card">${table([...data.entries||[],...(data.core_entries||[]).map(e=>({...e,created:e.created_at}))].map(e=>({...e,created:date(e.created)})),[['action','scope'],['outcome','state'],['created','created']])}</section>`;
 else if(page==='storage')html=`<section class="card">${l('storageNote','p')}${table(Object.entries(data.counts||{}).map(([kind,count])=>({kind,count})),[['kind','scope'],['count','memoryCount']])}${policy('storageNote',['export','restore'])}</section>`;
 else if(page==='appearance')html=`<section class="card">${l('appearanceNote','p')}<p>Neural Indigo · Signal Teal · Paper Amber</p>${l('theme','h2')}${l('appearanceNote','p')}<p>${l('mode')}: <span data-current-mode data-i18n="${document.documentElement.dataset.mode}">${esc(t(document.documentElement.dataset.mode))}</span></p></section>`;
 else if(['models','invitations','accounts'].includes(page))html=`<section class="card">${policy(page==='models'?'modelsNote':'platformNote',[page==='models'?'configure':page==='invitations'?'issue':'manage'])}</section>`;
 root.innerHTML=heading+html;
}
async function load() {
 const sequence=++requestSequence;
 if(['appearance','models','invitations','accounts'].includes(page)){currentData={};render(currentData);return;}
 try {
   const data=await api(page,page==='memories'?query?{query}:{offset}:{});
   if(sequence!==requestSequence||!state.account)return;currentData=data;render(data);
 }catch(e){if(sequence!==requestSequence||!state.account||e.name==='AbortError')return;
   root.innerHTML=`<div class="page-heading">${l(page,'h1')}</div><div class="card" role="alert">${l(e.message==='BLOCKED_POLICY'?'blocked':'unavailable','h2')}${l('errorNote','p')}<button type="button" data-retry>${l('retry')}</button></div>`;}
}
function showDetail(data) {
 detail.innerHTML=`<div class="detail-meta">${tag(data.memory?.memory_type)}<span class="tag">${l('revisions')} ${data.revision}</span>${tag(data.memory?.status)}</div><div class="body-content">${esc(data.memory?.content)}</div><p>${data.content_complete?l('complete'):`${data.content_offset} / ${data.content_length}`}</p><div class="pagination">${data.next_request?`<button type="button" data-detail-next>${l('next')}</button>`:''}</div>${l('sources','h3')}${(data.source_manifest?.sources||[]).map(s=>`<div class="detail-source"><strong>${esc(s.source_kind||s.source_id)}</strong><small>${esc(s.source_id)}</small><pre>${esc(JSON.stringify(s,null,2))}</pre></div>`).join('')||empty()}${data.next_source_request?`<button type="button" data-source-next>${l('next')}</button>`:''}`;
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
 const memory=event.target.closest('[data-memory]');if(memory){void openMemory({memory_id:memory.dataset.memory,content_limit:1024,...(memory.dataset.revision?{revision:memory.dataset.revision}:{})},true);return;}
 const summary=event.target.closest('[data-summary]');if(summary){void openSummary({summary_id:summary.dataset.summary,revision:summary.dataset.revision},true);return;}
 if(event.target.closest('[data-close]')){dialog.close();return;}
 if(event.target.closest('[data-detail-next]')&&detailData?.next_request)void (detailKind==='summary'?openSummary:openMemory)(detailData.next_request);
 if(event.target.closest('[data-source-next]')&&detailData?.next_source_request)void openMemory(detailData.next_source_request);
 const pagination=event.target.closest('[data-offset]');if(pagination){offset=Number(pagination.dataset.offset);void load();}
 if(event.target.closest('[data-retry]'))void load();
});
document.addEventListener('submit',event=>{
 if(event.target.id==='search-form'){event.preventDefault();query=String(new FormData(event.target).get('query')||'');offset=0;void load();}
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
try {
 const me=await api('me');if(me.account_id!==state.account){clear();location.replace('/login');}
 else{for(const field of document.querySelectorAll('input[name="csrf"]'))field.value=me.csrf;await load();}
}catch(e){if(state.account)root.innerHTML=`<div class="card" role="alert">${l('unavailable','h2')}${l('errorNote','p')}</div>`;}

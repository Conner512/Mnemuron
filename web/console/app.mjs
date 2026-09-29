// Console controller: account-bound requests, routing and the detail pane.
// Views are pure (visuals.mjs); operations and connections keep their own modules.
import {actionButton,actionPage,mountActions,canAct} from './actions.mjs';
import {translate as t,syncAppearance} from './appearance.mjs';
import {overviewView,appearanceView,libraryView,summariesView,auditView,memoryDetailView,summaryDetailView,memoryRows,pageHeading,formatDate} from './visuals.mjs';
import {SessionState} from './session-state.mjs';
import {mountConnections} from './connections.mjs';

const root=document.getElementById('console-root'),pane=document.getElementById('memory-dialog'),detail=document.getElementById('memory-content');
const state=new SessionState(document.body.dataset.account);
const page=document.body.dataset.page;
const WIDE_PANE=window.matchMedia('(min-width: 1180px)');
let capabilities={enabled:false,writable:false},actions,connections;
let requestSequence=0,detailSequence=0,currentData=null,detailData=null,lastFocus=null,detailKind='memory',detailStack=[];
let query='',searchMode='lexical',category='',status='',offset=0;

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const l=(key,tag='span')=>`<${tag} data-i18n="${key}">${esc(t(key))}</${tag}>`;

function readLocation(){const p=new URLSearchParams(location.search);query=p.get('query')||'';searchMode=p.get('mode')||'lexical';category=p.get('category')||'';status=p.get('status')||'';const n=Number(p.get('offset')||0);offset=Number.isSafeInteger(n)&&n>=0?n:0;}
function saveLocation(){const p=new URLSearchParams();if(query)p.set('query',query);if(searchMode!=='lexical')p.set('mode',searchMode);if(category)p.set('category',category);if(status)p.set('status',status);if(offset)p.set('offset',offset);history.replaceState(null,'',location.pathname+(p.size?'?'+p:''));}
readLocation();

function clear() {
 actions?.clear();connections?.clear();state.clear();requestSequence++;detailSequence++;
 currentData=null;detailData=null;detailStack=[];query='';category='';status='';searchMode='lexical';offset=0;
 detail.replaceChildren();closePane();root.replaceChildren();document.body.removeAttribute('data-csrf');
 for(const input of document.querySelectorAll('input'))input.value='';
}
async function api(view,params={}) {
 const ticket=state.ticket();try {
   const response=await fetch(`/console-api/${view}?${new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined))}`,{credentials:'same-origin',cache:'no-store',signal:ticket.controller.signal});
   if(response.status===401){clear();location.replace('/login');throw new Error('SESSION_REQUIRED');}
   const data=await response.json();if(!state.accepts(ticket))throw new Error('STALE_ACCOUNT');
   if(!response.ok)throw new Error(data.error_code||'UNAVAILABLE');return data;
 } finally {state.finish(ticket);}
}
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

const pagination=data=>`<div class="pagination">${offset?`<button type="button" data-offset="${Math.max(0,offset-(data.limit||25))}">${l('previous')}</button>`:''}${data.next_offset!=null?`<button type="button" data-offset="${data.next_offset}">${l('next')}</button>`:''}</div>`;
const policy=(note,items)=>`<section class="card"><div class="policy-box"><span class="tag">${l('blocked')}</span>${l(note,'p')}<div class="actions">${items.map(key=>`<button type="button" disabled title="${esc(t('blocked'))}" data-i18n="${key}">${esc(t(key))}</button>`).join('')}</div></div></section>`;

function heading() {
 if(page==='overview')return pageHeading(t,{title:'homeTitle',note:'homeNote'});
 const pageActions={memories:['memory.create','memory.correct'],summaries:['jobs.schedule'],jobs:['jobs.schedule','jobs.cancel'],models:['models.save'],connections:['oauth.revoke','connections.create'],security:['security.password','security.sessions.revoke_others'],storage:['storage.export','storage.import']};
 const managing=capabilities.operator&&capabilities.management?.[page];
 const interactive=page==='appearance'||(pageActions[page]||[]).some(a=>canAct(capabilities,a));
 const badge=`<span class="tag">${l(managing?'operatorManagement':interactive?'interactive':'readOnly')}</span>`;
 const create=page==='memories'&&canAct(capabilities,'memory.create')?actionButton('memory.create','newMemory'):'';
 return pageHeading(t,{title:page,note:`pageNote_${page}`,actions:badge+create});
}

function render(data) {
 let html='';
 if(page==='overview')html=overviewView(data,{t,memoryRows:rows=>memoryRows(rows,t)});
 else if(page==='memories')html=libraryView(t,{data,query,searchMode,category,status,categories:capabilities.taxonomy?.categories||[],focusSources:new URLSearchParams(location.search).get('focus')==='sources',readOnly:!canAct(capabilities,'memory.create'),pagination:pagination(data)});
 else if(page==='summaries')html=summariesView(t,{data,pagination:pagination(data)});
 else if(page==='audit')html=auditView(t,{entries:[...data.entries||[],...(data.core_entries||[]).map(e=>({...e,created:e.created_at}))],pagination:pagination(data)});
 else if(page==='appearance')html=appearanceView(t);
 else if(page==='models')html=policy('modelsNote',['configure']);
 else if(['invitations','accounts'].includes(page))html=policy('platformNote',[page==='invitations'?'issue':'manage']);
 const implementation=actionPage(page,data,capabilities,connections?.query());if(implementation!==null)html=implementation;
 root.innerHTML=heading()+(capabilities.unavailable?`<p class="policy-box" role="status">${l('capabilitiesUnavailable')}</p>`:'')+html;
 syncAppearance();
}
async function load() {
 const sequence=++requestSequence;
 if(page==='appearance'||['invitations','accounts'].includes(page)&&(!capabilities.operator||!(capabilities.management?.[page]??capabilities.enabled))){currentData={};render(currentData);return;}
 try {
   const params=page==='connections'?connections.query():page==='memories'?{offset,limit:25,...(query?{query,mode:searchMode}:{}),...(category?{category}:{}),...(status?{status}:{})}:['jobs','summaries','audit'].includes(page)?{offset,limit:25}:{};
   const data=await api(page,params);
   if(sequence!==requestSequence||!state.account)return;currentData=data;render(data);
 }catch(e){if(sequence!==requestSequence||!state.account||e.name==='AbortError')return;
   root.innerHTML=`${pageHeading(t,{title:page==='overview'?'homeTitle':page})}<div class="card" role="alert">${l(e.message==='BLOCKED_POLICY'?'blocked':'unavailable','h2')}${l('errorNote','p')}<button type="button" data-retry>${l('retry')}</button></div>`;}
}

// Detail pane: docked beside the list on wide screens, modal on narrow ones.
function openPane(title) {
 const heading=document.getElementById('detail-title');heading.dataset.i18n=title;heading.textContent=t(title);
 if(pane.open)return;
 lastFocus=document.activeElement;
 if(WIDE_PANE.matches){pane.show();document.body.classList.add('pane-open');}else pane.showModal();
}
function closePane(){if(pane.open)pane.close();}
function beginDetail(kind,title){detailKind=kind;detailStack=[];detail.innerHTML=l('loading','p');openPane(title);}
function markSelected(){
 const memoryId=detailKind==='memory'?detailData?.memory?.memory_id:null,summaryId=detailKind==='summary'?detailData?.results?.[0]?.summary_id:null;
 for(const node of root.querySelectorAll('[data-memory],[data-summary]'))node.toggleAttribute('data-selected',(!!memoryId&&node.dataset.memory===memoryId)||(!!summaryId&&node.dataset.summary===summaryId));
}
const detailActions=memoryId=>[['memory.correct','editMemory'],['memory.retract','retractMemory'],['memory.classify','classifyMemory'],['memory.sensitivity','sensitivity'],['memory.visibility','webVisibility']].filter(([a])=>canAct(capabilities,a)).map(([a,k])=>actionButton(a,k,{id:memoryId})).join('');
const changed=e=>`<div role="alert">${l(/VERSION_CHANGED|MANIFEST_CHANGED/.test(e.message)?'changed':'unavailable','p')}</div>`;
async function openMemory(params,first=false,back=false) {
 const sequence=++detailSequence;
 if(first)beginDetail('memory','detail');
 try{const data=await api('memory',params);if(!state.account||sequence!==detailSequence)return;detailData=data;
   if(!back)detailStack.push({kind:'memory',params:{...params,revision:data.revision,source_version:data.source_manifest?.source_version}});
   detail.innerHTML=memoryDetailView(t,data,{actions:detailActions(data.memory.memory_id),canGoBack:detailStack.length>1});markSelected();}
 catch(e){if(!state.account||sequence!==detailSequence||e.name==='AbortError')return;detailData=null;detail.innerHTML=changed(e);}
}
async function openSummary(params,first=false,back=false) {
 const sequence=++detailSequence;
 if(first)beginDetail('summary','summaries');
 try{const data=await api('summary',params);if(!state.account||sequence!==detailSequence)return;detailData=data;if(!back)detailStack.push({kind:'summary',params});
   detail.innerHTML=summaryDetailView(t,data,{canGoBack:detailStack.length>1});markSelected();}
 catch(e){if(!state.account||sequence!==detailSequence||e.name==='AbortError')return;detailData=null;detail.innerHTML=changed(e);}
}

document.addEventListener('click',event=>{
 const memory=event.target.closest('[data-memory]');if(memory){void openMemory({memory_id:memory.dataset.memory,content_limit:1024,include_history:'true',...(memory.dataset.revision?{revision:memory.dataset.revision}:{})},true);return;}
 const summary=event.target.closest('[data-summary]');if(summary){void openSummary({summary_id:summary.dataset.summary,revision:summary.dataset.revision},true);return;}
 if(event.target.closest('[data-close]')){closePane();return;}
 if(event.target.closest('[data-detail-back]')&&detailStack.length>1){detailStack.pop();const prior=detailStack.at(-1);void (prior.kind==='summary'?openSummary:openMemory)(prior.params,false,true);return;}
 if(event.target.closest('[data-detail-next]')&&detailData?.next_request)void (detailKind==='summary'?openSummary:openMemory)(detailData.next_request);
 if(event.target.closest('[data-source-next]')&&detailData?.next_source_request)void openMemory(detailData.next_source_request);
 const pager=event.target.closest('[data-offset]');if(pager){offset=Number(pager.dataset.offset);saveLocation();void load();}
 if(event.target.closest('[data-reset-filters]')){query='';category='';status='';searchMode='lexical';offset=0;saveLocation();void load();}
 if(event.target.closest('[data-retry]'))void load();
});
document.addEventListener('submit',event=>{
 if(event.target.id==='search-form'){event.preventDefault();const f=new FormData(event.target);query=String(f.get('query')||'');searchMode=String(f.get('search_mode')||'lexical');category=String(f.get('category')||'');status=String(f.get('status')||'');offset=0;saveLocation();void load();}
 if(event.target.action?.endsWith('/console-api/logout')){requestSequence++;detailSequence++;for(const c of state.controllers)c.abort();root.replaceChildren();detail.replaceChildren();closePane();currentData=null;detailData=null;}
});
pane.addEventListener('close',()=>{detailSequence++;detailData=null;detailStack=[];detail.replaceChildren();document.body.classList.remove('pane-open');markSelected();lastFocus?.isConnected&&lastFocus.focus();lastFocus=null;});
// Keyboard: "/" or Ctrl/Cmd+K focuses search; Escape closes a docked (non-modal) pane.
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&pane.open&&!document.querySelector('dialog[open]:modal')&&!document.querySelector('.select-popup:popover-open')){closePane();return;}
 const typing=event.target.closest?.('input,textarea,select,[contenteditable="true"]')||document.querySelector('dialog[open]:modal');
 if(!((event.key==='/'&&!typing)||(event.key.toLowerCase?.()==='k'&&(event.metaKey||event.ctrlKey))))return;
 event.preventDefault();const field=document.querySelector('[data-search-input]');
 if(field){field.focus();field.select();}else location.assign('/app/memories');
});
WIDE_PANE.addEventListener('change',()=>{if(pane.open){const modal=pane.matches(':modal');if(modal===WIDE_PANE.matches){pane.close();}}});
window.addEventListener('pagehide',clear);
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
document.addEventListener('appearancechange',()=>{
 // Language changes translate chrome only; do not replace a form, drawer, user content or a pending request.
 document.title=`Mnemuron · ${t(page)}`;
});

actions=mountActions({api,mutate,getData:()=>currentData||{},getCaps:()=>capabilities,reload:async()=>{closePane();await load();},isActive:()=>!!state.account});
connections=mountConnections({api,mutate,getCaps:()=>capabilities,reload:load,isActive:()=>!!state.account});

try {
 const me=await api('me');if(me.account_id!==state.account){clear();location.replace('/login');}
 else{try{capabilities={...await api('capabilities'),security_version:me.security_version};}catch{capabilities={enabled:false,writable:false,unavailable:true};}for(const field of document.querySelectorAll('input[name="csrf"]'))field.value=me.csrf;await load();}
}catch(e){if(state.account)root.innerHTML=`<div class="card" role="alert">${l('unavailable','h2')}${l('errorNote','p')}</div>`;}

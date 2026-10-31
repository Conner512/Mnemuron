import {mountAuditDates,auditDateRange} from './audit.mjs';
// Console controller: account-bound requests, routing and the detail pane.
// Views are pure (visuals.mjs); operations and connections keep their own modules.
import {actionButton,actionPage,mountActions,mountFeatureReads,canAct,overviewStatus,mountOverview,configHistoryCard} from './actions.mjs';
import {translate as t,syncAppearance} from './appearance.mjs';
import {projectProfileView,SELECTION_LIMIT,overviewView,libraryView,summariesView,auditView,memoryDetailView,versionChainView,revisionDifference,summaryDetailView,memoryRows,pageHeading,formatDate,prototypeView,prototypePages,roadmapCard,featureStatus,pageState,completedViews,completedFeaturePanels,projectContextView} from './visuals.mjs';
import {SessionState} from './session-state.mjs';
import {mountConnections} from './connections.mjs';
import {mountAgents} from './agents.mjs';
import {mountTaskWorkflows} from './task-workflows.mjs';
import {mountMemoryReview,reviewButton} from './memory-review.mjs';
import {retrievalReasonKey} from './catalog.mjs';
import {memoryProcessingView} from './memory-processing.mjs';
import {searchFeedbackCard,mountSearchFeedback} from './search-feedback.mjs';

const root=document.getElementById('console-root'),pane=document.getElementById('memory-dialog'),detail=document.getElementById('memory-content');
const state=new SessionState(document.body.dataset.account);
const page=document.body.dataset.page;
const WIDE_PANE=window.matchMedia('(min-width: 1180px)');
let capabilities={enabled:false,writable:false},actions,connections,featureReads,taskWorkflows,memoryReview,overview,searchFeedback,auditFilters={},auditSource='core',auditGroup='memory',auditPages={},auditCursor='';
let requestSequence=0,detailSequence=0,currentData=null,detailData=null,lastFocus=null,detailKind='memory',detailStack=[];
let detailMeta=null,query='',searchMode='hybrid',kind='',concept='',status='active',topic='',origin='',review='',offset=0;
// Library selection: explicit IDs (kept across pages, up to SELECTION_LIMIT) or everything matching the filter.
// selected maps memory_id → the text its list row already showed (kept for confirmations across pages).
let selected=new Map(),selectAll=false,facets=null;
// Tasks page: project and task list offsets, and the inline context request currently owned by each row.
let projectOffset=0,projectArchived='false',taskOffset=0,contextGeneration=0;const contextRequests=new Map();

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const l=(key,tag='span')=>`<${tag} data-i18n="${key}">${esc(t(key))}</${tag}>`;
const requestError=data=>Object.assign(new Error(data.error_code||'UNAVAILABLE'),
 data.error_code==='SEMANTIC_UNAVAILABLE'&&retrievalReasonKey(data.degradation_code)!=='retrievalUnavailableReason'?{degradation_code:data.degradation_code}:{});

// Audit tabs: the four event groups, and configuration changes (web and CLI edits, read from the config view).
const AUDIT_TABS=['system','memory','connections','security','config'];
function readLocation(){const p=new URLSearchParams(location.search);if(page==='audit'){auditGroup=AUDIT_TABS.includes(p.get('group'))?p.get('group'):p.get('source')==='identity'?'security':'memory';auditCursor=p.get('cursor')||'';auditFilters=Object.fromEntries(['action','outcome','from','to'].filter(k=>p.has(k)).map(k=>[k,p.get(k)]));}query=p.get('query')||'';searchMode=p.get('mode')||capabilities.default_retrieval_mode||'hybrid';kind=p.get('kind')||'';concept=p.get('concept')||'';status=p.get('status')||'active';topic=p.get('topic')||'';origin=p.get('origin')||'';review=p.get('review')==='stale'?'stale':'';const n=Number(p.get('offset')||0);offset=Number.isSafeInteger(n)&&n>=0?n:0;}
function saveLocation(){const p=new URLSearchParams();if(page==='audit'){p.set('group',auditGroup);if(auditCursor)p.set('cursor',auditCursor);for(const [key,value] of Object.entries(auditFilters))if(value)p.set(key,value);history.replaceState(null,'',location.pathname+'?'+p);return;}if(query)p.set('query',query);if(searchMode!==(capabilities.default_retrieval_mode||'hybrid'))p.set('mode',searchMode);if(kind)p.set('kind',kind);if(concept)p.set('concept',concept);if(status!=='active')p.set('status',status);if(topic)p.set('topic',topic);if(origin)p.set('origin',origin);if(review)p.set('review',review);if(offset)p.set('offset',offset);history.replaceState(null,'',location.pathname+(p.size?'?'+p:''));}
readLocation();const auditDates=page==='audit'?mountAuditDates(t):null;

function clear() {
 memoryReview?.clear();
 searchFeedback?.dispose();searchFeedback=null;
 actions?.clear();connections?.clear();featureReads?.clear();taskWorkflows?.clear();overview?.dispose();overview=null;state.clear();requestSequence++;detailSequence++;contextGeneration++;contextRequests.clear();projectOffset=0;projectArchived='false';taskOffset=0;
 currentData=null;detailData=null;detailMeta=null;detailStack=[];query='';kind='';concept='';status='active';topic='';origin='';review='';searchMode='hybrid';offset=0;selected=new Map();selectAll=false;facets=null;auditFilters={};auditSource='core';auditGroup='memory';auditCursor='';auditPages={};auditDates?.close();
 detail.replaceChildren();closePane();root.replaceChildren();document.body.removeAttribute('data-csrf');
 for(const input of document.querySelectorAll('input'))input.value='';
}
async function api(view,params={}) {
 const ticket=state.ticket();try {
   const response=await fetch(`/console-api/${view}?${new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined))}`,{credentials:'same-origin',cache:'no-store',signal:ticket.controller.signal});
   if(response.status===401){clear();location.replace('/login');throw new Error('SESSION_REQUIRED');}
   const data=await response.json();if(!state.accepts(ticket))throw new Error('STALE_ACCOUNT');
   if(!response.ok)throw requestError(data);return data;
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

// Library pages: previous / next plus the current page of the total, with a page number that can be typed to jump.
function pageJump(data){const size=data.limit||25,pages=Math.max(1,Math.ceil(data.total/size)),current=Math.min(pages,Math.floor(offset/size)+1);
 return `<div class="pagination pager">${offset?`<button type="button" data-offset="${Math.max(0,offset-size)}">${l('previous')}</button>`:''}<form class="page-jump" data-page-jump data-page-size="${size}" data-pages="${pages}"><label for="page-jump-input">${l('pageLabel')}</label><input id="page-jump-input" name="page" type="number" min="1" max="${pages}" step="1" value="${current}" inputmode="numeric" required><span class="page-total">/ ${pages} ${l('pageUnit')} · ${l('totalItems')} ${Number(data.total).toLocaleString()} ${l('itemUnit')}</span><button type="submit">${l('jumpToPage')}</button></form>${data.next_offset!=null?`<button type="button" data-offset="${data.next_offset}">${l('next')}</button>`:''}</div>`;}
const pagination=data=>page==='memories'&&Number.isSafeInteger(data.total)?pageJump(data):page==='audit'?`<div class="pagination">${auditCursor?`<button type="button" data-audit-prev>${l('previous')}</button>`:''}${data.next_cursor?`<button type="button" data-audit-next>${l('next')}</button>`:''}</div>`:`<div class="pagination">${offset?`<button type="button" data-offset="${Math.max(0,offset-(data.limit||25))}">${l('previous')}</button>`:''}${data.next_offset!=null?`<button type="button" data-offset="${data.next_offset}">${l('next')}</button>`:''}</div>`;
const policy=(note,items)=>`<section class="card"><div class="policy-box"><span class="tag">${l('blocked')}</span>${l(note,'p')}<div class="actions">${items.map(key=>`<button type="button" disabled title="${esc(t('blocked'))}" data-i18n="${key}">${esc(t(key))}</button>`).join('')}</div></div></section>`;

function heading() {
 if(page==='overview')return pageHeading(t,{title:'overview',note:'heroNote'});
 // Prototype destinations (built from the feature map) say how much of the page is live; other pages carry no badge:
 // whether a button can be used shows on the button itself.
 const badge=prototypePages.includes(page)?String(featureStatus(t,pageState(page))):'';
 const create=page==='memories'&&canAct(capabilities,'memory.create')?actionButton('memory.create','newMemory'):'';
 return pageHeading(t,{title:page,note:`pageNote_${page}`,actions:badge+create+(page==='memories'&&canAct(capabilities,'review.extract')?reviewButton():'' )});
}

function render(data) {
 searchFeedback?.dispose();searchFeedback=null;
 overview?.dispose();overview=null;
 // Replaced rows can never receive a context reply that was requested before this render.
 contextGeneration++;contextRequests.clear();
 let html='';
 if(page==='overview')html=overviewStatus(data)+overviewView(data,{t,memoryRows:rows=>memoryRows(rows,t),labels:capabilities.category_labels||{},taxonomy:capabilities.taxonomy?.categories||[],descriptions:capabilities.category_descriptions||{}});
 else if(page==='memories')html=libraryView(t,{data,query,searchMode,kind,concept,status,topic,origin,review,facets,selected:[...selected.keys()],selectAll,labels:capabilities.category_labels||{},categories:capabilities.taxonomy?.categories||[],focusSources:new URLSearchParams(location.search).get('focus')==='sources',readOnly:!canAct(capabilities,'memory.create'),allowedActions:capabilities.allowed_actions||[],pagination:pagination(data),failure:data.read_failure});
 else if(page==='summaries')html=summariesView(t,{data,pagination:pagination(data),labels:capabilities.category_labels||{}});
 else if(page==='audit'&&auditGroup==='config')html=auditView(t,{group:'config'})+configHistoryCard(data);
 else if(page==='audit')html=auditView(t,{data,source:'grouped',group:auditGroup,pagination:pagination(data),filters:auditFilters});
 else if(prototypePages.includes(page))html=prototypeView(t,page,{data,caps:capabilities});
 else if(page==='models')html=policy('modelsNote',['configure']);
 const implementation=actionPage(page,data,capabilities,connections?.query());if(implementation!==null)html=implementation;
 if(!prototypePages.includes(page))html+=completedFeaturePanels(t,page,data,capabilities);
 if(page==='memories')html+=searchFeedbackCard(data,{writable:canAct(capabilities,'search.feedback')});
 root.innerHTML=heading()+(capabilities.unavailable?`<p class="policy-box" role="status">${l('capabilitiesUnavailable')}</p>`:'')+html;
 syncAppearance();
 taskWorkflows?.afterRender();
 // The overview map and live stream draw after the markup exists; both stop once the page is replaced.
 const openFromMap=memory_id=>void openMemory({memory_id,content_limit:1024,include_history:'true'},true);
 if(page==='overview'){const account=state.account;overview=mountOverview({api,root,data,isActive:()=>!!account&&state.account===account,openMemory:openFromMap});}
 if(page==='memories'){const account=state.account;searchFeedback=mountSearchFeedback({root,data,api,mutate,writable:canAct(capabilities,'search.feedback'),isActive:()=>!!account&&state.account===account});syncAppearance();}
}
function updateMemorySelection() {
 const toolbar=root.querySelector('[data-memory-selection]');if(!toolbar||selectAll)return;
 const boxes=[...root.querySelectorAll('[data-batch-memory]')];
 for(const box of boxes)if(box.checked)selected.set(box.dataset.batchMemory,(box.closest('tr')?.querySelector('.memory-text')||box.closest('tr')?.querySelector('.memory-title'))?.textContent||'');else selected.delete(box.dataset.batchMemory);
 const count=selected.size,limit=50;
 toolbar.querySelector('[data-selection-count]').textContent=String(count);
 // Batch retract (and the older batch classify) stay bounded at 50 per request.
 for(const button of toolbar.querySelectorAll('[data-console-action]'))button.disabled=count===0||count>50;
 toolbar.querySelector('[data-clear-selection]').disabled=count===0;
 for(const box of boxes){box.disabled=!box.checked&&count>=limit;box.closest('tr').toggleAttribute('data-batch-selected',box.checked);}
}
const resetSelection=()=>{selected=new Map();selectAll=false;};
/** What the organize dialog acts on: the explicit selection, or the current filter (lexical, active only). */
function librarySelection(){
 if(!selectAll)return {memory_ids:[...selected.keys()],snippets:Object.fromEntries(selected)};
 const filter={...(query?{query}:{}),...(topic?{topic}:{}),...(origin?{origin}:{}),...(review?{review}:{})};
 return Object.keys(filter).length?filter:{all:true};
}
async function load({retainOnError=false}={}) {
 const sequence=++requestSequence;
 if(page==='resume'||page==='system'&&!capabilities.operator){currentData={};render(currentData);return;}
 const extras=async()=>Object.fromEntries(await Promise.all((completedViews[page]||[]).map(async view=>{try{return [view,await api(view,{})];}catch{return [view,null];}})));
 // Prototype pages read existing views for their live cards; a failure only degrades that card.
 if(page==='tasks'||page==='system'){
   const read=async(view,params)=>{try{return await api(view,params);}catch(e){if(sequence!==requestSequence||!state.account||e.name==='AbortError'||retainOnError&&currentData)throw e;return null;}};
   let data;
   try{
     if(page==='system')data={};
     else if(page==='tasks'){
       const [projects,tasks]=await Promise.all([read('projects',{offset:projectOffset,limit:25,archived:projectArchived}),read('task-branches',{offset:taskOffset,limit:10})]);
       // A page emptied by a change (its last row archived, restored or moved) steps back to the previous page.
       const emptied=(list,at)=>Array.isArray(list)&&!list.length&&at>0;
       if(emptied(projects?.projects,projectOffset)||emptied(tasks?.tasks,taskOffset)){
         if(sequence!==requestSequence||!state.account)return;
         if(emptied(projects?.projects,projectOffset))projectOffset=Math.max(0,projectOffset-25);
         if(emptied(tasks?.tasks,taskOffset))taskOffset=Math.max(0,taskOffset-10);
         return load({retainOnError});
       }
       data={...(projects??{unavailable:true}),features:{'task-branches':tasks}};
       if(sequence!==requestSequence||!state.account)return;currentData=data;render(data);return;
     }
     data.features=await extras();
   }catch(error){if(retainOnError&&currentData&&sequence===requestSequence&&state.account&&error.name!=='AbortError')throw error;return;}
   if(sequence!==requestSequence||!state.account)return;currentData=data;render(data);return;
 }
 try {
   const params=page==='connections'?connections.query():page==='memories'?{offset,limit:25,...(query?{query,mode:searchMode}:{}),...(kind?{kind}:{}),...(concept?{concept}:{}),...(status!=='all'?{status}:{}),...(topic?{topic}:{}),...(origin?{origin}:{}),...(review?{review}:{})}:['jobs','summaries','audit'].includes(page)?{...(page==='audit'?{...auditParams(),...(auditCursor?{cursor:auditCursor}:{})}:{offset}),...(page==='jobs'?{group:'batch'}:{}),limit:25}:{};
   // Library facets are a separate read: if it fails only the sidebar degrades, never the list.
   const facetRead=page==='memories'?api('memories',{part:'facets'}).catch(e=>{if(e.message==='STALE_ACCOUNT'||e.name==='AbortError')throw e;return null;}):null;
   const [data,features,facetData]=await Promise.all([page==='audit'&&auditGroup==='config'?api('config',{limit:100}):api(page,params),extras(),facetRead]);data.features=features;
   if(page==='memories')facets=facetData;
   if(sequence!==requestSequence||!state.account)return;currentData=data;render(data);
 }catch(e){if(sequence!==requestSequence||!state.account||e.name==='AbortError')return;
   // Agent issuance has already rendered its one-time credential. Let its caller
   // report a failed refresh without replacing that result with a page error.
   if(retainOnError&&currentData)throw e;
   if(page==='memories'&&e.message==='SEMANTIC_UNAVAILABLE'){
     currentData={results:[],read_failure:{code:e.message,degradation_code:e.degradation_code}};render(currentData);return;
   }
   root.innerHTML=`${pageHeading(t,{title:page})}<div class="card" role="alert">${l(e.message==='BLOCKED_POLICY'?'blocked':'unavailable','h2')}${l('errorNote','p')}<button type="button" data-retry>${l('retry')}</button></div>`;}
}

// Detail pane: docked beside the list on wide screens, modal on narrow ones.
function openPane(title) {
 setPaneTitle(title);
 if(pane.open)return;
 lastFocus=document.activeElement;
 if(WIDE_PANE.matches){pane.show();document.body.classList.add('pane-open');}else pane.showModal();
}
// A catalog key is translated (and re-translated on language change); a memory title is shown as stored text.
function setPaneTitle(key,text){const heading=document.getElementById('detail-title');
 if(text){delete heading.dataset.i18n;heading.textContent=text;heading.title=text;}else{heading.dataset.i18n=key;heading.textContent=t(key);heading.removeAttribute('title');}}
function closePane(){if(pane.open)pane.close();}
function beginDetail(kind,title){detailKind=kind;detailStack=[];detail.innerHTML=l('loading','p');openPane(title);}
function markSelected(){
 const memoryId=detailKind==='memory'?detailData?.memory?.memory_id:null,summaryId=detailKind==='summary'?detailData?.results?.[0]?.summary_id:null;
 for(const node of root.querySelectorAll('[data-memory],[data-summary]'))node.toggleAttribute('data-selected',(!!memoryId&&node.dataset.memory===memoryId)||(!!summaryId&&node.dataset.summary===summaryId));
}
const detailActions=memoryId=>[['memory.correct','editMemory'],['memory.retract','retractMemory'],].filter(([a])=>canAct(capabilities,a)).map(([a,k])=>actionButton(a,k,{id:memoryId})).join('');
// A failed detail read keeps an in-pane way back to the list; nothing stale stays on screen.
// A failed read opened from another detail (a summary's cited source) can also return to that detail.
const changed=(e,returnable=false)=>`<div role="alert">${l(/VERSION_CHANGED|MANIFEST_CHANGED/.test(e.message)?'changed':'unavailable','p')}</div><div class="pagination">${returnable?`<button type="button" data-detail-return>${l('previous')}</button>`:''}<button type="button" data-close>${l('backToList')}</button></div>`;
async function openMemory(params,first=false,back=false) {
 
 const sequence=++detailSequence;
 if(first){detailMeta=null;beginDetail('memory','detail');}
 try{
   // Metadata (title, category, provenance) is optional: the body still renders if that read fails.
   const cached=detailMeta?.memory_id===params.memory_id?detailMeta:null;
   const [data,fetched]=await Promise.all([api('memory',params),cached||!params.memory_id?cached:api('memory-meta',{memory_id:params.memory_id}).catch(e=>{if(e.message==='STALE_ACCOUNT'||e.name==='AbortError')throw e;return null;})]);
   if(!state.account||sequence!==detailSequence)return;detailData=data;
   const meta=fetched?.memory_id===data.memory.memory_id?fetched:detailMeta?.memory_id===data.memory.memory_id?detailMeta:null;detailMeta=meta;
   if(!back)detailStack.push({kind:'memory',params:{...params,revision:data.revision,source_version:data.source_manifest?.source_version}});
   setPaneTitle('detail',meta?.title);detailKind='memory';
   detail.innerHTML=memoryDetailView(t,data,{actions:detailActions(data.memory.memory_id),canGoBack:detailStack.length>1,meta,labels:capabilities.category_labels||{}});
   if(data.memory.status==='active')detail.insertAdjacentHTML('afterbegin',reviewButton('memory',data.memory.memory_id));
   void loadMemoryProcessing(data.memory.memory_id,data.revision,sequence);
   if(data.memory.lifecycle?.supersedes_memory_id||data.memory.lifecycle?.superseded_by_memory_id)void loadVersionChain(data.memory.memory_id,sequence);
   markSelected();}
 catch(e){if(!state.account||sequence!==detailSequence||e.name==='AbortError')return;detailData=null;detail.innerHTML=changed(e,!first&&detailStack.length>0);}
}
async function loadMemoryProcessing(memory_id,revision,sequence){
 const target=detail.querySelector('[data-memory-processing]');if(!target)return;
 target.innerHTML=l('loading','p');
 try{const data=await api('memory-processing',{memory_id,revision});
  if(!state.account||sequence!==detailSequence||target!==detail.querySelector('[data-memory-processing]'))return;
  target.innerHTML=memoryProcessingView(t,data,{writable:canAct(capabilities,'processing.preview')});
 }catch(e){if(!state.account||sequence!==detailSequence||e.name==='AbortError'||e.message==='STALE_ACCOUNT'||target!==detail.querySelector('[data-memory-processing]'))return;
  target.innerHTML=`<p role="status">${esc(t(e.message==='MEMORY_VERSION_CHANGED'?'changed':'processingEvidenceUnavailable'))}</p><button type="button" data-processing-refresh>${esc(t('retry'))}</button>`;}
}
// Version chain: the correction lineage of the open memory (each correction is a replacement record). A version's
// change is read on demand (the two records' text) and shown inline; Compare versions keeps the side-by-side view.
// Config sync (server config/center.mjs): on settings pages, a change made elsewhere (the CLI or another window) is
// noticed within CONFIG_POLL_MS and the page refreshes with a note saying where it came from. Never while a dialog is
// open, so an edit in progress is not replaced. Deployments without owner settings stop polling after the first refusal.
const CONFIG_POLL_MS=15000,CONFIG_PAGES=['connections','jobs','models','storage'];
let configSeen=null,configLatest=null,configWatch=true;
async function watchConfig(){
 if(!configWatch||!state.account||!CONFIG_PAGES.includes(page)||document.hidden||document.querySelector('dialog[open]'))return;
 let c;try{c=await api('config',{limit:1});}catch(e){if(e.name!=='AbortError'&&e.message!=='STALE_ACCOUNT')configWatch=false;return;}
 const changed=configSeen&&c.fingerprint!==configSeen,h=c.latest?.[0],fresh=h&&h.at!==configLatest;configSeen=c.fingerprint;configLatest=h?.at??null;
 if(!changed)return;
 // Name the change only when a new one was logged; otherwise (for example an agent key issued by a script) say so plainly.
 const who=h?.source==='cli'?`命令行${h.actor?`（${h.actor.replace(/^cli:/,'')}）`:''}`:'另一个窗口';
 const note=fresh?`配置已在${who}修改：${h.key}，页面已刷新。`:'配置已在其他地方更新，页面已刷新。';
 await load();
 const banner=document.createElement('p');banner.className='config-banner';banner.setAttribute('role','status');banner.textContent=note;
 document.getElementById('console-root')?.prepend(banner);setTimeout(()=>banner.remove(),10000);
}
setInterval(()=>void watchConfig(),CONFIG_POLL_MS);
async function loadVersionChain(memory_id,sequence){
 const slot=()=>sequence===detailSequence?detail.querySelector(`[data-version-chain="${CSS.escape(memory_id)}"]`):null;
 try{const d=await api('memory-versions',{memory_id,chain:'1'});const el=slot();if(!el)return;el.innerHTML=versionChainView(t,d.chain||[],{truncated:d.truncated,current:memory_id});syncAppearance();}
 catch(e){const el=slot();if(el&&e.name!=='AbortError')el.innerHTML=versionChainView(t,[]);}
}
async function showVersionChange(button){
 const out=button.closest('.version-step')?.querySelector('[data-version-diff]');if(!out)return;
 if(!out.hidden){out.hidden=true;button.setAttribute('aria-expanded','false');button.textContent=t('versionShowChange');return;}
 out.hidden=false;button.setAttribute('aria-expanded','true');button.textContent=t('versionHideChange');if(out.dataset.loaded)return;out.textContent=t('loading');
 const sequence=detailSequence,{before,beforeRevision,after,afterRevision}=button.dataset;
 try{const [old,next]=await Promise.all([[before,beforeRevision],[after,afterRevision]].map(([memory_id,revision])=>api('memory-versions',{memory_id,revision})));if(sequence!==detailSequence||!out.isConnected)return;
  const [a,b]=revisionDifference(old.content,next.content),trim=(text,end)=>text.length>80?(end?text.slice(0,80)+'…':'…'+text.slice(-80)):text;out.replaceChildren();
  if(!a.changed&&!b.changed&&old.content_complete&&next.content_complete){const p=document.createElement('p');p.className='muted';p.textContent=t('versionChangeNone');out.append(p);}
  else{const p=document.createElement('p'),del=document.createElement('del'),ins=document.createElement('ins');p.className='version-diff-text';del.textContent=a.changed;ins.textContent=b.changed;
   p.append(document.createTextNode(trim(a.prefix,false)),del,ins,document.createTextNode(trim(b.suffix,true)));out.append(p);}
  if(!old.content_complete||!next.content_complete){const p=document.createElement('p');p.className='muted';p.textContent=t('versionChangeTruncated');out.append(p);}
  out.dataset.loaded='true';}
 catch(e){if(out.isConnected)out.textContent=t(e.message);}
}
detail.addEventListener('click',event=>{const button=event.target.closest('[data-version-change]');if(button){event.preventDefault();void showVersionChange(button);}});
async function openSummary(params,first=false,back=false) {
 
 const sequence=++detailSequence;
 if(first)beginDetail('summary','summaries');
 try{const data=await api('summary',params);if(!state.account||sequence!==detailSequence)return;detailData=data;if(!back)detailStack.push({kind:'summary',params});
   setPaneTitle('summaries');detailKind='summary';
   detail.innerHTML=reviewButton('summary',data.results?.[0]?.summary_id||params.summary_id)+summaryDetailView(t,data,{canGoBack:detailStack.length>1});markSelected();}
 catch(e){if(!state.account||sequence!==detailSequence||e.name==='AbortError')return;detailData=null;detail.innerHTML=changed(e,!first&&detailStack.length>0);}
}

// Inline project context. Each row owns at most one request; a reply is shown only while that row still
// owns it: not closed or re-requested, not replaced by a render or page change, and not signed out.
async function loadContext(button){
 const project=button.dataset.projectContext,region=document.getElementById(button.getAttribute('aria-controls'));if(!project||!region)return;
 const token={generation:contextGeneration};contextRequests.set(project,token);
 const current=()=>contextRequests.get(project)===token&&token.generation===contextGeneration&&!!state.account&&region.isConnected&&!region.hidden;
 region.hidden=false;region.setAttribute('aria-busy','true');region.innerHTML=l('loading','p');
 // The profile is optional: a failure there still shows the context.
 try{const [data,profile]=await Promise.all([api('project-context',{project_id:project}),api('project-profile',{project_id:project}).catch(e=>{if(e.name==='AbortError')throw e;return null;})]);if(!current())return;region.innerHTML=projectProfileView(t,profile)+projectContextView(t,data);}
 catch(e){if(!current()||e.name==='AbortError')return;region.innerHTML=`<div role="alert">${l('contextFailed','p')}<button type="button" data-project-context-retry="${esc(project)}">${l('retry')}</button></div>`;}
 finally{if(current()){region.removeAttribute('aria-busy');syncAppearance();}}
}
function toggleContext(button){
 const region=document.getElementById(button.getAttribute('aria-controls'));if(!region)return;
 if(button.getAttribute('aria-expanded')==='true'){contextRequests.delete(button.dataset.projectContext);button.setAttribute('aria-expanded','false');region.hidden=true;region.removeAttribute('aria-busy');region.replaceChildren();return;}
 button.setAttribute('aria-expanded','true');void loadContext(button);
}
document.addEventListener('click',event=>{
 if(event.target.closest('[data-processing-refresh]')&&detailKind==='memory'&&detailData){void loadMemoryProcessing(detailData.memory.memory_id,detailData.revision,detailSequence);return;}
 const context=event.target.closest('[data-project-context]');if(context){toggleContext(context);return;}
 const retry=event.target.closest('[data-project-context-retry]');if(retry){const button=[...root.querySelectorAll('[data-project-context]')].find(b=>b.dataset.projectContext===retry.dataset.projectContextRetry);if(button)void loadContext(button);return;}
 const projectView=event.target.closest('[data-project-view]');if(projectView){projectArchived=['true','deleted'].includes(projectView.dataset.projectView)?projectView.dataset.projectView:'false';projectOffset=0;void load();return;}
 const projectPage=event.target.closest('[data-project-offset]');if(projectPage){projectOffset=Number(projectPage.dataset.projectOffset);void load();return;}
 const taskPage=event.target.closest('[data-task-offset]');if(taskPage){taskOffset=Number(taskPage.dataset.taskOffset);void load();return;}
});
document.addEventListener('click',event=>{
 if(event.target.closest('[data-clear-selection]')){const all=selectAll;resetSelection();if(all)render(currentData);else{for(const box of root.querySelectorAll('[data-batch-memory]'))box.checked=false;updateMemorySelection();}return;}
 // A source cited by the open summary stacks on it, so Back returns to that summary; any other
 // memory link starts a fresh detail as before.
 const memory=event.target.closest('[data-memory]');if(memory){const fromSummary=detailKind==='summary'&&!!memory.closest('#memory-content .claim-list');
   void openMemory({memory_id:memory.dataset.memory,content_limit:1024,include_history:'true',...(memory.dataset.revision?{revision:memory.dataset.revision}:{})},!fromSummary);return;}
 if(event.target.closest('[data-detail-return]')&&detailStack.length){const prior=detailStack.at(-1);void (prior.kind==='summary'?openSummary:openMemory)(prior.params,false,true);return;}
 const summary=event.target.closest('[data-summary]');if(summary){void openSummary({summary_id:summary.dataset.summary,revision:summary.dataset.revision},true);return;}
 if(event.target.closest('[data-close]')){closePane();return;}
 if(event.target.closest('[data-detail-back]')&&detailStack.length>1){detailStack.pop();const prior=detailStack.at(-1);void (prior.kind==='summary'?openSummary:openMemory)(prior.params,false,true);return;}
 if(event.target.closest('[data-detail-next]')&&detailData?.next_request)void (detailKind==='summary'?openSummary:openMemory)(detailData.next_request);
 if(event.target.closest('[data-source-next]')&&detailData?.next_source_request)void openMemory(detailData.next_source_request);
 const stream=event.target.closest('[data-audit-group]');if(stream&&page==='audit'&&AUDIT_TABS.includes(stream.dataset.auditGroup)){auditPages[auditGroup]={cursor:auditCursor,filters:{...auditFilters},history:auditPages[auditGroup]?.history||[]};auditGroup=stream.dataset.auditGroup;auditCursor=auditPages[auditGroup]?.cursor||'';auditFilters={...auditPages[auditGroup]?.filters};featureReads.invalidateAudit();auditDates?.close();closePane();saveLocation();void load();return;}
 if(page==='audit'&&event.target.closest('[data-audit-next]')&&currentData?.next_cursor){const h=auditPages[auditGroup]?.history||[];h.push(auditCursor);auditPages[auditGroup]={...auditPages[auditGroup],history:h};auditCursor=currentData.next_cursor;saveLocation();void load();return;}
 if(page==='audit'&&event.target.closest('[data-audit-prev]')){auditCursor=auditPages[auditGroup]?.history?.pop()||'';saveLocation();void load();return;}
 const pager=event.target.closest('[data-offset]');if(pager){offset=Number(pager.dataset.offset);if(selectAll)resetSelection();saveLocation();void load();}
 if(event.target.closest('[data-review-toggle]')){review=review?'':'stale';if(review)status='active';offset=0;resetSelection();saveLocation();void load();return;}
 if(event.target.closest('[data-reset-filters]')){query='';kind='';concept='';status='active';topic='';origin='';review='';searchMode=capabilities.default_retrieval_mode||'hybrid';offset=0;resetSelection();saveLocation();void load();}
 const facet=event.target.closest('[data-facet]');if(facet&&page==='memories'){const value=facet.dataset.value||'';
   if(facet.dataset.facet==='kind')kind=kind===value&&value?'':value;else if(facet.dataset.facet==='concept')concept=concept===value?'':value;else if(facet.dataset.facet==='topic')topic=topic===value?'':value;else if(facet.dataset.facet==='origin')origin=origin===value?'':value;
   offset=0;resetSelection();saveLocation();void load();return;}
 const clearFacet=event.target.closest('[data-clear-facet]');if(clearFacet){if(clearFacet.dataset.clearFacet==='topic')topic='';else if(clearFacet.dataset.clearFacet==='concept')concept='';else if(clearFacet.dataset.clearFacet==='review')review='';else origin='';offset=0;resetSelection();saveLocation();void load();return;}
 if(event.target.closest('[data-select-all]')){selectAll=true;selected=new Map();render(currentData);return;}
 if(event.target.closest('[data-retry]'))void load();
});
document.addEventListener('change',event=>{if(event.target.matches('[data-batch-memory]'))updateMemorySelection();});
document.addEventListener('submit',event=>{
 if(event.target.matches('[data-page-jump]')){event.preventDefault();const form=event.target,pages=Number(form.dataset.pages),size=Number(form.dataset.pageSize),n=Math.round(Number(new FormData(form).get('page')));
  if(!Number.isFinite(n)||n<1||n>pages){const field=form.elements.page;field.setCustomValidity(`1–${pages}`);field.reportValidity();field.setCustomValidity('');return;}
  offset=(n-1)*size;if(selectAll)resetSelection();saveLocation();void load();return;}
 if(event.target.id==='audit-filter'){event.preventDefault();const values=Object.fromEntries(new FormData(event.target));try{Object.assign(values,auditDateRange(values.from,values.to));}catch(e){const field=event.target.elements.to;field.setCustomValidity(t(e.message));field.reportValidity();return;}auditFilters=values;auditCursor='';auditPages[auditGroup]={history:[]};featureReads.invalidateAudit();saveLocation();void load();}
 if(event.target.id==='search-form'){event.preventDefault();const f=new FormData(event.target);query=String(f.get('query')||'');searchMode=String(f.get('search_mode')||'hybrid');kind=String(f.get('kind')||'');status=String(f.get('status')||'active');if(f.has('origin'))origin=String(f.get('origin')||'');offset=0;resetSelection();saveLocation();void load();}
 if(event.target.getAttribute('action')==='/console-api/logout'){requestSequence++;detailSequence++;for(const c of state.controllers)c.abort();root.replaceChildren();detail.replaceChildren();closePane();currentData=null;detailData=null;detailMeta=null;}
});
pane.addEventListener('close',()=>{detailSequence++;detailData=null;detailMeta=null;detailStack=[];detail.replaceChildren();document.body.classList.remove('pane-open');markSelected();lastFocus?.isConnected&&lastFocus.focus();lastFocus=null;});
// Keyboard shortcuts focus an existing page search only; never navigate from pages without search.
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&pane.open&&!document.querySelector('dialog[open]:modal')&&!document.querySelector('.select-popup:popover-open')){closePane();return;}
 const typing=event.target.closest?.('input,textarea,select,[contenteditable="true"]')||document.querySelector('dialog[open]:modal');
 // A page shortcut must not navigate away from an editor or an unacknowledged credential.
 if(typing||event.defaultPrevented||event.isComposing||document.querySelector('.select-popup:popover-open'))return;
 if(!(event.key==='/'||(event.key.toLowerCase?.()==='k'&&(event.metaKey||event.ctrlKey))))return;
 const field=document.querySelector('[data-search-input]');
 if(field){event.preventDefault();field.focus();field.select();}
});
WIDE_PANE.addEventListener('change',()=>{if(pane.open){const modal=pane.matches(':modal');if(modal===WIDE_PANE.matches){pane.close();}}});
window.addEventListener('pagehide',clear);
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
document.addEventListener('appearancechange',()=>{
 memoryReview?.appearance();
 // Language changes translate chrome only; do not replace a form, drawer, user content or a pending request.
 document.title=`Mnemuron · ${t(page)}`;
});

// Sidebar badges, read once per page view: the active memory count and an overall health state. A failed read
// leaves the slot empty; backups (a standing reminder) do not colour the health dot.
async function navBadges(){
 const [overview,health]=await Promise.all([api('overview').catch(()=>null),api('system-health').catch(()=>null)]);
 if(!state.account)return;
 const slot=key=>document.querySelector(`[data-nav-badge="${key}"]`);
 const count=(overview?.insights?.statuses||[]).find(r=>r.value==='active')?.count;if(Number.isFinite(count)&&slot('memories'))slot('memories').textContent=String(count);
 if(!health)return;
 const o=health.owner,c=o?.vector_catch_up||{};
 const level=health.services?.core!=='ready'||c.error_code?'bad':o&&(!o.flags?.processing||!o.flags?.vector_catch_up||c.pending)?'warn':'good';
 const dot=slot('storage');if(dot){dot.dataset.health=level;dot.title=t(level==='good'?'navBadgeHealthy':'navBadgeAttention');dot.setAttribute('aria-label',dot.title);dot.setAttribute('role','img');}
}

function auditParams(){return {group:auditGroup,...Object.fromEntries(Object.entries(auditFilters).filter(([,v])=>v))};}
featureReads=mountFeatureReads({api,isActive:()=>!!state.account,getAuditParams:auditParams});
actions=mountActions({api,mutate,getData:()=>currentData||{},getCaps:()=>capabilities,getFacets:()=>facets,getSelection:librarySelection,
  reload:async({keepSelection=false}={})=>{closePane();if(!keepSelection)resetSelection();try{capabilities={...capabilities,...await api('capabilities')};}catch{}await load();},isActive:()=>!!state.account});
connections=mountConnections({api,mutate,getCaps:()=>capabilities,reload:load,isActive:()=>!!state.account});
taskWorkflows=mountTaskWorkflows({api,mutate,getCaps:()=>capabilities,getData:()=>currentData||{},getAccount:()=>state.account,
 isActive:()=>!!state.account&&page==='tasks',reload:()=>load({retainOnError:true}),syncAppearance});
mountAgents({api,mutate,reload:()=>load({retainOnError:true})});
memoryReview=mountMemoryReview({api,mutate,getCaps:()=>capabilities,getAccount:()=>state.account,reload:()=>load({retainOnError:true}),translate:t});

try {
 const me=await api('me');if(me.account_id!==state.account){clear();location.replace('/login');}
 else{try{capabilities={...await api('capabilities'),security_version:me.security_version};}catch{capabilities={enabled:false,writable:false,unavailable:true};}readLocation();for(const field of document.querySelectorAll('input[name="csrf"]'))field.value=me.csrf;void navBadges().catch(()=>{});await load();}
}catch(e){if(state.account)root.innerHTML=`<div class="card" role="alert">${l('unavailable','h2')}${l('errorNote','p')}</div>`;}

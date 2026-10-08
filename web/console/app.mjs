// Console controller: account-bound requests, routing and the detail pane.
// Views are pure (visuals.mjs); operations and connections keep their own modules.
import {actionButton,actionPage,mountActions,mountFeatureReads,canAct} from './actions.mjs';
import {translate as t,syncAppearance} from './appearance.mjs';
import {SELECTION_LIMIT,overviewView,libraryView,summariesView,auditView,memoryDetailView,summaryDetailView,memoryRows,pageHeading,formatDate,prototypeView,prototypePages,roadmapCard,featureStatus,pageState,completedViews,completedFeaturePanels,projectContextView} from './visuals.mjs';
import {SessionState} from './session-state.mjs';
import {mountConnections} from './connections.mjs';
import {mountEntities,entitiesPendingView} from './entities.mjs';

const root=document.getElementById('console-root'),pane=document.getElementById('memory-dialog'),detail=document.getElementById('memory-content');
const state=new SessionState(document.body.dataset.account);
const page=document.body.dataset.page;
const WIDE_PANE=window.matchMedia('(min-width: 1180px)');
let capabilities={enabled:false,writable:false},actions,connections,entities,featureReads,auditFilters={},auditSource='core',auditOffsets={core:0,identity:0};
let requestSequence=0,entityPendingSequence=0,detailSequence=0,currentData=null,detailData=null,lastFocus=null,detailKind='memory',detailStack=[];
let detailMeta=null,query='',searchMode='lexical',category='',status='active',topic='',origin='',offset=0;
// Library selection: explicit IDs (kept across pages, up to SELECTION_LIMIT) or everything matching the filter.
// selected maps memory_id → the text its list row already showed (kept for confirmations across pages).
let selected=new Map(),selectAll=false,facets=null;
// Tasks page: project and task list offsets, and the inline context request currently owned by each row.
let projectOffset=0,projectArchived='false',taskOffset=0,contextGeneration=0;const contextRequests=new Map();

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const l=(key,tag='span')=>`<${tag} data-i18n="${key}">${esc(t(key))}</${tag}>`;

function readLocation(){const p=new URLSearchParams(location.search);if(page==='audit'){auditSource=p.get('source')==='identity'?'identity':'core';auditFilters=Object.fromEntries(['action','outcome','from','to'].filter(k=>p.has(k)).map(k=>[k,p.get(k)]));}query=p.get('query')||'';searchMode=p.get('mode')||'lexical';category=p.get('category')||'';status=p.get('status')||'active';topic=p.get('topic')||'';origin=p.get('origin')||'';const n=Number(p.get('offset')||0);offset=Number.isSafeInteger(n)&&n>=0?n:0;}
function saveLocation(){const p=new URLSearchParams();if(page==='audit'){p.set('source',auditSource);for(const [key,value] of Object.entries(auditFilters))if(value)p.set(key,value);if(offset)p.set('offset',offset);history.replaceState(null,'',location.pathname+'?'+p);return;}if(query)p.set('query',query);if(searchMode!=='lexical')p.set('mode',searchMode);if(category)p.set('category',category);if(status!=='active')p.set('status',status);if(topic)p.set('topic',topic);if(origin)p.set('origin',origin);if(offset)p.set('offset',offset);history.replaceState(null,'',location.pathname+(p.size?'?'+p:''));}
readLocation();if(page==='audit')auditOffsets[auditSource]=offset;

function clear() {
 actions?.clear();connections?.clear();entities?.clear();featureReads?.clear();state.clear();requestSequence++;entityPendingSequence++;detailSequence++;contextGeneration++;contextRequests.clear();projectOffset=0;projectArchived='false';taskOffset=0;
 currentData=null;detailData=null;detailMeta=null;detailStack=[];query='';category='';status='active';topic='';origin='';searchMode='lexical';offset=0;selected=new Map();selectAll=false;facets=null;auditFilters={};auditSource='core';auditOffsets={core:0,identity:0};
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
 if(page==='overview')return pageHeading(t,{title:'overview',note:'heroNote'});
 const pageActions={memories:['memory.create','memory.correct'],summaries:['jobs.schedule'],jobs:['jobs.schedule','jobs.cancel'],models:['models.save'],connections:['oauth.revoke','connections.create'],security:['security.password','security.sessions.revoke_others'],storage:['storage.export','storage.import']};
 const interactive=(pageActions[page]||[]).some(a=>canAct(capabilities,a));
 // New destinations are built from the feature map; their badge says how much of the page is live.
 const badge=prototypePages.includes(page)?String(featureStatus(t,pageState(page))):`<span class="tag">${l(interactive?'interactive':'readOnly')}</span>`;
 const create=page==='memories'&&canAct(capabilities,'memory.create')?actionButton('memory.create','newMemory'):'';
 return pageHeading(t,{title:page,note:`pageNote_${page}`,actions:badge+create});
}

function render(data) {
 // Replaced rows can never receive a context reply that was requested before this render.
 contextGeneration++;contextRequests.clear();
 let html='';
 if(page==='overview')html=overviewView(data,{t,memoryRows:rows=>memoryRows(rows,t),labels:capabilities.category_labels||{}});
 else if(page==='memories')html=libraryView(t,{data,query,searchMode,category,status,topic,origin,facets,selected:[...selected.keys()],selectAll,labels:capabilities.category_labels||{},categories:capabilities.taxonomy?.categories||[],focusSources:new URLSearchParams(location.search).get('focus')==='sources',readOnly:!canAct(capabilities,'memory.create'),allowedActions:capabilities.allowed_actions||[],pagination:pagination(data)});
 else if(page==='summaries')html=summariesView(t,{data,pagination:pagination(data),labels:capabilities.category_labels||{}});
 else if(page==='audit')html=auditView(t,{data,source:auditSource,pagination:pagination(data),filters:auditFilters});
 else if(prototypePages.includes(page))html=prototypeView(t,page,{data,caps:capabilities});
 else if(page==='models')html=policy('modelsNote',['configure']);
 const implementation=actionPage(page,data,capabilities,connections?.query());if(implementation!==null)html=implementation;
 if(!prototypePages.includes(page))html+=completedFeaturePanels(t,page,data,capabilities);
 if(page==='memories'){entities?.setPending(data.features?.entities);html+=entitiesPendingView(t,data.features?.entities,capabilities);}
 if(!prototypePages.includes(page))html+=roadmapCard(t,page);
 root.innerHTML=heading()+(capabilities.unavailable?`<p class="policy-box" role="status">${l('capabilitiesUnavailable')}</p>`:'')+html;
 syncAppearance();
}
function updateMemorySelection() {
 const toolbar=root.querySelector('[data-memory-selection]');if(!toolbar||selectAll)return;
 const boxes=[...root.querySelectorAll('[data-batch-memory]')];
 for(const box of boxes)if(box.checked)selected.set(box.dataset.batchMemory,(box.closest('tr')?.querySelector('.memory-text')||box.closest('tr')?.querySelector('.memory-title'))?.textContent||'');else selected.delete(box.dataset.batchMemory);
 const count=selected.size,organize=canAct(capabilities,'memory.organize'),limit=organize?SELECTION_LIMIT:50;
 toolbar.querySelector('[data-selection-count]').textContent=String(count);
 // Batch retract (and the older batch classify) stay bounded at 50 per request.
 for(const button of toolbar.querySelectorAll('[data-console-action]'))button.disabled=count===0||count>(button.dataset.consoleAction==='memory.organize'?SELECTION_LIMIT:50);
 toolbar.querySelector('[data-clear-selection]').disabled=count===0;
 for(const box of boxes){box.disabled=!box.checked&&count>=limit;box.closest('tr').toggleAttribute('data-batch-selected',box.checked);}
}
const resetSelection=()=>{selected=new Map();selectAll=false;};
/** What the organize dialog acts on: the explicit selection, or the current filter (lexical, active only). */
function librarySelection(){
 if(!selectAll)return {memory_ids:[...selected.keys()],snippets:Object.fromEntries(selected)};
 const filter={...(query?{query}:{}),...(category?{filter_category:category}:{}),...(topic?{topic}:{}),...(origin?{origin}:{})};
 return Object.keys(filter).length?filter:{all:true};
}
async function load() {
 const sequence=++requestSequence;
 if(page==='resume'||page==='system'&&!capabilities.operator){currentData={};render(currentData);return;}
 const extras=async()=>Object.fromEntries(await Promise.all((completedViews[page]||[]).map(async view=>{try{return [view,await api(view,view==='entities'?{status:'pending',limit:10}:{})];}catch{return [view,null];}})));
 // Prototype pages read existing views for their live cards; a failure only degrades that card.
 if(page==='tasks'||page==='system'){
   const read=async(view,params)=>{try{return await api(view,params);}catch(e){if(sequence!==requestSequence||!state.account||e.name==='AbortError')throw e;return null;}};
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
         return load();
       }
       data={...(projects??{unavailable:true}),features:{'task-branches':tasks}};
       if(sequence!==requestSequence||!state.account)return;currentData=data;render(data);return;
     }
     data.features=await extras();
   }catch{return;}
   if(sequence!==requestSequence||!state.account)return;currentData=data;render(data);return;
 }
 try {
   const params=page==='connections'?connections.query():page==='memories'?{offset,limit:25,...(query?{query,mode:searchMode}:{}),...(category?{category}:{}),...(status!=='all'?{status}:{}),...(topic?{topic}:{}),...(origin?{origin}:{})}:['jobs','summaries','audit'].includes(page)?{offset,limit:25,...(page==='audit'?auditParams():{})}:{};
   // Library facets are a separate read: if it fails only the sidebar degrades, never the list.
   const facetRead=page==='memories'?api('memories',{part:'facets'}).catch(e=>{if(e.message==='STALE_ACCOUNT'||e.name==='AbortError')throw e;return null;}):null;
   const [data,features,facetData]=await Promise.all([api(page,params),extras(),facetRead]);data.features=features;
   if(page==='memories')facets=facetData;
   if(sequence!==requestSequence||!state.account)return;currentData=data;render(data);
 }catch(e){if(sequence!==requestSequence||!state.account||e.name==='AbortError')return;
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
function closePane(){entities?.clearMemory();if(pane.open)pane.close();}
function beginDetail(kind,title){detailKind=kind;detailStack=[];detail.innerHTML=l('loading','p');openPane(title);}
function markSelected(){
 const memoryId=detailKind==='memory'?detailData?.memory?.memory_id:null,summaryId=detailKind==='summary'?detailData?.results?.[0]?.summary_id:null;
 for(const node of root.querySelectorAll('[data-memory],[data-summary]'))node.toggleAttribute('data-selected',(!!memoryId&&node.dataset.memory===memoryId)||(!!summaryId&&node.dataset.summary===summaryId));
}
const detailActions=memoryId=>[['memory.correct','editMemory'],['memory.retract','retractMemory'],...(canAct(capabilities,'memory.organize')?[['memory.organize','moveToCategory']]:[['memory.classify','classifyMemory']]),['memory.sensitivity','sensitivity']].filter(([a])=>canAct(capabilities,a)).map(([a,k])=>actionButton(a,k,{id:memoryId})).join('');
// A failed detail read keeps an in-pane way back to the list; nothing stale stays on screen.
// A failed read opened from another detail (a summary's cited source) can also return to that detail.
const changed=(e,returnable=false)=>`<div role="alert">${l(/VERSION_CHANGED|MANIFEST_CHANGED/.test(e.message)?'changed':'unavailable','p')}</div><div class="pagination">${returnable?`<button type="button" data-detail-return>${l('previous')}</button>`:''}<button type="button" data-close>${l('backToList')}</button></div>`;
async function openMemory(params,first=false,back=false) {
 entities?.clearMemory();
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
   const region=document.createElement('section');region.className='entity-memory';detail.append(region);
   void entities.loadMemory(region,{...data.memory,revision:data.revision,current_revision:meta?.revision,current:meta?.revision===data.revision&&meta?.status==='active',title:meta?.title},()=>sequence===detailSequence&&pane.open&&detailKind==='memory'&&detailData===data);markSelected();}
 catch(e){if(!state.account||sequence!==detailSequence||e.name==='AbortError')return;detailData=null;detail.innerHTML=changed(e,!first&&detailStack.length>0);}
}
async function openSummary(params,first=false,back=false) {
 entities?.clearMemory();
 const sequence=++detailSequence;
 if(first)beginDetail('summary','summaries');
 try{const data=await api('summary',params);if(!state.account||sequence!==detailSequence)return;detailData=data;if(!back)detailStack.push({kind:'summary',params});
   setPaneTitle('summaries');detailKind='summary';
   detail.innerHTML=summaryDetailView(t,data,{canGoBack:detailStack.length>1});markSelected();}
 catch(e){if(!state.account||sequence!==detailSequence||e.name==='AbortError')return;detailData=null;detail.innerHTML=changed(e,!first&&detailStack.length>0);}
}

// Inline project context. Each row owns at most one request; a reply is shown only while that row still
// owns it: not closed or re-requested, not replaced by a render or page change, and not signed out.
async function loadContext(button){
 const project=button.dataset.projectContext,region=document.getElementById(button.getAttribute('aria-controls'));if(!project||!region)return;
 const token={generation:contextGeneration};contextRequests.set(project,token);
 const current=()=>contextRequests.get(project)===token&&token.generation===contextGeneration&&!!state.account&&region.isConnected&&!region.hidden;
 region.hidden=false;region.setAttribute('aria-busy','true');region.innerHTML=l('loading','p');
 try{const data=await api('project-context',{project_id:project});if(!current())return;region.innerHTML=projectContextView(t,data);}
 catch(e){if(!current()||e.name==='AbortError')return;region.innerHTML=`<div role="alert">${l('contextFailed','p')}<button type="button" data-project-context-retry="${esc(project)}">${l('retry')}</button></div>`;}
 finally{if(current()){region.removeAttribute('aria-busy');syncAppearance();}}
}
function toggleContext(button){
 const region=document.getElementById(button.getAttribute('aria-controls'));if(!region)return;
 if(button.getAttribute('aria-expanded')==='true'){contextRequests.delete(button.dataset.projectContext);button.setAttribute('aria-expanded','false');region.hidden=true;region.removeAttribute('aria-busy');region.replaceChildren();return;}
 button.setAttribute('aria-expanded','true');void loadContext(button);
}
document.addEventListener('click',event=>{
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
 const stream=event.target.closest('[data-audit-source]');if(stream&&page==='audit'&&['core','identity'].includes(stream.dataset.auditSource)){auditOffsets[auditSource]=offset;auditSource=stream.dataset.auditSource;offset=auditOffsets[auditSource];featureReads.invalidateAudit();closePane();saveLocation();void load();return;}
 const pager=event.target.closest('[data-offset]');if(pager){offset=Number(pager.dataset.offset);if(selectAll)resetSelection();saveLocation();void load();}
 if(event.target.closest('[data-reset-filters]')){query='';category='';status='active';topic='';origin='';searchMode='lexical';offset=0;resetSelection();saveLocation();void load();}
 const facet=event.target.closest('[data-facet]');if(facet&&page==='memories'){const value=facet.dataset.value||'';
   if(facet.dataset.facet==='category')category=category===value&&value?'':value;else if(facet.dataset.facet==='topic')topic=topic===value?'':value;else if(facet.dataset.facet==='origin')origin=origin===value?'':value;
   offset=0;resetSelection();saveLocation();void load();return;}
 const clearFacet=event.target.closest('[data-clear-facet]');if(clearFacet){if(clearFacet.dataset.clearFacet==='topic')topic='';else origin='';offset=0;resetSelection();saveLocation();void load();return;}
 if(event.target.closest('[data-select-all]')){selectAll=true;selected=new Map();render(currentData);return;}
 if(event.target.closest('[data-retry]'))void load();
});
document.addEventListener('change',event=>{if(event.target.matches('[data-batch-memory]'))updateMemorySelection();});
document.addEventListener('submit',event=>{
 if(event.target.id==='audit-filter'){event.preventDefault();auditFilters=Object.fromEntries(new FormData(event.target));offset=0;auditOffsets={core:0,identity:0};featureReads.invalidateAudit();saveLocation();void load();}
 if(event.target.id==='search-form'){event.preventDefault();const f=new FormData(event.target);query=String(f.get('query')||'');searchMode=String(f.get('search_mode')||'lexical');category=String(f.get('category')||'');status=String(f.get('status')||'active');offset=0;resetSelection();saveLocation();void load();}
 if(event.target.getAttribute('action')==='/console-api/logout'){entities?.clear();requestSequence++;detailSequence++;for(const c of state.controllers)c.abort();root.replaceChildren();detail.replaceChildren();closePane();currentData=null;detailData=null;detailMeta=null;}
});
pane.addEventListener('close',()=>{entities?.clearMemory();detailSequence++;detailData=null;detailMeta=null;detailStack=[];detail.replaceChildren();document.body.classList.remove('pane-open');markSelected();lastFocus?.isConnected&&lastFocus.focus();lastFocus=null;});
// Keyboard: "/" or Ctrl/Cmd+K focuses search; Escape closes a docked (non-modal) pane.
document.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&pane.open&&!document.querySelector('dialog[open]:modal')&&!document.querySelector('.select-popup:popover-open')){closePane();return;}
 const typing=event.target.closest?.('input,textarea,select,[contenteditable="true"]')||document.querySelector('dialog[open]:modal');
 // A page shortcut must not navigate away from an editor or an unacknowledged credential.
 if(typing||event.defaultPrevented||event.isComposing||document.querySelector('.select-popup:popover-open'))return;
 if(!(event.key==='/'||(event.key.toLowerCase?.()==='k'&&(event.metaKey||event.ctrlKey))))return;
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

function auditParams(){return {source:auditSource,...Object.fromEntries(Object.entries(auditFilters).filter(([,v])=>v).map(([k,v])=>[k,['from','to'].includes(k)?new Date(v).toISOString():v]))};}
featureReads=mountFeatureReads({api,isActive:()=>!!state.account,getAuditParams:auditParams});
actions=mountActions({api,mutate,getData:()=>currentData||{},getCaps:()=>capabilities,getFacets:()=>facets,getSelection:librarySelection,
  reload:async({keepSelection=false}={})=>{closePane();if(!keepSelection)resetSelection();try{capabilities={...capabilities,...await api('capabilities')};}catch{}await load();},isActive:()=>!!state.account});
connections=mountConnections({api,mutate,getCaps:()=>capabilities,reload:load,isActive:()=>!!state.account});
entities=mountEntities({api,mutate,getCaps:()=>capabilities,isActive:()=>!!state.account,t,syncAppearance,reloadPending:async(at=0)=>{
 const seq=requestSequence,pendingSeq=++entityPendingSequence;try{const data=await api('entities',{status:'pending',limit:10,offset:at});if(!state.account||seq!==requestSequence||pendingSeq!==entityPendingSequence||page!=='memories')return;
 currentData.features.entities=data;entities.setPending(data);const card=root.querySelector('[data-feature="MEM-08"]');if(card){card.outerHTML=entitiesPendingView(t,data,capabilities);syncAppearance();}}catch{}
}});

try {
 const me=await api('me');if(me.account_id!==state.account){clear();location.replace('/login');}
 else{try{capabilities={...await api('capabilities'),security_version:me.security_version};}catch{capabilities={enabled:false,writable:false,unavailable:true};}for(const field of document.querySelectorAll('input[name="csrf"]'))field.value=me.csrf;await load();}
}catch(e){if(state.account)root.innerHTML=`<div class="card" role="alert">${l('unavailable','h2')}${l('errorNote','p')}</div>`;}

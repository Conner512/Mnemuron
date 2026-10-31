import {translate as t} from './appearance.mjs';
import {kindGroup,KIND_OF_GROUP} from './visuals.mjs';
import {neighborhoodCard,mountNeighborhood} from './graph-neighborhood.mjs';

// A bounded, owner-only view of keyword co-occurrence. Nodes are not entity identities.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=value=>Number.isFinite(value)?value.toLocaleString():'—';
const message=(key,...values)=>values.reduce((text,value,i)=>text.replaceAll(`{${i}}`,String(value)),t(key));
const label=key=>`<span data-i18n="${key}">${esc(t(key))}</span>`;
const GROUP_KEYS={fact:'mapKindFact',pref:'mapKindPreference',flow:'mapKindWorkflow',proj:'mapKindArchitecture',bug:'mapKindBug',pat:'mapKindPattern',none:'mapKindNone'};
const groupName=group=>t(GROUP_KEYS[group]||'mapKindNone');
export const MAP_KINDS=['fact','preference','workflow','architecture','bug','pattern','none'];
const TOPIC_ANCHORS=14,MAP_AGGREGATE_AT=150,MAP_DAYS=[7,30,90,0],MEMORY_PAGE=10;
const kindOf=memory=>MAP_KINDS.includes(memory.kind)?memory.kind:'none';
// Same normalization as Core's metadata graph filter; retain the first original spelling for display.
const conceptKey=value=>String(value).normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
const daysLabel=days=>days?message('mapRecentDays',days):t('mapAllDays');
const rangeLabel=days=>days?message('mapRangeDays',days):t('mapRangeAll');
const topicLabel=(topic,all)=>{const parts=String(topic).split('/').filter(Boolean),last=parts.at(-1)||String(topic);return all.filter(x=>String(x).split('/').filter(Boolean).at(-1)===last).length>1&&parts.length>1?parts.slice(-2).join('/'):last;};
const dayKey=()=>`mnm.map.days.${document.body.dataset.account||'signed-out'}`;
const savedDays=()=>{try{const raw=localStorage.getItem(dayKey()),value=Number(raw);return raw!==null&&Number.isInteger(value)&&value>=0&&value<=3650?value:null;}catch{return null;}};
const saveDays=value=>{try{localStorage.setItem(dayKey(),String(value));}catch{}};

// Kept as a pure compatibility helper; live graph requests filter on the server before bounds.
export function mapWindow(graph,{days=30,hidden=new Set(),today=new Date()}={}){
 const cutoff=days>0?new Date(today.getTime()-(days-1)*86400000).toISOString().slice(0,10):null;
 return {...graph,memories:graph.memories.filter(m=>(!cutoff||!m.day||m.day>=cutoff)&&!hidden.has(kindGroup(m.kind))),entities:[],links:[]};
}

export function mapAnchors(graph,{max=TOPIC_ANCHORS,aggregate=graph.memories.length>MAP_AGGREGATE_AT}={}){
 const groups=[...new Set(graph.memories.map(m=>kindGroup(m.kind)))],counts=new Map(),spelled=new Map();
 for(const memory of graph.memories)for(const key of new Set((memory.concepts||[]).map(conceptKey).filter(Boolean)))counts.set(key,(counts.get(key)||0)+1);
 for(const memory of graph.memories)for(const value of memory.concepts||[])if(!spelled.has(conceptKey(value)))spelled.set(conceptKey(value),String(value).trim());
 const top=counts=>[...counts].filter(([,n])=>n>1).sort((a,b)=>b[1]-a[1]||(a[0]<b[0]?-1:1)).slice(0,max).map(([key])=>key);
 const concepts=top(counts),hubs=()=>groups.map(group=>({key:`hub:${group}`,kind:'hub',group,label:groupName(group),count:graph.memories.filter(m=>kindGroup(m.kind)===group).length}));
 const edgesOf=links=>{const pairs=new Map();for(const linksOfMemory of links){const ids=linksOfMemory.filter(([,weight])=>weight===1).map(([index])=>index);for(let a=0;a<ids.length;a++)for(let b=a+1;b<ids.length;b++){const key=[Math.min(ids[a],ids[b]),Math.max(ids[a],ids[b])].join(',');pairs.set(key,(pairs.get(key)||0)+1);}}return [...pairs].map(([key,count])=>[...key.split(',').map(Number),count]);};
 // A rare or missing keyword/topic must not make a memory disappear in aggregate mode.
 const completeAggregate=(mode,anchors,links)=>{
  const buckets=new Map();for(let i=0;i<links.length;i++)if(!links[i].length){const group=kindGroup(graph.memories[i].kind);if(!buckets.has(group)){buckets.set(group,anchors.length);anchors.push({key:`unmapped:${group}`,kind:'unmapped',group,label:message('mapOtherKind',groupName(group)),count:0});}const index=buckets.get(group);anchors[index].count++;links[i]=[[index,1]];}
  return {mode,aggregate:true,anchors,links,edges:edgesOf(links)};
 };
 if(concepts.length){
  const anchors=concepts.map(key=>({key:`concept:${key}`,kind:'concept',label:spelled.get(key),title:spelled.get(key),count:counts.get(key)}));
  const mine=memory=>[...new Set((memory.concepts||[]).map(conceptKey))].map(key=>concepts.indexOf(key)).filter(index=>index>=0);
  if(aggregate)return completeAggregate('concepts',anchors,graph.memories.map(memory=>mine(memory).map(index=>[index,1])));
  const hub=group=>concepts.length+groups.indexOf(group);
  return {mode:'concepts',anchors:[...anchors,...hubs()],links:graph.memories.map(memory=>{const indices=mine(memory);return indices.length?[...indices.map(index=>[index,1]),[hub(kindGroup(memory.kind)),.3]]:[[hub(kindGroup(memory.kind)),1]];})};
 }
 const sizes=new Map();for(const memory of graph.memories)if(memory.topic)sizes.set(memory.topic,(sizes.get(memory.topic)||0)+1);
 const topics=top(sizes),anchors=topics.map(topic=>({key:`topic:${topic}`,kind:'topic',label:topicLabel(topic,topics),title:topic,count:sizes.get(topic)}));
 if(aggregate){if(!topics.length)return {mode:'kinds',aggregate:true,anchors:hubs(),links:graph.memories.map(memory=>[[groups.indexOf(kindGroup(memory.kind)),1]]),edges:[]};return completeAggregate('topics',anchors,graph.memories.map(memory=>{const index=topics.indexOf(memory.topic);return index>=0?[[index,1]]:[];}));}
 const hub=group=>topics.length+groups.indexOf(group);
 return {mode:topics.length?'topics':'kinds',anchors:[...anchors,...hubs()],links:graph.memories.map(memory=>{const index=topics.indexOf(memory.topic);return index>=0?[[index,1],[hub(kindGroup(memory.kind)),.3]]:[[hub(kindGroup(memory.kind)),1]];})};
}

const anchorType=anchor=>t(({concept:'mapKeyword',topic:'mapTopic',hub:'mapType',unmapped:'mapUnmapped'})[anchor.kind]||'mapType');
const members=(plan,index)=>plan.links.map((links,i)=>links.some(([node,weight])=>node===index&&(weight===1||plan.anchors[index]?.kind==='hub'))?i:-1).filter(i=>i>=0);
// Selection is a union within this authorized, bounded snapshot, never a wider library query.
// Iterate source order and deduplicate IDs so overlapping keywords cannot inflate the result.
export function selectedMemories(graph,plan,keys){
 const selected=new Set(keys),indices=new Set(plan.anchors.flatMap((anchor,index)=>selected.has(anchor.key)?members(plan,index):[])),seen=new Set();
 return graph.memories.filter((memory,index)=>{if(!indices.has(index)||seen.has(memory.id))return false;seen.add(memory.id);return true;});
}
export function anchorPanel(graph,plan,index,{offset=0}={}){
 const anchor=plan.anchors[index];if(!anchor)return '';
 const mine=members(plan,index),groups={},shared={};
 for(const i of mine){const group=kindGroup(graph.memories[i].kind);groups[group]=(groups[group]||0)+1;for(const [node] of plan.links[i])if(node!==index)shared[node]=(shared[node]||0)+1;}
 const near=anchor.kind==='topic'?[]:Object.entries(shared).filter(([node])=>anchor.kind!=='concept'||plan.anchors[node].kind==='concept').sort((a,b)=>b[1]-a[1]).slice(0,5);
 const isKind=anchor.kind==='hub'||anchor.kind==='unmapped';
 const href=anchor.kind==='topic'?`/app/memories?topic=${encodeURIComponent(anchor.title)}`:anchor.kind==='concept'?`/app/memories?concept=${encodeURIComponent(anchor.label)}`:`/app/memories?kind=${encodeURIComponent(KIND_OF_GROUP[anchor.group]||'none')}`;
 const start=Math.max(0,Math.min(offset,Math.max(0,Math.ceil(mine.length/MEMORY_PAGE)-1)*MEMORY_PAGE)),page=mine.slice(start,start+MEMORY_PAGE);
 return `<header><span class="node-key" data-group="${isKind?esc(anchor.group):'entity'}">${esc(anchorType(anchor))}</span><button type="button" class="quiet map-panel-close" data-map-close data-i18n-aria-label="close" aria-label="${esc(t('close'))}">×</button></header>
  <h3 title="${esc(anchor.title||anchor.label)}">${esc(anchor.title||anchor.label)}</h3><p class="muted">${esc(message('mapOnGraph',num(mine.length)))}</p>${anchor.kind==='unmapped'?`<p class="muted">${label('mapUnmappedNote')}</p>`:''}
  ${isKind?'':`<div class="entity-groups">${Object.entries(groups).map(([group,count])=>`<span class="node-key" data-group="${group}">${esc(groupName(group))} <span>${num(count)}</span></span>`).join('')}</div>`}
  ${near.length?`<h4>${esc(t(isKind?(plan.mode==='concepts'?'mapKeywordsInType':'mapTopicsInType'):'mapTogether'))}</h4><ul class="entity-picks">${near.map(([node,count])=>`<li><button type="button" class="quiet" data-map-node-key="${esc(plan.anchors[node].key)}" aria-pressed="false"><span>${esc(plan.anchors[node].label)}</span><span>${esc(message('mapMemoryCount',num(count)))}</span></button></li>`).join('')}</ul>`:''}
  <h4>${label('mapSourceMemories')}</h4><ul class="map-memories">${page.map(i=>{const memory=graph.memories[i];return `<li><button type="button" class="quiet" data-map-memory="${esc(memory.id)}"><span>${esc(memory.topic||message('mapMemoryId',memory.id))}</span><small>${esc([memory.day,groupName(kindGroup(memory.kind))].filter(Boolean).join(' · '))}</small></button></li>`;}).join('')}</ul>
  ${mine.length>MEMORY_PAGE?`<div class="map-memory-pages"><span>${num(start+1)}–${num(Math.min(start+MEMORY_PAGE,mine.length))} / ${num(mine.length)}</span>${start?`<button type="button" data-map-memory-offset="${start-MEMORY_PAGE}">${label('previous')}</button>`:''}${start+MEMORY_PAGE<mine.length?`<button type="button" data-map-memory-offset="${start+MEMORY_PAGE}">${label('next')}</button>`:''}</div>`:''}
  <div class="actions">${anchor.kind==='concept'?`<button type="button" data-map-explore="${esc(anchor.label)}">${label('mapExploreLibrary')}</button>`:''}<a class="button" href="${href}">${label('mapOpenLibrary')}</a></div><p class="muted">${label('mapLibraryScope')}</p>`;
}

export function selectionPanel(graph,plan,keys,{offset=0}={}){
 const chosen=new Set(keys),anchors=plan.anchors.filter(anchor=>chosen.has(anchor.key));if(!anchors.length)return '';
 const mine=selectedMemories(graph,plan,chosen);
 if(anchors.length===1)return anchorPanel(graph,plan,plan.anchors.indexOf(anchors[0]),{offset})+`<p class="map-selection-bound">${label('mapSelectionBound')}</p>`;
 const start=Math.max(0,Math.min(offset,Math.max(0,Math.ceil(mine.length/MEMORY_PAGE)-1)*MEMORY_PAGE)),page=mine.slice(start,start+MEMORY_PAGE);
 return `<header><strong>${esc(message('mapSelectedNodes',anchors.length))}</strong><button type="button" class="quiet map-panel-close" data-map-close aria-label="${esc(t('mapClearSelection'))}">×</button></header>
  <h3>${esc(message('mapUniqueMemories',num(mine.length)))}</h3><p class="muted">${label('mapUnionNote')}</p>
  <ul class="map-panel-selection">${anchors.map(anchor=>`<li><button type="button" class="quiet" data-map-node-key="${esc(anchor.key)}" aria-pressed="true" title="${esc(t('mapRemoveSelection'))}">${esc(anchor.label)} <span aria-hidden="true">×</span></button></li>`).join('')}</ul>
  <h4>${label('mapSourceMemories')}</h4><ul class="map-memories">${page.map(memory=>`<li><button type="button" class="quiet" data-map-memory="${esc(memory.id)}"><span>${esc(memory.topic||message('mapMemoryId',memory.id))}</span><small>${esc([memory.day,groupName(kindGroup(memory.kind))].filter(Boolean).join(' · '))}</small></button></li>`).join('')}</ul>
  ${mine.length>MEMORY_PAGE?`<div class="map-memory-pages"><span>${num(start+1)}–${num(Math.min(start+MEMORY_PAGE,mine.length))} / ${num(mine.length)}</span>${start?`<button type="button" data-map-memory-offset="${start-MEMORY_PAGE}">${label('previous')}</button>`:''}${start+MEMORY_PAGE<mine.length?`<button type="button" data-map-memory-offset="${start+MEMORY_PAGE}">${label('next')}</button>`:''}</div>`:''}
  <p class="map-selection-bound">${label('mapSelectionBound')}</p>`;
}

const scopeOf=graph=>({days:graph.scope?.days??30,kinds:graph.scope?.kinds||MAP_KINDS,query:graph.scope?.query||'',project_id:graph.scope?.project_id||'',task_id:graph.scope?.task_id||''});
const unavailableGraph=()=>({memories:[],entities:[],links:[],unavailable:true});
const renderedGraph=graph=>graph.scope?graph:mapWindow(graph,{days:30});
const kindCounts=graph=>graph.kind_counts||Object.fromEntries(MAP_KINDS.map(kind=>[kind,graph.memories.filter(memory=>kindOf(memory)===kind).length]));
const coverage=graph=>graph.unavailable?t('mapUnavailable'):`${message('mapCoverage',num(graph.returned??graph.memories.length),num(graph.filtered_total??(graph.truncated?null:graph.memories.length)))}${graph.truncated?` · ${t(graph.truncation_reason==='response_budget'?'mapByteLimit':'mapRecordLimit')}`:''}`;
const scopeText=scope=>[daysLabel(scope.days),scope.kinds.length===MAP_KINDS.length?t('mapAllTypes'):scope.kinds.map(kind=>groupName(kindGroup(kind))).join(' / ')||t('mapNoTypes'),scope.query?message('mapQueryValue',scope.query):'',scope.project_id,scope.task_id].filter(Boolean).join(' · ');
const figures=graph=>{const keywords=new Set(graph.memories.flatMap(memory=>(memory.concepts||[]).map(conceptKey))).size;return `<div class="map-figure"><b>${num(graph.unavailable?null:graph.returned??graph.memories.length)}</b><span>${label('mapShownMemories')}</span></div><div class="map-figure"><b>${num(graph.unavailable?null:keywords)}</b><span>${label(keywords?'mapKeywords':'mapNoKeywords')}</span></div>`;};
const legend=(graph,wanted)=>Object.entries(kindCounts(graph)).filter(([,count])=>count>0).map(([kind,count])=>`<li><button type="button" class="node-key map-kind" data-group="${kindGroup(kind)}" data-map-kind="${kind}" aria-pressed="${wanted.kinds.includes(kind)}">${esc(groupName(kindGroup(kind)))} <span>${num(count)}</span></button></li>`).join('');
const directory=(plan,selected)=>plan.anchors.map(anchor=>`<li><button type="button" data-map-node-key="${esc(anchor.key)}" aria-pressed="${selected.has(anchor.key)}"><span class="node-key" data-group="${anchor.group||'entity'}">${esc(anchor.label)}</span><span>${num(anchor.count)}</span></button></li>`).join('');
const range=days=>`<div class="map-range" role="group" data-i18n-aria-label="mapTimeRange" aria-label="${esc(t('mapTimeRange'))}">${MAP_DAYS.map(value=>`<button type="button" data-map-days="${value}" aria-pressed="${value===days}" aria-label="${esc(daysLabel(value))}">${esc(rangeLabel(value))}</button>`).join('')}</div>`;
const empty=graph=>graph.memories.length?'':`<p class="map-empty">${label(graph.unavailable?'mapUnavailable':graph.hidden_all?'mapHiddenAll':graph.active_total===0?'mapNoMemories':'mapNoMatches')}</p>`;
export function mapCard(features){
 const source=features.attention?.graph||(features.attention===null?unavailableGraph():null);if(!source)return '';
 const graph=renderedGraph(source),scope=scopeOf(graph),plan=mapAnchors(graph);
 return `<section class="card map-card map-card--browse" data-memory-map data-selection-count="0"><header class="section-head map-heading"><div class="map-heading-title"><h2>${label('mapTitle')}</h2><div class="map-figures" data-map-figures>${figures(graph)}</div></div><div class="map-heading-actions"><button type="button" class="quiet" data-map-filter-toggle aria-expanded="false" aria-controls="memory-map-filters">${label('mapFilters')}</button><button type="button" class="quiet" data-map-refresh>${label('refresh')}</button></div></header>
  <div class="map-toolbar">${range(scope.days)}</div>
  <div class="map-filter-panel" id="memory-map-filters" data-map-filters hidden><h3>${label('mapFilterHeading')}</h3><form class="map-search" data-map-search role="search"><label><span class="sr-only">${label('mapSearch')}</span><input type="search" data-map-query name="graph_query" maxlength="400" value="${esc(scope.query)}" data-i18n-placeholder="mapSearch" placeholder="${esc(t('mapSearch'))}" autocomplete="off"></label><button type="submit">${label('search')}</button><button type="button" class="quiet" data-map-reset>${label('resetFilters')}</button></form>
  <form class="map-scope-filters" data-map-scope-filter><label>${label('mapProjectScope')}<select data-map-project><option value="">${esc(t('mapAllProjects'))}</option></select></label><button type="button" data-map-project-more hidden>${label('mapMoreProjects')}</button><label>${label('mapTaskScope')}<input data-map-task maxlength="128" value="${esc(scope.task_id)}" autocomplete="off"></label><button type="submit">${label('applyFilters')}</button><span data-map-project-status role="status"></span></form><p class="muted">${label('mapProjectNote')}</p>
  <div class="map-filter-options"><label class="map-custom">${label('mapCustomDays')}<input type="number" min="1" max="3650" step="1" inputmode="numeric" data-i18n-placeholder="mapCustomDays" placeholder="${esc(t('mapCustomDays'))}" data-map-custom value="${MAP_DAYS.includes(scope.days)?'':scope.days}"></label><div><p>${label('mapFilterTypes')}</p><ul class="map-legend" data-map-legend>${legend(graph,scope)}</ul></div></div><p class="muted" data-map-rendering-note>${label(plan.aggregate?'mapAggregateHint':'mapDotsHint')}</p><p class="muted">${label('mapLabelDensityNote')}</p></div>
  <div class="map-snapshot-line"><p class="map-coverage" data-map-coverage>${esc(coverage(graph))}</p><p class="map-scope muted" data-map-scope title="${esc(scopeText(scope))}">${esc(message('mapAppliedScope',scopeText(scope)))}</p></div><div data-map-status role="status" aria-live="polite"></div>
  <div class="map-board"><div class="map-zoom" role="group" data-i18n-aria-label="mapZoom" aria-label="${esc(t('mapZoom'))}"><button type="button" data-map-zoom="in" data-i18n-aria-label="mapZoomIn" aria-label="${esc(t('mapZoomIn'))}">+</button><button type="button" data-map-zoom="out" data-i18n-aria-label="mapZoomOut" aria-label="${esc(t('mapZoomOut'))}">−</button><button type="button" data-map-zoom="reset">${label('mapResetView')}</button></div><div class="map-tip" data-map-tip hidden></div><aside class="map-panel" data-map-panel hidden></aside><canvas data-map-canvas role="img" data-i18n-aria-label="mapDescription" aria-label="${esc(t('mapDescription'))}"></canvas><div data-map-empty>${empty(graph)}</div></div>
  <div class="map-selection-bar" data-map-selection hidden><p data-map-selection-count role="status" aria-live="polite"></p><ul data-map-selection-chips></ul><button type="button" class="quiet" data-map-clear>${label('mapClearSelection')}</button></div>
  <p class="map-hint" data-map-hint>${label('mapCooccurrence')}</p><div class="map-browse-tools"><details class="map-directory"><summary>${label('mapBrowseShort')} <span data-map-node-count>${num(plan.anchors.length)}</span></summary><p class="muted">${label('mapKeyboardHint')}</p><ul data-map-nodes>${directory(plan,new Set())}</ul></details>${neighborhoodCard({compact:true})}</div></section>`;
}

// Only the newest request for the still-mounted account may replace a graph. A failed filter read
// keeps the previous snapshot visible, explicitly labelled; it never becomes an empty result.
export function mountMemoryMap({api,root,data,isActive,openMemory}){
 const card=root.querySelector('[data-memory-map]'),canvas=card?.querySelector('[data-map-canvas]');
 if(!canvas)return null;
 let graph=renderedGraph(data.features?.attention?.graph||unavailableGraph()),wanted=scopeOf(graph),selected=new Set(),lastNodeKey=null,memoryOffset=0,sequence=0,disposed=false,loading=false,error=graph.unavailable===true,map,lastPanelHtml=null,lastDirectoryHtml=null;
 const panel=card.querySelector('[data-map-panel]'),query=card.querySelector('[data-map-query]'),status=card.querySelector('[data-map-status]'),nodeList=card.querySelector('[data-map-nodes]'),filters=card.querySelector('[data-map-filters]');
 const alive=()=>!disposed&&card.isConnected&&isActive();
 const explorer=mountNeighborhood({root:card,api,isActive,readScope:()=>scopeOf(graph),openMemory});
 let projectOffset=0,projectBusy=false;
 async function projects(){if(projectBusy)return;projectBusy=true;const target=card.querySelector('[data-map-project]'),more=card.querySelector('[data-map-project-more]'),notice=card.querySelector('[data-map-project-status]');
  try{const reply=await api('projects',{offset:projectOffset,limit:50,archived:'any'});if(!alive())return;
   for(const row of reply.projects||[]){if([...target.options].some(option=>option.value===row.project_id))continue;const option=document.createElement('option');option.value=row.project_id;option.textContent=row.name||row.project_id;target.append(option);}
   projectOffset=reply.next_offset;more.hidden=projectOffset===null;notice.textContent='';
  }catch{if(alive()){notice.textContent=t('mapProjectsFailed');more.hidden=false;}}finally{projectBusy=false;}}
 const select=keys=>{selected=new Set(keys);memoryOffset=0;show();};
 function show(){
  const focused=document.activeElement,restore=panel.contains(focused)?Object.entries(focused.dataset):null;
  panel.hidden=!selected.size;const html=selected.size?selectionPanel(graph,map.plan,selected,{offset:memoryOffset}):'';if(html!==lastPanelHtml){panel.innerHTML=html;lastPanelHtml=html;}
  for(const button of nodeList.querySelectorAll('[data-map-node-key]'))button.setAttribute('aria-pressed',String(selected.has(button.dataset.mapNodeKey)));
  card.dataset.selectionCount=String(selected.size);const strip=card.querySelector('[data-map-selection]');strip.hidden=!selected.size;
  card.querySelector('[data-map-selection-count]').textContent=selected.size?message('mapSelectionSummary',selected.size,num(selectedMemories(graph,map.plan,selected).length)):'';
  const chips=card.querySelector('[data-map-selection-chips]'),chipHtml=map?.plan.anchors.filter(anchor=>selected.has(anchor.key)).map(anchor=>`<li><button type="button" class="quiet" data-map-node-key="${esc(anchor.key)}" aria-pressed="true" aria-label="${esc(message('mapRemoveNode',anchor.label))}">${esc(anchor.label)} <span aria-hidden="true">×</span></button></li>`).join('')||'';
  if(chips.innerHTML!==chipHtml)chips.innerHTML=chipHtml;
  if(restore&&!panel.hidden){const same=[...panel.querySelectorAll('button')].find(button=>restore.every(([key,value])=>button.dataset[key]===value));(same||panel.querySelector('[data-map-close]'))?.focus({preventScroll:true});}
 }
 function repaintNodes(){
  const focused=document.activeElement,key=nodeList.contains(focused)?focused.dataset.mapNodeKey:null;
  const html=directory(map.plan,selected);if(html!==lastDirectoryHtml){nodeList.innerHTML=html;lastDirectoryHtml=html;}
  if(key){const same=[...nodeList.querySelectorAll('[data-map-node-key]')].find(button=>button.dataset.mapNodeKey===key);(same||card.querySelector('.map-directory summary'))?.focus({preventScroll:true});}
 }
 const focusNode=key=>{const target=[...nodeList.querySelectorAll('[data-map-node-key]')].find(button=>button.dataset.mapNodeKey===key);(target&&card.querySelector('.map-directory').open?target:card.querySelector('.map-directory summary'))?.focus({preventScroll:true});};
 const closePanel=({restoreFocus=false}={})=>{map.clearSelection();if(restoreFocus)focusNode(lastNodeKey);};
 function paint(){
  if(!alive())return;
  const focused=document.activeElement,focusKind=focused?.dataset?.mapKind,restoreKind=focusKind&&card.contains(focused);
  card.querySelector('[data-map-figures]').innerHTML=figures(graph);card.querySelector('[data-map-legend]').innerHTML=legend(graph,wanted);
  card.querySelector('[data-map-coverage]').textContent=coverage(graph);const applied=scopeText(scopeOf(graph));card.querySelector('[data-map-scope]').textContent=message('mapAppliedScope',applied);card.querySelector('[data-map-scope]').title=applied;
  card.querySelector('[data-map-empty]').innerHTML=empty(graph);repaintNodes();
  card.querySelector('[data-map-node-count]').textContent=num(map.plan.anchors.length);
  card.querySelector('[data-map-hint]').textContent=t('mapCooccurrence');card.querySelector('[data-map-rendering-note]').textContent=t(map.plan.aggregate?'mapAggregateHint':'mapDotsHint');
  for(const button of card.querySelectorAll('[data-map-days]')){const days=Number(button.dataset.mapDays);button.setAttribute('aria-pressed',String(days===wanted.days));button.textContent=rangeLabel(days);button.setAttribute('aria-label',daysLabel(days));}
  const custom=card.querySelector('[data-map-custom]');if(document.activeElement!==custom)custom.value=MAP_DAYS.includes(wanted.days)?'':String(wanted.days);
  card.querySelector('.map-custom').classList.toggle('is-active',!MAP_DAYS.includes(wanted.days));
  card.setAttribute('aria-busy',String(loading));
  status.innerHTML=loading?`<p>${label(graph.unavailable?'mapInitialLoading':'mapLoading')}</p>`:error?`<p>${label(graph.unavailable?'mapUnavailable':'mapReadFailed')} <button type="button" data-map-retry>${label('retry')}</button></p>`:'';
  if(restoreKind)card.querySelector(`[data-map-kind="${focusKind}"]`)?.focus();show();
 }
 map=memoryMap(canvas,graph,{onSelectionChange:select,onMemory:openMemory,tip:card.querySelector('[data-map-tip]'),top:30,insets:()=>({top:30,bottom:50}),panelWidth:316,onLayout:()=>{if(map){selected=new Set(map.selectedKeys);repaintNodes();show();}}});
 async function request(){
  const mine=++sequence,requested={...wanted,kinds:[...wanted.kinds]};explorer?.reset();loading=true;error=false;map.clearSelection();paint();
  try{
   const params={graph_days:requested.days,...(!requested.kinds.length||requested.kinds.length===MAP_KINDS.length?{}:{graph_kinds:requested.kinds.join(',')}),...(requested.query?{graph_query:requested.query}:{}),...(requested.project_id?{graph_project_id:requested.project_id}:{}),...(requested.task_id?{graph_task_id:requested.task_id}:{})};
   const result=await api('attention',params);if(mine!==sequence||!alive())return;
   if(!result.graph||!Array.isArray(result.graph.memories)||!result.graph.scope)throw new Error('MAP_INVALID_REPLY');
   const matchingKinds=Object.entries(kindCounts(result.graph)).filter(([,count])=>count>0).map(([kind])=>kind);
   graph=requested.kinds.length?{...result.graph,hidden_all:matchingKinds.length>0&&!matchingKinds.some(kind=>requested.kinds.includes(kind))}:{...result.graph,memories:[],returned:0,filtered_total:0,truncated:false,truncation_reason:null,hidden_all:true,scope:{...result.graph.scope,kinds:[]}};
   wanted=scopeOf(graph);loading=false;error=false;saveDays(wanted.days);query.value=wanted.query;map.setGraph(graph);paint();
  }catch{if(mine!==sequence||!alive())return;loading=false;error=true;paint();}
 }
 const click=event=>{
  const filterToggle=event.target.closest('[data-map-filter-toggle]');if(filterToggle){filters.hidden=!filters.hidden;filterToggle.setAttribute('aria-expanded',String(!filters.hidden));return;}
  const explore=event.target.closest('[data-map-explore]');if(explore){if(!loading)explorer?.explore(explore.dataset.mapExplore);return;}
  if(event.target.closest('[data-map-project-more]')){void projects();return;}
  const node=event.target.closest('[data-map-node-key]');if(node){lastNodeKey=node.dataset.mapNodeKey;const fromChip=card.querySelector('[data-map-selection-chips]').contains(node),fromPanel=panel.contains(node);map.toggleKey(lastNodeKey);if(event.detail===0&&(fromChip||fromPanel&&!selected.size))focusNode(lastNodeKey);return;}
  const memory=event.target.closest('[data-map-memory]');if(memory){if(graph.memories.some(item=>item.id===memory.dataset.mapMemory))openMemory(memory.dataset.mapMemory);return;}
  const page=event.target.closest('[data-map-memory-offset]');if(page){memoryOffset=Number(page.dataset.mapMemoryOffset);show();panel.querySelector('[data-map-memory]')?.focus({preventScroll:true});return;}
  if(event.target.closest('[data-map-close],[data-map-clear]')){closePanel({restoreFocus:event.detail===0});return;}
  const zoom=event.target.closest('[data-map-zoom]');if(zoom){zoom.dataset.mapZoom==='reset'?map.reset():map.zoom(zoom.dataset.mapZoom==='in'?1.4:1/1.4);return;}
  const day=event.target.closest('[data-map-days]');if(day){wanted={...wanted,days:Number(day.dataset.mapDays)};void request();return;}
  const kind=event.target.closest('[data-map-kind]');if(kind){const value=kind.dataset.mapKind;wanted={...wanted,kinds:MAP_KINDS.filter(item=>item===value?!wanted.kinds.includes(item):wanted.kinds.includes(item))};void request();return;}
  if(event.target.closest('[data-map-reset]')){wanted={days:30,kinds:[...MAP_KINDS],query:'',project_id:'',task_id:''};card.querySelector('[data-map-project]').value='';card.querySelector('[data-map-task]').value='';query.value='';query.setCustomValidity('');void request();return;}
  if(event.target.closest('[data-map-retry],[data-map-refresh]'))void request();
 };
 const submit=event=>{if(event.target.matches('[data-map-scope-filter]')){event.preventDefault();wanted={...wanted,project_id:card.querySelector('[data-map-project]').value,task_id:card.querySelector('[data-map-task]').value.trim()};void request();return;}
  if(!event.target.matches('[data-map-search]'))return;event.preventDefault();const value=query.value.trim().replace(/\s+/gu,' ');if([...value].length>200){query.setCustomValidity(t('mapQueryTooLong'));query.reportValidity();return;}query.setCustomValidity('');wanted={...wanted,query:value};void request();};
 const change=event=>{if(!event.target.matches('[data-map-custom]'))return;const value=Number(event.target.value);if(!Number.isInteger(value)||value<1||value>3650){event.target.reportValidity();return;}wanted={...wanted,days:value};void request();};
 const keydown=event=>{if(event.key==='Escape'&&selected.size){event.preventDefault();closePanel({restoreFocus:panel.contains(document.activeElement)});}else if(event.key==='Escape'&&!filters.hidden&&filters.contains(event.target)){filters.hidden=true;const button=card.querySelector('[data-map-filter-toggle]');button.setAttribute('aria-expanded','false');button.focus({preventScroll:true});}};
 const input=()=>query.setCustomValidity('');
 const appearance=()=>{if(!alive())return;map.setGraph(graph,{selectedKeys:selected});paint();};
 card.addEventListener('click',click);card.addEventListener('submit',submit);card.addEventListener('change',change);card.addEventListener('keydown',keydown);query.addEventListener('input',input);document.addEventListener('appearancechange',appearance);
 paint();void projects();const preferred=savedDays();if(preferred!==null&&preferred!==wanted.days){wanted={...wanted,days:preferred};void request();}
 return {replay:items=>map.replay(items),dispose(){disposed=true;sequence++;explorer?.dispose();map.dispose();card.removeEventListener('click',click);card.removeEventListener('submit',submit);card.removeEventListener('change',change);card.removeEventListener('keydown',keydown);query.removeEventListener('input',input);document.removeEventListener('appearancechange',appearance);panel.replaceChildren();panel.hidden=true;}};
}

// Canvas renderer follows below. Selection is keyed independently from the viewport's anchor count.
export function memoryMap(canvas,initialGraph,{onSelect=null,onSelectionChange=null,onMemory=null,onLayout=null,tip=null,top:topInset=null,insets=null,panelWidth=0}={}){const media=matchMedia('(prefers-reduced-motion: reduce)'),token=n=>getComputedStyle(canvas).getPropertyValue(n).trim();let reduce=media.matches;
  const colour={pref:'--c-pref',proj:'--c-proj',flow:'--c-flow',fact:'--c-fact',bug:'--c-bug',pat:'--c-pat',none:'--c-none'};let graph=initialGraph,plan=mapAnchors(graph);
  let nodes=[],links=[],W=0,H=0,dpr=1,pulses=[],frame=0,events=[],cursor=0,timer=0,hover=-1,view={s:1,x:0,y:0},drag=null,lit=null,selectedKey=null,selectedKeys=new Set(),selectedIndices=new Set(),disposed=false;
  const listeners=[],listen=(name,handler,options)=>{canvas.addEventListener(name,handler,options);listeners.push([name,handler,options]);};
  function layout(){const r=canvas.getBoundingClientRect();W=Math.max(1,r.width);H=Math.max(1,r.height);dpr=devicePixelRatio||1;canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);
    // More room, more connection points (8–30); fewer on a phone so labels do not collide.
    plan=mapAnchors(graph,{max:Math.max(8,Math.min(30,Math.round(W*H/36000)))});
    let seed=7;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
    // insets(): the space the card's overlays (figures, legend) take, measured; otherwise a fixed estimate.
    const measured=insets?.()||{},top=measured.top??topInset??Math.min(110,H*.24),bottom=measured.bottom??(W<560?100:56),cy=top+(H-top-bottom)/2,ry=(H-top-bottom)/2,inner=plan.anchors.filter(a=>!a.group),outer=plan.anchors.filter(a=>!!a.group);
    const place=(list,i,rx,rr)=>list.length>1?[W/2+Math.cos(i/list.length*6.283+.4)*rx,cy+Math.sin(i/list.length*6.283+.4)*rr]:[W/2,cy];
    nodes=plan.anchors.map(a=>{const ring=!!a.group&&inner.length?outer:inner.length?inner:outer,far=!!a.group&&inner.length;
      const [x,y]=place(ring,ring.indexOf(a),W*(far?.4:.26),ry*(far?.85:.6));return {...a,anchor:true,x:x+(rnd()-.5)*30,y:y+(rnd()-.5)*20,r:Math.min(far?9:15,3.5+Math.sqrt(a.count)*.9)};});
    const n0=nodes.length;
    // Aggregated: keywords only, linked by co-occurrence (w = shared memories); otherwise every memory is a dot.
    if(plan.aggregate){const most=Math.max(1,...plan.edges.map(([,,n])=>n));links=plan.edges.map(([a,b,n])=>[a,b,n/most]);for(const p of nodes)p.r=Math.min(22,4+Math.sqrt(p.count)*1.1);}
    else{graph.memories.forEach((m,i)=>{const a=nodes[plan.links[i][0]?.[0]];nodes.push({anchor:false,id:m.id,group:kindGroup(m.kind),topic:m.topic,x:(a?a.x:W/2)+(rnd()-.5)*90,y:(a?a.y:cy)+(rnd()-.5)*90,r:2.6});});
      links=plan.links.flatMap((es,i)=>es.map(([e,w])=>[n0+i,e,w]));}
    const n=nodes.length,steps=n>250?110:170,span=Math.min(W,(H-top-bottom)*1.7);
    for(let it=0;it<steps;it++){for(let a=0;a<n;a++)for(let b=a+1;b<n;b++){const A=nodes[a],B=nodes[b],dx=A.x-B.x,dy=A.y-B.y,d=Math.hypot(dx,dy)||1,want=A.anchor&&B.anchor?span*(A.group||B.group?.34:.3):A.anchor||B.anchor?A.r+B.r+16:15;
        if(d<want){const k=(want-d)/d*.08;A.x+=dx*k;A.y+=dy*k;B.x-=dx*k;B.y-=dy*k;}}
      for(const [a,b,w] of links){const A=nodes[a],B=nodes[b],dx=B.x-A.x,dy=B.y-A.y,d=Math.hypot(dx,dy)||1,rest=plan.aggregate?span*(.34-.14*w):w<1?span*.22:(plan.mode==='kinds'?40:52),k=(d-rest)/d*.04*(plan.aggregate?.3+w*.7:w);
        A.x+=dx*k;A.y+=dy*k;B.x-=dx*k*(plan.aggregate?1:.12);B.y-=dy*k*(plan.aggregate?1:.12);}
      for(const p of nodes){p.x+=(W/2-p.x)*.0012;p.y+=(cy-p.y)*.0012;p.x=Math.max(24,Math.min(W-24,p.x));p.y=Math.max(top,Math.min(H-bottom,p.y));}}
    fit(top,bottom);const valid=new Set(plan.anchors.map(anchor=>anchor.key));selectedKeys=new Set([...selectedKeys].filter(key=>valid.has(key)));selectedKey=[...selectedKeys].at(-1)||null;selectedIndices=new Set(plan.anchors.flatMap((anchor,index)=>selectedKeys.has(anchor.key)?[index]:[]));canvas.dataset.selectedCount=String(selectedKeys.size);hover=-1;drag=null;pulses=[];delete canvas.dataset.hover;delete canvas.dataset.dragging;if(tip)tip.hidden=true;view={s:1,x:0,y:0};highlight();onLayout?.();}
  // Stretch the finished layout over the whole free area (labels of connection points kept inside on the right).
  function fit(top,bottom){if(nodes.length<2)return;const pad=28,label=p=>p.anchor?Math.min(18,p.label.length)*6.6+p.r+12:p.r;
    const minX=Math.min(...nodes.map(p=>p.x-p.r)),maxX=Math.max(...nodes.map(p=>p.x+label(p))),minY=Math.min(...nodes.map(p=>p.y-p.r)),maxY=Math.max(...nodes.map(p=>p.y+p.r));
    const sx=(W-2*pad)/Math.max(1,maxX-minX),sy=(H-top-bottom)/Math.max(1,maxY-minY),k=Math.min(sx,sy),kx=Math.min(sx,k*1.8),ky=Math.min(sy,k*1.8);
    const ox=pad+((W-2*pad)-(maxX-minX)*kx)/2,oy=top+((H-top-bottom)-(maxY-minY)*ky)/2;
    for(const p of nodes){p.x=ox+(p.x-minX)*kx;p.y=oy+(p.y-minY)*ky;}}
  const bend=(A,B,i)=>{const s=(i%2?1:-1)*.16;return [(A.x+B.x)/2-(B.y-A.y)*s,(A.y+B.y)/2+(B.x-A.x)*s];};
  const highlight=()=>{lit=selectedKeys.size?new Set([...selectedIndices,...links.filter(([a,b])=>selectedIndices.has(b)||plan.aggregate&&selectedIndices.has(a)).flatMap(([a,b])=>[a,b])]):null;};
  // Place the most relevant labels first, never over other labels or anchor circles.
  // Dense views may omit a label, not its node; hover and the native node directory keep
  // the complete exact spelling accessible. Recompute in viewport space on pan/zoom.
  function labelPositions(g){
    const boxes=[],placed=new Map(),fontHeight=10/Math.sqrt(view.s),gap=3/view.s;
    const overlaps=(a,b)=>a.x<b.x+b.w+gap&&a.x+a.w>b.x-gap&&a.y<b.y+b.h+gap&&a.y+a.h>b.y-gap;
    const anchorIndices=nodes.flatMap((p,i)=>p.anchor?[i]:[]),priority=i=>(selectedIndices.has(i)?2:0)+(i===hover?1:0);
    for(const i of [...anchorIndices].sort((a,b)=>priority(b)-priority(a)||nodes[b].count-nodes[a].count||a-b)){
      const p=nodes[i],label=p.label.length>18?p.label.slice(0,17)+'…':p.label,width=g.measureText(label).width;
      const candidates=[[p.x+p.r+8/view.s,p.y+fontHeight*.35],[p.x-p.r-8/view.s-width,p.y+fontHeight*.35],[p.x-width/2,p.y-p.r-8/view.s],[p.x-width/2,p.y+p.r+fontHeight+8/view.s]];
      for(const [x,y] of candidates){const box={x:x-2/view.s,y:y-fontHeight-2/view.s,w:width+4/view.s,h:fontHeight+6/view.s};
        if(box.x*view.s+view.x<5||(box.x+box.w)*view.s+view.x>W-5||box.y*view.s+view.y<5||(box.y+box.h)*view.s+view.y>H-5)continue;
        if(boxes.some(other=>overlaps(box,other))||anchorIndices.some(index=>{if(index===i)return false;const other=nodes[index];return overlaps(box,{x:other.x-other.r-3/view.s,y:other.y-other.r-3/view.s,w:2*other.r+6/view.s,h:2*other.r+6/view.s});}))continue;
        placed.set(i,{x,y,label});boxes.push(box);break;
      }
    }
    canvas.dataset.labelsHidden=String(anchorIndices.length-placed.size);return placed;
  }
  function draw(){const g=canvas.getContext('2d');g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,W,H);g.setTransform(dpr*view.s,0,0,dpr*view.s,dpr*view.x,dpr*view.y);
    // Sticky board (--map-style: outline): pastel fills with ink outlines, no glow; otherwise glowing nodes.
    const ink=token('--text'),line=token('--line-strong'),ent=token('--c-ent'),bg=token('--surface'),flat=token('--map-style')==='outline',blur=n=>{g.shadowBlur=flat?0:n;};
    links.forEach(([a,b,w],i)=>{const A=nodes[a],B=nodes[b],[qx,qy]=bend(A,B,i),on=lit&&(selectedIndices.has(b)||plan.aggregate&&selectedIndices.has(a));g.strokeStyle=on?(flat?ink:!!B.group?token(colour[B.group]):ent):line;g.globalAlpha=on?.8:lit?.07:plan.aggregate?.18+.4*w:(w<1?.13:.32)*(flat?.7:1);g.lineWidth=(plan.aggregate?1+3*w:on?1.4:1)/view.s;g.beginPath();g.moveTo(A.x,A.y);g.quadraticCurveTo(qx,qy,B.x,B.y);g.stroke();});g.globalAlpha=1;
    pulses=pulses.filter(p=>p.k<1);for(const p of pulses){const A=nodes[p.a],B=nodes[p.b],[qx,qy]=bend(A,B,p.i),k=p.k,u=1-k,x=u*u*A.x+2*u*k*qx+k*k*B.x,y=u*u*A.y+2*u*k*qy+k*k*B.y;
      g.fillStyle=p.colour;g.shadowColor=p.colour;blur(14);g.beginPath();g.arc(x,y,flat?3.6:2.8,0,7);g.fill();g.shadowBlur=0;if(flat){g.strokeStyle=ink;g.lineWidth=1.4/view.s;g.stroke();}p.k+=.016;}
    nodes.forEach((p,i)=>{if(p.anchor)return;const c=token(colour[p.group]);g.globalAlpha=lit&&!lit.has(i)?.2:1;g.fillStyle=c;g.shadowColor=c;blur(7);g.beginPath();g.arc(p.x,p.y,(i===hover?p.r+1.6:p.r)+(flat?.6:0),0,7);g.fill();g.shadowBlur=0;if(flat){g.strokeStyle=ink;g.lineWidth=1/view.s;g.stroke();}
      if(i===hover){g.strokeStyle=ink;g.lineWidth=1.2/view.s;g.beginPath();g.arc(p.x,p.y,p.r+4,0,7);g.stroke();}g.globalAlpha=1;});
    g.font=`${flat?600:500} ${10/Math.sqrt(view.s)}px "Martian Mono",ui-monospace,monospace`;g.lineJoin='round';
    const labels=labelPositions(g);
    nodes.forEach((p,i)=>{if(!p.anchor)return;const c=!!p.group?token(colour[p.group]):ent,r=p.r,chosen=selectedIndices.has(i),dim=lit&&!chosen&&(plan.aggregate?!lit.has(i):!links.some(([a,b])=>b===i&&lit.has(a)));g.globalAlpha=dim?.35:1;
      if(!flat){const halo=g.createRadialGradient(p.x,p.y,0,p.x,p.y,r*3.2);halo.addColorStop(0,c+'55');halo.addColorStop(1,c+'00');g.fillStyle=halo;g.beginPath();g.arc(p.x,p.y,r*3.2,0,7);g.fill();}
      g.strokeStyle=chosen||i===hover||flat?ink:c;g.globalAlpha=chosen||i===hover?1:dim?.2:.5;g.lineWidth=(chosen?2:1.2)/view.s;g.beginPath();g.arc(p.x,p.y,r+(chosen?6:i===hover?5:3.5),0,7);g.stroke();g.globalAlpha=dim?.35:1;
      if(flat){g.fillStyle=ink;g.beginPath();g.arc(p.x+2/view.s,p.y+2/view.s,r+1,0,7);g.fill();g.globalAlpha=dim?.35:1;g.fillStyle=c;g.beginPath();g.arc(p.x,p.y,r+1,0,7);g.fill();g.strokeStyle=ink;g.lineWidth=2/view.s;g.stroke();}
      else{const core=g.createRadialGradient(p.x-r*.3,p.y-r*.3,0,p.x,p.y,r);core.addColorStop(0,'#FFFFFF');core.addColorStop(.45,c);core.addColorStop(1,c);g.fillStyle=core;g.beginPath();g.arc(p.x,p.y,r,0,7);g.fill();}
      const position=labels.get(i);if(position){g.strokeStyle=bg;g.lineWidth=4/view.s;g.globalAlpha=dim?.3:.9;g.strokeText(position.label,position.x,position.y);g.globalAlpha=dim?.3:flat?1:!!p.group?.65:.85;g.fillStyle=ink;g.fillText(position.label,position.x,position.y);}g.globalAlpha=1;});}
  function loop(){if(disposed||!canvas.isConnected){clearTimeout(timer);frame=0;return;}draw();frame=pulses.length&&!document.hidden?requestAnimationFrame(loop):0;}
  const start=()=>{if(!frame&&!reduce)frame=requestAnimationFrame(loop);};
  function pulse(item){const i=item.memory_id?nodes.findIndex(n=>n.id===item.memory_id):-1,targets=i>=0?[i]:(item.refs||[]).map(id=>nodes.findIndex(n=>n.id===id)).filter(x=>x>=0).slice(0,3);
    const col=token(item.kind==='write'?'--c-proj':'--c-pref');for(const target of targets)links.forEach(([a,b],li)=>{if(a===target)pulses.push({a,b,i:li,k:0,colour:col});});start();}
  // Pointer handling in screen space; nodes live in map space (view: scale s, offset x/y).
  const point=event=>{const b=canvas.getBoundingClientRect();return [event.clientX-b.left,event.clientY-b.top];};
  const hitAt=(px,py)=>{const x=(px-view.x)/view.s,y=(py-view.y)/view.s,reach=r=>r+8/view.s,nearest=keep=>{let best=-1,bd=Infinity;
      nodes.forEach((p,i)=>{if(!keep(p))return;const d=Math.hypot(p.x-x,p.y-y);if(d<reach(p.r)&&d<bd){best=i;bd=d;}});return best;};
    const anchor=nearest(p=>p.anchor);return anchor>=0?anchor:nearest(p=>!p.anchor);};
  const showTip=(i,px,py)=>{if(!tip)return;if(i<0){tip.hidden=true;return;}const p=nodes[i];
    tip.textContent=p.anchor?`${anchorType(p)}: ${p.title||p.label} · ${message('mapMemoryCount',num(p.count))}`:`${groupName(p.group)}${p.topic?' · '+p.topic:''} · ${t('mapOpenMemory')}`;
    tip.hidden=false;tip.style.transform=`translate(${Math.round(Math.min(px+14,W-tip.offsetWidth-8))}px,${Math.round(Math.max(8,py-tip.offsetHeight-10))}px)`;};
  // A panel on the right covers part of the map: a chosen point under it slides into view on the left.
  const reveal=i=>{if(i<0||!nodes[i]||!panelWidth||W<panelWidth*2)return;const sx=nodes[i].x*view.s+view.x;if(sx>W-panelWidth-24)view={...view,x:view.x-(sx-(W-panelWidth)/2)};};
  const stopReplay=()=>{clearTimeout(timer);timer=0;events=[];cursor=0;pulses=[];if(frame)cancelAnimationFrame(frame);frame=0;};
  const notifySelection=()=>{onSelect?.(selectedKey);onSelectionChange?.([...selectedKeys]);};
  const choose=(keys,revealKey=null)=>{const valid=new Set(plan.anchors.map(anchor=>anchor.key));selectedKeys=new Set([...keys].filter(key=>valid.has(key)));selectedKey=[...selectedKeys].at(-1)||null;selectedIndices=new Set(plan.anchors.flatMap((anchor,index)=>selectedKeys.has(anchor.key)?[index]:[]));canvas.dataset.selectedCount=String(selectedKeys.size);stopReplay();hover=-1;delete canvas.dataset.hover;showTip(-1);highlight();reveal(plan.anchors.findIndex(anchor=>anchor.key===revealKey));draw();notifySelection();};
  const toggleKey=key=>{if(!plan.anchors.some(anchor=>anchor.key===key))return;const keys=new Set(selectedKeys);if(keys.has(key))keys.delete(key);else keys.add(key);choose(keys,keys.has(key)?key:null);};
  const zoomAt=(f,px=W/2,py=H/2)=>{const s=Math.min(6,Math.max(.6,view.s*f));view={s,x:px-(px-view.x)*s/view.s,y:py-(py-view.y)*s/view.s};draw();};
  listen('pointerdown',event=>{if(event.button)return;const [px,py]=point(event);drag={px,py,x:view.x,y:view.y,moved:false};canvas.setPointerCapture(event.pointerId);});
  listen('pointermove',event=>{const [px,py]=point(event);
    if(drag){const dx=px-drag.px,dy=py-drag.py;if(!drag.moved&&Math.hypot(dx,dy)>4){drag.moved=true;showTip(-1);canvas.dataset.dragging='';}if(drag.moved){view={...view,x:drag.x+dx,y:drag.y+dy};draw();return;}}
    const i=hitAt(px,py);if(i!==hover){hover=i;draw();}canvas.dataset.hover=i>=0?'node':'';showTip(i,px,py);});
  listen('pointerup',event=>{const d=drag;drag=null;delete canvas.dataset.dragging;if(!d||d.moved)return;const [px,py]=point(event),i=hitAt(px,py);
    if(i<0){choose([]);return;}if(nodes[i].anchor)toggleKey(nodes[i].key);else onMemory?.(nodes[i].id);});
  listen('pointerleave',()=>{if(drag)return;hover=-1;delete canvas.dataset.hover;showTip(-1);draw();});
  listen('wheel',event=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();const [px,py]=point(event);zoomAt(Math.exp(-event.deltaY*.01),px,py);},{passive:false});
  listen('dblclick',event=>{const [px,py]=point(event);zoomAt(1.6,px,py);});
  listen('pointercancel',()=>{drag=null;delete canvas.dataset.dragging;delete canvas.dataset.hover;hover=-1;showTip(-1);draw();});
  const motion=event=>{reduce=event.matches;if(reduce){stopReplay();draw();}};media.addEventListener?.('change',motion);
  layout();draw();
  const observer=new ResizeObserver(()=>{if(disposed||!canvas.isConnected)return;layout();draw();});observer.observe(canvas);
  return {get plan(){return plan;},get graph(){return graph;},get selectedKey(){return selectedKey;},get selectedKeys(){return [...selectedKeys];},
    setGraph(next,{selectedKey:key=null,selectedKeys:keys=key?[key]:[]}={}){stopReplay();graph=next;selectedKeys=new Set(keys);layout();draw();notifySelection();},
    selectKey(key){choose(key?[key]:[],key);},toggleKey,clearSelection(){choose([]);},zoom(f){zoomAt(f);},reset(){view={s:1,x:0,y:0};draw();},
    // A new activity notification plays once. Historical records are never looped as live events.
    replay(items){stopReplay();events=items.filter(item=>item.memory_id||item.refs?.length);if(reduce||disposed||!events.length){draw();return;}
      const next=()=>{timer=0;if(disposed||!canvas.isConnected||document.hidden){stopReplay();return;}const item=events[cursor++];if(item)pulse(item);if(cursor<events.length)timer=setTimeout(next,2400);else events=[];};next();},
    dispose(){disposed=true;stopReplay();observer.disconnect();media.removeEventListener?.('change',motion);for(const args of listeners)canvas.removeEventListener(...args);showTip(-1);delete canvas.dataset.hover;delete canvas.dataset.dragging;canvas.dataset.selectedCount='0';}
  };
}

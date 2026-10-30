import {translate as t} from './appearance.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label=key=>`<span data-i18n="${key}">${esc(t(key))}</span>`;
const date=value=>value?String(value).slice(0,10):'—';
export const graphScopeParams=scope=>({graph_days:scope.days,graph_kinds:scope.kinds.join(','),...(scope.query?{graph_query:scope.query}:{}),
  ...(scope.project_id?{graph_project_id:scope.project_id}:{}),...(scope.task_id?{graph_task_id:scope.task_id}:{})});

export function neighborhoodCard(){return `<details class="map-neighborhood" data-map-neighborhood><summary>${label('mapExploreLibrary')}</summary>
  <p class="muted">${label('mapNeighborhoodNote')}</p><form data-neighbor-search class="map-search"><label>${label('mapExactKeyword')}<input data-neighbor-focus maxlength="400" required autocomplete="off"></label><button>${label('search')}</button></form>
  <div data-neighbor-status role="status" aria-live="polite"></div><div data-neighbor-result></div></details>`;}

export function neighborhoodResult(n){
 const e=n.evidence;
 return `<header><h3>${esc(n.focus)}${n.peer?` · ${esc(n.peer)}`:''}</h3><p>${label('mapCurrentCount')}: ${n.current_count} · ${label('mapHistoryCount')}: ${n.history_count}</p>
  <p class="muted">${label('mapFirstSeen')}: ${esc(date(n.first_seen))} · ${label('mapLastChanged')}: ${esc(date(n.last_changed))}</p></header>
  <p class="muted">${label('mapCooccurrence')} ${label('mapHistoryNote')}</p>
  <h4>${label('mapOneHop')}</h4><ul class="map-neighbor-list">${n.neighbors.map(row=>`<li><button type="button" class="quiet" data-neighbor-peer="${esc(row.keyword)}" aria-pressed="${row.keyword===n.peer}">${esc(row.label)} <small>${row.current_count} / ${row.history_count}</small></button></li>`).join('')}</ul>
  ${n.neighbors_truncated?`<p class="muted">${label('mapNeighborsLimited')}</p>`:''}
  ${n.neighbor_labels_omitted_records?`<p class="muted">${label('mapMetadataOmitted')}</p>`:''}
  <form data-neighbor-peer-form class="map-search"><label>${label('mapExactPeer')}<input data-neighbor-peer-input maxlength="400" value="${esc(n.peer||'')}" autocomplete="off"></label><button>${label('mapPairEvidence')}</button></form>
  <h4>${label('mapPairEvidence')} (${e.total})</h4><p class="muted">${label('mapCurrentCount')}: ${e.current_count} · ${label('mapHistoryCount')}: ${e.history_count} · ${label('mapFirstSeen')}: ${esc(date(e.first_seen))} · ${label('mapLastChanged')}: ${esc(date(e.last_changed))}</p>
  <label class="map-history-toggle"><input type="checkbox" data-neighbor-history ${e.include_history?'checked':''}> ${label('mapIncludeHistory')}</label>
  <ul class="map-evidence-list">${e.items.map(row=>`<li><button type="button" class="quiet" data-neighbor-memory="${esc(row.memory_id)}">${esc(row.topic||row.memory_id)}</button> <span>${esc(t(row.status))} · v${row.revision||1} · ${esc(date(row.updated_at))}</span>
   <small>${label('mapEvidenceDetails')}</small>${row.topic_omitted?`<small>${label('mapMetadataOmitted')}</small>`:''}${row.supersedes_memory_id||row.superseded_by_memory_id?`<small>${label('mapReplacement')}: ${esc(row.superseded_by_memory_id||row.supersedes_memory_id)}</small>`:''}</li>`).join('')}</ul>
  ${!e.total?`<p>${label('mapNoMatches')}</p>`:''}<div class="map-memory-pages"><span>${e.items.length?e.offset+1:0}–${e.offset+e.items.length} / ${e.total}</span>
    ${e.offset?`<button type="button" data-neighbor-offset="${Math.max(0,e.offset-e.limit)}">${label('previous')}</button>`:''}
    ${e.next_offset!==null?`<button type="button" data-neighbor-offset="${e.next_offset}">${label('next')}</button>`:''}</div>`;
}

/** Independent sequence fence; changing map filters or accounts invalidates all evidence and project replies. */
export function mountNeighborhood({root,api,isActive,readScope,openMemory}){
 const card=root.querySelector('[data-map-neighborhood]');if(!card)return null;
 const input=card.querySelector('[data-neighbor-focus]'),status=card.querySelector('[data-neighbor-status]'),body=card.querySelector('[data-neighbor-result]');
 let seq=0,disposed=false,result=null,last=null;
 const alive=()=>!disposed&&card.isConnected&&isActive();
 function reset(){seq++;result=null;last=null;body.replaceChildren();status.replaceChildren();card.removeAttribute('aria-busy');}
 async function request({focus=input.value.trim(),peer=null,offset=0,history=false}={}){
  if(!focus||[...focus].length>200||peer&&[...peer].length>200)return;
  const scope=readScope();if(!scope.kinds.length)return;
  const mine=++seq;last={focus,peer,offset,history};result=null;body.replaceChildren();card.open=true;card.setAttribute('aria-busy','true');status.textContent=t('loading');
  try{const response=await api('attention',{...graphScopeParams(scope),graph_focus:focus,...(peer?{graph_peer:peer}:{}),graph_offset:offset,graph_limit:10,graph_history:history?'1':'0'});
   if(mine!==seq||!alive())return;if(!response.graph?.neighborhood)throw new Error('MAP_INVALID_REPLY');
   result=response.graph.neighborhood;input.value=result.focus;body.innerHTML=neighborhoodResult(result);status.replaceChildren();
  }catch{if(mine!==seq||!alive())return;status.innerHTML=`${label('mapNeighborhoodReadFailed')} <button type="button" data-neighbor-retry>${label('retry')}</button>`;}
  finally{if(mine===seq&&alive())card.removeAttribute('aria-busy');}
 }
 const submit=event=>{if(event.target.matches('[data-neighbor-search]')){event.preventDefault();void request();}
  if(event.target.matches('[data-neighbor-peer-form]')){event.preventDefault();if(result)void request({focus:result.focus,peer:body.querySelector('[data-neighbor-peer-input]').value.trim()||null,history:result.evidence.include_history});}};
 const click=event=>{const peer=event.target.closest('[data-neighbor-peer]'),page=event.target.closest('[data-neighbor-offset]'),memory=event.target.closest('[data-neighbor-memory]');
  if(memory&&result?.evidence.items.some(row=>row.memory_id===memory.dataset.neighborMemory))openMemory(memory.dataset.neighborMemory);
  if(peer&&result)void request({focus:result.focus,peer:peer.dataset.neighborPeer,history:result.evidence.include_history});
  if(page&&result)void request({focus:result.focus,peer:result.peer,history:result.evidence.include_history,offset:Number(page.dataset.neighborOffset)});
  if(event.target.closest('[data-neighbor-retry]')&&last)void request(last);
 };
 const change=event=>{if(event.target.matches('[data-neighbor-history]')&&result)void request({focus:result.focus,peer:result.peer,history:event.target.checked});};
 const appearance=()=>{if(alive()&&result)body.innerHTML=neighborhoodResult(result);};
 card.addEventListener('submit',submit);card.addEventListener('click',click);card.addEventListener('change',change);document.addEventListener('appearancechange',appearance);
 return {reset,explore:focus=>{input.value=focus;void request({focus});card.scrollIntoView({block:'nearest'});},dispose(){reset();disposed=true;card.removeEventListener('submit',submit);card.removeEventListener('click',click);card.removeEventListener('change',change);document.removeEventListener('appearancechange',appearance);}};
}

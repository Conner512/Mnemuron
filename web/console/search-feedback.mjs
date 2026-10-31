import {translate as t} from './appearance.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label=key=>`<span data-i18n="${key}">${esc(t(key))}</span>`;
export const feedbackKinds=['relevant','irrelevant','outdated','missing'];
const kindLabel=kind=>t(`searchFeedback_${kind}`);
export function feedbackControls(memory,{writable=true}={}){return `<div class="search-feedback-votes" data-feedback-for="${esc(memory.memory_id)}" role="group" aria-label="${esc(t('searchFeedbackTitle'))}">
 ${feedbackKinds.slice(0,3).map(kind=>`<button type="button" class="quiet" data-feedback-vote="${kind}" data-feedback-memory="${esc(memory.memory_id)}" ${writable?'':'disabled'}>${label(`searchFeedback_${kind}`)}</button>`).join('')}<small data-feedback-status role="status"></small></div>`;}
export function searchFeedbackCard(data,{writable=false}={}){
 if(!data.feedback_context)return '';
 return `<section class="card search-feedback-card" data-search-feedback><header class="section-head"><h2>${label('searchFeedbackTitle')}</h2><button type="button" data-feedback-refresh>${label('refresh')}</button></header>
  <p class="muted">${label('searchFeedbackPrivacy')}</p><p class="muted">${label('searchFeedbackWindow')}</p>
  <form data-feedback-missing><label>${label('searchFeedbackExpected')}<input name="memory_id" maxlength="128" autocomplete="off" ${writable?'':'disabled'}></label><button ${writable?'':'disabled'}>${label('searchFeedback_missing')}</button><span data-feedback-missing-status role="status"></span></form>
  ${writable?'':`<p>${label('viewWithoutWrite')}</p>`}<div data-feedback-history-status role="status" aria-live="polite"></div><div data-feedback-history></div>
  <details><summary>${label('searchFeedbackEvaluation')}</summary><p>${label('searchFeedbackEvaluationNote')}</p><code>node server/bin/mnemuron-search-workbench-quality.mjs --output /private/evidence</code>
   <p class="muted">${label('searchFeedbackEvaluationSeparate')}</p></details></section>`;
}
export function feedbackHistory(view){
 return `<p>${label('searchFeedbackObservations')}: ${view.total}</p><p class="muted">${label('searchFeedbackNotAccuracy')}</p>
  <ul>${view.groups.map(row=>`<li>${esc(t(row.requested_mode))} → ${esc(t(row.effective_mode))}: ${esc(kindLabel(row.feedback))} ${row.count}</li>`).join('')}</ul>
  <ol class="search-feedback-history">${view.items.map(row=>`<li><span>${esc(kindLabel(row.feedback))}</span> ${row.memory_id?`<button type="button" class="quiet" data-memory="${esc(row.memory_id)}">${esc(row.memory_id)}</button> <small>v${row.revision}${row.revision_current===0?` · ${esc(t('searchFeedbackRevisionChanged'))}`:''}</small>`:`<small>${label('searchFeedbackUnspecified')}</small>`}
   <time>${esc(row.updated_at.slice(0,19).replace('T',' '))} UTC</time>${row.truncated?`<small>${label('searchFeedbackLimited')}</small>`:''}</li>`).join('')}</ol>
  <div class="pagination">${view.offset?`<button type="button" data-feedback-offset="${Math.max(0,view.offset-view.limit)}">${label('previous')}</button>`:''}${view.next_offset!==null?`<button type="button" data-feedback-offset="${view.next_offset}">${label('next')}</button>`:''}</div>`;
}

export function mountSearchFeedback({root,data,api,mutate,isActive,writable=false}){
 const card=root.querySelector('[data-search-feedback]'),context=data.feedback_context;if(!card||!context)return null;
 let disposed=false,readSequence=0,busy=false,history=null;const operations=new Map(),memories=new Map(data.results.map(row=>[row.memory_id,row]));
 const alive=()=>!disposed&&card.isConnected&&isActive();
 for(const button of root.querySelectorAll('.memory-table [data-memory]')){
  const memory=memories.get(button.dataset.memory);if(memory)button.closest('td')?.insertAdjacentHTML('beforeend',feedbackControls(memory,{writable}));
 }
 const notice=card.querySelector('[data-feedback-history-status]'),body=card.querySelector('[data-feedback-history]');
 async function read(offset=0){const mine=++readSequence;notice.textContent=t('loading');
  try{const view=await api('search-feedback',{query_fingerprint:context.query_fingerprint,filter_fingerprint:context.filter_fingerprint,offset,limit:20});if(mine!==readSequence||!alive())return;history=view;body.innerHTML=feedbackHistory(view);notice.textContent='';}
  catch{if(mine===readSequence&&alive())notice.textContent=t('searchFeedbackReadFailed');}
 }
 function disable(value){for(const button of root.querySelectorAll('[data-feedback-vote],[data-feedback-missing] button'))button.disabled=value||!writable;}
 async function save(payload,status){if(busy||!writable||!alive())return;busy=true;disable(true);status.textContent=t('loading');
  const key=JSON.stringify(payload),operation=operations.get(key)||crypto.randomUUID();operations.set(key,operation);
  try{const reply=await mutate('search.feedback',{search_token:context.token,...payload},operation);if(!alive())return;
   if(reply.status!=='saved')throw new Error('CONSOLE_REQUEST_FAILED');operations.delete(key);status.textContent=t('searchFeedbackSaved');void read();
  }catch(error){if(alive())status.textContent=t(error.message)===error.message?t('searchFeedbackSaveFailed'):t(error.message);}
  finally{busy=false;if(alive())disable(false);}
 }
 const click=event=>{const vote=event.target.closest('[data-feedback-vote]');if(vote){const memory=memories.get(vote.dataset.feedbackMemory);if(memory&&feedbackKinds.slice(0,3).includes(vote.dataset.feedbackVote))void save({memory_id:memory.memory_id,revision:memory.revision,feedback:vote.dataset.feedbackVote},vote.closest('[data-feedback-for]').querySelector('[data-feedback-status]'));return;}
  const page=event.target.closest('[data-feedback-offset]');if(page)void read(Number(page.dataset.feedbackOffset));
  if(event.target.closest('[data-feedback-refresh]'))void read();
 };
 const submit=async event=>{if(!event.target.matches('[data-feedback-missing]'))return;event.preventDefault();if(busy||!writable||!alive())return;
  const memory_id=event.target.elements.memory_id.value.trim(),status=card.querySelector('[data-feedback-missing-status]');
  if(!memory_id){void save({feedback:'missing'},status);return;}
  busy=true;disable(true);status.textContent=t('loading');
  try{const meta=await api('memory-meta',{memory_id});if(!alive())return;busy=false;await save({memory_id,revision:meta.revision,feedback:'missing'},status);}
  catch(error){if(alive())status.textContent=t(error.message)===error.message?t('searchFeedbackSaveFailed'):t(error.message);}
  finally{busy=false;if(alive())disable(false);}
 };
 const appearance=()=>{if(alive()&&history)body.innerHTML=feedbackHistory(history);};
 root.addEventListener('click',click);root.addEventListener('submit',submit);document.addEventListener('appearancechange',appearance);void read();
 return {dispose(){disposed=true;readSequence++;operations.clear();memories.clear();root.removeEventListener('click',click);root.removeEventListener('submit',submit);document.removeEventListener('appearancechange',appearance);body.replaceChildren();notice.replaceChildren();}};
}

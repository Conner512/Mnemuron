// An account-bound review workbench. Reads never call a model or promote captured content.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
import {text as catalogText} from "./catalog.mjs";
const l=key=>catalogText("reviewUI_"+key,document.documentElement.lang);
export function reviewButton(kind='',id=''){return `<button type="button" data-review-open="${esc(kind||'candidates')}" data-review-id="${esc(id)}">${esc(l(kind==='summary'?'quality':kind==='memory'?'review':'workbench'))}</button>`;}
const button=(key,attrs='')=>`<button type="button" ${attrs}>${esc(l(key))}</button>`;
const pre=text=>`<pre class="review-text">${esc(text)}</pre>`;
const highlighted=(text,ranges=[])=>{const points=[...text],ordered=ranges.filter(r=>Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.end)&&r.start>=0&&r.end>r.start&&r.end<=points.length).sort((a,b)=>a.start-b.start),merged=[];
  for(const range of ordered){const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});}
  let at=0,out='';for(const range of merged){out+=esc(points.slice(at,range.start).join(''))+'<mark>'+esc(points.slice(range.start,range.end).join(''))+'</mark>';at=range.end;}return `<pre class="review-text">${out+esc(points.slice(at).join(''))}</pre>`;};
const version=m=>`<p class="muted">${esc(l('revision'))} ${esc(m.revision)} · ${esc(l('sourceVersion'))} <code>${esc(m.source_version)}</code></p>`;
const pageButtons=(current,next,attr,size=4096)=>`<div class="actions">${current?button('previous',`${attr}="${Math.max(0,current-size)}"`):''}${next!=null?button('next',`${attr}="${next}"`):''}</div>`;

export function mountMemoryReview({api,mutate,getCaps,getAccount,reload,translate}){
  const dialog=document.createElement('dialog');dialog.className='review-dialog';dialog.setAttribute('aria-labelledby','review-title');document.body.append(dialog);
  let generation=0,account=null,view=null,params={},data=null,pending=null,busy=false,notice='',lastFocus=null,triggerSelector='';
  const can=action=>{const c=getCaps();return c.writable===true&&c.actions?.includes(action)&&c.allowed_actions?.includes(action);};
  const valid=(ticket=generation)=>ticket===generation&&!!account&&account===getAccount()&&dialog.open;
  const close=()=>{generation++;account=null;data=null;pending=null;busy=false;notice='';dialog.close();dialog.replaceChildren();(lastFocus?.isConnected?lastFocus:triggerSelector?document.querySelector(triggerSelector):null)?.focus();};
  const header=title=>`<header class="review-head"><h2 id="review-title">${esc(l(title))}</h2>${button('close','data-review-close')}</header><p data-review-notice role="status">${esc(notice?l(notice):'')}</p>`;
  const error=e=>{if(!valid())return;const slot=dialog.querySelector('[data-review-notice]');if(slot){slot.setAttribute('role','alert');slot.textContent=/STALE|CHANGED|EXPIRED|NOT_FOUND|PROJECT_DELETED/.test(e.message)?l('unavailable'):(translate?.(e.message)||e.message);}};
  async function load(nextView=view,nextParams=params){const ticket=++generation;view=nextView;params={...nextParams};data=null;pending=null;dialog.innerHTML=header(view==='summary-quality'?'quality':view==='memory-review'?'review':'workbench')+`<p>${esc(l('loading'))}</p>`;
    try{const result=await api(view,params);if(!valid(ticket))return;data=result;render();}catch(e){if(!valid(ticket))return;dialog.innerHTML=header('workbench')+button('refresh','data-review-refresh');error(e);}}
  function render(){if(!valid()||!data)return;
    let body='';
    if(view==='review-candidates'){
      body=`<p class="policy-box">${esc(l('disclaimer'))}</p><form data-review-extract><label>${esc(l('event'))}<select name="event_id" required>${data.events.map(e=>`<option value="${esc(e.event_id)}">${esc(e.event_type)} · ${esc(e.captured_at)} · ${esc(e.event_id)}</option>`).join('')}</select></label><button${!can('review.extract')||!data.events.length?' disabled':''}>${esc(l('preview'))}</button></form>`;
      body+=data.candidates.length?data.candidates.map(c=>`<form class="card review-candidate" data-review-candidate="${esc(c.candidate_id)}"><p><code>${esc(c.event_id)}</code> · ${esc(c.project_id||c.session_id||'—')}</p><p>${esc(l('role'))}: ${esc(c.role)} · ${esc(l('unverified'))}</p><p>${esc(l('rule'))}: <code>${esc(c.rule)}</code> · ${esc(l('span'))}: ${c.span_start}–${c.span_end}</p><details><summary>${esc(l('original'))}</summary>${pre(c.source_context)}</details><label>${esc(l('excerpt'))}<textarea name="content" rows="4" maxlength="4000" required>${esc(c.content)}</textarea></label><div class="review-columns"><label>${esc(l('type'))}<select name="memory_type">${['fact','goal','constraint','decision','completed','blocker','remaining','next_step'].map(type=>`<option value="${type}"${type===c.memory_type?' selected':''}>${esc(translate?.(type)||type)}</option>`).join('')}</select></label><label>${esc(l('topic'))}<input name="topic" maxlength="200" value="${esc(c.topic||'')}"></label></div><div class="actions"><button${!can('review.candidate')?' disabled':''}>${esc(l('accept'))}</button>${button('dismiss',`data-review-dismiss="${esc(c.candidate_id)}"${!can('review.candidate')?' disabled':''}`)}</div></form>`).join(''):`<p>${esc(l('empty'))}</p>`;
      if(data.unavailable)body+=`<p class="muted">${esc(l('unavailableCandidates'))} (${data.unavailable})</p>`;
      body+=pageButtons(data.offset,data.next_offset,'data-review-candidate-page',data.limit);
    }else if(view==='summary-quality'){
      const m=data.metrics;body=`<h3>${esc(l('metrics'))}</h3><dl><dt>${esc(l('characters'))}</dt><dd>${m.source_characters} / ${m.excerpt_characters}</dd><dt>${esc(l('ratio'))}</dt><dd>${m.character_reduction_ratio===null?'—':(m.character_reduction_ratio*100).toFixed(1)+'%'}</dd><dt>${esc(l('coverage'))}</dt><dd>${m.represented_sources} / ${m.selected_sources}</dd></dl><p class="policy-box">${esc(l('semantic'))}</p><p>${esc(l('feedback'))}: ${esc(data.feedback?l(data.feedback.decision):l('none'))}${data.feedback?' · '+esc(data.feedback.reviewed_at):''}</p>`;
      if(data.feedback_stale)body+=`<p role="status">${esc(l('staleFeedback'))}</p>`;
      if(can('review.summary'))body+=`<form data-review-feedback><label>${esc(l('feedback'))}<select name="decision">${['accurate','missing_context','misleading','needs_review'].map(v=>`<option value="${v}"${v===(data.feedback?.decision||'needs_review')?' selected':''}>${esc(l(v))}</option>`).join('')}</select></label><button>${esc(l('send'))}</button></form>`;
      body+=`<div class="review-columns"><section><h3>${esc(l('excerpt'))}</h3>${data.claims.map(c=>`<article><p><code>${esc(c.memory_id)}</code> · v${c.revision} · ${c.start}–${c.end}</p>${pre(c.quote)}${c.quote_truncated?`<p>${esc(l('partial'))}</p>`:''}${button('source',`data-review-source="${esc(c.memory_id)}" data-review-source-offset="${c.source_offset}"`)}</article>`).join('')}${pageButtons(data.offset,data.next_offset,'data-review-claim-page',8)}</section><section><h3>${esc(l('source'))}</h3><select data-review-source-select aria-label="${esc(l('source'))}">${data.sources.map(s=>`<option value="${esc(s.memory_id)}"${s.memory_id===data.source.memory_id?' selected':''}>${esc(s.memory_id)} · v${s.revision}${s.represented?'':' · '+esc(l('unrepresented'))}</option>`).join('')}</select>${data.sources_truncated?`<p>${esc(l('moreSources'))}</p>`:''}${version(data.source)}${highlighted(data.source.text,data.source.highlight_ranges)}<p>${data.source.offset+1}–${data.source.offset+[...data.source.text].length} / ${data.source.total}</p>${pageButtons(data.source.offset,data.source.next_offset,'data-review-source-page')}</section></div>`;
    }else{
      const side=(m,key,attr)=>`<section class="card"><h3>${esc(l(key))}</h3><code>${esc(m.memory_id)}</code>${version(m)}<p>${esc(l('project'))}: ${esc(m.project_name||m.project_id||'—')} / ${esc(m.scope)} ${esc([m.task_id,m.workstream_id,m.session_id].filter(Boolean).join(' / '))}</p>${pre(m.text)}${pageButtons(m.offset,m.next_offset,attr)}<details><summary>${esc(l('sourceMetadata'))}</summary>${pre(JSON.stringify(m.provenance,null,2))}</details></section>`;
      body=`<form data-review-compare><label>${esc(l('compare'))}<input name="counterpart_id" value="${esc(data.right?.memory_id||'')}" placeholder="${esc(l('memoryId'))}" required pattern="[A-Za-z0-9_.:-]+"></label><button>${esc(l('load'))}</button></form>`;
      if(data.hints.length)body+=`<p>${esc(l('hints'))}</p><div class="actions">${data.hints.map(h=>`<button type="button" data-review-counterpart="${esc(h.memory_id)}">${esc(h.memory_id)}</button>`).join('')}</div>`;
      if(data.conflicts.length)body+=`<p>${esc(l('conflicts'))}</p><div class="actions">${[...new Set(data.conflicts.flatMap(c=>c.memory_ids))].filter(id=>id!==data.left.memory_id).map(id=>`<button type="button" data-review-counterpart="${esc(id)}">${esc(id)}</button>`).join('')}</div>`;
      body+=`<div class="review-columns">${side(data.left,'left','data-review-left-page')}${data.right?side(data.right,'right','data-review-right-page'):''}</div>`;
      if(data.left.review)body+=`<p>${esc(data.left.review.current?`${l(data.left.review.decision)} · ${data.left.review.last_verified_at||data.left.review.reviewed_at}`:l('staleReview'))}${data.left.review.review_due_at?' · '+esc(l('due'))+': '+esc(data.left.review.review_due_at):''}</p>`;
      if(can('review.verify'))body+=`<form data-review-verify><label>${esc(l('due'))}<input type="date" name="review_due_at"></label><button>${esc(l('verify'))}</button></form>`;
      if(data.right&&can('review.resolve'))body+=`<p class="policy-box">${esc(l('replacementNote'))}</p><div class="actions">${['keep_both','replace','retract_duplicate','undecided'].map(d=>button(d,`data-review-resolve="${d}"${!data.same_scope&&['replace','retract_duplicate'].includes(d)?' disabled':''}`)).join('')}</div>`;
    }
    dialog.innerHTML=header(view==='summary-quality'?'quality':view==='memory-review'?'review':'workbench')+body;
  }
  function confirm(action,payload,label){pending={action,payload,operation_id:crypto.randomUUID()};dialog.innerHTML=header('workbench')+`<h3>${esc(label)}</h3><p class="policy-box">${esc(l('confirmNote'))}</p>${pre(payload.content||JSON.stringify(payload,null,2))}<form data-review-confirm><label>${esc(l('password'))}<input name="current_password" type="password" autocomplete="current-password" required></label><label>${esc(l('otp'))}<input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required></label><label class="checkbox"><input type="checkbox" required>${esc(l('confirm'))}</label><div class="actions"><button>${esc(l('submit'))}</button>${button('cancel','data-review-cancel')}</div></form>`;}
  async function write(action,payload,operation_id=crypto.randomUUID()){if(busy||!can(action))return;busy=true;const ticket=generation,buttons=[...dialog.querySelectorAll('button')].map(b=>[b,b.disabled]);for(const [b] of buttons)b.disabled=true;
    try{await mutate(action,payload,operation_id);if(!valid(ticket))return;notice='saved';pending=null;const next=view==='memory-review'&&['replace','retract_duplicate'].includes(payload.decision)?{memory_id:payload.counterpart_id}:params;await load(view,next);void reload?.();}
    catch(e){if(valid(ticket))error(e);}finally{busy=false;if(valid())for(const [b,disabled] of buttons)if(b.isConnected)b.disabled=disabled;}}
  const documentClick=e=>{const b=e.target.closest('[data-review-open]');if(!b)return;e.preventDefault();account=getAccount();if(!account)return;lastFocus=b;triggerSelector=`[data-review-open="${CSS.escape(b.dataset.reviewOpen)}"][data-review-id="${CSS.escape(b.dataset.reviewId||'')}"]`;notice='';if(!dialog.open)dialog.showModal();
    const kind=b.dataset.reviewOpen;void load(kind==='summary'?'summary-quality':kind==='memory'?'memory-review':'review-candidates',kind==='summary'?{summary_id:b.dataset.reviewId}:kind==='memory'?{memory_id:b.dataset.reviewId}:{});};
  document.addEventListener('click',documentClick);
  dialog.addEventListener('cancel',e=>{e.preventDefault();if(!busy)close();});
  dialog.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||busy)return;
    if(b.hasAttribute('data-review-close'))return close();
    if(b.hasAttribute('data-review-refresh'))return void load();
    if(b.hasAttribute('data-review-cancel')){pending=null;render();return;}
    if(b.dataset.reviewDismiss){const c=data.candidates.find(c=>c.candidate_id===b.dataset.reviewDismiss);return confirm('review.candidate',{candidate_id:c.candidate_id,revision:c.revision,decision:'dismiss'},l('dismiss'));}
    if(b.dataset.reviewResolve){const a=data.left,c=data.right,decision=b.dataset.reviewResolve;return confirm('review.resolve',{memory_id:a.memory_id,revision:a.revision,source_version:a.source_version,counterpart_id:c.memory_id,counterpart_revision:c.revision,counterpart_source_version:c.source_version,decision,...(['replace','retract_duplicate'].includes(decision)?{confirmed:true}:{})},l(decision));}
    if(b.dataset.reviewSource)return void load(view,{...params,source_memory_id:b.dataset.reviewSource,source_offset:Number(b.dataset.reviewSourceOffset||0)});
    if(b.dataset.reviewCounterpart)return void load(view,{memory_id:data.left.memory_id,counterpart_id:b.dataset.reviewCounterpart});
    for(const [key,param] of [['reviewCandidatePage','offset'],['reviewClaimPage','offset'],['reviewSourcePage','source_offset'],['reviewLeftPage','content_offset'],['reviewRightPage','counterpart_offset']])if(b.dataset[key]!==undefined)return void load(view,{...params,[param]:Number(b.dataset[key])});
  });
  dialog.addEventListener('change',e=>{if(e.target.matches('[data-review-source-select]'))void load(view,{...params,source_memory_id:e.target.value,source_offset:0});});
  dialog.addEventListener('submit',e=>{e.preventDefault();if(busy||!valid())return;const form=e.target,v=Object.fromEntries(new FormData(form));
    if(form.hasAttribute('data-review-extract')){const event=data.events.find(x=>x.event_id===v.event_id);if(event)void write('review.extract',{event_id:event.event_id,source_hash:event.source_hash});}
    if(form.hasAttribute('data-review-candidate')){const c=data.candidates.find(x=>x.candidate_id===form.dataset.reviewCandidate);confirm('review.candidate',{candidate_id:c.candidate_id,revision:c.revision,decision:'accept',content:v.content,memory_type:v.memory_type,topic:v.topic||null,confirmed:true},l('accept'));}
    if(form.hasAttribute('data-review-confirm')&&pending)void write(pending.action,{...pending.payload,current_password:v.current_password,otp:v.otp},pending.operation_id);
    if(form.hasAttribute('data-review-feedback'))void write('review.summary',{summary_id:data.summary_id,revision:data.revision,source_digest:data.source_digest,decision:v.decision});
    if(form.hasAttribute('data-review-compare'))void load(view,{memory_id:data.left.memory_id,counterpart_id:v.counterpart_id});
    if(form.hasAttribute('data-review-verify'))void write('review.verify',{memory_id:data.left.memory_id,revision:data.left.revision,source_version:data.left.source_version,review_due_at:v.review_due_at?new Date(v.review_due_at+'T23:59:59').toISOString():null});
  });
  function appearance(){if(!valid()||pending||busy)return;
    // Appearance changes translate labels without discarding any unsubmitted review decision or edited candidate.
    // Pending password/OTP forms are intentionally never rerendered or copied into a draft snapshot.
    const drafts=[...dialog.querySelectorAll('form')].map(form=>({selector:'form'+[...form.attributes].filter(a=>a.name.startsWith('data-review-')).map(a=>`[${a.name}="${CSS.escape(a.value)}"]`).join(''),
      fields:[...form.elements].filter(el=>el.name).map(el=>({name:el.name,value:el.value,checked:el.checked,active:document.activeElement===el,start:el.selectionStart,end:el.selectionEnd}))}));
    const details=[...dialog.querySelectorAll('details')].map(el=>el.open);render();
    for(const draft of drafts){const form=dialog.querySelector(draft.selector);if(!form)continue;
      for(const field of draft.fields){const el=form.elements.namedItem(field.name);if(!el)continue;el.value=field.value;if(typeof field.checked==='boolean')el.checked=field.checked;
        if(field.active){el.focus();if(field.start!==null&&field.start!==undefined&&typeof el.setSelectionRange==='function')el.setSelectionRange(field.start,field.end);}}}
    [...dialog.querySelectorAll('details')].forEach((el,i)=>{if(details[i]!==undefined)el.open=details[i];});
  }
  return {clear:close,appearance};
}

// Owner-scoped entity presentation and review. Associations never edit a memory's content.
// No module-global account data: each controller invalidates late reads on navigation or sign-out.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const l=(t,key,tag='span')=>`<${tag} data-i18n="${esc(key)}">${esc(t(key))}</${tag}>`;
const date=value=>value?new Date(typeof value==='number'&&value<1e12?value*1000:value).toLocaleString(globalThis.document?.documentElement?.lang||'zh-CN'):'—';
const allowed=(caps,action)=>caps.allowed_actions?.includes(action)===true;
export const entityCurrent=e=>e?.confirmable===true&&e?.state==='current';
export const anchorCurrent=a=>a?.current===true&&Number.isSafeInteger(a.revision)&&a.revision===a.current_revision&&a.status==='active';
const button=(t,key,attrs,disabled=false)=>`<button type="button" ${attrs}${disabled?' disabled':''}>${l(t,key)}</button>`;
const pair=(t,key,value)=>`<div><dt>${l(t,key)}</dt><dd>${value}</dd></div>`;
export function entitySourceView(t,a={}){
 const current=anchorCurrent(a),context=a.context||a;
 const facts=[pair(t,'entityScope',l(t,context.kind==='user'?'entityUserScope':['project','task','workstream','session'].includes(context.kind)?`entityScope_${context.kind}`:'entityScopeUnknown')),
  pair(t,'project',context.project_name?esc(context.project_name):l(t,context.project_id?'entityNameUnknown':'entityNoProject')),
  ...(context.task_id||context.task_title?[pair(t,'taskTitle',esc(context.task_title||t('entityNameUnknown')))]:[]),
  ...(context.workstream_id||context.workstream_name?[pair(t,'workstream',esc(context.workstream_name||t('entityNameUnknown')))]:[]),
  ...(context.session_id?[pair(t,'entitySession',esc(context.session_id))]:[]),pair(t,'created',`<time>${esc(date(a.created_at))}</time>`),pair(t,'originFacet',esc(a.source_kind||t('entityNameUnknown'))),
  pair(t,'revisions',`${esc(a.revision??'—')} / ${esc(a.current_revision??'—')}`)].join('');
 return `<section class="entity-source" data-entity-source="${esc(a.memory_id)}"><h4>${l(t,'entitySource')}</h4><p class="entity-source-state">${l(t,current?'entityCurrentSource':a.status&&a.status!=='active'?'entityInactiveSource':'entityStaleSource')}</p>
 ${current?`<p class="entity-source-text">${esc(a.title||a.content||t('entityNameUnknown'))}</p>${a.title&&a.content?`<p class="entity-source-text">${esc(a.content)}</p>`:''}`:''}<dl class="entity-facts">${facts}</dl>
 <details class="entity-identifiers"><summary>${l(t,'entityIdentifiers')}</summary><dl class="entity-facts">${[['memoryId',a.memory_id],['project',context.project_id],['taskTitle',context.task_id],['workstream',context.workstream_id]].filter(([,v])=>v).map(([k,v])=>pair(t,k,`<code>${esc(v)}</code>`)).join('')}</dl></details>
 ${current?button(t,'entityOpenSource',`data-memory="${esc(a.memory_id)}" data-revision="${esc(a.revision)}"`):''}</section>`;
}
const nameOf=e=>e?.label||e?.name||'';
export function entitySummaryView(t,e={},{open=true}={}){
 return `<article class="entity-summary" data-entity="${esc(e.entity_id)}"><header><h3 class="entity-name">${esc(nameOf(e))}</h3><span class="tag">${l(t,`entityKind_${e.kind||'object'}`)}</span></header>
 ${!entityCurrent(e)?l(t,'entityUnavailable','p'):''}${entitySourceView(t,e.anchor)}${open?button(t,'entityManage',`data-entity-open="${esc(e.entity_id)}"`):''}</article>`;
}
export function proposalView(t,p={},caps={}){
 const canResolve=allowed(caps,'entity.resolve'),confirmable=p.confirmable===true&&p.state==='pending',relation=p.relation!=='same_entity';
 return `<article class="entity-proposal" data-entity-proposal="${esc(p.proposal_id)}"><header><h3>${l(t,relation?'entityRelatedProposal':p.target?'entityLinkProposal':'entityAliasProposal')}</h3><span class="tag">${l(t,`entityState_${p.state||'pending'}`)}</span></header>
 ${p.source?entitySummaryView(t,p.source,{open:false}):''}${p.target?`<p class="entity-target-label">${l(t,'entityTarget')}</p>${entitySummaryView(t,p.target,{open:false})}`:`<p class="entity-name">${esc(p.name?.name||p.name||'')}</p>`}
 ${l(t,relation?'entityRelationNote':'entityConfirmNote','p')}${p.state==='pending'&&!confirmable?l(t,'entityProposalStale','p'):''}
 ${canResolve?`<div class="actions">${button(t,'entityAccept',`data-entity-resolve="accept" data-proposal="${esc(p.proposal_id)}"`,!confirmable)}${button(t,'entityReject',`data-entity-resolve="reject" data-proposal="${esc(p.proposal_id)}"`,!confirmable)}</div>`:''}</article>`;
}
export function entitiesPendingView(t,data,caps={}){
 return `<section class="card entity-pending" data-feature="MEM-08" data-status="live"><header class="section-head"><h2>${l(t,'entityPending')}</h2><span class="feature-id">MEM-08</span></header>${l(t,'entityDerivedNote','p')}
 ${!data?`<p role="status">${l(t,'unavailable')}</p>`:`${l(t,'entityPendingNote','p')}<p>${l(t,'entityPendingCount')}: ${esc(data.proposal_total??data.pending_count??data.proposals?.length??0)}</p>${data.proposals?.length?`<div class="entity-pending-list">${data.proposals.map(p=>`<article><h3 class="entity-name">${esc(nameOf(p.source))}${p.target?` → ${esc(nameOf(p.target))}`:` → ${esc(p.name?.name||p.name||'')}`}</h3><p>${l(t,p.relation==='related'?'entityRelatedProposal':'entityAliasProposal')} · <time>${esc(date(p.created_at))}</time></p>${p.source?entitySourceView(t,p.source.anchor):''}${p.target?entitySourceView(t,p.target.anchor):''}${button(t,'entityReview',`data-entity-review="${esc(p.proposal_id)}"`)}</article>`).join('')}</div>`:l(t,'entityNoPending','p')}${data.truncated?l(t,'entityTruncated','p'):''}`}
 <div class="actions">${button(t,'entityBrowse','data-entity-browse')}${button(t,'refresh','data-entity-pending-refresh')}${data?.offset?button(t,'previous',`data-entity-pending-page="${Math.max(0,data.offset-(data.limit||10))}"`):''}${data?.next_offset!=null?button(t,'next',`data-entity-pending-page="${data.next_offset}"`):''}</div></section>`;
}
export function entityMemoryView(t,data,caps={},memory={}){
 return `<header class="section-head"><h3>${l(t,'entityAssociations')}</h3></header>${l(t,'entityDerivedNote','p')}${data.entities?.length?data.entities.map(e=>entitySummaryView(t,e)).join(''):l(t,'entityNoAssociations','p')}
 ${data.proposals?.length?`<h3>${l(t,'entityPending')}</h3>${data.proposals.map(p=>proposalView(t,p,caps)).join('')}`:''}
 ${data.truncated?l(t,'entityTruncated','p'):''}${memory.status==='active'&&memory.current===true?`<div class="actions">${allowed(caps,'entity.create')?button(t,'entityCreate','data-entity-create'):''}${allowed(caps,'entity.link')?button(t,'entityLinkExisting','data-entity-link-existing'):''}</div>`:''}`;
}
export function mountEntities({api,mutate,getCaps,isActive,t,syncAppearance,reloadPending}){
 const dialog=document.createElement('dialog');dialog.id='entity-dialog';dialog.className='entity-dialog';dialog.setAttribute('aria-labelledby','entity-dialog-title');
 dialog.innerHTML=`<div class="dialog-header"><h2 id="entity-dialog-title">${l(t,'entityAssociations')}</h2>${button(t,'close','data-entity-close')}</div><div class="entity-dialog-content"></div>`;document.body.append(dialog);
 const body=dialog.querySelector('.entity-dialog-content');let sequence=0,memorySequence=0,focus=null,working=false,intent=null,entity=null,proposals=[],memoryProposals=[],pending=null,memory=null,memoryRegion=null,memoryGuard=null,back=null,pendingOffset=0;
 const active=seq=>seq===sequence&&isActive()&&dialog.open;
 const paint=(html,{focusFirst=true}={})=>{body.innerHTML=html;syncAppearance();dialog.scrollTop=0;if(focusFirst){const explicit=body.querySelector('[data-entity-focus]');(explicit||body.querySelector('input:not([type="hidden"])')||body.querySelector('button')||dialog.querySelector('[data-entity-close]'))?.focus({preventScroll:!!explicit});}};
 const error=e=>l(t,['ENTITY_SCOPE_MISMATCH','ENTITY_TOMBSTONED'].includes(e.message)?e.message:['ENTITY_STALE','ENTITY_VERSION_CHANGED','MEMORY_VERSION_CHANGED','SOURCE_MANIFEST_CHANGED','VERSION_CHANGED'].includes(e.message)?'entityChanged':'entityFailed','p');
 function clearDialog(){sequence++;working=false;intent=null;entity=null;back=null;proposals=[];body.replaceChildren();if(dialog.open)dialog.close();}
 function close(){const target=focus;clearDialog();focus=null;
  let restore=target?.isConnected?target:null;
  if(!restore&&target?.dataset){for(const attribute of ['data-entity-open','data-entity-review','data-entity-create','data-entity-link-existing','data-entity-browse'])if(target.hasAttribute(attribute)){restore=document.querySelector(`[${attribute}="${CSS.escape(target.getAttribute(attribute))}"]`);if(restore)break;}}
  (restore||document.querySelector('#memory-content [data-entity-create]')||document.querySelector('[data-feature="MEM-08"] [data-entity-browse]'))?.focus();
 }
 function open(){sequence++;intent=null;working=false;entity=null;back=null;proposals=[];if(!dialog.open){focus=document.activeElement;dialog.showModal();}paint(l(t,'loading','p'));return sequence;}
 function clearMemory(){memorySequence++;memoryProposals=[];memory=null;memoryRegion=null;memoryGuard=null;clearDialog();}
 async function refreshMemory(){if(!memoryRegion?.isConnected||!memoryGuard?.())return;await loadMemory(memoryRegion,memory,memoryGuard);}
 async function loadMemory(region,record,guard){const seq=++memorySequence;memory=record;memoryRegion=region;memoryGuard=guard;
  region.innerHTML=l(t,'loading','p');const valid=()=>seq===memorySequence&&isActive()&&region.isConnected&&guard();
  try{const data=await api('entities',{memory_id:record.memory_id});if(!valid())return;memoryProposals=data.proposals||[];region.innerHTML=entityMemoryView(t,data,getCaps(),record);syncAppearance();}
  catch(e){if(valid()&&e.name!=='AbortError')region.innerHTML=`<p role="status">${l(t,'entityFailed')}</p>${button(t,'retry','data-entity-memory-retry')}`;}
 }
 const memoryTarget=()=>entitySourceView(t,{...memory,context:{...memory,kind:memory?.scope}});
 const toolbar=()=>`<div class="actions">${button(t,'previous','data-entity-back')}${button(t,'close','data-entity-close')}</div>`;
 function confirm(action,payload,heading,context,returnTo){intent={action,payload,operation:crypto.randomUUID(),returnTo};back=returnTo;
  paint(`<form data-entity-confirm><h3 data-entity-focus tabindex="-1">${l(t,heading)}</h3><div class="entity-confirm-target">${context}</div>${l(t,'entityDerivedNote','p')}${action==='entity.resolve'&&payload.decision==='accept'?l(t,'entityRetiredAliasesNote','p'):''}<p data-entity-error role="alert"></p><div class="actions"><button type="submit" class="primary">${l(t,'confirm')}</button>${button(t,'cancel','data-entity-back')}</div></form>`);
 }
 function entityDetail(data){entity=data.entity||data.entities?.[0];proposals=data.proposals||[];if(!entity){paint(l(t,'entityUnavailable','p')+toolbar());return;}
  entity={...entity,names:data.aliases||[],members:data.memories||[]};const e=entity,current=entityCurrent(e),caps=getCaps(),names=e.names,members=e.members.filter(m=>m.origin!=='anchor');
  paint(`${entitySummaryView(t,e,{open:false})}${l(t,'entityAliases','h3')}<ul class="entity-names">${names.map(n=>`<li><span class="entity-name">${esc(n.name)}</span><small>${l(t,n.origin==='manual'?'entityManualName':'entityProvenName')} · ${l(t,`entityState_${n.state}`)}</small>${n.state==='retired'?l(t,'entityRetiredNameNote','p'):''}${current&&n.current&&n.state==='accepted'?`<div class="actions">${allowed(caps,'entity.alias_correct')?button(t,'entityCorrect',`data-entity-name-edit="${esc(n.name_id)}"`):''}${allowed(caps,'entity.alias_remove')?button(t,'entityRemoveAlias',`data-entity-name-remove="${esc(n.name_id)}"`):''}</div>`:''}</li>`).join('')}</ul>
  ${current&&allowed(caps,'entity.alias')?button(t,'entityAddAlias','data-entity-alias'):''}${members.length?`<h3>${l(t,'entityLinkedMemories')}</h3>${members.map(m=>`<section class="entity-member"><p class="tag">${l(t,`entityState_${m.state}`)}</p>${entitySourceView(t,m)}${current&&m.origin!=='anchor'&&m.state==='accepted'&&allowed(caps,'entity.unlink')?button(t,'entityUnlink',`data-entity-unlink="${esc(m.memory_id)}"`):''}</section>`).join('')}`:''}
  ${proposals.map(p=>proposalView(t,p,caps)+(current&&p.target&&p.state==='accepted'&&allowed(caps,'entity.unlink')?button(t,'entityUnlink',`data-entity-edge-unlink="${esc(p.source.entity_id===e.entity_id?p.target.entity_id:p.source.entity_id)}"`):'')).join('')}${data.truncated?l(t,'entityTruncated','p'):''}${l(t,'entityRetiredAliasesNote','p')}${toolbar()}`);
 }
 async function detail(id){const seq=open();back=()=>browse();try{const data=await api('entities',{entity_id:id});if(active(seq))entityDetail(data);}catch(e){if(active(seq))paint(error(e)+toolbar());}}
 async function review(id){const cached=[...proposals,...memoryProposals,...pending?.proposals||[]].find(p=>p.proposal_id===id),sourceId=cached?.source?.entity_id;const seq=open();back=()=>browse({status:'pending'});try{if(!sourceId)throw new Error('ENTITY_STALE');const data=await api('entities',{entity_id:sourceId});if(!active(seq))return;const p=data.proposals?.find(x=>x.proposal_id===id);proposals=p?[p]:[];paint(p?proposalView(t,p,getCaps())+toolbar():l(t,'entityUnavailable','p')+toolbar());}catch(e){if(active(seq))paint(error(e)+toolbar());}}
 async function browse({query='',status='objects',offset=0,link=false}={}){const seq=open();back=()=>close();
  try{const data=await api('entities',{query,...(status==='objects'?{}:{status}),offset,limit:10});if(!active(seq))return;proposals=data.proposals||[];
   const options=['objects','pending','accepted','rejected'].map(value=>`<option value="${value}"${status===value?' selected':''} data-i18n="entityState_${value}">${esc(t(`entityState_${value}`))}</option>`).join('');
   paint(`<form data-entity-search data-link="${link}"><label>${l(t,'entitySearch')}<input name="query" maxlength="80" value="${esc(query)}"></label><label>${l(t,'status')}<select name="status">${options}</select></label><button type="submit">${l(t,'search')}</button></form>${l(t,link?'entityLinkScopeNote':'entityEqualNamesNote','p')}${data.truncated?l(t,'entityTruncated','p'):''}
   ${status==='objects'?(data.entities||[]).map(e=>`${entitySummaryView(t,e,{open:!link})}${link?button(t,'entityChooseLink',`data-entity-choose="${esc(e.entity_id)}"`,!entityCurrent(e)):''}`).join('')||l(t,'entityNoAssociations','p'):proposals.map(p=>proposalView(t,p,getCaps())).join('')||l(t,'entityNoProposals','p')}
   <div class="pagination">${offset?button(t,'previous',`data-entity-page="${Math.max(0,offset-10)}"`):''}${data.next_offset!=null?button(t,'next',`data-entity-page="${data.next_offset}"`):''}</div>${toolbar()}`);intent={browse:{query,status,offset,link}};
  }catch(e){if(active(seq))paint(error(e)+toolbar());}
 }
 function nameForm(mode,nameId){const e=entity,n=e?.names?.find(x=>x.name_id===nameId),originMemory=memory;
  const key=mode==='create'?'entityCreate':mode==='alias'?'entityAddAlias':'entityCorrect';back=()=>e?detail(e.entity_id):close();
  paint(`<form data-entity-name-form data-mode="${mode}" data-name-id="${esc(nameId||'')}"><h3>${l(t,key)}</h3>${e?entitySummaryView(t,e,{open:false}):memoryTarget()}<label>${l(t,'entityName')}<input name="name" maxlength="160" required value="${esc(n?.name||'')}" autocomplete="off"></label>${mode==='create'?`<label>${l(t,'entityKind')}<select name="kind">${['object','person','place','project','server','vendor'].map(k=>`<option value="${k}" data-i18n="entityKind_${k}">${esc(t(`entityKind_${k}`))}</option>`).join('')}</select></label>`:''}${l(t,'entityManualScopeNote','p')}<div class="actions"><button type="submit">${l(t,'continue')}</button>${button(t,'cancel','data-entity-back')}</div></form>`);
 }
 async function chooseLink(id){const seq=++sequence;paint(l(t,'loading','p'));try{const data=await api('entities',{entity_id:id});if(!active(seq)||!memory)return;const e=data.entity||data.entities?.[0];if(!entityCurrent(e))return paint(l(t,'entityUnavailable','p')+toolbar());
   confirm('entity.link',{entity_id:id,memory_id:memory.memory_id,revision:memory.revision,expected_version:e.expected_version},'entityConfirmLink',entitySummaryView(t,e,{open:false})+memoryTarget(),()=>browse({link:true}));
  }catch(e){if(active(seq))paint(error(e)+toolbar());}}
 document.addEventListener('click',event=>{const b=event.target.closest('button');if(!b||!isActive())return;
  if(b.hasAttribute('data-entity-open'))void detail(b.dataset.entityOpen);
  else if(b.hasAttribute('data-entity-review'))void review(b.dataset.entityReview);
  else if(b.hasAttribute('data-entity-browse'))void browse();
  else if(b.hasAttribute('data-entity-pending-refresh'))void reloadPending(pendingOffset);
  else if(b.hasAttribute('data-entity-pending-page')){pendingOffset=Number(b.dataset.entityPendingPage);void reloadPending(pendingOffset);}
  else if(b.hasAttribute('data-entity-memory-retry'))void refreshMemory();
  else if(b.hasAttribute('data-entity-create')){open();nameForm('create');}
  else if(b.hasAttribute('data-entity-link-existing'))void browse({link:true});
  else if(b.hasAttribute('data-entity-choose'))void chooseLink(b.dataset.entityChoose);
  else if(b.hasAttribute('data-entity-close'))close();
  else if(b.hasAttribute('data-entity-back')){sequence++;working=false;intent=null;(back||close)();}
  else if(b.hasAttribute('data-entity-page')&&intent?.browse)void browse({...intent.browse,offset:Number(b.dataset.entityPage)});
  else if(b.hasAttribute('data-entity-alias'))nameForm('alias');
  else if(b.hasAttribute('data-entity-name-edit'))nameForm('correct',b.dataset.entityNameEdit);
  else if(b.hasAttribute('data-entity-name-remove')&&entity){const e=entity,n=e.names?.find(x=>x.name_id===b.dataset.entityNameRemove);if(!n)return;
   confirm('entity.alias_remove',{entity_id:e.entity_id,name_id:n.name_id,expected_version:e.expected_version},'entityConfirmRemove',`<p class="entity-name">${esc(n.name)}</p>${entitySummaryView(t,e,{open:false})}`,()=>detail(e.entity_id));}
  else if(b.hasAttribute('data-entity-edge-unlink')&&entity){const e=entity,targetId=b.dataset.entityEdgeUnlink,p=proposals.find(p=>p.source?.entity_id===targetId||p.target?.entity_id===targetId),target=p?.source?.entity_id===targetId?p.source:p?.target;if(!target)return;
   confirm('entity.unlink',{entity_id:e.entity_id,target_entity_id:targetId,expected_version:e.expected_version},'entityConfirmUnlink',entitySummaryView(t,e,{open:false})+entitySummaryView(t,target,{open:false}),()=>detail(e.entity_id));}
  else if(b.hasAttribute('data-entity-unlink')&&entity){const e=entity,m=e.members?.find(x=>x.memory_id===b.dataset.entityUnlink)||e.anchor;
   confirm('entity.unlink',{entity_id:e.entity_id,memory_id:b.dataset.entityUnlink,expected_version:e.expected_version},'entityConfirmUnlink',`<h3 class="entity-name">${esc(nameOf(e))}</h3>${entitySourceView(t,m)}`,()=>detail(e.entity_id));}
  else if(b.hasAttribute('data-entity-resolve')){const p=[...proposals,...memoryProposals].find(x=>x.proposal_id===b.dataset.proposal);if(!p)return;const returnTo=()=>{proposals=[p];void review(p.proposal_id);};if(!dialog.open)open();
   confirm('entity.resolve',{proposal_id:p.proposal_id,decision:b.dataset.entityResolve,expected_version:p.expected_version},b.dataset.entityResolve==='accept'?'entityConfirmAccept':'entityConfirmReject',proposalView(t,p,{}),returnTo);}
  else if(b.hasAttribute('data-memory')&&dialog.contains(b))close();
 });
 dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
 // Native close events are queued. A prior opening must not invalidate a newer same-task reopen;
 // clearDialog() has already invalidated and cleared the old opening synchronously.
 dialog.addEventListener('close',()=>{if(dialog.open)return;sequence++;intent=null;working=false;body.replaceChildren();});
 body.addEventListener('input',event=>{if(event.target.matches('[data-entity-name-form] [name=name]'))event.target.setCustomValidity([...event.target.value.trim()].length>80?t('entityNameTooLong'):'');});
 body.addEventListener('submit',async event=>{event.preventDefault();if(!isActive())return;const f=event.target,fd=new FormData(f);
  if(f.hasAttribute('data-entity-search'))return void browse({query:String(fd.get('query')||''),status:String(fd.get('status')),link:f.dataset.link==='true'});
  if(f.hasAttribute('data-entity-name-form')){const mode=f.dataset.mode,name=String(fd.get('name')||'').trim(),e=entity;if(!name||[...name].length>80)return;
   const action=mode==='create'?'entity.create':mode==='alias'?'entity.alias':'entity.alias_correct';
   const payload=mode==='create'?{memory_id:memory.memory_id,revision:memory.revision,name,kind:fd.get('kind')}:{entity_id:e.entity_id,name,expected_version:e.expected_version,...(mode==='correct'?{name_id:f.dataset.nameId}:{})};
   return confirm(action,payload,mode==='create'?'entityConfirmCreate':mode==='alias'?'entityConfirmAlias':'entityConfirmCorrect',`<h3 class="entity-name">${esc(name)}</h3>${e?entitySummaryView(t,e,{open:false}):memoryTarget()}`,()=>nameForm(mode,f.dataset.nameId));
  }
  if(!f.hasAttribute('data-entity-confirm')||!intent?.action||working)return;const seq=sequence,op=intent;working=true;f.querySelector('[type=submit]').disabled=true;
  try{await mutate(op.action,op.payload,op.operation);if(!active(seq))return;intent=null;working=false;
   paint(`<p role="status" tabindex="-1" data-entity-focus>${l(t,'entitySaved')}</p><div class="actions">${button(t,'close','data-entity-close')}${button(t,'entityBrowse','data-entity-browse')}</div>`);void refreshMemory();void reloadPending(pendingOffset);
  }catch(e){if(active(seq)){f.querySelector('[data-entity-error]').innerHTML=error(e);f.querySelector('[data-entity-error]').setAttribute('tabindex','-1');f.querySelector('[data-entity-error]').focus();}}
  finally{if(active(seq)){working=false;const submit=f.querySelector('[type=submit]');if(submit)submit.disabled=false;}}
 });
 return {loadMemory,clearMemory,clear(){clearMemory();pending=null;pendingOffset=0;},setPending(data){pending=data;pendingOffset=data?.offset||0;}};
}

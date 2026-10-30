// Account-bound Console creation, reconciliation and handoff workflows. A write returns only a receipt;
// reviewable content is fetched separately and checked again immediately before confirmation.
import {text} from './catalog.mjs';
const t=key=>text(key,globalThis.document?.documentElement?.lang||'zh-CN');

const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label=(key,translate=t)=>`<span data-i18n="${key}">${esc(translate(key))}</span>`;
const button=(action,key,values={},translate=t)=>`<button type="button" data-task-workflow="${action}" ${Object.entries(values).map(([k,v])=>`data-${k}="${esc(v)}"`).join(' ')}>${label(key,translate)}</button>`;
const permitted=(caps,action)=>Array.isArray(caps?.allowed_actions)&&caps.allowed_actions.includes(action);
const date=value=>value?new Date(value).toLocaleString(document.documentElement.lang):'—';
const stateKeys={pending_confirmation:'taskFlowPending',awaiting_confirmation:'taskFlowPending',expired:'taskFlowExpired',cancelled:'taskFlowCancelled',queued:'taskFlowQueued',delivered:'taskFlowDelivered',completed:'taskFlowCompleted',failed:'taskFlowFailed',blocked:'taskFlowBlocked',acknowledged_unpaired:'taskFlowUnpaired',confirmed:'taskFlowConfirmed',applied:'taskFlowApplied',rejected:'taskFlowRejected',no_changes:'taskFlowNoChanges',no_effect:'taskFlowNoChanges',existing:'taskFlowExisting',ambiguous:'taskFlowAmbiguous',existing_project_selection_required:'taskFlowExistingProject',existing_task_selection_required:'taskFlowExistingTask',pending_project_bootstrap_selection_required:'taskFlowPendingMatch',pending_bootstrap_selection_required:'taskFlowPendingMatch',identifier_collision:'taskFlowIdentifierCollision'};
const errorKeys={LIFECYCLE_AUTHORITY_STALE:'taskFlowErrorLifecycle',TASK_WORKFLOW_PREVIEW_TOO_LARGE:'taskFlowErrorTooLarge',RECONCILIATION_CONFLICT:'taskFlowErrorConflict',RESUME_ALREADY_DELIVERED:'taskFlowErrorDelivered',RESUME_CONTEXT_CHANGED:'taskFlowErrorContext',RESUME_NOT_FOUND:'taskFlowErrorMissing',RESUME_PREVIEW_EXPIRED:'taskFlowErrorExpired',RESUME_TARGET_MISMATCH:'taskFlowErrorTarget',RESUME_TARGET_REQUIRED:'taskFlowErrorTarget',RESUME_TARGET_UNAVAILABLE:'taskFlowErrorTarget',RESUME_TASK_UNRESOLVED:'taskFlowErrorTask',RESUME_VERSION_CHANGED:'taskFlowErrorVersion',RESUME_CONFIRMATION_REQUIRED:'taskFlowErrorConfirmation',PREVIEW_REQUIRED:'taskFlowErrorMissing',PREVIEW_CHANGED:'taskFlowErrorVersion',PREVIEW_EXPIRED:'taskFlowErrorExpired',HANDOFF_DISABLED:'taskFlowErrorDisabled'};
const problem=code=>t(errorKeys[code]||code);
const invalidatesPreview=code=>['LIFECYCLE_AUTHORITY_STALE','RECONCILIATION_CONFLICT','TASK_VERSION_CHANGED','PREVIEW_REQUIRED','PREVIEW_CHANGED','PREVIEW_EXPIRED','RESUME_CONTEXT_CHANGED','RESUME_NOT_FOUND','RESUME_PREVIEW_EXPIRED','RESUME_TARGET_MISMATCH','RESUME_TARGET_UNAVAILABLE','RESUME_VERSION_CHANGED','HANDOFF_DISABLED'].includes(code);
const stateLabel=(value,translate=t)=>label(stateKeys[value]||'taskFlowUnknownState',translate);
const FORM={
  project:{title:'newProject',preview:'projects.bootstrap_preview',confirm:'projects.bootstrap_confirm',kind:'project_bootstrap'},
  task:{title:'newTask',preview:'tasks.bootstrap_preview',confirm:'tasks.bootstrap_confirm',kind:'task_bootstrap'},
  reconcile:{title:'runReconciliation',preview:'tasks.reconciliation_preview',confirm:'tasks.reconciliation_resolve',kind:'reconciliation'},
  resume:{title:'previewResume',preview:'resume.preview',confirm:'resume.confirm',kind:'resume'},
};
const formForKind=kind=>Object.keys(FORM).find(key=>FORM[key].kind===kind);
const facts=pairs=>`<dl class="entity-facts">${pairs.map(([key,value])=>`<div><dt>${label(key)}</dt><dd>${esc(value??'—')}</dd></div>`).join('')}</dl>`;
const paragraph=value=>`<p class="entity-source-text">${esc(typeof value==='string'?value:JSON.stringify(value,null,2))}</p>`;
const notes=(key,items)=>items?.length?`<section><h3>${label(key)}</h3><ul class="entity-names">${items.map(item=>`<li>${paragraph(typeof item==='string'?item:item?.text??item)}</li>`).join('')}</ul></section>`:'';
const empty=key=>`<p class="muted">${label(key)}</p>`;

export function taskWorkflowCard(translate,id,data,caps){
  const can=action=>permitted(caps,action),launch=(flow,key)=>can(FORM[flow].preview)?button(flow,key,{},translate):'';
  if(id==='TSK-05')return `<p>${label('taskFlowCreationNote',translate)}</p><div class="actions">${launch('project','newProject')}${launch('task','newTask')}</div>${!can(FORM.project.preview)&&!can(FORM.task.preview)?`<p>${label('taskFlowReadOnly',translate)}</p>`:''}`;
  if(id==='TSK-06')return `<p>${label('taskFlowReconcileNote',translate)}</p>${launch('reconcile','taskFlowReviewProposal')||`<p>${label('taskFlowReadOnly',translate)}</p>`}`;
  if(id==='TSK-07')return `<p>${label('taskFlowTargetNote',translate)}</p>${launch('resume','previewResume')||`<p>${label('taskFlowReadOnly',translate)}</p>`}`;
  const slots={'TSK-08':'pending','TSK-09':'delivery','TSK-10':'history'},slot=slots[id];
  return slot?`<p>${label(slot==='pending'?'taskFlowPendingNote':slot==='delivery'?'taskFlowDeliveryNote':'taskFlowHistoryNote',translate)}</p><div data-task-workflow-slot="${slot}">${label('loading',translate)}</div>`:'';
}

/** A delivery ACK is separate evidence from an injection ACK; neither is manufactured from confirmation. */
export function deliveryLabels(item){
  const d=item.delivery||{};
  return {delivery:d.delivered===true?'taskFlowDelivered':item.status==='acknowledged_unpaired'?'taskFlowUnpaired':item.status==='failed'?'taskFlowFailed':'taskFlowNotDelivered',
    completion:d.completed===true?'taskFlowCompleted':'taskFlowNotCompleted'};
}
function historyRows(data,mode){
  const all=Array.isArray(data?.items)?data.items:[],rows=mode==='pending'?all.filter(row=>row.status==='pending_confirmation'):mode==='delivery'?all.filter(row=>!['pending_confirmation','expired','cancelled'].includes(row.status)):all;
  if(!rows.length)return empty(mode==='history'?'taskFlowNoHistory':'taskFlowNoRowsOnPage');
  return `<div class="table-scroll"><table><thead><tr><th>${label('taskTitle')}</th><th>${label('created')}</th><th>${label('state')}</th>${mode==='delivery'?`<th>${label('deliveryState')}</th><th>${label('completionAck')}</th>`:''}<th>${label('actions')}</th></tr></thead><tbody>${rows.map(row=>{const receipt=deliveryLabels(row);return `<tr><td>${esc(row.task_title||row.task_id)}${row.target?`<small>${esc(row.target.label||row.target.agent_id)} · ${esc(row.target.device_id)}</small>`:''}</td><td>${esc(date(row.created_at))}</td><td>${stateLabel(row.status)}</td>${mode==='delivery'?`<td>${label(receipt.delivery)}</td><td>${label(receipt.completion)}</td>`:''}<td>${button('status',mode==='pending'?'taskFlowReviewPreview':'inspectDetails',{id:row.resume_id})}</td></tr>`;}).join('')}</tbody></table></div>`;
}
function receiptRows(value){
  const data=[...(value.delivery?.injection?.attempts||[]).map(row=>({...row,id:row.attempt_id,method:row.injection_method,delivered_at:row.injected_at})),...(value.delivery?.receipt?.receipts||[]).map(row=>({...row,id:row.receipt_id,method:row.delivery_method}))];
  const total=(value.delivery?.injection?.total??value.delivery?.injection?.attempts?.length??0)+(value.delivery?.receipt?.total??value.delivery?.receipt?.receipts?.length??0),truncated=value.delivery?.injection?.truncated||value.delivery?.receipt?.truncated||data.length<total;
  if(!data.length&&!total)return '';
  return `<section data-task-receipts><h3>${label('taskFlowReceipts')}</h3><p class="muted">${label('taskFlowReceiptWindow')} ${label('taskFlowReceiptCounts')} ${esc(data.length)} / ${esc(total)}</p>${truncated?`<p class="policy-box">${label('taskFlowReceiptsTruncated')}</p>`:''}${data.length?`<div class="table-scroll"><table><thead><tr><th>${label('taskFlowReceiptAttempt')}</th><th>${label('state')}</th><th>${label('taskFlowDeliveryTime')}</th><th>${label('taskFlowCompletionTime')}</th><th>${label('taskFlowReceiptError')}</th></tr></thead><tbody>${data.map(row=>`<tr><td>${esc(row.id)}<small>${esc(row.method)}</small></td><td>${stateLabel(row.ack_complete?'completed':row.status==='in_flight'?'delivered':row.status)}</td><td>${esc(date(row.delivered_at))}</td><td>${esc(date(row.acknowledged_at))}</td><td>${esc(row.error?.code||row.error?.message||'—')}</td></tr>`).join('')}</tbody></table></div>`:''}</section>`;
}
const historyPager=(data,previous)=>`${data.truncated?empty('taskFlowHistoryTruncated'):''}<div class="pagination"><span>${label('taskFlowHistoryTotal')} ${esc(data.total??data.items?.length??0)}</span>${data.offset>0?button('history-page','previous',{offset:previous??Math.max(0,data.offset-data.limit)}):''}${data.next_offset!=null?button('history-page','next',{offset:data.next_offset}):''}${button('history-refresh','refresh')}</div>`;

export function mountTaskWorkflows({api,mutate,getCaps,getData=()=>({}),getAccount,isActive,reload=async()=>{},syncAppearance=()=>{}}){
  const dialog=document.createElement('dialog');dialog.id='task-workflow-dialog';dialog.className='entity-dialog';dialog.setAttribute('aria-labelledby','task-workflow-title');
  dialog.innerHTML=`<header class="dialog-header"><h2 id="task-workflow-title"></h2>${button('close','close')}</header><div class="entity-dialog-content" data-task-workflow-content></div>`;document.body.append(dialog);
  const content=dialog.querySelector('[data-task-workflow-content]'),title=dialog.querySelector('h2');
  let sequence=0,historySequence=0,historyOffset=0,history=null,historyAccount=null,flow=null,busy=false,trigger=null,expiryTimer=null;const historyPrevious=new Map();
  const account=()=>getAccount?.()??document.body.dataset.account;
  const valid=ticket=>ticket.sequence===sequence&&ticket.account===account()&&isActive()&&dialog.open;
  const ticket=()=>({sequence,account:account()});
  const can=action=>permitted(getCaps(),action);
  const stage=(html,focus='input,select,textarea,button')=>{content.innerHTML=html;syncAppearance();content.querySelector(focus)?.focus({preventScroll:true});dialog.scrollTop=0;};
  const error=(message,container=content)=>{const node=container.querySelector('[data-task-error]');if(node){node.textContent=problem(message);node.hidden=false;}};
  const errorBox=()=>'<p role="alert" data-task-error hidden></p>';
  const clearProof=()=>{for(const input of content.querySelectorAll('[name="current_password"],[name="otp"]'))input.value='';};
  const restoreFocus=()=>{const fallback=document.querySelector('[data-task-workflow="'+(flow?.type||'resume')+'"]');(trigger?.isConnected?trigger:fallback||document.getElementById('main'))?.focus();trigger=null;};
  function dispose(){sequence++;clearTimeout(expiryTimer);expiryTimer=null;clearProof();flow=null;busy=false;content.replaceChildren();}
  function open(type){dispose();trigger=document.activeElement;flow={type,values:{},choices:{},choiceEpoch:{},branchEpoch:0,readEpoch:0,operation:null,ref:null,preview:null,receipt:null};title.dataset.i18n=FORM[type]?.title||'taskFlowResumeDetails';title.textContent=t(title.dataset.i18n);if(!dialog.open)dialog.showModal();stage(`<p>${label('loading')}</p>`);return ticket();}
  const field=(name,key,{value='',required=true,multiline=false,max=200}={})=>`<label>${label(key)}${multiline?`<textarea name="${name}" rows="3" maxlength="${max}"${required?' required':''}>${esc(value)}</textarea>`:`<input name="${name}" value="${esc(value)}" maxlength="${max}"${required?' required':''}>`}</label>`;
  const select=(name,key,set,display)=>`<label>${label(key)}<select name="${name}" required><option value="" data-i18n="taskFlowChoose">${esc(t('taskFlowChoose'))}</option>${(set?.items||[]).map(item=>`<option value="${esc(item.id)}"${flow.values[name]===item.id?' selected':''}>${esc(display(item.row))}</option>`).join('')}</select></label>${set?.next_offset!=null?button('more','taskFlowLoadMore',{choice:name}):''}`;
  const preserveEditor=(submitted=null)=>{const form=content.querySelector('[data-task-editor]');if(!form||!flow)return;const fd=submitted||new FormData(form);for(const [key,value] of fd)if(typeof value==='string')flow.values[key]=value;flow.values.source_workstream_ids=fd.getAll('source_workstream_ids').map(String);};
  async function choices(name,view,key,params={},append=false){
    const f=flow,at=ticket(),epoch=(f.choiceEpoch[name]||0)+1,old=f.choices[name],offset=append?old?.next_offset:0;f.choiceEpoch[name]=epoch;
    const data=await api(view,{...params,offset:offset??0,limit:25});if(!valid(at)||flow!==f||epoch!==f.choiceEpoch[name])return false;
    if(!Array.isArray(data[key]))throw new Error('taskFlowInvalidReply');
    const idKey={project_id:'project_id',task_id:'task_id',target_event_id:'target_event_id'}[name];
    f.choices[name]={view,key,params,items:[...(append?old?.items||[]:[]),...data[key].map(row=>({id:row[idKey],row}))],next_offset:data.next_offset};return true;
  }
  function editor(){if(!flow)return;const v=flow.values;let fields='';
    if(flow.type==='project')fields=field('project_name','projectName',{value:v.project_name})+field('task_title','taskFlowInitialTask',{value:v.task_title})+field('task_goal','goal',{value:v.task_goal,multiline:true,max:4096})+field('workstream_name','taskFlowWorkstreamName',{value:v.workstream_name,required:false});
    if(flow.type==='task')fields=select('project_id','projectName',flow.choices.project_id,row=>`${row.name} · ${row.project_id}`)+field('title','taskTitle',{value:v.title})+field('goal','goal',{value:v.goal,multiline:true,max:4096})+field('workstream_name','taskFlowWorkstreamName',{value:v.workstream_name,required:false});
    if(flow.type==='reconcile')fields=`<p>${label('taskFlowWholeProposal')}</p>`+select('task_id','taskTitle',flow.choices.task_id,row=>`${row.title} · ${row.project_id}`);
    if(flow.type==='resume'){
      fields=select('project_id','projectName',flow.choices.project_id,row=>`${row.name} · ${row.project_id}`)+select('task_id','taskTitle',flow.choices.task_id,row=>`${row.title} · ${row.task_id}`);
      const sources=flow.branches?flow.branches.items.map(branch=>`<label class="check-field"><input type="checkbox" name="source_workstream_ids" value="${esc(branch.workstream_id)}"${v.source_workstream_ids?.includes(branch.workstream_id)?' checked':''}>${esc(branch.name||branch.workstream_id)}</label>`).join('')||empty('taskFlowNoSources'):empty(flow.branchError?'taskFlowSourceLoadFailed':v.task_id?'loading':'taskFlowChooseTaskSources');
      fields+=`<fieldset><legend>${label('sourceBranch')}</legend><label>${label('taskFlowSourceMode')}<select name="source_mode"><option value="all" data-i18n="taskFlowAllSources"${v.source_mode!=='selected'?' selected':''}>${esc(t('taskFlowAllSources'))}</option><option value="selected" data-i18n="taskFlowSelectedSources"${v.source_mode==='selected'?' selected':''}>${esc(t('taskFlowSelectedSources'))}</option></select></label>${flow.branches?.truncated?`<p class="policy-box">${label('taskFlowSourcesTruncated')}</p>`:''}<div data-task-sources${v.source_mode!=='selected'?' hidden':''}>${sources}</div></fieldset>`;
      if(flow.branchError)fields+=`<p role="alert">${label('taskFlowSourceLoadFailed')}</p>${button('retry-sources','retry')}`;
      fields+=select('target_event_id','targetAgent',flow.choices.target_event_id,row=>`${row.label||row.agent_id} · ${row.device_id} · ${row.session_id} · ${row.workstream_id}`)+`<p class="muted">${label('taskFlowTargetObservedOnly')}</p>`;
      if(flow.choices.target_event_id&&!flow.choices.target_event_id.items.length)fields+=`<p class="policy-box">${label('taskFlowNoTargets')} <a href="/app/agents">${label('agents')}</a></p>`;
    }
    stage(`<form data-task-editor>${fields}${errorBox()}<div class="actions">${button('close','cancel')}<button type="submit" class="primary">${label('generatePreview')}</button></div></form>`);
  }
  async function begin(type){if(busy||!FORM[type]||!can(FORM[type].preview))return;const at=open(type);
    try{if(['task','resume'].includes(type))await choices('project_id','projects','projects',{archived:'false'});if(!valid(at))return;
      if(type==='reconcile')await choices('task_id','task-branches','tasks');if(!valid(at))return;
      if(type==='resume')await choices('target_event_id','resume-targets','targets');if(valid(at))editor();
    }catch(e){if(valid(at))stage(`<p role="alert">${esc(problem(e.message))}</p>${button(type,'retry')}${button('close','close')}`);}
  }
  async function loadBranches(){const f=flow,at=ticket(),selected=f.values.task_id,epoch=++f.branchEpoch;f.branches=null;f.branchError=null;editor();if(!selected)return;
    try{const data=await api('task-branches',{task_id:selected});if(!valid(at)||flow!==f||epoch!==f.branchEpoch)return;
      if(!Array.isArray(data.preview?.branches))throw new Error('taskFlowSourceLoadFailed');
      f.branches={items:data.preview.branches,truncated:data.preview.truncated===true||data.preview.source_summary?.observed_workstream_count>data.preview.branches.length};editor();
    }catch(e){if(valid(at)&&flow===f&&epoch===f.branchEpoch){f.branchError=e.message;editor();}}
  }
  const refOf=receipt=>receipt?.resume_id?{resume_id:receipt.resume_id,preview_version:receipt.preview_version}:receipt?.preview_id?{preview_id:receipt.preview_id,preview_version:receipt.preview_version}:null;
  async function readPreview(ref){const value=await api(ref.resume_id?'resume-status':'task-workflow-preview',ref.resume_id?{resume_id:ref.resume_id}:{preview_id:ref.preview_id});
    if((ref.resume_id?value.resume_id:value.preview_id)!==(ref.resume_id||ref.preview_id)||!Number.isInteger(value.preview_version)||(ref.preview_version!==undefined&&value.preview_version!==ref.preview_version))throw new Error('taskFlowPreviewChanged');return value;}
  const expiry=preview=>Date.parse(preview?.expires_at||preview?.preview?.expires_at||'');
  function allowed(preview,decision){return preview&&preview.preview_version===flow.ref.preview_version&&(!Number.isFinite(expiry(preview))||expiry(preview)>Date.now())&&
    (decision==='cancel'?preview.can_cancel===true:decision==='reject'?preview.can_reject===true:preview.can_confirm===true);}
  function technical(data){return `<details class="tech-details"><summary>${label('technicalDetails')}</summary><pre class="body-content">${esc(JSON.stringify(data,null,2))}</pre></details>`;}
  function checkpointViews(p){return (p.latest_checkpoints||[]).length?`<section><h3>${label('taskFlowCheckpoints')}</h3>${p.latest_checkpoints.map(checkpoint=>{const c=checkpoint.content||{},workstream=p.workstreams?.find(row=>row.workstream_id===checkpoint.workstream_id),outcome=typeof c.latest_outcome==='string'?c.latest_outcome:c.latest_outcome?.text;
    return `<article class="entity-source"><h4>${esc(workstream?.name||checkpoint.workstream_id)}</h4>${facts([['taskFlowCheckpointVersion',checkpoint.version],['created',date(checkpoint.created_at)]])}${outcome?paragraph(outcome):''}${notes('taskFlowProgress',c.completed_items)}${notes('taskFlowDecisions',c.decisions)}${notes('taskFlowBlockers',c.blockers)}${notes('taskFlowNextSteps',c.next_steps)}${notes('taskFlowResources',c.resources)}</article>`;}).join('')}</section>`:'';}
  function previewBody(value){const p=value.preview;if(!p||value.content_withheld)return empty('taskFlowContentWithheld');
    if(flow.type==='reconcile'){
      const proposal=p.proposal;if(!proposal)return `<p>${stateLabel(p.status)}</p>${['no_changes','no_effect'].includes(p.status)?empty('taskFlowNoChanges'):technical(p)}`;
      return `<p class="policy-box">${label('taskFlowWholeProposal')}</p>${facts([['taskTitle',proposal.task_id],['taskFlowProposalVersion',proposal.proposal_version],['taskFlowCanonicalVersion',proposal.base_canonical_version]])}<h3>${label('taskFlowChanges')}</h3>${(proposal.operations||[]).map(op=>`<section class="entity-source"><h4>${esc(op.field||op.op)}</h4><div class="columns"><div><strong>${label('taskFlowBefore')}</strong>${paragraph(op.before)}</div><div><strong>${label('taskFlowAfter')}</strong>${paragraph(op.after)}</div></div></section>`).join('')||empty('taskFlowNoChanges')}${notes('taskFlowConflicts',proposal.conflicts)}${technical({source_checkpoint_ids:proposal.source_checkpoint_ids,source_workstreams:proposal.source_workstreams})}`;
    }
    if(flow.type==='resume'){
      return facts([['projectName',p.project?.name||p.project?.project_id],['taskTitle',p.task?.title||p.task_title||value.task_title],['goal',p.task?.goal||p.goal],['taskFlowExpires',value.expires_at||p.expires_at]])+notes('taskFlowProgress',p.progress)+notes('taskFlowDecisions',p.decisions)+notes('taskFlowBlockers',p.blockers)+notes('taskFlowNextSteps',p.next_steps)+notes('taskFlowResources',p.resources)+notes('taskFlowWorkstreams',(p.workstreams||[]).map(row=>[row.name||row.workstream_id,row.description].filter(Boolean).join(' · ')))+notes('taskFlowConflicts',p.conflicts)+
        `<section><h3>${label('taskFlowSourceContext')}</h3>${notes('taskFlowMemories',(p.structured_memories||[]).map(memory=>memory.content))}${notes('taskFlowActivity',(p.recent_activity||[]).map(event=>event.content??t('taskFlowSourceExpired')))}${checkpointViews(p)}${technical(p)}</section>`;
    }
    const main=p.proposed||p,project=main.project||p.project,task=main.task||(p.proposed?.title?p.proposed:p.task);
    return facts([['projectName',project?.name],['taskTitle',task?.title],['goal',task?.goal],['taskFlowWorkstreamName',main.workstream?.name||p.workstream?.name],['taskFlowExpires',value.expires_at]])+
      (Array.isArray(p.candidates)?notes('taskFlowExistingCandidates',p.candidates):'')+`<p class="policy-box">${label('taskFlowConsoleBindingOnly')}</p>`;
  }
  function previewView(){if(!flow?.preview)return;const value=flow.preview,receipt=deliveryLabels(value),target=value.target;
    const confirmation=can(FORM[flow.type]?.confirm),yes=confirmation&&allowed(value,'confirm'),reject=flow.type==='reconcile'&&confirmation&&allowed(value,'reject'),cancel=flow.type!=='reconcile'&&confirmation&&allowed(value,'cancel');
    const status=`<div role="status" tabindex="-1" data-task-state="${esc(value.status)}">${stateLabel(value.status)}</div>`;
    const targetView=target?facts([['targetAgent',target.label||target.agent_id],['deviceId',target.device_id],['sessionIdentifier',target.session_id],['sourceBranch',target.workstream_id]]):'';
    const delivery=flow.type==='resume'?`<p>${label('deliveryState')}: ${label(receipt.delivery)} · ${label('completionAck')}: ${label(receipt.completion)}</p><p class="muted">${label('taskFlowDeliveryNote')}</p>${receiptRows(value)}`:'';
    const proof=(yes||reject||cancel)?`<fieldset class="reauth"><legend>${label('reauthenticate')}</legend><label>${label('currentPassword')}<input type="password" name="current_password" maxlength="1024" autocomplete="current-password" required></label><label>${label('otp')}<input name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6" required></label><p>${label('otpFreshNote')}</p></fieldset>`:'';
    stage(`${status}${targetView}${delivery}${value.blockers?.length?`<p class="policy-box">${value.blockers.map(code=>esc(problem(code))).join(' · ')}</p>`:''}${previewBody(value)}<form data-task-confirm>${proof}${errorBox()}<div class="actions">${yes?`<button type="submit" class="primary" data-task-decision="confirm">${label(flow.type==='resume'?'confirmResume':flow.type==='reconcile'?'taskFlowAcceptProposal':'taskFlowConfirmCreation')}</button>`:''}${reject?`<button type="submit" data-task-decision="reject">${label('taskFlowRejectProposal')}</button>`:''}${cancel?`<button type="submit" data-task-decision="cancel">${label('taskFlowCancelPreview')}</button>`:''}${button('refresh-preview','refresh')}${button('close','close')}</div></form>`,'[data-task-state]');
    clearTimeout(expiryTimer);const until=expiry(value)-Date.now(),at=ticket();if((yes||reject||cancel)&&Number.isFinite(until)&&until>0)expiryTimer=setTimeout(()=>{if(!valid(at))return;flow.preview={...value,status:'expired',preview:null,content_withheld:true,can_confirm:false,can_cancel:false,can_reject:false};previewView();},Math.min(until,2147483647));
  }
  function retryRead(errorKey){flow.preview=null;clearTimeout(expiryTimer);stage(`<p role="alert">${esc(problem(errorKey))}</p><p>${label('taskFlowReadPreviewFailed')}</p>${button('refresh-preview','retry')}${button('close','close')}`);}
  async function showPreview(){if(!flow?.ref)return;const at=ticket(),f=flow,epoch=++f.readEpoch;clearProof();try{const value=await readPreview(f.ref);if(!valid(at)||flow!==f||epoch!==f.readEpoch)return;f.ref.preview_version??=value.preview_version;f.preview=value;previewView();}catch(e){if(valid(at)&&flow===f&&epoch===f.readEpoch&&e.name!=='AbortError')retryRead(e.message);}}
  function operation(action,payload){const key=JSON.stringify([action,payload]);if(flow.operation?.key!==key)flow.operation={key,id:crypto.randomUUID()};return flow.operation.id;}
  function previewPayload(){const v=flow.values;
    if(flow.type==='project')return {project_name:v.project_name,task_title:v.task_title,task_goal:v.task_goal,...(v.workstream_name?{workstream_name:v.workstream_name}:{})};
    if(flow.type==='task')return {project_id:v.project_id,title:v.title,goal:v.goal,...(v.workstream_name?{workstream_name:v.workstream_name}:{})};
    if(flow.type==='reconcile')return {task_id:v.task_id};
    const sources=v.source_mode==='selected'?v.source_workstream_ids:undefined;if(sources&&!sources.length)throw new Error('taskFlowChooseSource');
    return {task_id:v.task_id,target_event_id:v.target_event_id,...(sources?{source_workstream_ids:sources}:{})};
  }
  async function submitPreview(fd){const at=ticket();preserveEditor(fd);const action=FORM[flow.type].preview;
    if(!can(action))throw new Error('BLOCKED_POLICY');const payload=previewPayload(),op=operation(action,payload),receipt=await mutate(action,payload,op);if(!valid(at))return;
    const ref=refOf(receipt);if(!ref||!Number.isInteger(ref.preview_version))throw new Error('taskFlowInvalidReply');flow.ref=ref;flow.receipt=receipt;flow.operation=null;await showPreview();
  }
  function resultView(receipt){flow.preview=null;clearTimeout(expiryTimer);clearProof();stage(`<div class="policy-box" role="status">${stateLabel(receipt.status)}<p>${label(receipt.status==='cancelled'?'taskFlowCancelledNote':flow.type==='resume'?'taskFlowQueuedNote':flow.type==='reconcile'?'taskFlowProposalResult':'taskFlowCreationResult')}</p></div>${errorBox()}<div class="actions">${flow.ref?button('refresh-preview','taskFlowReadCurrent'):''}${button('close','close')}</div>`,'button');}
  async function confirm(fd,decision){const at=ticket(),ref={...flow.ref},action=FORM[flow.type]?.confirm,f=flow,epoch=++f.readEpoch;if(!can(action)||!ref.preview_version)throw new Error('BLOCKED_POLICY');
    if(!(flow.type==='reconcile'?['confirm','reject']:['confirm','cancel']).includes(decision))throw new Error('taskFlowPreviewUnavailable');
    // This read runs before password/OTP is sent. A changed or expired preview must never silently become a new intent.
    let fresh;try{fresh=await readPreview(ref);}catch(e){if(valid(at)&&flow===f&&epoch===f.readEpoch)retryRead(e.message);throw e;}
    if(!valid(at)||flow!==f||epoch!==f.readEpoch)return;flow.preview=fresh;if(!allowed(fresh,decision)){previewView();if(['confirmed','applied','rejected','cancelled','queued','delivered','completed'].includes(fresh.status)){flow.operation=null;try{await reload();}catch{if(valid(at))error('taskFlowSavedRefreshFailed');}return;}throw new Error('taskFlowPreviewUnavailable');}
    const payload=flow.type==='reconcile'?{preview_id:ref.preview_id,preview_version:ref.preview_version,decision:decision==='reject'?'reject':'confirm'}:{...ref,confirmed:decision==='confirm'};
    const op=operation(action,payload),receipt=await mutate(action,{...payload,current_password:String(fd.get('current_password')||''),otp:String(fd.get('otp')||'')},op);
    if(!valid(at))return;flow.receipt=receipt;flow.operation=null;resultView(receipt);
    try{await reload();}catch{if(valid(at))error('taskFlowSavedRefreshFailed');}
  }
  async function status(id){if(busy)return;const at=open('resume');flow.ref={resume_id:id};try{const value=await api('resume-status',{resume_id:id});if(!valid(at))return;
      if(value.resume_id!==id||!Number.isInteger(value.preview_version))throw new Error('taskFlowInvalidReply');flow.ref.preview_version=value.preview_version;flow.preview=value;previewView();
    }catch(e){if(valid(at))retryRead(e.message);}}
  function paintHistory(data,problem=null){for(const slot of document.querySelectorAll('[data-task-workflow-slot]')){const mode=slot.dataset.taskWorkflowSlot;
    slot.innerHTML=(data?historyRows(data,mode)+(mode==='history'?historyPager(data,historyPrevious.get(data.offset)):empty('taskFlowCurrentPage')):'')+(problem?`<p role="alert">${esc(t(errorKeys[problem]||problem))}</p>${button('history-refresh','retry')}`:'');slot.removeAttribute('aria-busy');}syncAppearance();}
  async function afterRender(){const slots=[...document.querySelectorAll('[data-task-workflow-slot]')];if(!slots.length||!isActive()||!account())return;
    const seq=++historySequence,owner=account();if(historyAccount!==owner){history=null;historyOffset=0;historyPrevious.clear();historyAccount=owner;}for(const slot of slots)slot.setAttribute('aria-busy','true');
    const current=()=>seq===historySequence&&owner===account()&&isActive()&&slots.every(slot=>slot.isConnected);
    try{const data=await api('resume-history',{offset:historyOffset,limit:10});if(!current())return;if(!Array.isArray(data.items))throw new Error('taskFlowInvalidReply');history=data;paintHistory(history);}
    catch(e){if(current()&&e.name!=='AbortError')paintHistory(history,e.message);}}
  document.addEventListener('click',event=>{const control=event.target.closest('[data-task-workflow]');if(!control)return;const action=control.dataset.taskWorkflow;
    if(action==='close'){if(!busy){restoreFocus();dispose();dialog.close();}return;}
    if(action==='history-page'||action==='history-refresh'){if(action==='history-page'){const next=Number(control.dataset.offset)||0;if(history&&next>history.offset)historyPrevious.set(next,history.offset);historyOffset=next;}void afterRender();return;}
    if(busy)return;if(Object.hasOwn(FORM,action)){void begin(action);return;}if(action==='status'){void status(control.dataset.id);return;}
    if(action==='refresh-preview'){void showPreview();return;}
    if(action==='retry-sources'&&flow?.type==='resume'){preserveEditor();void loadBranches();return;}
    if(action==='more'&&flow){preserveEditor();const name=control.dataset.choice,set=flow.choices[name],at=ticket();if(!set?.next_offset)return;control.disabled=true;
      void choices(name,set.view,set.key,set.params,true).then(changed=>{if(changed&&valid(at))editor();}).catch(e=>{if(valid(at))error(e.message);}).finally(()=>{if(control.isConnected)control.disabled=false;});}
  });
  dialog.addEventListener('change',event=>{if(!flow||busy||!event.target.name)return;preserveEditor();const name=event.target.name,at=ticket();
    if(name==='source_mode'){const box=content.querySelector('[data-task-sources]');if(box)box.hidden=flow.values.source_mode!=='selected';return;}
    if(flow.type!=='resume')return;
    if(name==='project_id'){flow.values.task_id='';flow.values.source_workstream_ids=[];flow.branches=null;flow.branchError=null;flow.branchEpoch++;delete flow.choices.task_id;editor();
      if(!flow.values.project_id){flow.choiceEpoch.task_id=(flow.choiceEpoch.task_id||0)+1;return;}void choices('task_id','task-branches','tasks',{project_id:flow.values.project_id}).then(changed=>{if(changed&&valid(at))editor();}).catch(e=>{if(valid(at))error(e.message);});}
    if(name==='task_id'){flow.values.source_workstream_ids=[];void loadBranches();}
  });
  dialog.addEventListener('submit',async event=>{event.preventDefault();if(busy||!flow)return;const at=ticket(),form=event.target,fd=new FormData(form);busy=true;const controls=[...dialog.querySelectorAll('button,input,select,textarea')];controls.forEach(node=>node.disabled=true);
    try{if(form.matches('[data-task-editor]'))await submitPreview(fd);else if(form.matches('[data-task-confirm]'))await confirm(fd,event.submitter?.dataset.taskDecision||'confirm');}
    catch(e){if(valid(at)&&e.name!=='AbortError'){clearProof();if(flow.ref&&invalidatesPreview(e.message))retryRead(e.message);else error(e.message);}}
    finally{if(valid(at))busy=false;for(const node of controls)if(node.isConnected)node.disabled=false;}
  });
  dialog.addEventListener('cancel',event=>{event.preventDefault();if(!busy){restoreFocus();dispose();dialog.close();}});
  dialog.addEventListener('close',()=>{if(!dialog.open){restoreFocus();dispose();}});
  window.addEventListener('pagehide',()=>{dispose();historySequence++;history=null;historyAccount=null;historyPrevious.clear();dialog.close();});
  return {afterRender,clear(){historySequence++;historyOffset=0;history=null;historyAccount=null;historyPrevious.clear();dispose();trigger=null;dialog.close();}};
}

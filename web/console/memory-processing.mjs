// Pure view. The controller supplies a version-pinned read and fences late responses on account/detail changes.
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function memoryProcessingView(t,data,{writable=false}={}){
  const label=key=>esc(t(key)),state=value=>label(`processingState_${value}`);
  const action=(kind,key)=>`<button type="button" data-console-action="processing.preview" data-selection="true" data-kind="${kind}" data-id="${esc(data.memory_id)}" data-revision="${data.revision}">${label(key)}</button>`;
  const repairable=writable&&data.source.status==='available';
  const buttons=[...(repairable&&data.traits.status==='missing'?[action('traits','processingRepairTraits')]:[]),
    ...(repairable&&data.summary.status!=='covered'?[action('summary','processingRepairSummary')]:[]),
    ...(repairable&&data.vector.status!=='indexed'&&!data.vector.repair_blockers.length?[action('vector','processingRepairVector')]:[])];
  const rows=[['processingSource',state(data.source.status)],['processingTraits',state(data.traits.status)],
    ['processingSummary',state(data.summary.status)],['processingVector',`${state(data.vector.status)} · ${label('processingConfirmedChunks')} ${data.vector.confirmed_chunks}`]];
  const runRows=data.runs.items.map(run=>`<li><span>${label('processingChannel_'+run.kind)}</span> · ${esc(t(run.state))} · ${label('revisions')} ${run.revision} · ${run.used}/${run.budget}${run.error_code?` <strong>${esc(t(run.error_code))}</strong>`:''}</li>`).join('');
  const jobs=data.jobs.items.map(job=>`<li>${label('processingChannel_'+job.job_type)} · ${esc(t(job.state))} · ${label('revisions')} ${job.revision}${job.last_error_code?` <strong>${esc(t(job.last_error_code))}</strong>`:''}</li>`).join('');
  return `<h3>${label('processingEvidenceTitle')}</h3><p class="muted">${label('processingEvidenceNote')} · ${label('revisions')} ${data.revision}</p>
    <dl class="detail-facts">${rows.map(([key,value])=>`<dt>${label(key)}</dt><dd>${value}</dd>`).join('')}</dl>
    ${data.vector.repair_blockers.length?`<p class="muted">${data.vector.repair_blockers.map(code=>esc(t(code))).join(' · ')}</p>`:''}
    <div class="actions">${buttons.join('')}<button type="button" class="quiet" data-processing-refresh>${label('refresh')}</button></div>
    <details><summary>${label('processingHistory')}</summary>${runRows?`<ul>${runRows}</ul>`:`<p>${label('processingNoRuns')}</p>`}
      ${jobs?`<ul>${jobs}</ul>`:''}${data.runs.truncated||data.jobs.truncated?`<p>${label('processingHistoryBound')}</p>`:''}</details>
    ${data.summary.truncated?`<p class="muted">${label('processingSummaryBound')}</p>`:''}`;
}

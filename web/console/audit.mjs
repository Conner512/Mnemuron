// Audit export consumes exactly one independently paged stream. It is a bounded live listing, never a snapshot.
// Keep an explicit projection here too: a future API field cannot accidentally export bodies or secrets.
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value||{},key)).map(key=>[key,value[key]]));
const entryKeys=['audit_id','action','kind','outcome','created','created_at','target_type','target_id','credential_id','group','unclassified'];
export function auditExportPage(data,source,group){
  if(data.source!==source||group&&data.group!==group||!Array.isArray(data.entries)||source==='grouped'&&data.entries.some(e=>!['core','identity'].includes(e.source)||e.group!==group))throw new Error('INVALID_AUDIT_PAGE');
  const entries=data.entries.map(row=>({...pick(row,entryKeys),source:source==='grouped'?row.source:source,...((source==='core'||row.source==='core')&&row.query?{query:pick(row.query,['result_count','result_refs','result_refs_truncated','result_refs_kind'])}:{})}));
  const credentialIds=new Set(entries.map(e=>e.credential_id).filter(Boolean)),memoryIds=new Set(entries.flatMap(e=>[...(e.target_type==='memory'&&e.target_id?[e.target_id]:[]),...(e.query?.result_refs||[])]));
  const credentials=Object.create(null),memories=Object.create(null);
  if(source==='core'||source==='grouped'){
    for(const id of credentialIds){const c=Object.hasOwn(data.credentials||{},id)?data.credentials[id]:null;if(!c)continue;
      credentials[id]={...pick(c,['label','agent_id','agent_instance_id','device_id','revoked']),...(c.connection?{connection:pick(c.connection,['type','connection_id','credential_version','credential_revoked','label','kind','state','missing','purpose'])}:{})};}
    for(const id of memoryIds)if(Object.hasOwn(data.memories||{},id))memories[id]=pick(data.memories[id],['title','status']);
  }
  return {entries,credentials,memories,memory_titles_truncated:data.memory_titles_truncated===true};
}
export async function collectAuditExport(read,params={},current=()=>true){
  const filters={...params,...(params.group?{}:{source:params.source||'core'})},source=params.group?'grouped':filters.source;
  if(params.group&&!['system','memory','connections','security'].includes(params.group))throw new Error('INVALID_AUDIT_PAGE');
  if(!['core','identity','grouped'].includes(source))throw new Error('INVALID_AUDIT_PAGE');
  delete filters.offset;delete filters.limit;delete filters.cursor;
  const check=()=>{if(!current())throw new Error('STALE_ACCOUNT');};
  let offset=0,cursor=undefined,size=0,requests=0;const cursors=new Set();let memory_titles_truncated=false;const entries=new Map(),credentials=Object.create(null),memories=Object.create(null);
  for(;;){
    check();if(++requests>100)throw new Error('EXPORT_SIZE_LIMIT');
    const data=await read({...filters,...(source==='grouped'?{...(cursor?{cursor}:{})}:{offset}),limit:100});check();
    const page=auditExportPage(data,source,filters.group);size+=new TextEncoder().encode(JSON.stringify(page)).length;
    if(size>16*1024*1024)throw new Error('EXPORT_SIZE_LIMIT');
    for(const e of page.entries)entries.set(e.source+':'+e.audit_id,e);Object.assign(credentials,page.credentials);Object.assign(memories,page.memories);
    memory_titles_truncated ||= page.memory_titles_truncated;
    if(source==='grouped'){if(data.next_cursor==null)break;if(typeof data.next_cursor!=='string'||cursors.has(data.next_cursor))throw new Error('INVALID_AUDIT_PAGE');cursors.add(data.next_cursor);cursor=data.next_cursor;continue;}
    if(data.next_offset==null)break;
    if(!Number.isSafeInteger(data.next_offset)||data.next_offset<=offset||data.next_offset>1000000)throw new Error('INVALID_AUDIT_PAGE');
    offset=data.next_offset;
  }
  check();return {format:'mnemuron-own-audit-v2',snapshot:'bounded_live_listing',source,group:filters.group,filters,generated_at:new Date().toISOString(),
    provenance:{credential:'recorded_reference_with_issuance_attributes',connection:'current_owner_scoped_mapping_and_labels',memory:'current_owner_readable_titles',query_results:'bounded_lexical_subquery_refs_not_final_search_results'},
    entries:[...entries.values()],credentials,memories,memory_titles_truncated};
}

// Inputs use an explicit local wall-clock format. Reject normalized invalid dates and DST gaps.
export function auditLocalToUTC(value){
 if(!value)return '';
 const m=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value);
 if(!m)throw new Error('auditDateInvalid');
 const [y,mo,d,h,mi]=m.slice(1).map(Number),date=new Date(0);date.setFullYear(y,mo-1,d);date.setHours(h,mi,0,0);
 if(y<1000||date.getFullYear()!==y||date.getMonth()!==mo-1||date.getDate()!==d||date.getHours()!==h||date.getMinutes()!==mi)throw new Error('auditDateInvalid');
 return date.toISOString();
}
export function auditLocalValue(value){
 if(!value)return '';const d=new Date(value);if(!Number.isFinite(d.getTime()))return '';
 const pad=n=>String(n).padStart(2,'0');return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function auditDateRange(from,to){const a=auditLocalToUTC(from),b=auditLocalToUTC(to);if(a&&b&&a>b)throw new Error('auditDateRange');return {from:a,to:b};}

export function mountAuditDates(t){
 let dialog=null,trigger=null,input=null,selected=null,month=null,empty=false;
 const pad=n=>String(n).padStart(2,'0'),key=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
 const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const close=()=>{if(!dialog)return;const old=trigger;dialog.close();dialog.remove();dialog=null;old?.setAttribute('aria-expanded','false');old?.focus();};
 function calendar(focusKey){
  const label=dialog.querySelector('[data-month-label]');label.textContent=month.toLocaleDateString(document.documentElement.lang||undefined,{year:'numeric',month:'long'});
  const grid=dialog.querySelector('[data-date-grid]');grid.replaceChildren();
  const start=new Date(month.getFullYear(),month.getMonth(),1),weekday=(start.getDay()+6)%7;
  for(let i=0;i<7;i++){const el=document.createElement('span');el.className='date-weekday';el.textContent=new Date(2026,0,5+i).toLocaleDateString(document.documentElement.lang||undefined,{weekday:'short'});grid.append(el);}
  for(let i=0;i<42;i++){
   const date=new Date(month.getFullYear(),month.getMonth(),i-weekday+1),button=document.createElement('button');button.type='button';button.dataset.day=key(date);button.textContent=date.getDate();
   button.className='date-day'+(date.getMonth()!==month.getMonth()?' adjacent':'');button.setAttribute('aria-label',date.toLocaleDateString(document.documentElement.lang||undefined,{dateStyle:'full'}));button.setAttribute('aria-pressed',String(!empty&&key(date)===key(selected)));if(key(date)===key(new Date()))button.setAttribute('aria-current','date');button.tabIndex=key(date)===(focusKey||key(selected))?0:-1;grid.append(button);
  }
  if(!grid.querySelector('[tabindex="0"]'))grid.querySelector('[data-day="'+key(start)+'"]').tabIndex=0;
  dialog.querySelector('[data-date-selection]').textContent=empty?t('auditDateEmpty'):key(selected);
  if(focusKey)grid.querySelector('[data-day="'+focusKey+'"]')?.focus();
 }
 function open(button){
  close();trigger=button;input=document.getElementById(button.dataset.auditDate);if(!input)return;
  try{selected=input.value?new Date(auditLocalToUTC(input.value)):new Date();}catch{selected=new Date();}
  month=new Date(selected.getFullYear(),selected.getMonth(),1);empty=!input.value;
  dialog=document.createElement('dialog');dialog.className='audit-date-dialog';dialog.setAttribute('aria-labelledby','audit-date-title');
  dialog.innerHTML=`<header><div><span class="eyebrow">${esc(t('auditDateChoose'))}</span><h2 id="audit-date-title">${esc(t(input.name==='from'?'auditFrom':'auditTo'))}</h2></div><button type="button" data-date-close aria-label="${esc(t('close'))}">×</button></header><div class="date-month"><button type="button" data-month="-1" aria-label="${esc(t('auditPrevMonth'))}">‹</button><strong data-month-label aria-live="polite"></strong><button type="button" data-month="1" aria-label="${esc(t('auditNextMonth'))}">›</button></div><div class="date-grid" data-date-grid role="group" aria-label="${esc(t('auditCalendar'))}"></div><div class="date-time-row"><span data-date-selection></span><label>${esc(t('auditTime'))}<input data-date-time type="text" inputmode="numeric" maxlength="5" placeholder="HH:mm" aria-label="${esc(t('auditTime'))}" value="${pad(selected.getHours())}:${pad(selected.getMinutes())}"></label></div><p class="date-zone">${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)} · ${esc(t('auditDateDST'))}</p><p data-date-error role="alert"></p><footer><button type="button" data-date-clear>${esc(t('clear'))}</button><span></span><button type="button" data-date-close>${esc(t('cancel'))}</button><button type="button" class="primary" data-date-apply>${esc(t('auditDateUse'))}</button></footer>`;
  document.body.append(dialog);calendar();dialog.showModal();button.setAttribute('aria-expanded','true');dialog.querySelector('[tabindex="0"]').focus();
  dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
  dialog.addEventListener('click',e=>{
   if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close();return;}
   if(e.target.closest('[data-date-close]'))return close();
   const day=e.target.closest('[data-day]');if(day){selected=new Date(day.dataset.day+'T12:00:00');empty=false;month=new Date(selected.getFullYear(),selected.getMonth(),1);calendar(key(selected));return;}
   const move=e.target.closest('[data-month]');if(move){month=new Date(month.getFullYear(),month.getMonth()+Number(move.dataset.month),1);calendar();return;}
   if(e.target.closest('[data-date-clear]')){empty=true;calendar();return;}
   if(e.target.closest('[data-date-apply]')){
    const value=empty?'':key(selected)+' '+dialog.querySelector('[data-date-time]').value;
    try{auditLocalToUTC(value);}catch{dialog.querySelector('[data-date-error]').textContent=t('auditDateInvalid');return;}
    input.value=value;input.setCustomValidity('');input.dispatchEvent(new Event('input',{bubbles:true}));close();
   }
  });
  dialog.addEventListener('keydown',e=>{
   if(e.key==='Enter'&&e.target.matches('[data-date-time]')){e.preventDefault();dialog.querySelector('[data-date-apply]').click();return;}
   const day=e.target.closest('[data-day]');if(!day)return;let date=new Date(day.dataset.day+'T12:00:00');
   const delta={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
   if(e.key in delta)date.setDate(date.getDate()+delta[e.key]);else if(e.key==='Home')date.setDate(date.getDate()-(date.getDay()+6)%7);else if(e.key==='End')date.setDate(date.getDate()+6-(date.getDay()+6)%7);else if(e.key==='PageUp'||e.key==='PageDown')date=new Date(date.getFullYear(),date.getMonth()+(e.key==='PageUp'?-1:1),1);else return;
   e.preventDefault();month=new Date(date.getFullYear(),date.getMonth(),1);calendar(key(date));
  });
 }
 document.addEventListener('click',e=>{const b=e.target.closest('[data-audit-date]');if(b)open(b);const c=e.target.closest('[data-audit-copy]');if(c)void navigator.clipboard.writeText(c.dataset.auditCopy).then(()=>{c.textContent=t('copied');},()=>{c.textContent=t('auditCopyFailed');});});
 document.addEventListener('input',e=>{if(e.target.matches('#audit-filter input'))for(const x of e.target.form.querySelectorAll('input'))x.setCustomValidity('');});
 return {close};
}

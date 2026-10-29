import {consoleWritable,CONSOLE_WRITE_SCOPES,exactScopes} from '../../../shared/console-contract.mjs';
import {AuthenticationError,AuthorizationError,ConflictError,NotFoundError,ValidationError} from '../errors.mjs';
import {object,id,number,fingerprint} from './state.mjs';

export const RESUME_WORKFLOW_ACTIONS=['resume.preview','resume.confirm'];
export const RESUME_WORKFLOW_VIEWS=['resume-targets','resume-status','resume-history'];
export const resumeWorkflowParams={
  'resume-targets':['offset','limit'],
  'resume-status':['resume_id'],
  'resume-history':['task_id','offset','limit'],
};
const AGENTS=['codex','openclaw','hermes'];
const REQUIRED_SCOPES=['capture:write','resume:read','resume:confirm'];
// A JSON body, an Agent key, and the Console's ordinary raw API scopes cannot manufacture this authority.
const CONFIRM_AUTHORITY=Symbol('console.resume.confirm');
const TARGET_SCHEMA='console-resume-target-v1';
// The Console BFF accepts 256 KiB. Freeze the complete preview below that boundary and reserve space for
// current metadata and receipt evidence. A page may contain fewer rows, but its exact next_offset preserves all rows.
const PREVIEW_BYTES=160*1024,RESPONSE_BYTES=240*1024,RECEIPT_BYTES=24*1024;
const now=()=>new Date().toISOString();
const conflict=code=>{throw new ConflictError(code,code);};
const parse=value=>JSON.parse(value);
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const bounded=(value,maximum=RESPONSE_BYTES)=>{
  if(bytes(value)>maximum)throw new ConflictError('This complete preview or detail is too large to review. Choose fewer sources.','TASK_WORKFLOW_PREVIEW_TOO_LARGE');
  return value;
};
const page=p=>({offset:number(Number(p.offset??0),0,1000000),limit:number(Number(p.limit??25),1,100)});
const pages=(rows,total,{offset,limit},key)=>({[key]:rows,total,offset,limit,next_offset:offset+rows.length<total?offset+rows.length:null});
const boundedPage=(rows,total,pg)=>{
  const items=[],result=()=>({read_only:true,...pages(items,total,pg,'items'),truncated:items.length<rows.length});
  for(const row of rows){items.push(row);if(bytes(result())>RESPONSE_BYTES){items.pop();if(!items.length)conflict('TASK_WORKFLOW_PREVIEW_TOO_LARGE');break;}}
  return bounded(result());
};
const receiptWindow=(value,total,key,latestKey,details)=>{
  const result={status:value.status,ack_complete:value.ack_complete,total};
  if(!details)return result;
  result[latestKey]=value[latestKey];result[key]=[];result.limit=20;result.truncated=total>0;
  for(const row of value[key]){
    result[key].push(row);if(bytes(result)>RECEIPT_BYTES){result[key].pop();break;}
  }
  result.truncated=total>result[key].length;
  return bounded(result,RECEIPT_BYTES);
};
const identityKeys=['credential_id','device_id','agent_id','agent_instance_id','session_id','workstream_id'];
// Filter completed or actively delivered attempts in SQLite before loading frozen context on every host turn.
// Identifiers below are fixed protocol tables, never request input. Failed attempts remain eligible for retry.
const unconsumedSql=(table,key,initial)=>`NOT EXISTS(SELECT 1 FROM ${table} d WHERE d.user_id=r.user_id AND d.resume_id=r.resume_id AND d.phase='${initial}'
  AND (EXISTS(SELECT 1 FROM ${table} a WHERE a.user_id=d.user_id AND a.resume_id=d.resume_id AND a.${key}=d.${key} AND a.phase='acknowledged')
    OR NOT EXISTS(SELECT 1 FROM ${table} f WHERE f.user_id=d.user_id AND f.resume_id=d.resume_id AND f.${key}=d.${key} AND f.phase='failed')))`;

/** Owner Console authorization around the existing frozen Resume and real Agent receipt protocols.
 * No new API scopes, session records, fabricated deliveries, or second queue authority are created.
 * A confirmed Resume with console_target is the durable pending record. Only its selected Agent may fetch it.
 */
export class ConsoleResumeWorkflows{
  constructor(service){this.service=service;this.store=service.store;this.db=service.db;}

  requireRead(auth){
    if(auth?.agent_id!=='mnemuron-console')throw new AuthorizationError('console:read');
    this.store.requireScope(auth,'console:read');this.store.requireScope(auth,'resume:read');
    if(this.service.owner.user)this.service.owner.require(auth.user_id);
    const row=this.db.prepare('SELECT credential_id,device_id,agent_id,agent_instance_id,scopes_json,revoked_at,expires_at FROM credentials WHERE user_id=? AND credential_id=?').get(auth.user_id,auth.credential_id);
    if(!row||row.revoked_at||row.expires_at&&Date.parse(row.expires_at)<=Date.now()
      ||identityKeys.slice(0,4).some(key=>row[key]!==auth[key])||['console:read','resume:read'].some(scope=>!parse(row.scopes_json).includes(scope)))throw new AuthenticationError();
    return row;
  }
  requireWrite(auth){const row=this.requireRead(auth);if(!consoleWritable(auth)||!exactScopes(parse(row.scopes_json),CONSOLE_WRITE_SCOPES))throw new AuthorizationError('console:write');}
  task(user,taskId){
    id(taskId);const row=this.db.prepare('SELECT * FROM tasks WHERE user_id=? AND task_id=?').get(user,taskId);
    if(!row)throw new NotFoundError('Task not found.','TASK_NOT_FOUND');
    this.store.assertTaskLive(user,taskId);return row;
  }
  // Evidence comes from authenticated capture, including all identity columns. Session identifiers alone grant nothing.
  // No heartbeat protocol exists: an observed, not-ended session is selectable, but never advertised as online.
  targetQuery(user,{eventId=null,latest=false,allowEnded=false}={}){
    const live=this.store.lifecycle.live(user),event=live.sql('e.project_id'),task=live.sql('t.project_id');
    const same="x.user_id=e.user_id AND x.credential_id=e.credential_id AND x.device_id=e.device_id AND x.agent_id=e.agent_id AND x.agent_instance_id=e.agent_instance_id AND x.session_id=e.session_id";
    const clauses=[`e.user_id=?`,`c.revoked_at IS NULL`,`(c.expires_at IS NULL OR c.expires_at>?)`,
      `c.agent_id IN ('codex','openclaw','hermes')`,
      ...REQUIRED_SCOPES.map(scope=>`EXISTS(SELECT 1 FROM json_each(c.scopes_json) WHERE value='${scope}')`),
      `e.session_id IS NOT NULL AND e.workstream_id IS NOT NULL`,event.sql,
      `(e.task_id IS NULL OR EXISTS(SELECT 1 FROM tasks t WHERE t.user_id=e.user_id AND t.task_id=e.task_id AND ${task.sql}))`];
    const params=[user,now(),...event.params,...task.params];
    if(eventId){clauses.push('e.event_id=?');params.push(eventId);}
    if(latest)clauses.push(`e.rowid=(SELECT x.rowid FROM events x WHERE ${same} ORDER BY x.captured_at DESC,x.rowid DESC LIMIT 1)`);
    if(!allowEnded){
      clauses.push(`(SELECT x.event_type FROM events x WHERE ${same} ORDER BY x.captured_at DESC,x.rowid DESC LIMIT 1)<>'session_end'`);
      clauses.push(`(SELECT x.workstream_id FROM events x WHERE ${same} ORDER BY x.captured_at DESC,x.rowid DESC LIMIT 1)=e.workstream_id`);
      // The selected evidence belongs to one observed session epoch. Reusing the same session identifier after
      // an end can authorize a new preview, never revive an old packet. Late older captures do not end a new epoch.
      clauses.push(`NOT EXISTS(SELECT 1 FROM events x WHERE ${same} AND x.event_type='session_end'
        AND (x.captured_at>e.captured_at OR (x.captured_at=e.captured_at AND x.rowid>e.rowid)))`);
    }
    return {sql:`SELECT e.event_id target_event_id,c.credential_id,c.label,c.device_id,c.agent_id,c.agent_instance_id,e.session_id,e.workstream_id,
      (SELECT MAX(x.received_at) FROM events x WHERE ${same}) last_seen_at
      FROM events e JOIN credentials c ON c.user_id=e.user_id AND c.credential_id=e.credential_id
        AND c.device_id=e.device_id AND c.agent_id=e.agent_id AND c.agent_instance_id=e.agent_instance_id
      WHERE ${clauses.join(' AND ')}`,params};
  }
  target(user,eventId,options={}){
    id(eventId);const q=this.targetQuery(user,{eventId,...options}),row=this.db.prepare(q.sql).get(...q.params);
    if(!row)conflict('RESUME_TARGET_UNAVAILABLE');
    for(const key of ['target_event_id',...identityKeys])id(row[key]);
    return {...row,online:'not_observable',session_state:'observed_open'};
  }
  targets(auth,p){
    this.requireRead(auth);object(p,resumeWorkflowParams['resume-targets']);const pg=page(p);
    return this.store.memoryTransaction(()=>{
      this.requireRead(auth);const q=this.targetQuery(auth.user_id,{latest:true});
      const total=this.db.prepare(`SELECT COUNT(*) n FROM (${q.sql})`).get(...q.params).n;
      const rows=this.db.prepare(`${q.sql} ORDER BY last_seen_at DESC,target_event_id LIMIT ? OFFSET ?`).all(...q.params,pg.limit,pg.offset)
        .map(row=>({...row,online:'not_observable',session_state:'observed_open'}));
      return bounded({read_only:true,...pages(rows,total,pg,'targets'),supported_agents:AGENTS,handoff:this.store.handoffPolicy.status(auth.user_id)});
    });
  }
  load(user,resumeId){
    id(resumeId);const row=this.db.prepare('SELECT * FROM resumes WHERE user_id=? AND resume_id=?').get(user,resumeId);
    if(!row)throw new NotFoundError('Resume not found.','RESUME_NOT_FOUND');
    this.task(user,row.task_id);
    const preview=parse(row.preview_json);
    // A Task may have moved since this snapshot. Both its current project and the snapshot's project must be live.
    const state=this.store.lifecycle.projectState(user,preview.project?.project_id);
    if(state==='deleted')conflict('PROJECT_DELETED');
    if(state==='unavailable')throw new NotFoundError('Resume not found.','RESUME_NOT_FOUND');
    return {row,preview};
  }
  binding(preview){return preview.console_target?.schema_version===TARGET_SCHEMA?preview.console_target:null;}
  assertTarget(user,target,{allowEnded=false}={}){
    const current=this.target(user,target.target_event_id,{allowEnded});
    if(identityKeys.some(key=>current[key]!==target[key]))conflict('RESUME_TARGET_UNAVAILABLE');
    return current;
  }
  assertContext(user,row,preview,{live=null}={}){
    this.store.assertAuthorityCurrent(user,'resume',row.resume_id);
    const task=this.task(user,row.task_id);
    if(Number(task.canonical_version)!==Number(preview.task.canonical_version))conflict('RESUME_CONTEXT_CHANGED');
    live ||= this.store.lifecycle.live(user);
    const revisions=new Map((preview.console_source_revisions||[]).map(source=>[source.memory_id,source]));
    for(const source of preview.structured_memories||[]){
      const memory=this.db.prepare('SELECT status,project_id,content FROM memories WHERE user_id=? AND memory_id=?').get(user,source.memory_id);
      const pinned=revisions.get(source.memory_id),revision=memory&&pinned&&this.store.revisions.latest(user,source.memory_id);
      // Legacy previews did not pin a revision manifest, but their frozen body still cannot revive withdrawn text.
      if(!memory||memory.status!=='active'||!live.has(memory.project_id)||memory.content!==source.content
        ||pinned&&(revision?.revision!==pinned.revision||revision?.state_hash!==pinned.state_hash))conflict('RESUME_CONTEXT_CHANGED');
    }
    // Expired/retracted raw content must not be replayed from a frozen Console operation or a queued packet.
    for(const source of preview.recent_activity||[]){
      if(source.source_status!=='available')continue;
      const event=this.db.prepare('SELECT project_id,content,expires_at,expired_at FROM events WHERE user_id=? AND event_id=?').get(user,source.event_id);
      if(!event||!live.has(event.project_id)||event.expired_at
        ||event.expires_at&&Date.parse(event.expires_at)<=Date.now()
        ||fingerprint(event.content===null?null:parse(event.content))!==fingerprint(source.content))conflict('RESUME_CONTEXT_CHANGED');
    }
  }
  preview(auth,p){
    this.requireWrite(auth);object(p,['task_id','source_workstream_ids','target_event_id']);
    this.store.handoffPolicy.requireNew();
    return this.store.memoryTransaction(()=>{
      this.requireWrite(auth);
      this.task(auth.user_id,p.task_id);const target=this.target(auth.user_id,p.target_event_id);
      const preview=this.store.createPreview(auth,{query:p.task_id,signals:{task_id:p.task_id},
        ...(p.source_workstream_ids===undefined?{}:{source_workstream_ids:p.source_workstream_ids})});
      if(!preview.resume_id)conflict('RESUME_TASK_UNRESOLVED');
      preview.console_target={schema_version:TARGET_SCHEMA,...target};
      preview.console_source_revisions=(preview.structured_memories||[]).map(memory=>({memory_id:memory.memory_id,...this.store.revisions.latest(auth.user_id,memory.memory_id)}));
      bounded(preview,PREVIEW_BYTES);
      // Validate the actual review response too, including repeated title/source/target metadata. Any rejection
      // rolls back createPreview's Resume, authority binding and audit record with this surrounding transaction.
      const {row}=this.load(auth.user_id,preview.resume_id);
      bounded(this.metadata(auth,row,preview,{includePreview:true}),RESPONSE_BYTES-2*RECEIPT_BYTES-4*1024);
      this.db.prepare('UPDATE resumes SET preview_json=? WHERE user_id=? AND resume_id=?').run(JSON.stringify(preview),auth.user_id,preview.resume_id);
      // ConsoleState may replay this receipt. Context is intentionally fetched only through the guarded status view.
      return {resume_id:preview.resume_id,preview_version:preview.preview_version,status:'pending_confirmation',delivery_recorded:false};
    });
  }
  confirm(auth,p){
    this.requireWrite(auth);object(p,['resume_id','preview_version','confirmed']);number(p.preview_version,1,2147483647);
    if(typeof p.confirmed!=='boolean')throw new ValidationError('An explicit confirmation decision is required.','INVALID_CONSOLE_INPUT');
    this.store.handoffPolicy.requireNew();
    return this.store.memoryTransaction(()=>{
      this.requireWrite(auth);
      const {row,preview}=this.load(auth.user_id,p.resume_id);
      if(!this.binding(preview))conflict('RESUME_TARGET_REQUIRED');
      if(row.preview_version!==p.preview_version)conflict('RESUME_VERSION_CHANGED');
      if(p.confirmed){this.assertContext(auth.user_id,row,preview);this.assertTarget(auth.user_id,this.binding(preview));}
      const authorized={...auth,scopes:[...auth.scopes,'resume:confirm'],[CONFIRM_AUTHORITY]:{module:this,confirmed:p.confirmed}};
      const result=this.store.confirmPreview(authorized,p.resume_id,p.preview_version,p.confirmed);
      return {resume_id:p.resume_id,preview_version:p.preview_version,status:result.status==='confirmed'?'queued':result.status,delivery_recorded:false};
    });
  }
  // Called by Store.confirmPreview under its write transaction. Legacy Agent-created Resumes are unchanged.
  assertConfirmation(auth,resumeId){
    const row=this.db.prepare('SELECT preview_json FROM resumes WHERE user_id=? AND resume_id=?').get(auth.user_id,resumeId);
    if(!row||!this.binding(parse(row.preview_json)))return;
    if(auth[CONFIRM_AUTHORITY]?.module!==this)throw new AuthorizationError('console resume confirmation');
  }
  currentAgent(auth){
    if(!AGENTS.includes(auth.agent_id))throw new AuthorizationError('resume target Agent');
    for(const scope of REQUIRED_SCOPES)this.store.requireScope(auth,scope);
    const row=this.db.prepare('SELECT credential_id,device_id,agent_id,agent_instance_id,scopes_json,revoked_at,expires_at FROM credentials WHERE user_id=? AND credential_id=?').get(auth.user_id,auth.credential_id);
    if(!row||row.revoked_at||row.expires_at&&Date.parse(row.expires_at)<=Date.now()
      ||identityKeys.slice(0,4).some(key=>row[key]!==auth[key])||REQUIRED_SCOPES.some(scope=>!parse(row.scopes_json).includes(scope)))conflict('RESUME_TARGET_UNAVAILABLE');
  }
  // Called by both Store receipt methods inside their write transaction before recording any evidence.
  assertReceipt(auth,resumeId,payload,kind){
    const raw=this.db.prepare('SELECT preview_json FROM resumes WHERE user_id=? AND resume_id=?').get(auth.user_id,resumeId);
    if(!raw||!this.binding(parse(raw.preview_json)))return;
    this.currentAgent(auth);const {row,preview}=this.load(auth.user_id,resumeId),target=this.binding(preview);
    if(row.status!=='confirmed'||payload?.preview_version!==row.preview_version)conflict('RESUME_VERSION_CHANGED');
    if(identityKeys.slice(0,4).some(key=>auth[key]!==target[key])||payload?.session_id!==target.session_id||payload?.workstream_id!==target.workstream_id)conflict('RESUME_TARGET_MISMATCH');
    const initial=payload.phase===(kind==='injection'?'injected':'delivered');
    const [table,attemptKey]=kind==='injection'?['resume_injection_events','attempt_id']:['resume_delivery_receipts','receipt_id'];
    const alreadyRecorded=initial&&this.db.prepare(`SELECT 1 FROM ${table} WHERE user_id=? AND resume_id=? AND ${attemptKey}=? AND phase=?`)
      .get(auth.user_id,resumeId,payload[attemptKey],payload.phase);
    if(initial&&!alreadyRecorded){
      this.assertContext(auth.user_id,row,preview);this.assertTarget(auth.user_id,target);
      // The two supported receipt protocols must not authorize two concurrent deliveries of the same packet.
      const other=kind==='injection'?this.store.deliveryReceiptStatus(auth,resumeId):this.store.injectionStatus(auth,resumeId);
      if(other.ack_complete||other.status==='in_flight')conflict('RESUME_ALREADY_DELIVERED');
    }
    // Replaying an accepted initial event writes no new delivery. Store still checks the exact attempt's full
    // provenance, method and turn before returning its duplicate receipt; later source progress cannot undo it.
    // Terminal evidence keeps its original provenance checks in Store. A completed turn may be reported after
    // the session ended or its task changed; neither turns an actual completion into a fabricated new delivery.
  }
  delivery(auth,resumeId,{details=false}={}){
    const injection=this.store.injectionStatus(auth,resumeId),receipt=this.store.deliveryReceiptStatus(auth,resumeId);
    // Store's legacy status arrays are already windowed. Count all attempts separately so neither completion,
    // delivery evidence nor the disclosure of omitted attempts depends on that display window.
    const totals=this.db.prepare(`SELECT 'injection' protocol,COUNT(DISTINCT attempt_id) total,MAX(phase='injected') delivered
      FROM resume_injection_events WHERE user_id=? AND resume_id=?
      UNION ALL SELECT 'receipt' protocol,COUNT(DISTINCT receipt_id) total,MAX(phase='delivered') delivered
      FROM resume_delivery_receipts WHERE user_id=? AND resume_id=?`).all(auth.user_id,resumeId,auth.user_id,resumeId);
    const counts=Object.fromEntries(totals.map(row=>[row.protocol,row]));
    const completed=injection.ack_complete||receipt.ack_complete;
    const active=injection.status==='in_flight'||receipt.status==='in_flight';
    const delivered=completed||active||Boolean(counts.injection.delivered||counts.receipt.delivered);
    const status=completed?'completed':active?'delivered':[injection.status,receipt.status].includes('failed')?'failed':
      [injection.status,receipt.status].includes('acknowledged_unpaired')?'acknowledged_unpaired':'not_delivered';
    return {status,delivered,completed,
      injection:receiptWindow(injection,counts.injection.total,'attempts','latest_attempt',details),
      receipt:receiptWindow(receipt,counts.receipt.total,'receipts','latest_receipt',details)};
  }
  metadata(auth,row,preview,{includePreview=false,live=null}={}){
    const target=this.binding(preview),blockers=[];let currentTarget=target;
    try{this.assertContext(auth.user_id,row,preview,{live});}catch(error){if(!error.statusCode)throw error;blockers.push(error.errorCode);}
    if(target)try{currentTarget=this.assertTarget(auth.user_id,target);}catch(error){if(!error.statusCode)throw error;blockers.push(error.errorCode);}
    const enabled=this.store.handoffPolicy.enabled(),expired=row.status==='pending_confirmation'&&Date.parse(row.expires_at)<=Date.now();
    if(expired)blockers.push('RESUME_PREVIEW_EXPIRED');
    if(!enabled&&row.status==='pending_confirmation')blockers.push('HANDOFF_DISABLED');
    const delivery=this.delivery(auth,row.resume_id,{details:includePreview});
    const status=row.status==='pending_confirmation'?(expired?'expired':blockers.length?'blocked':'pending_confirmation'):
      row.status==='confirmed'?(delivery.status!=='not_delivered'?delivery.status:target?(blockers.length?'blocked':'queued'):'confirmed'):row.status;
    const safePreview={...preview};delete safePreview.console_target;delete safePreview.console_source_revisions;
    return {resume_id:row.resume_id,preview_version:row.preview_version,status,resume_status:row.status,origin:target?'console':'agent',
      task_id:row.task_id,task_title:preview.task.title,created_at:row.created_at,expires_at:row.expires_at,confirmed_at:row.confirmed_at,cancelled_at:row.cancelled_at,
      target:currentTarget?{...currentTarget,available:!blockers.includes('RESUME_TARGET_UNAVAILABLE')}:null,
      source_workstream_ids:preview.branch_selection?.selected_workstream_ids||[],blockers,
      can_confirm:!!target&&consoleWritable(auth)&&row.status==='pending_confirmation'&&!blockers.length&&enabled,
      can_cancel:!!target&&consoleWritable(auth)&&row.status==='pending_confirmation'&&!expired&&enabled,
      content_withheld:blockers.length>0,delivery,
      ...(includePreview?{preview:blockers.length?null:safePreview}:{}),read_only:true};
  }
  status(auth,p){
    this.requireRead(auth);object(p,resumeWorkflowParams['resume-status']);
    return this.store.memoryTransaction(()=>{this.requireRead(auth);const {row,preview}=this.load(auth.user_id,p.resume_id);return bounded(this.metadata(auth,row,preview,{includePreview:true}));});
  }
  history(auth,p){
    this.requireRead(auth);object(p,resumeWorkflowParams['resume-history']);const pg=page(p);
    return this.store.memoryTransaction(()=>{
    this.requireRead(auth);
    if(p.task_id)this.task(auth.user_id,p.task_id);
    const live=this.store.lifecycle.live(auth.user_id),task=live.sql('t.project_id'),snapshot=live.sql("json_extract(r.preview_json,'$.project.project_id')");
    const where=`r.user_id=? AND ${task.sql} AND ${snapshot.sql}${p.task_id?' AND r.task_id=?':''}`;
    const params=[auth.user_id,...task.params,...snapshot.params,...(p.task_id?[p.task_id]:[])];
    const from=`FROM resumes r JOIN tasks t ON t.user_id=r.user_id AND t.task_id=r.task_id WHERE ${where}`;
    const total=this.db.prepare(`SELECT COUNT(*) n ${from}`).get(...params).n;
    const rows=this.db.prepare(`SELECT r.* ${from} ORDER BY r.created_at DESC,r.resume_id DESC LIMIT ? OFFSET ?`).all(...params,pg.limit,pg.offset)
      .map(row=>this.metadata(auth,row,parse(row.preview_json),{live}));
    return boundedPage(rows,total,pg);
    });
  }
  read(auth,view,p={}){
    if(view==='resume-targets')return this.targets(auth,p);
    if(view==='resume-status')return this.status(auth,p);
    if(view==='resume-history')return this.history(auth,p);
    throw new NotFoundError('Resume view not found.');
  }
  apply(auth,action,p){
    if(action==='resume.preview')return this.preview(auth,p);
    if(action==='resume.confirm')return this.confirm(auth,p);
    throw new NotFoundError('Resume action not found.');
  }
  pending(auth,p){
    object(p,['session_id','workstream_id']);id(p.session_id);id(p.workstream_id);this.currentAgent(auth);
    return this.store.memoryTransaction(()=>{
    this.currentAgent(auth);
    const live=this.store.lifecycle.live(auth.user_id),task=live.sql('t.project_id'),snapshot=live.sql("json_extract(r.preview_json,'$.project.project_id')");
    const rows=this.db.prepare(`SELECT r.* FROM resumes r JOIN tasks t ON t.user_id=r.user_id AND t.task_id=r.task_id
      WHERE r.user_id=? AND r.status='confirmed' AND ${task.sql} AND ${snapshot.sql}
        AND t.canonical_version=json_extract(r.preview_json,'$.task.canonical_version')
        AND COALESCE((SELECT generation FROM lifecycle_authority_bindings b WHERE b.user_id=r.user_id AND b.kind='resume' AND b.record_id=r.resume_id),0)=?
        AND json_extract(r.preview_json,'$.console_target.schema_version')=?
        AND json_extract(r.preview_json,'$.console_target.credential_id')=?
        AND json_extract(r.preview_json,'$.console_target.session_id')=?
        AND json_extract(r.preview_json,'$.console_target.workstream_id')=?
        AND ${unconsumedSql('resume_injection_events','attempt_id','injected')}
        AND ${unconsumedSql('resume_delivery_receipts','receipt_id','delivered')}
      ORDER BY r.confirmed_at ASC,r.resume_id ASC`).iterate(auth.user_id,...task.params,...snapshot.params,live.generation,TARGET_SCHEMA,auth.credential_id,p.session_id,p.workstream_id);
    // Iterate the exact destination's authorizations, not a global pre-filter window. Stale or completed history
    // cannot consume its only result slot, and only one packet is ever returned. No receipt is written by this read.
    for(const row of rows){
      const preview=parse(row.preview_json),target=this.binding(preview);
      if(identityKeys.slice(0,4).some(key=>auth[key]!==target[key]))continue;
      const delivery=this.delivery(auth,row.resume_id);
      if(delivery.completed||delivery.status==='delivered'||delivery.status==='acknowledged_unpaired')continue;
      if(!this.store.handoffPolicy.enabled()){
        const drain=this.db.prepare('SELECT 1 FROM handoff_drain_resumes WHERE user_id=? AND resume_id=? AND preview_version=?').get(auth.user_id,row.resume_id,row.preview_version);
        if(!drain||delivery.status==='failed')continue;
      }
      try{this.assertContext(auth.user_id,row,preview,{live});this.assertTarget(auth.user_id,target);}catch(error){if(error.statusCode)continue;throw error;}
      return {status:'pending',resume_packet:parse(row.packet_json),target,delivery_recorded:false};
    }
    return {status:'empty',resume_packet:null,target:null,delivery_recorded:false};
    });
  }
}

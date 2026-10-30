import {createHash} from 'node:crypto';
import {object,id,number,fingerprint} from './state.mjs';
import {ConflictError,NotFoundError,ValidationError} from '../errors.mjs';
import {labeledStatements,conversationStatements} from '../memory/rules.mjs';
import {hash} from '../memory/revisions.mjs';
import {similarMemories} from '../memory/similar.mjs';
import {webMemorySql} from '../memory/web-visibility.mjs';
import {protectGroup} from '../lifecycle/protection.mjs';

export const REVIEW_PARAMS=Object.freeze({
  'review-candidates':['event_id','candidate_id','offset','limit','state'],
  'summary-quality':['summary_id','revision','offset','source_memory_id','source_offset'],
  'memory-review':['memory_id','revision','counterpart_id','content_offset','counterpart_offset'],
});
const types=['fact','goal','constraint','decision','completed','blocker','remaining','next_step'];
const invalid=()=>{throw new ValidationError('Invalid review input.','INVALID_CONSOLE_INPUT');};
const stale=()=>{throw new ConflictError('The source or reviewed version changed. Reload before deciding.','STALE_INPUT');};
const integer=(v,fallback=0,max=1000000)=>v===undefined?fallback:number(Number(v),0,max);
const iso=()=>new Date().toISOString();
const textPage=(text,offset=0,size=4096)=>{const points=[...text];if(offset>points.length)invalid();return {text:points.slice(offset,offset+size).join(''),offset,unit:'unicode_code_points',total:points.length,next_offset:offset+size<points.length?offset+size:null};};
const selectedText=event=>{let decoded;try{decoded=JSON.parse(event.content);}catch{return null;}
  if(typeof decoded==='string')return {text:decoded,selector:'$'};
  const field=['text','content','message','summary','output'].find(k=>typeof decoded?.[k]==='string');return field?{text:decoded[field],selector:'$.'+field}:null;};
const sameScope=(a,b)=>['scope','project_id','task_id','workstream_id','session_id'].every(k=>(a[k]||null)===(b[k]||null));
const eventVersion=(event,generation,pinned)=>fingerprint([event.content,event.event_type,event.project_id,event.task_id,event.workstream_id,event.session_id,event.captured_at,event.expires_at,!!pinned,generation]);

/** Review metadata is deliberately separate from memories. A preview never enqueues processing or changes capture. */
export class ConsoleMemoryReview {
  constructor(service){this.service=service;this.store=service.store;this.db=service.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_review_candidates (
      user_id TEXT NOT NULL,candidate_id TEXT NOT NULL,event_id TEXT NOT NULL,source_hash TEXT NOT NULL,
      selector TEXT NOT NULL,span_start INTEGER NOT NULL,span_end INTEGER NOT NULL,rule_version TEXT NOT NULL,
      memory_type TEXT NOT NULL,topic TEXT,state TEXT NOT NULL CHECK(state IN ('pending','accepted','dismissed')),
      revision INTEGER NOT NULL,saved_memory_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id,candidate_id));
      CREATE INDEX IF NOT EXISTS memory_review_candidates_owner ON memory_review_candidates(user_id,event_id,state);
      CREATE TABLE IF NOT EXISTS memory_summary_reviews (
      user_id TEXT NOT NULL,summary_id TEXT NOT NULL,summary_revision INTEGER NOT NULL,source_digest TEXT NOT NULL,
      decision TEXT NOT NULL,reviewed_at TEXT NOT NULL,PRIMARY KEY(user_id,summary_id,summary_revision,source_digest));
      CREATE TABLE IF NOT EXISTS memory_manual_reviews (
      user_id TEXT NOT NULL,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,source_version TEXT NOT NULL,
      decision TEXT NOT NULL,counterpart_id TEXT,counterpart_revision INTEGER,counterpart_source_version TEXT,last_verified_at TEXT,review_due_at TEXT,
      reviewed_at TEXT NOT NULL,PRIMARY KEY(user_id,memory_id));`);
    if(!this.db.prepare('PRAGMA table_info(memory_manual_reviews)').all().some(column=>column.name==='counterpart_source_version'))
      this.db.exec('ALTER TABLE memory_manual_reviews ADD COLUMN counterpart_source_version TEXT');
    protectGroup(this.db,'memory_review');
  }
  event(auth,eventId,expected){id(eventId);const event=this.db.prepare('SELECT * FROM events WHERE user_id=? AND event_id=?').get(auth.user_id,eventId);
    if(!event||!this.store.lifecycle.liveProject(auth.user_id,event.project_id))throw new NotFoundError('Source not found.');
    const pinned=!!this.db.prepare('SELECT 1 FROM memory_source_pins WHERE user_id=? AND event_id=?').get(auth.user_id,eventId);
    if(!['user_message','assistant_message'].includes(event.event_type)||!event.content||event.expired_at||!pinned&&event.expires_at&&Date.parse(event.expires_at)<=Date.now())stale();
    const selected=selectedText(event);if(!selected)stale();
    const source_hash=eventVersion(event,this.store.lifecycle.generation(auth.user_id),pinned);if(expected!==undefined&&expected!==source_hash)stale();
    return {event,...selected,source_hash,pinned};
  }
  candidate(auth,candidateId){id(candidateId);const row=this.db.prepare('SELECT * FROM memory_review_candidates WHERE user_id=? AND candidate_id=?').get(auth.user_id,candidateId);
    if(!row)throw new NotFoundError('Candidate not found.');const source=this.event(auth,row.event_id,row.source_hash);
    if(source.selector!==row.selector||row.span_start<0||row.span_end>source.text.length||row.span_end-row.span_start>4000)stale();
    return {row,source,content:source.text.slice(row.span_start,row.span_end)};
  }
  candidates(auth,p){const offset=integer(p.offset),limit=number(integer(p.limit,20,30),1,30),state=p.state??'pending';if(!['pending','accepted','dismissed','all'].includes(state))invalid();
    const live=this.store.lifecycle.live(auth.user_id).sql('e.project_id');
    const events=this.db.prepare(`SELECT e.event_id,e.event_type,e.project_id,e.task_id,e.workstream_id,e.session_id,e.captured_at,e.content,e.expires_at,
      EXISTS(SELECT 1 FROM memory_source_pins p WHERE p.user_id=e.user_id AND p.event_id=e.event_id) pinned FROM events e
      WHERE e.user_id=? AND ${live.sql} AND e.event_type IN ('user_message','assistant_message') AND e.content IS NOT NULL
      AND e.expired_at IS NULL AND (e.expires_at IS NULL OR e.expires_at>? OR EXISTS(SELECT 1 FROM memory_source_pins p WHERE p.user_id=e.user_id AND p.event_id=e.event_id)) ORDER BY e.received_at DESC,e.event_id LIMIT 30`)
      .all(auth.user_id,...live.params,iso()).filter(e=>selectedText(e)).map(e=>{const {content,...safe}=e;return {...safe,source_hash:eventVersion(e,this.store.lifecycle.generation(auth.user_id),e.pinned)};});
    if(p.event_id)this.event(auth,p.event_id);
    if(p.candidate_id)this.candidate(auth,p.candidate_id);
    const rows=this.db.prepare(`SELECT c.* FROM memory_review_candidates c JOIN events e ON e.user_id=c.user_id AND e.event_id=c.event_id
      WHERE c.user_id=? AND ${live.sql} ${p.event_id?'AND c.event_id=?':''} ${p.candidate_id?'AND c.candidate_id=?':''} ${state==='all'?'':'AND c.state=?'}
      ORDER BY c.created_at DESC,c.candidate_id LIMIT ? OFFSET ?`).all(auth.user_id,...live.params,...(p.event_id?[p.event_id]:[]),...(p.candidate_id?[p.candidate_id]:[]),...(state==='all'?[]:[state]),limit+1,offset);
    const candidates=[];let unavailable=0,consumed=0,bytes=Buffer.byteLength(JSON.stringify(events));
    for(const row of rows.slice(0,limit)){try{const c=this.candidate(auth,row.candidate_id),item={candidate_id:row.candidate_id,event_id:row.event_id,revision:row.revision,state:row.state,memory_type:row.memory_type,topic:row.topic,
      source_hash:row.source_hash,selector:row.selector,span_start:row.span_start,span_end:row.span_end,span_unit:'utf16_code_units',rule:row.rule_version,
      role:c.source.event.event_type,project_id:c.source.event.project_id,session_id:c.source.event.session_id,content:c.content, saved_memory_id:row.saved_memory_id,
      source_context:c.source.text.slice(Math.max(0,row.span_start-160),Math.min(c.source.text.length,row.span_end+160)),independently_verified:false};
      const size=Buffer.byteLength(JSON.stringify(item));if(bytes+size>180*1024)break;bytes+=size;candidates.push(item);
      }catch(e){if(!['STALE_INPUT','NOT_FOUND'].includes(e.errorCode))throw e;unavailable++;}consumed++;}
    return {read_only:true,events,events_limit:30,candidates,unavailable,offset,limit,next_offset:rows.length>consumed?offset+consumed:null,no_model_calls:true,capture_policy_changed:false};
  }
  summarySnapshot(auth,summaryId,revision){id(summaryId);const summary=this.db.prepare('SELECT * FROM memory_summaries WHERE user_id=? AND summary_id=?').get(auth.user_id,summaryId);
    if(!summary)throw new NotFoundError('Summary not found.');
    if(summary.status!=='current'||revision!==undefined&&Number(revision)!==summary.revision)throw new ConflictError('Summary changed.','SUMMARY_VERSION_CHANGED');
    const dependencies=this.db.prepare('SELECT * FROM memory_summary_dependencies WHERE user_id=? AND summary_id=? ORDER BY memory_id').all(auth.user_id,summaryId);
    if(!dependencies.length||dependencies.length>2000)throw new ConflictError('Summary source set is unavailable or too large for one review.','INPUT_TOO_LARGE');
    const sources=dependencies.map(d=>{const row=this.store.derivedMemory.validateItem(d);if(!row)stale();
      if(!this.db.prepare(`SELECT 1 FROM memories m WHERE m.user_id=? AND m.memory_id=? AND ${webMemorySql(auth)}`).get(auth.user_id,row.memory_id))throw new NotFoundError('Source not found.');
      return {...row,source_version:this.store.revisions.detail(auth.user_id,row.memory_id,{limit:0}).source_version};});
    const byId=new Map(sources.map(s=>[s.memory_id,s]));
    const claims=this.db.prepare('SELECT ordinal,claim_json FROM memory_summary_claims WHERE summary_id=? ORDER BY ordinal').all(summaryId).map(({ordinal,claim_json})=>{
      const claim=JSON.parse(claim_json),source=byId.get(claim.memory_id);
      if(!source||claim.revision!==source.revision||!Number.isSafeInteger(claim.start)||!Number.isSafeInteger(claim.end)||claim.start<0||claim.end<=claim.start||claim.end>source.content.length||source.content.slice(claim.start,claim.end)!==claim.quote)stale();
      return {...claim,ordinal};});
    const source_digest=fingerprint([summary.summary_id,summary.revision,this.store.lifecycle.generation(auth.user_id),sources.map(s=>[s.memory_id,s.revision,s.state_hash,s.source_version]),claims]);
    return {summary,sources,claims,source_digest};
  }
  summary(auth,p){const snapshot=this.summarySnapshot(auth,p.summary_id,p.revision),{summary,sources,claims,source_digest}=snapshot,offset=integer(p.offset);
    const source=p.source_memory_id?sources.find(s=>s.memory_id===p.source_memory_id):sources.find(s=>s.memory_id===claims[offset]?.memory_id)||sources[0];if(!source)throw new NotFoundError('Source not found.');
    const firstClaim=claims.slice(offset,offset+8).find(c=>c.memory_id===source.memory_id),sourceOffset=integer(p.source_offset,firstClaim?Math.max(0,[...source.content.slice(0,firstClaim.start)].length-120):0);
    const sourcePage=textPage(source.content,sourceOffset),pageStart=[...source.content].slice(0,sourceOffset).join('').length,pageEnd=pageStart+sourcePage.text.length;
    const highlights=claims.filter(c=>c.memory_id===source.memory_id&&c.end>pageStart&&c.start<pageEnd).map(c=>({start:[...source.content.slice(pageStart,Math.max(pageStart,c.start))].length,end:[...source.content.slice(pageStart,Math.min(pageEnd,c.end))].length}));
    const ranges=new Map();let excerptUnits=0;
    for(const c of claims){excerptUnits+=c.quote.length;const list=ranges.get(c.memory_id)||[];list.push([c.start,c.end]);ranges.set(c.memory_id,list);}
    let coveredUnits=0;for(const list of ranges.values()){list.sort((a,b)=>a[0]-b[0]);let end=-1;for(const [a,b] of list){coveredUnits+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}}
    const sourceUnits=sources.reduce((n,s)=>n+s.content.length,0),feedback=this.db.prepare('SELECT decision,reviewed_at FROM memory_summary_reviews WHERE user_id=? AND summary_id=? AND summary_revision=? AND source_digest=?').get(auth.user_id,summary.summary_id,summary.revision,source_digest);
    return {read_only:true,summary_id:summary.summary_id,revision:summary.revision,source_digest,
      metrics:{unit:'utf16_code_units',source_characters:sourceUnits,excerpt_characters:excerptUnits,covered_source_characters:coveredUnits,
        character_reduction_ratio:sourceUnits?1-excerptUnits/sourceUnits:null,unique_character_coverage:sourceUnits?coveredUnits/sourceUnits:null,
        selected_sources:sources.length,represented_sources:ranges.size,omitted_sources:sources.length-ranges.size,claims:claims.length,semantic_completeness_verified:false},
      sources:sources.slice(0,100).map(s=>({memory_id:s.memory_id,revision:s.revision,source_version:s.source_version,project_id:s.project_id,characters:s.content.length,represented:ranges.has(s.memory_id)})),sources_truncated:sources.length>100,
      source:{memory_id:source.memory_id,revision:source.revision,source_version:source.source_version,...sourcePage,highlight_ranges:highlights},
      claims:claims.slice(offset,offset+8).map(c=>{const full=sources.find(s=>s.memory_id===c.memory_id).content;const start=Math.max(0,c.start-120);return {...c,quote:c.quote.slice(0,1600),quote_truncated:c.quote.length>1600,
        exact_match:true,span_unit:'utf16_code_units',source_context:full.slice(start,Math.min(full.length,c.start+1600)),context_start:start,source_offset:Math.max(0,[...full.slice(0,c.start)].length-120)};}),
      offset,next_offset:offset+8<claims.length?offset+8:null,feedback:feedback||null,feedback_stale:!feedback&&!!this.db.prepare('SELECT 1 FROM memory_summary_reviews WHERE user_id=? AND summary_id=?').get(auth.user_id,summary.summary_id)};
  }
  sourceVersion(auth,row,current,provenance=this.store.revisions.detail(auth.user_id,row.memory_id,{limit:0})){
    return fingerprint([provenance.source_version,current.state_hash,row.scope,row.project_id,row.task_id,row.workstream_id,row.session_id,this.store.lifecycle.generation(auth.user_id)]);
  }
  reviewCurrent(auth,review,current,sourceVersion){
    if(!review||review.revision!==current.revision||review.source_version!==sourceVersion)return false;
    if(!review.counterpart_id)return true;
    if(!review.counterpart_source_version)return false; // Older one-sided judgments cannot certify both current sources.
    try{const counterpart=this.service.memory(auth,review.counterpart_id,review.counterpart_revision);
      return counterpart.row.status==='active'&&!!this.store.derivedMemory.currentSource(auth.user_id,counterpart.row.memory_id)
        &&this.sourceVersion(auth,counterpart.row,counterpart.current)===review.counterpart_source_version;
    }catch(error){if(['MEMORY_NOT_FOUND','MEMORY_VERSION_CHANGED','PROJECT_DELETED','NOT_FOUND'].includes(error.errorCode))return false;throw error;}
  }
  memorySource(auth,memoryId,revision,offset=0){const {row,current}=this.service.memory(auth,memoryId,revision);if(row.status!=='active'||!this.store.derivedMemory.currentSource(auth.user_id,row.memory_id))stale();
    const provenance=this.store.revisions.detail(auth.user_id,row.memory_id,{limit:20});
    const project=row.project_id?this.db.prepare('SELECT name FROM projects WHERE user_id=? AND project_id=?').get(auth.user_id,row.project_id):null;
    const review=this.db.prepare('SELECT * FROM memory_manual_reviews WHERE user_id=? AND memory_id=?').get(auth.user_id,row.memory_id),sourceVersion=this.sourceVersion(auth,row,current,provenance);
    return {row,current,view:{memory_id:row.memory_id,revision:current.revision,source_version:sourceVersion,scope:row.scope,project_id:row.project_id,project_name:project?.name||null,
      task_id:row.task_id,workstream_id:row.workstream_id,session_id:row.session_id,memory_type:row.memory_type,topic:row.topic,...textPage(row.content,offset),provenance,
      review:review?{decision:review.decision,last_verified_at:review.last_verified_at,review_due_at:review.review_due_at,reviewed_at:review.reviewed_at,
        counterpart_id:review.counterpart_id,counterpart_revision:review.counterpart_revision,current:this.reviewCurrent(auth,review,current,sourceVersion)}:null}};
  }
  async memory(auth,p){const left=this.memorySource(auth,p.memory_id,p.revision,integer(p.content_offset)),right=p.counterpart_id?this.memorySource(auth,p.counterpart_id,undefined,integer(p.counterpart_offset)):null;
    if(right?.row.memory_id===left.row.memory_id)invalid();
    // Reuse the existing similarity signal without an embedding call. It is only a review hint, never truth.
    const hints=await similarMemories(this.store,auth,left.row,{semantic:false});
    let conflicts=[];if(left.row.topic){const q=this.store.queryMemories(auth,{query:left.row.topic,limit:20});conflicts=(q.conflict_presentation?.potential_conflicts||[])
      .filter(c=>c.memory_ids.includes(left.row.memory_id)).map(c=>({classification:c.classification,memory_ids:c.memory_ids.slice(0,10),truncated:c.memory_ids.length>10}));}
    if(this.memorySource(auth,left.row.memory_id,left.current.revision).view.source_version!==left.view.source_version||right&&this.memorySource(auth,right.row.memory_id,right.current.revision).view.source_version!==right.view.source_version)stale();
    return {read_only:true,left:left.view,right:right?.view||null,hints,conflicts,same_scope:right?sameScope(left.row,right.row):null,no_model_calls:true};
  }
  async read(auth,view,p){this.store.requireScope(auth,'memory:read');object(p,REVIEW_PARAMS[view]||[]);
    if(view==='review-candidates')this.service.require(auth,'review.extract');
    const result=await (view==='review-candidates'?this.candidates(auth,p):view==='summary-quality'?this.summary(auth,p):this.memory(auth,p));
    if(Buffer.byteLength(JSON.stringify(result))>236*1024)throw new ConflictError('The bounded review response is too large.','INPUT_TOO_LARGE');return result;
  }
  binding(auth,memoryId){const {row,current}=this.service.memory(auth,memoryId),detail=this.store.revisions.detail(auth.user_id,memoryId,{limit:0});
    if(current.content_hash!==hash(row.content))stale();
    const sources=this.db.prepare(`SELECT e.content,e.expires_at,e.expired_at,s.content_hash,e.event_id FROM memory_source_links l JOIN memory_sources s
      ON s.user_id=l.user_id AND s.source_id=l.source_id LEFT JOIN events e ON e.user_id=s.user_id AND e.event_id=s.source_event_id
      WHERE l.user_id=? AND l.memory_id=? AND l.revision=? AND s.source_kind='captured_event'`).all(auth.user_id,memoryId,current.revision);
    if(sources.some(s=>!s.content||s.expired_at||hash(s.content)!==s.content_hash||s.expires_at&&Date.parse(s.expires_at)<=Date.now()&&!this.db.prepare('SELECT 1 FROM memory_source_pins WHERE user_id=? AND event_id=?').get(auth.user_id,s.event_id)))stale();
    return {memory_id:memoryId,revision:current.revision,state_hash:current.state_hash,source_version:detail.source_version,scope_digest:fingerprint([row.scope,row.project_id,row.task_id,row.workstream_id,row.session_id,row.status]),lifecycle_generation:this.store.lifecycle.generation(auth.user_id)};
  }
  validateReceipt(auth,receipt){if(receipt.candidate_id)this.candidate(auth,receipt.candidate_id);
    for(const expected of receipt.review_bindings||[])if(fingerprint(expected)!==fingerprint(this.binding(auth,expected.memory_id)))stale();}
  execute(auth,action,p,operation){return this.store.memoryTransaction(()=>{
    const existing=this.service.state.existing(auth.user_id,operation,action,p);
    if(existing){
      if(existing.memory_id)this.service.memory(auth,existing.memory_id);
      if(action==='review.extract')this.event(auth,p.event_id,p.source_hash);
      if(action==='review.candidate')this.candidate(auth,p.candidate_id);
      if(action==='review.summary'){const s=this.summarySnapshot(auth,p.summary_id,p.revision);if(s.source_digest!==p.source_digest)stale();}
      this.validateReceipt(auth,existing);
      return existing;
    }
    return this.service.state.sync(auth,action,p,operation,()=>{
      if(this.service.owner.user&&!this.service.owner.allowed('memory')&&['review.candidate','review.resolve'].includes(action))throw new ConflictError('Memory is disabled.','MEMORY_DISABLED');
      const result=this.apply(auth,action,p),ids=[result.memory_id,...(action==='review.resolve'?[p.memory_id,p.counterpart_id]:[])].filter(Boolean);
      return {...result,...(ids.length?{review_bindings:[...new Set(ids)].map(memoryId=>this.binding(auth,memoryId))}:{})};
    });
  });}
  apply(auth,action,p){
    if(action==='review.extract'){
      object(p,['event_id','source_hash']);const source=this.event(auth,p.event_id,p.source_hash);if(typeof p.source_hash!=='string')invalid();
      if(source.text.length>128*1024)throw new ValidationError('Event is too large for a bounded review preview.','INPUT_TOO_LARGE');
      // The source gate has already checked the owner's live pin and retained body. Rules see an isolated input;
      // do not mutate event retention to preview a still-readable pinned source past its ordinary expiry.
      const ruleEvent=source.pinned?{...source.event,expires_at:null}:source.event;
      const labeled=labeledStatements([ruleEvent]),conversation=conversationStatements([ruleEvent],{enabled:true,user_ids:[auth.user_id],after:'1970-01-01T00:00:00.000Z'},auth.user_id)
        .filter(c=>!labeled.some(l=>c.start<l.end&&c.end>l.start));
      const all=[...labeled,...conversation].filter(c=>c.content.length<=4000),seen=new Set();let created=0;const selected=all.filter(c=>{const k=[c.start,c.end].join(':');if(seen.has(k))return false;seen.add(k);return true;}).slice(0,30);
      for(const c of selected){const candidateId=createHash('sha256').update(JSON.stringify([auth.user_id,source.event.event_id,source.source_hash,c.selector,c.start,c.end,c.version])).digest('hex');
        created+=this.db.prepare("INSERT OR IGNORE INTO memory_review_candidates VALUES(?,?,?,?,?,?,?,?,?,?,'pending',1,NULL,?,?)")
          .run(auth.user_id,candidateId,source.event.event_id,source.source_hash,c.selector,c.start,c.end,c.version,c.memory_type,c.topic,iso(),iso()).changes;}
      return {status:'previewed',event_id:p.event_id,created,total:selected.length,truncated:seen.size>30,no_model_calls:true,capture_policy_changed:false};
    }
    if(action==='review.candidate'){
      object(p,['candidate_id','revision','decision','content','memory_type','topic','confirmed']);const {row,source,content}=this.candidate(auth,p.candidate_id);
      if(p.revision!==row.revision)stale();if(row.state!=='pending')throw new ConflictError('Candidate already reviewed.','PREVIEW_CHANGED');
      if(!['accept','dismiss'].includes(p.decision))invalid();let saved=null;
      if(p.decision==='accept'){
        if(p.confirmed!==true)throw new ConflictError('Explicit confirmation is required.','CONFIRMATION_MISMATCH');
        const value=p.content===undefined?content:p.content;if(typeof value!=='string'||!value.trim()||value.length>4000||!types.includes(p.memory_type??row.memory_type))invalid();
        const event=source.event,scope=event.workstream_id?'workstream':event.task_id?'task':event.project_id?'project':'session';
        const result=this.store.saveMemory(auth,{content:value,memory_type:p.memory_type??row.memory_type,topic:p.topic===undefined?row.topic:p.topic,scope,
          project_id:event.project_id||undefined,task_id:event.task_id||undefined,workstream_id:event.workstream_id||undefined,session_id:event.session_id,source:'console_reviewed_candidate'});
        saved=result.memory.memory_id;
        this.db.prepare('UPDATE memories SET source_event_ids_json=? WHERE user_id=? AND memory_id=?').run(JSON.stringify([row.event_id]),auth.user_id,saved);
        const memory=this.db.prepare('SELECT * FROM memories WHERE user_id=? AND memory_id=?').get(auth.user_id,saved),revision=this.store.revisions.latest(auth.user_id,saved).revision;
        // Keep the exact original extraction range even after a human edits the saved assertion; provenance describes
        // a source excerpt, not an assertion that the edited memory is a verbatim quote.
        this.store.revisions.linkEvent(memory,revision,row.event_id,{start:row.span_start,end:row.span_end,selector:row.selector,version:row.rule_version+'+human-reviewed'});
      }else if(['content','memory_type','topic','confirmed'].some(k=>Object.hasOwn(p,k)))invalid();
      this.db.prepare('UPDATE memory_review_candidates SET state=?,revision=revision+1,saved_memory_id=?,updated_at=? WHERE user_id=? AND candidate_id=? AND revision=?')
        .run(saved?'accepted':'dismissed',saved,iso(),auth.user_id,row.candidate_id,row.revision);
      return {status:saved?'accepted':'dismissed',candidate_id:row.candidate_id,...(saved?{memory_id:saved}:{}),revision:row.revision+1};
    }
    if(action==='review.summary'){
      object(p,['summary_id','revision','source_digest','decision']);number(p.revision,1,2147483647);const s=this.summarySnapshot(auth,p.summary_id,p.revision);
      if(p.source_digest!==s.source_digest)stale();if(!['accurate','missing_context','misleading','needs_review'].includes(p.decision))invalid();
      this.db.prepare('INSERT INTO memory_summary_reviews VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,summary_id,summary_revision,source_digest) DO UPDATE SET decision=excluded.decision,reviewed_at=excluded.reviewed_at')
        .run(auth.user_id,p.summary_id,s.summary.revision,s.source_digest,p.decision,iso());return {status:'reviewed',summary_id:p.summary_id,revision:s.summary.revision,decision:p.decision};
    }
    if(action==='review.verify'){
      object(p,['memory_id','revision','source_version','review_due_at']);number(p.revision,1,2147483647);const left=this.memorySource(auth,p.memory_id,p.revision);
      if(p.source_version!==left.view.source_version)stale();const due=this.due(p.review_due_at);this.record(auth,left,'verified',null,due,true);
      return {status:'verified',memory_id:p.memory_id,last_verified_at:iso(),review_due_at:due};
    }
    if(action==='review.resolve'){
      object(p,['memory_id','revision','source_version','counterpart_id','counterpart_revision','counterpart_source_version','decision','confirmed']);
      number(p.revision,1,2147483647);number(p.counterpart_revision,1,2147483647);
      const left=this.memorySource(auth,p.memory_id,p.revision),right=this.memorySource(auth,p.counterpart_id,p.counterpart_revision);
      if(left.row.memory_id===right.row.memory_id||p.source_version!==left.view.source_version||p.counterpart_source_version!==right.view.source_version)stale();
      if(!['keep_both','replace','retract_duplicate','undecided'].includes(p.decision))invalid();
      let replacement=null;
      if(['replace','retract_duplicate'].includes(p.decision)){
        if(p.confirmed!==true)throw new ConflictError('Explicit confirmation is required.','CONFIRMATION_MISMATCH');
        if(!sameScope(left.row,right.row))throw new ConflictError('Destructive reconciliation requires the same exact scope.','RECONCILIATION_CONFLICT');
        if(p.decision==='replace'){
          // The established supersede API preserves history and privacy. The right hand reference is retained;
          // the receipt explicitly identifies the new replacement instead of pretending the two IDs were merged.
          replacement=this.store.supersedeMemory(auth,left.row.memory_id,{content:right.row.content,memory_type:right.row.memory_type,topic:right.row.topic,...this.store.traits.get(auth.user_id,right.row.memory_id),reason:'Explicit review: replacement based on '+right.row.memory_id}).replacement_memory.memory_id;
          this.store.webVisibility.inheritPrivate(auth.user_id,right.row.memory_id,replacement);
        }else this.store.retractMemory(auth,left.row.memory_id,{reason:'Explicit review: duplicate of '+right.row.memory_id});
      }
      this.record(auth,left,p.decision,right,null,false);this.record(auth,right,p.decision,left,null,false);
      return {status:'reviewed',decision:p.decision,memory_id:replacement||left.row.memory_id,counterpart_id:right.row.memory_id,reference_retained:true,physically_deleted:false};
    }
    invalid();
  }
  due(value){if(value===undefined||value===null||value==='')return null;if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||Date.parse(value)<=Date.now()||Date.parse(value)>Date.now()+366*86400000)invalid();return new Date(value).toISOString();}
  record(auth,left,decision,right,due,verified){const at=iso();this.db.prepare(`INSERT INTO memory_manual_reviews
    (user_id,memory_id,revision,source_version,decision,counterpart_id,counterpart_revision,counterpart_source_version,last_verified_at,review_due_at,reviewed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,memory_id) DO UPDATE SET revision=excluded.revision,source_version=excluded.source_version,decision=excluded.decision,
    counterpart_id=excluded.counterpart_id,counterpart_revision=excluded.counterpart_revision,counterpart_source_version=excluded.counterpart_source_version,last_verified_at=excluded.last_verified_at,review_due_at=excluded.review_due_at,reviewed_at=excluded.reviewed_at`)
    .run(auth.user_id,left.row.memory_id,left.current.revision,left.view.source_version,decision,right?.row.memory_id||null,right?.current.revision||null,right?.view.source_version||null,verified?at:null,due,at);}
}

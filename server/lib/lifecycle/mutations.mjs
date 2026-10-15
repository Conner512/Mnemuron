// Project lifecycle mutations (phase 5E): recoverable delete, restore and canonical merge, each as preview → confirm.
// Reachable only through the full-write Console actions projects.lifecycle_preview / projects.lifecycle_delete /
// projects.lifecycle_restore / projects.merge; the BFF requires a fresh password + OTP for every confirm (5F) and
// strips those factors before Core. Nothing here purges, rewrites or reparents any record: the only writes are the
// lifecycle row, the owner generation bump, append-only lifecycle history, the preview state and (on restore) the
// rescheduling of jobs that went stale while the project was deleted.
import {createHash,randomUUID} from 'node:crypto';
import {ConflictError,NotFoundError,ValidationError} from '../errors.mjs';
import {MAX_SOURCE_MEMBERS,MAX_CHAIN_DEPTH} from './resolver.mjs';
import {ownerEpoch,globalEpoch} from './protection.mjs';

export const PREVIEW_TTL_MS = 10 * 60 * 1000;
// Bounds of what a preview displays; the fingerprint always covers the complete server-side impact.
export const DISPLAY_LIMIT = 20;
const ACTIONS = ['delete','restore','merge'];
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exists = (db,name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const object = (value,keys) => {if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new ValidationError('Invalid lifecycle request.','INVALID_CONSOLE_INPUT');};
const norm = value => String(value??'').trim().normalize('NFKC').toLowerCase();

export class ProjectLifecycleMutations {
  constructor(store){this.store=store;this.db=store.db;this.clock=()=>Date.now();}
  get lifecycle(){return this.store.lifecycle;}

  /** Validates the request against current state and returns {project, target, members, sources, targetMembers}.
   * Owner first: an unknown or foreign ID is the generic PROJECT_NOT_FOUND. */
  subject(user,action,p){
    const L=this.lifecycle,resolved=L.resolve(user,p.project_id);
    if(resolved.routed)throw new ConflictError('This project was merged into another project. Act on that project.','PROJECT_NOT_CANONICAL');
    if(action==='restore'){
      if(resolved.effective_state!=='deleted')throw new ConflictError('This project is not deleted.','PROJECT_NOT_DELETED');
      return {project:p.project_id,members:this.membersOf(user,p.project_id)};
    }
    if(resolved.effective_state==='deleted')throw new ConflictError('This project was deleted.','PROJECT_DELETED');
    if(action==='delete')return {project:p.project_id,members:L.members(user,p.project_id).map(m=>m.project_id)};
    // Merge: same owner (both resolve for this owner), distinct, both canonical and active.
    if(typeof p.target_project_id!=='string')throw new ValidationError('Choose a target project.','INVALID_CONSOLE_INPUT');
    const target=L.resolve(user,p.target_project_id);
    if(target.routed)throw new ConflictError('The target was merged into another project.','PROJECT_NOT_CANONICAL');
    if(target.effective_state==='deleted')throw new ConflictError('The target project was deleted.','PROJECT_DELETED');
    if(p.target_project_id===p.project_id)throw new ConflictError('A project cannot be merged into itself.','PROJECT_MERGE_CONFLICT');
    const sources=L.members(user,p.project_id).map(m=>m.project_id),targetMembers=L.members(user,p.target_project_id).map(m=>m.project_id);
    // Defensive cycle check: the target's chain must not pass through the source group.
    if(target.chain.some(id=>sources.includes(id)))throw new ConflictError('This merge would create a cycle.','PROJECT_MERGE_CONFLICT');
    if(targetMembers.length-1+sources.length>MAX_SOURCE_MEMBERS)throw new ConflictError(`At most ${MAX_SOURCE_MEMBERS} merged projects per project.`,'PROJECT_MEMBER_LIMIT');
    const depth=Math.max(...sources.map(id=>this.depthTo(user,id,p.project_id)));
    if(depth+1>MAX_CHAIN_DEPTH)throw new ConflictError('The merge chain would be too deep.','PROJECT_MEMBER_LIMIT');
    return {project:p.project_id,target:p.target_project_id,members:[...targetMembers,...sources],sources,targetMembers};
  }
  // Members of a deleted canonical project (members() itself works on any canonical project, deleted included).
  membersOf(user,id){return this.lifecycle.members(user,id).map(m=>m.project_id);}
  depthTo(user,from,to){let depth=0,current=from;while(current!==to){current=this.lifecycle.row(user,current).merged_into;if(++depth>MAX_CHAIN_DEPTH+1)break;}return depth;}

  /** The complete, deterministic server-side impact of the request (every member, every count, every conflict). */
  impact(user,action,subject){
    const db=this.db,list=JSON.stringify(subject.members);
    const count=(sql,...params)=>db.prepare(sql).get(...params).n;
    const archived=id=>exists(db,'console_project_state')?!!db.prepare('SELECT archived_at FROM console_project_state WHERE user_id=? AND project_id=?').get(user,id)?.archived_at:false;
    const memberFacts=subject.members.slice().sort().map(id=>{
      const row=db.prepare('SELECT name,aliases_json,updated_at FROM projects WHERE user_id=? AND project_id=?').get(user,id),life=this.lifecycle.row(user,id);
      return {project_id:id,name:row.name,aliases:JSON.parse(row.aliases_json||'[]'),updated_at:row.updated_at,state:life?.state??'active',lifecycle_revision:life?.lifecycle_revision??0,archived:archived(id),
        tasks:count('SELECT COUNT(*) n FROM tasks WHERE user_id=? AND project_id=?',user,id),
        memories:count('SELECT COUNT(*) n FROM memories WHERE user_id=? AND project_id=?',user,id),
        active_memories:count("SELECT COUNT(*) n FROM memories WHERE user_id=? AND project_id=? AND status='active'",user,id),
        revisions:count('SELECT COUNT(*) n FROM memory_revisions r JOIN memories m ON m.user_id=r.user_id AND m.memory_id=r.memory_id WHERE m.user_id=? AND m.project_id=?',user,id),
        checkpoints:count('SELECT COUNT(*) n FROM checkpoints WHERE user_id=? AND project_id=?',user,id),
        events:count('SELECT COUNT(*) n FROM events WHERE user_id=? AND project_id=?',user,id)};
    });
    const ids=`(SELECT memory_id FROM memories WHERE user_id=? AND project_id IN (SELECT value FROM json_each(?)))`;
    const totals={
      ...this.store.entities.impact(user,subject.members),
      summaries:count(`SELECT COUNT(DISTINCT summary_id) n FROM memory_summary_dependencies WHERE user_id=? AND memory_id IN ${ids}`,user,user,list),
      // Memories with an indexed vector document in any generation (each memory counted once).
      vector_indexed_memories:exists(db,'memory_vector_documents')?count(`SELECT COUNT(DISTINCT memory_id) n FROM memory_vector_documents WHERE user_id=? AND state='indexed' AND memory_id IN ${ids}`,user,user,list):0,
      pending_bootstrap_previews:count("SELECT COUNT(*) n FROM task_bootstrap_previews WHERE user_id=? AND status='pending_confirmation' AND project_id IN (SELECT value FROM json_each(?))",user,list),
      pending_resume_previews:count("SELECT COUNT(*) n FROM resumes r JOIN tasks t ON t.user_id=r.user_id AND t.task_id=r.task_id WHERE r.user_id=? AND r.status='pending_confirmation' AND t.project_id IN (SELECT value FROM json_each(?))",user,list),
      pending_reconciliation_proposals:count("SELECT COUNT(*) n FROM task_reconciliation_proposals WHERE user_id=? AND status='awaiting_confirmation' AND project_id IN (SELECT value FROM json_each(?))",user,list),
      queued_jobs:count(`SELECT COUNT(DISTINCT j.job_id) n FROM memory_jobs j JOIN memory_job_items i ON i.job_id=j.job_id WHERE j.user_id=? AND j.state IN ('pending','retry_wait','leased','stale') AND i.memory_id IN ${ids}`,user,user,list),
    };
    const conflicts=action==='merge'?this.conflicts(user,subject):[];
    return {schema:'project-lifecycle-impact-v1',action,project_id:subject.project,target_project_id:subject.target??null,members:memberFacts,totals,conflicts};
  }
  /** Same-title Tasks and name/alias collisions between the source group and the target group. Never resolved
   * automatically: same-named Tasks stay distinct, nothing is renamed. */
  conflicts(user,subject){
    const titles=ids=>this.db.prepare('SELECT task_id,title,project_id FROM tasks WHERE user_id=? AND project_id IN (SELECT value FROM json_each(?)) ORDER BY task_id').all(user,JSON.stringify(ids));
    const out=[],targetTitles=new Map();
    for(const t of titles(subject.targetMembers)){const key=norm(t.title);if(!targetTitles.has(key))targetTitles.set(key,[]);targetTitles.get(key).push(t.task_id);}
    for(const t of titles(subject.sources)){const match=targetTitles.get(norm(t.title));if(match)out.push({kind:'same_task_title',title:t.title,source_task_id:t.task_id,target_task_ids:match});}
    const names=ids=>ids.flatMap(id=>{const r=this.db.prepare('SELECT name,aliases_json FROM projects WHERE user_id=? AND project_id=?').get(user,id);return [r.name,...JSON.parse(r.aliases_json||'[]')].map(v=>({project_id:id,value:v}));});
    const targetNames=new Map(names(subject.targetMembers).map(n=>[norm(n.value),n]));
    for(const n of names(subject.sources)){const hit=targetNames.get(norm(n.value));if(hit)out.push({kind:'name_or_alias_collision',value:n.value,source_project_id:n.project_id,target_project_id:hit.project_id});}
    return out.sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:1);
  }
  binding(user){return {generation:this.lifecycle.generation(user),owner_epoch:ownerEpoch(this.db,user),global_epoch:globalEpoch(this.db)};}
  display(impact){
    const members=impact.members.slice(0,DISPLAY_LIMIT),conflicts=impact.conflicts.slice(0,DISPLAY_LIMIT);
    const sum=key=>impact.members.reduce((n,m)=>n+m[key],0);
    return {members,members_total:impact.members.length,members_truncated:impact.members.length>members.length,
      conflicts,conflicts_total:impact.conflicts.length,conflicts_truncated:impact.conflicts.length>conflicts.length,
      totals:{tasks:sum('tasks'),memories:sum('memories'),active_memories:sum('active_memories'),revisions:sum('revisions'),checkpoints:sum('checkpoints'),events:sum('events'),...impact.totals}};
  }

  /** projects.lifecycle_preview: validates, computes the full impact and stores a pending preview bound to it. */
  preview(auth,p){
    object(p,['action','project_id','target_project_id']);
    if(!ACTIONS.includes(p.action)||(p.action==='merge')!==(p.target_project_id!==undefined))throw new ValidationError('Invalid lifecycle request.','INVALID_CONSOLE_INPUT');
    const user=auth.user_id,subject=this.subject(user,p.action,p),impact=this.impact(user,p.action,subject),bound=this.binding(user);
    const id=randomUUID(),now=this.clock(),row=this.db.prepare('SELECT name FROM projects WHERE user_id=? AND project_id=?').get(user,p.project_id);
    this.db.prepare("INSERT INTO project_lifecycle_previews VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)").run(id,user,p.action,p.project_id,p.target_project_id??null,
      sha([p.action,p.project_id,p.target_project_id??null]),sha(impact),JSON.stringify(this.display(impact)),bound.generation,bound.global_epoch,bound.owner_epoch,new Date(now).toISOString(),new Date(now+PREVIEW_TTL_MS).toISOString());
    // Bounded storage: the row keeps the impact hash and the bounded display only; previews that expired more than a day
    // ago are removed for this owner.
    this.db.prepare('DELETE FROM project_lifecycle_previews WHERE user_id=? AND expires_at<?').run(user,new Date(now-86400000).toISOString());
    return {status:'previewed',preview_id:id,action:p.action,project_id:p.project_id,project_name:row.name,target_project_id:p.target_project_id??null,
      expires_at:new Date(now+PREVIEW_TTL_MS).toISOString(),requires_typed_name:p.action==='delete',requires_reauthentication:true,merge_undo_available:false,
      retention:'All records are kept; account-wide retention rules are unchanged. Nothing is purged.',impact:this.display(impact)};
  }

  /** Read-only: would this preview confirm now? The BFF asks before re-authenticating, so a stale preview does not
   * consume the owner's password + OTP attempt. The confirm itself still rechecks everything in its transaction. */
  check(auth,p){
    object(p,['preview_id','action','confirm_name','operation_id']);const user=auth.user_id;
    if(typeof p.preview_id!=='string'||!/^[0-9a-f-]{36}$/.test(p.preview_id)||!ACTIONS.includes(p.action))throw new ValidationError('Preview the change first.','PREVIEW_REQUIRED');
    const preview=this.db.prepare('SELECT * FROM project_lifecycle_previews WHERE preview_id=? AND user_id=?').get(p.preview_id,user);
    if(!preview||preview.action!==p.action)throw new NotFoundError('Preview not found.','PREVIEW_REQUIRED');
    // A confirmed preview: a retry of the same confirm (same operation ID) is replayed by Core with its stored result, so it
    // is let through; any other attempt on it is refused there (PREVIEW_CHANGED).
    if(preview.state==='confirmed'){
      // Only the very operation that confirmed it (recorded in the append-only lifecycle history) may pass to be replayed.
      const same=typeof p.operation_id==='string'&&!!this.db.prepare("SELECT 1 FROM project_lifecycle_events WHERE user_id=? AND operation_id=? AND action=? AND json_extract(before_json,'$.preview_id')=?")
        .get(user,p.operation_id,`project.${p.action}`,preview.preview_id);
      return same?{read_only:true,current:true,replay:true}:{read_only:true,current:false,error_code:'PREVIEW_CHANGED'};
    }
    if(preview.state!=='pending')return {read_only:true,current:false,error_code:'PREVIEW_CHANGED'};
    if(Date.parse(preview.expires_at)<=this.clock())return {read_only:true,current:false,error_code:'PREVIEW_EXPIRED'};
    const request={action:p.action,project_id:preview.project_id,...(preview.target_project_id?{target_project_id:preview.target_project_id}:{})};
    try{const impact=this.impact(user,p.action,this.subject(user,p.action,request)),bound=this.binding(user);
      const current=sha(impact)===preview.impact_sha256&&bound.generation===preview.generation&&bound.owner_epoch===preview.owner_epoch&&bound.global_epoch===preview.global_epoch;
      if(!current)return {read_only:true,current:false,error_code:'PREVIEW_CHANGED'};
      // A delete's typed name is checked here too, so a typo never consumes the factors.
      if(p.action==='delete'&&p.confirm_name!==undefined&&p.confirm_name!==this.db.prepare('SELECT name FROM projects WHERE user_id=? AND project_id=?').get(user,preview.project_id).name)
        return {read_only:true,current:false,error_code:'CONFIRMATION_MISMATCH'};
      return {read_only:true,current:true};}
    catch(error){if(['PROJECT_LIFECYCLE_CORRUPT','PROJECT_NOT_FOUND'].includes(error.errorCode))throw error;return {read_only:true,current:false,error_code:'PREVIEW_CHANGED'};}
  }

  /** A confirm: the preview must be this owner's, pending, unexpired and for this action; every validation and the full
   * impact, generation and epochs are recomputed inside this transaction (PREVIEW_CHANGED on any difference). */
  confirm(auth,action,p,operationId){
    object(p,action==='delete'?['preview_id','confirm_name']:['preview_id']);
    if(typeof p.preview_id!=='string'||!/^[0-9a-f-]{36}$/.test(p.preview_id))throw new ValidationError('Preview the change first.','PREVIEW_REQUIRED');
    const user=auth.user_id;
    return this.lifecycle.operation(user,operationId,`lifecycle.${action}`,p,()=>{
      const preview=this.db.prepare('SELECT * FROM project_lifecycle_previews WHERE preview_id=? AND user_id=?').get(p.preview_id,user);
      if(!preview||preview.action!==action)throw new NotFoundError('Preview not found.','PREVIEW_REQUIRED');
      if(preview.state!=='pending')throw new ConflictError('This preview is no longer current. Preview again.','PREVIEW_CHANGED');
      if(Date.parse(preview.expires_at)<=this.clock())throw new ConflictError('This preview expired. Preview again.','PREVIEW_EXPIRED');
      const request={action,project_id:preview.project_id,...(preview.target_project_id?{target_project_id:preview.target_project_id}:{})};
      let subject,impact;
      try{subject=this.subject(user,action,request);impact=this.impact(user,action,subject);}
      catch(error){if(['PROJECT_LIFECYCLE_CORRUPT','PROJECT_NOT_FOUND'].includes(error.errorCode))throw error;throw new ConflictError('The project changed since the preview. Preview again.','PREVIEW_CHANGED');}
      const bound=this.binding(user);
      if(sha(impact)!==preview.impact_sha256||bound.generation!==preview.generation||bound.owner_epoch!==preview.owner_epoch||bound.global_epoch!==preview.global_epoch)
        throw new ConflictError('The project changed since the preview. Preview again.','PREVIEW_CHANGED');
      const project=this.db.prepare('SELECT name FROM projects WHERE user_id=? AND project_id=?').get(user,preview.project_id);
      if(action==='delete'&&(typeof p.confirm_name!=='string'||p.confirm_name!==project.name))throw new ConflictError('Type the project name exactly to confirm.','CONFIRMATION_MISMATCH');
      const before=this.lifecycle.row(user,preview.project_id)??null,now=new Date(this.clock()).toISOString(),revision=(before?.lifecycle_revision??0)+1;
      const state=action==='delete'?'deleted':action==='restore'?'active':'merged';
      this.db.prepare('INSERT OR REPLACE INTO project_lifecycle VALUES (?,?,?,?,?,?)').run(user,preview.project_id,state,action==='merge'?preview.target_project_id:null,revision,now);
      const generation=this.lifecycle.bumpGeneration(user);
      const rescheduled=action==='restore'?this.reschedule(user,subject.members):0;
      const entityIntents=action==='restore'?this.store.entities.restoreIntents(user,subject.members):0;
      const eventId=randomUUID(),after={state,merged_into:action==='merge'?preview.target_project_id:null,lifecycle_revision:revision,generation};
      this.db.prepare('INSERT INTO project_lifecycle_events VALUES (?,?,?,?,?,?,?,?)').run(eventId,user,operationId,preview.project_id,`project.${action}`,
        JSON.stringify({row:before&&{state:before.state,merged_into:before.merged_into,lifecycle_revision:before.lifecycle_revision},impact_sha256:preview.impact_sha256,preview_id:preview.preview_id}),
        JSON.stringify({...after,totals:this.display(impact).totals,rescheduled_jobs:rescheduled,rescheduled_entity_intents:entityIntents}),now);
      this.db.prepare("UPDATE project_lifecycle_previews SET state='confirmed' WHERE preview_id=?").run(preview.preview_id);
      // Every other pending preview of this owner is superseded (its generation is stale anyway).
      this.db.prepare("UPDATE project_lifecycle_previews SET state='superseded' WHERE user_id=? AND state='pending'").run(user);
      this.store.audit({auth,action:`project.lifecycle.${action}`,targetType:'project',targetId:preview.project_id,metadata:{target_project_id:preview.target_project_id,generation,lifecycle_event_id:eventId}});
      return {status:action==='delete'?'deleted':action==='restore'?'restored':'merged',project_id:preview.project_id,target_project_id:preview.target_project_id,
        generation,lifecycle_event_id:eventId,members:subject.members.length,rescheduled_jobs:rescheduled,rescheduled_entity_intents:entityIntents,records_purged:0,merge_undo_available:false};
    });
  }
  /** On restore: jobs that went stale while the project was deleted are deduplicated by input fingerprint, so a new
   * schedule would return them and never rerun them. A stale job whose every item validates again is put back to
   * pending (fence advanced, so no earlier lease can act on it). Jobs with any still-invalid item stay stale. */
  reschedule(user,members){
    const list=JSON.stringify(members),jobs=this.db.prepare(`SELECT DISTINCT j.job_id FROM memory_jobs j JOIN memory_job_items i ON i.job_id=j.job_id
      JOIN memories m ON m.user_id=i.user_id AND m.memory_id=i.memory_id WHERE j.user_id=? AND j.job_type<>'entities' AND j.state='stale' AND j.last_error_code='STALE_INPUT'
      AND m.project_id IN (SELECT value FROM json_each(?))`).all(user,list);
    let n=0;const now=this.clock();
    for(const {job_id} of jobs){
      const items=this.db.prepare('SELECT * FROM memory_job_items WHERE job_id=?').all(job_id);
      if(!items.every(item=>this.store.derivedMemory.validateItem(item)))continue;
      this.db.prepare("UPDATE memory_jobs SET state='pending',run_after=?,last_error_code=NULL,fence=fence+1,lease_owner=NULL,lease_expires=NULL,updated_at=? WHERE job_id=? AND state='stale'").run(now,now,job_id);n++;
    }
    return n;
  }
}

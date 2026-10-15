// Internal project lifecycle resolution (foundation only: no route, action or UI uses it to change state).
// Ownership is checked before anything else; unknown and foreign IDs share one generic error. A project
// without a lifecycle row is active. Merges are stored as one direct `merged_into` edge per source and are
// followed at read time, so A -> B -> C keeps every original edge as history. Broken, foreign or cyclic
// metadata fails closed.
import {createHash} from 'node:crypto';
import {ConflictError,NotFoundError,ValidationError} from '../errors.mjs';
import {ownerEpoch,globalEpoch} from './protection.mjs';

export const MAX_CHAIN_DEPTH = 20;
// At most 20 merged source projects per canonical project; the canonical target itself is not counted.
export const MAX_SOURCE_MEMBERS = 20;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const corrupt = () => new ConflictError('Project lifecycle metadata is inconsistent.', 'PROJECT_LIFECYCLE_CORRUPT');
const notFound = () => new NotFoundError('Project not found.', 'PROJECT_NOT_FOUND');

export class ProjectLifecycle {
  constructor(store){this.store=store;this.db=store.db;}
  owned(user,projectId){return !!this.db.prepare('SELECT 1 FROM projects WHERE user_id=? AND project_id=?').get(user,projectId);}
  row(user,projectId){return this.db.prepare('SELECT * FROM project_lifecycle WHERE user_id=? AND project_id=?').get(user,projectId);}

  /** {requested_project_id, canonical_project_id, routed, state, effective_state, lifecycle_revision, chain}. */
  resolve(user,projectId){
    if(typeof projectId!=='string'||!IDENTIFIER.test(projectId))throw new ValidationError('Invalid project identifier.','INVALID_IDENTIFIER');
    if(!this.owned(user,projectId))throw notFound();
    const requested=this.row(user,projectId),chain=[projectId],seen=new Set(chain);
    let current=requested;
    while(current?.state==='merged'){
      const next=current.merged_into;
      if(seen.has(next)||chain.length>MAX_CHAIN_DEPTH||!this.owned(user,next))throw corrupt();
      chain.push(next);seen.add(next);current=this.row(user,next);
    }
    const canonical=chain.at(-1);
    return {requested_project_id:projectId,canonical_project_id:canonical,routed:canonical!==projectId,
      state:requested?.state??'active',effective_state:current?.state??'active',lifecycle_revision:current?.lifecycle_revision??0,chain};
  }
  /** The canonical project and every source that resolves to it (each with its own origin ID), bounded. */
  members(user,canonicalId){
    const resolved=this.resolve(user,canonicalId);
    if(resolved.routed)throw new ConflictError('Not a canonical project.','PROJECT_NOT_CANONICAL');
    const members=[{project_id:canonicalId,origin:true,state:resolved.state}],seen=new Set([canonicalId]);
    let frontier=[canonicalId];
    for(let depth=0;frontier.length;depth++){
      if(depth>MAX_CHAIN_DEPTH)throw corrupt();
      const next=[];
      for(const target of frontier)for(const row of this.db.prepare("SELECT project_id FROM project_lifecycle WHERE user_id=? AND merged_into=? AND state='merged' ORDER BY project_id").all(user,target)){
        if(seen.has(row.project_id))throw corrupt();
        if(!this.owned(user,row.project_id))throw corrupt();
        seen.add(row.project_id);next.push(row.project_id);members.push({project_id:row.project_id,origin:false,state:'merged'});
        if(members.length-1>MAX_SOURCE_MEMBERS)throw new ConflictError('Too many merged projects.','PROJECT_MEMBER_LIMIT');
      }
      frontier=next;
    }
    // Every member must resolve back to this canonical project through owned, acyclic edges.
    for(const member of members)if(this.resolve(user,member.project_id).canonical_project_id!==canonicalId)throw corrupt();
    return members;
  }
  /** Monotonic owner lifecycle generation: bumped by every delete, restore and merge (0 = no lifecycle change ever). */
  generation(user){return this.db.prepare('SELECT generation FROM owner_lifecycle_generation WHERE user_id=?').get(user)?.generation??0;}

  /** Authoritative per-owner lifecycle view for enforcement, computed from project_lifecycle rows (no cached index):
   * `dead` = projects whose effective state is deleted (a deleted canonical project and every member merged into it),
   * `canonical` = merged source -> canonical target. A project of this owner without a lifecycle row is active and
   * its own canonical project. Every row is resolved through the owner-first resolver, so inconsistent metadata
   * (cycle, foreign or missing target, depth) throws PROJECT_LIFECYCLE_CORRUPT instead of being treated as live. */
  view(user){
    const dead=[],canonical={};
    for(const row of this.db.prepare("SELECT project_id FROM project_lifecycle WHERE user_id=? AND state<>'active' ORDER BY project_id").all(user)){
      const resolved=this.resolve(user,row.project_id);
      if(resolved.effective_state==='deleted')dead.push(row.project_id);
      if(resolved.routed)canonical[row.project_id]=resolved.canonical_project_id;
    }
    // A deleted canonical project is dead even though it routes nowhere (handled above); members follow it.
    return {dead,canonical,generation:this.generation(user)};
  }
  /** Normal-operation scope of one requested project: owner check first (generic not found), then a deleted effective
   * state is PROJECT_DELETED (only the owner learns this), else the canonical project and its bounded member set. */
  scope(user,projectId){
    const resolved=this.resolve(user,projectId);
    if(resolved.effective_state==='deleted')throw new ConflictError('This project was deleted.','PROJECT_DELETED');
    const members=this.members(user,resolved.canonical_project_id).map(m=>m.project_id);
    return {requested_project_id:projectId,canonical_project_id:resolved.canonical_project_id,routed:resolved.routed,members,generation:this.generation(user)};
  }

  /** Freshness token: both parts must be unchanged. Not proof of an unchanged displayed impact or authority. */
  epoch(user){return {global:globalEpoch(this.db),owner:ownerEpoch(this.db,user)};}

  /** Owner-scoped idempotent operation record inside one immediate transaction: the same operation ID with the
   * same action and payload replays the stored result; with anything else it is refused. */
  operation(user,operationId,action,payload,apply){
    if(typeof operationId!=='string'||!IDENTIFIER.test(operationId))throw new ValidationError('Invalid operation identifier.','INVALID_OPERATION_ID');
    const hash=createHash('sha256').update(JSON.stringify([action,payload])).digest('hex');
    return this.store.memoryTransaction(()=>{
      const prior=this.db.prepare('SELECT * FROM project_lifecycle_operations WHERE user_id=? AND operation_id=?').get(user,operationId);
      if(prior){
        if(prior.action!==action||prior.payload_sha256!==hash)throw new ConflictError('Operation ID was used for a different request.','IDEMPOTENCY_CONFLICT');
        return {...JSON.parse(prior.result_json),replayed:true};
      }
      const result=apply();
      this.db.prepare("INSERT INTO project_lifecycle_operations VALUES (?,?,?,?,'completed',?,?)").run(user,operationId,action,hash,JSON.stringify(result),new Date().toISOString());
      return {...result,replayed:false};
    });
  }
}

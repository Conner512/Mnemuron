// Internal project lifecycle resolution and enforcement reads (no route, action or UI changes lifecycle state yet).
// Ownership is checked before anything else; unknown and foreign IDs share one generic error. A project
// without a lifecycle row is active. Merges are stored as one direct `merged_into` edge per source and are
// followed at read time, so A -> B -> C keeps every original edge as history. Broken, foreign or cyclic
// metadata fails closed.
import {createHash,randomUUID} from 'node:crypto';
import {ConflictError,NotFoundError,ValidationError} from '../errors.mjs';
import {ownerEpoch,globalEpoch} from './protection.mjs';

export const MAX_CHAIN_DEPTH = 20;
// At most 20 merged source projects per canonical project; the canonical target itself is not counted.
export const MAX_SOURCE_MEMBERS = 20;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const corrupt = () => new ConflictError('Project lifecycle metadata is inconsistent.', 'PROJECT_LIFECYCLE_CORRUPT');
const notFound = () => new NotFoundError('Project not found.', 'PROJECT_NOT_FOUND');
const wellFormed = row => ['active','deleted','merged'].includes(row.state)&&(row.state==='merged'
  ?typeof row.merged_into==='string'&&row.merged_into!==row.project_id:row.merged_into==null);

/** Open-time consistency check (read-only, before any migration, ensure or repair write). The v8/v9 builds refused
 * every deleted or merged project at open; from v10 consistent lifecycle state opens and is enforced, and this check
 * keeps the open-time refusal for inconsistent state: for every owner with lifecycle rows, a row for a project the
 * owner does not own, a malformed row (unknown state, bad target), a cycle, a foreign or missing target, excessive depth,
 * an invalid identifier or too many sources refuses the whole open with PROJECT_LIFECYCLE_CORRUPT. Reads keep failing closed for any inconsistency that appears after the open. */
export function assertLifecycleConsistent(db){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_lifecycle'").get())return;
  // No lifecycle rows: nothing to check (also when a damaged database is missing other tables that the repeatable
  // migrations are about to repair). Rows that refer to projects while the projects table itself is missing are rows of
  // unowned projects: inconsistent.
  if(!db.prepare('SELECT 1 FROM project_lifecycle LIMIT 1').get())return;
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get())throw corrupt();
  // Every metadata failure of this check, whatever its specific cause (malformed row, identifier, member limit), is
  // reported as the one fixed code: the open is refused because the lifecycle metadata is inconsistent.
  try{
    for(const row of db.prepare('SELECT * FROM project_lifecycle').all())if(!wellFormed(row))throw corrupt();
    if(db.prepare('SELECT 1 FROM project_lifecycle l WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.user_id=l.user_id AND p.project_id=l.project_id) LIMIT 1').get())throw corrupt();
    // A v8 database has no generation table yet; the generation is not part of consistency, so it is not read here.
    const lifecycle=new ProjectLifecycle({db});lifecycle.generation=()=>0;
    for(const {user_id:user} of db.prepare('SELECT DISTINCT user_id FROM project_lifecycle ORDER BY user_id').all()){
      lifecycle.view(user);
      // Every canonical project with sources is also held to the member walk (each member resolves back to it).
      for(const {project_id:id} of db.prepare("SELECT DISTINCT merged_into AS project_id FROM project_lifecycle WHERE user_id=? AND state='merged'").all(user)){
        const canonical=lifecycle.resolve(user,id).canonical_project_id;lifecycle.members(user,canonical);
      }
    }
  }catch(error){
    // The resolver's own refusals all mean inconsistent metadata here; an operational failure (lock, I/O, SQLite) is
    // rethrown as it is, so it is not mistaken for corrupt data (it still refuses the open, before any write).
    if(['INVALID_IDENTIFIER','PROJECT_MEMBER_LIMIT','PROJECT_NOT_FOUND','PROJECT_NOT_CANONICAL'].includes(error?.errorCode))throw corrupt();
    throw error;}
}

export class ProjectLifecycle {
  constructor(store){this.store=store;this.db=store.db;}
  owned(user,projectId){return !!this.db.prepare('SELECT 1 FROM projects WHERE user_id=? AND project_id=?').get(user,projectId);}
  // A row that only a bypassed CHECK could produce (unknown state, merged without a target or into itself, a target on a
  // non-merged row) is inconsistent metadata: it never reads as active.
  row(user,projectId){const row=this.db.prepare('SELECT * FROM project_lifecycle WHERE user_id=? AND project_id=?').get(user,projectId);
    if(row&&!wellFormed(row))throw corrupt();return row;}

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
  /** Monotonic owner lifecycle generation (0 = no lifecycle change ever). Database guards refuse every decrease,
   * reset, delete or replacement; bumpGeneration is the only supported change. */
  generation(user){return this.db.prepare('SELECT generation FROM owner_lifecycle_generation WHERE user_id=?').get(user)?.generation??0;}
  /** Advances the owner's generation by one and returns it. Only inside the caller's lifecycle mutation transaction, so
   * the bump commits or rolls back together with the state change (a rollback keeps the prior generation). The insert
   * seed is already current + 1, so the no-reset guard accepts it at any height. */
  bumpGeneration(user){
    if(!this.db.isTransaction)throw new Error('The owner lifecycle generation changes only inside a lifecycle transaction.');
    return this.db.prepare(`INSERT INTO owner_lifecycle_generation (user_id, generation)
      VALUES (?, COALESCE((SELECT generation FROM owner_lifecycle_generation WHERE user_id = ?), 0) + 1)
      ON CONFLICT (user_id) DO UPDATE SET generation = excluded.generation RETURNING generation`).get(user,user).generation;
  }

  /** Authoritative per-owner lifecycle view for enforcement, computed from project_lifecycle rows (no cached index):
   * `dead` = projects whose effective state is deleted (a deleted canonical project and every member merged into it),
   * `canonical` = merged source -> canonical target, a null-prototype dictionary (any valid project ID, including
   * `constructor` or `toString`, is an own key or absent). A project of this owner without a lifecycle row is active
   * and its own canonical project. Every row is resolved through the owner-first resolver and every canonical project
   * is held to the same source-member limit as scope(), so inconsistent metadata (cycle, foreign or missing target,
   * depth, too many sources) throws instead of being treated as live. */
  view(user){
    const dead=[],canonical=Object.create(null),sources=new Map();
    // Every row of the owner is well formed, an active one included (an active row with a target is inconsistent too).
    for(const row of this.db.prepare('SELECT * FROM project_lifecycle WHERE user_id=?').all(user))if(!wellFormed(row))throw corrupt();
    for(const row of this.db.prepare("SELECT project_id FROM project_lifecycle WHERE user_id=? AND state<>'active' ORDER BY project_id").all(user)){
      // Lifecycle metadata for a project this owner does not own is inconsistent, not "not found".
      if(!this.owned(user,row.project_id))throw corrupt();
      const resolved=this.resolve(user,row.project_id);
      if(resolved.effective_state==='deleted')dead.push(row.project_id);
      if(!resolved.routed)continue;
      canonical[row.project_id]=resolved.canonical_project_id;
      const count=(sources.get(resolved.canonical_project_id)??0)+1;
      if(count>MAX_SOURCE_MEMBERS)throw new ConflictError('Too many merged projects.','PROJECT_MEMBER_LIMIT');
      sources.set(resolved.canonical_project_id,count);
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

  /** Per-request read filter for one owner, from the authoritative view (corrupt metadata throws before any read).
   * A record is live when its project ID is NULL (a neutral memory), or names a project this owner owns whose
   * effective state is not deleted. A dangling ID or another owner's project is never live, so the filter never
   * widens what the caller's own predicates allow. One rule backs `has`, `canonicalOf` and `sql`. Canonical grouping
   * never grants access: callers keep their own owner, scope, visibility and agent/session/workstream predicates. */
  live(user){
    const view=this.view(user),dead=new Set(view.dead),json=JSON.stringify(view.dead);
    const owned=new Set(this.db.prepare('SELECT project_id FROM projects WHERE user_id=?').all(user).map(row=>row.project_id));
    const has=projectId=>projectId==null||(owned.has(projectId)&&!dead.has(projectId));
    return {dead,canonical:view.canonical,generation:view.generation,has,
      // The canonical project of a live owned ID; null for NULL and for any ID that is not live, which therefore
      // never equals a canonical project ID.
      canonicalOf:projectId=>projectId!=null&&has(projectId)?view.canonical[projectId]??projectId:null,
      sql:column=>({sql:`(${column} IS NULL OR (${column} IN (SELECT project_id FROM projects WHERE user_id = ?) AND ${column} NOT IN (SELECT value FROM json_each(?))))`,params:[user,json]})};
  }
  /** Single-record state for direct reads and derived-source delivery: 'neutral' (NULL project), 'live',
   * 'deleted' (owned, effectively deleted: only the full owner may learn this), or 'unavailable' (dangling or another
   * owner's ID: callers answer with their generic not found). Lifecycle rows for an unowned ID fail closed. */
  projectState(user,projectId){
    if(projectId==null)return 'neutral';
    if(!this.owned(user,projectId)){if(this.row(user,projectId))throw corrupt();return 'unavailable';}
    return this.resolve(user,projectId).effective_state==='deleted'?'deleted':'live';
  }
  liveProject(user,projectId){return ['neutral','live'].includes(this.projectState(user,projectId));}

  /** Write-time project decision, only inside the caller's write transaction (no check-then-write gap). Owner first:
   * - NULL stays NULL; an ID with no project row of this owner (and no lifecycle row) is returned unchanged for the
   *   caller's existing creation/ownership rules (another owner's ID is refused there generically);
   * - an owned, effectively deleted ID is PROJECT_DELETED: deleted IDs stay permanently reserved, never recreated;
   * - an owned merged ID is routed to its canonical project with requested-ID provenance in project_route_log, unless
   *   `origin` (the record's existing project) is canonically equivalent: then the origin is kept (task history);
   * - a live canonical ID is returned unchanged.
   * Returns {project_id, requested_project_id, routed}. */
  writeProject(user,projectId,{entityType,entityId,origin=null}={}){
    if(!this.db.isTransaction)throw new Error('Lifecycle write checks run only inside the write transaction.');
    if(projectId==null)return {project_id:null,requested_project_id:null,routed:false};
    const state=this.projectState(user,projectId);
    if(state==='unavailable')return {project_id:projectId,requested_project_id:projectId,routed:false};
    if(state==='deleted')throw new ConflictError('This project was deleted.','PROJECT_DELETED');
    const canonical=this.resolve(user,projectId).canonical_project_id;
    if(origin!=null&&origin!==projectId&&this.projectState(user,origin)==='live'&&this.resolve(user,origin).canonical_project_id===canonical)
      return {project_id:origin,requested_project_id:projectId,routed:false};
    if(canonical===projectId)return {project_id:projectId,requested_project_id:projectId,routed:false};
    if(origin===projectId)return {project_id:projectId,requested_project_id:projectId,routed:false};
    this.logRoute(user,projectId,canonical,entityType,entityId);
    return {project_id:canonical,requested_project_id:projectId,routed:true};
  }
  /** Requested-ID provenance of a routed write (append-only history of which old ID a write used). */
  logRoute(user,requested,canonical,entityType,entityId){
    if(!this.db.isTransaction)throw new Error('Route provenance is written only inside the write transaction.');
    this.db.prepare('INSERT INTO project_route_log VALUES (?,?,?,?,?,?,?)').run(randomUUID(),user,requested,canonical,String(entityType||'unknown'),String(entityId||''),new Date().toISOString());
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

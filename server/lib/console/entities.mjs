import {parseEntityProof} from '../memory-entities/store.mjs';
import {object,id,number} from './state.mjs';
import {entityName} from '../memory-entities/contracts.mjs';
import {ValidationError,ConflictError,NotFoundError} from '../errors.mjs';
const proofOf=s=>({user_id:s.user_id,memory_id:s.memory_id,revision:s.revision,state_hash:s.state_hash,scope_key:s.scope_key});
export const ENTITY_ACTIONS=['entity.create','entity.alias','entity.alias_remove','entity.alias_correct','entity.link','entity.unlink','entity.resolve'];
export class ConsoleEntities {
  constructor(service){this.service=service;this.store=service.store;this.graph=this.store.entities;this.db=service.db;}
  context(e){let s;try{s=JSON.parse(e.scope_key);}catch{return {kind:'unknown'};}
    const [user,kind,project_id,task_id,workstream_id,session_id]=s;
    return {kind,project_id,project_name:project_id?this.db.prepare('SELECT name FROM projects WHERE user_id=? AND project_id=?').get(user,project_id)?.name||null:null,
      task_id,task_title:task_id?this.db.prepare('SELECT title FROM tasks WHERE user_id=? AND task_id=?').get(user,task_id)?.title||null:null,workstream_id,session_id};}
  summary(auth,e){const source=this.graph.anchor(e,auth),revision=this.store.revisions.latest(auth.user_id,e.anchor_memory_id),row=this.db.prepare('SELECT status,project_id FROM memories WHERE user_id=? AND memory_id=?').get(auth.user_id,e.anchor_memory_id);
    const lifecycle=row?this.store.lifecycle.projectState(auth.user_id,row.project_id):'unavailable';
    const state=source?'current':!['live','neutral'].includes(lifecycle)?'unavailable':row?.status!=='active'?'inactive':'stale';
    return {entity_id:e.entity_id,name:e.label,kind:e.kind,origin:e.origin,state,confirmable:!!source,expected_version:this.graph.version(auth,e),
      anchor:{current:!!source,memory_id:e.anchor_memory_id,revision:e.anchor_revision,current_revision:revision?.revision||null,content:source?source.content.slice(0,600):null,content_truncated:!!source&&source.content.length>600,
        status:row?.status||'unavailable',source_kind:source?.evidence_kind||null,created_at:e.created_at,context:this.context(e)}};}
  proposal(auth,p){const e=this.graph.get(auth.user_id,p.source_entity_id),target=p.target_entity_id?this.graph.get(auth.user_id,p.target_entity_id):null,n=p.name_id?this.db.prepare('SELECT * FROM memory_entity_names WHERE user_id=? AND name_id=?').get(auth.user_id,p.name_id):null;
    const valid=!!e&&!!this.graph.anchor(e,auth)&&(target?!!this.graph.edgeValid(p,auth):!!n&&!!this.graph.validProof(parseEntityProof(n.proof_json),auth));
    return {proposal_id:p.proposal_id,current:valid,created_at:p.created_at,relation:p.relation,state:p.state,name:n?.name||null,name_id:p.name_id,source:e?this.summary(auth,e):null,target:target?this.summary(auth,target):null,
      confirmable:p.state==='pending'&&valid,expected_version:e?this.graph.version(auth,e):null};}
  read(auth,p){object(p,['entity_id','memory_id','query','status','offset','limit']);
    if(p.entity_id){id(p.entity_id);const e=this.graph.requireEntity(auth,p.entity_id);
      const aliases=this.db.prepare('SELECT name_id,name,origin,state,proof_json FROM memory_entity_names WHERE user_id=? AND entity_id=? ORDER BY name_id LIMIT 1001').all(auth.user_id,e.entity_id);
      const members=this.db.prepare('SELECT * FROM memory_entity_members WHERE user_id=? AND entity_id=? ORDER BY memory_id LIMIT 501').all(auth.user_id,e.entity_id);
      const proposals=this.db.prepare('SELECT * FROM memory_entity_proposals WHERE user_id=? AND (source_entity_id=? OR target_entity_id=?) ORDER BY proposal_id LIMIT 501').all(auth.user_id,e.entity_id,e.entity_id);
      return {read_only:true,entity:this.summary(auth,e),aliases:aliases.slice(0,1000).map(({proof_json,...n})=>({...n,current:!!this.graph.validProof(parseEntityProof(proof_json),auth),evidence_backed:n.origin==='model'})),
        memories:members.slice(0,500).map(m=>{const s=this.graph.validProof(parseEntityProof(m.proof_json),auth),proof=parseEntityProof(m.proof_json);const current=this.store.revisions.latest(auth.user_id,m.memory_id),row=this.db.prepare('SELECT status,created_at FROM memories WHERE user_id=? AND memory_id=?').get(auth.user_id,m.memory_id);return {memory_id:m.memory_id,revision:proof.revision,current_revision:current?.revision||null,state:m.state,status:row?.status||'unavailable',created_at:row?.created_at||null,source_kind:s?.evidence_kind||null,context:this.context({...e,scope_key:proof.scope_key}),current:!!s,origin:m.origin,content:s?s.content.slice(0,300):null};}),
        proposals:proposals.slice(0,500).map(p=>this.proposal(auth,p)),truncated:aliases.length>1000||members.length>500||proposals.length>500,
        manual_alias_policy:'Owner-typed aliases stay private to owner reads and are retired when this object is linked to another object. Evidence-backed names retain their proof and bridge dependencies.'};}
    if(p.memory_id)id(p.memory_id);if(p.query!==undefined&&(typeof p.query!=='string'||p.query.length>200))throw new ValidationError('Invalid object query.');
    if(p.status!==undefined&&!['accepted','pending','rejected','current','stale','inactive'].includes(p.status))throw new ValidationError('Invalid object status.');
    const limit=p.limit===undefined?25:number(Number(p.limit),1,100),offset=p.offset===undefined?0:number(Number(p.offset),0,1000000),q=(p.query||'').toLowerCase();
    // Inventory is owner-only, bounded independently from search. Never echo stale anchor content.
    const rows=this.db.prepare(`SELECT e.* FROM memory_entities e WHERE e.user_id=? AND (? IS NULL OR EXISTS(SELECT 1 FROM memory_entity_members m WHERE m.user_id=e.user_id AND m.entity_id=e.entity_id AND m.memory_id=?)) ORDER BY e.created_at DESC,e.entity_id LIMIT 1001`).all(auth.user_id,p.memory_id||null,p.memory_id||null);
    const all=rows.slice(0,1000).map(e=>this.summary(auth,e)).filter(e=>(!q||e.name.toLowerCase().includes(q))&&(!['current','stale','inactive'].includes(p.status)||e.state===p.status));
    let proposals=this.db.prepare(`SELECT p.* FROM memory_entity_proposals p WHERE p.user_id=? AND p.state=? AND (? IS NULL OR EXISTS(SELECT 1 FROM memory_entity_members m WHERE m.user_id=p.user_id AND m.memory_id=? AND (m.entity_id=p.source_entity_id OR m.entity_id=p.target_entity_id))) ORDER BY p.created_at,p.proposal_id LIMIT 501`).all(auth.user_id,['accepted','rejected'].includes(p.status)?p.status:'pending',p.memory_id||null,p.memory_id||null);
    const proposalsOverflow=proposals.length>=500;proposals=proposals.slice(0,500).filter(p=>!q||[this.graph.get(auth.user_id,p.source_entity_id)?.label,p.target_entity_id?this.graph.get(auth.user_id,p.target_entity_id)?.label:null,p.name_id?this.db.prepare('SELECT name FROM memory_entity_names WHERE user_id=? AND name_id=?').get(auth.user_id,p.name_id)?.name:null].some(name=>name?.toLowerCase().includes(q)));
    return {read_only:true,entities:all.slice(offset,offset+limit),proposals:proposals.slice(offset,Math.min(500,offset+limit)).map(p=>this.proposal(auth,p)),proposal_total:Math.min(proposals.length,500),offset,limit,next_offset:(p.status&&['pending','rejected','accepted'].includes(p.status)?proposals.length:all.length)>offset+limit?offset+limit:null,
      truncated:rows.length>1000||proposalsOverflow,pending_count:proposals.filter(p=>p.state==='pending').length,requires_review:proposals.some(p=>p.state==='pending'),historical_backfill:false};
  }
  apply(auth,action,p){this.store.requireScope(auth,'memory:organize');const g=this.graph,user=auth.user_id;
    if(action==='entity.create'){object(p,['memory_id','revision','name','kind']);number(p.revision,1,2147483647);this.service.memory(auth,p.memory_id,p.revision);const source=g.source(user,p.memory_id,auth);
      if(!source)throw new ConflictError('The memory is not an eligible current object anchor.','ENTITY_STALE');const name=entityName(p.name),kind=p.kind||'object';if(!['object','person','place','project','server','vendor'].includes(kind))throw new ValidationError('Invalid object kind.');
      const e=g.createFromSource(source,name,kind,'manual');return {status:'created',entity_id:e.entity_id};}
    if(action==='entity.resolve'){object(p,['proposal_id','decision','expected_version']);id(p.proposal_id);if(!['accept','reject'].includes(p.decision))throw new ValidationError('Choose accept or reject.');
      const proposal=this.db.prepare('SELECT * FROM memory_entity_proposals WHERE user_id=? AND proposal_id=?').get(user,p.proposal_id);
      if(!proposal)throw new NotFoundError('Object proposal not found.','ENTITY_PROPOSAL_NOT_FOUND');const e=g.requireEntity(auth,proposal.source_entity_id);g.assertVersion(auth,e,p.expected_version);
      if(proposal.state!=='pending')throw new ConflictError('The proposal has already been resolved.','ENTITY_PROPOSAL_RESOLVED');
      const presented=this.proposal(auth,proposal);if(!presented.confirmable)throw new ConflictError('Object evidence changed; this proposal is no longer confirmable.','ENTITY_STALE');
      const accepted=p.decision==='accept',state=accepted?'accepted':'rejected';
      if(proposal.target_entity_id){const target=g.requireEntity(auth,proposal.target_entity_id);
        if(!g.edgeValid(proposal,auth))throw new ConflictError('Object evidence or scope changed.','ENTITY_STALE');
        if(!accepted){g.retire(user,'edge',[g.objectKey(e),g.objectKey(target)],'rejected');g.retire(user,'edge',[g.objectKey(target),g.objectKey(e)],'rejected');}
        if(accepted&&proposal.relation==='same_entity')this.db.prepare("UPDATE memory_entity_names SET state='retired' WHERE user_id=? AND entity_id IN (?,?) AND origin='manual'").run(user,e.entity_id,target.entity_id);
      }else{const n=this.db.prepare('SELECT * FROM memory_entity_names WHERE user_id=? AND name_id=?').get(user,proposal.name_id);
        if(!accepted)g.retire(user,'name',[g.objectKey(e),n.normalized],'rejected');
        this.db.prepare('UPDATE memory_entity_names SET state=? WHERE user_id=? AND name_id=?').run(accepted?(proposal.relation==='same_entity'?'accepted':'related'):'rejected',user,n.name_id);}
      this.db.prepare('UPDATE memory_entity_proposals SET state=? WHERE user_id=? AND proposal_id=?').run(state,user,p.proposal_id);return {status:state,proposal_id:p.proposal_id,entity_id:e.entity_id,relation:proposal.relation,manual_aliases_retired:accepted&&!!proposal.target_entity_id&&proposal.relation==='same_entity'};
    }
    object(p,action==='entity.alias'?['entity_id','name','expected_version']:action==='entity.alias_remove'?['entity_id','name_id','expected_version']:action==='entity.alias_correct'?['entity_id','name_id','name','expected_version']:['entity_id','memory_id','revision','target_entity_id','expected_version']);
    const e=g.requireEntity(auth,p.entity_id);g.assertVersion(auth,e,p.expected_version);
    if(['entity.alias_remove','entity.alias_correct'].includes(action)){id(p.name_id);const n=this.db.prepare('SELECT * FROM memory_entity_names WHERE user_id=? AND entity_id=? AND name_id=?').get(user,e.entity_id,p.name_id);
      if(!n)throw new NotFoundError('Alias not found.','ENTITY_ALIAS_NOT_FOUND');if(action==='entity.alias_correct')entityName(p.name);
      g.retire(user,'name',[g.objectKey(e),n.normalized],'removed');this.db.prepare("UPDATE memory_entity_names SET state='retired' WHERE user_id=? AND name_id=?").run(user,n.name_id);
      this.db.prepare("UPDATE memory_entity_proposals SET state='rejected' WHERE user_id=? AND name_id=? AND state='pending'").run(user,n.name_id);
      if(action==='entity.alias_remove')return {status:'removed',entity_id:e.entity_id,name_id:n.name_id};}
    if(['entity.alias','entity.alias_correct'].includes(action)){const name=entityName(p.name),source=g.anchor(e,auth),nameId=g.addName(e,name,{origin:'manual',proof:proofOf(source)});
      if(!nameId)throw new ConflictError('This name was previously rejected or removed; use a distinct corrected name.','ENTITY_TOMBSTONED');return {status:action==='entity.alias_correct'?'corrected':'added',entity_id:e.entity_id,name_id:nameId,evidence_backed:false};}
    if(['entity.link','entity.unlink'].includes(action)&&Boolean(p.target_entity_id)===Boolean(p.memory_id))throw new ValidationError('Choose exactly one memory or object target.','INVALID_ENTITY_TARGET');
    if(p.target_entity_id){if(p.revision!==undefined)throw new ValidationError('Object links use the reviewed object version.','INVALID_ENTITY_TARGET');const target=g.requireEntity(auth,p.target_entity_id);if(!g.anchor(target,auth)||e.scope_key!==target.scope_key)throw new ConflictError('Objects must have current anchors in the same exact context.','ENTITY_SCOPE_MISMATCH');
      if(action==='entity.unlink'){g.retire(user,'edge',[g.objectKey(e),g.objectKey(target)],'unlinked');g.retire(user,'edge',[g.objectKey(target),g.objectKey(e)],'unlinked');
        this.db.prepare("UPDATE memory_entity_proposals SET state='unlinked' WHERE user_id=? AND ((source_entity_id=? AND target_entity_id=?) OR (source_entity_id=? AND target_entity_id=?))").run(user,e.entity_id,target.entity_id,target.entity_id,e.entity_id);return {status:'unlinked',entity_id:e.entity_id,target_entity_id:target.entity_id};}
      const proposal=g.propose(e,target,{proof:{source:proofOf(g.anchor(e,auth)),target:proofOf(g.anchor(target,auth))}});if(!proposal)throw new ConflictError('This association was previously rejected or removed.','ENTITY_TOMBSTONED');
      // An explicit manual link is the confirmation itself; no name is moved or source rewritten.
      this.db.prepare("UPDATE memory_entity_proposals SET state='accepted' WHERE user_id=? AND proposal_id=? AND state='pending'").run(user,proposal);
      this.db.prepare("UPDATE memory_entity_names SET state='retired' WHERE user_id=? AND entity_id IN (?,?) AND origin='manual'").run(user,e.entity_id,target.entity_id);
      return {status:'linked',entity_id:e.entity_id,target_entity_id:target.entity_id,manual_aliases_retired:true};}
    id(p.memory_id);if(action==='entity.unlink'){if(p.memory_id===e.anchor_memory_id)throw new ValidationError('An object anchor cannot be unlinked; remove its aliases instead.','ENTITY_ANCHOR_REQUIRED');
      g.retire(user,'member',[g.objectKey(e),p.memory_id],'unlinked');this.db.prepare("UPDATE memory_entity_members SET state='unlinked' WHERE user_id=? AND entity_id=? AND memory_id=?").run(user,e.entity_id,p.memory_id);return {status:'unlinked',entity_id:e.entity_id,memory_id:p.memory_id};}
    number(p.revision,1,2147483647);this.service.memory(auth,p.memory_id,p.revision);const source=g.source(user,p.memory_id,auth);
    if(!source||source.scope_key!==e.scope_key)throw new ConflictError('The memory must be current and in the exact object context.','ENTITY_SCOPE_MISMATCH');
    if(g.tombstone(user,'member',g.objectKey(e),p.memory_id))throw new ConflictError('This association was previously removed.','ENTITY_TOMBSTONED');
    this.db.prepare("INSERT INTO memory_entity_members VALUES(?,?,?,?,?,'accepted') ON CONFLICT(user_id,entity_id,memory_id) DO UPDATE SET proof_json=excluded.proof_json,origin=excluded.origin,state=excluded.state").run(user,e.entity_id,p.memory_id,JSON.stringify(proofOf(source)),'manual');
    return {status:'linked',entity_id:e.entity_id,memory_id:p.memory_id};
  }
}

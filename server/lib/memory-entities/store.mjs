import {migrateEntities} from './schema.mjs';
import {digest,fail} from '../model-providers/contracts.mjs';
import {ValidationError,ConflictError,NotFoundError} from '../errors.mjs';
import {ownerEpoch,globalEpoch} from '../lifecycle/protection.mjs';
import {searchTokens} from '../memory-retrieval.mjs';
import {isWebReader} from '../memory/web-visibility.mjs';
import {memoryScopeSql} from '../memory-scope.mjs';
import {entityName,normalizedName,explicitEquivalence,sourceContainsName,ENTITY_LIMITS} from './contracts.mjs';
export function parseEntityProof(value){try{const data=JSON.parse(value);if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();return data;}catch{throw new ConflictError('Object proof is unavailable; repair the derived record before using it.','ENTITY_PROOF_INVALID');}}
const parse=parseEntityProof,now=()=>new Date().toISOString();
const kinds=['object','person','place','project','server','vendor'];
const safeId=x=>typeof x==='string'&&x.length>0&&x.length<=200;
const proofOf=s=>({user_id:s.user_id,memory_id:s.memory_id,revision:s.revision,state_hash:s.state_hash,scope_key:s.scope_key});
/** Evidence-first object graph. Names never identify a node: each node has its own exact source anchor.
 * A confirmed relationship is a one-hop bridge, not a transitive merge or a rewrite of either source. */
export class MemoryEntities {
  constructor(store){this.store=store;this.db=store.db;this.migrate();}
  migrate(){migrateEntities(this.db);}
  lifecycleStamp(user,project){return project?digest(this.store.lifecycle.resolve(user,project).chain.map(id=>[id,this.store.lifecycle.row(user,id)])):'neutral';}
  source(user,id,auth=null){const source=this.store.derivedMemory.currentSource(user,id);if(!source||auth&&!this.store.webVisibility.visible(auth,id))return null;
    const revision=this.store.revisions.latest(user,id),lifecycle=this.lifecycleStamp(user,source.project_id);
    // Category is presentation metadata, not identity evidence. Revision, privacy, exact context and
    // project lifecycle are still bound; changing a category must not accidentally erase aliases.
    return {...source,state_hash:digest(['entity-source-v1',revision.state_hash,source.sensitivity,lifecycle])};}

  validProof(proof,auth=null){if(!proof)return null;if(!safeId(proof.user_id)||!safeId(proof.memory_id)||!Number.isSafeInteger(proof.revision)||proof.revision<1||typeof proof.state_hash!=='string'||!/^[a-f0-9]{64}$/.test(proof.state_hash)||typeof proof.scope_key!=='string'||proof.scope_key.length>2000)throw new ConflictError('Object proof is invalid.','ENTITY_PROOF_INVALID');if(auth&&proof.user_id!==auth.user_id)return null;const s=this.source(proof.user_id,proof.memory_id,auth);
    return s&&s.revision===proof.revision&&s.state_hash===proof.state_hash&&s.scope_key===proof.scope_key?s:null;}
  get(user,id){return this.db.prepare('SELECT * FROM memory_entities WHERE user_id=? AND entity_id=?').get(user,id)||null;}
  anchor(e,auth=null){return e&&this.validProof({user_id:e.user_id,memory_id:e.anchor_memory_id,revision:e.anchor_revision,state_hash:e.anchor_state_hash,scope_key:e.scope_key},auth);}
  requireEntity(auth,id){if(!safeId(id))throw new ValidationError('Invalid object identifier.');const e=this.get(auth.user_id,id);if(!e)throw new NotFoundError('Object not found.','ENTITY_NOT_FOUND');return e;}
  objectKey(e){return digest(['entity-object-v1',e.user_id,e.anchor_memory_id,e.scope_key,e.kind,normalizedName(e.label)]);}
  key(type,...parts){return digest([type,...parts]);}
  tombstone(user,type,...parts){return !!this.db.prepare('SELECT 1 FROM memory_entity_tombstones WHERE user_id=? AND tombstone_key=?').get(user,this.key(type,...parts));}
  retire(user,type,parts,reason){this.db.prepare('INSERT OR IGNORE INTO memory_entity_tombstones VALUES(?,?,?,?)').run(user,this.key(type,...parts),reason,now());}
  version(auth,e){return digest(['entity-v1',auth.user_id,e.entity_id,ownerEpoch(this.db,auth.user_id),globalEpoch(this.db),this.store.lifecycle.generation(auth.user_id),!!this.anchor(e,auth)]);}
  assertVersion(auth,e,expected){if(!this.anchor(e,auth))throw new ConflictError('The object source changed or is no longer available.','ENTITY_STALE');
    if(expected!==this.version(auth,e))throw new ConflictError('Object evidence changed; review it again.','ENTITY_VERSION_CHANGED');}
  addName(e,name,{origin='model',state='accepted',proof,relation='same_entity'}={}){
    name=entityName(name);const normalized=normalizedName(name),id=digest(['name',e.entity_id,normalized,origin]);
    if(this.tombstone(e.user_id,'name',this.objectKey(e),normalized))return null;
    this.db.prepare('INSERT OR IGNORE INTO memory_entity_names VALUES(?,?,?,?,?,?,?,?,?)').run(id,e.user_id,e.entity_id,name,normalized,origin,state,JSON.stringify(proof),now());
    if(state==='pending')this.propose(e,null,{nameId:id,relation,proof});return id;
  }
  createFromSource(source,name,kind='object',origin='model'){
    const entityId=digest(['entity',source.user_id,source.memory_id,source.revision,source.state_hash,normalizedName(name),kind]);
    this.db.prepare('INSERT OR IGNORE INTO memory_entities VALUES(?,?,?,?,?,?,?,?,?,?)').run(entityId,source.user_id,source.memory_id,source.revision,source.state_hash,source.scope_key,kind,name,origin,source.created_at);
    const e=this.get(source.user_id,entityId),proof=proofOf(source);
    this.db.prepare("INSERT OR IGNORE INTO memory_entity_members VALUES(?,?,?,?,?,'accepted')").run(source.user_id,entityId,source.memory_id,JSON.stringify(proof),'anchor');
    this.addName(e,name,{origin,proof});return e;
  }
  propose(source,target,{nameId=null,relation='same_entity',proof={}}={}){
    if(target&&(source.entity_id===target.entity_id||source.scope_key!==target.scope_key))return null;
    if(target&&this.tombstone(source.user_id,'edge',this.objectKey(source),this.objectKey(target)))return null;
    const id=digest(['proposal',source.entity_id,target?.entity_id||null,nameId,relation]);
    this.db.prepare("INSERT OR IGNORE INTO memory_entity_proposals VALUES(?,?,?,?,?,?,'pending',?,?)").run(id,source.user_id,source.entity_id,target?.entity_id||null,nameId,relation,JSON.stringify(proof),now());return id;
  }
  /** Validate every result before writing any derivation; worker publication is already transactional. */
  publish(job,items,outputs){
    if(outputs.length!==items.length||new Set(outputs.map(x=>x.memory_id)).size!==items.length)fail('INVALID_SOURCE_SET');
    const checked=outputs.map(output=>{const item=items.find(i=>i.memory_id===output.memory_id),validated=item&&this.store.derivedMemory.validateItem(item),source=validated&&this.source(job.user_id,item.memory_id);
      if(!source||source.user_id!==job.user_id||output.revision!==source.revision||job.metadata.lifecycle_stamp!==this.lifecycleStamp(job.user_id,source.project_id))fail('STALE_INPUT');
      if(!Array.isArray(output.objects)||output.objects.length>ENTITY_LIMITS.objects)fail('INVALID_SOURCE_SET');
      const checkedName=value=>{try{return entityName(value);}catch{fail('INVALID_SOURCE_SET');}};
      const seen=new Set();for(const o of output.objects){checkedName(o.name);const key=JSON.stringify([o.kind,normalizedName(o.name)]);if(seen.has(key))fail('INVALID_SOURCE_SET');seen.add(key);if(!kinds.includes(o.kind)||typeof o.quote!=='string'||!o.quote||!source.content.includes(o.quote)||!sourceContainsName(o.quote,o.name)||!sourceContainsName(source.content,o.name)||(o.quote!==source.content&&source.content.indexOf(o.quote,source.content.indexOf(o.quote)+1)!==-1)||!Array.isArray(o.aliases)||o.aliases.length>ENTITY_LIMITS.aliases)fail('INVALID_SOURCE_SET');
        for(const a of o.aliases){checkedName(a.name);if(!['same_entity','related','uncertain'].includes(a.relation)||!sourceContainsName(source.content,a.name))fail('INVALID_SOURCE_SET');}}
      return {source,objects:output.objects};});
    for(const {source,objects} of checked)for(const o of objects){const e=this.createFromSource(source,o.name,o.kind),proof={...proofOf(source),quote:o.quote,quote_start:source.content.indexOf(o.quote),quote_end:source.content.indexOf(o.quote)+o.quote.length};
      for(const a of o.aliases){if(normalizedName(a.name)===normalizedName(o.name))continue;const accepted=explicitEquivalence(source.content,o.name,a.name,{relation:a.relation,kind:o.kind});
        this.addName(e,a.name,{proof,state:accepted?'accepted':'pending',relation:a.relation});}}
    // Reconcile both directions after every publication: reverse arrival and identical timestamps have
    // the same directed candidate set. Colliding names remain pending, never evidence of identity.
    this.reconcile(job.user_id);
    for(const {source} of checked)this.db.prepare("UPDATE memory_processing_outbox SET state='done' WHERE user_id=? AND memory_id=? AND revision=? AND job_type='entities'").run(source.user_id,source.memory_id,source.revision);
    return null;
  }
  namingRows(user){const rows=this.db.prepare('SELECT * FROM memory_entity_names WHERE user_id=? ORDER BY entity_id,name_id LIMIT ?').all(user,ENTITY_LIMITS.names+1);
    return {rows:rows.slice(0,ENTITY_LIMITS.names),truncated:rows.length>ENTITY_LIMITS.names};}
  reconcile(user){const inventory=this.namingRows(user);if(inventory.truncated)return {truncated:true};
    const grouped=new Map();for(const n of inventory.rows){if(n.origin!=='model'||n.state!=='accepted')continue;const e=this.get(user,n.entity_id);if(!this.anchor(e)||!this.validProof(parse(n.proof_json)))continue;
      const key=e.scope_key+'\0'+n.normalized,list=grouped.get(key)||[];if(!list.some(x=>x.entity_id===e.entity_id))list.push(e);grouped.set(key,list);}
    let proposals=0;for(const list of grouped.values())for(const a of list)for(const b of list){if(a.entity_id===b.entity_id||a.anchor_memory_id===b.anchor_memory_id||a.kind!==b.kind)continue;
      if(proposals>=500)return {truncated:true};if(this.propose(a,b,{proof:{source:proofOf(this.anchor(a)),target:proofOf(this.anchor(b))}}))proposals++;}
    return {truncated:false};
  }
  impact(user,members){
    const entities=`SELECT e.entity_id FROM memory_entities e JOIN memories m ON m.user_id=e.user_id AND m.memory_id=e.anchor_memory_id
      WHERE e.user_id=? AND m.project_id IN (SELECT value FROM json_each(?))`,list=JSON.stringify(members);
    const count=(sql,...params)=>this.db.prepare(sql).get(...params).n;
    const proposals=`SELECT COUNT(*) n FROM memory_entity_proposals p WHERE p.user_id=? AND
      (p.source_entity_id IN (${entities}) OR p.target_entity_id IN (${entities}))`;
    return {entities:count(`SELECT COUNT(*) n FROM (${entities})`,user,list),
      entity_proposals:count(proposals,user,user,list,user,list),pending_entity_proposals:count(proposals+" AND p.state='pending'",user,user,list,user,list)};
  }
  restoreIntents(user,members){
    // Requeue only prior requested intents of current active revisions. No historical-memory scan
    // or baseline insertion; explicit cancelled jobs remain cancelled. Fresh jobs bind the new lifecycle.
    const count=this.db.prepare(`UPDATE memory_processing_outbox AS o SET state='pending' WHERE o.user_id=? AND o.job_type='entities'
      AND EXISTS(SELECT 1 FROM memories m WHERE m.user_id=o.user_id AND m.memory_id=o.memory_id AND m.status='active'
        AND m.project_id IN (SELECT value FROM json_each(?)) AND o.revision=(SELECT MAX(r.revision) FROM memory_revisions r WHERE r.user_id=o.user_id AND r.memory_id=o.memory_id))
      AND (o.state IN ('pending','stale','done') OR o.state='scheduled' AND EXISTS(SELECT 1 FROM memory_job_items i JOIN memory_jobs j ON j.job_id=i.job_id
        WHERE i.user_id=o.user_id AND i.memory_id=o.memory_id AND i.revision=o.revision AND j.job_type='entities' AND j.state<>'cancelled'))`).run(user,JSON.stringify(members)).changes;
    this.db.prepare(`UPDATE memory_jobs SET state='cancelled',fence=fence+1,lease_owner=NULL,lease_expires=NULL,last_error_code='RESCHEDULED'
      WHERE user_id=? AND job_type='entities' AND state NOT IN ('succeeded','cancelled') AND EXISTS(
        SELECT 1 FROM memory_job_items i JOIN memories m ON m.user_id=i.user_id AND m.memory_id=i.memory_id
        WHERE i.job_id=memory_jobs.job_id AND i.user_id=memory_jobs.user_id AND m.project_id IN (SELECT value FROM json_each(?)))`).run(user,JSON.stringify(members));
    return count;
  }
  enqueue(user,ids){
    if(!ids.length)return;
    this.db.prepare(`INSERT INTO memory_processing_outbox(user_id,memory_id,revision,job_type,state,content_hash,created_at)
      SELECT r.user_id,r.memory_id,r.revision,'entities','pending',r.content_hash,? FROM memory_revisions r
      WHERE r.user_id=? AND r.memory_id IN (SELECT value FROM json_each(?))
        AND r.revision=(SELECT MAX(x.revision) FROM memory_revisions x WHERE x.user_id=r.user_id AND x.memory_id=r.memory_id)
      ON CONFLICT(user_id,memory_id,revision,job_type) DO UPDATE SET state='pending'`).run(now(),user,JSON.stringify(ids));
  }
  schedule(user,organizer,{taxonomy={version:'entities-v1',categories:['uncategorized']}}={}){
    if(!organizer?.profile.enabled||!organizer.profile.egress.approved)return {jobs:[],scanned:0,blocked:true};
    return this.store.memoryTransaction(()=>{
      const after=this.db.prepare('SELECT after_rowid FROM memory_entity_queue_cursor WHERE user_id=?').get(user)?.after_rowid||0;
      const rows=this.db.prepare("SELECT rowid AS cursor_id,* FROM memory_processing_outbox WHERE user_id=? AND job_type='entities' AND state='pending' AND rowid>? ORDER BY rowid LIMIT ?").all(user,after,ENTITY_LIMITS.queue+1);
      const selected=rows.slice(0,ENTITY_LIMITS.queue),groups=new Map();let excluded=0;
      for(const row of selected){const source=this.store.derivedMemory.currentSource(user,row.memory_id);
        if(!source||source.revision!==row.revision){this.db.prepare("UPDATE memory_processing_outbox SET state='stale' WHERE rowid=?").run(row.cursor_id);excluded++;continue;}
        if(!organizer.profile.egress.sensitivities.includes(source.sensitivity)){excluded++;continue;}
        const list=groups.get(source.scope_key)||[];list.push(source);groups.set(source.scope_key,list);
      }
      const configurationRevision=organizer.profile.fingerprint.startsWith('console-')?this.db.prepare("SELECT revision FROM console_models WHERE user_id=? AND kind='organizer'").get(user)?.revision||0:null;
      const jobs=[];for(const [scope,items] of groups){const jobId=this.store.memoryJobs.enqueue({type:'entities',userId:user,scope,profile:organizer.profile.fingerprint,metadata:{prompt_version:'entities-grounded-v1',configuration_revision:configurationRevision,lifecycle_generation:this.store.lifecycle.generation(user),lifecycle_stamp:this.lifecycleStamp(user,items[0].project_id)},items});jobs.push(jobId);
        const state=this.store.memoryJobs.get(jobId).state==='succeeded'?'done':'scheduled';
        for(const s of items)this.db.prepare("UPDATE memory_processing_outbox SET state=? WHERE user_id=? AND memory_id=? AND revision=? AND job_type='entities'").run(state,user,s.memory_id,s.revision);}
      const truncated=rows.length>ENTITY_LIMITS.queue,next=truncated?selected.at(-1).cursor_id:0;
      if(next!==after)this.db.prepare('INSERT INTO memory_entity_queue_cursor VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET after_rowid=excluded.after_rowid WHERE after_rowid<>excluded.after_rowid').run(user,next);
      return {jobs,scanned:selected.length,excluded,truncated,cursor:next||null};
    });
  }
  edgeValid(p,auth){const source=this.get(auth.user_id,p.source_entity_id),target=p.target_entity_id&&this.get(auth.user_id,p.target_entity_id),proof=parse(p.proof_json);
    return source&&target&&source.scope_key===target.scope_key&&this.anchor(source,auth)&&this.anchor(target,auth)&&this.validProof(proof.source,auth)&&this.validProof(proof.target,auth)
      &&!this.tombstone(auth.user_id,'edge',this.objectKey(source),this.objectKey(target));}
  names(e,auth,{search=false}={}){if(!this.anchor(e,auth))return [];const outgoing=this.db.prepare("SELECT 1 FROM memory_entity_proposals WHERE user_id=? AND (source_entity_id=? OR target_entity_id=?) AND target_entity_id IS NOT NULL AND relation='same_entity' AND state='accepted'").get(auth.user_id,e.entity_id,e.entity_id);
    return this.db.prepare('SELECT * FROM memory_entity_names WHERE user_id=? AND entity_id=? ORDER BY name_id LIMIT ?').all(auth.user_id,e.entity_id,ENTITY_LIMITS.names).filter(n=>
      (!search||n.state==='accepted')&&(!isWebReader(auth)||n.origin==='model')&&!(n.origin==='manual'&&outgoing)&&this.validProof(parse(n.proof_json),auth));}
  queryAuthority(auth,scope,options){
    const inventory=this.namingRows(auth.user_id),terms=new Set(),filter=memoryScopeSql(scope,options);
    for(const n of inventory.rows){
      if(isWebReader(auth)&&n.origin!=='model')continue;
      const e=this.get(auth.user_id,n.entity_id),source=e&&this.source(auth.user_id,e.anchor_memory_id,auth);
      if(!source||source.scope_key!==e.scope_key)continue;
      if(!this.db.prepare(`SELECT 1 FROM memories m WHERE m.user_id=? AND m.memory_id=? AND ${filter.sql}`).get(auth.user_id,source.memory_id,...filter.params))continue;
      terms.add(n.normalized);
    }
    return {terms:[...terms],truncated:inventory.truncated};
  }
  /** Search is purely local. A naming overflow fails closed rather than selecting an arbitrary subset. */
  expand(auth,query,scope,options){const inventory=this.namingRows(auth.user_id),empty={matches:new Map(),truncated:inventory.truncated,ambiguous:false,dependency_token:this.dependencyToken(auth)};
    const normalized=normalizedName(query),filter=memoryScopeSql(scope,options),eligible=new Map(),entries=[];
    const inScope=id=>!!this.db.prepare(`SELECT 1 FROM memories m WHERE m.user_id=? AND m.memory_id=? AND ${filter.sql}`).get(auth.user_id,id,...filter.params);
    for(const n of inventory.rows){if(n.state!=='accepted'||isWebReader(auth)&&n.origin!=='model')continue;const e=this.get(auth.user_id,n.entity_id);
      if(!this.anchor(e,auth)||!inScope(e.anchor_memory_id)||!this.validProof(parse(n.proof_json),auth))continue;
      if(n.origin==='manual'&&this.db.prepare("SELECT 1 FROM memory_entity_proposals WHERE user_id=? AND (source_entity_id=? OR target_entity_id=?) AND target_entity_id IS NOT NULL AND relation='same_entity' AND state='accepted'").get(auth.user_id,e.entity_id,e.entity_id))continue;
      eligible.set(e.entity_id,e);entries.push(n);
    }
    // Whole engineering identifiers remain intact: ali does not activate ali-vps or an unrelated path.
    const seeds=entries.filter(n=>n.normalized===normalized||sourceContainsName(normalized,n.normalized));
    const ids=[...new Set(seeds.map(n=>n.entity_id))].sort();empty.ambiguous=ids.length>1;
    if(inventory.truncated)return {...empty,ambiguity_complete:false};
    const termNames=new Set([...searchTokens(query),...entries.filter(n=>ids.includes(n.entity_id)).flatMap(n=>searchTokens(n.normalized))]);
    if(termNames.size>ENTITY_LIMITS.terms)return {...empty,truncated:true};
    const matches=new Map();let truncated=false;
    const add=(entity,seed,bridge=null)=>{if(!entity||!this.anchor(entity,auth)||!inScope(entity.anchor_memory_id))return;
      const names=this.names(entity,auth,{search:true});for(const n of names)for(const term of searchTokens(n.normalized))termNames.add(term);
      if(termNames.size>ENTITY_LIMITS.terms){truncated=true;return;}
      const members=this.db.prepare("SELECT * FROM memory_entity_members WHERE user_id=? AND entity_id=? AND state='accepted' ORDER BY memory_id LIMIT 501").all(auth.user_id,entity.entity_id);if(members.length>500)truncated=true;
      for(const member of members.slice(0,500)){const source=this.validProof(parse(member.proof_json),auth);if(!source||source.scope_key!==entity.scope_key||!inScope(source.memory_id)||!options.statuses.includes(source.status)||!options.memoryTypes.includes(source.memory_type))continue;
        if(this.tombstone(auth.user_id,'member',this.objectKey(entity),member.memory_id))continue;
        if(!matches.has(source.memory_id)){if(matches.size>=500){truncated=true;continue;}matches.set(source.memory_id,{row:source,explanation:{source:'alias',matched_name:seed.name,entity_id:entity.entity_id,proof_memory_id:seed.proof.memory_id,...(bridge?{bridge_id:bridge.proposal_id}:{})}});}}
    };
    for(const id of ids){const e=eligible.get(id),n=seeds.find(n=>n.entity_id===id),seed={name:n.name,proof:parse(n.proof_json)};add(e,seed);
      const bridges=this.db.prepare("SELECT * FROM memory_entity_proposals WHERE user_id=? AND (source_entity_id=? OR target_entity_id=?) AND target_entity_id IS NOT NULL AND relation='same_entity' AND state='accepted' ORDER BY proposal_id LIMIT 501").all(auth.user_id,id,id);
      if(bridges.length>500)truncated=true;
      for(const p of bridges.slice(0,500)){if(!this.edgeValid(p,auth))continue;const other=this.get(auth.user_id,p.source_entity_id===id?p.target_entity_id:p.source_entity_id);add(other,seed,p);}}
    return {...empty,matches:truncated?new Map():matches,truncated,dependency_token:digest([empty.dependency_token,entries.map(n=>n.name_id),[...matches].map(([id,m])=>[id,m.explanation])])};
  }
  dependencyToken(auth){return digest(['entity-search-v1',auth.user_id,ownerEpoch(this.db,auth.user_id),globalEpoch(this.db),this.store.lifecycle.generation(auth.user_id)]);}
}

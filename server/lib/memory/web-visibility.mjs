import {createHash} from 'node:crypto';
import {ConflictError,NotFoundError,ValidationError} from '../errors.mjs';

export const WEB_READ_POLICY = 'web-memory-visibility-v1';
export const isWebReader = auth => auth?.agent_id === 'chatgpt-web';

// Destination comes from the authenticated credential, never from a tool argument or header.
export function webMemorySql(auth, alias='m') {
  if (!isWebReader(auth)) return '1=1';
  return `(EXISTS (SELECT 1 FROM memory_privacy wp WHERE wp.user_id=${alias}.user_id AND wp.memory_id=${alias}.memory_id AND wp.sensitivity='public')
    OR (COALESCE((SELECT sensitivity FROM memory_privacy wp WHERE wp.user_id=${alias}.user_id AND wp.memory_id=${alias}.memory_id),'sensitive') IN ('internal','sensitive')
      AND EXISTS (SELECT 1 FROM memory_web_grants wg JOIN memory_revisions wr
        ON wr.user_id=wg.user_id AND wr.memory_id=wg.memory_id AND wr.revision=wg.revision AND wr.state_hash=wg.state_hash
        WHERE wg.user_id=${alias}.user_id AND wg.memory_id=${alias}.memory_id
        AND wg.sensitivity=COALESCE((SELECT sensitivity FROM memory_privacy wp WHERE wp.user_id=${alias}.user_id AND wp.memory_id=${alias}.memory_id),'sensitive')
        AND wr.content=${alias}.content AND wr.status=${alias}.status
        AND wr.revision=(SELECT MAX(revision) FROM memory_revisions WHERE user_id=wg.user_id AND memory_id=wg.memory_id))))`;
}

export class WebMemoryVisibility {
  constructor(store) {
    this.store=store;this.db=store.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_web_grants (user_id TEXT NOT NULL,memory_id TEXT NOT NULL,
      revision INTEGER NOT NULL,state_hash TEXT NOT NULL,sensitivity TEXT NOT NULL,PRIMARY KEY(user_id,memory_id));
      CREATE TRIGGER IF NOT EXISTS memory_web_revoke_privacy_insert AFTER INSERT ON memory_privacy BEGIN
        DELETE FROM memory_web_grants WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id; END;
      CREATE TRIGGER IF NOT EXISTS memory_web_revoke_privacy_update AFTER UPDATE ON memory_privacy BEGIN
        DELETE FROM memory_web_grants WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id; END;
      CREATE TRIGGER IF NOT EXISTS memory_web_revoke_revision AFTER INSERT ON memory_revisions BEGIN
        DELETE FROM memory_web_grants WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id; END;
      CREATE TRIGGER IF NOT EXISTS memory_web_revoke_change AFTER UPDATE ON memories BEGIN
        DELETE FROM memory_web_grants WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id; END;`);
  }
  visible(auth,id) {
    return !!this.db.prepare(`SELECT 1 FROM memories m WHERE m.user_id=? AND m.memory_id=? AND ${webMemorySql(auth)}`).get(auth.user_id,id);
  }
  project(auth,memory) {
    const revision=this.db.prepare('SELECT MAX(revision) revision FROM memory_revisions WHERE user_id=? AND memory_id=?').get(auth.user_id,memory.memory_id)?.revision;
    return webMemoryProjection({...memory,revision:revision ?? null});
  }
  list(auth,{limit=20,after}={}) {
    this.store.requireScope(auth,'admin:tasks');
    if(!Number.isSafeInteger(limit) || limit<1 || limit>100 || (after!==undefined && (typeof after!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(after))))throw new ValidationError('Invalid grant inventory page.');
    const rows=this.db.prepare('SELECT memory_id FROM memory_web_grants WHERE user_id=? AND memory_id>? ORDER BY memory_id LIMIT ?').all(auth.user_id,after || '',limit+1);
    const grants=rows.slice(0,limit).map(row=>this.inspect(auth,row.memory_id));
    return {grants,selection:'explicit_grants_only',public_records_not_listed:true,content_returned:false,
      next_request:rows.length>limit?{limit,after:grants.at(-1).memory_id}:null};
  }
  inspect(auth,id) {
    this.store.requireScope(auth,'admin:tasks');
    const current=this.store.revisions.latest(auth.user_id,id);
    if(!current)throw new NotFoundError('Memory not found.','MEMORY_NOT_FOUND');
    const sensitivity=this.db.prepare('SELECT sensitivity FROM memory_privacy WHERE user_id=? AND memory_id=?').get(auth.user_id,id)?.sensitivity || 'sensitive';
    return {memory_id:id,revision:current.revision,state_hash:current.state_hash,sensitivity,
      allowed:this.visible({...auth,agent_id:'chatgpt-web'},id),content_returned:false,policy:WEB_READ_POLICY};
  }
  set(auth,id,{allow,revision,state_hash}={}) {
    this.store.requireScope(auth,'admin:tasks');
    if(typeof allow!=='boolean')throw new ValidationError('Explicit allow or deny is required.');
    return this.store.memoryTransaction(()=>{
      const current=this.store.revisions.latest(auth.user_id,id);
      if(!current)throw new NotFoundError('Memory not found.','MEMORY_NOT_FOUND');
      if(!Number.isSafeInteger(revision) || current.revision!==revision || current.state_hash!==state_hash)
        throw new ConflictError('Approval must match the reviewed revision and state hash.','MEMORY_VERSION_CHANGED');
      const sensitivity=this.db.prepare('SELECT sensitivity FROM memory_privacy WHERE user_id=? AND memory_id=?').get(auth.user_id,id)?.sensitivity || 'sensitive';
      if(sensitivity==='public')throw new ValidationError('Public classification is already visible; change its classification locally to restrict it.','WEB_VISIBILITY_DENIED');
      if(allow && !['internal','sensitive'].includes(sensitivity))throw new ValidationError('Only internal/sensitive records need grants; secret is never eligible.','WEB_VISIBILITY_DENIED');
      if(allow)this.db.prepare('INSERT OR REPLACE INTO memory_web_grants VALUES (?,?,?,?,?)').run(auth.user_id,id,revision,state_hash,sensitivity);
      else this.db.prepare('DELETE FROM memory_web_grants WHERE user_id=? AND memory_id=?').run(auth.user_id,id);
      this.store.audit({auth,action:'memory.web_visibility',targetType:'memory',targetId:id,metadata:{allow,revision}});
      return {memory_id:id,revision,allowed:allow,policy:WEB_READ_POLICY};
    });
  }
}

export function webMemoryProjection(memory) {
  const fields=['memory_id','revision','content','status','memory_type','created_at','updated_at','content_truncated','content_length','content_length_unit','detail_available','ranking'];
  return {...Object.fromEntries(fields.filter(key=>memory[key]!==undefined).map(key=>[key,memory[key]])),
    provenance:{source_preserved:true,details_omitted:true},independently_fact_checked:false};
}
export function webSourceProjection(source) {
  return {source_id:createHash('sha256').update(String(source.source_id)).digest('hex'),source_kind:source.source_kind,
    source_status:source.source_status,source_revision:source.source_revision,span_available:source.span_available};
}

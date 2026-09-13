import {hash} from './revisions.mjs';
import {integer,fail} from '../model-providers/contracts.mjs';

export class MemorySources {
  constructor(store){this.store=store;this.db=store.db;this.db.exec(`CREATE TABLE IF NOT EXISTS memory_source_pins
    (user_id TEXT NOT NULL,event_id TEXT NOT NULL,pin_id TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,event_id,pin_id));
    CREATE INDEX IF NOT EXISTS memory_source_pin_event ON memory_source_pins(user_id,event_id);`);}
  manifest(auth,{task_id,workstream_id,session_id,after=0,highwater,limit=20}={}){
    this.store.requireScope(auth,'memory:sources:read');integer(after,0,Number.MAX_SAFE_INTEGER);integer(limit,1,100);
    if(!task_id || !workstream_id || !session_id || [task_id,workstream_id,session_id].some(s=>typeof s!=='string' || s.length>200))fail('EXACT_SOURCE_SCOPE_REQUIRED');
    const high=highwater===undefined?this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM events').get().n:integer(highwater,0,Number.MAX_SAFE_INTEGER);
    const params=[auth.user_id,task_id,workstream_id,session_id];
    const query='FROM events WHERE user_id=? AND task_id=? AND workstream_id=? AND session_id=? AND rowid<=?';
    const total=this.db.prepare('SELECT COUNT(*) AS n '+query).get(...params,high).n;
    const rows=this.db.prepare('SELECT rowid AS cursor_id,event_id,event_type,content,expires_at,expired_at '+query+' AND rowid>? ORDER BY rowid LIMIT ?').all(...params,high,after,limit+1);
    return {kind:'source_manifest',read_only:true,content_complete:false,total,highwater:high,entries:rows.slice(0,limit).map(r=>{
      const pinned=!!this.db.prepare('SELECT 1 FROM memory_source_pins WHERE user_id=? AND event_id=?').get(auth.user_id,r.event_id);
      const available=r.content!==null && !r.expired_at && (pinned || !r.expires_at || Date.parse(r.expires_at)>Date.now());
      return {event_id:r.event_id,event_type:r.event_type,hash:r.content===null?null:hash(r.content),utf8_bytes:r.content===null?null:Buffer.byteLength(r.content),
        unicode_length:r.content===null?null:Array.from(r.content).length,availability:available?'available':r.content===null?'unavailable':'expired',pinned};}),
      next_after:rows.length>limit?rows[limit-1].cursor_id:null};
  }
  content(auth,eventId,{offset=0,limit=4096}={}){
    this.store.requireScope(auth,'memory:sources:read');integer(offset,0,Number.MAX_SAFE_INTEGER);integer(limit,1,16384);
    const row=this.db.prepare('SELECT content,expires_at,expired_at FROM events WHERE user_id=? AND event_id=?').get(auth.user_id,eventId);
    const pinned=!!this.db.prepare('SELECT 1 FROM memory_source_pins WHERE user_id=? AND event_id=?').get(auth.user_id,eventId);
    if(!row || row.content===null || row.expired_at || !pinned && row.expires_at && Date.parse(row.expires_at)<=Date.now())return {event_id:eventId,availability:'unavailable',content:null,content_complete:false};
    const chars=Array.from(row.content),slice=chars.slice(offset,offset+limit).join('');
    return {event_id:eventId,availability:'available',content:slice,offset,length:chars.length,unit:'unicode_code_points',content_hash:hash(row.content),utf8_bytes:Buffer.byteLength(row.content),
      content_complete:offset===0 && offset+limit>=chars.length,next_offset:offset+limit<chars.length?offset+limit:null};
  }
  pin(auth,{event_ids,pin_id,reason='explicit_source_retention'}={}){
    this.store.requireScope(auth,'memory:retention');
    if(!Array.isArray(event_ids) || !event_ids.length || event_ids.length>1000 || typeof pin_id!=='string' || pin_id.length>200 || !pin_id || typeof reason!=='string' || reason.length>200)fail('INVALID_PIN');
    return this.store.memoryTransaction(()=>{
      for(const id of event_ids){const row=this.db.prepare('SELECT content,expired_at FROM events WHERE user_id=? AND event_id=?').get(auth.user_id,id);if(!row || row.content===null || row.expired_at)fail('SOURCE_UNAVAILABLE');}
      for(const id of event_ids)this.db.prepare('INSERT OR IGNORE INTO memory_source_pins VALUES (?,?,?,?,?)').run(auth.user_id,id,pin_id,reason,new Date().toISOString());
      this.store.audit({auth,action:'memory.source.pin',targetType:'source_pin',targetId:pin_id,metadata:{count:event_ids.length}});return {pinned:event_ids.length};
    });
  }
  unpin(auth,pinId){this.store.requireScope(auth,'memory:retention');const result=this.db.prepare('DELETE FROM memory_source_pins WHERE user_id=? AND pin_id=?').run(auth.user_id,pinId);return {unpinned:result.changes};}
  setSensitivity(auth,id,value){
    this.store.requireScope(auth,'memory:retention');if(!['public','internal','sensitive','secret'].includes(value) || !this.db.prepare('SELECT 1 FROM memories WHERE user_id=? AND memory_id=?').get(auth.user_id,id))fail('INVALID_PRIVACY_TARGET');
    return this.store.memoryTransaction(()=>{
      this.db.prepare('INSERT INTO memory_privacy VALUES (?,?,?) ON CONFLICT(user_id,memory_id) DO UPDATE SET sensitivity=excluded.sensitivity').run(auth.user_id,id,value);
      this.db.prepare("UPDATE memory_processing_outbox SET state='blocked_config' WHERE user_id=? AND memory_id=?").run(auth.user_id,id);
      this.db.prepare("UPDATE memory_index_outbox SET state='pending',action=? WHERE user_id=? AND memory_id=?").run(value==='secret'?'hide':'upsert',auth.user_id,id);
      this.store.audit({auth,action:'memory.sensitivity.set',targetType:'memory',targetId:id,metadata:{sensitivity:value}});return {sensitivity:value};
    });
  }
  privacyImpact(auth,memoryIds){
    this.store.requireScope(auth,'memory:retention');if(!Array.isArray(memoryIds) || !memoryIds.length || memoryIds.length>1000 || memoryIds.some(s=>typeof s!=='string'))fail('INVALID_PURGE_SELECTION');
    const ids=[...new Set(memoryIds)];let atomic=0,revisions=0,summaries=new Set(),points=0,jobs=new Set();
    const vector=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_vector_points'").get();
    for(const id of ids){if(!this.db.prepare('SELECT 1 FROM memories WHERE user_id=? AND memory_id=?').get(auth.user_id,id))fail('MEMORY_NOT_FOUND');atomic++;
      revisions+=this.db.prepare('SELECT COUNT(*) AS n FROM memory_revisions WHERE user_id=? AND memory_id=?').get(auth.user_id,id).n;
      for(const r of this.db.prepare('SELECT summary_id FROM memory_summary_dependencies WHERE user_id=? AND memory_id=?').all(auth.user_id,id))summaries.add(r.summary_id);
      for(const r of this.db.prepare('SELECT job_id FROM memory_job_items WHERE user_id=? AND memory_id=?').all(auth.user_id,id))jobs.add(r.job_id);
      if(vector)points+=this.db.prepare('SELECT COUNT(*) AS n FROM memory_vector_points WHERE user_id=? AND memory_id=?').get(auth.user_id,id).n;
    }
    return {dry_run:true,atomic_records:atomic,revisions,summaries:summaries.size,known_vector_points:points,job_result_sets:jobs.size,
      raw_sources:'may_be_shared_requires_explicit_source_review',cache:'no_body_cache_in_memory_first_modules',backups:'not_inspected_or_physically_erased',
      exports_and_provider_copies:'outside_authority_not_erased',physical_erasure_performed:false};
  }
}

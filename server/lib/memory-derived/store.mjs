import {digest,fail,strictObject,text} from '../model-providers/contracts.mjs';
import {hash as digestText} from '../memory/revisions.mjs';

export const scopeKey = row => JSON.stringify([row.user_id,row.scope,row.project_id || null,row.task_id || null,row.workstream_id || null,row.session_id || null]);
export class DerivedMemory {
  constructor(store) {this.store=store;this.db=store.db;this.migrate();}
  migrate(){this.db.exec(`
    CREATE TABLE IF NOT EXISTS memory_privacy (user_id TEXT NOT NULL,memory_id TEXT NOT NULL,sensitivity TEXT NOT NULL DEFAULT 'sensitive',PRIMARY KEY(user_id,memory_id));
    CREATE TABLE IF NOT EXISTS memory_annotations (user_id TEXT NOT NULL,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,taxonomy_version TEXT NOT NULL,
      category TEXT NOT NULL,tags_json TEXT NOT NULL,suggestion TEXT,profile TEXT NOT NULL,job_id TEXT NOT NULL,PRIMARY KEY(user_id,memory_id,revision,taxonomy_version));
    CREATE TABLE IF NOT EXISTS memory_category_overrides (user_id TEXT NOT NULL,memory_id TEXT NOT NULL,category TEXT NOT NULL,locked INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(user_id,memory_id));
    CREATE TABLE IF NOT EXISTS memory_summaries (summary_id TEXT PRIMARY KEY,group_key TEXT NOT NULL,revision INTEGER NOT NULL,user_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,category TEXT NOT NULL,window_json TEXT NOT NULL,status TEXT NOT NULL,profile TEXT NOT NULL,job_id TEXT NOT NULL UNIQUE,
      coverage INTEGER NOT NULL,omitted INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(group_key,revision));
    CREATE INDEX IF NOT EXISTS memory_summary_current ON memory_summaries(user_id,scope_key,status);
    CREATE TABLE IF NOT EXISTS memory_summary_claims (summary_id TEXT NOT NULL,ordinal INTEGER NOT NULL,claim_json TEXT NOT NULL,PRIMARY KEY(summary_id,ordinal));
    CREATE TABLE IF NOT EXISTS memory_summary_dependencies (summary_id TEXT NOT NULL,user_id TEXT NOT NULL,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,state_hash TEXT NOT NULL,
      scope_key TEXT NOT NULL,PRIMARY KEY(summary_id,user_id,memory_id));
    CREATE INDEX IF NOT EXISTS memory_summary_dep_memory ON memory_summary_dependencies(user_id,memory_id);
    CREATE TABLE IF NOT EXISTS memory_derived_outbox (summary_id TEXT PRIMARY KEY,action TEXT NOT NULL,state TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS memory_summary_invalidate_revision AFTER INSERT ON memory_revisions BEGIN
      UPDATE memory_summaries SET status='stale' WHERE status='current' AND summary_id IN
        (SELECT summary_id FROM memory_summary_dependencies WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id AND revision<>NEW.revision);
      INSERT OR REPLACE INTO memory_derived_outbox SELECT summary_id,'hide','pending' FROM memory_summary_dependencies
        WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id AND revision<>NEW.revision;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_summary_invalidate_privacy AFTER INSERT ON memory_privacy BEGIN
      UPDATE memory_summaries SET status='stale' WHERE summary_id IN (SELECT summary_id FROM memory_summary_dependencies WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id);
      INSERT OR REPLACE INTO memory_derived_outbox SELECT summary_id,'hide','pending' FROM memory_summary_dependencies WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_summary_invalidate_privacy_update AFTER UPDATE ON memory_privacy BEGIN
      UPDATE memory_summaries SET status='stale' WHERE summary_id IN (SELECT summary_id FROM memory_summary_dependencies WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id);
      INSERT OR REPLACE INTO memory_derived_outbox SELECT summary_id,'hide','pending' FROM memory_summary_dependencies WHERE user_id=NEW.user_id AND memory_id=NEW.memory_id;
    END;
  `);}
  currentSource(user,id){
    const row=this.db.prepare(`SELECT m.*,COALESCE(p.sensitivity,'sensitive') AS sensitivity FROM memories m LEFT JOIN memory_privacy p
      ON p.user_id=m.user_id AND p.memory_id=m.memory_id WHERE m.user_id=? AND m.memory_id=?`).get(user,id);
    if(!row || row.status!=='active' || row.sensitivity==='secret')return null;
    const revision=this.store.revisions.latest(user,id);
    if(!revision || revision.status!=='active' || revision.content_hash!==digestText(row.content))return null;
    const captured=this.db.prepare(`SELECT s.content_hash,e.content,e.expires_at,e.expired_at,e.event_id FROM memory_source_links l JOIN memory_sources s
      ON s.user_id=l.user_id AND s.source_id=l.source_id LEFT JOIN events e ON e.user_id=s.user_id AND e.event_id=s.source_event_id
      WHERE l.user_id=? AND l.memory_id=? AND l.revision=? AND s.source_kind='captured_event'`).all(user,id,revision.revision);
    if(captured.some(source=>source.content===null || source.content===undefined || source.expired_at || digestText(source.content)!==source.content_hash ||
      source.expires_at && Date.parse(source.expires_at)<=Date.now() && !this.db.prepare('SELECT 1 FROM memory_source_pins WHERE user_id=? AND event_id=?').get(user,source.event_id)))return null;
    const override=this.db.prepare('SELECT category,locked FROM memory_category_overrides WHERE user_id=? AND memory_id=?').get(user,id);
    return {...row,revision:revision.revision,state_hash:digest([revision.state_hash,row.sensitivity,override || null]),evidence_kind:revision.evidence_kind,scope_key:scopeKey(row)};
  }
  validateItem(item){const row=this.currentSource(item.user_id,item.memory_id);return row && row.revision===item.revision && row.state_hash===item.state_hash && row.scope_key===item.scope_key?row:null;}
  taxonomy(input){
    strictObject(input,['version','categories']);text(input.version);
    if(!Array.isArray(input.categories) || !input.categories.length || input.categories.length>64 || new Set(input.categories).size!==input.categories.length)fail('INVALID_TAXONOMY');
    for(const id of input.categories)if(typeof id!=='string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id))fail('INVALID_TAXONOMY');
    if(!input.categories.includes('uncategorized'))fail('INVALID_TAXONOMY');return input;
  }
  category(row,taxonomyVersion){
    const override=this.db.prepare('SELECT category FROM memory_category_overrides WHERE user_id=? AND memory_id=? AND locked=1').get(row.user_id,row.memory_id);
    return override?.category || this.db.prepare('SELECT category FROM memory_annotations WHERE user_id=? AND memory_id=? AND revision=? AND taxonomy_version=?')
      .get(row.user_id,row.memory_id,row.revision,taxonomyVersion)?.category || 'uncategorized';
  }
  setCategory(auth,id,category,taxonomy){
    this.store.requireScope(auth,'memory:organize');this.taxonomy(taxonomy);
    if(!taxonomy.categories.includes(category) || !this.currentSource(auth.user_id,id))fail('INVALID_CATEGORY_TARGET');
    return this.store.memoryTransaction(()=>{
      this.db.prepare('INSERT OR REPLACE INTO memory_category_overrides VALUES (?,?,?,1)').run(auth.user_id,id,category);
      this.db.prepare("UPDATE memory_summaries SET status='stale' WHERE summary_id IN (SELECT summary_id FROM memory_summary_dependencies WHERE user_id=? AND memory_id=?)").run(auth.user_id,id);
      this.db.prepare("INSERT OR REPLACE INTO memory_derived_outbox SELECT summary_id,'hide','pending' FROM memory_summary_dependencies WHERE user_id=? AND memory_id=?").run(auth.user_id,id);
      this.store.audit({auth,action:'memory.category.set',targetType:'memory',targetId:id,metadata:{locked:true}});return {locked:true,category};
    });
  }
  publishAnnotations(job,items,outputs){
    const taxonomy=job.metadata.taxonomy;this.taxonomy(taxonomy);
    if(outputs.length!==items.length || new Set(outputs.map(o=>o.memory_id)).size!==items.length)fail('INVALID_SOURCE_SET');
    const byId=new Map(items.map(item=>[item.memory_id,item]));
    for(const output of outputs){
      const item=byId.get(output.memory_id);if(!item || !this.validateItem(item))fail('STALE_INPUT');
      const known=taxonomy.categories.includes(output.category);
      const previous=this.db.prepare('SELECT category FROM memory_annotations WHERE user_id=? AND memory_id=? AND revision=? AND taxonomy_version=?').get(item.user_id,item.memory_id,item.revision,taxonomy.version);
      if(previous && previous.category!==(known?output.category:'uncategorized')){
        this.db.prepare("UPDATE memory_summaries SET status='stale' WHERE summary_id IN (SELECT summary_id FROM memory_summary_dependencies WHERE user_id=? AND memory_id=?)").run(item.user_id,item.memory_id);
        this.db.prepare("INSERT OR REPLACE INTO memory_derived_outbox SELECT summary_id,'hide','pending' FROM memory_summary_dependencies WHERE user_id=? AND memory_id=?").run(item.user_id,item.memory_id);
      }
      this.db.prepare('INSERT OR REPLACE INTO memory_annotations VALUES (?,?,?,?,?,?,?,?,?)').run(item.user_id,item.memory_id,item.revision,taxonomy.version,
        known?output.category:'uncategorized',JSON.stringify(output.tags),known?null:output.category,job.profile,job.job_id);
    }
  }
  publishSummary(job,items,claims,now){
    for(const item of items){const source=this.validateItem(item);if(!source || this.category(source,job.metadata.taxonomy.version)!==job.metadata.category)fail('STALE_INPUT');}
    const {category,window}=job.metadata,revision=this.db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS n FROM memory_summaries WHERE group_key=?').get(job.group_key).n;
    const summaryId=digest(['summary',job.job_id]);
    this.db.prepare("UPDATE memory_summaries SET status='superseded' WHERE group_key=? AND status='current'").run(job.group_key);
    this.db.prepare('INSERT INTO memory_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(summaryId,job.group_key,revision,job.user_id,job.scope_key,category,JSON.stringify(window),
      'current',job.profile,job.job_id,items.length,items.length-new Set(claims.map(c=>c.memory_id)).size,new Date(now).toISOString());
    for(const [i,claim] of claims.entries())this.db.prepare('INSERT INTO memory_summary_claims VALUES (?,?,?)').run(summaryId,i,JSON.stringify(claim));
    for(const item of items)this.db.prepare('INSERT INTO memory_summary_dependencies VALUES (?,?,?,?,?,?)').run(summaryId,item.user_id,item.memory_id,item.revision,item.state_hash,item.scope_key);
    this.db.prepare('INSERT OR REPLACE INTO memory_derived_outbox VALUES (?,?,?)').run(summaryId,'upsert','disabled');
    return summaryId;
  }
  summaries(user,scope,{limit=20,offset=0}={}){
    if(!Number.isInteger(limit) || limit<1 || limit>50 || !Number.isInteger(offset) || offset<0)fail('INVALID_PAGINATION');
    const rows=this.db.prepare("SELECT * FROM memory_summaries WHERE user_id=? AND scope_key=? AND status='current' ORDER BY created_at DESC,summary_id LIMIT ? OFFSET ?").all(user,scope,limit+1,offset);
    const visible=[];
    for(const summary of rows.slice(0,limit)){
      const deps=this.db.prepare('SELECT * FROM memory_summary_dependencies WHERE summary_id=?').all(summary.summary_id);
      const metadata=JSON.parse(this.db.prepare('SELECT metadata_json FROM memory_jobs WHERE job_id=?').get(summary.job_id)?.metadata_json || '{}');
      if(!deps.length || deps.some(d=>{const s=this.validateItem(d);return !s || this.category(s,metadata.taxonomy?.version)!==summary.category;}))continue;
      const claims=this.db.prepare('SELECT claim_json FROM memory_summary_claims WHERE summary_id=? ORDER BY ordinal LIMIT 101').all(summary.summary_id).map(c=>JSON.parse(c.claim_json));
      const selected=new Set(this.db.prepare("SELECT DISTINCT json_extract(claim_json,'$.memory_id') AS memory_id FROM memory_summary_claims WHERE summary_id=?").all(summary.summary_id).map(row=>row.memory_id));
      const omitted=deps.filter(dependency=>!selected.has(dependency.memory_id));
      visible.push({...summary,kind:'derived_summary',independently_fact_checked:false,claims:claims.slice(0,100),claims_truncated:claims.length>100,dependency_count:deps.length,
        coverage_status:omitted.length?'partial':'complete',selected_source_count:deps.length-omitted.length,omitted_source_count:omitted.length,
        omitted_sources:omitted.slice(0,100).map(({memory_id,revision})=>({memory_id,revision})),omitted_sources_truncated:omitted.length>100});
    }
    return {results:visible,next_offset:rows.length>limit?offset+limit:null,read_only:true};
  }
}

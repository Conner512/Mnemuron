import {ValidationError} from '../errors.mjs';
import {protectTables} from '../lifecycle/protection.mjs';
import {resolveMemoryScope} from '../memory-scope.mjs';
import {staleSql,staleReasons} from '../memory/review.mjs';
import {MEMORY_KINDS} from '../memory/traits.mjs';

// The memory library's reads: the validated filter, the owner-scoped rows and the browsing facets.
// Memories are filed by their writer-chosen type (memory_traits). Category writes (organize, classify, category
// management) were retired; their tables and the stored categories stay for history and older summaries.
export const ORGANIZE_LIMIT=2000;
const MEMORY_TYPES=['fact','goal','constraint','decision','completed','blocker','remaining','next_step'];
const ORIGINS=['imported','other'];

// Current category per memory: a locked manual override wins, then the model annotation of the
// latest revision under the account's taxonomy version, otherwise uncategorized. Only live memories (no project, or
// an owned project that is not deleted) take part: every library, facet, preview and organize read goes through here.
// Parameters: taxonomy version, user, then the live filter's own parameters.
export const categorySql=live=>`SELECT m.memory_id,COALESCE(o.category,a.category,'uncategorized') category FROM memories m
  LEFT JOIN memory_category_overrides o ON o.user_id=m.user_id AND o.memory_id=m.memory_id AND o.locked=1
  LEFT JOIN memory_annotations a ON a.user_id=m.user_id AND a.memory_id=m.memory_id AND a.taxonomy_version=?
    AND a.revision=(SELECT MAX(revision) FROM memory_revisions WHERE user_id=m.user_id AND memory_id=m.memory_id)
  WHERE m.user_id=? AND ${live.sql}`;

const conceptList=raw=>{try{const v=JSON.parse(raw||'[]');return Array.isArray(v)?v.filter(c=>typeof c==='string').slice(0,8):[];}catch{return [];}};

export class ConsoleOrganizer {
  constructor(service){
    this.service=service;this.store=service.store;this.db=service.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS console_organize_batches(user_id TEXT NOT NULL,batch_id TEXT NOT NULL,kind TEXT NOT NULL,category TEXT NOT NULL,
        detail_json TEXT NOT NULL,matched INTEGER NOT NULL,changed INTEGER NOT NULL,created_at TEXT NOT NULL,undone_at TEXT,PRIMARY KEY(user_id,batch_id));
      CREATE INDEX IF NOT EXISTS console_organize_batches_recent ON console_organize_batches(user_id,created_at);
      CREATE TABLE IF NOT EXISTS console_organize_items(user_id TEXT NOT NULL,batch_id TEXT NOT NULL,memory_id TEXT NOT NULL,prior_category TEXT,applied_category TEXT NOT NULL,
        PRIMARY KEY(user_id,batch_id,memory_id));
      CREATE TABLE IF NOT EXISTS console_import_records(user_id TEXT NOT NULL,memory_id TEXT NOT NULL,original_created_at TEXT,imported_at TEXT NOT NULL,PRIMARY KEY(user_id,memory_id));`);
    protectTables(this.db,['console_organize_batches','console_organize_items']);
  }
  taxonomy(user){return this.service.taxonomy(user);}
  /** The owner's authoritative lifecycle filter for one Console request (normal views are live-only). */
  live(user){return this.store.lifecycle.live(user);}
  /** categorySql with its parameters for this owner. */
  categories(user,live=this.live(user)){const filter=live.sql('m.project_id');return {sql:categorySql(filter),params:[this.taxonomy(user).version,user,...filter.params]};}

  /** Validated filter shared by the library list, the facets, the preview and the apply step. */
  filter(user,p){
    const f={};
    if(p.query!==undefined){if(typeof p.query!=='string'||p.query.length>2000)throw new ValidationError('Invalid query.');if(p.query.trim())f.query=p.query;}
    if(p.kind!==undefined&&p.kind!==''){if(![...MEMORY_KINDS,'none'].includes(p.kind))throw new ValidationError('Invalid kind.');f.kind=p.kind;}
    if(p.topic!==undefined&&p.topic!==''){if(typeof p.topic!=='string'||p.topic.length>200)throw new ValidationError('Invalid topic.');f.topic=p.topic;}
    if(p.concept!==undefined&&p.concept!==''){if(typeof p.concept!=='string'||[...p.concept].length>40)throw new ValidationError('Invalid concept.');f.concept=p.concept;}
    if(p.origin!==undefined&&p.origin!==''){if(!ORIGINS.includes(p.origin))throw new ValidationError('Invalid origin.');f.origin=p.origin;}
    if(p.status!==undefined&&p.status!==''){if(!['active','superseded','retracted'].includes(p.status))throw new ValidationError('Invalid status.');f.status=p.status;}
    // Cleanup review (memory/review.mjs) lists active memories only.
    if(p.review!==undefined&&p.review!==''){if(p.review!=='stale')throw new ValidationError('Invalid review.');f.review='stale';f.status='active';}
    return f;
  }
  /** Rows matching a filter, newest first (or search rank). Candidate windows are bounded and say so. */
  rows(auth,f,{ids,ranked,limit=ORGANIZE_LIMIT+1,offset=0,count=false}={}){
    const user=auth.user_id,live=this.live(user),categories=this.categories(user,live);let order=ranked||null,truncated=false,total,plan=null,aliases=null,dependencyToken=null,matchById=new Map();
    if(ranked)ids=ids?ids.filter(x=>ranked.includes(x)):ranked;
    if(f.query){
      // The search window is cut after the live filter, so deleted-project records never take candidate slots.
      const scope=resolveMemoryScope(this.db,user,{},{lifecycle:this.store.lifecycle});
      const found=this.store.memorySearch.candidates(user,f.query,scope,{auth,statuses:f.status?[f.status]:['active','superseded','retracted'],memoryTypes:MEMORY_TYPES});
      truncated=found.truncated===true;plan=found.plan;aliases=found.aliases;dependencyToken=found.dependency_token;matchById=new Map(found.rows.map(r=>[r.memory_id,r._entity_match]));order=found.rows.map(r=>r.memory_id);
      // Memories whose keywords contain the query join the result after the text matches (bounded, owner scoped).
      const extra=this.conceptMatches(user,f.query).filter(x=>!order.includes(x));order=[...order,...extra];
      ids=ids?ids.filter(x=>order.includes(x)):order;
    }
    const now=Date.now(),stale=f.review==='stale'?staleSql(now):null;
    // Writer-chosen traits (kind, concepts, strength) and the project name ride along for the library row; 'none' filters unmarked records.
    const sql=`SELECT m.memory_id,m.content,m.memory_type,m.status,m.topic,m.created_at,m.project_id,c.category,
        t.kind,t.concepts_json,t.strength,t.updated_at traits_updated_at,p.name project_name,
        (SELECT MAX(revision) FROM memory_revisions r WHERE r.user_id=m.user_id AND r.memory_id=m.memory_id) revision,
        m.source LIKE 'user_import:%' imported,i.original_created_at
      FROM memories m JOIN (${categories.sql}) c ON c.memory_id=m.memory_id
      LEFT JOIN console_import_records i ON i.user_id=m.user_id AND i.memory_id=m.memory_id
      LEFT JOIN memory_traits t ON t.user_id=m.user_id AND t.memory_id=m.memory_id
      LEFT JOIN projects p ON p.user_id=m.user_id AND p.project_id=m.project_id
      WHERE m.user_id=? AND (? IS NULL OR m.status=?) AND (? IS NULL OR c.category=?) AND (? IS NULL OR m.topic=?)
        AND (? IS NULL OR COALESCE(t.kind,'none')=?)
        AND (? IS NULL OR EXISTS (SELECT 1 FROM json_each(COALESCE(t.concepts_json,'[]')) c WHERE lower(c.value)=lower(?)))
        AND (? IS NULL OR (m.source LIKE 'user_import:%')=(?='imported'))
        ${stale?`AND ${stale.sql}`:''}
        AND (? IS NULL OR m.memory_id IN (SELECT value FROM json_each(?)))`;
    const args=[...categories.params,user,f.status??null,f.status??null,null,null,f.topic??null,f.topic??null,f.kind??null,f.kind??null,f.concept??null,f.concept??null,
      f.origin??null,f.origin??null,...(stale?stale.params:[]),ids?'1':null,ids?JSON.stringify(ids):null];
    let rows;
    if(order){
      // Keep search rank; the candidate window is already bounded by the search.
      const byId=new Map(this.db.prepare(sql).all(...args).map(r=>[r.memory_id,r])),all=ids.map(x=>byId.get(x)).filter(Boolean);
      rows=all.slice(offset,offset+limit);if(count)total=all.length;
    }else{rows=this.db.prepare(sql+' ORDER BY m.created_at DESC,m.rowid DESC LIMIT ? OFFSET ?').all(...args,limit,offset);
      if(count)total=rows.length<limit&&offset===0?rows.length:this.db.prepare(`SELECT COUNT(*) n FROM (${sql})`).get(...args).n;}
    const reasons=stale?staleReasons(this.db,user,rows,now):null;
    return {rows:rows.map(({concepts_json,...r})=>({...r,concepts:conceptList(concepts_json),imported:r.imported===1,...(matchById.has(r.memory_id)?{ranking:matchById.get(r.memory_id)}:{}),...(reasons?{review:reasons.get(r.memory_id)}:{})})),truncated,plan,aliases,dependencyToken,...(count?{total}:{})};
  }
  /** Memory IDs whose keywords contain the query (case-insensitive), newest first, at most 200. */
  conceptMatches(user,query){const q=String(query).trim();if(!q||[...q].length>40)return [];
    return this.db.prepare(`SELECT DISTINCT t.memory_id FROM memory_traits t JOIN memories m ON m.user_id=t.user_id AND m.memory_id=t.memory_id, json_each(t.concepts_json) c
      WHERE t.user_id=? AND instr(lower(c.value),lower(?))>0 ORDER BY m.created_at DESC LIMIT 200`).all(user,q).map(r=>r.memory_id);}
  /** Most used keywords of active memories (live projects only), for the library and the overview map. */
  concepts(user,limit=30){const live=this.live(user).sql('m.project_id');
    return this.db.prepare(`SELECT c.value concept,COUNT(*) count FROM memory_traits t JOIN memories m ON m.user_id=t.user_id AND m.memory_id=t.memory_id, json_each(t.concepts_json) c
      WHERE t.user_id=? AND m.status='active' AND ${live.sql} GROUP BY lower(c.value) ORDER BY count DESC,concept LIMIT ?`).all(user,...live.params,limit);}
  /** Facets for browsing a large collection: active memories only, owner scoped, counts only. */
  facets(auth){
    const user=auth.user_id,live=this.live(user),filter=live.sql('project_id');
    const topics=this.db.prepare(`SELECT topic,COUNT(*) count FROM memories WHERE user_id=? AND status='active' AND topic IS NOT NULL AND topic<>'' AND ${filter.sql} GROUP BY topic ORDER BY count DESC,topic LIMIT 30`).all(user,...filter.params);
    const statuses=Object.fromEntries(this.db.prepare(`SELECT status,COUNT(*) n FROM memories WHERE user_id=? AND ${filter.sql} GROUP BY status`).all(user,...filter.params).map(r=>[r.status,r.n]));
    const imported=this.db.prepare(`SELECT COUNT(*) n FROM memories WHERE user_id=? AND status='active' AND source LIKE 'user_import:%' AND ${filter.sql}`).get(user,...filter.params).n;
    const kindCounts=new Map(this.db.prepare(`SELECT COALESCE(t.kind,'none') kind,COUNT(*) n FROM memories m LEFT JOIN memory_traits t ON t.user_id=m.user_id AND t.memory_id=m.memory_id
      WHERE m.user_id=? AND m.status='active' AND ${live.sql('m.project_id').sql} GROUP BY COALESCE(t.kind,'none')`).all(user,...live.sql('m.project_id').params).map(r=>[r.kind,r.n]));
    const importDays=this.db.prepare("SELECT substr(imported_at,1,10) day,COUNT(*) count FROM console_import_records WHERE user_id=? GROUP BY day ORDER BY day DESC LIMIT 10").all(user);
    return {read_only:true,concepts:this.concepts(user),kinds:[...MEMORY_KINDS,'none'].map(kind=>({kind,count:kindCounts.get(kind)||0})),
      topics,statuses:{active:statuses.active||0,superseded:statuses.superseded||0,retracted:statuses.retracted||0},
      origins:{imported,other:(statuses.active||0)-imported},import_days:importDays};
  }

  recordImport(user,memoryId,original){
    const valid=typeof original==='string'&&original.length<=40&&Number.isFinite(Date.parse(original))?new Date(Date.parse(original)).toISOString():null;
    this.db.prepare('INSERT OR IGNORE INTO console_import_records VALUES (?,?,?,?)').run(user,memoryId,valid,new Date().toISOString());
  }
}

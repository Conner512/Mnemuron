import {createHash,randomUUID} from 'node:crypto';
import {object,id,number,fingerprint} from './state.mjs';
import {ValidationError,ConflictError,NotFoundError} from '../errors.mjs';
import {protectTables} from '../lifecycle/protection.mjs';
import {resolveMemoryScope} from '../memory-scope.mjs';

// One organizer for every manual category write: a single memory, a page selection, everything
// matching a filter, or the members of a deleted category. Each write is previewed (token), applied
// in one transaction and recorded as a batch with the prior state per memory so it can be undone.
// Model annotations are never rewritten here; a manual category is a locked override.
export const ORGANIZE_LIMIT=2000,SELECTION_LIMIT=100,LABEL_MAX=40;
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

export function label(value){
  if(typeof value!=='string')throw new ValidationError('Invalid category name.','INVALID_CATEGORY_LABEL');
  const text=value.normalize('NFC').replace(/\s+/g,' ').trim();
  if(!text||[...text].length>LABEL_MAX||/[\u0000-\u001f\u007f<>]/.test(text))throw new ValidationError('Invalid category name.','INVALID_CATEGORY_LABEL');
  return text;
}
// Stable category IDs are derived once from the first name; later renames change only the label.
function slug(text,taken){
  let base=text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,48);
  if(!base)base='c-'+createHash('sha256').update(text).digest('hex').slice(0,10);
  else if(!/^[a-z]/.test(base))base='c-'+base;
  let candidate=base,n=2;while(taken.has(candidate))candidate=`${base}-${n++}`.slice(0,64);
  return candidate;
}

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
  labels(user){return this.service.features.labels(user);}
  /** The owner's authoritative lifecycle filter for one Console request (normal views are live-only). */
  live(user){return this.store.lifecycle.live(user);}
  /** categorySql with its parameters for this owner. */
  categories(user,live=this.live(user)){const filter=live.sql('m.project_id');return {sql:categorySql(filter),params:[this.taxonomy(user).version,user,...filter.params]};}

  /** Validated filter shared by the library list, the facets, the preview and the apply step. */
  filter(user,p,{organize=false}={}){
    const f={};
    if(p.query!==undefined){if(typeof p.query!=='string'||p.query.length>2000)throw new ValidationError('Invalid query.');if(p.query.trim())f.query=p.query;}
    if(p.category!==undefined&&p.category!==''){if(!this.taxonomy(user).categories.includes(p.category))throw new ValidationError('Invalid category.');f.category=p.category;}
    if(p.topic!==undefined&&p.topic!==''){if(typeof p.topic!=='string'||p.topic.length>200)throw new ValidationError('Invalid topic.');f.topic=p.topic;}
    if(p.origin!==undefined&&p.origin!==''){if(!ORIGINS.includes(p.origin))throw new ValidationError('Invalid origin.');f.origin=p.origin;}
    if(p.status!==undefined&&p.status!==''){if(!['active','superseded','retracted'].includes(p.status))throw new ValidationError('Invalid status.');f.status=p.status;}
    if(organize)f.status='active';
    return f;
  }
  /** Rows matching a filter, newest first (or search rank). Candidate windows are bounded and say so. */
  rows(auth,f,{ids,ranked,limit=ORGANIZE_LIMIT+1,offset=0,count=false}={}){
    const user=auth.user_id,live=this.live(user),categories=this.categories(user,live);let order=ranked||null,truncated=false,total,aliases=null,dependencyToken=null,matchById=new Map();
    if(ranked)ids=ids?ids.filter(x=>ranked.includes(x)):ranked;
    if(f.query){
      // The search window is cut after the live filter, so deleted-project records never take candidate slots.
      const scope=resolveMemoryScope(this.db,user,{},{lifecycle:this.store.lifecycle});
      const found=this.store.memorySearch.candidates(user,f.query,scope,{auth,statuses:f.status?[f.status]:['active','superseded','retracted'],memoryTypes:MEMORY_TYPES});
      truncated=found.truncated===true;aliases=found.aliases;dependencyToken=found.dependency_token;matchById=new Map(found.rows.map(r=>[r.memory_id,r._entity_match]));order=found.rows.map(r=>r.memory_id);
      ids=ids?ids.filter(x=>order.includes(x)):order;
    }
    const sql=`SELECT m.memory_id,m.content,m.memory_type,m.status,m.topic,m.created_at,m.project_id,c.category,
        (SELECT MAX(revision) FROM memory_revisions r WHERE r.user_id=m.user_id AND r.memory_id=m.memory_id) revision,
        m.source LIKE 'user_import:%' imported,i.original_created_at
      FROM memories m JOIN (${categories.sql}) c ON c.memory_id=m.memory_id
      LEFT JOIN console_import_records i ON i.user_id=m.user_id AND i.memory_id=m.memory_id
      WHERE m.user_id=? AND (? IS NULL OR m.status=?) AND (? IS NULL OR c.category=?) AND (? IS NULL OR m.topic=?)
        AND (? IS NULL OR (m.source LIKE 'user_import:%')=(?='imported'))
        AND (? IS NULL OR m.memory_id IN (SELECT value FROM json_each(?)))`;
    const args=[...categories.params,user,f.status??null,f.status??null,f.category??null,f.category??null,f.topic??null,f.topic??null,
      f.origin??null,f.origin??null,ids?'1':null,ids?JSON.stringify(ids):null];
    let rows;
    if(order){
      // Keep search rank; the candidate window is already bounded by the search.
      const byId=new Map(this.db.prepare(sql).all(...args).map(r=>[r.memory_id,r])),all=ids.map(x=>byId.get(x)).filter(Boolean);
      rows=all.slice(offset,offset+limit);if(count)total=all.length;
    }else{rows=this.db.prepare(sql+' ORDER BY m.created_at DESC,m.rowid DESC LIMIT ? OFFSET ?').all(...args,limit,offset);
      if(count)total=rows.length<limit&&offset===0?rows.length:this.db.prepare(`SELECT COUNT(*) n FROM (${sql})`).get(...args).n;}
    return {rows:rows.map(r=>({...r,imported:r.imported===1,...(matchById.has(r.memory_id)?{ranking:matchById.get(r.memory_id)}:{})})),truncated,aliases,dependencyToken,...(count?{total}:{})};
  }
  /** Facets for browsing a large collection: active memories only, owner scoped, counts only. */
  facets(auth){
    const user=auth.user_id,taxonomy=this.taxonomy(user),labels=this.labels(user),live=this.live(user),categories=this.categories(user,live),filter=live.sql('project_id');
    const counts=new Map(this.db.prepare(`SELECT c.category,COUNT(*) n FROM memories m JOIN (${categories.sql}) c ON c.memory_id=m.memory_id WHERE m.user_id=? AND m.status='active' GROUP BY c.category`)
      .all(...categories.params,user).map(r=>[r.category,r.n]));
    const topics=this.db.prepare(`SELECT topic,COUNT(*) count FROM memories WHERE user_id=? AND status='active' AND topic IS NOT NULL AND topic<>'' AND ${filter.sql} GROUP BY topic ORDER BY count DESC,topic LIMIT 30`).all(user,...filter.params);
    const statuses=Object.fromEntries(this.db.prepare(`SELECT status,COUNT(*) n FROM memories WHERE user_id=? AND ${filter.sql} GROUP BY status`).all(user,...filter.params).map(r=>[r.status,r.n]));
    const imported=this.db.prepare(`SELECT COUNT(*) n FROM memories WHERE user_id=? AND status='active' AND source LIKE 'user_import:%' AND ${filter.sql}`).get(user,...filter.params).n;
    const importDays=this.db.prepare("SELECT substr(imported_at,1,10) day,COUNT(*) count FROM console_import_records WHERE user_id=? GROUP BY day ORDER BY day DESC LIMIT 10").all(user);
    return {read_only:true,categories:taxonomy.categories.map(c=>({category:c,label:labels[c]||null,count:counts.get(c)||0})),
      topics,statuses:{active:statuses.active||0,superseded:statuses.superseded||0,retracted:statuses.retracted||0},
      origins:{imported,other:(statuses.active||0)-imported},import_days:importDays,taxonomy_version:taxonomy.version,classification:this.classification(auth)};
  }

  /** Why memories are (un)categorized: configuration, blockers and classification job states. Counts only. */
  classification(auth){
    const user=auth.user_id,service=this.service,taxonomy=this.taxonomy(user);
    const organizer=service.models.list(user).find(m=>m.kind==='organizer')?.config||{},processing=service.processing(user).classification;
    const jobs=Object.fromEntries(this.db.prepare("SELECT state,COUNT(*) n FROM memory_jobs WHERE user_id=? AND job_type='classification' AND COALESCE(last_error_code,'')<>'RESCHEDULED' GROUP BY state").all(user).map(r=>[r.state,r.n]));
    const last=this.db.prepare("SELECT state,last_error_code,updated_at FROM memory_jobs WHERE user_id=? AND job_type='classification' AND COALESCE(last_error_code,'')<>'RESCHEDULED' ORDER BY updated_at DESC,job_id LIMIT 1").get(user);
    const live=this.live(user).sql('m.project_id');
    const counts=this.db.prepare(`SELECT SUM(o.memory_id IS NOT NULL) manual,SUM(o.memory_id IS NULL AND a.memory_id IS NOT NULL AND a.category<>'uncategorized') model,COUNT(*) active FROM memories m
      LEFT JOIN memory_category_overrides o ON o.user_id=m.user_id AND o.memory_id=m.memory_id AND o.locked=1
      LEFT JOIN memory_annotations a ON a.user_id=m.user_id AND a.memory_id=m.memory_id AND a.taxonomy_version=?
        AND a.revision=(SELECT MAX(revision) FROM memory_revisions WHERE user_id=m.user_id AND memory_id=m.memory_id)
      WHERE m.user_id=? AND m.status='active' AND ${live.sql}`).get(taxonomy.version,user,...live.params);
    const running=(jobs.pending||0)+(jobs.leased||0)+(jobs.retry_wait||0),failed=['dead_letter','blocked_auth','blocked_budget','blocked_config','review_required'].reduce((n,s)=>n+(jobs[s]||0),0);
    // Scheduling works with the worker disabled (jobs wait for it); only these make a schedule fail.
    const configured=!!organizer.model&&organizer.enabled===true,blocking=processing.blockers.filter(code=>['NOT_CONFIGURED','EGRESS_DENIED'].includes(code));
    const state=!configured?'unconfigured':blocking.length?'blocked':running?'running':last&&failed&&last.state!=='succeeded'?'failed':jobs.succeeded?'completed':'unscheduled';
    return {state,blockers:blocking,model_configured:!!organizer.model,model_enabled:organizer.enabled===true,
      worker_enabled:this.store.memoryConfig.console?.worker_enabled===true,key_storage:!!this.store.memoryConfig.console?.key_file,
      jobs:{running,failed,succeeded:jobs.succeeded||0},last_job:last?{state:last.state,error_code:last.last_error_code,updated_at:last.updated_at}:null,
      active:counts.active||0,manual:counts.manual||0,model:counts.model||0};
  }
  selection(auth,p){
    const user=auth.user_id;let ids;
    if(p.memory_ids!==undefined){
      ids=typeof p.memory_ids==='string'?p.memory_ids.split(',').filter(Boolean):p.memory_ids;
      if(!Array.isArray(ids)||!ids.length||ids.length>SELECTION_LIMIT)throw new ValidationError(`Select 1..${SELECTION_LIMIT} memories, or organize everything matching a filter.`,'INVALID_SELECTION');
      ids.forEach(id);if(new Set(ids).size!==ids.length)throw new ValidationError('Duplicate records in selection.','INVALID_SELECTION');
    }
    const f=this.filter(user,{query:p.query,category:p.filter_category,topic:p.topic,origin:p.origin},{organize:true});
    if(!ids&&!Object.keys(f).some(k=>k!=='status')&&p.all!==true&&p.all!=='true')throw new ValidationError('Choose memories or a filter to organize.','INVALID_SELECTION');
    const {rows,truncated,total,aliases,dependencyToken}=this.rows(auth,f,{ids,count:true});
    return {rows,truncated,total,aliases,dependencyToken,filter:f,ids};
  }
  // Bound to the owner, the owner's lifecycle generation and each row's project as well as its revision and category, so
  // a preview taken before a project delete/restore (or merge) never matches again even if nothing else changed.
  token(user,target,rows,dependencyToken=null){return fingerprint(['organize-v3',dependencyToken,user,this.store.lifecycle.generation(user),target,rows.map(r=>[r.memory_id,r.revision,r.category,r.project_id??null])]);}

  /** organize-preview: exactly what memory.organize would do now, without writing anything. */
  preview(auth,p){return this.plan(auth,p).preview;}
  plan(auth,p){
    object(p,['category','memory_ids','query','filter_category','topic','origin','all']);
    const user=auth.user_id,taxonomy=this.taxonomy(user);
    if(!taxonomy.categories.includes(p.category))throw new ValidationError('Invalid category.','INVALID_CATEGORY');
    const {rows,truncated,total,ids,aliases,dependencyToken}=this.selection(auth,p);
    const over=total>ORGANIZE_LIMIT,list=rows.slice(0,ORGANIZE_LIMIT);
    const breakdown=new Map();for(const r of list)breakdown.set(r.category,(breakdown.get(r.category)||0)+1);
    const unchanged=breakdown.get(p.category)||0;
    // total is the exact number of matching active memories; matched is what one step could cover.
    return {rows:list,preview:{read_only:true,category:p.category,total,matched:list.length,changed:list.length-unchanged,unchanged,
      missing:ids?ids.length-list.length:0,by_category:[...breakdown].map(([category,count])=>({category,count})).sort((a,b)=>b.count-a.count),
      sample:list.slice(0,5).map(r=>({memory_id:r.memory_id,content:[...String(r.content)].slice(0,120).join(''),category:r.category})),
      truncated,aliases,over_limit:over,limit:ORGANIZE_LIMIT,applicable:!over&&!truncated&&list.length>0,preview_token:this.token(user,p.category,list,dependencyToken)}};
  }
  /** memory.organize: re-resolves the same selection and refuses if anything changed since the preview. */
  organize(auth,p){
    object(p,['category','memory_ids','query','filter_category','topic','origin','all','preview_token']);
    if(typeof p.preview_token!=='string'||!/^[a-f0-9]{64}$/.test(p.preview_token))throw new ValidationError('Preview the change before applying it.','PREVIEW_REQUIRED');
    // Re-plan, token comparison and write share one transaction: the token (owner, lifecycle generation, each row's
    // project, revision and category) is rechecked against exactly the state that is written; hidden records never are.
    return this.store.memoryTransaction(()=>{
    const {preview_token,...request}=p,{rows,preview:current}=this.plan(auth,request);
    if(current.truncated)throw new ConflictError('The search matches more records than one organize step can verify; narrow the filter.','SELECTION_TRUNCATED');
    if(current.over_limit)throw new ConflictError(`Organize at most ${ORGANIZE_LIMIT} memories at a time; narrow the filter.`,'SELECTION_TOO_LARGE');
    if(!current.matched)throw new ConflictError('Nothing matches this selection any more.','SELECTION_EMPTY');
    if(current.preview_token!==preview_token)throw new ConflictError('Memories changed since the preview; review the new preview.','PREVIEW_CHANGED');
    const kind=request.memory_ids!==undefined?'selection':'filter';
    return this.write(auth,rows,p.category,{kind,detail:{filter:kind==='filter'?this.filter(auth.user_id,{query:p.query,category:p.filter_category,topic:p.topic,origin:p.origin}):null}});
    });
  }
  /** Rows a manual category can apply to: owned and active. Sensitivity does not matter; nothing leaves. */
  targets(user,ids){
    const categories=this.categories(user);
    const rows=this.db.prepare(`SELECT m.memory_id,m.status,c.category FROM memories m JOIN (${categories.sql}) c ON c.memory_id=m.memory_id
      WHERE m.user_id=? AND m.memory_id IN (SELECT value FROM json_each(?))`).all(...categories.params,user,JSON.stringify(ids));
    return new Map(rows.map(r=>[r.memory_id,r]));
  }
  /** The one write path. Callers have authorized the owner and validated the category. */
  write(auth,rows,category,{kind,detail={}}){
    const user=auth.user_id,store=this.store,batch=randomUUID(),now=new Date().toISOString();
    return store.memoryTransaction(()=>{
      const changed=[];
      for(const row of rows){
        if(row.category===category)continue;
        const prior=this.db.prepare('SELECT category FROM memory_category_overrides WHERE user_id=? AND memory_id=? AND locked=1').get(user,row.memory_id)?.category??null;
        this.db.prepare('INSERT OR REPLACE INTO memory_category_overrides VALUES (?,?,?,1)').run(user,row.memory_id,category);
        this.db.prepare('INSERT INTO console_organize_items VALUES (?,?,?,?,?)').run(user,batch,row.memory_id,prior,category);
        changed.push(row.memory_id);
      }
      this.invalidate(user,changed);
      store.entities.enqueue(user,changed);
      this.db.prepare('INSERT INTO console_organize_batches VALUES (?,?,?,?,?,?,?,?,NULL)').run(user,batch,kind,category,JSON.stringify(detail),rows.length,changed.length,now);
      store.audit({auth,action:'memory.category.batch',targetType:'console_organize_batch',targetId:batch,metadata:{kind,matched:rows.length,changed:changed.length,locked:true}});
      return {status:'organized',batch_id:batch,kind,category,matched:rows.length,changed:changed.length,unchanged:rows.length-changed.length,undo_available:changed.length>0};
    });
  }
  invalidate(user,ids){
    if(!ids.length)return;const list=JSON.stringify(ids);
    this.db.prepare("UPDATE memory_summaries SET status='stale' WHERE status='current' AND summary_id IN (SELECT summary_id FROM memory_summary_dependencies WHERE user_id=? AND memory_id IN (SELECT value FROM json_each(?)))").run(user,list);
    this.db.prepare("INSERT OR REPLACE INTO memory_derived_outbox SELECT summary_id,'hide','pending' FROM memory_summary_dependencies WHERE user_id=? AND memory_id IN (SELECT value FROM json_each(?))").run(user,list);
  }
  /** memory.classify and memory.batch_classify keep their contracts but share the write path. */
  classify(auth,items,category,{kind}){
    const user=auth.user_id;if(!this.taxonomy(user).categories.includes(category))throw new ValidationError('Invalid category.');
    const found=this.targets(user,items.map(i=>i.memory_id)),results=[],eligible=[];
    for(const item of items){
      const row=found.get(item.memory_id),latest=row&&this.store.revisions.latest(user,item.memory_id);
      const error=!row?'MEMORY_NOT_FOUND':latest.revision!==item.revision?'MEMORY_VERSION_CHANGED':row.status!=='active'?'INVALID_CATEGORY_TARGET':null;
      results.push({memory_id:item.memory_id,ok:!error,...(error?{error_code:error}:{result:{status:'classified',locked:true,category}})});
      if(!error)eligible.push(row);
    }
    const batch=eligible.length?this.write(auth,eligible,category,{kind}):null;
    return {results,batch};
  }
  undo(auth,p){
    object(p,['batch_id']);id(p.batch_id);const user=auth.user_id;
    const batch=this.db.prepare('SELECT * FROM console_organize_batches WHERE user_id=? AND batch_id=?').get(user,p.batch_id);
    if(!batch)throw new NotFoundError('Organize batch not found.','BATCH_NOT_FOUND');
    if(batch.undone_at)throw new ConflictError('This change was already undone.','BATCH_ALREADY_UNDONE');
    return this.store.memoryTransaction(()=>{
      const detail=JSON.parse(batch.detail_json);let restoredCategory=null;
      if(batch.kind==='category.delete'&&!this.taxonomy(user).categories.includes(detail.deleted.id))restoredCategory=this.service.features.restoreCategory(auth,detail);
      const categories=this.taxonomy(user).categories,items=this.db.prepare('SELECT * FROM console_organize_items WHERE user_id=? AND batch_id=?').all(user,batch.batch_id);
      const restored=[],skipped=[];
      for(const item of items){
        const current=this.db.prepare('SELECT category FROM memory_category_overrides WHERE user_id=? AND memory_id=? AND locked=1').get(user,item.memory_id)?.category??null;
        // A corrected or retracted memory changed since: its replacement carries the category on.
        const memory=this.db.prepare('SELECT status,project_id FROM memories WHERE user_id=? AND memory_id=?').get(user,item.memory_id),active=memory?.status==='active';
        // A memory of a deleted (or dangling/foreign) project is never changed by undo and never reported as restored.
        if(memory&&!this.store.lifecycle.liveProject(user,memory.project_id)){skipped.push({memory_id:item.memory_id,reason:'PROJECT_UNAVAILABLE'});continue;}
        if(current!==item.applied_category||!active){skipped.push({memory_id:item.memory_id,reason:'CHANGED_SINCE'});continue;}
        if(item.prior_category!==null&&!categories.includes(item.prior_category)){skipped.push({memory_id:item.memory_id,reason:'CATEGORY_REMOVED'});continue;}
        if(item.prior_category===null)this.db.prepare('DELETE FROM memory_category_overrides WHERE user_id=? AND memory_id=?').run(user,item.memory_id);
        else this.db.prepare('INSERT OR REPLACE INTO memory_category_overrides VALUES (?,?,?,1)').run(user,item.memory_id,item.prior_category);
        restored.push(item.memory_id);
      }
      // Nothing restorable (every memory changed since): keep the batch undoable for later, e.g. after
      // the change that superseded it is itself undone. The transaction rolls back a restored category.
      if(items.length&&!restored.length)throw new ConflictError('Every memory in this change was changed again since; nothing was undone.','UNDO_CONFLICT');
      this.invalidate(user,restored);
      this.db.prepare('UPDATE console_organize_batches SET undone_at=? WHERE user_id=? AND batch_id=?').run(new Date().toISOString(),user,batch.batch_id);
      this.store.audit({auth,action:'memory.category.undo',targetType:'console_organize_batch',targetId:batch.batch_id,metadata:{restored:restored.length,skipped:skipped.length}});
      return {status:'undone',batch_id:batch.batch_id,restored:restored.length,skipped_count:skipped.length,skipped:skipped.slice(0,50),...(restoredCategory?{restored_category:restoredCategory}:{})};
    });
  }
  batches(auth,p){
    object(p,['limit']);const limit=p.limit===undefined?10:number(Number(p.limit),1,50);
    const rows=this.db.prepare('SELECT batch_id,kind,category,detail_json,matched,changed,created_at,undone_at FROM console_organize_batches WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(auth.user_id,limit);
    return {read_only:true,batches:rows.map(({detail_json,...r})=>{const d=JSON.parse(detail_json);
      return {...r,...(d.deleted?{deleted_category:d.deleted.id,deleted_label:d.deleted.label||null}:{}),undoable:!r.undone_at&&r.changed+(d.deleted?1:0)>0};})};
  }
  recordImport(user,memoryId,original){
    const valid=typeof original==='string'&&original.length<=40&&Number.isFinite(Date.parse(original))?new Date(Date.parse(original)).toISOString():null;
    this.db.prepare('INSERT OR IGNORE INTO console_import_records VALUES (?,?,?,?)').run(user,memoryId,valid,new Date().toISOString());
  }
}

/** Account-owned category list with stable IDs and editable names. */
export function categoryEditor(features){
  const {db,store}=features;
  const versionFor=(user,categories,revision)=>'console-'+createHash('sha256').update(JSON.stringify([user,categories,revision])).digest('hex');
  // A new taxonomy version must not hide model classifications: copy them forward (old rows stay).
  const carryForward=(user,from,to,categories,{map={},only=null}={})=>{
    if(from===to)return;
    const rows=db.prepare('SELECT * FROM memory_annotations WHERE user_id=? AND taxonomy_version=?').all(user,from);
    const insert=db.prepare(`INSERT ${only?'OR REPLACE':'OR IGNORE'} INTO memory_annotations VALUES (?,?,?,?,?,?,?,?,?)`);
    for(const r of rows){if(only&&r.category!==only)continue;const category=map[r.category]??r.category;
      // A classification into a category that no longer exists falls back to uncategorized (no row).
      if(!categories.includes(category))continue;
      insert.run(r.user_id,r.memory_id,r.revision,to,category,r.tags_json,r.suggestion,r.profile,r.job_id);}
  };
  // Queued organizer jobs carry their own taxonomy; fence them before output can publish under it.
  const fence=user=>db.prepare("UPDATE memory_jobs SET state='blocked_config',fence=fence+1,lease_owner=NULL,lease_expires=NULL,last_error_code='STALE_TAXONOMY' WHERE user_id=? AND job_type<>'entities' AND state IN ('pending','leased','retry_wait')").run(user);
  const current=user=>{const p=features.preference(user,'taxonomy',features.service.taxonomy(user));return {revision:p.revision,version:p.version,categories:p.categories,labels:p.labels||{}};};
  const unique=(t,text,except)=>{const lower=text.toLocaleLowerCase();
    if(t.categories.some(c=>c!==except&&(c===lower||(t.labels[c]||'').toLocaleLowerCase()===lower)))throw new ConflictError('A category with this name already exists.','CATEGORY_EXISTS');};
  const persist=(user,expected,t)=>features.save(user,'taxonomy',{expected_revision:expected},{version:t.version,categories:t.categories,labels:t.labels});
  return {
    carryForward,fence,current,
    create(auth,p){
      object(p,['label','expected_revision']);const user=auth.user_id,t=current(user),text=label(p.label);unique(t,text);
      if(t.categories.length>=64)throw new ConflictError('At most 64 categories.','TAXONOMY_FULL');
      const category=slug(text,new Set(t.categories)),categories=[...t.categories,category],version=versionFor(user,categories,t.revision+1);
      store.derivedMemory.taxonomy({version,categories});
      const saved=persist(user,p.expected_revision,{version,categories,labels:{...t.labels,[category]:text}});
      carryForward(user,t.version,version,categories);fence(user);
      return {...saved,status:'created',category,label:text};
    },
    rename(auth,p){
      object(p,['category','label','expected_revision']);const user=auth.user_id,t=current(user),text=label(p.label);
      if(!t.categories.includes(p.category)||p.category==='uncategorized')throw new ValidationError('This category cannot be renamed.','INVALID_CATEGORY');
      unique(t,text,p.category);
      // Names are presentation only: the taxonomy version, jobs and summaries are unaffected.
      return {...persist(user,p.expected_revision,{...t,labels:{...t.labels,[p.category]:text}}),status:'renamed',category:p.category,label:text};
    },
    remove(auth,p,organizer){
      object(p,['category','move_to','expected_revision']);const user=auth.user_id,t=current(user);
      if(!t.categories.includes(p.category)||p.category==='uncategorized')throw new ValidationError('This category cannot be deleted.','INVALID_CATEGORY');
      if(!t.categories.includes(p.move_to)||p.move_to===p.category)throw new ValidationError('Choose where its memories go.','INVALID_CATEGORY');
      const categories=t.categories.filter(c=>c!==p.category),version=versionFor(user,categories,t.revision+1),{[p.category]:removed,...labels}=t.labels;
      store.derivedMemory.taxonomy({version,categories});
      const members=db.prepare(`SELECT o.memory_id,m.project_id FROM memory_category_overrides o LEFT JOIN memories m ON m.user_id=o.user_id AND m.memory_id=o.memory_id
        WHERE o.user_id=? AND o.category=? AND o.locked=1`).all(user,p.category);
      // Records of a deleted project are not part of the visible, undoable move: their override follows the removed
      // category to its target as taxonomy maintenance, so the taxonomy stays consistent if the project is restored.
      // They are not counted in `moved`, get no organize item and cannot be undone by the batch.
      const hidden=members.filter(m=>!store.lifecycle.liveProject(user,m.project_id)),visible=members.filter(m=>!hidden.includes(m));
      const saved=persist(user,p.expected_revision,{version,categories,labels});
      carryForward(user,t.version,version,categories,{map:{[p.category]:p.move_to}});fence(user);
      db.prepare("UPDATE memory_summaries SET status='stale' WHERE user_id=? AND status='current' AND category IN (?,?)").run(user,p.category,p.move_to);
      for(const m of hidden)db.prepare('UPDATE memory_category_overrides SET category=? WHERE user_id=? AND memory_id=? AND locked=1').run(p.move_to,user,m.memory_id);
      organizer.invalidate(user,hidden.map(m=>m.memory_id));
      const batch=organizer.write(auth,visible.map(m=>({memory_id:m.memory_id,category:p.category})),p.move_to,
        {kind:'category.delete',detail:{deleted:{id:p.category,label:removed||null,index:t.categories.indexOf(p.category)},previous_version:t.version}});
      return {...saved,status:'deleted',category:p.category,move_to:p.move_to,moved:batch.changed,batch_id:batch.batch_id};
    },
    // Undo of a deletion: put the category back where it was and restore its model classifications.
    restore(auth,detail){
      const user=auth.user_id,t=current(user),{id:category,index}=detail.deleted;
      if(t.categories.length>=64)throw new ConflictError('At most 64 categories.','TAXONOMY_FULL');
      let text=detail.deleted.label;if(text){try{unique(t,text,category);}catch{text=`${text} (2)`.slice(0,LABEL_MAX);}}
      const categories=[...t.categories];categories.splice(Math.min(index,categories.length),0,category);
      const version=versionFor(user,categories,t.revision+1);store.derivedMemory.taxonomy({version,categories});
      persist(user,t.revision,{version,categories,labels:text?{...t.labels,[category]:text}:t.labels});
      carryForward(user,t.version,version,categories);carryForward(user,detail.previous_version,version,categories,{only:category});fence(user);
      return category;
    },
  };
}

import {semanticPolicy,acceptsSemanticScore,querySubjectsMatch,memorySearchText,makeQueryPlan} from '../search-query.mjs';
import {MEMORY_SEARCH_CONTEXT,memorySearchFilterSql} from '../memory/search-context.mjs';
import {randomUUID} from 'node:crypto';
import {digest,fail,integer} from '../model-providers/contracts.mjs';
import {memoryScopeSql,resolveMemoryScope} from '../memory-scope.mjs';
import {memorySummary,boundMemoryResponse} from '../memory-projection.mjs';
import {scopeKey} from '../memory-derived/store.mjs';
import {normalizeSearch,searchTokens,lexicalScore,originalMatchKind} from '../memory-retrieval.mjs';
import {isWebReader,webMemorySql} from '../memory/web-visibility.mjs';
import {protectTables,assertProtection} from '../lifecycle/protection.mjs';
import {isDeterministicReadError} from '../errors.mjs';
import {MEMORY_TYPES} from '../memory-validation.mjs';
import {isRetrievalDegradation} from '../../../shared/retrieval-diagnostics.mjs';
import {documentChunks,documentBatches} from './chunks.mjs';
export {splitDocument} from './chunks.mjs';

export const surrogate=value=>digest(['vector-private-v1',value]);
// A bounded document allowlist lets the current SQLite traits filter the vector backend
// before its top-k window, without relying on stale metadata copied into vector payloads.
export const VECTOR_FILTER_DOCUMENT_LIMIT=2000;
export const VECTOR_GROUP_QUERY_ATTEMPTS=3;
const pointId=(...values)=>{const h=digest(values);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const condition=(key,value)=>({key,match:{value}});
export class VectorIndex {
  constructor(store,backend,embedders,{clock=()=>Date.now(),leaseMs=120000,prefix='memory',ownerId=null,collections=backend?.precreated??null,budget=null,guard=null}={}){this.executionGuard=guard;
    this.store=store;this.db=store.db;this.backend=backend;this.embedders=embedders;this.clock=clock;this.leaseMs=leaseMs;this.prefix=prefix;this.ownerId=ownerId;
    // collections: operator pre-created names (never created here). budget(purpose): a finite first-run call
    // allowance checked inside the same transaction as the daily limit; it returns true when it replaces it.
    this.collections=collections;this.budget=budget;
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_vector_generations (generation TEXT PRIMARY KEY,profile TEXT NOT NULL,collection_name TEXT NOT NULL UNIQUE,state TEXT NOT NULL,
      dimensions INTEGER NOT NULL,distance TEXT NOT NULL,created_at INTEGER NOT NULL,lease_owner TEXT,lease_expires INTEGER,fence INTEGER NOT NULL DEFAULT 0,checkpoint INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS memory_vector_owners(generation TEXT PRIMARY KEY,user_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_vector_owner_active(user_id TEXT PRIMARY KEY,generation TEXT NOT NULL,profile TEXT NOT NULL,collection_name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_vector_active (id INTEGER PRIMARY KEY CHECK(id=1),generation TEXT NOT NULL,profile TEXT NOT NULL,collection_name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_vector_documents (generation TEXT NOT NULL,user_id TEXT NOT NULL,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,state_hash TEXT NOT NULL,
        scope_key TEXT NOT NULL,content_hash TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(generation,user_id,memory_id));
      CREATE TABLE IF NOT EXISTS memory_vector_points (point_id TEXT PRIMARY KEY,generation TEXT NOT NULL,user_id TEXT NOT NULL,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,chunk INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_vector_point_doc ON memory_vector_points(generation,user_id,memory_id);
      CREATE TABLE IF NOT EXISTS memory_vector_calls (profile TEXT NOT NULL,day TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(profile,day));
      CREATE TABLE IF NOT EXISTS memory_owner_vector_usage (user_id TEXT NOT NULL,profile TEXT NOT NULL,day TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(user_id,profile,day));
      CREATE TABLE IF NOT EXISTS memory_owner_vector_build_usage (user_id TEXT NOT NULL,profile TEXT NOT NULL,day TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(user_id,profile,day));
      CREATE TABLE IF NOT EXISTS memory_vector_manifest (generation TEXT NOT NULL,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,state_hash TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(generation,memory_id));`);
    // Optional module, also created later at runtime from the Console: protect every material table it may
    // have just created before its first read or write, then require the whole vector group to be complete.
    protectTables(this.db,['memory_vector_owners','memory_vector_owner_active','memory_vector_manifest','memory_vector_documents','memory_vector_generations']);
    assertProtection(this.db,['vector']);
  }
  // `current`: optional revalidation of the document about to be embedded, the last step before the provider call.
  reserve(embedder,userId,purpose='document',current=null){this.store.memoryTransaction(()=>{const p=embedder.profile,day=new Date(this.clock()).toISOString().slice(0,10);
    if(typeof userId!=='string'||!userId)fail('INVALID_OWNER');
    if(current&&!current())fail('STALE_INPUT');
    if(this.db.prepare('SELECT state FROM memory_profile_state WHERE profile=?').get(p.fingerprint)?.state==='blocked_auth')fail('AUTH_FAILED');
    this.db.prepare('INSERT OR IGNORE INTO memory_vector_calls VALUES (?,?,0)').run(p.fingerprint,day);
    // A first-run budget counts every call (it throws when exhausted); only manifest document calls skip the daily cap.
    // They are bounded by that total instead, so they are recorded apart and never use the daily query/probe allowance.
    // 'manual': the owner's own daily limit was enforced by the budget callback and replaces the profile's.
    const reserved=this.budget?this.budget(purpose,day):false;
    if(reserved===true){this.db.prepare(`INSERT INTO memory_owner_vector_build_usage VALUES(?,?,?,1) ON CONFLICT(user_id,profile,day)
      DO UPDATE SET count=count+1`).run(userId,p.fingerprint,day);return;}
    const probes=this.ownerId?this.db.prepare('SELECT reserved_calls n FROM memory_model_budget WHERE profile=? AND day=?').get(p.fingerprint,day)?.n||0:0;
    if(reserved!=='manual'&&probes+this.db.prepare('SELECT count FROM memory_vector_calls WHERE profile=? AND day=?').get(p.fingerprint,day).count>=p.limits.daily_requests)fail('BUDGET_EXHAUSTED');
    this.db.prepare('UPDATE memory_vector_calls SET count=count+1 WHERE profile=? AND day=?').run(p.fingerprint,day);
    this.db.prepare(`INSERT INTO memory_owner_vector_usage VALUES(?,?,?,1) ON CONFLICT(user_id,profile,day)
      DO UPDATE SET count=count+1`).run(userId,p.fingerprint,day);
  });}
  async embed(embedder,texts,inputType,{userId,purpose,current,...options}){try{return await embedder.embed(texts,inputType,{...options,reserve:()=>this.reserve(embedder,userId,purpose||inputType,current)});}
    catch(error){if(error.code==='AUTH_FAILED')this.db.prepare('INSERT OR REPLACE INTO memory_profile_state VALUES (?,?)').run(embedder.profile.fingerprint,'blocked_auth');throw error;}}
  /** A new generation. With `manifest` it indexes only that frozen (memory_id, revision, state_hash) set. */
  begin(profile,{manifest}={}){
    const embedder=this.embedders.get(profile);if(!embedder?.profile.enabled)fail('NOT_CONFIGURED');
    const generation=randomUUID(),p=embedder.profile;
    return this.store.memoryTransaction(()=>{
      // A pre-created collection is used once: a retired generation keeps its own for rollback.
      const name=this.collections?this.collections.find(n=>!this.db.prepare('SELECT 1 FROM memory_vector_generations WHERE collection_name=?').get(n)):this.prefix+'_'+digest([generation,profile]).slice(0,32);
      if(!name)fail('VECTOR_COLLECTION_UNAVAILABLE');
      this.db.prepare('INSERT INTO memory_vector_generations VALUES (?,?,?,?,?,?,?,NULL,NULL,0,0)').run(generation,profile,name,'building',p.dimensions,p.distance,this.clock());if(this.ownerId)this.db.prepare('INSERT INTO memory_vector_owners VALUES(?,?)').run(generation,this.ownerId);
      for(const item of manifest||[])this.db.prepare("INSERT INTO memory_vector_manifest VALUES(?,?,?,?,'pending')").run(generation,item.memory_id,item.revision,item.state_hash);
      return generation;
    });
  }
  manifest(id){return this.db.prepare('SELECT memory_id,revision,state_hash,state FROM memory_vector_manifest WHERE generation=? ORDER BY memory_id').all(id);}
  manifestCounts(id){return Object.fromEntries(this.db.prepare('SELECT state,COUNT(*) n FROM memory_vector_manifest WHERE generation=? GROUP BY state').all(id).map(r=>[r.state,r.n]));}
  snapshot(){const active=this.ownerId?this.db.prepare('SELECT * FROM memory_vector_owner_active WHERE user_id=?').get(this.ownerId):this.db.prepare('SELECT * FROM memory_vector_active WHERE id=1').get();if(!active)fail('VECTOR_NOT_READY');return Object.freeze({...active});}
  state(){if(this.ownerId)return {generations:this.db.prepare('SELECT g.state,COUNT(*) AS count FROM memory_vector_generations g JOIN memory_vector_owners o ON o.generation=g.generation WHERE o.user_id=? GROUP BY g.state').all(this.ownerId),active:!!this.db.prepare('SELECT 1 FROM memory_vector_owner_active WHERE user_id=?').get(this.ownerId)};return {generations:this.db.prepare('SELECT state,COUNT(*) AS count FROM memory_vector_generations GROUP BY state').all(),active:!!this.db.prepare('SELECT 1 FROM memory_vector_active').get()};}
  assertOwner(id){const owner=this.db.prepare('SELECT user_id FROM memory_vector_owners WHERE generation=?').get(id)?.user_id||null;if(owner!==this.ownerId)fail('VECTOR_NOT_READY');}
  acquire(id,{maintenance=false}={}){this.assertOwner(id);return this.store.memoryTransaction(()=>{const row=this.db.prepare('SELECT * FROM memory_vector_generations WHERE generation=?').get(id),now=this.clock();
    if(!row || !maintenance&&!['building','ready','active'].includes(row.state) || row.lease_expires>now)fail('VECTOR_LEASE_BUSY');
    const owner=randomUUID();this.db.prepare('UPDATE memory_vector_generations SET lease_owner=?,lease_expires=?,fence=fence+1 WHERE generation=?').run(owner,now+this.leaseMs,id);
    return {...row,fence:row.fence+1,lease_owner:owner};
  });}
  owns(g){this.executionGuard?.();const row=this.db.prepare('SELECT * FROM memory_vector_generations WHERE generation=?').get(g.generation);return row && row.fence===g.fence && row.lease_owner===g.lease_owner && row.lease_expires>this.clock();}
  renew(g){if(!this.owns(g))fail('LEASE_LOST');this.db.prepare('UPDATE memory_vector_generations SET lease_expires=? WHERE generation=?').run(this.clock()+this.leaseMs,g.generation);}
  async sync(id,{maxDocuments=10000}={}){
    integer(maxDocuments,1,1000000);
    if(this.db.prepare('SELECT 1 FROM memory_vector_manifest WHERE generation=? LIMIT 1').get(id))return this.syncManifest(id,{maxDocuments});
    const g=this.acquire(id),e=this.embedders.get(g.profile);let processed=0,after=0,complete=false;
    try{
      if(!e)fail('NOT_CONFIGURED');await this.backend.ensureCollection(g.collection_name,{dimensions:g.dimensions,distance:g.distance});
      const highwater=this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM memories WHERE (? IS NULL OR user_id=?)').get(this.ownerId,this.ownerId).n;
      while(processed<maxDocuments){
        const batch=this.db.prepare('SELECT rowid AS cursor_id,user_id,memory_id FROM memories WHERE rowid>? AND rowid<=? AND (? IS NULL OR user_id=?) ORDER BY rowid LIMIT 100').all(after,highwater,this.ownerId,this.ownerId);
        if(!batch.length){complete=true;break;}
        for(const raw of batch){
          const source=this.store.derivedMemory.currentSource(raw.user_id,raw.memory_id),old=this.db.prepare('SELECT * FROM memory_vector_documents WHERE generation=? AND user_id=? AND memory_id=?').get(id,raw.user_id,raw.memory_id);
          after=raw.cursor_id;
          if(old && source && old.revision===source.revision && old.state_hash===source.state_hash && old.scope_key===source.scope_key && old.state==='indexed')continue;
          if(old?.state==='hidden' && !source && old.revision===this.store.revisions.latest(raw.user_id,raw.memory_id)?.revision)continue;
          if(await this.indexRecord(g,e,id,raw,source,old)==='missing'){processed++;continue;}
          processed++;if(processed>=maxDocuments)break;
        }
      }
      if(after>=highwater)complete=true;
      if(complete)this.db.prepare("UPDATE memory_vector_generations SET state=CASE WHEN state='active' THEN state ELSE 'ready' END,checkpoint=? WHERE generation=? AND fence=?")
        .run(this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM memory_index_outbox').get().n,id,g.fence);
      return {processed,complete,generation:id};
    }finally{this.db.prepare('UPDATE memory_vector_generations SET lease_owner=NULL,lease_expires=NULL WHERE generation=? AND fence=? AND lease_owner=?').run(id,g.fence,g.lease_owner);}
  }
  /** Checkpoint only backend-confirmed chunks. A building document is never a searchable/activatable document.
   * Model limits are outside the profile fingerprint, so the deterministic IDs also bind the exact chunk layout. */
  async indexSource(g,e,source,{purpose='document'}={}){
    const id=g.generation,{layout,chunks}=documentChunks(e,source.content),contentHash=digest(source.content);
    const current=()=>{if(!this.owns(g))fail('LEASE_LOST');if(!this.store.derivedMemory.validateItem(source))fail('STALE_INPUT');};
    const filter={must:[condition('owner',surrogate(source.user_id)),condition('document',surrogate([source.user_id,source.memory_id]))]};
    const build=digest(['vector-build-v2',id,g.profile,source.user_id,source.memory_id,source.revision,source.state_hash,source.scope_key,layout]);
    const expected=chunks.map(chunk=>({...chunk,id:pointId('vector-point-v2',build,chunk.chunk)}));
    const expectedIds=new Set(expected.map(chunk=>chunk.id));
    const old=this.db.prepare('SELECT * FROM memory_vector_documents WHERE generation=? AND user_id=? AND memory_id=?').get(id,source.user_id,source.memory_id);
    const reusable=old&&['building','indexed'].includes(old.state)&&old.revision===source.revision&&old.state_hash===source.state_hash
      &&old.scope_key===source.scope_key&&old.content_hash===contentHash;
    const previous=this.db.prepare('SELECT point_id,revision,chunk FROM memory_vector_points WHERE generation=? AND user_id=? AND memory_id=?').all(id,source.user_id,source.memory_id);
    const obsolete=previous.filter(point=>!reusable||point.revision!==source.revision||expected[point.chunk]?.id!==point.point_id);
    this.store.memoryTransaction(()=>{current();
      this.db.prepare('INSERT OR REPLACE INTO memory_vector_documents VALUES (?,?,?,?,?,?,?,?)').run(id,source.user_id,source.memory_id,source.revision,source.state_hash,source.scope_key,contentHash,'building');});
    // Remove prior revision or layout points without spending a model call. Keep their local mappings until the
    // backend confirms deletion, so a failed cleanup remains retryable rather than losing the cleanup checkpoint.
    this.renew(g);current();
    await this.backend.deleteByDocumentRevision(g.collection_name,{...filter,must_not:[condition('revision',source.revision)]});
    for(let start=0;start<obsolete.length;start+=64){
      this.renew(g);current();const part=obsolete.slice(start,start+64);
      await this.backend.deleteByDocumentRevision(g.collection_name,{must:[...filter.must,{has_id:part.map(point=>point.point_id)}]});
      this.store.memoryTransaction(()=>{current();for(const point of part)this.db.prepare('DELETE FROM memory_vector_points WHERE point_id=? AND generation=? AND user_id=? AND memory_id=?')
        .run(point.point_id,id,source.user_id,source.memory_id);});
    }
    current();
    const completed=new Set(this.db.prepare('SELECT point_id FROM memory_vector_points WHERE generation=? AND user_id=? AND memory_id=? AND revision=?')
      .all(id,source.user_id,source.memory_id,source.revision).filter(point=>expectedIds.has(point.point_id)).map(point=>point.point_id));
    for(const part of documentBatches(e,expected.filter(chunk=>!completed.has(chunk.id)))){
      this.renew(g);current();
      const result=await this.embed(e,part.map(chunk=>chunk.text),'document',{userId:source.user_id,purpose,current:()=>{current();return true;}});
      current();
      const points=part.map((chunk,i)=>({id:chunk.id,vector:result.vectors[i],payload:{owner:surrogate(source.user_id),scope:surrogate(source.scope_key),
        document:surrogate([source.user_id,source.memory_id]),revision:source.revision,profile:g.profile,content_hash:contentHash,build,lifecycle:'building'}}));
      for(let start=0;start<points.length;start+=64){
        this.renew(g);current();const batch=points.slice(start,start+64);
        await this.backend.upsert(g.collection_name,batch);
        this.store.memoryTransaction(()=>{current();for(const [i,point] of batch.entries()){
          this.db.prepare('INSERT OR REPLACE INTO memory_vector_points VALUES (?,?,?,?,?,?)').run(point.id,id,source.user_id,source.memory_id,source.revision,part[start+i].chunk);
          completed.add(point.id);
        }});
      }
    }
    this.renew(g);current();if(completed.size!==expected.length)fail('STALE_INPUT');
    // Remote publication is idempotent and contains no source body. A lost acknowledgement keeps all confirmed
    // checkpoints: a retry repeats only this publication, never the successful embedding requests.
    await this.backend.publishBuild(g.collection_name,{owner:surrogate(source.user_id),document:surrogate([source.user_id,source.memory_id]),build});
    this.store.memoryTransaction(()=>{current();
      this.db.prepare("UPDATE memory_vector_documents SET state='indexed' WHERE generation=? AND user_id=? AND memory_id=?")
        .run(id,source.user_id,source.memory_id);});
  }
  /** Embed one record into generation `g` under its lease, or hide it when it is no longer a current source.
   * Shared by the full backfill (`sync`) and the owner's incremental catch-up. Returns 'indexed', 'hidden' or 'missing'. */
  async indexRecord(g,e,id,raw,source,old,{purpose='document'}={}){
    this.renew(g);
    const filter={must:[condition('owner',surrogate(raw.user_id)),condition('document',surrogate([raw.user_id,raw.memory_id]))]};
    const hide=async()=>{
      await this.backend.deleteByDocumentRevision(g.collection_name,filter);
      this.store.memoryTransaction(()=>{if(!this.owns(g))fail('LEASE_LOST');const revision=this.store.revisions.latest(raw.user_id,raw.memory_id);
        this.db.prepare('INSERT OR REPLACE INTO memory_vector_documents VALUES (?,?,?,?,?,?,?,?)').run(id,raw.user_id,raw.memory_id,revision?.revision || 0,revision?.state_hash || '',old?.scope_key || '',revision?.content_hash || '', 'hidden');
        this.db.prepare('DELETE FROM memory_vector_points WHERE generation=? AND user_id=? AND memory_id=?').run(id,raw.user_id,raw.memory_id);});};
    if(!source){await hide();return 'missing';}
    // A source that became stale during its own embedding (deleted project, retraction, new revision) is hidden like
    // any other non-source, and the build continues; only a lost lease or a provider failure stops it.
    try{
      await this.indexSource(g,e,source,{purpose});
      if(purpose!=='manifest')this.store.memoryTransaction(()=>{
        if(!this.owns(g))fail('LEASE_LOST');if(!this.store.derivedMemory.validateItem(source))fail('STALE_INPUT');
        this.db.prepare("UPDATE memory_index_outbox SET state='indexed' WHERE user_id=? AND memory_id=? AND revision=?").run(source.user_id,source.memory_id,source.revision);
      });
    }catch(error){
      // Only the source itself going stale is a skip; any other STALE_INPUT (e.g. a provider whose configuration
      // changed mid-build) or a lost lease stops the build without touching live documents.
      if(error?.code!=='STALE_INPUT' || !this.owns(g) || this.store.derivedMemory.validateItem(source))throw error;await hide();return 'hidden';}
    return 'indexed';
  }
  /** Active records of the owner that this generation lacks or holds at an older revision, plus indexed records that
   * are no longer current. Never walks retracted history and never reads or changes a first-run manifest. */
  catchUpPending(id){
    this.assertOwner(id);if(!this.ownerId)fail('INVALID_OWNER');
    const docs=new Map(this.db.prepare('SELECT * FROM memory_vector_documents WHERE generation=? AND user_id=?').all(id,this.ownerId).map(d=>[d.memory_id,d])),out=[];
    for(const raw of this.db.prepare("SELECT rowid AS cursor_id,user_id,memory_id FROM memories WHERE user_id=? AND status='active' ORDER BY rowid").all(this.ownerId)){
      const source=this.store.derivedMemory.currentSource(raw.user_id,raw.memory_id),old=docs.get(raw.memory_id);
      if(!source || old && old.state==='indexed' && old.revision===source.revision && old.state_hash===source.state_hash && old.scope_key===source.scope_key)continue;
      out.push({user_id:raw.user_id,memory_id:raw.memory_id});
    }
    for(const old of docs.values())if(['indexed','building'].includes(old.state)&&!this.store.derivedMemory.currentSource(old.user_id,old.memory_id))out.push({user_id:old.user_id,memory_id:old.memory_id});
    return out;
  }
  /** Owner-approved incremental catch-up of an existing generation (normally the serving one): at most `maxDocuments`
   * records per call, each revalidated under the lease. Every embedding call goes through the owner's call limits. */
  async catchUp(id,{maxDocuments=2}={}){
    integer(maxDocuments,1,1000);
    const pending=this.catchUpPending(id);
    if(!pending.length)return {processed:0,complete:true,remaining:0,generation:id};
    const g=this.acquire(id),e=this.embedders.get(g.profile);let processed=0;
    try{
      if(!e)fail('NOT_CONFIGURED');
      // Before any embedding call: a rejected vector-store key fails here without spending a call.
      await this.backend.ensureCollection(g.collection_name,{dimensions:g.dimensions,distance:g.distance});
      for(const raw of pending.slice(0,maxDocuments)){
        const source=this.store.derivedMemory.currentSource(raw.user_id,raw.memory_id),old=this.db.prepare('SELECT * FROM memory_vector_documents WHERE generation=? AND user_id=? AND memory_id=?').get(id,raw.user_id,raw.memory_id);
        await this.indexRecord(g,e,id,raw,source,old);processed++;
      }
      return {processed,complete:processed>=pending.length,remaining:pending.length-processed,generation:id};
    }finally{this.db.prepare('UPDATE memory_vector_generations SET lease_owner=NULL,lease_expires=NULL WHERE generation=? AND fence=? AND lease_owner=?').run(id,g.fence,g.lease_owner);}
  }
  /** First-run build: only the frozen manifest, never other rows, history, secret records or other accounts.
   * A record whose revision or state changed since the manifest was frozen is skipped as stale (no call). */
  async syncManifest(id,{maxDocuments}){
    const g=this.acquire(id),e=this.embedders.get(g.profile);let processed=0,complete=false;
    try{
      if(!e)fail('NOT_CONFIGURED');
      // Before any embedding call: an expired or missing collection fails here without spending the budget.
      await this.backend.ensureCollection(g.collection_name,{dimensions:g.dimensions,distance:g.distance});
      while(processed<maxDocuments){
        const item=this.db.prepare("SELECT * FROM memory_vector_manifest WHERE generation=? AND state='pending' ORDER BY memory_id LIMIT 1").get(id);
        if(!item){complete=true;break;}
        const user=this.ownerId||this.db.prepare('SELECT user_id FROM memory_vector_owners WHERE generation=?').get(id)?.user_id;
        const source=this.store.derivedMemory.currentSource(user,item.memory_id);
        const mark=state=>this.store.memoryTransaction(()=>{if(!this.owns(g))fail('LEASE_LOST');this.db.prepare('UPDATE memory_vector_manifest SET state=? WHERE generation=? AND memory_id=?').run(state,id,item.memory_id);});
        const raw={user_id:user,memory_id:item.memory_id},old=this.db.prepare('SELECT * FROM memory_vector_documents WHERE generation=? AND user_id=? AND memory_id=?').get(id,user,item.memory_id);
        // Only the frozen source may resume. Stale items clean up every partial checkpoint without embedding the
        // newer revision; full and manifest builds share the same request budgets and durable publication fence.
        const frozen=source&&source.revision===item.revision&&source.state_hash===item.state_hash;
        const result=await this.indexRecord(g,e,id,raw,frozen?source:null,old,{purpose:'manifest'});
        mark(result==='indexed'?'indexed':'stale');
        processed++;
      }
      if(complete)this.db.prepare("UPDATE memory_vector_generations SET state=CASE WHEN state IN ('active','retired') THEN state ELSE 'ready' END WHERE generation=? AND fence=?").run(id,g.fence);
      return {processed,complete,generation:id,manifest:this.manifestCounts(id)};
    }finally{this.db.prepare('UPDATE memory_vector_generations SET lease_owner=NULL,lease_expires=NULL WHERE generation=? AND fence=? AND lease_owner=?').run(id,g.fence,g.lease_owner);}
  }
  /** Rollback for the owner: stop serving this generation (semantic search falls back to lexical). Nothing is deleted. */
  deactivate(id){this.assertOwner(id);return this.store.memoryTransaction(()=>{
    const active=this.ownerId?this.db.prepare('SELECT generation FROM memory_vector_owner_active WHERE user_id=?').get(this.ownerId):this.db.prepare('SELECT generation FROM memory_vector_active WHERE id=1').get();
    if(active?.generation!==id)fail('VECTOR_NOT_ACTIVE');
    if(this.ownerId)this.db.prepare('DELETE FROM memory_vector_owner_active WHERE user_id=?').run(this.ownerId);else this.db.prepare('DELETE FROM memory_vector_active WHERE id=1').run();
    this.db.prepare("UPDATE memory_vector_generations SET state='ready' WHERE generation=?").run(id);
    return {generation:id,state:'ready',serving:false};
  });}
  activate(id){this.assertOwner(id);return this.store.memoryTransaction(()=>{
    const g=this.db.prepare('SELECT * FROM memory_vector_generations WHERE generation=?').get(id);
    const manifest=this.manifestCounts(id),frozen=Object.keys(manifest).length>0;
    // A retired first-run generation can be re-activated (rollback) without re-embedding.
    if(!g || !(g.state==='ready' || frozen&&g.state==='retired') || g.lease_expires>this.clock())fail('VECTOR_NOT_READY');
    if(frozen){if(manifest.pending)fail('VECTOR_CATCHUP_REQUIRED');}
    // Full authoritative coverage check includes writes that raced with backfill.
    else for(let after=0;;){const rows=this.db.prepare('SELECT rowid AS cursor_id,user_id,memory_id FROM memories WHERE rowid>? AND (? IS NULL OR user_id=?) ORDER BY rowid LIMIT 100').all(after,this.ownerId,this.ownerId);if(!rows.length)break;
      for(const raw of rows){const s=this.store.derivedMemory.currentSource(raw.user_id,raw.memory_id);if(!s)continue;
        const indexed=this.db.prepare('SELECT * FROM memory_vector_documents WHERE generation=? AND user_id=? AND memory_id=?').get(id,s.user_id,s.memory_id);
        if(!indexed || indexed.state!=='indexed' || indexed.revision!==s.revision || indexed.state_hash!==s.state_hash || indexed.scope_key!==s.scope_key)fail('VECTOR_CATCHUP_REQUIRED');}
      after=rows.at(-1).cursor_id;
    }
    this.db.prepare("UPDATE memory_vector_generations SET state='retired' WHERE state='active' AND generation IN (SELECT generation FROM memory_vector_owners WHERE user_id=?)").run(this.ownerId);
    if(!this.ownerId)this.db.prepare("UPDATE memory_vector_generations SET state='retired' WHERE state='active' AND generation NOT IN (SELECT generation FROM memory_vector_owners)").run();
    this.db.prepare("UPDATE memory_vector_generations SET state='active' WHERE generation=?").run(id);
    if(this.ownerId)this.db.prepare('INSERT OR REPLACE INTO memory_vector_owner_active VALUES(?,?,?,?)').run(this.ownerId,id,g.profile,g.collection_name);
    else this.db.prepare('INSERT OR REPLACE INTO memory_vector_active VALUES (1,?,?,?)').run(id,g.profile,g.collection_name);
    return this.snapshot();
  });}
  async reconcile(id){
    // Maintenance shares the writer's atomic lease, including retired generations. It must never remove a point
    // in the interval between a successful upsert and the writer's local checkpoint commit.
    const g=this.acquire(id,{maintenance:true});let offset=null,removed=0;
    try{do{this.renew(g);const page=await this.backend.scroll(g.collection_name,offset);if(!this.owns(g))fail('LEASE_LOST');
      for(const point of page.points){const mapping=this.db.prepare('SELECT * FROM memory_vector_points WHERE point_id=? AND generation=?').get(String(point.id),id),source=mapping && this.store.derivedMemory.currentSource(mapping.user_id,mapping.memory_id);
        if(!source || source.revision!==mapping.revision){this.renew(g);await this.backend.deleteByDocumentRevision(g.collection_name,{must:[{has_id:[point.id]}]});if(!this.owns(g))fail('LEASE_LOST');removed++;}}
      offset=page.next_page_offset ?? null;
    }while(offset!==null);return {removed};
    }finally{this.db.prepare('UPDATE memory_vector_generations SET lease_owner=NULL,lease_expires=NULL WHERE generation=? AND fence=? AND lease_owner=?').run(id,g.fence,g.lease_owner);}
  }
  async search(auth,payload){if(this.ownerId&&this.ownerId!==auth.user_id)fail('INVALID_OWNER');
    this.store.requireScope(auth,'memory:read');
    const searchContext=payload[MEMORY_SEARCH_CONTEXT];
    const mode=payload.mode || 'hybrid';if(!['lexical','hybrid','semantic'].includes(mode))fail('INVALID_RETRIEVAL_MODE');
    if(mode==='lexical')return this.store.queryMemories(auth,payload);
    // Existing validation and exact scope resolution remain authoritative.
    let lexical=this.store.queryMemories(auth,{...payload,limit:Math.min(payload.limit || 10,20)});
    let scope=resolveMemoryScope(this.db,auth.user_id,payload);const limit=lexical.result_limit;
    // Public memory_type filters need the same pre-window document restriction as Console traits.
    // An explicit selection of all types is equivalent to the default and needs no extra allowlist.
    const memoryTypes=payload.memory_types&&new Set(payload.memory_types).size<MEMORY_TYPES.size?payload.memory_types:undefined;
    try{
      const snapshot=this.snapshot(),e=this.embedders.get(snapshot.profile);if(!e)fail('NOT_CONFIGURED');
      const relevance=semanticPolicy(this.store.memoryConfig.memory?.retrieval,e.profile);if(!relevance)fail('RELEVANCE_NOT_CONFIGURED');
      let scopeSql=memoryScopeSql(scope,{workstreamIds:payload.source_workstream_ids || (payload.workstream_id?[payload.workstream_id]:null),includeShared:payload.include_shared!==false}),library=memorySearchFilterSql(searchContext?.filter,{memoryTypes});
      const assertWebIndexFresh=()=>{
        if(!isWebReader(auth))return;
        const documents=this.db.prepare(`SELECT m.memory_id,d.revision,d.state_hash,d.scope_key,d.state FROM memories m
          LEFT JOIN memory_vector_documents d ON d.user_id=m.user_id AND d.memory_id=m.memory_id AND d.generation=?
          WHERE m.user_id=? AND m.status='active' AND ${scopeSql.sql} AND ${webMemorySql(auth)} AND ${library.sql}`)
          .iterate(snapshot.generation,auth.user_id,...scopeSql.params,...library.params);
        for(const document of documents)if(document.state!=='indexed' || !this.store.derivedMemory.validateItem({...document,user_id:auth.user_id}))fail('VECTOR_STALE');
      };
      assertWebIndexFresh();
      const scopes=this.db.prepare(`SELECT DISTINCT m.user_id,m.scope,m.project_id,m.task_id,m.workstream_id,m.session_id FROM memories m WHERE m.user_id=? AND m.status='active' AND ${scopeSql.sql} AND ${webMemorySql(auth)} AND ${library.sql} LIMIT 129`).all(auth.user_id,...scopeSql.params,...library.params);
      if(scopes.length>128)fail('VECTOR_SCOPE_TOO_BROAD');
      const filter={must:[condition('owner',surrogate(auth.user_id)),condition('profile',snapshot.profile),condition('lifecycle','active'),{key:'scope',match:{any:scopes.map(row=>surrogate(scopeKey(row)))}}]};
      if(library.active){
        const documents=this.db.prepare(`SELECT m.memory_id FROM memories m WHERE m.user_id=? AND m.status='active'
          AND ${scopeSql.sql} AND ${webMemorySql(auth)} AND ${library.sql} ORDER BY m.memory_id LIMIT ?`).all(auth.user_id,...scopeSql.params,...library.params,VECTOR_FILTER_DOCUMENT_LIMIT+1);
        // Never truncate this allowlist and return a false "no match". Hybrid can explicitly
        // degrade to the correctly filtered lexical path; semantic reports unavailability.
        if(documents.length>VECTOR_FILTER_DOCUMENT_LIMIT)fail('VECTOR_FILTER_TOO_BROAD');
        filter.must.push({key:'document',match:{any:documents.map(row=>surrogate([auth.user_id,row.memory_id]))}});
      }
      const {vectors}=await this.embed(e,[payload.query],'query',{userId:auth.user_id});
      const semantic=[],semanticScores=new Map(),excludedIds=new Set(),excludedDocs=new Set(),allowedScopes=new Set(scopes.map(row=>surrogate(scopeKey(row))));
      let hits=[],currentHits=new Map(),rejected=0,candidateWindowFull=false;
      // A late/uncertain remote write can leave an unmapped active point ahead of its document's current build.
      // Retry the grouped lookup with exact exclusions, reusing this query vector and every private filter. A
      // backend that keeps returning excluded/stale candidates fails explicitly instead of producing false emptiness.
      for(let attempt=0;attempt<VECTOR_GROUP_QUERY_ATTEMPTS;attempt++){
        const exclusions=[...(filter.must_not||[]),...(excludedIds.size?[{has_id:[...excludedIds]}]:[]),
          ...(excludedDocs.size?[{key:'document',match:{any:[...excludedDocs]}}]:[])];
        hits=scopes.length?await this.backend.search(snapshot.collection_name,vectors[0],{...filter,...(exclusions.length?{must_not:exclusions}:{})},100):[];
        candidateWindowFull ||= hits.length>=100;
        // Re-resolve after every network wait. Lifecycle/permission changes are authoritative, not a reason to
        // serve an earlier cached candidate or to widen the backend's original owner/scope/document filters.
        scope=resolveMemoryScope(this.db,auth.user_id,payload);
        scopeSql=memoryScopeSql(scope,{workstreamIds:payload.source_workstream_ids || (payload.workstream_id?[payload.workstream_id]:null),includeShared:payload.include_shared!==false});
        library=memorySearchFilterSql(searchContext?.filter,{memoryTypes});assertWebIndexFresh();currentHits=new Map();
        const before=excludedIds.size+excludedDocs.size;let stale=false;
        for(const hit of hits){
          // Foreign/out-of-scope injected backend responses do not contribute to diagnostics or retries.
          if(hit.payload?.owner!==surrogate(auth.user_id)||hit.payload?.profile!==snapshot.profile||hit.payload?.lifecycle!=='active'||!allowedScopes.has(hit.payload?.scope))continue;
          const point=this.db.prepare('SELECT * FROM memory_vector_points WHERE point_id=? AND generation=? AND user_id=?').get(String(hit.id),snapshot.generation,auth.user_id);
          if(!point){excludedIds.add(String(hit.id));stale=true;continue;}
          const indexed=this.db.prepare("SELECT * FROM memory_vector_documents WHERE generation=? AND user_id=? AND memory_id=? AND state='indexed'").get(snapshot.generation,auth.user_id,point.memory_id);
          const row=this.db.prepare(`SELECT m.* FROM memories m WHERE m.user_id=? AND m.memory_id=? AND m.status='active' AND ${scopeSql.sql} AND ${library.sql}`).get(auth.user_id,point.memory_id,...scopeSql.params,...library.params);
          const source=row&&this.store.derivedMemory.currentSource(auth.user_id,point.memory_id);
          if(!indexed||indexed.revision!==point.revision||!row||!this.store.webVisibility.visible(auth,row.memory_id)
            ||payload.statuses&&!payload.statuses.includes(row.status)||payload.memory_types&&!payload.memory_types.includes(row.memory_type)
            ||!source||source.revision!==point.revision||indexed.state_hash!==source.state_hash||indexed.scope_key!==source.scope_key||indexed.content_hash!==digest(source.content)){
            excludedDocs.add(surrogate([auth.user_id,point.memory_id]));stale=true;continue;
          }
          if(hit.payload?.content_hash!==indexed.content_hash
            ||hit.payload.build!==undefined&&pointId('vector-point-v2',hit.payload.build,point.chunk)!==point.point_id){excludedIds.add(String(hit.id));stale=true;continue;}
          currentHits.set(String(hit.id),{row,source});
        }
        if(!stale)break;
        if(attempt===VECTOR_GROUP_QUERY_ATTEMPTS-1||excludedIds.size+excludedDocs.size===before)fail('VECTOR_STALE');
      }
      // Network waits may outlive a privacy change; rebuild lexical results and conflicts now.
      lexical=this.store.queryMemories(auth,{...payload,limit});
      const plan=searchContext?.documentSimilarity?makeQueryPlan(payload.query):this.store.memorySearch.plan(auth.user_id,payload.query,scope,{auth,searchContext,
        workstreamIds:payload.source_workstream_ids||(payload.workstream_id?[payload.workstream_id]:null),includeShared:payload.include_shared!==false,
        statuses:payload.statuses||['active'],memoryTypes:payload.memory_types||['fact','goal','constraint','decision','completed','blocker','remaining','next_step']});
      // Filter absolute model scores BEFORE rank fusion; the first neighbour may itself
      // be unrelated. Sort before dedup so a many-chunk record contributes only its best hit.
      const scoreOrder=hit=>Number.isFinite(hit.score)?(relevance.direction==='maximum'?-hit.score:hit.score):-Infinity;
      const qualified=[...hits].sort((a,b)=>scoreOrder(b)-scoreOrder(a));
      for(const hit of qualified){
        const current=currentHits.get(String(hit.id));if(!current)continue;const {row,source}=current;
        // Counts, too, are scoped: hidden/foreign/stale hits never affect returned diagnostics.
        const searchable=memorySearchText({...source,concepts:this.store.traits.get(auth.user_id,source.memory_id).concepts});
        if(!acceptsSemanticScore(hit.score,relevance)||!querySubjectsMatch(plan,searchable)||(plan.authority_ids&&!plan.authority_ids.includes(source.memory_id))){rejected++;continue;}
        if(!semantic.some(m=>m.memory_id===row.memory_id)) {
          semanticScores.set(row.memory_id,hit.score);
          const memory=memorySummary(this.store.memoryFromRow(row));semantic.push(isWebReader(auth)?this.store.webVisibility.project(auth,memory):memory);
        }
      }
      const ranked=new Map(),add=(items,method)=>items.forEach((item,index)=>{const old=ranked.get(item.memory_id) || {item,rrf:0,methods:[]};old.rrf+=1/(60+index+1);old.methods.push(method);ranked.set(item.memory_id,old);});
      if(mode==='hybrid')add(lexical.results,'lexical');add(semantic,'semantic');
      const query=normalizeSearch(payload.query.trim());
      for(const r of ranked.values()){
        // Evaluate the full original query, never the expansion or the truncated preview. Preserve
        // proven alias explanations even when the same record also appears among semantic hits.
        const source=this.store.derivedMemory.currentSource(auth.user_id,r.item.memory_id),text=source&&normalizeSearch(`${source.content}\n${source.topic||''}`);
        r.kind=source&&originalMatchKind(payload.query,{...source,concepts:this.store.traits.get(auth.user_id,r.item.memory_id).concepts})|| (r.item.ranking?.match_kind==='alias'?'alias':'semantic');
      }
      // Within a match tier the fused score is scaled by strength and recent assistant reads (memory/salience.mjs).
      const salience=this.store.salience.of(auth.user_id,[...ranked.keys()]);
      for(const r of ranked.values()){r.salience=salience.get(r.item.memory_id);r.score=r.rrf*r.salience.factor;}
      const priority={raw_query:0,original_terms:1,alias:2,semantic:3};
      // Save-time duplicate hints ask for the nearest documents. Applying the general search's salience
      // before their small result window can displace a true duplicate with a popular, less similar record.
      const similarity=mode==='semantic'&&searchContext?.documentSimilarity;
      const compare=(a,b)=>similarity?scoreOrder({score:semanticScores.get(b.item.memory_id)})-scoreOrder({score:semanticScores.get(a.item.memory_id)}):
        (mode==='semantic'?Number(b.kind==='raw_query')-Number(a.kind==='raw_query'):priority[a.kind]-priority[b.kind])||b.score-a.score;
      const result=[...ranked.values()].sort((a,b)=>compare(a,b)||a.item.memory_id.localeCompare(b.item.memory_id)).slice(0,limit)
        .map(r=>({...r.item,ranking:{...r.item.ranking,method:similarity?'semantic-score-v1':'rrf-salience-v2',score:similarity?semanticScores.get(r.item.memory_id):r.score,rrf_score:r.rrf,strength_score:r.salience.strength_term,read_score:r.salience.read_term,match_kind:r.kind,matched_by:r.methods,...(semanticScores.has(r.item.memory_id)?{semantic_score:semanticScores.get(r.item.memory_id)}:{})}}));
      lexical.results=result;lexical.result_count=result.length;lexical.retrieval={...lexical.retrieval,engine:'memory-hybrid-v1',mode,requested_mode:mode,effective_mode:mode,degraded:false,profile:snapshot.profile,generation:snapshot.generation,semantic_candidates:semantic.length,semantic_rejected:rejected,semantic_threshold:relevance.threshold,semantic_threshold_direction:relevance.direction,semantic_distance:relevance.distance,semantic_normalization:e.profile.normalization,relevance_policy:'query-relevance-v1',alias_expanded:plan.expanded,alias_ambiguous:plan.ambiguous,alias_source_truncated:plan.source_truncated};
      // A full backend document window is a bound, not proof that there are no further current candidates. Keep
      // this visible even when hydration rejected stale points and the final result contains fewer than `limit`.
      lexical.retrieval.semantic_candidate_limit=100;
      lexical.retrieval.semantic_candidates_truncated=candidateWindowFull;
      lexical.retrieval.result_truncated ||= ranked.size>limit||candidateWindowFull;
      boundMemoryResponse(lexical);return lexical;
    }catch(error){
      // A lifecycle/validation/authorization outcome during or after the wait (e.g. the requested project was deleted
      // meanwhile: PROJECT_DELETED) is the answer, not provider degradation.
      if(isDeterministicReadError(error))throw error;
      const code=isRetrievalDegradation(error.code)?error.code:'VECTOR_UNAVAILABLE';
      if(mode==='semantic')throw Object.assign(new Error('Semantic retrieval unavailable.'),{statusCode:503,code:'SEMANTIC_UNAVAILABLE',errorCode:'SEMANTIC_UNAVAILABLE',degradation_code:code});
      lexical=this.store.queryMemories(auth,{...payload,limit});
      lexical.retrieval={...lexical.retrieval,mode,requested_mode:mode,effective_mode:'lexical',degraded:true,fallback:'lexical',degradation_code:code};return lexical;
    }
  }
}

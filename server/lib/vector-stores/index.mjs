import {randomUUID} from 'node:crypto';
import {digest,fail,integer} from '../model-providers/contracts.mjs';
import {memoryScopeSql,resolveMemoryScope} from '../memory-scope.mjs';
import {memorySummary,boundMemoryResponse} from '../memory-projection.mjs';
import {scopeKey} from '../memory-derived/store.mjs';
import {normalizeSearch,searchTokens} from '../memory-retrieval.mjs';
import {isWebReader,webMemorySql} from '../memory/web-visibility.mjs';

export const surrogate=value=>digest(['vector-private-v1',value]);
const pointId=(...values)=>{const h=digest(values);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
const condition=(key,value)=>({key,match:{value}});
export function splitDocument(content,maxBytes){
  integer(maxBytes,16,1000000);const parts=[];let text='',bytes=0;
  for(const char of content){const n=Buffer.byteLength(char);if(bytes+n>maxBytes){parts.push(text);text='';bytes=0;}text+=char;bytes+=n;}
  if(text)parts.push(text);return parts;
}
export class VectorIndex {
  constructor(store,backend,embedders,{clock=()=>Date.now(),leaseMs=120000,prefix='memory',ownerId=null}={}){
    this.store=store;this.db=store.db;this.backend=backend;this.embedders=embedders;this.clock=clock;this.leaseMs=leaseMs;this.prefix=prefix;this.ownerId=ownerId;
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
      CREATE TABLE IF NOT EXISTS memory_owner_vector_usage (user_id TEXT NOT NULL,profile TEXT NOT NULL,day TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(user_id,profile,day));`);
  }
  reserve(embedder,userId){this.store.memoryTransaction(()=>{const p=embedder.profile,day=new Date(this.clock()).toISOString().slice(0,10);
    if(typeof userId!=='string'||!userId)fail('INVALID_OWNER');
    if(this.db.prepare('SELECT state FROM memory_profile_state WHERE profile=?').get(p.fingerprint)?.state==='blocked_auth')fail('AUTH_FAILED');
    this.db.prepare('INSERT OR IGNORE INTO memory_vector_calls VALUES (?,?,0)').run(p.fingerprint,day);
    const probes=this.ownerId?this.db.prepare('SELECT reserved_calls n FROM memory_model_budget WHERE profile=? AND day=?').get(p.fingerprint,day)?.n||0:0;
    if(probes+this.db.prepare('SELECT count FROM memory_vector_calls WHERE profile=? AND day=?').get(p.fingerprint,day).count>=p.limits.daily_requests)fail('BUDGET_EXHAUSTED');
    this.db.prepare('UPDATE memory_vector_calls SET count=count+1 WHERE profile=? AND day=?').run(p.fingerprint,day);
    this.db.prepare(`INSERT INTO memory_owner_vector_usage VALUES(?,?,?,1) ON CONFLICT(user_id,profile,day)
      DO UPDATE SET count=count+1`).run(userId,p.fingerprint,day);
  });}
  async embed(embedder,texts,inputType,{userId,...options}){try{return await embedder.embed(texts,inputType,{...options,reserve:()=>this.reserve(embedder,userId)});}
    catch(error){if(error.code==='AUTH_FAILED')this.db.prepare('INSERT OR REPLACE INTO memory_profile_state VALUES (?,?)').run(embedder.profile.fingerprint,'blocked_auth');throw error;}}
  begin(profile){
    const embedder=this.embedders.get(profile);if(!embedder?.profile.enabled)fail('NOT_CONFIGURED');
    const generation=randomUUID(),name=this.prefix+'_'+digest([generation,profile]).slice(0,32),p=embedder.profile;
    this.db.prepare('INSERT INTO memory_vector_generations VALUES (?,?,?,?,?,?,?,NULL,NULL,0,0)').run(generation,profile,name,'building',p.dimensions,p.distance,this.clock());if(this.ownerId)this.db.prepare('INSERT INTO memory_vector_owners VALUES(?,?)').run(generation,this.ownerId);return generation;
  }
  snapshot(){const active=this.ownerId?this.db.prepare('SELECT * FROM memory_vector_owner_active WHERE user_id=?').get(this.ownerId):this.db.prepare('SELECT * FROM memory_vector_active WHERE id=1').get();if(!active)fail('VECTOR_NOT_READY');return Object.freeze({...active});}
  state(){if(this.ownerId)return {generations:this.db.prepare('SELECT g.state,COUNT(*) AS count FROM memory_vector_generations g JOIN memory_vector_owners o ON o.generation=g.generation WHERE o.user_id=? GROUP BY g.state').all(this.ownerId),active:!!this.db.prepare('SELECT 1 FROM memory_vector_owner_active WHERE user_id=?').get(this.ownerId)};return {generations:this.db.prepare('SELECT state,COUNT(*) AS count FROM memory_vector_generations GROUP BY state').all(),active:!!this.db.prepare('SELECT 1 FROM memory_vector_active').get()};}
  assertOwner(id){const owner=this.db.prepare('SELECT user_id FROM memory_vector_owners WHERE generation=?').get(id)?.user_id||null;if(owner!==this.ownerId)fail('VECTOR_NOT_READY');}
  acquire(id){this.assertOwner(id);return this.store.memoryTransaction(()=>{const row=this.db.prepare('SELECT * FROM memory_vector_generations WHERE generation=?').get(id),now=this.clock();
    if(!row || !['building','ready','active'].includes(row.state) || row.lease_expires>now)fail('VECTOR_LEASE_BUSY');
    const owner=randomUUID();this.db.prepare('UPDATE memory_vector_generations SET lease_owner=?,lease_expires=?,fence=fence+1 WHERE generation=?').run(owner,now+this.leaseMs,id);
    return {...row,fence:row.fence+1,lease_owner:owner};
  });}
  owns(g){const row=this.db.prepare('SELECT * FROM memory_vector_generations WHERE generation=?').get(g.generation);return row && row.fence===g.fence && row.lease_owner===g.lease_owner && row.lease_expires>this.clock();}
  renew(g){if(!this.owns(g))fail('LEASE_LOST');this.db.prepare('UPDATE memory_vector_generations SET lease_expires=? WHERE generation=?').run(this.clock()+this.leaseMs,g.generation);}
  async sync(id,{maxDocuments=10000}={}){
    integer(maxDocuments,1,1000000);const g=this.acquire(id),e=this.embedders.get(g.profile);let processed=0,after=0,complete=false;
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
          this.renew(g);
          const filter={must:[condition('owner',surrogate(raw.user_id)),condition('document',surrogate([raw.user_id,raw.memory_id]))]};
          if(!source || !e.profile.egress.sensitivities.includes(source.sensitivity)){
            await this.backend.deleteByDocumentRevision(g.collection_name,filter);
            this.store.memoryTransaction(()=>{if(!this.owns(g))fail('LEASE_LOST');const revision=this.store.revisions.latest(raw.user_id,raw.memory_id);
              this.db.prepare('INSERT OR REPLACE INTO memory_vector_documents VALUES (?,?,?,?,?,?,?,?)').run(id,raw.user_id,raw.memory_id,revision?.revision || 0,revision?.state_hash || '',old?.scope_key || '',revision?.content_hash || '', 'hidden');
              this.db.prepare('DELETE FROM memory_vector_points WHERE generation=? AND user_id=? AND memory_id=?').run(id,raw.user_id,raw.memory_id);});processed++;continue;
          }
          const chunks=splitDocument(source.content,Math.min(8192,Math.floor(e.profile.limits.input_tokens/4))),points=[];
          for(let start=0;start<chunks.length;start+=e.profile.limits.batch_size){
            this.renew(g);const part=chunks.slice(start,start+e.profile.limits.batch_size);
            const result=await this.embed(e,part,'document',{sensitivity:source.sensitivity,userId:source.user_id});
            if(!this.owns(g) || !this.store.derivedMemory.validateItem(source))fail('STALE_INPUT');
            for(const [i,vector] of result.vectors.entries())points.push({id:pointId(id,source.user_id,source.memory_id,source.revision,g.profile,start+i),vector,
              payload:{owner:surrogate(source.user_id),scope:surrogate(source.scope_key),document:surrogate([source.user_id,source.memory_id]),revision:source.revision,
                profile:g.profile,content_hash:digest(source.content),lifecycle:'active'}});
          }
          // Delete only older revisions. Repeating the same upsert is idempotent.
          await this.backend.deleteByDocumentRevision(g.collection_name,{...filter,must_not:[condition('revision',source.revision)]});
          for(let start=0;start<points.length;start+=64){this.renew(g);await this.backend.upsert(g.collection_name,points.slice(start,start+64));}
          this.store.memoryTransaction(()=>{
            if(!this.owns(g) || !this.store.derivedMemory.validateItem(source))fail('STALE_INPUT');
            this.db.prepare('INSERT OR REPLACE INTO memory_vector_documents VALUES (?,?,?,?,?,?,?,?)').run(id,source.user_id,source.memory_id,source.revision,source.state_hash,source.scope_key,digest(source.content),'indexed');
            this.db.prepare('DELETE FROM memory_vector_points WHERE generation=? AND user_id=? AND memory_id=?').run(id,source.user_id,source.memory_id);
            for(const [chunk,point] of points.entries())this.db.prepare('INSERT OR REPLACE INTO memory_vector_points VALUES (?,?,?,?,?,?)').run(point.id,id,source.user_id,source.memory_id,source.revision,chunk);
            this.db.prepare("UPDATE memory_index_outbox SET state='indexed' WHERE user_id=? AND memory_id=? AND revision=?").run(source.user_id,source.memory_id,source.revision);
          });
          processed++;if(processed>=maxDocuments)break;
        }
      }
      if(after>=highwater)complete=true;
      if(complete)this.db.prepare("UPDATE memory_vector_generations SET state=CASE WHEN state='active' THEN state ELSE 'ready' END,checkpoint=? WHERE generation=? AND fence=?")
        .run(this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM memory_index_outbox').get().n,id,g.fence);
      return {processed,complete,generation:id};
    }finally{this.db.prepare('UPDATE memory_vector_generations SET lease_owner=NULL,lease_expires=NULL WHERE generation=? AND fence=? AND lease_owner=?').run(id,g.fence,g.lease_owner);}
  }
  activate(id){this.assertOwner(id);return this.store.memoryTransaction(()=>{
    const g=this.db.prepare('SELECT * FROM memory_vector_generations WHERE generation=?').get(id);if(!g || g.state!=='ready' || g.lease_expires>this.clock())fail('VECTOR_NOT_READY');
    // Full authoritative coverage check includes writes that raced with backfill.
    let after=0;for(;;){const rows=this.db.prepare('SELECT rowid AS cursor_id,user_id,memory_id FROM memories WHERE rowid>? AND (? IS NULL OR user_id=?) ORDER BY rowid LIMIT 100').all(after,this.ownerId,this.ownerId);if(!rows.length)break;
      for(const raw of rows){const s=this.store.derivedMemory.currentSource(raw.user_id,raw.memory_id);if(!s || !this.embedders.get(g.profile).profile.egress.sensitivities.includes(s.sensitivity))continue;
        const indexed=this.db.prepare('SELECT * FROM memory_vector_documents WHERE generation=? AND user_id=? AND memory_id=?').get(id,s.user_id,s.memory_id);
        if(!indexed || indexed.revision!==s.revision || indexed.state_hash!==s.state_hash || indexed.scope_key!==s.scope_key)fail('VECTOR_CATCHUP_REQUIRED');}
      after=rows.at(-1).cursor_id;
    }
    this.db.prepare("UPDATE memory_vector_generations SET state='retired' WHERE state='active' AND generation IN (SELECT generation FROM memory_vector_owners WHERE user_id=?)").run(this.ownerId);
    if(!this.ownerId)this.db.prepare("UPDATE memory_vector_generations SET state='retired' WHERE state='active' AND generation NOT IN (SELECT generation FROM memory_vector_owners)").run();
    this.db.prepare("UPDATE memory_vector_generations SET state='active' WHERE generation=?").run(id);
    if(this.ownerId)this.db.prepare('INSERT OR REPLACE INTO memory_vector_owner_active VALUES(?,?,?,?)').run(this.ownerId,id,g.profile,g.collection_name);
    else this.db.prepare('INSERT OR REPLACE INTO memory_vector_active VALUES (1,?,?,?)').run(id,g.profile,g.collection_name);
    return this.snapshot();
  });}
  async reconcile(id){this.assertOwner(id);
    const g=this.db.prepare('SELECT * FROM memory_vector_generations WHERE generation=?').get(id);if(!g)fail('VECTOR_NOT_READY');let offset=null,removed=0;
    do{const page=await this.backend.scroll(g.collection_name,offset);
      for(const point of page.points){const mapping=this.db.prepare('SELECT * FROM memory_vector_points WHERE point_id=? AND generation=?').get(String(point.id),id),source=mapping && this.store.derivedMemory.currentSource(mapping.user_id,mapping.memory_id);
        if(!source || source.revision!==mapping.revision){await this.backend.deleteByDocumentRevision(g.collection_name,{must:[{has_id:[point.id]}]});removed++;}}
      offset=page.next_page_offset ?? null;
    }while(offset!==null);return {removed};
  }
  async search(auth,payload){if(this.ownerId&&this.ownerId!==auth.user_id)fail('INVALID_OWNER');
    this.store.requireScope(auth,'memory:read');
    const mode=payload.mode || 'lexical';if(!['lexical','hybrid','semantic'].includes(mode))fail('INVALID_RETRIEVAL_MODE');
    if(mode==='lexical')return this.store.queryMemories(auth,payload);
    // Existing validation and exact scope resolution remain authoritative.
    let lexical=this.store.queryMemories(auth,{...payload,limit:Math.min(payload.limit || 10,20)});
    const scope=resolveMemoryScope(this.db,auth.user_id,payload),limit=lexical.result_limit;
    try{
      const snapshot=this.snapshot(),e=this.embedders.get(snapshot.profile);if(!e)fail('NOT_CONFIGURED');
      const scopeSql=memoryScopeSql(scope,{workstreamIds:payload.source_workstream_ids || (payload.workstream_id?[payload.workstream_id]:null),includeShared:payload.include_shared!==false});
      const assertWebIndexFresh=()=>{
        if(!isWebReader(auth))return;
        const documents=this.db.prepare(`SELECT m.memory_id,d.revision,d.state_hash,d.scope_key,d.state FROM memories m
          LEFT JOIN memory_vector_documents d ON d.user_id=m.user_id AND d.memory_id=m.memory_id AND d.generation=?
          WHERE m.user_id=? AND m.status='active' AND ${scopeSql.sql} AND ${webMemorySql(auth)}`)
          .iterate(snapshot.generation,auth.user_id,...scopeSql.params);
        for(const document of documents)if(document.state!=='indexed' || !this.store.derivedMemory.validateItem({...document,user_id:auth.user_id}))fail('VECTOR_STALE');
      };
      assertWebIndexFresh();
      const scopes=this.db.prepare(`SELECT DISTINCT m.user_id,m.scope,m.project_id,m.task_id,m.workstream_id,m.session_id FROM memories m WHERE m.user_id=? AND m.status='active' AND ${scopeSql.sql} AND ${webMemorySql(auth)} LIMIT 129`).all(auth.user_id,...scopeSql.params);
      if(scopes.length>128)fail('VECTOR_SCOPE_TOO_BROAD');
      const filter={must:[condition('owner',surrogate(auth.user_id)),condition('profile',snapshot.profile),condition('lifecycle','active'),{key:'scope',match:{any:scopes.map(row=>surrogate(scopeKey(row)))}}]};
      const {vectors}=await this.embed(e,[payload.query],'query',{sensitivity:'sensitive',userId:auth.user_id});
      const hits=scopes.length?await this.backend.search(snapshot.collection_name,vectors[0],filter,100):[],semantic=[];
      assertWebIndexFresh();
      // Network waits may outlive a privacy change; rebuild lexical results and conflicts now.
      lexical=this.store.queryMemories(auth,{...payload,limit});
      for(const hit of hits){
        const point=this.db.prepare('SELECT * FROM memory_vector_points WHERE point_id=? AND generation=? AND user_id=?').get(String(hit.id),snapshot.generation,auth.user_id);if(!point)continue;
        const row=this.db.prepare(`SELECT m.* FROM memories m WHERE m.user_id=? AND m.memory_id=? AND m.status='active' AND ${scopeSql.sql}`).get(auth.user_id,point.memory_id,...scopeSql.params);
        if(!row || !this.store.webVisibility.visible(auth,row.memory_id) || payload.statuses && !payload.statuses.includes(row.status)
          || payload.memory_types && !payload.memory_types.includes(row.memory_type))continue;
        const source=this.store.derivedMemory.currentSource(auth.user_id,point.memory_id);
        if(!source || source.revision!==point.revision || hit.payload?.content_hash!==digest(source.content) || hit.payload?.profile!==snapshot.profile || !e.profile.egress.sensitivities.includes(source.sensitivity))continue;
        if(!semantic.some(m=>m.memory_id===row.memory_id)) {
          const memory=memorySummary(this.store.memoryFromRow(row));semantic.push(isWebReader(auth)?this.store.webVisibility.project(auth,memory):memory);
        }
      }
      const ranked=new Map(),add=(items,method)=>items.forEach((item,index)=>{const old=ranked.get(item.memory_id) || {item,rrf:0,methods:[]};old.rrf+=1/(60+index+1);old.methods.push(method);ranked.set(item.memory_id,old);});
      if(mode==='hybrid')add(lexical.results,'lexical');add(semantic,'semantic');
      const query=normalizeSearch(payload.query.trim()),terms=searchTokens(query),exact=new Set();
      for(const {item} of ranked.values()){
        // Preview text may be truncated; identifier boundaries belong to the full source.
        const source=this.store.derivedMemory.currentSource(auth.user_id,item.memory_id),text=source && normalizeSearch(source.content);
        const tokens=text?.includes(query)?new Set(searchTokens(text)):null;
        if(item.memory_id===payload.query || tokens && terms.every(token=>tokens.has(token)))exact.add(item.memory_id);
      }
      const result=[...ranked.values()].sort((a,b)=>Number(exact.has(b.item.memory_id))-Number(exact.has(a.item.memory_id)) || b.rrf-a.rrf || a.item.memory_id.localeCompare(b.item.memory_id)).slice(0,limit)
        .map(r=>({...r.item,ranking:{method:'rrf-v1',score:r.rrf,matched_by:r.methods}}));
      lexical.results=result;lexical.result_count=result.length;lexical.retrieval={...lexical.retrieval,engine:'memory-hybrid-v1',mode,requested_mode:mode,effective_mode:mode,degraded:false,profile:snapshot.profile,generation:snapshot.generation,semantic_candidates:semantic.length};
      boundMemoryResponse(lexical);return lexical;
    }catch(error){
      const code=['EGRESS_DENIED','BUDGET_EXHAUSTED','VECTOR_NOT_READY','VECTOR_STALE','AUTH_FAILED','NOT_CONFIGURED'].includes(error.code)?error.code:'VECTOR_UNAVAILABLE';
      if(mode==='semantic')throw Object.assign(new Error('Semantic retrieval unavailable.'),{statusCode:503,code:'SEMANTIC_UNAVAILABLE',errorCode:'SEMANTIC_UNAVAILABLE',degradation_code:code});
      lexical=this.store.queryMemories(auth,{...payload,limit});
      lexical.retrieval={...lexical.retrieval,mode,requested_mode:mode,effective_mode:'lexical',degraded:true,fallback:'lexical',degradation_code:code};return lexical;
    }
  }
}

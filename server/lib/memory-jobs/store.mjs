import {randomUUID} from 'node:crypto';
import {digest,fail,integer} from '../model-providers/contracts.mjs';

export class MemoryJobs {
  constructor(store,{clock=()=>Date.now(),leaseMs=60000,concurrency=1,batchSize=20}={}){
    this.store=store;this.db=store.db;this.clock=clock;this.leaseMs=integer(leaseMs,100,600000);this.concurrency=integer(concurrency,1,16);this.batchSize=integer(batchSize,1,128);
    this.db.exec(`CREATE TABLE IF NOT EXISTS memory_jobs (job_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL UNIQUE,job_type TEXT NOT NULL,user_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,group_key TEXT NOT NULL,profile TEXT NOT NULL,metadata_json TEXT NOT NULL,input_hash TEXT NOT NULL,highwater INTEGER NOT NULL,
      state TEXT NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0,run_after INTEGER NOT NULL,lease_owner TEXT,lease_expires INTEGER,fence INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,result_ref TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,total INTEGER NOT NULL,processed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS memory_jobs_due ON memory_jobs(state,run_after,lease_expires);
      CREATE TABLE IF NOT EXISTS memory_job_items (job_id TEXT NOT NULL,ordinal INTEGER NOT NULL,user_id TEXT NOT NULL,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,
        state_hash TEXT NOT NULL,scope_key TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,PRIMARY KEY(job_id,ordinal));
      CREATE TABLE IF NOT EXISTS memory_profile_state (profile TEXT PRIMARY KEY,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_model_budget (profile TEXT NOT NULL,day TEXT NOT NULL,reserved_calls INTEGER NOT NULL,PRIMARY KEY(profile,day));
      CREATE TABLE IF NOT EXISTS memory_owner_model_usage (user_id TEXT NOT NULL,profile TEXT NOT NULL,day TEXT NOT NULL,reserved_calls INTEGER NOT NULL,PRIMARY KEY(user_id,profile,day));`);
  }
  enqueue({type,userId,scope,profile,metadata,items,highwater=0}) {
    if(!['classification','summary'].includes(type) || !items.length || items.some(i=>i.user_id!==userId || i.scope_key!==scope))fail('INVALID_JOB');
    const manifest=items.map(i=>[i.memory_id,i.revision,i.state_hash,i.scope_key]),inputHash=digest(manifest),groupKey=digest([type,userId,scope,metadata.category,metadata.window,metadata.taxonomy?.version]);
    const fingerprint=digest([groupKey,profile,inputHash,metadata]),now=this.clock();
    return this.store.memoryTransaction(()=>{
      const exists=this.db.prepare('SELECT job_id FROM memory_jobs WHERE fingerprint=?').get(fingerprint);if(exists)return exists.job_id;
      const id=randomUUID();this.db.prepare(`INSERT INTO memory_jobs(job_id,fingerprint,job_type,user_id,scope_key,group_key,profile,metadata_json,input_hash,highwater,state,run_after,created_at,updated_at,total)
        VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`).run(id,fingerprint,type,userId,scope,groupKey,profile,JSON.stringify(metadata),inputHash,highwater,now,now,now,items.length);
      const insert=this.db.prepare("INSERT INTO memory_job_items VALUES (?,?,?,?,?,?,?,'pending',NULL)");
      for(const [index,item] of items.entries())insert.run(id,index,item.user_id,item.memory_id,item.revision,item.state_hash,item.scope_key);
      return id;
    });
  }
  claim(worker,{userId=null}={}){
    if(typeof worker!=='string' || !worker || worker.length>128)fail('INVALID_WORKER');
    return this.store.memoryTransaction(()=>{
      const now=this.clock();
      if(this.db.prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE state='leased' AND lease_expires>?").get(now).n>=this.concurrency)return null;
      const job=this.db.prepare(`SELECT j.* FROM memory_jobs j LEFT JOIN memory_profile_state p ON p.profile=j.profile
        WHERE COALESCE(p.state,'ready')='ready' AND (? IS NULL OR j.user_id=?) AND ((j.state IN ('pending','retry_wait') AND j.run_after<=?) OR (j.state='leased' AND j.lease_expires<=?))
        ORDER BY j.run_after,j.job_id LIMIT 1`).get(userId,userId,now,now);
      if(!job)return null;
      this.db.prepare("UPDATE memory_jobs SET state='leased',attempt_count=attempt_count+1,lease_owner=?,lease_expires=?,fence=fence+1,updated_at=? WHERE job_id=?")
        .run(worker,now+this.leaseMs,now,job.job_id);
      return this.get(job.job_id);
    });
  }
  get(id){const job=this.db.prepare('SELECT * FROM memory_jobs WHERE job_id=?').get(id);return job?{...job,metadata:JSON.parse(job.metadata_json)}:null;}
  owns(job){const row=this.get(job.job_id);return row?.state==='leased' && row.fence===job.fence && row.lease_owner===job.lease_owner && row.lease_expires>this.clock()
    && ['user_id','scope_key','profile','input_hash','group_key','job_type'].every(key=>row[key]===job[key]) && JSON.stringify(row.metadata)===JSON.stringify(job.metadata);}
  renew(job){if(!this.owns(job))fail('LEASE_LOST');this.db.prepare('UPDATE memory_jobs SET lease_expires=? WHERE job_id=? AND fence=?').run(this.clock()+this.leaseMs,job.job_id,job.fence);}
  items(job){return this.db.prepare('SELECT * FROM memory_job_items WHERE job_id=? ORDER BY ordinal').all(job.job_id);}
  reserve(job,limit){return this.store.memoryTransaction(()=>{
    if(!this.owns(job))fail('LEASE_LOST');const day=new Date(this.clock()).toISOString().slice(0,10);
    this.db.prepare('INSERT OR IGNORE INTO memory_model_budget VALUES (?,?,0)').run(job.profile,day);
    const current=this.db.prepare('SELECT reserved_calls FROM memory_model_budget WHERE profile=? AND day=?').get(job.profile,day);
    if(current.reserved_calls>=limit)fail('BUDGET_EXHAUSTED');
    this.db.prepare('UPDATE memory_model_budget SET reserved_calls=reserved_calls+1 WHERE profile=? AND day=?').run(job.profile,day);
    // Account attribution is not a new cost allocation policy; the existing global ceiling still applies.
    this.db.prepare(`INSERT INTO memory_owner_model_usage VALUES(?,?,?,1) ON CONFLICT(user_id,profile,day)
      DO UPDATE SET reserved_calls=reserved_calls+1`).run(job.user_id,job.profile,day);
  });}
  saveChunk(job,items,results){return this.store.memoryTransaction(()=>{
    if(!this.owns(job))fail('LEASE_LOST');
    for(const item of items) {
      const saved=this.db.prepare('SELECT * FROM memory_job_items WHERE job_id=? AND ordinal=?').get(job.job_id,item.ordinal);
      if(!saved||item.job_id!==job.job_id||item.user_id!==job.user_id||item.scope_key!==job.scope_key
        ||['user_id','memory_id','revision','state_hash','scope_key'].some(key=>saved[key]!==item[key]))fail('INVALID_JOB_ITEM');
      if(!this.store.derivedMemory.validateItem(item))fail('STALE_INPUT');
    }
    if(results.some(result=>!items.some(item=>item.memory_id===result.memory_id)))fail('INVALID_SOURCE_SET');
    for(const item of items)this.db.prepare("UPDATE memory_job_items SET state='done',result_json=? WHERE job_id=? AND ordinal=?")
      .run(JSON.stringify(results.filter(r=>r.memory_id===item.memory_id)),job.job_id,item.ordinal);
    this.db.prepare("UPDATE memory_jobs SET processed=(SELECT COUNT(*) FROM memory_job_items WHERE job_id=? AND state='done'),updated_at=? WHERE job_id=?")
      .run(job.job_id,this.clock(),job.job_id);
  });}
  publish(job,callback){return this.store.memoryTransaction(()=>{
    if(!this.owns(job))fail('LEASE_LOST');const items=this.items(job);
    if(items.some(i=>i.user_id!==job.user_id || i.scope_key!==job.scope_key || i.state!=='done' || !this.store.derivedMemory.validateItem(i)))fail('STALE_INPUT');
    const ref=callback(items,items.flatMap(i=>JSON.parse(i.result_json)));
    this.db.prepare("UPDATE memory_jobs SET state='succeeded',result_ref=?,lease_owner=NULL,lease_expires=NULL,last_error_code=NULL,updated_at=? WHERE job_id=?")
      .run(ref || null,this.clock(),job.job_id);return ref;
  });}
  failure(job,error,retry){
    if(!this.owns(job))return;
    const code=error?.code || 'WORKER_ERROR',safe=['AUTH_FAILED','AUTH_NOT_CONFIGURED','BUDGET_EXHAUSTED','STALE_INPUT','INVALID_MODEL_OUTPUT','INVALID_SOURCE_SET',
      'INPUT_TOO_LARGE','OUTPUT_TOO_LARGE','INVALID_JSON','INVALID_EMBEDDING','INCOMPLETE_OUTPUT','NOT_CONFIGURED','EGRESS_DENIED','SENSITIVITY_DENIED','RATE_LIMITED','REMOTE_UNAVAILABLE','REQUEST_TIMEOUT','NETWORK_ERROR','DNS_UNAVAILABLE','HTTP_REJECTED'];
    let state=code==='AUTH_FAILED'?'blocked_auth':code==='BUDGET_EXHAUSTED'?'blocked_budget':code==='STALE_INPUT'?'stale':
      ['INVALID_MODEL_OUTPUT','INVALID_SOURCE_SET','INPUT_TOO_LARGE','OUTPUT_TOO_LARGE','INVALID_JSON','INCOMPLETE_OUTPUT'].includes(code)?'review_required':
      ['NOT_CONFIGURED','EGRESS_DENIED','SENSITIVITY_DENIED','AUTH_NOT_CONFIGURED','HTTP_REJECTED'].includes(code)?'blocked_config':job.attempt_count>=retry.max_attempts?'dead_letter':'retry_wait';
    const wait=Math.max(Math.min(retry.max_ms,retry.base_ms*2**Math.min(job.attempt_count-1,16)),Math.min(3600000,error?.retryAfterMs || 0));
    this.store.memoryTransaction(()=>{
      if(state==='blocked_auth')this.db.prepare('INSERT OR REPLACE INTO memory_profile_state VALUES (?,?)').run(job.profile,'blocked_auth');
      this.db.prepare('UPDATE memory_jobs SET state=?,run_after=?,last_error_code=?,lease_owner=NULL,lease_expires=NULL,updated_at=? WHERE job_id=? AND fence=?')
        .run(state,this.clock()+wait,safe.includes(code)?code:'WORKER_ERROR',this.clock(),job.job_id,job.fence);
    });
  }
  resumeProfile(profile){this.store.memoryTransaction(()=>{
    this.db.prepare('INSERT OR REPLACE INTO memory_profile_state VALUES (?,?)').run(profile,'ready');
    this.db.prepare("UPDATE memory_jobs SET state='pending',run_after=?,last_error_code=NULL WHERE profile=? AND state IN ('blocked_config','blocked_auth','blocked_budget')").run(this.clock(),profile);
  });}
  cancel(id){this.db.prepare("UPDATE memory_jobs SET state='cancelled',fence=fence+1,lease_owner=NULL,lease_expires=NULL WHERE job_id=? AND state NOT IN ('succeeded','cancelled')").run(id);}
  status(){return {states:this.db.prepare('SELECT state,COUNT(*) AS count,SUM(total-processed) AS remaining FROM memory_jobs GROUP BY state').all(),
    oldest_pending_age_ms:Math.max(0,this.clock()-(this.db.prepare("SELECT MIN(created_at) AS n FROM memory_jobs WHERE state IN ('pending','retry_wait','leased')").get().n ?? this.clock()))};}
}

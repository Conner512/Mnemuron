import {fail} from '../model-providers/contracts.mjs';
import {ConflictError,ValidationError} from '../errors.mjs';
import {object,number} from './state.mjs';

// Owner-set call-count limits per model kind. null is an explicit "no limit"; 0 is a cap that allows no call.
export const QUOTA_RANGES=Object.freeze({daily_limit:1000000,total_limit:1000000000});
const KINDS=['organizer','embedder'];
const today=()=>new Date().toISOString().slice(0,10);

/** Without a saved setting a kind keeps its legacy caps (the model's daily_requests and the first-run total).
 * Once saved, the manual limits replace them for enforcement. Every reserved call is counted in both modes,
 * limited or not, and no setting change resets a counter. */
export class ConsoleQuotas {
  constructor(store,models){this.store=store;this.db=store.db;this.models=models;
    this.db.exec(`CREATE TABLE IF NOT EXISTS console_model_quotas(user_id TEXT NOT NULL,kind TEXT NOT NULL,
        daily_limit INTEGER CHECK(daily_limit IS NULL OR daily_limit BETWEEN 0 AND ${QUOTA_RANGES.daily_limit}),
        total_limit INTEGER CHECK(total_limit IS NULL OR total_limit BETWEEN 0 AND ${QUOTA_RANGES.total_limit}),
        revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(user_id,kind));
      CREATE TABLE IF NOT EXISTS console_model_usage(user_id TEXT NOT NULL,kind TEXT NOT NULL,total_used INTEGER NOT NULL,counting_since INTEGER NOT NULL,PRIMARY KEY(user_id,kind));
      CREATE TABLE IF NOT EXISTS console_model_usage_daily(user_id TEXT NOT NULL,kind TEXT NOT NULL,day TEXT NOT NULL,used INTEGER NOT NULL,PRIMARY KEY(user_id,kind,day));`);}
  kind(kind){if(!KINDS.includes(kind))throw new ValidationError('Unknown model kind.','INVALID_CONSOLE_INPUT');return kind;}
  setting(user,kind){return this.db.prepare('SELECT daily_limit,total_limit,revision,updated_at FROM console_model_quotas WHERE user_id=? AND kind=?').get(user,kind)||null;}
  table(name){return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
  /** Profile fingerprints this account has used for the kind: the current configuration and, for the
   * embedder, every retained generation profile. */
  fingerprints(user,kind){const out=new Set(),row=this.models.raw(user,kind),config=row&&JSON.parse(row.config_json);
    if(config?.model)try{out.add(this.models.profile(user,kind,config).fingerprint);}catch{/* an unusable stored config has no profile */}
    if(kind==='embedder'&&this.table('console_vector_profiles'))for(const s of this.db.prepare('SELECT DISTINCT fingerprint FROM console_vector_profiles WHERE user_id=?').all(user))out.add(s.fingerprint);
    return [...out];}
  /** Starting values when the counters are first created: the first-run budget already spent (embedder) and
   * calls already recorded today under this account's profiles, so introducing the counters resets nothing. */
  seed(user,kind,day){
    const total=kind==='embedder'?this.db.prepare('SELECT used FROM console_vector_budget WHERE user_id=?').get(user)?.used||0:0;
    let daily=0;const sum=(table,column)=>{if(!this.table(table))return;
      for(const profile of this.fingerprints(user,kind))daily+=this.db.prepare(`SELECT ${column} n FROM ${table} WHERE user_id=? AND profile=? AND day=?`).get(user,profile,day)?.n||0;};
    sum('memory_owner_model_usage','reserved_calls');if(kind==='embedder')sum('memory_owner_vector_usage','count');
    return {total,daily};
  }
  usage(user,kind,day=today()){
    const total=this.db.prepare('SELECT total_used,counting_since FROM console_model_usage WHERE user_id=? AND kind=?').get(user,kind);
    const daily=this.db.prepare('SELECT used FROM console_model_usage_daily WHERE user_id=? AND kind=? AND day=?').get(user,kind,day);
    const seed=!total||!daily?this.seed(user,kind,day):null;
    return {total:total?total.total_used:seed.total,today:daily?daily.used:seed.daily,counting_since:total?.counting_since??null,day};
  }
  /** Checks and counts one model call inside the caller's reservation transaction (BEGIN IMMEDIATE), before the
   * caller's legacy counters move. daily=false is a first-run build call: outside the daily allowance, never the total.
   * Returns {manual}: true when the owner's limits were enforced here and replace the legacy caps. */
  reserve(user,kind,{daily=true,day=today()}={}){return this.store.memoryTransaction(()=>{
    const s=this.setting(user,kind),used=this.usage(user,kind,day);
    if(s&&s.total_limit!==null&&used.total>=s.total_limit)fail('BUDGET_EXHAUSTED');
    if(s&&daily&&s.daily_limit!==null&&used.today>=s.daily_limit)fail('BUDGET_EXHAUSTED');
    this.db.prepare('INSERT INTO console_model_usage VALUES(?,?,?,?) ON CONFLICT(user_id,kind) DO UPDATE SET total_used=total_used+1').run(user,kind,used.total+1,Date.now());
    this.db.prepare('INSERT INTO console_model_usage_daily VALUES(?,?,?,?) ON CONFLICT(user_id,kind,day) DO UPDATE SET used=used+?')
      .run(user,kind,day,used.today+(daily?1:0),daily?1:0);
    return {manual:!!s};
  });}
  save(auth,p){
    object(p,['kind','expected_revision','daily_limit','total_limit']);const kind=this.kind(p.kind),user=auth.user_id;
    for(const key of ['daily_limit','total_limit']){
      // A missing key is malformed, never read as "no limit": unlimited must be chosen explicitly as null.
      if(!Object.hasOwn(p,key))throw new ValidationError(`${key} is required; use null for no limit.`,'QUOTA_INVALID');
      if(p[key]!==null&&(!Number.isSafeInteger(p[key])||p[key]<0||p[key]>QUOTA_RANGES[key]))
        throw new ValidationError(`${key} must be null (no limit) or a whole number from 0 to ${QUOTA_RANGES[key]}.`,'QUOTA_INVALID');
    }
    return this.store.memoryTransaction(()=>{
      const before=this.setting(user,kind),revision=before?.revision||0;
      if(number(p.expected_revision,0,2147483647)!==revision)throw new ConflictError('Call limits changed.','QUOTA_VERSION_CHANGED');
      this.db.prepare(`INSERT INTO console_model_quotas VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,kind) DO UPDATE SET
        daily_limit=excluded.daily_limit,total_limit=excluded.total_limit,revision=excluded.revision,updated_at=excluded.updated_at`).run(user,kind,p.daily_limit,p.total_limit,revision+1,Date.now());
      // Only the setting changes: counters, model configuration, jobs, index and activation are left as they are.
      this.store.audit({auth,action:'console.models.quota.change',targetType:'console_model_quota',targetId:kind,
        metadata:{previous:before?{daily_limit:before.daily_limit,total_limit:before.total_limit}:'legacy',daily_limit:p.daily_limit,total_limit:p.total_limit}});
      return {status:'saved',kind,quota:this.view(user,kind)};
    });
  }
  /** Truthful limits and usage for one kind. remaining:null means no limit applies. */
  view(user,kind){
    const s=this.setting(user,kind),used=this.usage(user,kind),left=(limit,n)=>limit===null?null:Math.max(0,limit-n);
    if(s){const daily={limit:s.daily_limit,used:used.today,remaining:left(s.daily_limit,used.today)},total={limit:s.total_limit,used:used.total,remaining:left(s.total_limit,used.total)};
      return {kind,mode:'manual',revision:s.revision,updated_at:s.updated_at,daily,total,counting_since:used.counting_since,day:used.day,
        exhausted:[...(daily.remaining===0?['DAILY_BUDGET_EXHAUSTED']:[]),...(total.remaining===0?['TOTAL_BUDGET_EXHAUSTED']:[])]};}
    // Legacy: what is enforced today without a manual setting.
    const config=JSON.parse(this.models.raw(user,kind)?.config_json||'null');
    let fp=null;if(config?.model)try{fp=this.models.profile(user,kind,config).fingerprint;}catch{/* no usable profile */}
    const legacyUsed=fp?(this.table('memory_model_budget')?this.db.prepare('SELECT reserved_calls n FROM memory_model_budget WHERE profile=? AND day=?').get(fp,used.day)?.n||0:0)
      +(kind==='embedder'&&this.table('memory_vector_calls')?this.db.prepare('SELECT count n FROM memory_vector_calls WHERE profile=? AND day=?').get(fp,used.day)?.n||0:0):0;
    const limit=config?.daily_requests??null,budget=kind==='embedder'?this.models.budget(user):null;
    const daily={limit,used:legacyUsed,remaining:left(limit,legacyUsed)},total=budget?{limit:budget.total,used:budget.used,remaining:Math.max(0,budget.remaining)}:{limit:null,used:used.total,remaining:null};
    return {kind,mode:'legacy',revision:0,updated_at:null,daily,total,counting_since:used.counting_since,day:used.day,
      exhausted:[...(fp&&daily.remaining===0?['DAILY_BUDGET_EXHAUSTED']:[]),...(budget&&total.remaining===0?['FIRST_RUN_BUDGET_EXHAUSTED']:[])]};
  }
}

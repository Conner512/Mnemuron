import {ValidationError} from '../errors.mjs';
import {fail} from './contracts.mjs';

// Observation is not a billing receipt. These fields deliberately exclude request/response bodies, URLs,
// keys and supplier error messages. Unknown token counts are NULL, including interrupted/lost responses.
export const USAGE_PURPOSES=Object.freeze(['classification','summary','traits','entities','organizer','document_embedding','query_embedding','probe']);
const KINDS=['organizer','embedder'];
const ERROR_CODES=new Set(['INCOMPLETE_OUTPUT','INVALID_JSON','INVALID_MODEL_OUTPUT','OUTPUT_TOO_LARGE','INVALID_EMBEDDING_ORDER',
  'INVALID_EMBEDDING_COUNT','INVALID_EMBEDDING','REQUEST_TIMEOUT','NETWORK_ERROR','REMOTE_UNAVAILABLE','RATE_LIMITED',
  'AUTH_FAILED','EGRESS_DENIED','DNS_UNAVAILABLE','ADDRESS_DENIED','STALE_INPUT','LEASE_LOST','FEATURE_DISABLED',
  'EXECUTION_GRANT_REQUIRED','NOT_CONFIGURED','RESPONSE_TOO_LARGE','INVALID_RESPONSE','REDIRECT_DENIED']);
const token=n=>Number.isSafeInteger(n)&&n>=0?n:null;
const sum=n=>Number.isSafeInteger(n)&&n>=0?n:null;
const label=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
export const usageErrorCode=error=>ERROR_CODES.has(error?.code)?error.code:'REQUEST_FAILED';
export const usagePurpose=value=>USAGE_PURPOSES.includes(value)?value:'organizer';

/** A provider can omit usage or return malformed counters. Never coerce numeric strings, negatives, fractions,
 * Infinity or unsafe integers. Invalid cached usage cannot be used to reduce the reported input tokens. */
export function normalizeUsage(value,kind='organizer') {
  const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  const out={input_tokens:token(source.input_tokens),output_tokens:kind==='embedder'?null:token(source.output_tokens),cached_input_tokens:token(source.cached_input_tokens)};
  let invalid=Math.max(source.status==='invalid'&&Number.isSafeInteger(source.invalid_fields)&&source.invalid_fields>0&&source.invalid_fields<=3?source.invalid_fields:0,
    ['input_tokens',...(kind==='organizer'?['output_tokens']:[]),'cached_input_tokens'].filter(k=>source[k]!==undefined&&source[k]!==null&&token(source[k])===null).length);
  if(out.cached_input_tokens!==null&&out.input_tokens!==null&&out.cached_input_tokens>out.input_tokens){out.cached_input_tokens=null;invalid++;}
  const known=out.input_tokens!==null&&(kind==='embedder'||out.output_tokens!==null);
  return {...out,status:invalid?'invalid':known?'reported':out.input_tokens!==null||out.output_tokens!==null?'partial':'unknown',invalid_fields:invalid};
}

/** Optional owner-supplied list prices, per million tokens. No online lookup or retroactive repricing. */
export function validateUsagePricing(value,kind='organizer') {
  if(value===undefined||value===null)return null;
  const keys=['currency','version','input_per_million','output_per_million','cached_input_per_million'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k))||
    typeof value.currency!=='string'||!/^[A-Z]{3}$/.test(value.currency)||!label(value.version,80)||value.version!==value.version.trim())
    throw new ValidationError('Use a currency code, a price version, and nonnegative per-million prices.','MODEL_PRICING_INVALID');
  const required=['input_per_million',...(kind==='organizer'?['output_per_million']:[])];
  for(const key of ['input_per_million','output_per_million','cached_input_per_million'])if(required.includes(key)||value[key]!==undefined)
    if(typeof value[key]!=='number'||!Number.isFinite(value[key])||value[key]<0||value[key]>1e9)throw new ValidationError('Invalid per-million price.','MODEL_PRICING_INVALID');
  return Object.fromEntries(keys.filter(k=>value[k]!==undefined).map(k=>[k,value[k]]));
}

function estimate(row,usage) {
  if(!row.pricing_json)return {estimated_amount:null,estimate_status:'unpriced'};
  const price=JSON.parse(row.pricing_json);
  if(usage.input_tokens===null||row.kind==='organizer'&&usage.output_tokens===null||price.cached_input_per_million!==undefined&&usage.cached_input_tokens===null)
    return {estimated_amount:null,estimate_status:'unknown_usage'};
  const cached=price.cached_input_per_million===undefined?0:usage.cached_input_tokens;
  const amount=((usage.input_tokens-cached)*price.input_per_million+cached*(price.cached_input_per_million??0)+(row.kind==='organizer'?usage.output_tokens*price.output_per_million:0))/1e6;
  if(!Number.isFinite(amount)||amount>Number.MAX_SAFE_INTEGER)return {estimated_amount:null,estimate_status:'out_of_range'};
  return {estimated_amount:Math.round(amount*1e10)/1e10,estimate_status:'estimated'};
}

/** Non-material, account-owned operational telemetry. It neither changes memory state nor advances lifecycle
 * epochs. Retrying an observation with the same UUID is idempotent; retrying an actual request gets a new UUID. */
export class ModelUsageLedger {
  constructor(db){this.db=db;db.exec(`CREATE TABLE IF NOT EXISTS memory_model_attempts(
    attempt_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('organizer','embedder')),
    profile_fingerprint TEXT NOT NULL,model TEXT NOT NULL,purpose TEXT NOT NULL,synthetic INTEGER NOT NULL CHECK(synthetic IN (0,1)),
    started_at INTEGER NOT NULL,finished_at INTEGER,duration_ms INTEGER,outcome TEXT NOT NULL CHECK(outcome IN ('pending','succeeded','failed')),
    error_code TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_input_tokens INTEGER,usage_status TEXT NOT NULL,
    pricing_json TEXT,estimated_amount REAL,estimate_status TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS memory_model_attempts_owner_time ON memory_model_attempts(user_id,started_at DESC,attempt_id);
  `);}
  observer(context){
    const {user_id,kind,profile_fingerprint,model,synthetic=false}=context;
    if(!label(user_id,256)||!KINDS.includes(kind)||!label(profile_fingerprint,256)||!label(model,200))fail('USAGE_CONTEXT_INVALID');
    const pricing=validateUsagePricing(context.pricing,kind),pricingJson=pricing?JSON.stringify(pricing):null;
    return event=>{
      if(!event||!['started','finished'].includes(event.phase)||typeof event.attempt_id!=='string'||!/^[0-9a-f-]{36}$/i.test(event.attempt_id)||token(event.started_at)===null)fail('USAGE_OBSERVATION_INVALID');
      if(event.phase==='started'){
        this.db.prepare(`INSERT OR IGNORE INTO memory_model_attempts(attempt_id,user_id,kind,profile_fingerprint,model,purpose,synthetic,started_at,outcome,usage_status,pricing_json,estimate_status)
          VALUES(?,?,?,?,?,?,?,?,'pending','unknown',?,'pending')`).run(event.attempt_id,user_id,kind,profile_fingerprint,model,usagePurpose(synthetic?'probe':event.purpose),synthetic?1:0,event.started_at,pricingJson);
        const row=this.db.prepare('SELECT user_id,kind,profile_fingerprint,started_at FROM memory_model_attempts WHERE attempt_id=?').get(event.attempt_id);
        if(!row||row.user_id!==user_id||row.kind!==kind||row.profile_fingerprint!==profile_fingerprint||row.started_at!==event.started_at)fail('USAGE_OBSERVATION_CONFLICT');
        return;
      }
      const row=this.db.prepare('SELECT * FROM memory_model_attempts WHERE attempt_id=? AND user_id=?').get(event.attempt_id,user_id);
      if(!row||row.started_at!==event.started_at||row.kind!==kind||row.profile_fingerprint!==profile_fingerprint)fail('USAGE_OBSERVATION_CONFLICT');
      // Completed observations are immutable even if a duplicate delivery supplies different usage or prices.
      if(row.finished_at!==null)return;
      if(token(event.finished_at)===null||event.finished_at<event.started_at||token(event.duration_ms)===null||!['succeeded','failed'].includes(event.outcome))fail('USAGE_OBSERVATION_INVALID');
      const usage=normalizeUsage(event.usage,kind),cost=estimate(row,usage);
      this.db.prepare(`UPDATE memory_model_attempts SET finished_at=?,duration_ms=?,outcome=?,error_code=?,input_tokens=?,output_tokens=?,cached_input_tokens=?,usage_status=?,estimated_amount=?,estimate_status=?
        WHERE attempt_id=? AND user_id=? AND finished_at IS NULL`).run(event.finished_at,event.duration_ms,event.outcome,event.outcome==='failed'?usageErrorCode({code:event.error_code}):null,
          usage.input_tokens,usage.output_tokens,usage.cached_input_tokens,usage.status,cost.estimated_amount,cost.estimate_status,event.attempt_id,user_id);
    };
  }
  /** UTC window, a bounded detailed list, and exact counts of which observations remain unknown. This query has
   * no provider, pricing-discovery or maintenance side effects. An unfinished request is not claimed to have failed. */
  report(user,{days=14,now=Date.now()}={}) {
    if(!Number.isSafeInteger(days)||days<1||days>90)throw new ValidationError('Usage days must be 1–90.','INVALID_CONSOLE_INPUT');
    const today=new Date(now).toISOString().slice(0,10),since=Date.parse(today)-(days-1)*86400000,until=now;
    const select=`COUNT(*) attempts,SUM(outcome='succeeded') succeeded,SUM(outcome='failed') failed,SUM(outcome='pending') pending,
      SUM(usage_status IN ('unknown','partial','invalid')) unknown_usage,SUM(usage_status='invalid') invalid_usage,
      TOTAL(input_tokens) input_known,SUM(input_tokens IS NULL) input_unknown,TOTAL(output_tokens) output_known,SUM(kind='organizer') output_attempts,SUM(output_tokens IS NULL AND kind='organizer') output_unknown,
      TOTAL(cached_input_tokens) cached_known,SUM(cached_input_tokens IS NULL) cached_unknown,
      AVG(duration_ms) latency_mean_ms,MAX(duration_ms) latency_max_ms,SUM(duration_ms IS NULL) latency_unknown,
      SUM(estimate_status='estimated') estimated_attempts,SUM(estimate_status<>'estimated') unestimated_attempts`;
    const where='user_id=? AND started_at>=? AND started_at<=?',args=[user,since,until];
    const shape=row=>{const {input_known,output_known,cached_known,...rest}=row;
      for(const key of ['succeeded','failed','pending','unknown_usage','invalid_usage','input_unknown','output_attempts','output_unknown','cached_unknown','latency_unknown','estimated_attempts','unestimated_attempts'])rest[key]??=0;
      return {...rest,input_tokens:rest.input_unknown===row.attempts?null:sum(input_known),output_tokens:!rest.output_attempts||rest.output_unknown===rest.output_attempts?null:sum(output_known),
        cached_input_tokens:rest.cached_unknown===row.attempts?null:sum(cached_known)};};
    const totals=shape(this.db.prepare(`SELECT ${select} FROM memory_model_attempts WHERE ${where}`).get(...args));
    const grouped=this.db.prepare(`SELECT kind,profile_fingerprint,model,purpose,strftime('%Y-%m-%d',started_at/1000,'unixepoch') day,${select}
      FROM memory_model_attempts WHERE ${where} GROUP BY kind,profile_fingerprint,model,purpose,day ORDER BY day DESC,model,purpose LIMIT 201`).all(...args);
    const prices=this.db.prepare(`SELECT json_extract(pricing_json,'$.currency') currency,COUNT(*) attempts,TOTAL(estimated_amount) amount
      FROM memory_model_attempts WHERE ${where} AND estimate_status='estimated' GROUP BY currency ORDER BY currency`).all(...args).map(r=>({...r,amount:Number.isFinite(r.amount)&&r.amount<=Number.MAX_SAFE_INTEGER?r.amount:null}));
    const recent=this.db.prepare(`SELECT attempt_id,kind,profile_fingerprint,model,purpose,synthetic,started_at,finished_at,duration_ms,outcome,error_code,
      input_tokens,output_tokens,cached_input_tokens,usage_status,pricing_json,estimated_amount,estimate_status FROM memory_model_attempts WHERE ${where} ORDER BY started_at DESC,attempt_id DESC LIMIT 50`).all(...args)
      .map(({pricing_json,...r})=>({...r,pricing:pricing_json?JSON.parse(pricing_json):null,synthetic:!!r.synthetic}));
    return {scope:'console_owner_providers',standalone_provider_usage:'unobserved',unit:'observed_attempts',billing_verified:false,days,since,until,timezone:'UTC',
      totals,groups:grouped.slice(0,200).map(shape),groups_truncated:grouped.length>200,estimates:prices,recent,recent_limit:50,
      estimate_basis:'request_time_owner_prices_and_provider_reported_tokens',historical_backfill:false};
  }
}

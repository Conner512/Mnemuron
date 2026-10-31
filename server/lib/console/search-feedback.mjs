import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {object,id,number,fingerprint} from './state.mjs';
import {ValidationError,ConflictError} from '../errors.mjs';

export const SEARCH_FEEDBACK_KINDS=Object.freeze(['relevant','irrelevant','outdated','missing']);
const MODES=['lexical','hybrid','semantic'],TTL=30*60*1000;
const invalid=()=>{throw new ValidationError('Invalid search feedback.','INVALID_CONSOLE_INPUT');};
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const mac=(key,value)=>createHmac('sha256',key).update(value).digest('hex');

/** Explicit human feedback, not training data or permission to send a query to another model. */
export class ConsoleSearchFeedback{
 constructor(service){this.service=service;this.db=service.db;this.store=service.store;
  this.db.exec(`CREATE TABLE IF NOT EXISTS console_search_feedback_keys(user_id TEXT PRIMARY KEY,salt TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS console_search_feedback(user_id TEXT NOT NULL,feedback_key TEXT NOT NULL,
    query_fingerprint TEXT NOT NULL,filter_fingerprint TEXT NOT NULL,search_fingerprint TEXT NOT NULL,
    memory_id TEXT,revision INTEGER,feedback TEXT NOT NULL,requested_mode TEXT NOT NULL,effective_mode TEXT NOT NULL,
    profile_fingerprint TEXT,rank INTEGER,result_count INTEGER NOT NULL,truncated INTEGER NOT NULL,degraded INTEGER NOT NULL,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,feedback_key));
   CREATE INDEX IF NOT EXISTS console_search_feedback_query ON console_search_feedback(user_id,query_fingerprint,filter_fingerprint,updated_at);`);
 }
 key(user,{create=false}={}){let row=this.db.prepare('SELECT salt FROM console_search_feedback_keys WHERE user_id=?').get(user);
  if(!row&&create){this.db.prepare('INSERT OR IGNORE INTO console_search_feedback_keys VALUES (?,?)').run(user,randomBytes(32).toString('hex'));row=this.db.prepare('SELECT salt FROM console_search_feedback_keys WHERE user_id=?').get(user);}
  return row?.salt||null;
 }
 /** The original query is transient input to a per-owner HMAC; neither rows nor tokens contain it. */
 context(auth,filter,response,now=Date.now()){
  if(!filter.query)return response;
  const key=this.key(auth.user_id,{create:true}),query_fingerprint=mac(key,String(filter.query).normalize('NFKC').replace(/\s+/gu,' ').trim()),
   {query,...filters}=filter,filter_fingerprint=mac(key,fingerprint(filters));
  const retrieval=response.retrieval||{},requested=MODES.includes(retrieval.requested_mode)?retrieval.requested_mode:'lexical',effective=MODES.includes(retrieval.effective_mode)?retrieval.effective_mode:'lexical';
  const profile=typeof retrieval.profile==='string'?fingerprint(retrieval.profile):null;
  const live=this.store.lifecycle.live(auth.user_id).sql('m.project_id');
  const revisions=this.db.prepare(`SELECT m.memory_id,MAX(r.revision) revision FROM memories m JOIN memory_revisions r ON r.user_id=m.user_id AND r.memory_id=m.memory_id
    WHERE m.user_id=? AND ${live.sql} AND m.memory_id IN (SELECT value FROM json_each(?)) GROUP BY m.memory_id`)
   .all(auth.user_id,...live.params,JSON.stringify(response.results.map(row=>row.memory_id)));
  const byId=new Map(revisions.map(row=>[row.memory_id,row.revision]));
  // Recheck live ownership, but never relabel an earlier displayed body with a newly current revision. A source
  // changed by another process between the SELECT and signing retains its displayed revision and fails at apply.
  const rows=response.results.filter(row=>byId.has(row.memory_id)&&Number.isSafeInteger(row.revision)&&row.revision>0);
  const payload={v:1,user:auth.user_id,query_fingerprint,filter_fingerprint,requested,effective,profile,
   results:rows.map((row,index)=>({memory_id:row.memory_id,revision:row.revision,rank:(response.offset||0)+index+1})),
   result_count:rows.length,truncated:response.truncated===true,degraded:retrieval.degraded===true,expires_at:now+TTL};
  const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url'),token=`${encoded}.${mac(key,encoded)}`;
  return {...response,results:rows,feedback_context:{token,query_fingerprint,filter_fingerprint,expires_at:payload.expires_at,stores_query_text:false}};
 }
 token(auth,value,now){
  if(typeof value!=='string'||value.length>24000)invalid();
  const [encoded,signature,...extra]=value.split('.'),key=this.key(auth.user_id);
  if(!key||extra.length||!hex(signature)||!encoded||!/^[A-Za-z0-9_-]+$/.test(encoded))invalid();
  const expected=Buffer.from(mac(key,encoded),'hex'),actual=Buffer.from(signature,'hex');if(!timingSafeEqual(actual,expected))invalid();
  let token;try{token=JSON.parse(Buffer.from(encoded,'base64url').toString());}catch{invalid();}
  if(token?.v!==1||token.user!==auth.user_id||!hex(token.query_fingerprint)||!hex(token.filter_fingerprint)||!MODES.includes(token.requested)||!MODES.includes(token.effective)||!Array.isArray(token.results)||token.results.length>50)invalid();
  if(!Number.isSafeInteger(token.expires_at)||token.expires_at<=now)throw new ConflictError('Search feedback expired; repeat the search.','SEARCH_FEEDBACK_EXPIRED');
  return token;
 }
 apply(auth,p,now=Date.now()){
  object(p,['search_token','memory_id','revision','feedback']);if(!SEARCH_FEEDBACK_KINDS.includes(p.feedback))invalid();
  const token=this.token(auth,p.search_token,now),memory=p.memory_id===undefined||p.memory_id===null?null:id(p.memory_id);
  if(!memory&&p.feedback!=='missing'||!memory&&p.revision!==undefined&&p.revision!==null)invalid();
  let revision=null,rank=null;
  if(memory){revision=number(p.revision,1,2147483647);this.service.memory(auth,memory,revision);
   const returned=token.results.find(row=>row.memory_id===memory&&row.revision===revision);
   if(p.feedback==='missing'?!!returned:!returned)throw new ConflictError('Feedback does not match the displayed result set.','SEARCH_FEEDBACK_RESULT_MISMATCH');
   rank=returned?.rank||null;
  }
  const search=fingerprint([token.query_fingerprint,token.filter_fingerprint,token.requested,token.effective,token.profile]),
   feedback_key=fingerprint([search,memory,revision]),at=new Date(now).toISOString();
  this.db.prepare(`INSERT INTO console_search_feedback VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
   ON CONFLICT(user_id,feedback_key) DO UPDATE SET feedback=excluded.feedback,rank=excluded.rank,result_count=excluded.result_count,
    truncated=excluded.truncated,degraded=excluded.degraded,updated_at=excluded.updated_at`)
   .run(auth.user_id,feedback_key,token.query_fingerprint,token.filter_fingerprint,search,memory,revision,p.feedback,token.requested,token.effective,token.profile,rank,token.result_count,token.truncated?1:0,token.degraded?1:0,at,at);
  return {status:'saved',feedback_key,feedback:p.feedback,...(memory?{memory_id:memory,revision}:{}),stores_query_text:false,ranking_changed:false};
 }
 read(auth,p){
  object(p,['query_fingerprint','filter_fingerprint','offset','limit']);
  for(const key of ['query_fingerprint','filter_fingerprint'])if(p[key]!==undefined&&!hex(p[key]))invalid();
  const offset=Number(p.offset??0),limit=Number(p.limit??20);number(offset,0,1000000);number(limit,1,50);
  const live=this.store.lifecycle.live(auth.user_id).sql('m.project_id');
  const from=`FROM console_search_feedback f LEFT JOIN memories m ON m.user_id=f.user_id AND m.memory_id=f.memory_id`,
   where=`f.user_id=? AND (f.memory_id IS NULL OR (m.memory_id IS NOT NULL AND ${live.sql}))
    AND (? IS NULL OR f.query_fingerprint=?) AND (? IS NULL OR f.filter_fingerprint=?)`,
   args=[auth.user_id,...live.params,p.query_fingerprint||null,p.query_fingerprint||null,p.filter_fingerprint||null,p.filter_fingerprint||null];
  const total=this.db.prepare(`SELECT count(*) n ${from} WHERE ${where}`).get(...args).n;
  const rows=this.db.prepare(`SELECT f.feedback_key,f.query_fingerprint,f.filter_fingerprint,f.memory_id,f.revision,f.feedback,
    f.requested_mode,f.effective_mode,f.profile_fingerprint,f.rank,f.result_count,f.truncated,f.degraded,f.created_at,f.updated_at,
    CASE WHEN f.memory_id IS NULL THEN NULL ELSE f.revision=(SELECT MAX(revision) FROM memory_revisions r WHERE r.user_id=f.user_id AND r.memory_id=f.memory_id) END revision_current
    ${from} WHERE ${where} ORDER BY f.updated_at DESC,f.feedback_key LIMIT ? OFFSET ?`).all(...args,limit+1,offset);
  const groups=this.db.prepare(`SELECT f.requested_mode,f.effective_mode,f.feedback,count(*) count ${from} WHERE ${where}
    GROUP BY f.requested_mode,f.effective_mode,f.feedback ORDER BY f.requested_mode,f.effective_mode,f.feedback`).all(...args);
  return {read_only:true,items:rows.slice(0,limit),total,offset,limit,next_offset:rows.length>limit?offset+limit:null,groups,
   stores_query_text:false,ranking_changed:false,metric_basis:'explicit_human_feedback_not_benchmark_accuracy',
   evaluation:{command:'node server/bin/mnemuron-search-workbench-quality.mjs --output /private/evidence',network_required:false,synthetic_only:true}};
 }
}

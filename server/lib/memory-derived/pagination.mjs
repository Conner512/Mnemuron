import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {digest} from '../model-providers/contracts.mjs';
import {ConflictError,ValidationError} from '../errors.mjs';
import {isWebReader,webMemorySql} from '../memory/web-visibility.mjs';

const bytes=value=>Buffer.byteLength(JSON.stringify(value));
export class SummaryPagination {
  constructor(derived) {this.derived=derived;this.db=derived.db;this.key=randomBytes(32);this.clock=()=>Date.now();}
  sign(state) {
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
    const body=Buffer.concat([cipher.update(JSON.stringify(state)),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64url');
  }
  decode(cursor,binding) {
    if(typeof cursor!=='string' || cursor.length>2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))throw new ValidationError('Invalid summary cursor.','INVALID_CURSOR');
    let state;try {
      const raw=Buffer.from(cursor,'base64url');if(raw.length<29 || raw.toString('base64url')!==cursor)throw new Error('Invalid encoding');
      const decipher=createDecipheriv('aes-256-gcm',this.key,raw.subarray(0,12));decipher.setAuthTag(raw.subarray(12,28));
      state=JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString());
    }catch{throw new ValidationError('Invalid summary cursor.','INVALID_CURSOR');}
    if(state.binding!==binding)throw new ValidationError('Cursor does not match this read.','INVALID_CURSOR');
    if(state.expires<=this.clock())throw new ConflictError('Summary cursor expired; restart reading.','CURSOR_EXPIRED');
    return state;
  }
  page(user,scope,{limit=20,offset=0,cursor,category,auth={user_id:user},budget=128*1024}={}) {
    if(!Number.isSafeInteger(limit) || limit<1 || limit>50 || !Number.isSafeInteger(offset) || offset<0
      || (category!==undefined && (typeof category!=='string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(category))))throw new ValidationError('Invalid summary pagination or category.');
    if(cursor && offset)throw new ValidationError('Use cursor without offset.');
    const binding=digest([user,scope,limit,category || null,auth.credential_id || null,isWebReader(auth)]);
    const eligible=isWebReader(auth)?`status='current' AND EXISTS (SELECT 1 FROM memory_summary_dependencies d WHERE d.summary_id=memory_summaries.summary_id)
      AND NOT EXISTS (SELECT 1 FROM memory_summary_dependencies d LEFT JOIN memories m ON m.user_id=d.user_id AND m.memory_id=d.memory_id
        WHERE d.summary_id=memory_summaries.summary_id AND (m.memory_id IS NULL OR NOT (${webMemorySql(auth)})))`:"status='current'";
    const high=this.db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM memory_summaries').get().n;
    let state=cursor?this.decode(cursor,binding):{binding,high,before:high+1,claim:0,text:0,consumed:offset,expires:this.clock()+15*60000};
    if(!cursor && offset) {
      const row=this.db.prepare("SELECT rowid n FROM memory_summaries WHERE user_id=? AND scope_key=? AND status='current' AND (? IS NULL OR category=?) ORDER BY rowid DESC LIMIT 1 OFFSET ?").get(user,scope,category ?? null,category ?? null,offset);
      state.before=row?row.n+1:0;
    }
    const result={read_only:true,results:[],next_cursor:null,next_offset:null,production_ready:false};
    const fits=row=>bytes({...result,results:[...result.results,row]})<=budget-2048;
    let scanned=0,more=false;
    while(result.results.length<limit && scanned++<1000) {
      const row=(state.claim || state.text)?this.db.prepare('SELECT rowid AS cursor_id,* FROM memory_summaries WHERE user_id=? AND scope_key=? AND rowid=?').get(user,scope,state.before-1)
        :this.db.prepare(`SELECT rowid AS cursor_id,* FROM memory_summaries WHERE user_id=? AND scope_key=? AND rowid<=? AND rowid<?
        AND (? IS NULL OR category=?) AND ${eligible} ORDER BY rowid DESC LIMIT 1`).get(user,scope,state.high,state.before,category ?? null,category ?? null);
      if(!row && (state.claim || state.text))throw new ConflictError('Summary changed; restart reading.','SUMMARY_VERSION_CHANGED');
      if(!row)break;
      const deps=this.db.prepare('SELECT * FROM memory_summary_dependencies WHERE summary_id=? ORDER BY memory_id').all(row.summary_id);
      const metadata=JSON.parse(this.db.prepare('SELECT metadata_json FROM memory_jobs WHERE job_id=?').get(row.job_id)?.metadata_json || '{}');
      const valid=row.status==='current' && deps.length && deps.every(d=>{
        const source=this.derived.validateItem(d);
        return source && this.derived.store.webVisibility.visible(auth,d.memory_id) && this.derived.category(source,metadata.taxonomy?.version || '')===row.category;
      });
      if(!valid) {
        if(state.claim || state.text)throw new ConflictError('Summary source changed; restart reading.','SUMMARY_VERSION_CHANGED');
        state={...state,before:row.cursor_id,consumed:state.consumed+1};continue;
      }
      const selected=new Set(this.db.prepare("SELECT DISTINCT json_extract(claim_json,'$.memory_id') memory_id FROM memory_summary_claims WHERE summary_id=?").all(row.summary_id).map(r=>r.memory_id));
      const omitted=deps.filter(d=>!selected.has(d.memory_id));
      const header=isWebReader(auth)?{summary_id:row.summary_id,revision:row.revision,category:row.category,created_at:row.created_at,status:row.status}
        :Object.fromEntries(Object.entries(row).filter(([key])=>key!=='cursor_id'));
      const item={...header,kind:'derived_summary',independently_fact_checked:false,claims:[],claim_offset:state.claim,claims_truncated:false,
        dependency_count:deps.length,coverage_status:omitted.length?'partial':'complete',selected_source_count:deps.length-omitted.length,
        omitted_source_count:omitted.length,omitted_sources:omitted.slice(0,100).map(({memory_id,revision})=>({memory_id,revision})),omitted_sources_truncated:omitted.length>100};
      const claims=this.db.prepare('SELECT claim_json FROM memory_summary_claims WHERE summary_id=? ORDER BY ordinal LIMIT 101 OFFSET ?').all(row.summary_id,state.claim);
      let index=state.claim,textOffset=state.text,partial=false;
      for(const raw of claims.slice(0,100)) {
        const claim=JSON.parse(raw.claim_json);
        const points=Array.from(claim.quote || '');
        let part=textOffset?{...claim,quote:points.slice(textOffset).join(''),quote_offset:textOffset,quote_length:points.length,quote_complete:true}:claim;
        if(!fits({...item,claims:[...item.claims,part]})) {
          if(result.results.length || item.claims.length) {partial=true;break;}
          let lo=0,hi=points.length-textOffset;
          while(lo<hi) {
            const n=Math.ceil((lo+hi)/2),fragment={...claim,quote:points.slice(textOffset,textOffset+n).join(''),quote_offset:textOffset,quote_length:points.length,quote_complete:false};
            if(fits({...item,claims:[fragment]}))lo=n;else hi=n-1;
          }
          if(!lo)throw Object.assign(new ValidationError('Summary metadata exceeds the read budget.','SUMMARY_DETAIL_TOO_LARGE'),{statusCode:422});
          part={...claim,quote:points.slice(textOffset,textOffset+lo).join(''),quote_offset:textOffset,quote_length:points.length,quote_complete:false};
          item.claims.push(part);textOffset+=lo;partial=true;break;
        }
        item.claims.push(part);index++;textOffset=0;
      }
      partial ||= claims.length>100;
      item.claims_truncated=partial;item.content_complete=!partial;
      if(item.claims.length || !claims.length)result.results.push(item);
      if(partial) {state={...state,before:row.cursor_id+1,claim:index,text:textOffset};more=true;break;}
      state={...state,before:row.cursor_id,claim:0,text:0,consumed:state.consumed+1};
    }
    more ||= !!this.db.prepare(`SELECT 1 FROM memory_summaries WHERE user_id=? AND scope_key=? AND rowid<? AND rowid<=? AND (? IS NULL OR category=?) AND ${eligible} LIMIT 1`).get(user,scope,state.before,state.high,category ?? null,category ?? null);
    if(more) {result.next_cursor=this.sign(state);result.next_offset=isWebReader(auth) || state.claim || state.text?null:state.consumed;}
    result.complete=!more;result.budget_bytes=budget;
    return result;
  }
}

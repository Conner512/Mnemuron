// Packaged verbatim with the OpenClaw adapter; parity is verified by the contract test.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, openSync, fsyncSync, closeSync, linkSync } from 'node:fs';
import path from 'node:path';

export const RESPONSE_LIMIT = 2 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const states = new Set(['pending','retry_wait','paused_auth','quarantined','blocked_protocol','blocked_reconciliation','blocked_gap']);
export const protocolError = (code, statusCode) => Object.assign(new Error(`Mnemuron transport: ${code}${statusCode ? ` (${statusCode})` : ''}.`), {errorCode:code,statusCode});
export function decodeResponse(status, text, retryAfter=null) {
  let data;
  try { data=JSON.parse(text || '{}'); } catch {}
  const code=typeof data?.error_code==='string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(data.error_code) ? data.error_code : null;
  if(status<200 || status>=300) throw Object.assign(protocolError(code || (status>=300&&status<400?'REDIRECT_BLOCKED':`HTTP_${status}`),status),{responseData:data,retryAfter});
  if (!data || typeof data!=='object' || Array.isArray(data)) throw protocolError('INVALID_RESPONSE_JSON',status);
  return data;
}
export function retryState(error, previous={}, {now=Date.now(), random=Math.random, credential=''}={}) {
  const status=error.statusCode ?? null, code=error.errorCode || error.responseData?.error_code || error.code || 'NETWORK_ERROR';
  const attempt=(previous.attempt_count || 0)+1;
  const result={...previous,attempt_count:attempt,last_error_code:/^[A-Z0-9_]{1,64}$/.test(code)?code:'NETWORK_ERROR',last_http_status:status,
    first_failed_at:previous.first_failed_at || new Date(now).toISOString(),next_retry_at:null,credential_fingerprint:credential};
  if(status===401 || status===403) result.state='paused_auth';
  else if(code==='RECEIPT_MISMATCH' || status===409) result.state='blocked_reconciliation';
  else if(status===413 || ([400,422].includes(status) && ['INVALID_PAYLOAD','CONTENT_TOO_LONG','SCOPE_MISMATCH','INVALID_MEMORY_SCOPE','REQUEST_BODY_TOO_LARGE'].includes(code))) result.state='quarantined';
  else if(code==='RESPONSE_TOO_LARGE' || code==='INVALID_RESPONSE_JSON' || code==='REDIRECT_BLOCKED' || (status && status<500 && status!==429)) result.state='blocked_protocol';
  else {
    result.state='retry_wait';
    let delay=Math.min(300000,1000*2**Math.min(attempt-1,18))*(0.5+random()*0.5);
    if(status===429 && error.retryAfter) {
      const value=String(error.retryAfter).trim();
      const seconds=/^\d+(?:\.\d+)?$/.test(value)?Number(value)*1000:NaN;
      const requested=Number.isFinite(seconds)?now+seconds:Date.parse(value);
      if(Number.isFinite(requested) && requested>now && requested<=8.64e15) delay=Math.max(delay,requested-now);
    }
    result.next_retry_at=new Date(now+delay).toISOString();
  }
  return result;
}
export function validateAcceptance(kind, item, result) {
  const payload=item.payload;
  if(kind==='event') {
    const id=payload?.event?.event_id;
    if(typeof id==='string' && id.length>0 && result?.status==='accepted' && result.received===1
      && [result.inserted,result.duplicate].every(n=>Number.isInteger(n) && n>=0 && n<=1) && result.inserted+result.duplicate===1
      && Array.isArray(result.accepted_event_ids) && result.accepted_event_ids.length===1 && result.accepted_event_ids[0]===id) return;
  } else {
    const receipt=kind==='receipt', delivery=result?.delivery;
    const eventKey=receipt?'receipt_event_id':'event_id', attemptKey=receipt?'receipt_id':'attempt_id';
    const records=receipt?delivery?.receipts:delivery?.attempts;
    const attempt=records?.find(record=>record[attemptKey]===payload?.[attemptKey]);
    const ids=receipt?attempt?.receipt_event_ids:attempt?.event_ids;
    const phaseField=payload?.phase==='acknowledged'?'acknowledged_at':payload?.phase==='failed'?'failed_at':receipt?'delivered_at':'injected_at';
    if(result?.[eventKey]===payload?.[eventKey] && result.inserted+result.duplicate===1
      && delivery?.resume_id===item.resume_id && delivery?.preview_version===payload.preview_version
      && attempt?.session_id===payload.session_id && attempt?.workstream_id===payload.workstream_id
      && (payload.phase==='delivered' || attempt?.turn_id===payload.turn_id)
      && attempt?.[phaseField]===payload.occurred_at && ids?.includes(payload[eventKey])
      && (payload.phase!=='acknowledged' || attempt.ack_complete===true)) return;
  }
  throw protocolError('RECEIPT_MISMATCH');
}
export function atomicState(file, value) {
  const temporary=`${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd=openSync(temporary,'wx',0o600);
  try {writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,file);
}
export function immutableEnvelope(file, value) {
  const bytes=JSON.stringify(value)+'\n';
  if(existsSync(file)) {
    if(readFileSync(file,'utf8')!==bytes)throw protocolError('IMMUTABLE_ENVELOPE_CONFLICT');
    return file;
  }
  const temporary=`${file}.${process.pid}.${randomUUID()}.tmp`;
  const fd=openSync(temporary,'wx',0o600);
  try {writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}
  try {linkSync(temporary,file);}catch(error) {
    if(error.code!=='EEXIST')throw error;
    if(readFileSync(file,'utf8')!==bytes)throw protocolError('IMMUTABLE_ENVELOPE_CONFLICT');
  }finally{unlinkSync(temporary);}
  return file;
}
const alive = pid => {try {process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
export function claimLane(root,lane) {
  const parent=path.join(root,'sync-locks');mkdirSync(parent,{recursive:true,mode:0o700});
  const directory=path.join(parent,hash(lane));
  for(let retry=0;retry<2;retry++) {
    try {mkdirSync(directory,{mode:0o700});}
    catch(error) {
      if(error.code!=='EEXIST') throw error;
      let owners;
      try {owners=readdirSync(directory);}catch {return null;}
      if(!owners.length) {if(Date.now()-statSync(directory).mtimeMs<60000)return null;}
      else {
        if(owners.some(name=>!/^\d+-[a-f0-9-]+\.owner$/.test(name) || alive(Number(name.split('-')[0])))) return null;
        for(const name of owners) try {unlinkSync(path.join(directory,name));}catch(error){if(error.code!=='ENOENT')return null;}
      }
      try {rmdirSync(directory);}catch {return null;}
      continue;
    }
    const owner=path.join(directory,`${process.pid}-${randomUUID()}.owner`);
    writeFileSync(owner,'',{flag:'wx',mode:0o600});
    return ()=>{try {unlinkSync(owner);rmdirSync(directory);}catch(error){if(error.code!=='ENOENT')throw error;}};
  }
  return null;
}
export function queueItems(directory,kind) {
  if(!existsSync(directory))return [];
  return readdirSync(directory).filter(name=>/^[a-zA-Z0-9_.:-]+\.json$/.test(name)).map(name=>{
    const filePath=path.join(directory,name);
    try {
      const raw=readFileSync(filePath), value=JSON.parse(raw);
      const item={filePath,kind,...(kind==='event'?{payload:value}:value),envelope_hash:hash(raw)};
      const payload=kind==='event'?item.payload?.event:item.payload;
      item.lane=typeof payload?.session_id==='string' && payload.session_id ? `session:${payload.session_id}`:'legacy';
      item.time=payload?.captured_at || payload?.occurred_at || '';
      if(typeof item.time!=='string') {item.time='';item.parse_error=true;}
      item.phase=payload?.phase;
      delete item.payload;
      Object.defineProperty(item,'payload',{enumerable:true,get(){const value=JSON.parse(readFileSync(this.filePath,'utf8'));return this.kind==='event'?value:value.payload;}});
      return item;
    }catch(error){return {filePath,kind,lane:'legacy',time:'',parse_error:true};}
  }).sort((a,b)=>a.time.localeCompare(b.time) || (['acknowledged','failed'].includes(a.phase)?1:0)-(['acknowledged','failed'].includes(b.phase)?1:0) || a.filePath.localeCompare(b.filePath));
}
export function queueState(item) {
  try {
    if(!existsSync(item.filePath+'.state')) return {state:'pending',attempt_count:0,lane:item.lane};
    const value=JSON.parse(readFileSync(item.filePath+'.state','utf8'));
    if(!states.has(value.state) || !Number.isInteger(value.attempt_count) || value.attempt_count<0
      || (value.last_error_code && !/^[A-Z0-9_]{1,64}$/.test(value.last_error_code))
      || (value.next_retry_at && !Number.isFinite(Date.parse(value.next_retry_at)))) throw Error();
    return value;
  } catch {return {state:'blocked_protocol',last_error_code:'CORRUPT_SIDECAR',attempt_count:0,lane:item.lane,corrupt:true};}
}
export function queueSummary(items,now=Date.now(),root=null) {
  const counts=Object.fromEntries([...states].map(state=>[state,0]));
  let oldest=null,last=null;
  for(const item of items) {
    const state=queueState(item); counts[item.parse_error?'blocked_protocol':state.state]++;
    const time=Date.parse(item.time); if(Number.isFinite(time))oldest=Math.max(oldest??0,now-time);
    if(state.last_error_code)last=state.last_error_code;
  }
  let lastSuccess=null;
  try {if(root)lastSuccess=JSON.parse(readFileSync(path.join(root,'sync-last-success.state'),'utf8')).at;}catch {}
  return {counts,queued:items.length,oldest_age_ms:oldest,high_water:items.length>=1000,last_error_code:last,last_success_at:lastSuccess};
}
export async function flushQueue(items, {root,credential,send,accepted=()=>{},quarantine=null,predecessors=[],now=()=>Date.now(),random=Math.random,afterAccepted=()=>{},maxElapsedMs=15000}) {
  const credentialId=hash(credential), blocked=new Set(), result={queued_before:items.length,flushed:0,quarantined:0,blocked:0};
  const markerDir=path.join(root,'sync-lanes');mkdirSync(markerDir,{recursive:true,mode:0o700});
  const authFile=path.join(root,'sync-auth.state');
  try {if(existsSync(authFile)&&JSON.parse(readFileSync(authFile,'utf8')).credential_fingerprint===credentialId)return {...result,blocked:items.length};}catch{return {...result,blocked:items.length};}
  let attempts=0;const started=performance.now();
  for(const item of items) {
    if(attempts>=100 || performance.now()-started>=maxElapsedMs)break;
    const release=claimLane(root,item.lane); if(!release){result.blocked++;continue;}
    try {
      if(!existsSync(item.filePath))continue;
      const markerPath=path.join(markerDir,hash(item.lane)+'.state');
      let marker=null;
      try {if(existsSync(markerPath))marker=JSON.parse(readFileSync(markerPath,'utf8'));}catch {result.blocked++;continue;}
      let state=queueState(item);
      const fail=error=>{
        state=retryState(error,state,{now:now(),random,credential:credentialId});
        state.lane=item.lane;state.envelope_hash=item.envelope_hash;
        atomicState(item.filePath+'.state',state);
        atomicState(markerPath,{file:item.filePath,state:state.state});
        if(state.state==='paused_auth')atomicState(authFile,{credential_fingerprint:credentialId,last_error_code:state.last_error_code});
        if(state.state==='quarantined' && quarantine)quarantine(item,error);
        blocked.add(item.lane);result[state.state==='quarantined'?'quarantined':'blocked']++;
      };
      if(state.corrupt) {atomicState(markerPath,{file:item.filePath,state:'blocked_protocol'});result.blocked++;continue;}
      if(predecessors.some(other=>other.filePath!==item.filePath && other.lane===item.lane && other.time<item.time && existsSync(other.filePath))) {
        atomicState(item.filePath+'.state',{...state,state:'blocked_gap',last_error_code:'PENDING_PREDECESSOR'});result.blocked++;continue;
      }
      if(blocked.has(item.lane) || (marker && marker.file!==item.filePath)) {
        if(!['quarantined','blocked_protocol','blocked_reconciliation'].includes(state.state))atomicState(item.filePath+'.state',{...state,state:'blocked_gap',last_error_code:'LANE_GAP',lane:item.lane});
        result.blocked++;continue;
      }
      if(item.parse_error){fail(protocolError('CORRUPT_ENVELOPE',422));continue;}
      if(hash(readFileSync(item.filePath))!==item.envelope_hash){fail(protocolError('RECEIPT_MISMATCH'));continue;}
      if(state.envelope_hash && state.envelope_hash!==item.envelope_hash){fail(protocolError('RECEIPT_MISMATCH'));continue;}
      if(['quarantined','blocked_protocol','blocked_reconciliation'].includes(state.state)
        || (state.state==='paused_auth' && state.credential_fingerprint===credentialId)
        || (state.credential_fingerprint===credentialId && state.next_retry_at && Date.parse(state.next_retry_at)>now())) {blocked.add(item.lane);result.blocked++;continue;}
      try {
        attempts++;
        atomicState(item.filePath+'.state',{...state,state:'pending',envelope_hash:item.envelope_hash,attempt_count:state.attempt_count+1,last_attempt_at:new Date(now()).toISOString()});
        let response;
        try {response=await send(item);}catch(error){
          if(error.statusCode!==409 || error.responseData?.error_code!=='IDEMPOTENT_REPLAY')throw error;
          response=error.responseData;
        }
        validateAcceptance(item.kind,item,response);
        await accepted(item,response);
        Object.defineProperty(result,'last_response',{value:response,configurable:true});
        await afterAccepted(item);
        atomicState(path.join(root,'sync-last-success.state'),{at:new Date(now()).toISOString()});
        if(existsSync(authFile))unlinkSync(authFile);
        unlinkSync(item.filePath);
        for(const file of [item.filePath+'.state',markerPath])if(existsSync(file))unlinkSync(file);
        result.flushed++;
      } catch(error){fail(error);if(state.state==='paused_auth')break;}
    } finally {release();}
  }
  return result;
}

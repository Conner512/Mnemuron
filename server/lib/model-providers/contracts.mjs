import {createHash} from 'node:crypto';

export class ModelError extends Error {
  constructor(code, {retryAfterMs=0}={}) {
    super(code);this.name='ModelError';this.code=code;this.errorCode=code;this.retryAfterMs=retryAfterMs;
    this.statusCode=['SEMANTIC_UNAVAILABLE','VECTOR_NOT_READY','VECTOR_UNAVAILABLE','NOT_CONFIGURED','REMOTE_UNAVAILABLE','REQUEST_TIMEOUT','NETWORK_ERROR'].includes(code)?503:
      code==='RATE_LIMITED'?429:['LEASE_LOST','STALE_INPUT','VECTOR_CATCHUP_REQUIRED'].includes(code)?409:
      ['EGRESS_DENIED','SENSITIVITY_DENIED','ADDRESS_DENIED'].includes(code)?403:400;
  }
}
export const fail = code => {throw new ModelError(code);};
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function strictObject(value, keys) {
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k))) fail('INVALID_SCHEMA');
}
export function integer(value,min,max) { if (!Number.isInteger(value) || value<min || value>max) fail('INVALID_CONFIG'); return value; }
export function text(value,max=200) {if (typeof value!=='string' || !value.length || value.length>max) fail('INVALID_SCHEMA');return value;}
export function validateProfile(input, {kind,synthetic=false}={}) {
  strictObject(input,['enabled','provider_id','protocol','base_url','model','profile_revision','auth','timeouts','limits','retry','capabilities','egress',
    'dimensions','distance','query_prefix','document_prefix','normalization','chunker_version','paths']);
  if(typeof input.enabled!=='boolean')fail('INVALID_CONFIG');
  if (input.enabled!==true) return {enabled:false};
  if (!['organizer','embedder'].includes(kind) || !['openai_compatible','ollama','mock'].includes(input.protocol)) fail('INVALID_CONFIG');
  for(const k of ['provider_id','model','profile_revision']) text(input[k]);
  if(input.protocol==='mock' && !synthetic) fail('MOCK_PRODUCTION_DENIED');
  const p=structuredClone(input);
  strictObject(p.timeouts,['request_ms']); integer(p.timeouts.request_ms,1,120000);
  strictObject(p.limits,['input_bytes','input_tokens','output_bytes','output_tokens','batch_size','concurrency','daily_requests']);
  for(const k of ['input_bytes','output_bytes']) integer(p.limits[k],1,8*1024*1024);
  for(const k of ['input_tokens','output_tokens']) integer(p.limits[k],1,1000000);
  integer(p.limits.batch_size,1,128);integer(p.limits.concurrency,1,16);integer(p.limits.daily_requests,1,1000000);
  strictObject(p.retry,['max_attempts','base_ms','max_ms','repair_once']);
  integer(p.retry.max_attempts,1,10);integer(p.retry.base_ms,1,60000);integer(p.retry.max_ms,p.retry.base_ms,3600000);
  if(p.retry.repair_once!==undefined && typeof p.retry.repair_once!=='boolean') fail('INVALID_CONFIG');
  strictObject(p.capabilities,['native_schema']);if(typeof p.capabilities.native_schema!=='boolean')fail('INVALID_CONFIG');
  strictObject(p.auth,['env','secret_file','none']);
  if(Object.keys(p.auth).length!==1 || p.auth.none!==undefined && p.auth.none!==true) fail('INVALID_CONFIG');
  if(Object.hasOwn(p.auth,'env') && (typeof p.auth.env!=='string' || !/^[A-Z][A-Z0-9_]{0,100}$/.test(p.auth.env)))fail('INVALID_CONFIG');
  if(Object.hasOwn(p.auth,'secret_file') && (typeof p.auth.secret_file!=='string' || !p.auth.secret_file.startsWith('/')))fail('INVALID_CONFIG');
  strictObject(p.egress,['approved','origins','addresses','allow_private','sensitivities','query_approved']);
  for(const k of ['approved','allow_private','query_approved'])if(typeof p.egress[k]!=='boolean')fail('INVALID_CONFIG');
  for(const k of ['origins','addresses','sensitivities'])if(!Array.isArray(p.egress[k]) || p.egress[k].length>64 || p.egress[k].some(v=>typeof v!=='string'))fail('INVALID_CONFIG');
  if(p.egress.sensitivities.some(v=>!['public','internal','sensitive'].includes(v)))fail('INVALID_CONFIG');
  if(p.protocol!=='mock') {
    let url;try{url=new URL(p.base_url);}catch{fail('INVALID_CONFIG');}
    if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)fail('INVALID_CONFIG');
    if(url.protocol==='http:' && !p.egress.allow_private)fail('INVALID_CONFIG');
    p.base_url=url.href.replace(/\/$/,'');
  }
  strictObject(p.paths || {},['chat','embed']);
  for(const v of Object.values(p.paths || {})) if(typeof v!=='string' || !/^\/[a-zA-Z0-9_/-]+$/.test(v) || v.includes('..') || v.includes('//'))fail('INVALID_CONFIG');
  if(kind==='embedder') {
    integer(p.dimensions,1,65536);
    if(!['Cosine','Dot','Euclid'].includes(p.distance) || !['none','l2'].includes(p.normalization))fail('INVALID_CONFIG');
    text(p.chunker_version);for(const k of ['query_prefix','document_prefix'])if(typeof p[k]!=='string' || p[k].length>512)fail('INVALID_CONFIG');
  }
  // Credentials and budgets may rotate without reusing a different model's index space.
  p.fingerprint=digest([kind,p.protocol,p.base_url,p.model,p.profile_revision,p.paths,p.dimensions,p.distance,p.query_prefix,p.document_prefix,p.normalization,p.chunker_version]);
  return Object.freeze(p);
}

// A deliberately small closed JSON-Schema subset; unsupported schemas fail closed.
export function validateStructured(value,schema,depth=0) {
  if(depth>12)fail('INVALID_MODEL_OUTPUT');
  const bad=()=>fail('INVALID_MODEL_OUTPUT');
  if(schema.enum && !schema.enum.includes(value))bad();
  if(schema.type==='object') {
    if(!value || typeof value!=='object' || Array.isArray(value) || schema.additionalProperties!==false)bad();
    if(Object.keys(value).some(k=>!Object.hasOwn(schema.properties || {},k)) || (schema.required || []).some(k=>!Object.hasOwn(value,k)))bad();
    for(const [k,v] of Object.entries(value))validateStructured(v,schema.properties[k],depth+1);
  } else if(schema.type==='array') {
    if(!Array.isArray(value) || !Number.isInteger(schema.maxItems) || value.length>schema.maxItems || value.length<(schema.minItems || 0))bad();
    for(const v of value)validateStructured(v,schema.items,depth+1);
  } else if(schema.type==='string') {
    if(typeof value!=='string' || !Number.isInteger(schema.maxLength) || value.length>schema.maxLength || value.length<(schema.minLength || 0))bad();
  } else if(schema.type==='integer') {if(!Number.isSafeInteger(value) || value<schema.minimum || value>schema.maximum)bad();}
  else if(schema.type==='boolean') {if(typeof value!=='boolean')bad();}
  else bad();
  return value;
}

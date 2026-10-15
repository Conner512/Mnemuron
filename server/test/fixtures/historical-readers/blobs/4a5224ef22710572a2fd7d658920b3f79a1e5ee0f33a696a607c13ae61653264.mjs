import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {readFileSync,statSync} from 'node:fs';
import {ModelError,fail} from './contracts.mjs';

function addressClass(address) {
  const ip=address.toLowerCase();
  if(isIP(ip)===6) {
    // Mapped/transition encodings cannot circumvent IPv4 policy.
    if(ip.includes('.') || /^(::ffff:|64:ff9b:|2002:|2001:0:|fe[89ab]|ff)/.test(ip) || ip==='::')return 'denied';
    return ip==='::1' || /^(fc|fd)/.test(ip)?'private':'public';
  }
  if(isIP(ip)!==4)return 'denied';
  const [a,b]=ip.split('.').map(Number);
  if(a===0 || a===169 && b===254 || a>=224 || a===100 && b>=64 && b<=127 || ip==='168.63.129.16')return 'denied';
  return a===10 || a===127 || a===192 && b===168 || a===172 && b>=16 && b<=31?'private':'public';
}
export async function approvedTarget(profile,{resolve=lookup}={}) {
  const url=new URL(profile.base_url),policy=profile.egress,hostname=url.hostname.replace(/^\[|\]$/g,'');
  if(!policy.approved || !policy.origins.includes(url.origin) || url.username || url.password || /(^|\.)metadata\./i.test(hostname))fail('EGRESS_DENIED');
  const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await resolve(hostname,{all:true,verbatim:true}).catch(()=>fail('DNS_UNAVAILABLE'));
  if(!addresses.length || addresses.some(({address})=>!policy.addresses.includes(address) || addressClass(address)==='denied' || addressClass(address)==='private' && !policy.allow_private))fail('ADDRESS_DENIED');
  if(url.protocol==='http:' && addresses.some(({address})=>addressClass(address)!=='private'))fail('TLS_REQUIRED');
  return {url,address:addresses[0]};
}
export function authHeaders(profile,env=process.env) {
  let secret;
  if(profile.auth.env)secret=env[profile.auth.env];
  if(profile.auth.secret_file) {
    try{const s=statSync(profile.auth.secret_file);if(!s.isFile() || (s.mode & 0o077)!==0 || s.size>16384)fail('SECRET_REFERENCE_INVALID');secret=readFileSync(profile.auth.secret_file,'utf8').trim();}
    catch{fail('SECRET_REFERENCE_INVALID');}
  }
  if(profile.auth.none)return {};
  if(!secret || /[\r\n]/.test(secret) || secret.length>16384)fail('AUTH_NOT_CONFIGURED');
  return {authorization:'Bearer '+secret};
}
export async function requestJSON(profile,route,body,{method='POST',resolve,env,headers={}}={}) {
  const {url,address}=await approvedTarget(profile,{resolve});
  if(typeof route!=='string' || !/^\/[a-zA-Z0-9_/?=&.%-]*$/.test(route))fail('INVALID_ROUTE');
  let decoded;try{decoded=decodeURIComponent(route);}catch{fail('INVALID_ROUTE');}
  if(decoded.includes('..') || decoded.startsWith('//') || decoded.includes('\\'))fail('INVALID_ROUTE');
  const target=new URL(profile.base_url+route),payload=body===undefined?undefined:JSON.stringify(body);
  if(target.origin!==url.origin)fail('EGRESS_DENIED');
  if(payload && Buffer.byteLength(payload)>profile.limits.input_bytes)fail('INPUT_TOO_LARGE');
  const requestHeaders={...authHeaders(profile,env),...headers,'content-type':'application/json',...(payload?{'content-length':Buffer.byteLength(payload)}:{})};
  return new Promise((resolveResult,reject)=>{
    let settled=false;const end=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolveResult(value);};
    // Direct socket + pinned lookup: no environment proxy and no second DNS resolution.
    const request=(target.protocol==='https:'?https:http).request(target,{method,agent:false,headers:requestHeaders,
      lookup:(_host,options,cb)=>options.all?cb(null,[address]):cb(null,address.address,address.family)},response=>{
      let bytes=0;const chunks=[];
      response.on('data',chunk=>{bytes+=chunk.length;if(bytes>profile.limits.output_bytes){end(new ModelError('OUTPUT_TOO_LARGE'));response.destroy();request.destroy();}else chunks.push(chunk);});
      response.on('error',()=>end(new ModelError('NETWORK_ERROR')));
      response.on('end',()=>{
        const status=response.statusCode;
        if(status>=300 && status<400)return end(new ModelError('REDIRECT_DENIED'));
        if(status===401 || status===403)return end(new ModelError('AUTH_FAILED'));
        if(status===429 || status>=500) {
          const raw=response.headers['retry-after'];const wait=/^\d+$/.test(raw || '')?Number(raw)*1000:Date.parse(raw)-Date.now();
          return end(new ModelError(status===429?'RATE_LIMITED':'REMOTE_UNAVAILABLE',{retryAfterMs:Math.min(3600000,Math.max(0,wait || 0))}));
        }
        if(status<200 || status>=300)return end(new ModelError('HTTP_REJECTED'));
        try{end(null,JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{end(new ModelError('INVALID_JSON'));}
      });
    });
    const timer=setTimeout(()=>{end(new ModelError('REQUEST_TIMEOUT'));request.destroy();},profile.timeouts.request_ms);
    request.on('error',()=>end(new ModelError('NETWORK_ERROR')));request.end(payload);
  });
}

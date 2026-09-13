import {strictObject,fail,integer} from '../model-providers/contracts.mjs';
import {requestJSON,authHeaders,approvedTarget} from '../model-providers/transport.mjs';

export const QDRANT_PROTOCOL='qdrant-rest-v1.19';
export function vectorConfig(input){
  strictObject(input,['enabled','protocol','base_url','auth','egress','timeouts','limits','collection_prefix']);
  if(typeof input.enabled!=='boolean')fail('INVALID_VECTOR_CONFIG');
  if(input.enabled!==true)return {enabled:false};
  if(input.protocol!==QDRANT_PROTOCOL || !/^[a-z][a-z0-9_]{0,39}$/.test(input.collection_prefix || ''))fail('INVALID_VECTOR_CONFIG');
  strictObject(input.auth,['env','secret_file']);if(Object.keys(input.auth).length!==1)fail('VECTOR_AUTH_REQUIRED');
  if(Object.hasOwn(input.auth,'env') && (typeof input.auth.env!=='string' || !/^[A-Z][A-Z0-9_]{0,100}$/.test(input.auth.env)) || Object.hasOwn(input.auth,'secret_file') && (typeof input.auth.secret_file!=='string' || !input.auth.secret_file.startsWith('/')))fail('INVALID_VECTOR_CONFIG');
  strictObject(input.egress,['approved','origins','addresses','allow_private']);
  if(input.egress.approved!==true || input.egress.allow_private!==true || !Array.isArray(input.egress.origins) || !Array.isArray(input.egress.addresses))fail('PRIVATE_VECTOR_REQUIRED');
  let url;try{url=new URL(input.base_url);}catch{fail('INVALID_VECTOR_CONFIG');}
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname!=='/')fail('INVALID_VECTOR_CONFIG');
  // A private allowlist, not a public Tunnel hostname or arbitrary internet host.
  if(input.egress.addresses.some(ip=>!/^10\.|^127\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^::1$|^f[cd][0-9a-f:]+$/i.test(ip)) || !input.egress.addresses.length)fail('PRIVATE_VECTOR_REQUIRED');
  strictObject(input.timeouts,['request_ms']);integer(input.timeouts.request_ms,1,120000);
  strictObject(input.limits,['input_bytes','output_bytes']);integer(input.limits.input_bytes,1,8*1024*1024);integer(input.limits.output_bytes,1,8*1024*1024);
  return {...structuredClone(input),base_url:url.origin};
}
const collection=name=>{if(!/^[a-z][a-z0-9_]{0,100}$/.test(name))fail('INVALID_COLLECTION');return '/collections/'+name;};
export class QdrantStore {
  constructor(config,{transport=requestJSON,env=process.env}={}){this.config=vectorConfig(config);this.transport=transport;this.env=env;}
  async call(route,body,method='POST'){
    if(!this.config.enabled)fail('VECTOR_DISABLED');
    const bearer=authHeaders(this.config,this.env).authorization;
    const response=await this.transport({...this.config,auth:{none:true}},route,body,{method,env:this.env,headers:{'api-key':bearer.slice(7)}});
    if(response.status && response.status!=='ok')fail('VECTOR_REJECTED');return response.result ?? response;
  }
  async health(){const response=await this.call('/',undefined,'GET');return {state:'ready',protocol:QDRANT_PROTOCOL,version:response.version || null};}
  async ensureCollection(name,{dimensions,distance}){
    const base=collection(name),exists=await this.call(base+'/exists',undefined,'GET');
    if(exists.exists){const info=await this.call(base,undefined,'GET');const v=info.config?.params?.vectors;
      if(v?.size!==dimensions || v?.distance!==distance)fail('VECTOR_PROFILE_MISMATCH');return;
    }
    await this.call(base,{vectors:{size:dimensions,distance}},'PUT');
  }
  async upsert(name,points){return this.call(collection(name)+'/points?wait=true&ordering=strong',{points},'PUT');}
  async search(name,vector,filter,limit){integer(limit,1,100);const result=await this.call(collection(name)+'/points/query',{query:vector,filter,limit,with_payload:true,with_vector:false});
    if(!Array.isArray(result.points))fail('INVALID_VECTOR_RESPONSE');return result.points;}
  async deleteByDocumentRevision(name,filter){return this.call(collection(name)+'/points/delete?wait=true&ordering=strong',{filter});}
  async scroll(name,offset=null){return this.call(collection(name)+'/points/scroll',{limit:100,with_payload:true,with_vector:false,...(offset===null?{}:{offset})});}
  async validateTarget(){return approvedTarget(this.config);}
  // Generation authority lives in SQLite; there is deliberately no mutable read alias here.
  rebuildState(authority){return authority.state();}
  switchGeneration(authority,id){return authority.activate(id);}
}

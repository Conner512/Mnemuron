import {lookup} from 'node:dns/promises';
import {Organizer,Embedder} from '../model-providers/providers.mjs';
import {requestJSON} from '../model-providers/transport.mjs';
import {validateProfile,fail} from '../model-providers/contracts.mjs';
import {ConflictError,ValidationError} from '../errors.mjs';
import {object,number,fingerprint} from './state.mjs';

// A browser may configure its own HTTPS service and its own key, never an env/file
// reference, a proxy, or another user's model. Private destinations need operator approval.
export class ConsoleModels {
  constructor(store,state){this.store=store;this.state=state;this.db=store.db;}
  raw(user,kind){if(!['organizer','embedder'].includes(kind))throw new ValidationError('Unknown model kind.');return this.db.prepare('SELECT * FROM console_models WHERE user_id=? AND kind=?').get(user,kind);}
  list(user){return ['organizer','embedder'].map(kind=>{const row=this.raw(user,kind);return {kind,revision:row?.revision||0,config:row?JSON.parse(row.config_json):{enabled:false},has_key:!!row?.secret_cipher};});}
  save(auth,p) {
    object(p,['kind','expected_revision','config','api_key','remove_key']);object(p.config,['enabled','protocol','base_url','model','profile_revision','dimensions','daily_requests','output_tokens','batch_size','sensitivities','egress_approved','query_approved','native_schema']);
    const row=this.raw(auth.user_id,p.kind),revision=row?.revision||0;
    if(number(p.expected_revision,0,2147483647)!==revision)throw new ConflictError('Model configuration changed.','MODEL_VERSION_CHANGED');
    const config=structuredClone(p.config);
    if(config.native_schema===undefined)config.native_schema=true;
    if(typeof config.native_schema!=='boolean')throw new ValidationError('Invalid schema capability.');
    if(typeof config.enabled!=='boolean'||!['openai_compatible','ollama'].includes(config.protocol))throw new ValidationError('Invalid model configuration.');
    let url;try{url=new URL(config.base_url);}catch{throw new ValidationError('Invalid model URL.');}
    const privateApproved=(this.store.memoryConfig.console?.allowed_private_origins||[]).includes(url.origin);
    if(url.username||url.password||url.hash||url.search||!['https:',...(privateApproved?['http:']:[])].includes(url.protocol))throw new ValidationError('Use HTTPS; private HTTP requires operator approval.','MODEL_URL_DENIED');
    config.base_url=url.href.replace(/\/$/,'');
    for(const key of ['model','profile_revision'])if(typeof config[key]!=='string'||!config[key].trim()||config[key].length>160)throw new ValidationError('Model name and revision are required.');
    number(config.daily_requests,1,10000);number(config.output_tokens,128,32768);number(config.batch_size,1,20);
    if(p.kind==='embedder')number(config.dimensions,1,65536);
    if(typeof config.egress_approved!=='boolean'||typeof config.query_approved!=='boolean'||!Array.isArray(config.sensitivities)||config.sensitivities.length<1||config.sensitivities.some(s=>!['public','internal','sensitive'].includes(s)))throw new ValidationError('Explicit egress policy required.');
    if(p.remove_key!==undefined&&typeof p.remove_key!=='boolean')throw new ValidationError('Invalid key operation.');
    if(p.api_key!==undefined&&(typeof p.api_key!=='string'||!p.api_key||p.api_key.length>16384||/[\r\n\x00]/.test(p.api_key)))throw new ValidationError('Invalid model key.');
    if(p.api_key&&p.remove_key)throw new ValidationError('Conflicting key operation.');
    let secret=row?.secret_cipher||null;if(row&&new URL(JSON.parse(row.config_json).base_url).origin!==url.origin)secret=null;if(p.remove_key)secret=null;if(p.api_key)secret=this.state.seal(auth.user_id,`model:${p.kind}`,p.api_key);
    this.profile(auth.user_id,p.kind,config);
    this.db.prepare('INSERT INTO console_models VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,kind) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,secret_cipher=excluded.secret_cipher,updated_at=excluded.updated_at')
      .run(auth.user_id,p.kind,revision+1,JSON.stringify(config),secret,Date.now());
    // Old profile jobs do not run with a new key/model by accident. They remain inspectable.
    if(p.kind==='organizer')this.db.prepare("UPDATE memory_jobs SET state='blocked_config',fence=fence+1,lease_owner=NULL,lease_expires=NULL,last_error_code='NOT_CONFIGURED' WHERE user_id=? AND profile LIKE 'console-%' AND state IN ('pending','leased','retry_wait')").run(auth.user_id);
    return {status:'saved',model:this.list(auth.user_id).find(m=>m.kind===p.kind)};
  }
  profile(user,kind,c) {
    const privateApproved=(this.store.memoryConfig.console?.allowed_private_origins||[]).includes(new URL(c.base_url).origin);
    const profile=validateProfile({enabled:true,provider_id:`console-${kind}`,protocol:c.protocol,base_url:c.base_url,model:c.model,profile_revision:c.profile_revision,auth:{none:true},
      timeouts:{request_ms:30000},limits:{input_bytes:262144,input_tokens:262144,output_bytes:524288,output_tokens:c.output_tokens,batch_size:c.batch_size,concurrency:1,daily_requests:c.daily_requests},
      retry:{max_attempts:3,base_ms:2000,max_ms:60000,repair_once:false},capabilities:{native_schema:c.native_schema!==false},
      egress:{approved:c.egress_approved,query_approved:c.query_approved,origins:[new URL(c.base_url).origin],addresses:[],allow_private:privateApproved,sensitivities:c.sensitivities},
      ...(kind==='embedder'?{dimensions:c.dimensions,distance:'Cosine',query_prefix:'',document_prefix:'',normalization:'l2',chunker_version:'unicode-8k-v1'}:{})},{kind});
    return {...profile,fingerprint:'console-'+fingerprint([user,profile.fingerprint])};
  }
  provider(user,kind) {
    const row=this.raw(user,kind),c=row&&JSON.parse(row.config_json);if(!c?.enabled)fail('NOT_CONFIGURED');
    const profile=this.profile(user,kind,c),ctor=kind==='organizer'?Organizer:Embedder;
    // validateProfile is reused, then the budget/index fingerprint is namespaced by owner.
    const {fingerprint:unused,...input}=profile;
    const provider=new ctor(input,{transport:async(p,route,body)=>{
      const current=this.raw(user,kind);
      if(!current||current.revision!==row.revision)fail('STALE_INPUT');
      const host=new URL(p.base_url).hostname.replace(/^\[|\]$/g,'');
      const addresses=await lookup(host,{all:true,verbatim:true}).catch(()=>fail('DNS_UNAVAILABLE'));
      if(this.raw(user,kind)?.revision!==row.revision)fail('STALE_INPUT');
      // requestJSON rejects metadata, link-local, private/transition addresses and
      // redirects, and pins the validated lookup result to the actual socket.
      const target={...p,egress:{...p.egress,addresses:addresses.map(a=>a.address)}};
      const headers=row.secret_cipher?{authorization:'Bearer '+this.state.unseal(user,`model:${kind}`,row.secret_cipher)}:{};
      return requestJSON(target,route,body,{resolve:async()=>addresses,headers});
    }});
    provider.profile=Object.freeze(profile);return provider;
  }
  async test(auth,p) {
    object(p,['kind']);const provider=this.provider(auth.user_id,p.kind);
    const reserve=()=>this.store.memoryTransaction(()=>{
      const day=new Date().toISOString().slice(0,10),profile=provider.profile.fingerprint;
      this.db.prepare('INSERT OR IGNORE INTO memory_model_budget VALUES(?,?,0)').run(profile,day);
      const vectorCalls=p.kind==='embedder'&&this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_vector_calls'").get()?this.db.prepare('SELECT count n FROM memory_vector_calls WHERE profile=? AND day=?').get(profile,day)?.n||0:0;
      if(vectorCalls+this.db.prepare('SELECT reserved_calls n FROM memory_model_budget WHERE profile=? AND day=?').get(profile,day).n>=provider.profile.limits.daily_requests)fail('BUDGET_EXHAUSTED');
      this.db.prepare('UPDATE memory_model_budget SET reserved_calls=reserved_calls+1 WHERE profile=? AND day=?').run(profile,day);
      this.db.prepare('INSERT INTO memory_owner_model_usage VALUES(?,?,?,1) ON CONFLICT(user_id,profile,day) DO UPDATE SET reserved_calls=reserved_calls+1').run(auth.user_id,profile,day);
    });
    if(p.kind==='organizer') {
      const r=await provider.generateStructured({synthetic:true,instruction:'Return ok true.'},{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},{sensitivity:'public',reserve});
      if(r.data.ok!==true)fail('INVALID_MODEL_OUTPUT');
    }else await provider.embed(['Synthetic model connection check.'],'document',{sensitivity:'public',reserve});
    return {status:'verified',kind:p.kind,synthetic_input:true,real_memory_sent:false};
  }
}

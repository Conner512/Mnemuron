import {BoundaryError,readPrivate,fetchJson} from '../../../shared/oauth-common.mjs';
import {CONSOLE_READ_SCOPES,CONSOLE_WRITE_SCOPES,exactScopes} from '../../../shared/console-contract.mjs';
export class ConsoleCore {
  constructor(config,principal,binding) {
    if(!binding||binding.purpose!=='console'||!config?.base_url)throw new BoundaryError(503,'CONSOLE_CORE_UNAVAILABLE');
    this.config=config;this.principal=principal;this.binding=binding;this.token=readPrivate(binding.credential_file);
  }
  async request(route,{method='GET',body}={}) {
    let r;
    try {r=await fetchJson(`${this.config.base_url}${route}`,{method,headers:{authorization:`Bearer ${this.token}`,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})},{timeoutMs:40000,maxBytes:262144});}
    catch{throw new BoundaryError(503,'CONSOLE_CORE_UNAVAILABLE');}
    if(r.status!==200) {
      const codes=['MEMORY_VERSION_CHANGED','SOURCE_MANIFEST_CHANGED','SUMMARY_VERSION_CHANGED','INVALID_CURSOR','CURSOR_EXPIRED','MEMORY_NOT_FOUND',
        'IDEMPOTENCY_CONFLICT','INVALID_CONSOLE_INPUT','MODEL_VERSION_CHANGED','MODEL_URL_DENIED','NOT_CONFIGURED','CONSOLE_KEY_REQUIRED','EGRESS_DENIED','ADDRESS_DENIED',
        'BUDGET_EXHAUSTED','CONNECTION_REVOKED','MANAGED_CONNECTION','JOB_NOT_RETRYABLE','JOB_TERMINAL','JOB_NOT_FOUND','STALE_INPUT','OPERATION_PENDING','OPERATION_FAILED',
        'IMPORT_CONFLICT','CONTENT_TOO_LONG','EXPORT_RECORD_TOO_LARGE','VECTOR_DISABLED','VECTOR_NOT_READY','MEMORY_DISABLED','SETTINGS_VERSION_CHANGED','SEMANTIC_UNAVAILABLE','WEB_VISIBILITY_DENIED'];
      throw new BoundaryError([400,403,404,409,413,429,503].includes(r.status)?r.status:503,codes.includes(r.data.error_code)?r.data.error_code:'CONSOLE_REQUEST_FAILED');
    }
    return r.data;
  }
  async identity() {
    const identity=await this.request('/v1/identity'),i=identity.identity;
    if(i?.user_id!==this.principal.user_id||i?.credential_id!==this.binding.credential_id||i?.agent_id!=='mnemuron-console'||i?.agent_instance_id!==this.binding.agent_instance_id
      || ![CONSOLE_READ_SCOPES,CONSOLE_WRITE_SCOPES].some(expected=>exactScopes(identity.scopes,expected)))throw new BoundaryError(503,'CORE_IDENTITY_MISMATCH');
    return identity;
  }
  async view(view,params={}) {
    await this.identity();
    if(view==='memory') {
      const {memory_id,...options}=params;
      if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(memory_id||'')||Object.keys(options).some(k=>!['content_offset','content_limit','source_offset','revision','source_version','include_history'].includes(k)))throw new BoundaryError(400,'INVALID_DETAIL_REQUEST');
      return this.request(`/v1/memories/${encodeURIComponent(memory_id)}?${new URLSearchParams(options)}`);
    }
    if(!['overview','memories','summaries','summary','jobs','job','storage','connections','audit','capabilities','models','memory-meta','export','projects','operation'].includes(view))throw new BoundaryError(404,'NOT_FOUND');
    return this.request(`/v1/console/${view}?${new URLSearchParams(params)}`);
  }
  async action(input) {
    const identity=await this.identity();if(!exactScopes(identity.scopes,CONSOLE_WRITE_SCOPES))throw new BoundaryError(403,'CONSOLE_UPGRADE_REQUIRED');
    return this.request('/v1/console/action',{method:'POST',body:input});
  }
}

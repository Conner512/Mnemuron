import {BoundaryError,readPrivate,fetchJson} from '../../../shared/oauth-common.mjs';
import {CONSOLE_READ_SCOPES,CONSOLE_BASIC_SCOPES,CONSOLE_WRITE_SCOPES,consoleActionWritable,exactScopes} from '../../../shared/console-contract.mjs';
import {CONSOLE_FEATURE_VIEWS as FEATURE_VIEWS} from '../../../shared/console-contract.mjs';
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
        'IMPORT_CONFLICT','CONTENT_TOO_LONG','EXPORT_RECORD_TOO_LARGE','VECTOR_DISABLED','VECTOR_NOT_READY','VECTOR_AUTH_FAILED','VECTOR_COLLECTION_MISSING','VECTOR_COLLECTION_UNAVAILABLE','VECTOR_COLLECTION_UNVERIFIED','VECTOR_NOT_ACTIVE','VECTOR_NOT_FOUND','VECTOR_CATCHUP_REQUIRED','VECTOR_ALREADY_BUILT','VECTOR_PROFILE_MISMATCH','PROBE_REQUIRED','MANIFEST_CHANGED','MANIFEST_EMPTY','NOT_FIRST_RUN','FIRST_RUN_ACTIVE','FIRST_RUN_IN_PROGRESS','FIRST_RUN_EXISTS','MANIFEST_EXCEEDS_BUDGET','BUDGET_ALREADY_SET','BUDGET_REQUIRED','MEMORY_DISABLED','SETTINGS_VERSION_CHANGED','SEMANTIC_UNAVAILABLE','WEB_VISIBILITY_DENIED','CREDENTIAL_NOT_FOUND','CATEGORY_IN_USE','INVALID_TAXONOMY',
        'PREVIEW_CHANGED','PREVIEW_REQUIRED','SELECTION_TOO_LARGE','SELECTION_TRUNCATED','SELECTION_EMPTY','INVALID_SELECTION','BATCH_ALREADY_UNDONE','BATCH_NOT_FOUND','UNDO_CONFLICT',
        'CATEGORY_EXISTS','INVALID_CATEGORY_LABEL','INVALID_CATEGORY','INVALID_CATEGORY_TARGET','TAXONOMY_FULL',
        'CONSOLE_INPUT_TOO_LARGE','INVALID_IDENTIFIER','INVALID_PAYLOAD',
        'INVALID_EMBEDDING','INVALID_EMBEDDING_COUNT','INVALID_EMBEDDING_ORDER','INVALID_SOURCE_SET','INVALID_MODEL_OUTPUT','INVALID_JSON','INCOMPLETE_OUTPUT','OUTPUT_TOO_LARGE','INPUT_TOO_LARGE','AUTH_FAILED','HTTP_REJECTED','REDIRECT_DENIED','DNS_UNAVAILABLE','RATE_LIMITED','REQUEST_TIMEOUT','NETWORK_ERROR','REMOTE_UNAVAILABLE','SENSITIVITY_DENIED'];
      throw new BoundaryError([400,403,404,409,413,429,503].includes(r.status)?r.status:503,codes.includes(r.data.error_code)?r.data.error_code:'CONSOLE_REQUEST_FAILED');
    }
    return r.data;
  }
  async identity() {
    const identity=await this.request('/v1/identity'),i=identity.identity;
    if(i?.user_id!==this.principal.user_id||i?.credential_id!==this.binding.credential_id||i?.agent_id!=='mnemuron-console'||i?.agent_instance_id!==this.binding.agent_instance_id
      || ![CONSOLE_READ_SCOPES,CONSOLE_BASIC_SCOPES,CONSOLE_WRITE_SCOPES].some(expected=>exactScopes(identity.scopes,expected)))throw new BoundaryError(503,'CORE_IDENTITY_MISMATCH');
    return identity;
  }
  async view(view,params={}) {
    await this.identity();
    if(view==='memory') {
      if(params.metadata==='true'){
        if(Object.keys(params).some(k=>!['memory_id','metadata'].includes(k))||!/^[A-Za-z0-9_.:-]{1,160}$/.test(params.memory_id||''))throw new BoundaryError(400,'INVALID_DETAIL_REQUEST');
        return this.request(`/v1/console/memory-meta?${new URLSearchParams({memory_id:params.memory_id})}`);
      }
      const {memory_id,...options}=params;
      if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(memory_id||'')||Object.keys(options).some(k=>!['content_offset','content_limit','source_offset','revision','source_version','include_history'].includes(k)))throw new BoundaryError(400,'INVALID_DETAIL_REQUEST');
      return this.request(`/v1/memories/${encodeURIComponent(memory_id)}?${new URLSearchParams(options)}`);
    }
    if(!['overview','memories','summaries','summary','jobs','job','storage','connections','audit','capabilities','models','memory-meta','export','projects','operation',...FEATURE_VIEWS].includes(view))throw new BoundaryError(404,'NOT_FOUND');
    return this.request(`/v1/console/${view}?${new URLSearchParams(params)}`);
  }
  async action(input) {
    const identity=await this.identity();if(!consoleActionWritable({...identity.identity,scopes:identity.scopes},input.action))throw new BoundaryError(403,'CONSOLE_UPGRADE_REQUIRED');
    return this.request('/v1/console/action',{method:'POST',body:input});
  }
}

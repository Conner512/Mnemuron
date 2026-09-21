import {BoundaryError,readPrivate,fetchJson} from '../../../shared/oauth-common.mjs';
export class ConsoleCore {
  constructor(config,principal,binding) {
    if(!binding||binding.purpose!=='console'||!config?.base_url)throw new BoundaryError(503,'CONSOLE_CORE_UNAVAILABLE');
    this.config=config;this.principal=principal;this.binding=binding;this.token=readPrivate(binding.credential_file);
  }
  async request(route) {
    let r;
    try {r=await fetchJson(`${this.config.base_url}${route}`,{headers:{authorization:`Bearer ${this.token}`}}, {timeoutMs:5000,maxBytes:262144});}
    catch{throw new BoundaryError(503,'CONSOLE_CORE_UNAVAILABLE');}
    if(r.status!==200) {
      const code=['MEMORY_VERSION_CHANGED','SOURCE_MANIFEST_CHANGED','SUMMARY_VERSION_CHANGED','INVALID_CURSOR','CURSOR_EXPIRED','MEMORY_NOT_FOUND'].includes(r.data.error_code)?r.data.error_code:'CONSOLE_READ_FAILED';
      throw new BoundaryError([400,404,409].includes(r.status)?r.status:503,code);
    }
    return r.data;
  }
  async view(view,params) {
    const identity=await this.request('/v1/identity'),i=identity.identity;
    if(i?.user_id!==this.principal.user_id||i?.credential_id!==this.binding.credential_id||i?.agent_id!=='mnemuron-console'
      || i?.agent_instance_id!==this.binding.agent_instance_id||identity.scopes?.length!==3||!['console:read','memory:read','resume:read'].every(s=>identity.scopes.includes(s)))throw new BoundaryError(503,'CORE_IDENTITY_MISMATCH');
    if(view==='memory') {
      const {memory_id,...options}=params;
      if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(memory_id||'')||Object.keys(options).some(k=>!['content_offset','content_limit','source_offset','revision','source_version','include_history'].includes(k)))throw new BoundaryError(400,'INVALID_DETAIL_REQUEST');
      return this.request(`/v1/memories/${encodeURIComponent(memory_id)}?${new URLSearchParams(options)}`);
    }
    if(!['overview','memories','summaries','summary','jobs','storage','connections','audit'].includes(view))throw new BoundaryError(404,'NOT_FOUND');
    return this.request(`/v1/console/${view}?${new URLSearchParams(params)}`);
  }
}

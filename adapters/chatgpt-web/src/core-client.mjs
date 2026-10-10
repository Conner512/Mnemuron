import { BoundaryError, fetchJson, readPrivate, CORE_SCOPES, MEMORY_WRITE_CORE_SCOPES } from "../../../shared/oauth-common.mjs";
// Core reports which read policy it enforces for this credential; anything else fails closed.
export const WEB_READ_POLICIES=Object.freeze(['web-memory-visibility-v1','web-memory-active-uniform-v1']);

export class ReadonlyCoreClient {
  constructor(config, writeBinding=null) {
    this.config = config;
    this.writeBinding=writeBinding;
    this.token = readPrivate(config.core.credential_file);
    if (!/^mnm_[A-Za-z0-9_-]+$/.test(this.token)) throw new Error("Invalid core credential file");
  }
  async request(route, body, { method = body === undefined ? "GET" : "POST" } = {}) {
    const c = this.config.core;
    const allowed = (method === "GET" && (route === "/v1/identity" || route === "/readyz/search"
      || /^\/v1\/memories\/[A-Za-z0-9_.:-]+(?:\?[^#]*)?$/.test(route)))
      || (method === "POST" && ["/v1/memories/query", "/v1/project-context/preview", "/v1/memory-summaries/query"].includes(route))
      || (this.writeBinding && ((method==='POST' && route==='/v1/cloud-memory/operations')
        || (method==='GET' && /^\/v1\/cloud-memory\/operations\/[A-Za-z0-9_.:-]+\?connection_id=[a-f0-9]{64}$/.test(route))));
    if (!allowed) throw new BoundaryError(403, "CORE_ROUTE_DENIED");
    let result;
    try {
      result = await fetchJson(`${c.base_url}${route}`, { method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, { timeoutMs: c.timeout_ms, maxBytes: c.max_response_bytes });
    } catch { throw new BoundaryError(503, body && route==='/v1/cloud-memory/operations'?'OPERATION_STATUS_UNKNOWN':'CORE_UNAVAILABLE'); }
    if(route.startsWith('/v1/cloud-memory/operations') && result.status!==200){
      const codes=new Set(['IDEMPOTENCY_CONFLICT','MEMORY_VERSION_CHANGED','MEMORY_NOT_FOUND','OPERATION_NOT_FOUND','INVALID_CLOUD_OPERATION','CLOUD_READ_POLICY_DENIED','CLOUD_MEMORY_DISABLED','OPERATION_RESULT_TOO_LARGE']);
      if(codes.has(result.data?.error_code))throw new BoundaryError(result.status,result.data.error_code);
      if(result.status===400)throw new BoundaryError(400,'INVALID_CORE_QUERY');
      if(result.status>=500 && body)throw new BoundaryError(503,'OPERATION_STATUS_UNKNOWN');
    }
    // A project the owner deleted: not an outage and not worth retrying. One non-retryable code for reads and writes
    // (it does not name the lifecycle state; other accounts get Core's generic not found for unknown IDs).
    if (result.status === 409 && result.data?.error_code === 'PROJECT_DELETED') throw new BoundaryError(409, 'PROJECT_UNAVAILABLE');
    if ([401, 403].includes(result.status)) throw new BoundaryError(503, "CORE_AUTH_UNAVAILABLE");
    if (result.status === 503 && ["SEARCH_UNAVAILABLE", "SEARCH_RETRYABLE", "SEMANTIC_UNAVAILABLE"].includes(result.data.error_code)) {
      const error=new BoundaryError(503, result.data.error_code);
      if(['EGRESS_DENIED','BUDGET_EXHAUSTED','VECTOR_NOT_READY','VECTOR_DISABLED','VECTOR_STALE','RELEVANCE_NOT_CONFIGURED','AUTH_FAILED','NOT_CONFIGURED','VECTOR_UNAVAILABLE'].includes(result.data.degradation_code))error.degradation_code=result.data.degradation_code;
      throw error;
    }
    if (result.status === 409 && result.data.error_code === 'TASK_VERSION_CHANGED') throw new BoundaryError(409, 'TASK_VERSION_CHANGED');
    if(result.status===409 && ['MEMORY_VERSION_CHANGED','SOURCE_MANIFEST_CHANGED','SUMMARY_VERSION_CHANGED','CURSOR_EXPIRED'].includes(result.data.error_code))throw new BoundaryError(409,result.data.error_code);
    if(result.status===400 && result.data.error_code==='INVALID_CURSOR')throw new BoundaryError(400,'INVALID_CURSOR');
    if(result.status===422 && ['SUMMARY_DETAIL_TOO_LARGE','DETAIL_METADATA_TOO_LARGE'].includes(result.data.error_code))throw new BoundaryError(422,result.data.error_code);
    if (result.status === 422 && result.data.error_code === 'TASK_DETAIL_TOO_LARGE') throw new BoundaryError(422, 'TASK_DETAIL_TOO_LARGE');
    if (result.status === 404) throw new BoundaryError(404, result.data.error_code === 'TASK_CONTEXT_NOT_FOUND' ? 'TASK_CONTEXT_NOT_FOUND' : 'MEMORY_NOT_FOUND');
    if (result.status === 400) throw new BoundaryError(400, "INVALID_CORE_QUERY");
    if (result.status !== 200) throw new BoundaryError(503, "CORE_UNAVAILABLE");
    return result.data;
  }
  async checkIdentity(mapping) {
    const result = await this.request("/v1/identity");
    const identity = result.identity;
    const expected=this.writeBinding?{...mapping,...this.writeBinding}:mapping;
    const scopes=this.writeBinding?MEMORY_WRITE_CORE_SCOPES:CORE_SCOPES;
    if (!identity || identity.user_id !== mapping.mnemuron_user_id
      || (expected.credential_id && identity.credential_id!==expected.credential_id)
      || identity.agent_instance_id !== expected.agent_instance_id || identity.identity_status !== "server_verified"
      || identity.agent_id!=='chatgpt-web' || !WEB_READ_POLICIES.includes(identity.web_read_policy)
      || !Array.isArray(result.scopes) || result.scopes.length !== scopes.length
      || !scopes.every((scope) => result.scopes.includes(scope))) throw new BoundaryError(503, "CORE_AUTH_UNAVAILABLE");
    if(this.writeBinding){
      const b=identity.cloud_memory;
      if(!b?.enabled||b.connection_id!==expected.connection_id||b.account_id!==expected.account_id||b.security_version!==expected.security_version
        ||Boolean(b.allow_submitted_revision_grant)!==expected.allow_submitted_revision_grant)throw new BoundaryError(503,'CORE_AUTH_UNAVAILABLE');
    }
    return result;
  }
  async ready(mapping) {
    await this.checkIdentity(mapping);
    const result = await this.request("/readyz/search");
    if (result.ready !== true || result.component !== "memory_search") throw new BoundaryError(503, "SEARCH_UNAVAILABLE");
  }
  async call(name, args, mapping) {
    const identity=await this.checkIdentity(mapping);
    switch (name) {
      case 'mnemuron_save_memory':
      case 'mnemuron_supersede_memory':
      case 'mnemuron_retract_memory': {
        if(!this.writeBinding)throw new BoundaryError(403,'CORE_ROUTE_DENIED');
        const {operation_id,...payload}=args;
        const action={'mnemuron_save_memory':'memory.save','mnemuron_supersede_memory':'memory.supersede','mnemuron_retract_memory':'memory.retract'}[name];
        return this.request('/v1/cloud-memory/operations',{connection_id:this.writeBinding.connection_id,action,operation_id,payload});
      }
      case 'mnemuron_get_operation': {
        if(!this.writeBinding)throw new BoundaryError(403,'CORE_ROUTE_DENIED');
        return this.request(`/v1/cloud-memory/operations/${encodeURIComponent(args.operation_id)}?connection_id=${this.writeBinding.connection_id}`);
      }
      case "mnemuron_search_memories": {
        // A new account does not inherit the legacy owner's paid model allocation.
        if(this.config.identity_mode!=='multi_account_v1')return this.request('/v1/memories/query',args);
        // This flag is self-scoped Core metadata, not a tool argument. Pin the allocation
        // guard so a model removed between identity/read cannot fall back to a shared key.
        const mode=args.mode||identity?.personal_retrieval?.default_mode||'hybrid';
        if(identity?.personal_retrieval?.configured===true)return this.request('/v1/memories/query',{...args,mode,personal_model_only:true});
        if(mode==='semantic')throw Object.assign(new BoundaryError(503,'SEMANTIC_UNAVAILABLE'),{degradation_code:'NOT_CONFIGURED'});
        const result=await this.request('/v1/memories/query',{...args,mode:'lexical'});
        if(mode==='hybrid')result.retrieval={...result.retrieval,mode:'hybrid',requested_mode:'hybrid',effective_mode:'lexical',degraded:true,fallback:'lexical',degradation_code:'NOT_CONFIGURED'};
        return result;
      }
      case "mnemuron_get_summary": return this.request("/v1/memory-summaries/query", args);
      case "mnemuron_get_memory": {
        const { memory_id, ...options } = args;
        const query = new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]));
        return this.request(`/v1/memories/${encodeURIComponent(memory_id)}?${query}`);
      }
      case "mnemuron_preview_project_context": return this.request("/v1/project-context/preview", args);
      default: throw new BoundaryError(403, "CORE_ROUTE_DENIED");
    }
  }
}

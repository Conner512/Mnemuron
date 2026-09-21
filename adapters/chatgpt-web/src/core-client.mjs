import { BoundaryError, fetchJson, readPrivate, CORE_SCOPES } from "../../../shared/oauth-common.mjs";

export class ReadonlyCoreClient {
  constructor(config) {
    this.config = config;
    this.token = readPrivate(config.core.credential_file);
    if (!/^mnm_[A-Za-z0-9_-]+$/.test(this.token)) throw new Error("Invalid core credential file");
  }
  async request(route, body, { method = body === undefined ? "GET" : "POST" } = {}) {
    const c = this.config.core;
    const allowed = (method === "GET" && (route === "/v1/identity" || route === "/readyz/search"
      || /^\/v1\/memories\/[A-Za-z0-9_.:-]+(?:\?[^#]*)?$/.test(route)))
      || (method === "POST" && ["/v1/memories/query", "/v1/project-context/preview", "/v1/memory-summaries/query"].includes(route));
    if (!allowed) throw new BoundaryError(403, "CORE_ROUTE_DENIED");
    let result;
    try {
      result = await fetchJson(`${c.base_url}${route}`, { method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, { timeoutMs: c.timeout_ms, maxBytes: c.max_response_bytes });
    } catch { throw new BoundaryError(503, "CORE_UNAVAILABLE"); }
    if ([401, 403].includes(result.status)) throw new BoundaryError(503, "CORE_AUTH_UNAVAILABLE");
    if (result.status === 503 && ["SEARCH_UNAVAILABLE", "SEARCH_RETRYABLE", "SEMANTIC_UNAVAILABLE"].includes(result.data.error_code)) {
      const error=new BoundaryError(503, result.data.error_code);
      if(['EGRESS_DENIED','BUDGET_EXHAUSTED','VECTOR_NOT_READY','VECTOR_DISABLED','VECTOR_STALE','AUTH_FAILED','NOT_CONFIGURED','VECTOR_UNAVAILABLE'].includes(result.data.degradation_code))error.degradation_code=result.data.degradation_code;
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
    if (!identity || identity.user_id !== mapping.mnemuron_user_id
      || (mapping.credential_id && identity.credential_id!==mapping.credential_id)
      || identity.agent_instance_id !== mapping.agent_instance_id || identity.identity_status !== "server_verified"
      || identity.agent_id!=='chatgpt-web' || identity.web_read_policy!=='web-memory-visibility-v1'
      || !Array.isArray(result.scopes) || result.scopes.length !== CORE_SCOPES.length
      || !CORE_SCOPES.every((scope) => result.scopes.includes(scope))) throw new BoundaryError(503, "CORE_AUTH_UNAVAILABLE");
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
      case "mnemuron_search_memories": {
        // A new account does not inherit the legacy owner's paid model allocation.
        if(this.config.identity_mode!=='multi_account_v1')return this.request('/v1/memories/query',args);
        // This flag is self-scoped Core metadata, not a tool argument. Pin the allocation
        // guard so a model removed between identity/read cannot fall back to a shared key.
        if(identity?.personal_retrieval?.configured===true)return this.request('/v1/memories/query',{...args,mode:args.mode||'lexical',personal_model_only:true});
        if(args.mode==='semantic')throw Object.assign(new BoundaryError(503,'SEMANTIC_UNAVAILABLE'),{degradation_code:'NOT_CONFIGURED'});
        const result=await this.request('/v1/memories/query',{...args,mode:'lexical'});
        if(args.mode==='hybrid')result.retrieval={...result.retrieval,mode:'hybrid',requested_mode:'hybrid',effective_mode:'lexical',degraded:true,fallback:'lexical',degradation_code:'NOT_CONFIGURED'};
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

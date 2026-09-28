import { BoundaryError, readSecret, seconds, secretHash, oauthScopesFor } from "../../../shared/oauth-common.mjs";
import { loadIdentityMappings } from "./config.mjs";
import { fetchAuthorizationJson } from "./auth-transport.mjs";

export class GatewayAuthorization {
  constructor(config) {
    this.config = config;
    this.secret = readSecret(config.introspection.client_secret_file);
    loadIdentityMappings(config);
  }
  async metadata() {
    const c = this.config;
    try {
      const { status, data } = await fetchAuthorizationJson(c, c.authorization_server_metadata_url);
      if (status !== 200 || data.issuer !== c.issuer || data.introspection_endpoint !== c.introspection.endpoint
        || data.authorization_endpoint !== `${c.issuer}/authorize` || data.token_endpoint !== `${c.issuer}/token`
        || !data.code_challenge_methods_supported?.includes("S256") || data.mnemuron_mode === "bootstrap_metadata_only") {
        throw new Error("Authorization metadata mismatch");
      }
      return true;
    } catch { throw new BoundaryError(503, "AUTH_DEPENDENCY_UNAVAILABLE"); }
  }
  async verify(request,{generic=false}={}) {
    const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9._~-]{16,4096})$/);
    if (!bearer) throw new BoundaryError(401, "AUTH_REQUIRED");
    await this.metadata();
    const c = this.config;
    let result;
    try {
      result = await fetchAuthorizationJson(c, c.introspection.endpoint, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${c.introspection.client_id}:${this.secret}`).toString("base64")}` },
        body: new URLSearchParams({ token: bearer[1], token_type_hint: "access_token",resource:c.resource+(generic?'/generic':'') }).toString(),
      });
    } catch { throw new BoundaryError(503, "AUTH_DEPENDENCY_UNAVAILABLE"); }
    const data = result.data;
    if (result.status !== 200 || !data || typeof data !== "object" || Array.isArray(data) || typeof data.active !== "boolean") {
      throw new BoundaryError(503, "AUTH_DEPENDENCY_UNAVAILABLE");
    }
    if (!data.active) throw new BoundaryError(401, "INVALID_TOKEN");
    if (!Number.isInteger(data.exp) || typeof data.client_id !== "string" || typeof data.sub !== "string"
      || typeof data.scope !== "string" || typeof data.aud !== "string"
      || (data.nbf !== undefined && !Number.isInteger(data.nbf))) throw new BoundaryError(503, "AUTH_DEPENDENCY_UNAVAILABLE");
    if (data.exp <= seconds() || (data.nbf !== undefined && data.nbf > seconds())
      || data.aud !== c.resource+(generic?'/generic':'') || (data.iss !== undefined && data.iss !== c.issuer)
      || data.token_kind !== (generic?'connection_pat':'access_token')
      || data.token_type !== "Bearer") throw new BoundaryError(401, "INVALID_TOKEN");
    const registered=c.connection_management===true&&typeof data.connection_id==='string';
    if(!registered&&(generic||data.client_id!==c.introspection.expected_oauth_client_id))throw new BoundaryError(401,'INVALID_TOKEN');
    let mapping;
    try { mapping = loadIdentityMappings(c).find(item=>item.subject===data.sub && item.issuer===c.issuer); } catch { throw new BoundaryError(503, "IDENTITY_CONFIGURATION_UNAVAILABLE"); }
    if (!mapping?.enabled || (c.identity_mode==='multi_account_v1' && (data.account_id!==mapping.account_id || data.security_version!==mapping.security_version))) throw new BoundaryError(403, "SUBJECT_DENIED");
    const scopes=new Set(data.scope.split(' ').filter(Boolean));
    if([...scopes].some(s=>!oauthScopesFor(c).includes(s)))throw new BoundaryError(403,'SCOPE_DENIED');
    let connection_id=secretHash(JSON.stringify([c.issuer,data.client_id,data.sub]));
    if(registered){
      const b=mapping.connections?.find(b=>b.connection_id===data.connection_id&&b.client_id===data.client_id&&b.connection_version===data.connection_version&&b.profile===data.connection_profile);
      if(!b||data.iss!==c.issuer||[...scopes].some(s=>!['openid','offline_access','memory:read',...(b.profile==='memory_readwrite'?['memory:write']:[])].includes(s)))throw new BoundaryError(403,'CONNECTION_DENIED');
      connection_id=b.connection_id;mapping={...mapping,credential_file:b.credential_file,credential_id:b.credential_id,agent_instance_id:b.agent_instance_id,cloud_write:b.profile==='memory_readwrite'?b:undefined};
    }
    if(mapping.cloud_write && mapping.cloud_write.connection_id!==connection_id)throw new BoundaryError(503,'IDENTITY_CONFIGURATION_UNAVAILABLE');
    return Object.freeze({mapping,scopes,connection_id,registered,generic,token_id:data.token_id,connection_version:data.connection_version,profile:data.connection_profile,
      allow_submitted_revision_grant:data.cloud_submitted_revision_grant===true && c.cloud_memory?.allow_submitted_revision_grant===true});
  }
  async recordUse(request,{generic=false,failed=false}={}){
    const bearer=request.headers.authorization?.match(/^Bearer ([A-Za-z0-9._~-]{16,4096})$/);if(!bearer)return;
    const c=this.config;
    await fetchAuthorizationJson(c,c.introspection.endpoint,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded',authorization:`Basic ${Buffer.from(`${c.introspection.client_id}:${this.secret}`).toString('base64')}`},
      body:new URLSearchParams({token:bearer[1],resource:c.resource+(generic?'/generic':''),usage:failed?'memory_tool_failure':'memory_tool_success'}).toString()});
  }
}

export function requireScope(auth, scope) {
  if (!auth.scopes.has(scope)) {
    const error = new BoundaryError(403, "INSUFFICIENT_SCOPE");
    error.requiredScope = scope;
    throw error;
  }
}

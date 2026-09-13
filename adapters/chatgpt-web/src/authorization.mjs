import { BoundaryError, readSecret, seconds } from "../../../shared/oauth-common.mjs";
import { loadIdentityMap } from "./config.mjs";
import { fetchAuthorizationJson } from "./auth-transport.mjs";

export class GatewayAuthorization {
  constructor(config) {
    this.config = config;
    this.secret = readSecret(config.introspection.client_secret_file);
    loadIdentityMap(config);
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
  async verify(request) {
    const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9._~-]{16,4096})$/);
    if (!bearer) throw new BoundaryError(401, "AUTH_REQUIRED");
    await this.metadata();
    const c = this.config;
    let result;
    try {
      result = await fetchAuthorizationJson(c, c.introspection.endpoint, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${c.introspection.client_id}:${this.secret}`).toString("base64")}` },
        body: new URLSearchParams({ token: bearer[1], token_type_hint: "access_token" }).toString(),
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
      || data.aud !== c.resource || (data.iss !== undefined && data.iss !== c.issuer)
      || data.client_id !== c.introspection.expected_oauth_client_id || data.token_kind !== "access_token"
      || data.token_type !== "Bearer") throw new BoundaryError(401, "INVALID_TOKEN");
    let mapping;
    try { mapping = loadIdentityMap(c); } catch { throw new BoundaryError(503, "IDENTITY_CONFIGURATION_UNAVAILABLE"); }
    if (!mapping.enabled || data.sub !== mapping.subject) throw new BoundaryError(403, "SUBJECT_DENIED");
    return { mapping, scopes: new Set(data.scope.split(" ").filter(Boolean)) };
  }
}

export function requireScope(auth, scope) {
  if (!auth.scopes.has(scope)) {
    const error = new BoundaryError(403, "INSUFFICIENT_SCOPE");
    error.requiredScope = scope;
    throw error;
  }
}

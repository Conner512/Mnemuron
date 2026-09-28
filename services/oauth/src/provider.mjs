import { Provider, errors } from "oidc-provider";
import { seconds,oauthScopesFor,resourceScopesFor } from "../../../shared/oauth-common.mjs";

export function makeProvider(config, secrets, store, accounts) {
  const p = config.token_policy;
  const oauthScopes=oauthScopesFor(config),resourceScopes=resourceScopesFor(config);
  const personal=id=>accounts.connections?.clientRow(id);
  const accepted=(id,subject)=>id===config.chatgpt_client.client_id?accounts.eligible(subject):accounts.connections?.permitsClient(id,subject)===true;
  const provider = new Provider(config.issuer, {
    adapter: store.adapter(), jwks: secrets.jwks,
    clients: [
      { client_id: config.chatgpt_client.client_id, client_secret: secrets.clientSecret,
        token_endpoint_auth_method: "client_secret_post", redirect_uris: config.chatgpt_client.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
        scope: oauthScopes.join(" "), id_token_signed_response_alg: "RS256" },
      { client_id: config.introspection_client.client_id, client_secret: secrets.introspectionSecret,
        token_endpoint_auth_method: "client_secret_basic", redirect_uris: [], grant_types: [], response_types: [] },
    ],
    clientAuthMethods: ["client_secret_post", "client_secret_basic"],
    responseTypes: ["code"], scopes: oauthScopes, claims: { openid: ["sub"] },
    subjectTypes: ["public"], pkce: { required: () => true },
    allowOmittingSingleRegisteredRedirectUri: false,
    cookies: { keys: secrets.cookieKeys, names: { session: "mnm_session", interaction: "mnm_interaction", resume: "mnm_resume" },
      long: { secure: !config.isolated, httpOnly: true, sameSite: "lax" },
      short: { secure: !config.isolated, httpOnly: true, sameSite: "lax" } },
    routes: { authorization: "/authorize", token: "/token", introspection: "/introspect", revocation: "/revoke", jwks: "/jwks", userinfo: "/userinfo" },
    features: {
      devInteractions: { enabled: false }, registration: { enabled: false },
      clientCredentials: { enabled: false }, deviceFlow: { enabled: false },
      pushedAuthorizationRequests: { enabled: false }, requestObjects: { enabled: false },
      rpInitiatedLogout: { enabled: false }, dPoP: { enabled: false },
      claimsParameter: { enabled: false }, userinfo: { enabled: false },
      introspection: { enabled: true, allowedPolicy: async (_ctx, client, token) =>
        client.clientId === config.introspection_client.client_id && token.kind === "AccessToken"
        && token.aud === config.resource && accepted(token.clientId,token.accountId) },
      revocation: { enabled: true, allowedPolicy: async (_ctx, client, token) =>
        (client.clientId === config.chatgpt_client.client_id||!!personal(client.clientId)) && token.clientId === client.clientId },
      resourceIndicators: { enabled: true,
        defaultResource: () => { throw new errors.InvalidTarget("One explicit resource is required"); },
        useGrantedResource: () => true,
        getResourceServerInfo: async (_ctx, resource, client) => {
          const r=personal(client.clientId);
          if (resource !== config.resource || client.clientId !== config.chatgpt_client.client_id&&!accounts.connections?.client(client.clientId)) throw new errors.InvalidTarget();
          return { scope: (r?accounts.connections.scopes(r):resourceScopes).join(" "), audience: config.resource, accessTokenTTL: p.access_token_ttl_seconds, accessTokenFormat: "opaque" };
        },
      },
    },
    ttl: {
      AuthorizationCode: p.authorization_code_ttl_seconds, AccessToken: p.access_token_ttl_seconds,
      IdToken: p.access_token_ttl_seconds, Interaction: p.interaction_ttl_seconds,
      Session: p.login_session_ttl_seconds, Grant: p.refresh_absolute_ttl_seconds,
      RefreshToken: (_ctx, token) => {
        const remaining = p.refresh_absolute_ttl_seconds - (seconds() - token.iiat);
        if (remaining <= 0) throw new errors.InvalidGrant("Grant lifetime exceeded");
        return Math.min(p.refresh_idle_ttl_seconds, remaining);
      },
    },
    rotateRefreshToken: true, revokeGrantPolicy: () => true,
    extraTokenClaims: (_ctx, token) => token.kind === "AccessToken" ? { token_kind: "access_token",
      ...(String(token.scope||'').split(' ').includes('memory:write')?{cloud_submitted_revision_grant:config.cloud_memory?.allow_submitted_revision_grant===true}:{}),
      ...(accounts.principal?{account_id:accounts.principal(token.accountId).account_id,
        security_version:accounts.principal(token.accountId).security_version}:{}),
      ...(accounts.connections?.claims(token.clientId,token.accountId)||{}),
    } : undefined,
    findAccount: async (ctx, subject) => accounts.eligible(subject)&&(!personal(ctx?.oidc?.client?.clientId)||accepted(ctx.oidc.client.clientId,subject))
      ? { accountId: subject, claims: async () => ({ sub: subject }) } : undefined,
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    renderError: async (ctx) => { ctx.type = "html"; ctx.body = "<!doctype html><title>Authorization failed</title><h1>Authorization failed</h1><p>Return to the client and start a new authorization request.</p>"; },
  });
  provider.proxy = !config.isolated;
  // Keep discovery tied to the library's enabled endpoints; only endpoint-specific authentication metadata is added.
  provider.use(async (ctx, next) => {
    await next();
    if (ctx.path === "/.well-known/openid-configuration" && ctx.status === 200) {
      ctx.body.introspection_endpoint_auth_methods_supported = ["client_secret_basic"];
      ctx.body.revocation_endpoint_auth_methods_supported = ["client_secret_post"];
      ctx.body.token_endpoint_auth_methods_supported = ["client_secret_post"];
      ctx.body.response_modes_supported = ["query"];
    }
  });
  return provider;
}

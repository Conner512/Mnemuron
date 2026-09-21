import fs from "node:fs";
import { createPrivateKey } from "node:crypto";
import {
  canonicalUrl, exactList, boundedInteger, requireConfig, readPrivate, readSecret,
  OAUTH_SCOPES, RESOURCE_SCOPES, publicOriginMode,
} from "../../../shared/oauth-common.mjs";

export function validateAuthConfig(input, { isolated = false } = {}) {
  requireConfig(Number(process.versions.node.split(".")[0]) >= 24, "Node.js 24 or later");
  requireConfig(isolated || !!process.release.lts, "production requires a supported Node.js LTS runtime");
  requireConfig(isolated || (!process.env.DEBUG && !process.env.NODE_DEBUG), "protocol debug logging must be disabled");
  const c = structuredClone(input);
  requireConfig(c.config_version === "mnemuron-oauth-config-v1", "config_version");
  requireConfig(["oauth", "bootstrap_metadata_only"].includes(c.mode), "mode");
  canonicalUrl(c.issuer, { isolated, pathname: "/" });
  canonicalUrl(c.resource, { isolated, pathname: "/mcp" });
  c.public_origin_mode = publicOriginMode(c);
  requireConfig(c.listen?.host === "127.0.0.1", "loopback listener");
  boundedInteger(c.listen.port, null, 1, 65535, "port");
  if (isolated && c.public_origin_mode === "separate") requireConfig(new URL(c.issuer).port === String(c.listen.port), "fixture origin port");
  exactList(c.resource_scopes, RESOURCE_SCOPES, "resource_scopes");
  exactList(c.oidc_scopes, ["openid", "offline_access"], "oidc_scopes");
  requireConfig(c.client_registration?.dynamic === false && c.client_registration?.cimd === false, "static clients only");
  c.identity_mode ??= 'legacy_owner';
  requireConfig(['legacy_owner','multi_account_v1'].includes(c.identity_mode),'identity mode');
  if(c.identity_mode==='multi_account_v1') {
    requireConfig(typeof c.identity?.encryption_key_file==='string' && c.identity.encryption_key_file.startsWith('/'),'identity encryption key file');
    for(const [name,min,max] of [['invitation_batch_limit',1,1000],['console_session_ttl_seconds',60,28800]])
      if(c.identity[name]!==undefined) boundedInteger(c.identity[name],null,min,max,name);
    if(c.identity.core) canonicalUrl(c.identity.core.base_url,{isolated,loopbackHttp:true,pathname:'/'});
  }
  requireConfig(c.login?.mfa_required === true && (c.login.registration_enabled === false || c.identity_mode==='multi_account_v1' && c.login.registration_enabled===true)
    && c.login.development_interactions === false && c.login.cookie_secure === true
    && c.login.cookie_http_only === true && c.login.cookie_same_site === "lax", "login security policy");
  requireConfig(c.log?.include_tokens === false && c.log.include_request_body === false
    && c.log.include_querystring === false, "safe logging");
  const routes = { authorization: "/authorize", resume: "/authorize/:uid", token: "/token", jwks: "/jwks",
    revocation: "/revoke", introspection: "/introspect", userinfo: "/userinfo", interaction: "/interaction/:uid" };
  requireConfig(Object.keys(c.routes || {}).length === Object.keys(routes).length
    && Object.entries(routes).every(([key, value]) => c.routes[key] === value), "fixed routes");
  const client = c.chatgpt_client;
  requireConfig(/^[a-zA-Z0-9_-]{8,100}$/.test(client?.client_id || "")
    && client.token_endpoint_auth_method === "client_secret_post", "ChatGPT client");
  exactList(client.grant_types, ["authorization_code", "refresh_token"], "grant_types");
  exactList(client.response_types, ["code"], "response_types");
  exactList(client.allowed_scopes, OAUTH_SCOPES, "allowed_scopes");
  requireConfig(client.pkce?.required === true, "PKCE required");
  exactList(client.pkce.methods, ["S256"], "PKCE S256");
  const introspection = c.introspection_client;
  requireConfig(/^[a-zA-Z0-9_-]{8,100}$/.test(introspection?.client_id || "")
    && introspection.client_id !== client.client_id && introspection.auth_method === "client_secret_basic"
    && introspection.role === "resource_server_only" && introspection.allowed_resource === c.resource
    && introspection.allowed_token_kind === "access_token" && introspection.allow_user_authorization === false
    && introspection.allow_token_issuance === false, "introspection client isolation");
  const p = c.token_policy;
  requireConfig(p?.access_token_format === "opaque" && p.refresh_rotation === true
    && p.refresh_reuse_revokes_grant === true, "token policy");
  for (const [name, min, max] of [
    ["authorization_code_ttl_seconds", 1, 60], ["access_token_ttl_seconds", 1, 300],
    ["refresh_idle_ttl_seconds", 60, 604800], ["refresh_absolute_ttl_seconds", 60, 2592000],
    ["interaction_ttl_seconds", 60, 600], ["login_session_ttl_seconds", 60, 28800],
  ]) boundedInteger(p[name], null, min, max, name);
  requireConfig(p.refresh_idle_ttl_seconds <= p.refresh_absolute_ttl_seconds, "refresh lifetime");
  c.limits ||= {};
  for (const [name, fallback, max] of [
    ["login_attempts_per_account_per_15min", 10, 20], ["token_requests_per_client_per_minute", 60, 120],
    ["introspection_requests_per_client_per_minute", 600, 1200], ["request_body_bytes", 65536, 65536],
  ]) c.limits[name] = boundedInteger(c.limits[name], fallback, 1, max, name);
  requireConfig(c.reverse_proxy?.allowed_host === new URL(c.issuer).host
    && c.reverse_proxy.public_scheme === "https" && c.reverse_proxy.trust_unvalidated_forwarded_headers === false,
  "fixed proxy identity");
  exactList(c.reverse_proxy.trusted_peer_addresses, ["127.0.0.1", "::1"], "trusted peers");
  if (c.mode === "oauth") {
    requireConfig(Array.isArray(client.redirect_uris) && client.redirect_uris.length === 1, "one exact callback");
    const callback = canonicalUrl(client.redirect_uris[0], { isolated });
    requireConfig(isolated || (callback.protocol === "https:" && callback.hostname === "chatgpt.com"
      && (callback.pathname === "/connector_platform_oauth_redirect"
        || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(callback.pathname))), "exact ChatGPT callback");
    for (const key of ["database_file", "private_jwks_file", "cookie_keys_file", ...(c.identity_mode==='legacy_owner' ? ['accounts_file'] : [])]) {
      requireConfig(typeof c[key] === "string" && c[key].startsWith("/"), key);
    }
  }
  return { ...c, isolated };
}

export function loadAuthConfig(file, options) {
  return validateAuthConfig(JSON.parse(fs.readFileSync(file, "utf8")), options);
}

export function loadAuthSecrets(config) {
  const jwks = readPrivate(config.private_jwks_file, { json: true });
  requireConfig(Array.isArray(jwks.keys) && jwks.keys.length >= 1 && jwks.keys.length <= 3, "private JWKS");
  for (const jwk of jwks.keys) {
    const key = createPrivateKey({ key: jwk, format: "jwk" });
    requireConfig(jwk.kty === "RSA" && jwk.alg === "RS256" && jwk.use === "sig" && !!jwk.kid
      && key.asymmetricKeyDetails.modulusLength >= 2048, "RS256 signing key");
  }
  const cookieKeys = readPrivate(config.cookie_keys_file, { json: true });
  requireConfig(Array.isArray(cookieKeys) && cookieKeys.length >= 2
    && cookieKeys.every((key) => /^[A-Za-z0-9_-]{43,256}$/.test(key)), "cookie keys");
  const clientSecret = readSecret(config.chatgpt_client.client_secret_file);
  const introspectionSecret = readSecret(config.introspection_client.client_secret_file);
  requireConfig(clientSecret !== introspectionSecret && !cookieKeys.includes(clientSecret)
    && !cookieKeys.includes(introspectionSecret), "credential separation");
  return { jwks, cookieKeys, clientSecret, introspectionSecret };
}

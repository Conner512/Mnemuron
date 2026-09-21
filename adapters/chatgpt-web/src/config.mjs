import fs from "node:fs";
import { canonicalUrl, exactList, boundedInteger, requireConfig, readPrivate, OAUTH_SCOPES, CORE_SCOPES, publicOriginMode } from "../../../shared/oauth-common.mjs";

export function validateGatewayConfig(input, { isolated = false } = {}) {
  requireConfig(Number(process.versions.node.split(".")[0]) >= 24, "Node.js 24 or later");
  requireConfig(isolated || !!process.release.lts, "production requires a supported Node.js LTS runtime");
  requireConfig(isolated || (!process.env.DEBUG && !process.env.NODE_DEBUG), "protocol debug logging must be disabled");
  const c = structuredClone(input);
  requireConfig(c.config_version === "mnemuron-web-gateway-config-v1", "config_version");
  requireConfig(["oauth", "bootstrap_metadata_only"].includes(c.mode), "mode");
  requireConfig(["auth_only", "readonly"].includes(c.tool_profile), "tool_profile");
  c.identity_mode ??= 'legacy_owner';
  requireConfig(['legacy_owner','multi_account_v1'].includes(c.identity_mode),'identity mode');
  canonicalUrl(c.issuer, { isolated, pathname: "/" });
  canonicalUrl(c.resource, { isolated, pathname: "/mcp" });
  c.public_origin_mode = publicOriginMode(c);
  requireConfig(c.listen?.host === "127.0.0.1", "loopback listener");
  boundedInteger(c.listen.port, null, 1, 65535, "port");
  if (isolated && c.public_origin_mode === "separate") requireConfig(new URL(c.resource).port === String(c.listen.port), "fixture origin port");
  requireConfig(c.authorization_server_metadata_url === `${c.issuer}/.well-known/oauth-authorization-server`, "fixed metadata URL");
  c.authorization_server_transport ??= { mode: "issuer_url" };
  const transport = c.authorization_server_transport;
  requireConfig(transport && ["issuer_url", "loopback_http"].includes(transport.mode), "authorization server transport");
  exactList(Object.keys(transport), transport.mode === "issuer_url" ? ["mode"] : ["mode", "host", "port"], "authorization transport fields");
  if (transport.mode === "loopback_http") {
    requireConfig(transport.host === "127.0.0.1", "authorization transport must use literal IPv4 loopback");
    boundedInteger(transport.port, null, 1, 65535, "authorization transport port");
    requireConfig(transport.port !== c.listen.port, "authorization transport must not target the gateway");
  }
  requireConfig(c.protected_resource_metadata_path === "/.well-known/oauth-protected-resource/mcp"
    && c.root_metadata_alias === true, "protected metadata routes");
  exactList(c.requested_scopes, OAUTH_SCOPES, "requested scopes");
  const i = c.introspection;
  requireConfig(i?.endpoint === `${c.issuer}/introspect` && i.auth_method === "client_secret_basic"
    && i.accepted_token_kind === "access_token" && i.active_cache_seconds === 0 && i.follow_redirects === false,
  "introspection policy");
  requireConfig(/^[a-zA-Z0-9_-]{8,100}$/.test(i.client_id || "")
    && /^[a-zA-Z0-9_-]{8,100}$/.test(i.expected_oauth_client_id || "") && i.client_id !== i.expected_oauth_client_id,
  "separate clients");
  i.timeout_ms = boundedInteger(i.timeout_ms, 5000, 50, 10000, "introspection timeout");
  i.max_response_bytes = boundedInteger(i.max_response_bytes, 65536, 1024, 65536, "introspection response budget");
  c.limits ||= {};
  for (const [key, fallback, min, max] of [
    ["request_body_bytes", 65536, 1024, 65536], ["tool_response_bytes", 131072, 1024, 131072],
    ["concurrent_requests_per_subject", 4, 1, 4], ["requests_per_subject_per_minute", 120, 1, 120],
  ]) c.limits[key] = boundedInteger(c.limits[key], fallback, min, max, key);
  requireConfig(c.reverse_proxy?.allowed_host === new URL(c.resource).host && c.reverse_proxy.public_scheme === "https"
    && c.reverse_proxy.trust_unvalidated_forwarded_headers === false, "fixed proxy identity");
  exactList(c.reverse_proxy.trusted_peer_addresses, ["127.0.0.1", "::1"], "trusted peers");
  requireConfig(c.logging?.include_tokens === false && c.logging.include_memory_content === false
    && c.logging.include_request_body === false, "safe logging");
  const tools = { mnemuron_auth_status: "memory:read", mnemuron_search_memories: "memory:read",
    mnemuron_get_memory: "memory:read", mnemuron_preview_project_context: "project:read" };
  if(c.tools?.mnemuron_get_summary)tools.mnemuron_get_summary='memory:read';
  requireConfig(Object.keys(c.tools || {}).length === Object.keys(tools).length && Object.entries(tools).every(([name, scope]) => c.tools[name]?.required_scope === scope), "fixed tool scopes");
  for (const name of Object.keys(tools)) exactList(c.tools[name].profile,
    name === "mnemuron_auth_status" ? ["auth_only", "readonly"] : ["readonly"], "fixed tool profiles");
  if (c.mode === "oauth" && c.tool_profile === "readonly") {
    canonicalUrl(c.core?.base_url, { isolated, loopbackHttp: true, pathname: "/" });
    requireConfig(c.core.allow_plain_http_loopback_only === true && c.core.follow_redirects === false
      && c.core.search_readiness_contract === "GET /readyz/search", "core readiness contract");
    exactList(c.core.required_internal_scopes, CORE_SCOPES, "read-only core scopes");
    c.core.timeout_ms = boundedInteger(c.core.timeout_ms, 5000, 50, 10000, "core timeout");
    c.core.max_response_bytes = boundedInteger(c.core.max_response_bytes, 262144, 1024, 262144, "core response budget");
  }
  return { ...c, isolated };
}

export function loadGatewayConfig(file, options) {
  return validateGatewayConfig(JSON.parse(fs.readFileSync(file, "utf8")), options);
}

export function loadIdentityMap(config) {
  const mappings=loadIdentityMappings(config);
  requireConfig(mappings.length===1,'single mapping required by legacy operator command');
  return mappings[0];
}

export function loadIdentityMappings(config) {
  const data = readPrivate(config.identity_map_file, { json: true });
  requireConfig(data.unknown_subject_policy === "deny" && Array.isArray(data.mappings)
    && (config.identity_mode==='multi_account_v1' || data.mappings.length===1), "identity map");
  const subjects=new Set(),users=new Set(),credentials=new Set();
  for(const mapping of data.mappings) {
  requireConfig(mapping.issuer === config.issuer && typeof mapping.subject === "string"
    && /^[A-Za-z0-9_-]{16,128}$/.test(mapping.subject) && !mapping.subject.includes("__REQUIRED")
    && typeof mapping.enabled === "boolean", "immutable mapped subject");
  if (config.tool_profile === "readonly") {
    for (const key of ["mnemuron_user_id", "agent_instance_id"]) {
      requireConfig(typeof mapping[key] === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(mapping[key])
        && !mapping[key].includes("__REQUIRED"), `mapped ${key}`);
    }
  }
  requireConfig(!subjects.has(mapping.subject),'duplicate subject');subjects.add(mapping.subject);
  if(config.identity_mode==='multi_account_v1') {
    requireConfig(typeof mapping.account_id==='string' && Number.isSafeInteger(mapping.security_version) && mapping.security_version>0,'account mapping version');
    requireConfig(!users.has(mapping.mnemuron_user_id),'duplicate owner binding');users.add(mapping.mnemuron_user_id);
    if(config.tool_profile==='readonly') {
      requireConfig(typeof mapping.credential_file==='string' && mapping.credential_file.startsWith('/') && typeof mapping.credential_id==='string','per-account credential');
      const credential=readPrivate(mapping.credential_file);
      requireConfig(!credentials.has(credential),'shared credential forbidden');credentials.add(credential);
    }
  }
  }
  return data.mappings.map(mapping=>Object.freeze(mapping));
}

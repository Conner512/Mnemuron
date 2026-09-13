import path from "node:path";
import { fixture, listen, close, freePort } from "../../../services/oauth/test/fixture.mjs";
import { testIngress } from "../../../services/oauth/test/ingress.mjs";
import { writePrivate } from "../../../shared/oauth-common.mjs";
import { createGateway } from "../src/server.mjs";

export function approveWebMemory(core,...memories) {
  for(const memory of memories) {
    const {revision,state_hash}=core.store.revisions.latest(core.a.auth.user_id,memory.memory_id);
    core.store.webVisibility.set(core.a.auth,memory.memory_id,{allow:true,revision,state_hash});
  }
}

export async function gatewayFixture(t, { profile = "auth_only", coreFixture, mutate = () => {}, sharedOrigin = false, loopbackAuth = false, authMutate = () => {} } = {}) {
  const ingressPort = sharedOrigin ? await freePort() : undefined;
  const f = await fixture(t, { mutate: (config) => {
    if (sharedOrigin) {
      config.public_origin_mode = "shared";
      config.issuer = "http://127.0.0.1:" + ingressPort;
      config.resource = config.issuer + "/mcp";
      config.introspection_client.allowed_resource = config.resource;
      config.reverse_proxy.allowed_host = new URL(config.issuer).host;
    }
    authMutate(config);
  } });
  const config = { config_version: "mnemuron-web-gateway-config-v1", mode: "oauth", tool_profile: profile,
    public_origin_mode: f.config.public_origin_mode,
    listen: { host: "127.0.0.1", port: f.ports.gatewayPort }, issuer: f.config.issuer, resource: f.config.resource,
    protected_resource_metadata_path: "/.well-known/oauth-protected-resource/mcp", root_metadata_alias: true,
    authorization_server_metadata_url: `${f.config.issuer}/.well-known/oauth-authorization-server`,
    introspection: { endpoint: `${f.config.issuer}/introspect`, client_id: f.config.introspection_client.client_id,
      client_secret_file: path.join(f.directory, "gateway-introspection-secret"), auth_method: "client_secret_basic",
      expected_oauth_client_id: f.config.chatgpt_client.client_id, accepted_token_kind: "access_token", active_cache_seconds: 0,
      timeout_ms: 1000, max_response_bytes: 65536, follow_redirects: false },
    identity_map_file: path.join(f.directory, "identity-map.json"), requested_scopes: f.config.chatgpt_client.allowed_scopes,
    core: { base_url: coreFixture?.baseUrl, credential_file: path.join(f.directory, "core-token"), required_internal_scopes: ["memory:read", "resume:read"],
      allow_plain_http_loopback_only: true, search_readiness_contract: "GET /readyz/search", timeout_ms: 1000, max_response_bytes: 262144, follow_redirects: false },
    tools: { mnemuron_auth_status: { required_scope: "memory:read", profile: ["auth_only", "readonly"] },
      mnemuron_search_memories: { required_scope: "memory:read", profile: ["readonly"] },
      mnemuron_get_memory: { required_scope: "memory:read", profile: ["readonly"] },
      mnemuron_preview_project_context: { required_scope: "project:read", profile: ["readonly"] } },
    limits: { request_body_bytes: 65536, tool_response_bytes: 131072, concurrent_requests_per_subject: 4, requests_per_subject_per_minute: 120 },
    reverse_proxy: { trusted_peer_addresses: ["127.0.0.1", "::1"], allowed_host: `127.0.0.1:${f.ports.gatewayPort}`, public_scheme: "https", trust_unvalidated_forwarded_headers: false },
    logging: { include_tokens: false, include_memory_content: false, include_request_body: false } };
  writePrivate(config.introspection.client_secret_file, f.introspectionSecret);
  const map = { unknown_subject_policy: "deny", mappings: [{ issuer: config.issuer, subject: f.subject, enabled: true,
    mnemuron_user_id: coreFixture?.a.auth.user_id || "synthetic-owner", agent_instance_id: "synthetic-web-readonly" }] };
  writePrivate(config.identity_map_file, map);
  if (coreFixture) {
    const credential = coreFixture.store.issueCredential({ userId: coreFixture.a.auth.user_id, deviceId: "synthetic-web",
      agentId: "chatgpt-web", agentInstanceId: "synthetic-web-readonly", scopes: ["memory:read", "resume:read"] });
    f.coreCredential = credential;
    writePrivate(config.core.credential_file, credential.api_key);
  }
  if (loopbackAuth) config.authorization_server_transport = { mode: "loopback_http", host: "127.0.0.1", port: f.ports.authPort };
  mutate(config);
  if (sharedOrigin) config.reverse_proxy.allowed_host = new URL(config.resource).host;
  const logs = [];
  const gateway = createGateway(config, { isolated: true, logger: (event) => logs.push(event) });
  await listen(gateway.server, f.ports.gatewayPort);
  t.after(async () => { await close(gateway.server); });
  if (sharedOrigin) {
    f.ingress = testIngress(config.issuer, f.ports);
    await listen(f.ingress, ingressPort);
    t.after(() => close(f.ingress));
  }
  f.gateway = gateway; f.gatewayConfig = config; f.gatewayLogs = logs; f.identityMap = map;
  f.mcp = async (method, params, token, { headers = {}, notification = false } = {}) => {
    const response = await fetch(config.resource, { method: "POST", headers: { "content-type": "application/json",
      accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: 1 }), method, ...(params === undefined ? {} : { params }) }) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null };
  };
  return f;
}

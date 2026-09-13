import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { gatewayFixture } from "./fixture.mjs";
import { Browser } from "../../../services/oauth/test/fixture.mjs";
import { validateAuthConfig } from "../../../services/oauth/src/config.mjs";
import { validateGatewayConfig } from "../src/config.mjs";
import { memoryFixture, businessSnapshot } from "../../../server/test/helpers/core-memory-fixture.mjs";
import { randomSecret } from "../../../shared/oauth-common.mjs";

test("SHARED-01 shared origin is explicit; origin/resource/Host and loopback restrictions remain enforced", async (t) => {
  const f = await gatewayFixture(t, { sharedOrigin: true });
  for (const [config, validate] of [[f.config, validateAuthConfig], [f.gatewayConfig, validateGatewayConfig]]) {
    assert.equal(validate(config, { isolated: true }).public_origin_mode, "shared");
    for (const mutate of [
      c => { delete c.public_origin_mode; },
      c => { c.public_origin_mode = "separate"; },
      c => { c.public_origin_mode = "anything"; },
      c => { c.resource = c.issuer; },
      c => { c.resource += "?alternate=true"; },
      c => { c.resource = "http://127.0.0.1:1/mcp"; },
      c => { c.reverse_proxy.allowed_host = "attacker.invalid"; },
      c => { c.listen.host = "0.0.0.0"; },
    ]) {
      const changed = structuredClone(config); mutate(changed);
      assert.throws(() => validate(changed, { isolated: true }));
    }
    assert.throws(() => validate(config), /HTTPS/);
  }
});

test("SHARED-02 documented path allowlist routes both discovery documents and denies private/bootstrap operations", async (t) => {
  const f = await gatewayFixture(t, { sharedOrigin: true,
    authMutate: c => { c.mode = "bootstrap_metadata_only"; },
    mutate: c => { c.mode = "bootstrap_metadata_only"; } });
  const origin = f.config.issuer;
  const as = await (await fetch(origin + "/.well-known/oauth-authorization-server")).json();
  const rs = await (await fetch(origin + "/.well-known/oauth-protected-resource/mcp")).json();
  assert.equal(as.issuer, origin);
  assert.equal(as.authorization_endpoint, origin + "/authorize");
  assert.deepEqual(rs.authorization_servers, [origin]);
  assert.equal(rs.resource, origin + "/mcp");
  assert.deepEqual(rs, await (await fetch(origin + "/.well-known/oauth-protected-resource")).json());
  assert.deepEqual(as, await (await fetch(origin + "/.well-known/openid-configuration")).json());
  const noAuth = await f.mcp("tools/list");
  assert.equal(noAuth.status, 401);
  assert.ok(noAuth.headers.get("www-authenticate").includes(origin + "/.well-known/oauth-protected-resource/mcp"));
  for (const route of ["/livez", "/readyz", "/readyz/search", "/v1/identity", "/v1/memories", "/admin",
    "/.env", "/auth.sqlite3", "/userinfo", "/token/extra", "/interaction/../admin", "/mcp/extra", "/assets/script.js"]) {
    assert.equal((await fetch(origin + route)).status, 404, route);
  }
  for (const route of ["/authorize", "/token", "/introspect", "/revoke"]) {
    assert.equal((await fetch(origin + route, { method: "POST" })).status, 503);
  }
  assert.equal(f.app.provider, undefined);
  assert.equal(f.gateway.authorization, null);
  assert.equal(f.gateway.core, null);
});

test("SHARED-03 same-host login, resumed authorization, SDK, refresh and revocation preserve token-only MCP", async (t) => {
  const f = await gatewayFixture(t, { sharedOrigin: true });
  const authorization = await f.authorize();
  assert.equal(authorization.callback.searchParams.get("iss"), f.config.issuer);
  const result = await f.exchange(authorization);
  assert.equal(result.status, 200);
  const tokens = result.data;
  assert.equal((await f.introspect(tokens.access_token)).data.aud, f.config.resource);
  assert.ok(f.browser.cookies.size > 0);
  const observedCookies = [];
  f.gateway.server.on("request", request => observedCookies.push({ cookie: request.headers.cookie,
    raw: request.rawHeaders.filter((_, index) => index % 2 === 0).some(name => ["cookie", "cookie2"].includes(name.toLowerCase())) }));
  const cookieOnly = await f.browser.request("/mcp");
  assert.equal(cookieOnly.status, 401);
  assert.equal(cookieOnly.headers.getSetCookie().length, 0);
  const cookieAndToken = await f.browser.request("/mcp", { method: "POST", headers: {
    "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + tokens.access_token,
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(cookieAndToken.status, 200);
  assert.equal(cookieAndToken.headers.getSetCookie().length, 0);
  assert.equal(cookieAndToken.headers.get("x-content-type-options"), "nosniff");
  assert.ok(cookieAndToken.headers.get("content-security-policy").includes("default-src 'none'"));
  assert.ok(observedCookies.length >= 2 && observedCookies.every(item => item.cookie === undefined && item.raw === false));
  const client = new Client({ name: "synthetic-shared-host-client", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(f.config.resource),
    { requestInit: { headers: { authorization: "Bearer " + tokens.access_token } } }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["mnemuron_auth_status"]);
  assert.equal((await client.callTool({ name: "mnemuron_auth_status", arguments: {} })).structuredContent.authenticated, true);
  const refreshed = await f.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, resource: f.config.resource });
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.data.refresh_token, tokens.refresh_token);
  const revoke = await fetch(f.config.issuer + "/revoke", { method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({
      client_id: f.config.chatgpt_client.client_id, client_secret: f.secret, token: refreshed.data.refresh_token,
    }) });
  assert.equal(revoke.status, 200);
  assert.equal((await f.mcp("tools/list", undefined, refreshed.data.access_token)).status, 401);
  for (const secret of [tokens.access_token, tokens.refresh_token, f.secret, f.introspectionSecret]) {
    assert.equal(JSON.stringify([...f.logs, ...f.gatewayLogs]).includes(secret), false);
  }
});

test("SHARED-04 host, origin, CSRF, browser binding, audience and PKCE remain fail closed through ingress", async (t) => {
  const f = await gatewayFixture(t, { sharedOrigin: true });
  const params = { client_id: f.config.chatgpt_client.client_id, redirect_uri: f.config.chatgpt_client.redirect_uris[0],
    response_type: "code", resource: f.config.resource, scope: "openid offline_access memory:read",
    code_challenge: randomSecret(), code_challenge_method: "S256" };
  const start = await f.browser.request("/authorize?" + new URLSearchParams(params));
  const page = await f.browser.request(start.headers.get("location"));
  const csrf = page.text.match(/name="csrf" value="([^"]+)"/)[1];
  const action = page.text.match(/action="([^"]+)"/)[1];
  assert.equal((await f.browser.post(action, { csrf: "wrong" })).status, 403);
  assert.ok((await new Browser(f.config.issuer).post(action, { csrf })).status >= 400);
  assert.equal((await f.browser.request(action, { method: "POST", headers: {
    "content-type": "application/x-www-form-urlencoded", origin: "https://attacker.invalid",
  }, body: new URLSearchParams({ csrf }).toString() })).status, 403);
  assert.equal((await f.browser.post(action, { csrf, username: "synthetic-owner", password: "wrong", otp: "000000" })).status, 401);
  assert.equal((await f.browser.post(action, { csrf })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    http.get(f.config.resource, { headers: { host: "attacker.invalid" } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(wrongHost, 400);
  const wrongResource = await f.browser.request("/authorize?" + new URLSearchParams({ ...params, resource: f.config.issuer }));
  assert.equal(new URL(wrongResource.headers.get("location")).searchParams.get("error"), "invalid_target");
  const authorized = await f.authorize();
  assert.equal((await f.exchange(authorized, { code_verifier: randomSecret() })).status, 400);
});

test("SHARED-05 same-origin business reads retain owner isolation and never expose Core or writes", async (t) => {
  const core = await memoryFixture(t);
  const f = await gatewayFixture(t, { sharedOrigin: true, profile: "readonly", coreFixture: core });
  const own = core.store.saveMemory(core.a.auth, { scope: "task", task_id: core.alpha.task_id, content: "Synthetic single-origin sample" }).memory;
  const foreign = core.store.saveMemory(core.other.auth, { scope: "task", task_id: core.foreign.task_id, content: "Synthetic foreign sample" }).memory;
  const before = businessSnapshot(core.store);
  const tokens = (await f.exchange(await f.authorize())).data;
  const detail = await f.mcp("tools/call", { name: "mnemuron_get_memory", arguments: { memory_id: own.memory_id } }, tokens.access_token);
  assert.equal(detail.status, 200);
  assert.equal((await f.mcp("tools/call", { name: "mnemuron_get_memory", arguments: { memory_id: foreign.memory_id } }, tokens.access_token)).status, 404);
  const forbidden = await f.mcp("tools/call", { name: "mnemuron_remember", arguments: { content: "not written" } }, tokens.access_token);
  assert.ok(forbidden.data.error || forbidden.data.result?.isError);
  assert.equal((await fetch(f.config.issuer + "/v1/memories")).status, 404);
  assert.deepEqual(businessSnapshot(core.store), before);
});

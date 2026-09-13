import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { gatewayFixture } from "./fixture.mjs";
import { close, listen } from "../../../services/oauth/test/fixture.mjs";
import { createGateway } from "../src/server.mjs";
import { validateGatewayConfig, loadIdentityMap } from "../src/config.mjs";
import { seconds, writePrivate, randomSecret, fetchJson } from "../../../shared/oauth-common.mjs";
import { memoryFixture } from "../../../server/test/helpers/core-memory-fixture.mjs";
import { provisionCore } from "../bin/provision-core.mjs";

async function dependencyFixture(t, { loopbackAuth = false } = {}) {
  const f = await gatewayFixture(t, { loopbackAuth });
  await f.stop();
  const valid = { active: true, iss: f.config.issuer, aud: f.config.resource, client_id: f.config.chatgpt_client.client_id,
    sub: f.subject, exp: seconds() + 300, scope: "memory:read project:read", token_type: "Bearer", token_kind: "access_token" };
  f.response = { status: 200, body: valid };
  f.metadata = { issuer: f.config.issuer, authorization_endpoint: `${f.config.issuer}/authorize`, token_endpoint: `${f.config.issuer}/token`,
    introspection_endpoint: `${f.config.issuer}/introspect`, code_challenge_methods_supported: ["S256"] };
  f.calls = 0;
  const mock = http.createServer((request, response) => {
    if (request.url.includes("well-known")) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(f.metadata)); return; }
    f.calls += 1;
    if (f.response.delay) { setTimeout(() => response.end(), f.response.delay).unref(); return; }
    response.writeHead(f.response.status, { "content-type": f.response.type || "application/json", ...(f.response.headers || {}) });
    response.end(typeof f.response.body === "string" ? f.response.body : JSON.stringify(f.response.body));
  });
  await listen(mock, f.ports.authPort);
  t.after(() => close(mock));
  f.valid = valid;
  f.request = (method = "tools/list", params) => f.mcp(method, params, randomSecret());
  return f;
}

for (const loopbackAuth of [false, true]) {
test(`AUTHZ-01..03 fixed issuer, audience, client, access-token type and strict introspection schema (${loopbackAuth ? "loopback" : "issuer"})`, async (t) => {
  const f = await dependencyFixture(t, { loopbackAuth });
  assert.equal((await f.request()).status, 200);
  for (const change of [{ aud: `${f.config.resource}/other` }, { iss: "https://attacker.invalid" },
    { client_id: "different-client" }, { token_kind: "refresh_token" }, { token_type: "DPoP" },
    { exp: seconds() - 1 }, { nbf: seconds() + 30 }, { active: false }]) {
    f.response.body = { ...f.valid, ...change };
    assert.equal((await f.request()).status, 401, Object.keys(change).join(","));
  }
  for (const change of [{ active: "true" }, { exp: "9999999999" }, { exp: null }, { sub: null }, { scope: null }, { nbf: "future" }, { aud: [f.config.resource] }]) {
    f.response.body = { ...f.valid, ...change };
    assert.equal((await f.request()).status, 503);
  }
  f.response.body = { ...f.valid, scope: "memory:read-more project:read" };
  assert.equal((await f.request("tools/call", { name: "mnemuron_auth_status", arguments: {} })).status, 403);
  f.metadata.issuer = "https://attacker.invalid";
  assert.equal((await f.request()).data.error_code, "AUTH_DEPENDENCY_UNAVAILABLE");
});

test(`AUTHZ-06 dependency timeout, redirects, malformed/oversized replies and TLS errors do not fail open (${loopbackAuth ? "loopback" : "issuer"})`, async (t) => {
  const f = await dependencyFixture(t, { loopbackAuth });
  f.gateway.authorization.config.introspection.timeout_ms = 80;
  const cases = [
    { status: 500, body: { error: "offline" } }, { status: 200, body: "<html>challenge</html>", type: "text/html" },
    { status: 200, body: "{bad-json" }, { status: 200, body: `{"active":true,"padding":"${"x".repeat(70000)}"}` },
    { status: 302, headers: { location: "http://127.0.0.1:1/should-not-follow" }, body: {} },
    { status: 200, delay: 250 },
  ];
  for (const value of cases) {
    f.response = value;
    const result = await f.request();
    assert.equal(result.status, 503);
    assert.equal(result.data.error_code, "AUTH_DEPENDENCY_UNAVAILABLE");
  }
  await assert.rejects(() => fetchJson(`https://127.0.0.1:${f.ports.authPort}/introspect`, {}, { timeoutMs: 80 }));
  f.response = { status: 200, body: f.valid };
  assert.equal((await f.request()).status, 200);
  const previous = f.calls;
  await f.request(); await f.request();
  assert.equal(f.calls - previous, 2);
});
}

test("CFG-02/03/08 bootstrap never reads a core key; unsafe modes and mappings are rejected", async (t) => {
  const f = await gatewayFixture(t);
  const c = structuredClone(f.gatewayConfig);
  c.mode = "bootstrap_metadata_only";
  c.identity_map_file = "/unavailable/identity.json";
  c.introspection.client_secret_file = "/unavailable/secret";
  await close(f.gateway.server);
  const app = createGateway(c, { isolated: true });
  await listen(app.server, f.ports.gatewayPort);
  t.after(() => close(app.server));
  assert.equal(app.authorization, null);
  assert.equal(app.core, null);
  assert.equal((await f.mcp("tools/list", undefined, randomSecret())).status, 401);
  for (const change of [x => { x.tool_profile = "full"; }, x => { x.introspection.active_cache_seconds = 10; },
    x => { x.introspection.endpoint = "https://attacker.invalid/introspect"; }, x => { x.logging.include_memory_content = true; },
    x => { x.tool_profile = "readonly"; x.core.base_url = "https://attacker.invalid"; }]) {
    const broken = structuredClone(f.gatewayConfig); change(broken);
    assert.throws(() => validateGatewayConfig(broken, { isolated: true }));
  }
  f.identityMap.mappings.push({ ...f.identityMap.mappings[0] });
  writePrivate(f.gatewayConfig.identity_map_file, f.identityMap, { replace: true });
  assert.throws(() => loadIdentityMap(f.gatewayConfig));
});

test("CFG-07 explicit provisioning writes one minimum-scope credential without persisting the administrator key", async (t) => {
  const core = await memoryFixture(t);
  const f = await gatewayFixture(t, { profile: "readonly", coreFixture: core });
  const config = structuredClone(f.gatewayConfig);
  config.core.credential_file += "-new";
  const adminFile = `${f.directory}/admin-credential`;
  writePrivate(adminFile, core.a.api_key);
  const issued = await provisionCore(config, adminFile);
  assert.deepEqual(issued.scopes, ["memory:read", "resume:read"]);
  const secret = fs.readFileSync(config.core.credential_file, "utf8").trim();
  assert.notEqual(secret, core.a.api_key);
  assert.equal(fs.statSync(config.core.credential_file).mode & 0o077, 0);
  const auth = core.store.authenticate(secret);
  assert.equal(auth.user_id, core.a.auth.user_id);
  assert.deepEqual(auth.scopes, ["memory:read", "resume:read"]);
  await assert.rejects(() => provisionCore(config, adminFile));
});

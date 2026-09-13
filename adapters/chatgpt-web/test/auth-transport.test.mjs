import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { gatewayFixture } from "./fixture.mjs";
import { listen, close, freePort } from "../../../services/oauth/test/fixture.mjs";
import { fetchAuthorizationJson } from "../src/auth-transport.mjs";
import { validateGatewayConfig } from "../src/config.mjs";

test("LOCAL-AS-01 explicit opt-in rejects remote, DNS, ambiguous and self-target transports", async (t) => {
  const f = await gatewayFixture(t);
  assert.deepEqual(f.gateway.config.authorization_server_transport, { mode: "issuer_url" });
  const c = structuredClone(f.gatewayConfig);
  const local = { mode: "loopback_http", host: "127.0.0.1", port: f.ports.authPort };
  assert.deepEqual(validateGatewayConfig({ ...c, authorization_server_transport: local }, { isolated: true }).authorization_server_transport, local);
  for (const bad of [
    { mode: "fallback" }, { mode: "issuer_url", host: "127.0.0.1" }, { ...local, url: c.issuer },
    ...["localhost", "127.1", "127.0.0.2", "::1", "0.0.0.0", "192.0.2.1", "attacker.invalid"].map(host => ({ ...local, host })),
    ...[0, 65536, "47833", 1.5, c.listen.port].map(port => ({ ...local, port })),
  ]) assert.throws(() => validateGatewayConfig({ ...c, authorization_server_transport: bad }, { isolated: true }));
  for (const key of ["authorization_server_metadata_url", "introspection"]) {
    const bad = structuredClone(c);
    bad.authorization_server_transport = local;
    if (key === "introspection") bad.introspection.endpoint = "http://127.0.0.1:1/introspect";
    else bad[key] = "http://127.0.0.1:1/.well-known/oauth-authorization-server";
    assert.throws(() => validateGatewayConfig(bad, { isolated: true }));
  }
});

test("LOCAL-AS-02 full provider and SDK use canonical identity with an independent same-host backend", async (t) => {
  const f = await gatewayFixture(t, { sharedOrigin: true, loopbackAuth: true });
  const result = await f.exchange(await f.authorize());
  assert.equal(result.status, 200);
  const token = result.data.access_token;
  const publicRequests = [];
  f.ingress.on("request", request => publicRequests.push(request.url));
  const client = new Client({ name: "synthetic-loopback-auth", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(f.config.resource),
    { requestInit: { headers: { authorization: "Bearer " + token } } }));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["mnemuron_auth_status"]);
  assert.equal((await client.callTool({ name: "mnemuron_auth_status", arguments: {} })).structuredContent.authenticated, true);
  assert.ok(publicRequests.length > 0 && publicRequests.every(route => route === "/mcp"));
  const metadata = await fetchAuthorizationJson(f.gateway.config, f.gateway.config.authorization_server_metadata_url);
  assert.equal(metadata.data.issuer, f.config.issuer);
  assert.equal(metadata.data.introspection_endpoint, f.config.issuer + "/introspect");
  assert.equal(f.gateway.core, null);
  await client.close();
  await close(f.ingress);
  const request = { headers: { authorization: "Bearer " + token } };
  assert.equal((await f.gateway.authorization.verify(request)).mapping.subject, f.subject);
  await f.stop();
  await assert.rejects(() => f.gateway.authorization.verify(request), { code: "AUTH_DEPENDENCY_UNAVAILABLE" });
  await f.start();
  assert.equal((await f.gateway.authorization.verify(request)).mapping.subject, f.subject);
  f.app.store.revoke({ all: true });
  await assert.rejects(() => f.gateway.authorization.verify(request), { code: "INVALID_TOKEN" });
});

test("LOCAL-AS-03 loopback transport preserves public Host, has no DNS dependency and forwards only fixed protocol fields", async (t) => {
  const port = await freePort();
  const received = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ url: request.url, host: request.headers.host, headers: request.headers, body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ active: false }));
  });
  await listen(server, port);
  t.after(() => close(server));
  const config = { issuer: "https://as.unresolvable.invalid", listen: { port: await freePort() },
    authorization_server_metadata_url: "https://as.unresolvable.invalid/.well-known/oauth-authorization-server",
    introspection: { endpoint: "https://as.unresolvable.invalid/introspect", timeout_ms: 100, max_response_bytes: 65536 },
    authorization_server_transport: { mode: "loopback_http", host: "127.0.0.1", port } };
  const headers = { host: "attacker.invalid", cookie: "synthetic-cookie", origin: "https://attacker.invalid",
    "x-forwarded-host": "attacker.invalid", authorization: "Basic synthetic" };
  await fetchAuthorizationJson(config, config.authorization_server_metadata_url, { headers });
  await fetchAuthorizationJson(config, config.introspection.endpoint, { method: "POST", headers, body: "token=synthetic" });
  assert.deepEqual(received.map(item => [item.url, item.host, item.body]), [
    ["/.well-known/oauth-authorization-server", "as.unresolvable.invalid", ""],
    ["/introspect", "as.unresolvable.invalid", "token=synthetic"],
  ]);
  assert.equal(received[0].headers.authorization, undefined);
  assert.equal(received[1].headers.authorization, "Basic synthetic");
  for (const entry of received) for (const name of ["cookie", "origin", "x-forwarded-host"]) assert.equal(entry.headers[name], undefined);
  for (const endpoint of [config.issuer + "/token", config.introspection.endpoint + "?extra=1", "http://127.0.0.1:1/introspect"]) {
    await assert.rejects(() => fetchAuthorizationJson(config, endpoint, { method: "POST", headers }));
  }
  await assert.rejects(() => fetchAuthorizationJson(config, config.introspection.endpoint));
  assert.equal(received.length, 2);
  await close(server);
  await assert.rejects(() => fetchAuthorizationJson(config, config.authorization_server_metadata_url));
});

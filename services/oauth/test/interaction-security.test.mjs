import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fixture, listen, Browser } from "./fixture.mjs";
import { AuthStore } from "../src/sqlite-adapter.mjs";
import { Accounts } from "../src/accounts.mjs";
import { makeProvider } from "../src/provider.mjs";
import { loadAuthSecrets } from "../src/config.mjs";
import { interactionRequest } from "../src/interactions.mjs";
import { randomSecret } from "../../../shared/oauth-common.mjs";

test("LOGIN-09 interaction pages preserve native same-origin form POSTs without changing protocol referrer policy", async (t) => {
  const f = await fixture(t);
  const pages = new Set();
  const request = f.browser.request.bind(f.browser);
  f.browser.request = async (...args) => {
    const response = await request(...args);
    if (response.status === 200 && response.headers.get("content-type")?.startsWith("text/html")) {
      // no-referrer makes native non-CORS form POSTs serialize Origin as null.
      assert.equal(response.headers.get("referrer-policy"), "same-origin");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("content-security-policy"),
        `default-src 'none'; form-action 'self' ${f.config.chatgpt_client.redirect_uris[0]}; frame-ancestors 'none'; base-uri 'none'`);
      const action = response.text.match(/action="([^"]+)"/)[1];
      assert.equal(new URL(action, f.config.issuer).origin, f.config.issuer);
      pages.add(action.split("/").at(-1));
    } else assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    return response;
  };
  const authorization = await f.authorize();
  assert.deepEqual([...pages], ["login", "confirm"]);
  assert.ok(authorization.callback.searchParams.has("code"));
  assert.equal((await f.exchange(authorization)).status, 200);
  await f.browser.request("/.well-known/oauth-authorization-server");
});

test("LOGIN-10 null and foreign form origins remain forbidden, while same-origin forms still require CSRF", async (t) => {
  const f = await fixture(t);
  const params = new URLSearchParams({ client_id: f.config.chatgpt_client.client_id,
    redirect_uri: f.config.chatgpt_client.redirect_uris[0], response_type: "code", scope: "openid memory:read",
    resource: f.config.resource, code_challenge: randomSecret(), code_challenge_method: "S256" });
  const start = await f.browser.request(`/authorize?${params}`);
  const page = await f.browser.request(start.headers.get("location"));
  const action = page.text.match(/action="([^"]+)"/)[1];
  for (const suffix of ["login", "confirm", "abort"]) {
    for (const origin of ["null", "https://attacker.invalid"]) {
      const denied = await f.browser.request(action.replace(/login$/, suffix), { method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin }, body: "csrf=invalid" });
      assert.equal(denied.status, 403);
      assert.equal(JSON.parse(denied.text).error_code, "ORIGIN_DENIED");
    }
  }
  const missingCsrf = await f.browser.post(action, {});
  assert.equal(missingCsrf.status, 403);
  assert.equal(JSON.parse(missingCsrf.text).error_code, "CSRF_REJECTED");
  assert.equal(f.app.store.summary().some(item => item.model === "Grant"), false);
});

test("LOGIN-05 trusted-termination component fixture uses secure signed cookies and rotates an existing session", async (t) => {
  const f = await fixture(t, { start: false });
  const transportOrigin = f.config.issuer;
  f.config.issuer = f.config.issuer.replace("http:", "https:");
  f.browser = new Browser(f.config.issuer, { transportOrigin });
  const store = new AuthStore(f.config.database_file);
  const accounts = new Accounts(f.config.accounts_file, store);
  // This loopback-only harness supplies the TLS-termination signal itself, never from a caller header.
  const config = { ...f.config, isolated: false };
  const provider = makeProvider(config, loadAuthSecrets(config), store, accounts);
  const callback = provider.callback();
  const cookies = [];
  const server = http.createServer(async (request, response) => {
    request.headers["x-forwarded-proto"] = "https";
    response.on("finish", () => cookies.push(...(response.getHeader("set-cookie") || [])));
    try {
      const url = new URL(request.url, config.issuer);
      if (url.pathname.startsWith("/interaction/")) await interactionRequest(request, response, { provider, store, accounts, config, url });
      else await callback(request, response);
    } catch { response.writeHead(400); response.end(); }
  });
  server.on("close", () => store.close());
  f.app = { server };
  await listen(server, f.ports.authPort);
  f.browser.cookies.set("mnm_session:/", { name: "mnm_session", value: "synthetic-fixed-unsigned-cookie", path: "/" });
  const first = await f.authorize({ params: { prompt: "consent" } });
  assert.ok(first.callback.searchParams.has("code"));
  const before = f.browser.cookies.get("mnm_session:/").value;
  assert.notEqual(before, "synthetic-fixed-unsigned-cookie");
  const second = await f.authorize({ params: { prompt: "consent" } });
  assert.ok(second.callback.searchParams.has("code"));
  assert.notEqual(f.browser.cookies.get("mnm_session:/").value, before);
  const protectedCookies = cookies.filter(value => /^mnm_(session|interaction|resume)=/.test(value));
  assert.ok(protectedCookies.length > 0);
  for (const cookie of protectedCookies) {
    assert.match(cookie, /; secure/i);
    assert.match(cookie, /; httponly/i);
    assert.match(cookie, /; samesite=lax/i);
  }
  for (const key of Object.keys(loadAuthSecrets(config).jwks.keys[0])) {
    if (["d", "p", "q", "dp", "dq", "qi"].includes(key)) assert.equal(cookies.some(line => line.includes(loadAuthSecrets(config).jwks.keys[0][key])), false);
  }
});

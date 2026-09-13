import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { fixture, validatedCallback } from "./fixture.mjs";
import { randomSecret, seconds, readPrivate } from "../../../shared/oauth-common.mjs";

test("PKCE-01/TOKEN-01 complete HTTP password, MFA, consent, PKCE and opaque introspection", async (t) => {
  const f = await fixture(t);
  const metadata = await (await fetch(`${f.config.issuer}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.issuer, f.config.issuer);
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.equal(metadata.registration_endpoint, undefined);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ["client_secret_post"]);
  const authorization = await f.authorize();
  assert.equal(authorization.callback.searchParams.get("iss"), f.config.issuer);
  assert.equal(authorization.callback.searchParams.get("state"), authorization.request.state);
  assert.ok(authorization.callback.searchParams.get("code"));
  const result = await f.exchange(authorization);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.expires_in, 300);
  assert.ok(result.data.refresh_token);
  assert.ok(result.data.id_token);
  const [header, payload, signature] = result.data.id_token.split(".");
  const jwk = readPrivate(f.config.private_jwks_file, { json: true }).keys[0];
  assert.equal(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(signature, "base64url")), true);
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, f.config.issuer);
  assert.equal(claims.sub, f.subject);
  assert.equal(claims.aud, f.config.chatgpt_client.client_id);
  assert.equal(result.data.access_token.split(".").length, 1);
  const introspection = await f.introspect(result.data.access_token);
  assert.equal(introspection.data.active, true);
  assert.equal(introspection.data.sub, f.subject);
  assert.equal(introspection.data.aud, f.config.resource);
  assert.equal(introspection.data.token_kind, "access_token");
});

test("DISC-03..07 static discovery, disabled grants, exact callbacks, consent rejection and issuer", async (t) => {
  const f = await fixture(t);
  const discovery = await (await fetch(`${f.config.issuer}/.well-known/openid-configuration`)).json();
  assert.equal(discovery.authorization_endpoint, `${f.config.issuer}/authorize`);
  assert.equal(discovery.client_id_metadata_document_supported, undefined);
  assert.equal(discovery.registration_endpoint, undefined);
  assert.equal(discovery.pushed_authorization_request_endpoint, undefined);
  assert.equal(discovery.userinfo_endpoint, undefined);
  assert.deepEqual(discovery.grant_types_supported.sort(), ["authorization_code", "refresh_token"]);
  assert.deepEqual(discovery.scopes_supported.sort(), f.config.chatgpt_client.allowed_scopes.toSorted());
  for (const route of ["/reg", "/request", "/device/auth", "/v1/status", "/.env", "/userinfo"]) {
    assert.equal((await fetch(`${f.config.issuer}${route}`, { method: "POST" })).status, 404);
  }
  for (const redirect of [f.config.chatgpt_client.redirect_uris[0] + "/", "https://attacker.invalid/callback"]) {
    const result = await fetch(`${f.config.issuer}/authorize?${new URLSearchParams({ client_id: f.config.chatgpt_client.client_id,
      redirect_uri: redirect, response_type: "code", resource: f.config.resource, scope: "openid", code_challenge: randomSecret(), code_challenge_method: "S256" })}`, { redirect: "manual" });
    assert.equal(result.headers.get("location"), null);
    assert.ok(result.status >= 400);
  }
  const denied = await f.authorize({ decision: "abort" });
  assert.equal(denied.callback.searchParams.get("error"), "access_denied");
  assert.equal(denied.callback.searchParams.get("iss"), f.config.issuer);
  assert.equal(denied.callback.searchParams.get("code"), null);
  assert.equal(f.app.store.summary().find((row) => row.model === "Grant"), undefined);
  for (const issuer of [undefined, "https://untrusted.invalid"]) {
    const callback = new URL(denied.callback);
    if (issuer) callback.searchParams.set("iss", issuer); else callback.searchParams.delete("iss");
    assert.throws(() => validatedCallback(callback, f.config.issuer, denied.request), /Untrusted/);
  }
});

test("PKCE-02..08 verifier, resource, scope, credential and duplicate-parameter negative paths", async (t) => {
  const f = await fixture(t);
  for (const params of [{ code_challenge_method: "plain" }, { code_challenge: "" }, { resource: "https://attacker.invalid/mcp" }, { scope: "openid admin:devices" }]) {
    const authorization = await f.authorize({ params });
    assert.ok(authorization.callback.searchParams.get("error"));
    assert.equal(authorization.callback.searchParams.get("iss"), f.config.issuer);
    assert.equal(authorization.callback.searchParams.get("code"), null);
  }
  const a = await f.authorize();
  for (const changes of [{ code_verifier: "" }, { code_verifier: randomSecret() }, { redirect_uri: `${f.config.chatgpt_client.redirect_uris[0]}/` },
    { client_secret: randomSecret() }, { resource: `${f.config.resource}/wrong` }, { resource: "" }, { client_id: f.config.introspection_client.client_id }]) {
    const result = await f.exchange(a, changes);
    assert.ok(result.status >= 400, Object.keys(changes).join(","));
    assert.equal(result.data.access_token, undefined);
  }
  const body = new URLSearchParams({ client_id: f.config.chatgpt_client.client_id, client_secret: f.secret, grant_type: "authorization_code", code: a.callback.searchParams.get("code"),
    redirect_uri: f.config.chatgpt_client.redirect_uris[0], resource: f.config.resource, code_verifier: a.verifier });
  body.append("code", "ambiguous");
  const duplicate = await fetch(`${f.config.issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).error_code, "AMBIGUOUS_PARAMETERS");
  assert.equal((await f.exchange(a)).status, 200);
});

test("PKCE-04/TOKEN-06 parallel code exchange issues once and consumed code survives restart", async (t) => {
  const f = await fixture(t);
  const a = await f.authorize();
  const results = await Promise.all([f.exchange(a), f.exchange(a)]);
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.equal(results.filter((result) => result.data.error === "invalid_grant").length, 1);
  await f.stop(); await f.start();
  assert.equal((await f.exchange(a)).data.error, "invalid_grant");
});

test("TOKEN-02..06 refresh rotates, resource expansion fails, replay revokes the family and restart preserves valid tokens", async (t) => {
  const f = await fixture(t);
  const first = (await f.exchange(await f.authorize())).data;
  assert.equal((await f.introspect(first.refresh_token)).data.active, false);
  assert.equal((await f.introspect(first.id_token)).data.active, false);
  assert.equal((await f.introspect(first.access_token, { credentials: `${f.config.chatgpt_client.client_id}:${f.secret}` })).status, 401);
  await f.stop(); await f.start();
  assert.equal((await f.introspect(first.access_token)).data.active, true);
  for (const extra of [{ resource: "https://attacker.invalid/mcp" }, { scope: "admin:devices" }]) {
    const result = await f.token({ grant_type: "refresh_token", refresh_token: first.refresh_token, ...extra });
    assert.ok(result.status >= 400);
  }
  const rotated = await f.token({ grant_type: "refresh_token", refresh_token: first.refresh_token });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.data.refresh_token, first.refresh_token);
  assert.equal((await f.introspect(rotated.data.access_token)).data.active, true);
  const replay = await f.token({ grant_type: "refresh_token", refresh_token: first.refresh_token });
  assert.equal(replay.data.error, "invalid_grant");
  assert.equal((await f.introspect(rotated.data.access_token)).data.active, false);
  assert.equal((await f.token({ grant_type: "refresh_token", refresh_token: rotated.data.refresh_token })).data.error, "invalid_grant");
  await f.stop(); await f.start();
  assert.equal((await f.introspect(first.access_token)).data.active, false);
});

test("TOKEN-05 parallel refresh reuse cannot leave two live token branches", async (t) => {
  const f = await fixture(t);
  const first = (await f.exchange(await f.authorize())).data;
  const results = await Promise.all([1, 2].map(() => f.token({ grant_type: "refresh_token", refresh_token: first.refresh_token })));
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.equal(results.filter((result) => result.data.error === "invalid_grant").length, 1);
  const issued = results.find((result) => result.status === 200).data;
  assert.equal((await f.introspect(issued.access_token)).data.active, false);
});

test("TOKEN-08/OPS-03 revocation and owner disable reject the next check without logging secrets", async (t) => {
  const f = await fixture(t);
  const result = (await f.exchange(await f.authorize())).data;
  const response = await fetch(`${f.config.issuer}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: result.access_token, client_id: f.config.chatgpt_client.client_id, client_secret: f.secret }) });
  assert.equal(response.status, 200);
  assert.equal((await f.introspect(result.access_token)).data.active, false);
  assert.equal((await f.token({ grant_type: "refresh_token", refresh_token: result.refresh_token })).data.error, "invalid_grant");
  const next = (await f.exchange(await f.authorize())).data;
  assert.equal((await f.introspect(next.access_token)).data.active, true);
  f.app.accounts.disable();
  assert.equal((await f.introspect(next.access_token)).data.active, false);
  for (const secret of [f.password, f.secret, f.introspectionSecret, f.seed, result.access_token, result.refresh_token, result.id_token]) {
    assert.equal(JSON.stringify(f.logs).includes(secret), false);
  }
});

test("PKCE-04/TOKEN-01/04 expired authorization codes, access tokens and idle refresh tokens are rejected", async (t) => {
  const f = await fixture(t);
  const expired = await f.authorize();
  f.app.store.db.prepare("UPDATE oauth_records SET expires=? WHERE model='AuthorizationCode'").run(seconds() - 1);
  const denied = await f.exchange(expired);
  assert.equal(denied.data.error, "invalid_grant");
  assert.equal(denied.data.access_token, undefined);
  const tokens = (await f.exchange(await f.authorize())).data;
  f.app.store.db.prepare("UPDATE oauth_records SET expires=? WHERE model='AccessToken'").run(seconds() - 1);
  assert.equal((await f.introspect(tokens.access_token)).data.active, false);
  f.app.store.db.prepare("UPDATE oauth_records SET expires=? WHERE model='RefreshToken'").run(seconds() - 1);
  const refresh = await f.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal(refresh.data.error, "invalid_grant");
  assert.equal(refresh.data.access_token, undefined);
});

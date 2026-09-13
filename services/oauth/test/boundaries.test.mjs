import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { generate } from "otplib";
import { fixture, Browser, close, listen } from "./fixture.mjs";
import { AuthStore } from "../src/sqlite-adapter.mjs";
import { Accounts } from "../src/accounts.mjs";
import { validateAuthConfig, loadAuthSecrets } from "../src/config.mjs";
import { createAuthorizationServer } from "../src/server.mjs";
import { initializeSecrets } from "../bin/admin.mjs";
import { seconds, readPrivate, writePrivate, randomSecret } from "../../../shared/oauth-common.mjs";

test("CFG-01..06 insecure configuration, credential aliasing, secret permissions and bootstrap fail closed", async (t) => {
  const f = await fixture(t, { start: false });
  const bad = [c => { c.login.mfa_required = false; }, c => { c.issuer += "/"; }, c => { c.resource += "?user=owner"; },
    c => { c.resource = "http://user:pass@127.0.0.1:8000/mcp"; }, c => { c.client_registration.dynamic = true; },
    c => { c.chatgpt_client.redirect_uris = ["https://attacker.invalid/callback"]; }, c => { c.listen.host = "0.0.0.0"; },
    c => { c.mode = "disabled"; }, c => { c.chatgpt_client.pkce.methods = ["plain"]; }, c => { c.log.include_tokens = true; }];
  for (const change of bad) {
    const config = structuredClone(f.config); change(config);
    assert.throws(() => validateAuthConfig(config, { isolated: true }));
  }
  assert.throws(() => validateAuthConfig(f.config), /HTTPS/);
  const placeholder = structuredClone(f.config);
  placeholder.issuer = "https://auth-memory.example.com";
  assert.throws(() => validateAuthConfig(placeholder), /deployment hostname/);
  const secret = f.config.chatgpt_client.client_secret_file;
  fs.chmodSync(secret, 0o644);
  assert.throws(() => loadAuthSecrets(f.config));
  fs.chmodSync(secret, 0o600);
  writePrivate(secret, f.introspectionSecret, { replace: true });
  assert.throws(() => loadAuthSecrets(f.config), /separation/);
  assert.throws(() => initializeSecrets(f.config));
  const bootstrap = { ...f.config, mode: "bootstrap_metadata_only", accounts_file: "/unavailable/account.json" };
  const app = createAuthorizationServer(bootstrap, { isolated: true });
  await listen(app.server, f.ports.authPort);
  t.after(() => close(app.server));
  assert.equal(app.provider, undefined);
  const metadata = await (await fetch(`${bootstrap.issuer}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.mnemuron_mode, "bootstrap_metadata_only");
  assert.equal((await fetch(`${bootstrap.issuer}/readyz`)).status, 503);
  assert.equal((await fetch(`${bootstrap.issuer}/token`, { method: "POST" })).status, 503);
  assert.equal((await fetch(`${bootstrap.issuer}/.env`)).status, 404);
});

test("LOGIN-01..03 password and verified MFA are mandatory; TOTP replay, skew and concurrent use are rejected", async (t) => {
  const f = await fixture(t);
  const otp = await generate({ secret: f.seed });
  for (const [username, password, code] of [["missing-owner", f.password, otp], ["synthetic-owner", "wrong-password", otp],
    ["synthetic-owner", f.password, otp === "000000" ? "111111" : "000000"], ["synthetic-owner", f.password, ""],
    ["synthetic-owner", f.password, await generate({ secret: f.seed, epoch: seconds() - 180 })]]) {
    assert.equal(await f.app.accounts.authenticate(username, password, code), null);
  }
  const attempts = await Promise.all([1, 2].map(() => f.app.accounts.authenticate("synthetic-owner", f.password, otp)));
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.equal(await f.app.accounts.authenticate("synthetic-owner", f.password, otp), null);
  await f.stop(); await f.start();
  assert.equal(await f.app.accounts.authenticate("synthetic-owner", f.password, otp), null);
});

test("LOGIN-04..06 HTTP interactions reject missing cookies, wrong or reused CSRF and wrong prompt", async (t) => {
  const f = await fixture(t);
  const params = new URLSearchParams({ client_id: f.config.chatgpt_client.client_id, redirect_uri: f.config.chatgpt_client.redirect_uris[0],
    response_type: "code", scope: "openid offline_access memory:read", resource: f.config.resource, code_challenge: randomSecret(), code_challenge_method: "S256" });
  const start = await f.browser.request(`/authorize?${params}`);
  const target = start.headers.get("location");
  const page = await f.browser.request(target);
  const csrf = page.text.match(/name="csrf" value="([^"]+)"/)[1];
  const action = page.text.match(/action="([^"]+)"/)[1];
  assert.ok(page.text.includes("Do not enter your ChatGPT password"));
  assert.equal(page.headers.get("cache-control"), "no-store");
  const other = new Browser(f.config.issuer);
  assert.ok((await other.post(action, { csrf })).status >= 400);
  assert.equal((await f.browser.post(action, { csrf: "wrong" })).status, 403);
  assert.equal((await f.browser.post(action.replace(/login$/, "confirm"), { csrf })).status, 400);
  assert.equal((await f.browser.post(action, { csrf })).status, 403);
  assert.equal(f.app.store.summary().some((item) => item.model === "Grant"), false);
  assert.ok([...f.browser.cookies.keys()].some((key) => key.includes("mnm_interaction")));
});

test("LOGIN-07 persisted account/peer limits cannot be bypassed by forwarding headers", async (t) => {
  const f = await fixture(t, { mutate: c => { c.limits.login_attempts_per_account_per_15min = 1; } });
  const store = f.app.store;
  store.limit("login:owner", 1, 900);
  assert.throws(() => store.limit("login:owner", 1, 900), error => error.status === 429);
  await f.stop(); await f.start();
  assert.throws(() => f.app.store.limit("login:owner", 1, 900), error => error.status === 429);
  const authorization = await fetch(`${f.config.issuer}/authorize?${new URLSearchParams({ client_id: f.config.chatgpt_client.client_id,
    redirect_uri: f.config.chatgpt_client.redirect_uris[0], response_type: "code", resource: f.config.resource,
    scope: "openid", code_challenge: randomSecret(), code_challenge_method: "S256" })}`, {
      redirect: "manual", headers: { "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "https", "x-forwarded-for": "192.0.2.100" },
    });
  assert.equal(new URL(authorization.headers.get("location"), f.config.issuer).origin, f.config.issuer);
});

test("LOGIN-08 local MFA recovery consumes a code, invalidates grants and requires fresh enrollment", async (t) => {
  const f = await fixture(t);
  const tokens = (await f.exchange(await f.authorize())).data;
  const recovery = readPrivate(path.join(f.directory, "recovery.json"), { json: true });
  assert.equal(recovery.length, 8);
  assert.equal(JSON.stringify(readPrivate(f.config.accounts_file, { json: true })).includes(recovery[0]), false);
  assert.equal(f.app.accounts.resetMfa(recovery[0]), 1);
  assert.equal((await f.introspect(tokens.access_token)).data.active, false);
  assert.throws(() => f.app.accounts.read(), /verified MFA/);
  const next = f.app.accounts.read({ requireMfa: false });
  assert.notEqual(next.mfa.secret, f.seed);
  assert.throws(() => f.app.accounts.resetMfa(recovery[0]));
  await f.stop();
  assert.throws(() => createAuthorizationServer(f.config, { isolated: true }), /verified MFA/);
});

test("TOKEN-04 absolute refresh lifetime and expired grants are not extended by rotation", async (t) => {
  const f = await fixture(t);
  const tokens = (await f.exchange(await f.authorize())).data;
  const row = f.app.store.db.prepare("SELECT id,payload FROM oauth_records WHERE model='RefreshToken'").get();
  const token = JSON.parse(row.payload);
  token.iiat = seconds() - f.config.token_policy.refresh_absolute_ttl_seconds + 120;
  f.app.store.db.prepare("UPDATE oauth_records SET payload=? WHERE model='RefreshToken' AND id=?").run(JSON.stringify(token), row.id);
  const rotated = await f.token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  assert.equal(rotated.status, 200);
  const next = f.app.store.db.prepare("SELECT payload FROM oauth_records WHERE model='RefreshToken' AND json_extract(payload,'$.consumed') IS NULL").get();
  const payload = JSON.parse(next.payload);
  assert.equal(payload.iiat, token.iiat);
  assert.ok(payload.exp - seconds() <= 120);
  f.app.store.db.prepare("UPDATE oauth_records SET expires=? WHERE model='Grant'").run(seconds() - 1);
  assert.equal((await f.introspect(rotated.data.access_token)).data.active, false);
  assert.equal((await f.token({ grant_type: "refresh_token", refresh_token: rotated.data.refresh_token })).data.error, "invalid_grant");
});

test("CFG-06/TOKEN-06 single-process ownership and adapter indexes, consumption, expiry and grant tombstones", async (t) => {
  const f = await fixture(t);
  assert.throws(() => createAuthorizationServer(f.config, { isolated: true }), /Only one/);
  const before = [f.config.private_jwks_file, f.config.cookie_keys_file, f.config.chatgpt_client.client_secret_file].map(file => fs.readFileSync(file, "utf8"));
  const adapter = f.app.store.adapter();
  const session = new adapter("Session"), grant = new adapter("Grant"), token = new adapter("AuthorizationCode");
  await session.upsert("synthetic-record", { uid: "synthetic-session", userCode: "synthetic-user-code" }, 60);
  assert.equal((await session.findByUid("synthetic-session")).uid, "synthetic-session");
  assert.equal((await session.findByUserCode("synthetic-user-code")).uid, "synthetic-session");
  assert.equal(await token.find("synthetic-record"), undefined);
  await grant.upsert("synthetic-grant", { accountId: f.subject }, 60);
  await token.upsert("synthetic-code", { grantId: "synthetic-grant" }, 60);
  await token.consume("synthetic-code");
  await assert.rejects(() => token.consume("synthetic-code"));
  await token.upsert("synthetic-code", { grantId: "synthetic-grant" }, 60);
  assert.ok((await token.find("synthetic-code")).consumed);
  await grant.destroy("synthetic-grant");
  assert.equal(await token.find("synthetic-code"), undefined);
  await assert.rejects(() => token.upsert("delayed-stale-token", { grantId: "synthetic-grant" }, 60));
  await session.upsert("expired", { uid: "expired" }, -1);
  assert.equal(await session.find("expired"), undefined);
  await f.stop(); await f.start();
  assert.deepEqual([f.config.private_jwks_file, f.config.cookie_keys_file, f.config.chatgpt_client.client_secret_file].map(file => fs.readFileSync(file, "utf8")), before);
});

test("TOKEN-07 storage failure returns no tokens and does not clear durable authorization history", async (t) => {
  const f = await fixture(t);
  const authorization = await f.authorize();
  const count = f.app.store.db.prepare("SELECT COUNT(*) AS n FROM oauth_records").get().n;
  f.app.store.db.exec("PRAGMA query_only=ON");
  assert.equal((await fetch(`${f.config.issuer}/readyz`)).status, 503);
  const result = await f.exchange(authorization);
  assert.equal(result.status, 503);
  assert.equal(result.data.access_token, undefined);
  assert.equal(f.app.store.db.prepare("SELECT COUNT(*) AS n FROM oauth_records").get().n, count);
  f.app.store.db.exec("PRAGMA query_only=OFF");
  assert.equal((await fetch(`${f.config.issuer}/readyz`)).status, 200);
  const original = await f.exchange(authorization);
  assert.equal(original.status, 200);
  const later = await f.authorize();
  f.app.store.db.exec(`CREATE TRIGGER synthetic_reject_token BEFORE INSERT ON oauth_records
    WHEN NEW.model='AccessToken' BEGIN SELECT RAISE(ABORT, 'synthetic token storage failure'); END;`);
  const writeFailure = await f.exchange(later);
  assert.ok(writeFailure.status >= 500);
  for (const key of ["access_token", "refresh_token", "id_token"]) assert.equal(writeFailure.data[key], undefined);
  assert.equal((await f.introspect(original.data.access_token)).data.active, true);
  f.app.store.db.exec("DROP TRIGGER synthetic_reject_token");
  assert.equal((await f.exchange(await f.authorize())).status, 200);
});

test("CFG-05 OAuth storage refuses an existing business database without adding or rewriting tables", async (t) => {
  const f = await fixture(t, { start: false });
  const file = path.join(f.directory, "synthetic-business.sqlite3");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE memories (content TEXT); INSERT INTO memories VALUES ('Synthetic protected data')");
  fs.chmodSync(file, 0o600);
  assert.throws(() => new AuthStore(file), /separate OAuth database/);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ["memories"]);
  assert.equal(db.prepare("SELECT content FROM memories").get().content, "Synthetic protected data");
  db.close();
});

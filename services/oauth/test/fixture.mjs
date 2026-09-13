import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { generateKeyPairSync, createHash } from "node:crypto";
import { generate } from "otplib";
import { createOwner, Accounts } from "../src/accounts.mjs";
import { AuthStore } from "../src/sqlite-adapter.mjs";
import { createAuthorizationServer } from "../src/server.mjs";
import { randomSecret, readPrivate, writePrivate, seconds } from "../../../shared/oauth-common.mjs";

export async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function listen(server, port) { server.listen(port, "127.0.0.1"); await once(server, "listening"); }
export async function close(server) {
  if (!server.listening) return;
  const done = once(server, "close"); server.close(); server.closeAllConnections(); await done;
}

export function validatedCallback(target, issuer, request) {
  if (`${target.origin}${target.pathname}` !== request.redirect_uri || target.searchParams.get("iss") !== issuer
    || target.searchParams.get("state") !== request.state) throw new Error("Untrusted authorization callback");
  return target;
}

export function authConfiguration(directory, { authPort, gatewayPort, callbackPort }) {
  const issuer = `http://127.0.0.1:${authPort}`;
  const resource = `http://127.0.0.1:${gatewayPort}/mcp`;
  return { config_version: "mnemuron-oauth-config-v1", mode: "oauth", issuer, resource,
    listen: { host: "127.0.0.1", port: authPort }, database_file: path.join(directory, "auth.sqlite3"),
    private_jwks_file: path.join(directory, "signing.json"), cookie_keys_file: path.join(directory, "cookies.json"),
    accounts_file: path.join(directory, "account.json"), resource_scopes: ["memory:read", "project:read"], oidc_scopes: ["openid", "offline_access"],
    routes: { authorization: "/authorize", resume: "/authorize/:uid", token: "/token", jwks: "/jwks", revocation: "/revoke", introspection: "/introspect", userinfo: "/userinfo", interaction: "/interaction/:uid" },
    client_registration: { dynamic: false, cimd: false },
    chatgpt_client: { client_id: "synthetic-chatgpt", client_secret_file: path.join(directory, "chatgpt-secret"), token_endpoint_auth_method: "client_secret_post",
      redirect_uris: [`http://127.0.0.1:${callbackPort}/callback`], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      allowed_scopes: ["openid", "offline_access", "memory:read", "project:read"], pkce: { required: true, methods: ["S256"] } },
    introspection_client: { client_id: "synthetic-introspection", client_secret_file: path.join(directory, "introspection-secret"), auth_method: "client_secret_basic",
      role: "resource_server_only", allowed_resource: resource, allowed_token_kind: "access_token", allow_user_authorization: false, allow_token_issuance: false },
    token_policy: { access_token_format: "opaque", authorization_code_ttl_seconds: 60, access_token_ttl_seconds: 300,
      refresh_idle_ttl_seconds: 604800, refresh_absolute_ttl_seconds: 2592000, refresh_rotation: true, refresh_reuse_revokes_grant: true,
      interaction_ttl_seconds: 600, login_session_ttl_seconds: 28800 },
    login: { registration_enabled: false, mfa_required: true, cookie_secure: true, cookie_http_only: true, cookie_same_site: "lax", development_interactions: false },
    limits: { login_attempts_per_account_per_15min: 10, token_requests_per_client_per_minute: 60, introspection_requests_per_client_per_minute: 600, request_body_bytes: 65536 },
    reverse_proxy: { trusted_peer_addresses: ["127.0.0.1", "::1"], allowed_host: `127.0.0.1:${authPort}`, public_scheme: "https", trust_unvalidated_forwarded_headers: false },
    log: { include_tokens: false, include_request_body: false, include_querystring: false } };
}

export class Browser {
  cookies = new Map();
  constructor(origin, { transportOrigin = origin } = {}) { this.origin = origin; this.transportOrigin = transportOrigin; }
  async request(target, options = {}) {
    const url = new URL(target, this.origin);
    if (url.origin !== this.origin) throw new Error("Browser fixture will not fetch an external callback");
    const cookie = [...this.cookies.values()].filter((item) => url.pathname.startsWith(item.path)).map((item) => `${item.name}=${item.value}`).join("; ");
    const transportUrl = new URL(`${url.pathname}${url.search}`, this.transportOrigin);
    const result = await fetch(transportUrl, { ...options, redirect: "manual", headers: {
      connection: "close", host: url.host, ...options.headers, ...(cookie ? { cookie } : {}),
    } });
    for (const line of result.headers.getSetCookie()) {
      const parts = line.split(";").map((part) => part.trim());
      const first = parts[0].indexOf("=");
      const name = parts[0].slice(0, first), value = parts[0].slice(first + 1);
      const cookiePath = parts.find((part) => part.toLowerCase().startsWith("path="))?.slice(5) || "/";
      if (parts.some((part) => /^max-age=0$/i.test(part)) || !value) this.cookies.delete(`${name}:${cookiePath}`);
      else this.cookies.set(`${name}:${cookiePath}`, { name, value, path: cookiePath });
    }
    return { status: result.status, headers: result.headers, text: await result.text() };
  }
  post(target, data) {
    return this.request(target, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: this.origin }, body: new URLSearchParams(data).toString() });
  }
}

export async function fixture(t, { start = true, mutate = () => {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mnemuron-oauth-test-"));
  fs.chmodSync(directory, 0o700);
  const ports = { authPort: await freePort(), gatewayPort: await freePort(), callbackPort: await freePort() };
  const config = authConfiguration(directory, ports);
  mutate(config);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writePrivate(config.private_jwks_file, { keys: [{ ...privateKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid: "synthetic-signing-key" }] });
  writePrivate(config.cookie_keys_file, [randomSecret(), randomSecret()]);
  const secret = randomSecret(), introspectionSecret = randomSecret();
  writePrivate(config.chatgpt_client.client_secret_file, secret);
  writePrivate(config.introspection_client.client_secret_file, introspectionSecret);
  const password = `Synthetic-${randomSecret()}`;
  await createOwner(config.accounts_file, "synthetic-owner", password);
  const seed = readPrivate(config.accounts_file, { json: true }).mfa.secret;
  const enrollmentStore = new AuthStore(config.database_file);
  try { await new Accounts(config.accounts_file, enrollmentStore).enroll(await generate({ secret: seed, epoch: seconds() - 30 }), path.join(directory, "recovery.json")); }
  finally { enrollmentStore.close(); }
  const subject = readPrivate(config.accounts_file, { json: true }).subject;
  const f = { directory, config, ports, password, seed, subject, secret, introspectionSecret, browser: new Browser(config.issuer), logs: [] };
  f.start = async () => {
    f.app = createAuthorizationServer(config, { isolated: true, logger: (event) => f.logs.push(event) });
    await listen(f.app.server, ports.authPort);
  };
  f.stop = async () => { if (f.app) await close(f.app.server); };
  t.after(async () => { await f.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  f.authorize = async ({ scope = "openid offline_access memory:read project:read", params = {}, decision = "confirm", browser = f.browser } = {}) => {
    const verifier = randomSecret();
    const request = { client_id: config.chatgpt_client.client_id, redirect_uri: config.chatgpt_client.redirect_uris[0], response_type: "code", scope,
      resource: config.resource, state: randomSecret(), code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), ...params };
    let response = await browser.request(`/authorize?${new URLSearchParams(request)}`);
    for (let i = 0; i < 12; i++) {
      const location = response.headers.get("location");
      if (location) {
        const target = new URL(location, config.issuer);
        if (target.origin !== config.issuer) return { callback: validatedCallback(target, config.issuer, request), verifier, request, response };
        response = await browser.request(target);
      } else if (response.status === 200) {
        const csrf = response.text.match(/name="csrf" value="([^"]+)"/)?.[1];
        const action = response.text.match(/action="([^"]+)"/)?.[1];
        if (!csrf || !action) throw new Error(`Unexpected interaction page (${response.status})`);
        const fields = { csrf };
        if (action.endsWith("/login")) Object.assign(fields, { username: "synthetic-owner", password, otp: await generate({ secret: seed }) });
        response = await browser.post(decision === "abort" ? action.replace(/\/(login|confirm)$/, "/abort") : action, fields);
      } else throw new Error(`Authorization fixture stopped: ${response.status} ${response.text}`);
    }
    throw new Error("Authorization redirect loop");
  };
  f.token = async (body) => {
    const response = await fetch(`${config.issuer}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", connection: "close" },
      body: new URLSearchParams({ client_id: config.chatgpt_client.client_id, client_secret: secret, ...body }).toString() });
    return { status: response.status, data: await response.json() };
  };
  f.exchange = (authorization, changes = {}) => f.token({ grant_type: "authorization_code", code: authorization.callback.searchParams.get("code"),
    redirect_uri: config.chatgpt_client.redirect_uris[0], resource: config.resource, code_verifier: authorization.verifier, ...changes });
  f.introspect = async (token, { credentials = `${config.introspection_client.client_id}:${introspectionSecret}` } = {}) => {
    const response = await fetch(`${config.issuer}/introspect`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", connection: "close", authorization: `Basic ${Buffer.from(credentials).toString("base64")}` },
      body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString() });
    return { status: response.status, data: await response.json() };
  };
  if (start) await f.start();
  return f;
}

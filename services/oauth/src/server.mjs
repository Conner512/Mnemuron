import http from "node:http";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { loadAuthConfig, validateAuthConfig, loadAuthSecrets } from "./config.mjs";
import { AuthStore } from "./sqlite-adapter.mjs";
import { Accounts } from "./accounts.mjs";
import { IdentityRepository } from './identity-repository.mjs';
import {consoleRequest} from './console.mjs';
import {ConsoleCore} from './console-core.mjs';
import {sendPage,label} from '../../../web/console/render.mjs';
import { makeProvider } from "./provider.mjs";
import { interactionRequest } from "./interactions.mjs";
import { BoundaryError, SerialGate, WindowLimit, OAUTH_SCOPES, parseForm, readBody,
  requestBoundary, sendJson, equalSecret } from "../../../shared/oauth-common.mjs";
import {acquireAuthorizationLease} from './process-lease.mjs';
import {storageDoctor} from '../../../server/lib/storage-policy.mjs';
import {invalidateBrowserAuthorization} from './browser-session.mjs';

function bootstrapMetadata(config) {
  return { issuer: config.issuer, authorization_endpoint: `${config.issuer}/authorize`,
    token_endpoint: `${config.issuer}/token`, jwks_uri: `${config.issuer}/jwks`,
    response_types_supported: ["code"], response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"], scopes_supported: OAUTH_SCOPES,
    token_endpoint_auth_methods_supported: ["client_secret_post"], code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true, mnemuron_mode: "bootstrap_metadata_only" };
}

function authorizationError(response, config, params, code) {
  if (params?.get("client_id") === config.chatgpt_client.client_id
    && config.chatgpt_client.redirect_uris.includes(params.get("redirect_uri"))) {
    const callback = new URL(params.get("redirect_uri"));
    callback.searchParams.set("error", code);
    callback.searchParams.set("iss", config.issuer);
    if (params.get("state")) callback.searchParams.set("state", params.get("state"));
    response.writeHead(303, { location: callback.href, "cache-control": "no-store" });
    response.end();
  } else sendJson(response, 400, { error: code });
}

export function createAuthorizationServer(input, { isolated = false, logger = () => {} } = {}) {
  const config = validateAuthConfig(input, { isolated });
  let store, accounts, provider, secrets, release;
  try {
    if (config.mode === "oauth") {
      if(config.identity_mode==='multi_account_v1') storageDoctor({
        identity_database:config.database_file,identity_key:config.identity.encryption_key_file,
      });
      secrets = loadAuthSecrets(config);
      release = acquireAuthorizationLease(config.database_file);
      store = new AuthStore(config.database_file,{identity:config.identity_mode==='multi_account_v1'});
      accounts = config.identity_mode==='multi_account_v1' ? new IdentityRepository(store,{
        keyFile:config.identity.encryption_key_file,issuer:config.issuer,batchLimit:config.identity.invitation_batch_limit,
        sessionTtl:config.identity.console_session_ttl_seconds}) : new Accounts(config.accounts_file, store);
      if(config.identity_mode==='legacy_owner') accounts.read();
      else store.identity=accounts;
      provider = makeProvider(config, secrets, store, accounts);
    }
  } catch (error) { store?.close(); release?.(); throw error; }
  const gate = new SerialGate();
  const consoleGate = new SerialGate();
  const limits = new WindowLimit();
  const callback = provider?.callback();
  const origin = new URL(config.issuer);
  const server = http.createServer(async (request, response) => {
    const requestId = randomUUID();
    const started = Date.now();
    let errorCode;
    response.setHeader("x-request-id", requestId);
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    response.on("finish", () => logger({ time: new Date().toISOString(), request_id: requestId, component: "oauth",
      status: response.statusCode, duration_ms: Date.now() - started,
      error_code: errorCode || (response.statusCode >= 400 ? "AUTH_REQUEST_REJECTED" : undefined) }));
    try {
      const url = requestBoundary(request, origin, { isolated });
      limits.take(`peer:${request.socket.remoteAddress}`, 1500);
      if (request.method === "GET" && ["/livez", "/readyz"].includes(url.pathname)) {
        const ready = config.mode === "oauth" && store.ready({ writeProbe: url.pathname === "/readyz" })
          && (config.identity_mode==='multi_account_v1' || accounts.read().enabled);
        return sendJson(response, url.pathname === "/livez" || ready ? 200 : 503,
          { service: "mnemuron-oauth", mode: config.mode, ready, production_ready: false });
      }
      const discovery = ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"].includes(url.pathname);
      if (config.mode !== "oauth") {
        if (discovery && request.method === "GET") return sendJson(response, 200, bootstrapMetadata(config));
        if (["/authorize", "/token", "/introspect", "/revoke", "/jwks"].includes(url.pathname)
          || /^\/(interaction|authorize)\//.test(url.pathname)) {
          return sendJson(response, 503, { error: "temporarily_unavailable", error_code: "OAUTH_NOT_CONFIGURED" });
        }
        throw new BoundaryError(404, "NOT_FOUND");
      }
      if (discovery && request.method === "GET") {
        // RFC 8414 uses the live OIDC document, not a second hand-maintained capabilities list.
        request.url = "/.well-known/openid-configuration";
        return callback(request, response);
      }
      const handleConsole=()=>consoleRequest(request,response,{config,accounts,store,url,
        invalidateAuthorization:nextSubject=>invalidateBrowserAuthorization(request,response,provider,{nextSubject}),coreFor:subject=>new ConsoleCore(config.identity?.core,
        accounts.principal(subject),accounts.bindings(subject).find(b=>b.purpose==='console'))});
      if(await (request.method==='POST'&&/^\/(register|login)(\/|$)/.test(url.pathname)?consoleGate.run(handleConsole):handleConsole()))return;
      if (url.pathname.startsWith("/interaction/")) {
        return await gate.run(() => interactionRequest(request, response, { provider, store, accounts, config, url }));
      }
      if (request.method === "GET" && url.pathname === "/jwks") return callback(request, response);
      const initialAuthorization = url.pathname === "/authorize" && ["GET", "POST"].includes(request.method);
      const resume = /^\/authorize\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname) && request.method === "GET";
      const protocolPost = ["/token", "/introspect", "/revoke"].includes(url.pathname) && request.method === "POST";
      if (!initialAuthorization && !resume && !protocolPost) throw new BoundaryError(404, "NOT_FOUND");
      let params = parseForm(url.search.slice(1));
      if (request.method === "POST") {
        if (url.search || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers["content-type"] || "")) {
          throw new BoundaryError(400, "FORM_REQUIRED");
        }
        // The provider supports pre-parsed raw form bodies. Preserve the original bytes and reject duplicates before dispatch.
        request.body = await readBody(request, Math.min(56 * 1024, config.limits.request_body_bytes));
        params = parseForm(request.body);
      }
      if (initialAuthorization) {
        if (params.get("client_id") !== config.chatgpt_client.client_id) return authorizationError(response, config, params, "invalid_client");
        if (params.get("resource") !== config.resource) return authorizationError(response, config, params, "invalid_target");
        const scopes = (params.get("scope") || "").split(" ").filter(Boolean);
        if (scopes.some((scope) => !OAUTH_SCOPES.includes(scope))) return authorizationError(response, config, params, "invalid_scope");
        if (params.has("response_mode") && params.get("response_mode") !== "query") return authorizationError(response, config, params, "unsupported_response_mode");
        // OIDC requires explicit consent for offline access. Enforce that interaction even when the host omits prompt.
        if (scopes.includes("offline_access")) {
          const prompts = (params.get("prompt") || "").split(" ").filter(Boolean);
          if (prompts.includes("none")) return authorizationError(response, config, params, "interaction_required");
          params.set("prompt", [...new Set([...prompts, "consent"])].join(" "));
          if (request.method === "GET") request.url = `/authorize?${params}`;
          else request.body = params.toString();
        }
      }
      if (url.pathname === "/introspect") {
        const basic = `Basic ${Buffer.from(`${config.introspection_client.client_id}:${secrets.introspectionSecret}`).toString("base64")}`;
        if (!equalSecret(request.headers.authorization || "", basic) || params.has("client_secret") || params.has("client_id")) {
          throw new BoundaryError(401, "INVALID_INTROSPECTION_CLIENT");
        }
        store.limit("introspection", config.limits.introspection_requests_per_client_per_minute);
        if (params.get("token")?.includes(".")) return sendJson(response, 200, { active: false });
        return await callback(request, response);
      }
      if (protocolPost) {
        if (request.headers.authorization || params.get("client_id") !== config.chatgpt_client.client_id) {
          return sendJson(response, 401, { error: "invalid_client" });
        }
        store.limit("token", config.limits.token_requests_per_client_per_minute);
        if (url.pathname === "/token") {
          if (!["authorization_code", "refresh_token"].includes(params.get("grant_type"))) return sendJson(response, 400, { error: "unsupported_grant_type" });
          if ((params.get("grant_type") === "authorization_code" || params.has("resource")) && params.get("resource") !== config.resource) {
            return sendJson(response, 400, { error: "invalid_target" });
          }
        }
      }
      return await gate.run(() => callback(request, response));
    } catch (error) {
      errorCode = error instanceof BoundaryError ? error.code : "AUTH_DEPENDENCY_UNAVAILABLE";
      const route=request.url.split('?')[0],interaction=route.match(/^\/interaction\/([A-Za-z0-9_-]{1,128})(?:\/(login|confirm|abort))?$/);
      if(!response.headersSent&&config.identity_mode==='multi_account_v1'&&request.headers.accept?.includes('text/html')
        && (/^\/(register|login|recover)(\/|$)/.test(route)||interaction)) {
        const status=error instanceof BoundaryError?error.status:503;
        const restart=['AUTHORIZATION_RESTART_REQUIRED','INTERACTION_EXPIRED','INTERACTION_MISMATCH'].includes(errorCode);
        const message=restart?'restartAuthorization':errorCode==='LOGIN_FAILED'?'loginFailed':status===429?'rateLimited':status>=500?'unavailable':errorCode==='BLOCKED_POLICY'?'blockedNote':'pendingStep';
        const back=interaction&&!restart?`/interaction/${interaction[1]}`:route.startsWith('/register')?'/register':'/login';
        const navigation=interaction&&restart?label('oauthRestartHelp','p'):`<a href="${back}">${label(interaction?'oauthRetry':'back')}</a>`;
        sendPage(response,{title:'error',auth:true,authPurpose:interaction?'oauth':'console',body:`<div role="alert">${label(message,'p')}</div>${navigation}`},{status});return;
      }
      if (!response.headersSent) sendJson(response, error instanceof BoundaryError ? error.status : 503,
        { error: error instanceof BoundaryError && error.status < 500 ? "invalid_request" : "temporarily_unavailable",
          error_code: error instanceof BoundaryError ? error.code : "AUTH_DEPENDENCY_UNAVAILABLE" });
      else if (!response.writableEnded) response.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxRequestsPerSocket = 100;
  const maintenance = store ? setInterval(() => { try { store.cleanup(); } catch { logger({ component: "oauth", error_code: "AUTH_STORAGE_UNAVAILABLE" }); } }, 60000) : null;
  maintenance?.unref();
  server.on("close", () => { clearInterval(maintenance); store?.close(); release?.(); });
  return { server, config, store, accounts, provider };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const file = process.env.MNEMURON_OAUTH_CONFIG;
    if (!file) throw new Error("MNEMURON_OAUTH_CONFIG is required");
    const isolated = process.argv.includes("--isolated-fixture");
    const config = loadAuthConfig(file, { isolated });
    const { server } = createAuthorizationServer(config, { isolated, logger: (event) => console.log(JSON.stringify(event)) });
    server.listen(config.listen.port, config.listen.host);
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close());
  } catch { console.error("OAuth startup refused. Validate configuration and private file permissions with the local admin CLI."); process.exitCode = 1; }
}

import http from "node:http";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { BoundaryError, WindowLimit, RESOURCE_SCOPES, OAUTH_SCOPES, requestBoundary, sendJson, readBody, secretHash, requireConfig } from "../../../shared/oauth-common.mjs";
import { validateGatewayConfig, loadGatewayConfig, loadIdentityMap } from "./config.mjs";
import { GatewayAuthorization } from "./authorization.mjs";
import { ReadonlyCoreClient } from "./core-client.mjs";
import { createMcpServer, toolDefinitions, enabledTools } from "./tools.mjs";
import {requireScope} from './authorization.mjs';
import {readObservation} from './read-audit.mjs';

export function createGateway(input, { isolated = false, logger = () => {} } = {}) {
  const config = validateGatewayConfig(input, { isolated });
  const authorization = config.mode === "oauth" ? new GatewayAuthorization(config) : null;
  const core = config.mode === "oauth" && config.tool_profile === "readonly" ? new ReadonlyCoreClient(config) : null;
  requireConfig(!core || core.token !== authorization.secret, "separate introspection and core credentials");
  const origin = new URL(config.resource);
  const metadataUrl = `${origin.origin}${config.protected_resource_metadata_path}`;
  const challenge = `Bearer resource_metadata="${metadataUrl}", scope="${OAUTH_SCOPES.join(" ")}"`;
  const limits = new WindowLimit();
  const concurrent = new Map();
  const server = http.createServer(async (request, response) => {
    const requestId = randomUUID();
    const started = Date.now();
    let key;
    let errorCode, tool;
    let connectionId,read,readOutcome='not_executed',logged=false;
    let ownsSlot = false;
    response.setHeader("x-request-id", requestId);
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const record = transportOutcome => {
      if(logged)return;logged=true;
      logger({ schema_version:'web-read-audit-v1',time: new Date().toISOString(), request_id: requestId, component: "web",
      status: response.statusCode, duration_ms: Date.now() - started, subject_hash: key, tool,
      connection_id:connectionId,connection_kind:'oauth_client_subject',physical_device_verified:false,
      transport_outcome:transportOutcome,read_outcome:readOutcome,client_consumption_verified:false,read,
      error_code: errorCode || (response.statusCode >= 400 ? "MCP_REQUEST_REJECTED" : undefined) });
    };
    response.on('finish',()=>record('response_finished'));
    response.on('close',()=>record('connection_closed'));
    try {
      const url = requestBoundary(request, origin, { isolated });
      // Shared-host browser cookies belong to the AS, never to MCP authentication or the SDK.
      delete request.headers.cookie;
      delete request.headers.cookie2;
      for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
        if (["cookie", "cookie2"].includes(request.rawHeaders[index].toLowerCase())) request.rawHeaders.splice(index, 2);
      }
      limits.take(`peer:${request.socket.remoteAddress}`, 600);
      if (request.method === "GET" && [config.protected_resource_metadata_path, "/.well-known/oauth-protected-resource"].includes(url.pathname)) {
        return sendJson(response, 200, { resource: config.resource, authorization_servers: [config.issuer],
          scopes_supported: RESOURCE_SCOPES, bearer_methods_supported: ["header"] });
      }
      if (request.method === "GET" && ["/livez", "/readyz"].includes(url.pathname)) {
        let ready = false;
        if (url.pathname === "/readyz" && authorization) {
          await authorization.metadata();
          const mapping = loadIdentityMap(config);
          if (!mapping.enabled) throw new BoundaryError(503, "SUBJECT_DISABLED");
          if (core) await core.ready(mapping);
          ready = true;
        }
        return sendJson(response, url.pathname === "/livez" || ready ? 200 : 503,
          { service: "mnemuron-web", mode: config.mode, tool_profile: config.tool_profile, ready, production_ready: false });
      }
      if (url.pathname !== "/mcp") throw new BoundaryError(404, "NOT_FOUND");
      if (!authorization) throw new BoundaryError(401, "AUTH_REQUIRED");
      const auth = await authorization.verify(request);
      connectionId=auth.connection_id;
      key = secretHash(`${config.issuer}|${auth.mapping.subject}`);
      limits.take(`subject:${key}`, config.limits.requests_per_subject_per_minute);
      if ((concurrent.get(key) || 0) >= config.limits.concurrent_requests_per_subject) throw new BoundaryError(429, "BUSY");
      concurrent.set(key, (concurrent.get(key) || 0) + 1);
      ownsSlot = true;
      if (request.method !== "POST") throw new BoundaryError(405, "METHOD_NOT_ALLOWED");
      if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] || "")) throw new BoundaryError(415, "JSON_REQUIRED");
      const accept = request.headers.accept || "";
      if (!accept.includes("application/json") || !accept.includes("text/event-stream")) throw new BoundaryError(406, "MCP_ACCEPT_REQUIRED");
      if (request.headers["mcp-protocol-version"] && !SUPPORTED_PROTOCOL_VERSIONS.includes(request.headers["mcp-protocol-version"])) {
        throw new BoundaryError(400, "UNSUPPORTED_PROTOCOL_VERSION");
      }
      let body;
      try { body = JSON.parse(await readBody(request, config.limits.request_body_bytes)); }
      catch (error) { if (error instanceof BoundaryError) throw error; throw new BoundaryError(400, "INVALID_JSON"); }
      if (!body || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0") {
        throw new BoundaryError(400, "INVALID_MCP_REQUEST");
      }
      if (body.id !== undefined && !((typeof body.id === "string" && Buffer.byteLength(body.id) <= 128) || Number.isSafeInteger(body.id))) {
        throw new BoundaryError(400, "INVALID_MCP_REQUEST_ID");
      }
      if (body.method === "tools/call") {
        if (body.id === undefined || !body.params || typeof body.params.name !== "string") throw new BoundaryError(400, "INVALID_MCP_REQUEST");
        if (enabledTools(config).includes(body.params.name)) tool = body.params.name;
        if(tool)requireScope(auth,toolDefinitions[tool].scope);
      }
      const mcp = createMcpServer({ config, auth, core, id:body.id,
        onError:code=>{errorCode=code;readOutcome='tool_error';},
        onResult:(name,result)=>{read=readObservation(name,result);readOutcome='success';} });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const closed = () => { void transport.close(); void mcp.close(); };
      response.once("close", closed);
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      const status = error instanceof BoundaryError ? error.status : 503;
      const code = error instanceof BoundaryError ? error.code : "GATEWAY_UNAVAILABLE";
      errorCode = code;
      if (!response.headersSent) sendJson(response, status, { error_code: code },
        status === 401 ? { "www-authenticate": `${challenge}${code === "INVALID_TOKEN" ? ', error="invalid_token"' : ""}` }
          : status === 403 && code === "INSUFFICIENT_SCOPE" ? { "www-authenticate":
            `Bearer resource_metadata="${metadataUrl}", scope="${error.requiredScope}", error="insufficient_scope"` } : {});
      else if (!response.writableEnded) response.end();
    } finally {
      if (ownsSlot) {
        const remaining = concurrent.get(key) - 1;
        if (remaining) concurrent.set(key, remaining); else concurrent.delete(key);
      }
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.maxRequestsPerSocket = 100;
  return { server, config, authorization, core };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const file = process.env.MNEMURON_WEB_CONFIG;
    if (!file) throw new Error("MNEMURON_WEB_CONFIG is required");
    const isolated = process.argv.includes("--isolated-fixture");
    const config = loadGatewayConfig(file, { isolated });
    const { server } = createGateway(config, { isolated, logger: (event) => console.log(JSON.stringify(event)) });
    server.listen(config.listen.port, config.listen.host);
    for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close());
  } catch { console.error("Gateway startup refused. Validate configuration, identity mapping and private file permissions."); process.exitCode = 1; }
}

import http from "node:http";
import { fetchJson, requireConfig } from "../../../shared/oauth-common.mjs";

export async function fetchAuthorizationJson(config, endpoint, options = {}) {
  const metadata = endpoint === config.authorization_server_metadata_url;
  requireConfig(metadata || endpoint === config.introspection.endpoint, "fixed authorization transport endpoint");
  requireConfig(metadata ? !options.method || options.method === "GET" : options.method === "POST", "authorization transport method");
  const limits = { timeoutMs: config.introspection.timeout_ms, maxBytes: config.introspection.max_response_bytes };
  const transport = config.authorization_server_transport;
  if (!transport || transport.mode === "issuer_url") return fetchJson(endpoint, options, limits);
  requireConfig(transport.mode === "loopback_http" && transport.host === "127.0.0.1"
    && Number.isInteger(transport.port) && transport.port >= 1 && transport.port <= 65535
    && transport.port !== config.listen.port, "authorization loopback transport");
  // Only these two backend requests change destination. Public identities and redirects never do.
  const headers = { host: new URL(config.issuer).host, accept: "application/json" };
  if (!metadata) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    headers.authorization = options.headers.authorization;
  }
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: "127.0.0.1", port: transport.port,
      path: metadata ? "/.well-known/oauth-authorization-server" : "/introspect",
      method: metadata ? "GET" : "POST", headers, agent: false,
      signal: AbortSignal.timeout(limits.timeoutMs), maxHeaderSize: 16384,
    }, async (response) => {
      try {
        if ((response.statusCode >= 300 && response.statusCode < 400)
          || !/^application\/json\b/i.test(response.headers["content-type"] || "")) {
          throw new Error("Invalid authorization dependency response");
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response) {
          size += chunk.length;
          if (size > limits.maxBytes) throw new Error("Authorization dependency response limit");
          chunks.push(chunk);
        }
        resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch (error) { reject(error); }
      finally { response.destroy(); }
    });
    request.on("error", reject);
    request.end(metadata ? undefined : options.body);
  });
}

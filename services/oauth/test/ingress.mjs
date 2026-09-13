import fs from "node:fs";
import http from "node:http";

// Exercise the documented Cloudflare path expressions without a public tunnel.
export function testIngress(origin, ports) {
  const template = fs.readFileSync(new URL("../../../docs/chatgpt-web-oauth-v0.1/config/cloudflared.ingress.example.yml", import.meta.url), "utf8");
  const rules = [...template.matchAll(/    path: '([^']+)'\n    service: http:\/\/127\.0\.0\.1:(47832|47833)/g)]
    .map((match) => ({ pattern: new RegExp(match[1]), port: match[2] === "47832" ? ports.gatewayPort : ports.authPort }));
  if (rules.length !== 4 || !template.includes("- service: http_status:404")) throw new Error("Unrecognized ingress fixture");
  const host = new URL(origin).host;
  return http.createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    if (request.headers.host !== host || !request.url.startsWith("/") || request.url.startsWith("//")) {
      response.writeHead(400); response.end(); return;
    }
    const rule = rules.find((entry) => entry.pattern.test(new URL(request.url, origin).pathname));
    if (!rule) { response.writeHead(404); response.end(); return; }
    const forward = http.request({ hostname: "127.0.0.1", port: rule.port, path: request.url,
      method: request.method, headers: request.headers, timeout: 5000 }, (upstream) => {
      response.writeHead(upstream.statusCode, upstream.headers);
      upstream.pipe(response);
    });
    forward.on("timeout", () => forward.destroy());
    forward.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on("aborted", () => forward.destroy());
    request.pipe(forward);
  });
}

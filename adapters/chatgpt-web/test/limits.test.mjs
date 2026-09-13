import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gatewayFixture } from "./fixture.mjs";
import { memoryFixture } from "../../../server/test/helpers/core-memory-fixture.mjs";

test("MCP-05/08 full wire-response budget, protocol preflight and concurrent backpressure", async (t) => {
  const core = await memoryFixture(t);
  const f = await gatewayFixture(t, { profile: "readonly", coreFixture: core, mutate: c => {
    c.limits.concurrent_requests_per_subject = 1; c.limits.tool_response_bytes = 8192;
  } });
  const token = (await f.exchange(await f.authorize())).data.access_token;
  let enter, release, calls = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  f.gateway.core.call = async () => { calls++; enter(); await wait; return { status: "preview" }; };
  const params = { name: "mnemuron_preview_project_context", arguments: { query: "synthetic" } };
  const first = f.mcp("tools/call", params, token);
  try {
    await entered;
    assert.equal((await f.mcp("tools/list", undefined, token)).status, 429);
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal((await f.mcp("tools/call", params, token, { headers: { accept: "application/json" } })).status, 406);
  assert.equal(calls, 1);
  f.gateway.core.call = async () => ({ status: "preview", synthetic_padding: "x".repeat(5000) });
  const oversized = await f.mcp("tools/call", params, token);
  assert.equal(oversized.status, 422);
  assert.equal(oversized.data.error_code, "TOOL_RESPONSE_TOO_LARGE");
  f.gateway.core.call = async () => ({ status: "preview", synthetic_padding: "x".repeat(1000) });
  const bounded = await f.mcp("tools/call", params, token);
  assert.equal(bounded.status, 200);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.data)) <= f.gatewayConfig.limits.tool_response_bytes);
  const invalidId = await fetch(f.gatewayConfig.resource, { method: "POST", headers: {
    authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: "x".repeat(129), method: "tools/call", params }) });
  assert.equal(invalidId.status, 400);
});

test("MCP-08 per-subject rate limits and physical duplicate Authorization headers", async (t) => {
  const f = await gatewayFixture(t, { mutate: c => { c.limits.requests_per_subject_per_minute = 2; } });
  const token = (await f.exchange(await f.authorize())).data.access_token;
  const status = await new Promise((resolve, reject) => {
    const url = new URL(f.gatewayConfig.resource);
    const request = http.request(url, { method: "POST", headers: ["Host", url.host,
      "Authorization", `Bearer ${token}`, "Authorization", `Bearer ${token}`, "Content-Length", "0"] }, response => {
      response.resume(); response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject); request.end();
  });
  assert.equal(status, 400);
  assert.equal((await f.mcp("tools/list", undefined, token)).status, 200);
  assert.equal((await f.mcp("tools/list", undefined, token)).status, 200);
  assert.equal((await f.mcp("tools/list", undefined, token)).status, 429);
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { callTool } from "../../plugins/mnemuron/scripts/mcp-core.mjs";
import { memoryFixture } from "./helpers/core-memory-fixture.mjs";

function remoteEnv(f) {
  return {
    MNEMURON_MODE: "remote", MNEMURON_CONFIG_PATH: path.join(f.root, "missing.json"),
    MNEMURON_SPIKE_DATA_DIR: f.root, MNEMURON_SERVER_URL: f.baseUrl,
    MNEMURON_ALLOW_INSECURE_HTTP: "true", MNEMURON_API_KEY: f.a.api_key,
    MNEMURON_PROJECT_ID: f.beta.project_id, MNEMURON_TASK_ID: f.beta.task_id,
    MNEMURON_WORKSTREAM_ID: f.beta.task_id + "-one", CODEX_THREAD_ID: "",
  };
}

async function mcpRemember(t, env, body) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../plugins/mnemuron/scripts/mcp-server.mjs", import.meta.url))], { env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { errors += chunk; });
  const stopped = once(child, "close");
  child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mnemuron_remember", arguments: body } }) + "\n");
  assert.equal((await stopped)[0], 0, errors);
  return JSON.parse(output).result;
}

test("V-04 I-12: ChatGPT MCP exposes stable retry IDs and leaves explicit parent resolution to core", async t => {
  const f = await memoryFixture(t), env = remoteEnv(f);
  const body = { content: "explicit parent", scope: "project", task_id: f.alpha.task_id, operation_id: "mcp-original" };
  const saved = await mcpRemember(t, env, body);
  assert.equal(saved.structuredContent.memory.project_id, f.alpha.project_id);
  assert.equal(saved.structuredContent.memory.workstream_id, null);
  const conflict = await mcpRemember(t, env, { ...body, content: "changed intent" });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.error_code, "IDEMPOTENCY_CONFLICT");
  assert.equal(conflict.structuredContent.operation_id, body.operation_id);
  const replay = await mcpRemember(t, env, body);
  assert.equal(replay.structuredContent.memory.memory_id, saved.structuredContent.memory.memory_id);
  assert.equal(replay.structuredContent.idempotent, true);
  const local = { ...env, MNEMURON_MODE: "local-spike" };
  await assert.rejects(callTool("mnemuron_remember", { scope: "user", content: "local", operation_id: "unsupported-local" }, local), /local-spike does not provide/);
});

test("I-12 V-09: OpenClaw native tool and command retain operation IDs without changing scope", async t => {
  const f = await memoryFixture(t), registered = new Map();
  const entry = new URL("../../adapters/openclaw/dist/index.js", import.meta.url);
  const sdkImport = 'import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";';
  const source = readFileSync(entry, "utf8");
  assert.ok(source.includes(sdkImport));
  const stubbed = source.replace(sdkImport, "const definePluginEntry = entry => entry;")
    .replace('"./client.js"', JSON.stringify(new URL("./client.js", entry).href));
  const { default: plugin } = await import("data:text/javascript;base64," + Buffer.from(stubbed).toString("base64"));
  const keyFile = path.join(f.root, "synthetic.key");
  writeFileSync(keyFile, f.a.api_key, { mode: 0o600 });
  let command;
  plugin.register({
    pluginConfig: {
      serverUrl: f.baseUrl, apiKeyFile: keyFile, allowInsecureHttp: true,
      outboxDir: path.join(f.root, "outbox"), pendingResumeDir: path.join(f.root, "pending"),
      taskScopeDir: path.join(f.root, "scopes"), deviceId: "device-agent-a",
      agentId: "test", agentInstanceId: "agent-a", projectId: f.beta.project_id,
      taskId: f.beta.task_id, workstreamId: f.beta.task_id + "-one",
    },
    on() {},
    logger: { info() {}, warn() {} },
    registerTool(factory, { names }) { for (const name of names) registered.set(name, factory); },
    registerCommand(value) { command = value; },
  });
  const tool = registered.get("mnemuron_remember")({});
  assert.ok(tool.parameters.properties.operation_id);
  const params = { content: "native tool", scope: "project", task_id: f.alpha.task_id, operation_id: "native-tool" };
  const saved = (await tool.execute("synthetic-call", params)).details;
  assert.equal(saved.memory.project_id, f.alpha.project_id);
  assert.equal(saved.memory.scope, "project");
  const replay = (await tool.execute("separate-call", params)).details;
  assert.equal(replay.memory.memory_id, saved.memory.memory_id);
  assert.equal(replay.idempotent, true);
  const context = { args: "remember --operation-id native-command native content", sessionId: "synthetic-session" };
  assert.match((await command.handler(context)).text, /已保存/);
  assert.match((await command.handler(context)).text, /已保存/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE source='explicit-openclaw-command'").get().n, 1);
  const failure = await command.handler({ ...context, args: "remember --operation-id native-command changed content" });
  assert.match(failure.text, /native-command/);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n, 2);
});

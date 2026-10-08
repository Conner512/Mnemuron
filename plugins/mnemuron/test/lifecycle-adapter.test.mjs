// Project lifecycle through the MCP plugin against a real synthetic Core over HTTP (phase 5H, LA-01..LA-02).
// The lifecycle state is produced by the real Console delete/merge actions (5E; the BFF factor gate is covered in
// services/oauth). Old, new and inferred IDs, two owners, restart of the Core on the same database. Synthetic only.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMnemuronApp } from "../../../server/lib/app.mjs";
import { CONSOLE_WRITE_SCOPES } from "../../../shared/console-contract.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP = path.join(PLUGIN_ROOT, "scripts", "mcp-server.mjs");
const HOOK = path.join(PLUGIN_ROOT, "scripts", "launch-hook");

function startMcp(env) {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "", id = 1, stderr = "";
  const pending = new Map();
  child.stderr.setEncoding("utf8"); child.stderr.on("data", c => { stderr += c; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { buffer += chunk; let n;
    while ((n = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); if (!line) continue;
      const response = JSON.parse(line), waiter = pending.get(response.id); if (waiter) { clearTimeout(waiter.timer); pending.delete(response.id); waiter.resolve(response); } } });
  const request = (method, params = {}) => new Promise((resolve, reject) => { const requestId = id++;
    const timer = setTimeout(() => reject(new Error(`MCP timeout: ${stderr}`)), 8000); pending.set(requestId, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`); });
  return { child, request, call: async (name, args) => (await request("tools/call", { name, arguments: args })).result };
}
function runHook(payload, env) {
  return new Promise((resolve, reject) => { const child = spawn(HOOK, [], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    child.on("error", reject); child.on("close", status => resolve({ status, stdout, stderr })); child.stdin.end(JSON.stringify(payload)); });
}
const code = result => result?.structuredContent?.error_code ?? JSON.parse(result?.content?.[0]?.text || "{}").error_code;

async function world(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-lifecycle-plugin-")), databasePath = path.join(root, "server.sqlite3");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let app = createMnemuronApp({ databasePath });
  const start = async () => { const address = await app.listen({ host: "127.0.0.1", port: 0 }); return `http://127.0.0.1:${address.port}`; };
  let serverUrl = await start();
  t.after(async () => { await app.close(); });
  const bootstrap = app.store.authenticate(app.store.bootstrapAdmin().api_key);
  // A synthetic owner credential that may write projects, tasks and memories for seeding.
  const adminKey = app.store.issueCredential({ userId: bootstrap.user_id, deviceId: "lifecycle-seed", agentId: "synthetic", agentInstanceId: "lifecycle-seed", scopes: ["admin:tasks", "memory:read", "memory:write"] }).api_key;
  const admin = app.store.authenticate(adminKey);
  const agent = app.store.registerAgent(bootstrap, { device_id: "lifecycle-device", agent_id: "chatgpt", agent_instance_id: "lifecycle-agent" });
  const task = (id, project) => app.store.upsertTask(admin, { task_id: id, project_id: project, project_name: `Lifecycle ${project}`, title: `Lifecycle ${id}`, goal: "Synthetic lifecycle adapter check", status: "active", workstreams: [{ workstream_id: `${id}-ws`, name: "ws", status: "active" }] });
  for (const p of ["plug-live", "plug-dead", "plug-src", "plug-tgt"]) task(`task-${p}`, p);
  const save = (project, text) => app.store.saveMemory(admin, { scope: "project", project_id: project, content: `PLUGMARK ${text}` }).memory.memory_id;
  const m = { live: save("plug-live", "live record"), dead: save("plug-dead", "deleted record"), src: save("plug-src", "source record"), tgt: save("plug-tgt", "target record") };
  // Lifecycle state through the real Console actions (preview → confirm).
  const consoleKey = app.store.issueCredential({ userId: admin.user_id, deviceId: "lifecycle-console", agentId: "mnemuron-console", agentInstanceId: "lifecycle-console", scopes: [...CONSOLE_WRITE_SCOPES] });
  const act = (auth, action, payload) => app.store.consoleService.execute(auth, { action, operation_id: randomUUID(), payload });
  const writer = app.store.authenticate(consoleKey.api_key);
  let p = await act(writer, "projects.lifecycle_preview", { action: "delete", project_id: "plug-dead" });
  await act(writer, "projects.lifecycle_delete", { preview_id: p.preview_id, confirm_name: "Lifecycle plug-dead" });
  p = await act(writer, "projects.lifecycle_preview", { action: "merge", project_id: "plug-src", target_project_id: "plug-tgt" });
  await act(writer, "projects.merge", { preview_id: p.preview_id });
  const env = { MNEMURON_CONFIG_PATH: path.join(root, "missing-config.json"), MNEMURON_BACKGROUND_SYNC: "false", MNEMURON_MODE: "remote", MNEMURON_ALLOW_INSECURE_HTTP: "true",
    MNEMURON_RAW_RETENTION_DAYS: "30", MNEMURON_API_KEY: agent.api_key, MNEMURON_SPIKE_DATA_DIR: path.join(root, "agent"), MNEMURON_DEVICE_ID: "lifecycle-device",
    MNEMURON_AGENT_ID: "chatgpt", MNEMURON_AGENT_INSTANCE_ID: "lifecycle-agent", MNEMURON_DEFAULT_PROJECT_ID: "plug-src", MNEMURON_DEFAULT_TASK_ID: "task-plug-src", MNEMURON_DEFAULT_WORKSTREAM_ID: "task-plug-src-ws" };
  const restart = async () => { await app.close(); app = createMnemuronApp({ databasePath }); serverUrl = await start(); return serverUrl; };
  return { get app() { return app; }, get serverUrl() { return serverUrl; }, admin, adminKey, m, env, root, restart };
}

test("LA-01: the MCP plugin sees deleted projects as PROJECT_DELETED, merged IDs as their canonical group, and its writes and captures route", async t => {
  const w = await world(t);
  const mcp = startMcp({ ...w.env, MNEMURON_SERVER_URL: w.serverUrl }); t.after(() => mcp.child.kill());
  await mcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "0" } });
  const search = args => mcp.call("mnemuron_search_memories", { query: "PLUGMARK", ...args });
  const ids = r => (r.structuredContent?.results || []).map(x => x.memory_id).sort();
  const dead = await search({ project_id: "plug-dead" });
  assert.equal(dead.isError, true); assert.equal(code(dead), "PROJECT_DELETED");
  assert.deepEqual(ids(await search({ project_id: "plug-src" })), [w.m.src, w.m.tgt].sort(), "an old merged ID reads the canonical group");
  assert.ok(!ids(await search({})).includes(w.m.dead), "unscoped search never returns the deleted project's record");
  const context = await mcp.call("mnemuron_preview_project_context", { query: "plug-dead", signals: { project_id: "plug-dead" } });
  assert.equal(context.isError, true); assert.equal(code(context), "PROJECT_DELETED");
  // A memory written through the old ID lands in the canonical project.
  const remembered = await mcp.call("mnemuron_remember", { content: "PLUGMARK remembered through the old ID", memory_type: "fact", scope: "project", project_id: "plug-src" });
  assert.notEqual(remembered.isError, true, JSON.stringify(remembered));
  const stored = w.app.store.db.prepare("SELECT project_id FROM memories WHERE content='PLUGMARK remembered through the old ID'").get();
  assert.equal(stored.project_id, "plug-tgt");
  const refused = await mcp.call("mnemuron_remember", { content: "PLUGMARK never stored", memory_type: "fact", scope: "project", project_id: "plug-dead" });
  assert.equal(refused.isError, true); assert.equal(code(refused), "PROJECT_DELETED");
  // A hook capture with the old ID and its source-origin Task: the event lands in the canonical project; the raw payload keeps the old ID.
  const hook = await runHook({ hook_event_name: "Stop", session_id: "session-lifecycle", turn_id: "turn-1", project_id: "plug-src", task_id: "task-plug-src", workstream_id: "task-plug-src-ws",
    last_assistant_message: "已完成：lifecycle routed capture" }, { ...w.env, MNEMURON_SERVER_URL: w.serverUrl });
  assert.equal(hook.status, 0, hook.stderr);
  const event = w.app.store.db.prepare("SELECT project_id,raw_payload_json FROM events WHERE session_id='session-lifecycle' ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(event?.project_id, "plug-tgt"); assert.match(event.raw_payload_json, /plug-src/);
  assert.equal(w.app.store.db.prepare("SELECT project_id FROM tasks WHERE task_id='task-plug-src'").get().project_id, "plug-src", "the Task keeps its origin");
});

test("LA-02: after a Core restart on the same database the plugin still sees the enforced state; another owner sees nothing of it", async t => {
  const w = await world(t);
  const url = await w.restart();
  const mcp = startMcp({ ...w.env, MNEMURON_SERVER_URL: url }); t.after(() => mcp.child.kill());
  await mcp.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "0" } });
  const dead = await mcp.call("mnemuron_search_memories", { query: "PLUGMARK", project_id: "plug-dead" });
  assert.equal(code(dead), "PROJECT_DELETED", "the deleted state survived the restart");
  const merged = await mcp.call("mnemuron_search_memories", { query: "PLUGMARK", project_id: "plug-src" });
  assert.deepEqual((merged.structuredContent?.results || []).map(x => x.memory_id).sort(), [w.m.src, w.m.tgt].sort());
  // Another owner: generic not found for the first owner's IDs, never PROJECT_DELETED, and no records.
  const store = w.app.store, otherAdmin = store.issueCredential({ userId: "lifecycle-other-owner", deviceId: "other-device", agentId: "chatgpt", agentInstanceId: "other-agent", scopes: ["memory:read", "memory:write", "capture:write", "resume:read"] });
  const other = startMcp({ ...w.env, MNEMURON_SERVER_URL: url, MNEMURON_API_KEY: otherAdmin.api_key, MNEMURON_SPIKE_DATA_DIR: path.join(w.root, "other"), MNEMURON_DEVICE_ID: "other-device", MNEMURON_AGENT_INSTANCE_ID: "other-agent" });
  t.after(() => other.child.kill());
  await other.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "0" } });
  const foreign = await other.call("mnemuron_search_memories", { query: "PLUGMARK", project_id: "plug-dead" });
  assert.equal(foreign.isError, true); assert.notEqual(code(foreign), "PROJECT_DELETED");
  const unscoped = await other.call("mnemuron_search_memories", { query: "PLUGMARK" });
  assert.equal((unscoped.structuredContent?.results || []).length, 0);
});

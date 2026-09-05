import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMnemuronApp } from "../../lib/app.mjs";

export function assertIsolatedTarget(root, databasePath, baseUrl = "http://127.0.0.1") {
  const temporary = realpathSync(os.tmpdir());
  const resolved = realpathSync(root);
  assert.ok(path.dirname(resolved) === temporary && path.basename(resolved).startsWith("mnemuron-core-test-"), "Only a dedicated temporary root is allowed");
  assert.equal(path.dirname(path.resolve(databasePath)), resolved, "Database must be inside the temporary root");
  const url = new URL(baseUrl);
  assert.ok(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password, "Only loopback HTTP is allowed");
}

export async function memoryFixture(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mnemuron-core-test-")));
  const databasePath = path.join(root, "test.sqlite3");
  assertIsolatedTarget(root, databasePath);
  const app = createMnemuronApp({ databasePath });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  assertIsolatedTarget(root, databasePath, baseUrl);
  const { store } = app;
  const issue = (user, agent) => {
    const credential = store.issueCredential({ label: agent, userId: user, deviceId: `device-${agent}`, agentId: "test", agentInstanceId: agent, scopes: ["memory:read", "memory:write", "capture:write", "admin:tasks", "admin:devices"] });
    return { ...credential, auth: store.authenticate(credential.api_key) };
  };
  const a = issue("user-coretest-a", "agent-a");
  const b = issue("user-coretest-a", "agent-b");
  const other = issue("user-coretest-b", "agent-c");
  const seed = (owner, id, project) => {
    const task = { task_id: id, project_id: project, project_name: project, title: id, goal: "Synthetic scope verification", status: "active", workstreams: [{ workstream_id: `${id}-one`, name: "one", status: "active" }, { workstream_id: `${id}-two`, name: "two", status: "active" }] };
    store.upsertTask(owner.auth, task);
    return task;
  };
  const alpha = seed(a, "task-alpha-upgrade", "project-alpha");
  const beta = seed(a, "task-beta-upgrade", "project-beta");
  const foreign = seed(other, "task-foreign-upgrade", "project-foreign");
  const request = async (method, endpoint, body, owner = a, headers = {}) => {
    const response = await fetch(new URL(endpoint, baseUrl), { method, headers: { authorization: `Bearer ${owner.api_key}`, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { root, databasePath, app, store, baseUrl, a, b, other, alpha, beta, foreign, issue, request };
}

export function businessSnapshot(store) {
  return Object.fromEntries(["memories", "tasks", "resumes", "resume_delivery_receipts", "events", "task_canonical_revisions"].map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

export function assertCode(fn, code, status = 400) {
  assert.throws(fn, error => error.statusCode === status && error.errorCode === code);
}

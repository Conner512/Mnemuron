import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMnemuronApp } from "../lib/app.mjs";
import { MnemuronStore } from "../lib/store.mjs";

const PROJECT_BOOTSTRAP_SCOPES = [
  "memory:read",
  "project:bootstrap:preview",
  "project:bootstrap:confirm",
];

const request = {
  project_name: "Adversarial Project",
  project_aliases: [],
  git_remotes: [],
  repo_fingerprints: [],
  path_hints: [],
  task_title: "Create the first Task",
  task_goal: "Create exactly one Project and one initial Canonical Task after confirmation.",
  task_aliases: [],
  workstream_id: "workstream-chatgpt-test",
  workstream_name: "ChatGPT test",
  session_id: "session-project-bootstrap-adversarial",
};

async function api(baseUrl, apiKey, method, endpoint, body, expectedStatus = 200) {
  const response = await fetch(new URL(endpoint, baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(data));
  return data;
}

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-project-bootstrap-adversarial-"));
  const databasePath = path.join(root, "mnemuron.sqlite3");
  const app = createMnemuronApp({ databasePath });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const admin = app.store.bootstrapAdmin();
  const owner = app.store.issueCredential({
    label: "Project Bootstrap reviewer",
    deviceId: "clienta-project-bootstrap-review",
    agentId: "chatgpt",
    agentInstanceId: "chatgpt-clienta-project-bootstrap-review",
    scopes: PROJECT_BOOTSTRAP_SCOPES,
  });
  return { root, databasePath, app, baseUrl, admin, owner };
}

async function cleanup(context) {
  if (context.app.server.listening) await context.app.close();
  rmSync(context.root, { recursive: true, force: true });
}

test("Project Bootstrap is not granted to a newly issued default Agent credential", async () => {
  const context = await setup();
  try {
    const generic = context.app.store.issueCredential({
      label: "Generic Agent",
      deviceId: "generic-bootstrap-device",
      agentId: "openclaw",
      agentInstanceId: "openclaw-generic-bootstrap-agent",
    });
    assert.equal(generic.credential.scopes.includes("project:bootstrap:preview"), false);
    assert.equal(generic.credential.scopes.includes("project:bootstrap:confirm"), false);
    await api(
      context.baseUrl,
      generic.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      request,
      403,
    );
  } finally {
    await cleanup(context);
  }
});

test("Project Bootstrap removes secrets from SSH remotes and matches SSH to HTTPS", async () => {
  for (const unsafeRemote of [
    "ssh://oauth2:bootstrap-secret@example.com/org/repository.git?access_token=bootstrap-secret#bootstrap-secret",
    "oauth2@example.com:org/repository.git?access_token=bootstrap-secret#bootstrap-secret",
  ]) {
    const context = await setup();
    try {
      const admin = context.app.store.authenticate(context.admin.api_key);
      context.app.store.upsertProject(admin, {
        project_id: "project-existing-remote-owner",
        name: "Existing Remote Owner",
        aliases: [],
        git_remotes: ["https://example.com/org/repository"],
        repo_fingerprints: [],
        path_hints: [],
      });
      const result = await api(
        context.baseUrl,
        context.owner.api_key,
        "POST",
        "/v1/project-bootstrap/preview",
        {
          ...request,
          project_name: "Remote Alias Must Not Create A Duplicate",
          git_remotes: [unsafeRemote],
        },
        201,
      );
      assert.equal(result.status, "existing_project_selection_required");
      assert.equal(result.candidates[0].project_id, "project-existing-remote-owner");
      assert.equal(JSON.stringify(result).includes("bootstrap-secret"), false);
      const serializedDatabaseState = JSON.stringify(context.app.store.db.prepare(`
        SELECT preview_json FROM task_bootstrap_previews
        UNION ALL
        SELECT metadata_json FROM audit_events
      `).all());
      assert.equal(serializedDatabaseState.includes("bootstrap-secret"), false);
    } finally {
      await cleanup(context);
    }
  }
});

test("Project Bootstrap rolls the full transaction back when revision insertion fails", async () => {
  const context = await setup();
  try {
    const preview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      request,
      201,
    );
    const originalInsert = context.app.store.insertCanonicalRevision;
    context.app.store.insertCanonicalRevision = () => {
      throw new Error("injected canonical revision failure");
    };
    await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/project-bootstrap/${preview.bootstrap_id}/confirm`,
      {
        preview_version: 1,
        confirmed: true,
        session_id: request.session_id,
      },
      500,
    );
    context.app.store.insertCanonicalRevision = originalInsert;
    assert.equal(context.app.store.db.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 0);
    assert.equal(context.app.store.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
    assert.equal(context.app.store.db.prepare(
      "SELECT COUNT(*) AS count FROM task_canonical_revisions",
    ).get().count, 0);
    assert.equal(context.app.store.db.prepare(`
      SELECT status FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(preview.bootstrap_id).status, "pending_confirmation");
    assert.equal(context.app.store.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action = 'project.bootstrap.confirm' AND target_id = ?
    `).get(preview.bootstrap_id).count, 0);
  } finally {
    await cleanup(context);
  }
});

test("Project Bootstrap rejects oversized collections, strings, and unsafe identifiers", async () => {
  const context = await setup();
  try {
    const invalidBodies = [
      { ...request, task_goal: "x".repeat(4_097) },
      { ...request, git_remotes: Array.from({ length: 21 }, (_, index) => `https://example.com/r${index}`) },
      { ...request, git_remotes: ["x".repeat(2_049)] },
      { ...request, project_aliases: ["valid", 123] },
      { ...request, session_id: "../../forged-session" },
      { ...request, workstream_id: "../../forged-workstream" },
    ];
    for (const body of invalidBodies) {
      await api(
        context.baseUrl,
        context.owner.api_key,
        "POST",
        "/v1/project-bootstrap/preview",
        body,
        400,
      );
    }
    assert.equal(context.app.store.db.prepare(
      "SELECT COUNT(*) AS count FROM task_bootstrap_previews",
    ).get().count, 0);
    assert.equal(context.app.store.db.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 0);
    assert.equal(context.app.store.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
  } finally {
    await cleanup(context);
  }
});

test("Project Bootstrap cancel uses compare-and-swap when confirmation wins concurrently", async () => {
  const context = await setup();
  let peerStore;
  try {
    const ownerAuth = context.app.store.authenticate(context.owner.api_key);
    const preview = context.app.store.createProjectBootstrapPreview(ownerAuth, request);
    peerStore = new MnemuronStore(context.databasePath);
    const peerAuth = peerStore.authenticate(context.owner.api_key);
    const database = context.app.store.db;
    let injected = false;
    context.app.store.db = new Proxy(database, {
      get(target, property) {
        if (property === "exec") {
          return (sql) => {
            if (sql === "BEGIN IMMEDIATE" && !injected) {
              injected = true;
              peerStore.confirmProjectBootstrap(
                peerAuth,
                preview.bootstrap_id,
                preview.preview_version,
                true,
                request.session_id,
              );
            }
            return target.exec(sql);
          };
        }
        if (property !== "prepare") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return target.prepare.bind(target);
      },
    });
    assert.throws(
      () => context.app.store.confirmProjectBootstrap(
        ownerAuth,
        preview.bootstrap_id,
        preview.preview_version,
        false,
        request.session_id,
      ),
      (error) => error?.statusCode === 409,
    );
    const finalRow = peerStore.db.prepare(`
      SELECT status FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(preview.bootstrap_id);
    assert.equal(finalRow.status, "confirmed");
    assert.equal(peerStore.db.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 1);
    assert.equal(peerStore.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
  } finally {
    if (peerStore) peerStore.close();
    await cleanup(context);
  }
});

test("competing Project Bootstrap confirmations create only one Project and initial Task", async () => {
  const context = await setup();
  let peerStore;
  try {
    const ownerAuth = context.app.store.authenticate(context.owner.api_key);
    const preview = context.app.store.createProjectBootstrapPreview(ownerAuth, request);
    peerStore = new MnemuronStore(context.databasePath);
    const peerAuth = peerStore.authenticate(context.owner.api_key);
    const database = context.app.store.db;
    let injected = false;
    context.app.store.db = new Proxy(database, {
      get(target, property) {
        if (property === "exec") {
          return (sql) => {
            if (sql === "BEGIN IMMEDIATE" && !injected) {
              injected = true;
              peerStore.confirmProjectBootstrap(
                peerAuth,
                preview.bootstrap_id,
                preview.preview_version,
                true,
                request.session_id,
              );
            }
            return target.exec(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    assert.throws(
      () => context.app.store.confirmProjectBootstrap(
        ownerAuth,
        preview.bootstrap_id,
        preview.preview_version,
        true,
        request.session_id,
      ),
      (error) => error?.statusCode === 409,
    );
    assert.equal(peerStore.db.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 1);
    assert.equal(peerStore.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
    assert.equal(peerStore.db.prepare(
      "SELECT COUNT(*) AS count FROM task_canonical_revisions",
    ).get().count, 1);
    assert.equal(peerStore.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action = 'project.bootstrap.confirm' AND target_id = ?
    `).get(preview.bootstrap_id).count, 1);
  } finally {
    if (peerStore) peerStore.close();
    await cleanup(context);
  }
});

test("Project Bootstrap status separates Task and Project previews and accounts for TTL expiry", async () => {
  const context = await setup();
  try {
    const preview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      request,
      201,
    );
    let status = await api(context.baseUrl, context.owner.api_key, "GET", "/v1/status");
    assert.equal(status.counts.task_bootstrap_previews, 0);
    assert.equal(status.counts.project_bootstrap_previews, 1);
    assert.equal(status.project_bootstrap.pending_confirmation, 1);
    assert.equal(status.project_bootstrap.expired, 0);

    context.app.store.db.prepare(`
      UPDATE task_bootstrap_previews SET expires_at = ? WHERE bootstrap_id = ?
    `).run(new Date(Date.now() - 60_000).toISOString(), preview.bootstrap_id);
    status = await api(context.baseUrl, context.owner.api_key, "GET", "/v1/status");
    assert.equal(status.project_bootstrap.pending_confirmation, 0);
    assert.equal(status.project_bootstrap.expired, 1);
  } finally {
    await cleanup(context);
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createMnemuronApp } from "../lib/app.mjs";
import { MnemuronStore } from "../lib/store.mjs";

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

const project = {
  project_id: "project-mnemuron",
  name: "Mnemuron",
  aliases: ["Cross-Agent Memory"],
  git_remotes: ["https://github.com/example/mnemuron.git"],
  repo_fingerprints: ["sha256:task-bootstrap-test"],
  path_hints: ["/Users/test/Documents/Mnemuron"],
};

const bootstrapRequest = {
  project_query: "Mnemuron",
  title: "Task Bootstrap & Binding v0.1",
  goal: "Create and bind a missing Canonical Task only after explicit confirmation.",
  aliases: ["Task Bootstrap", "Bootstrap Binding"],
  workstream_id: "workstream-macbook",
  workstream_name: "MacBook",
  session_id: "session-task-bootstrap-owner",
};

function canonicalTask({
  taskId,
  title,
  goal = `Complete ${title}.`,
  aliases = [],
  workstreamId = "workstream-existing",
} = {}) {
  return {
    task_id: taskId,
    project_id: project.project_id,
    project_name: project.name,
    title,
    aliases,
    goal,
    status: "active",
    progress: ["Existing progress must remain intact."],
    decisions: ["Existing Task ownership is authoritative."],
    blockers: [],
    next_steps: ["Keep the existing Task unchanged."],
    resources: ["docs/existing-task.md"],
    workstreams: [{ workstream_id: workstreamId, name: "Existing", status: "active" }],
    conflicts: [],
  };
}

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-task-bootstrap-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const admin = app.store.bootstrapAdmin();
  const owner = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
    label: "Task bootstrap owner",
    device_id: "macbook-task-bootstrap-owner",
    agent_id: "chatgpt",
    agent_instance_id: "chatgpt-macbook-task-bootstrap-owner",
  }, 201);
  const peer = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
    label: "Task bootstrap peer",
    device_id: "macmini-task-bootstrap-peer",
    agent_id: "chatgpt",
    agent_instance_id: "chatgpt-macmini-task-bootstrap-peer",
  }, 201);
  const previewOnly = await api(
    baseUrl,
    admin.api_key,
    "POST",
    "/v1/agent-instances/register",
    {
      label: "Task bootstrap preview only",
      device_id: "readonly-task-bootstrap",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-task-bootstrap-preview-only",
      scopes: ["task:bootstrap:preview"],
    },
    201,
  );
  const confirmOnly = await api(
    baseUrl,
    admin.api_key,
    "POST",
    "/v1/agent-instances/register",
    {
      label: "Task bootstrap confirm only",
      device_id: "confirm-task-bootstrap",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-task-bootstrap-confirm-only",
      scopes: ["task:bootstrap:confirm"],
    },
    201,
  );
  await api(baseUrl, admin.api_key, "POST", "/v1/projects", project);
  return { root, app, baseUrl, admin, owner, peer, previewOnly, confirmOnly };
}

async function cleanup(context) {
  if (context.app.server.listening) await context.app.close();
  rmSync(context.root, { recursive: true, force: true });
}

function countRows(app, table) {
  return app.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function sideEffectCounts(app) {
  return {
    tasks: countRows(app, "tasks"),
    revisions: countRows(app, "task_canonical_revisions"),
    resumes: countRows(app, "resumes"),
    resolverSelections: countRows(app, "resolver_selections"),
    injectionEvents: countRows(app, "resume_injection_events"),
    deliveryReceipts: countRows(app, "resume_delivery_receipts"),
  };
}

test("Task Bootstrap Preview freezes one proposal without creating Task, revision, or Resume state", async () => {
  const context = await setup();
  try {
    const before = sideEffectCounts(context.app);
    const preview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      bootstrapRequest,
      201,
    );

    assert.equal(preview.schema_version, "task-bootstrap-binding-v0.1");
    assert.equal(preview.status, "pending_confirmation");
    assert.equal(preview.requires_confirmation, true);
    assert.equal(preview.preview_version, 1);
    assert.match(preview.bootstrap_id, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
    assert.equal(preview.project.project_id, project.project_id);
    assert.equal(preview.project.name, project.name);
    assert.match(preview.task.task_id, /^task-/);
    assert.equal(preview.task.title, bootstrapRequest.title);
    assert.equal(preview.task.goal, bootstrapRequest.goal);
    assert.deepEqual(preview.task.aliases, bootstrapRequest.aliases);
    assert.equal(preview.task.status, "active");
    assert.equal(preview.workstream.workstream_id, bootstrapRequest.workstream_id);
    assert.equal(preview.workstream.name, bootstrapRequest.workstream_name);
    assert.equal(preview.target_session_id, bootstrapRequest.session_id);
    assert.equal(preview.binding_packet, undefined);
    assert.equal(preview.resume_id, undefined);
    assert.ok(Number.isFinite(Date.parse(preview.created_at)));
    assert.ok(Number.isFinite(Date.parse(preview.expires_at)));
    assert.equal(Date.parse(preview.expires_at) - Date.parse(preview.created_at), 30 * 60_000);

    assert.deepEqual(sideEffectCounts(context.app), before);
    const stored = context.app.store.db.prepare(`
      SELECT * FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(preview.bootstrap_id);
    assert.equal(stored.requested_by_credential_id, context.owner.credential.credential_id);
    assert.equal(stored.project_id, project.project_id);
    assert.equal(stored.proposed_task_id, preview.task.task_id);
    assert.equal(stored.preview_version, preview.preview_version);
    assert.equal(stored.status, "pending_confirmation");
    assert.deepEqual(JSON.parse(stored.preview_json), preview);
  } finally {
    await cleanup(context);
  }
});

test("rejecting a frozen Bootstrap Preview is terminal and creates no Canonical or Resume state", async () => {
  const context = await setup();
  try {
    const preview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      bootstrapRequest,
      201,
    );
    const before = sideEffectCounts(context.app);
    const cancelled = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/task-bootstrap/${preview.bootstrap_id}/confirm`,
      {
        preview_version: preview.preview_version,
        confirmed: false,
        session_id: bootstrapRequest.session_id,
      },
    );
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.bootstrap_id, preview.bootstrap_id);
    assert.equal(cancelled.binding_packet, undefined);
    assert.deepEqual(sideEffectCounts(context.app), before);

    const stored = context.app.store.db.prepare(`
      SELECT status, cancelled_at, confirmed_at, binding_packet_json
      FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(preview.bootstrap_id);
    assert.equal(stored.status, "cancelled");
    assert.ok(Number.isFinite(Date.parse(stored.cancelled_at)));
    assert.equal(stored.confirmed_at, null);
    assert.equal(stored.binding_packet_json, null);

    await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/task-bootstrap/${preview.bootstrap_id}/confirm`,
      {
        preview_version: preview.preview_version,
        confirmed: true,
        session_id: bootstrapRequest.session_id,
      },
      409,
    );
    assert.deepEqual(sideEffectCounts(context.app), before);
    assert.equal(context.app.store.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action = 'task.bootstrap.cancel' AND target_id = ?
    `).get(preview.bootstrap_id).count, 1);
  } finally {
    await cleanup(context);
  }
});

test("Bootstrap confirmation is isolated by version, target Session, Credential, and scopes", async () => {
  const context = await setup();
  try {
    const defaultScopes = context.app.store.authenticate(context.owner.api_key).scopes;
    assert.ok(defaultScopes.includes("task:bootstrap:preview"));
    assert.ok(defaultScopes.includes("task:bootstrap:confirm"));

    await api(
      context.baseUrl,
      context.confirmOnly.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      bootstrapRequest,
      403,
    );
    const readOnlyPreview = await api(
      context.baseUrl,
      context.previewOnly.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      {
        ...bootstrapRequest,
        title: "Preview-only capability isolation",
        goal: "Exercise the preview-only credential without colliding with the owner proposal.",
        aliases: ["Preview-only isolation"],
        session_id: "session-preview-only",
      },
      201,
    );
    await api(
      context.baseUrl,
      context.previewOnly.api_key,
      "POST",
      `/v1/task-bootstrap/${readOnlyPreview.bootstrap_id}/confirm`,
      {
        preview_version: readOnlyPreview.preview_version,
        confirmed: true,
        session_id: "session-preview-only",
      },
      403,
    );

    const preview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      bootstrapRequest,
      201,
    );
    const confirmEndpoint = `/v1/task-bootstrap/${preview.bootstrap_id}/confirm`;
    await api(context.baseUrl, context.owner.api_key, "POST", confirmEndpoint, {
      preview_version: preview.preview_version + 1,
      confirmed: true,
      session_id: bootstrapRequest.session_id,
    }, 409);
    await api(context.baseUrl, context.owner.api_key, "POST", confirmEndpoint, {
      preview_version: preview.preview_version,
      confirmed: true,
      session_id: "session-task-bootstrap-other",
    }, 409);
    await api(context.baseUrl, context.peer.api_key, "POST", confirmEndpoint, {
      preview_version: preview.preview_version,
      confirmed: true,
      session_id: bootstrapRequest.session_id,
    }, 404);

    assert.deepEqual(sideEffectCounts(context.app), {
      tasks: 0,
      revisions: 0,
      resumes: 0,
      resolverSelections: 0,
      injectionEvents: 0,
      deliveryReceipts: 0,
    });
    assert.equal(context.app.store.db.prepare(`
      SELECT status FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(preview.bootstrap_id).status, "pending_confirmation");

    const cancelled = await api(context.baseUrl, context.owner.api_key, "POST", confirmEndpoint, {
      preview_version: preview.preview_version,
      confirmed: false,
      session_id: bootstrapRequest.session_id,
    });
    assert.equal(cancelled.status, "cancelled");
  } finally {
    await cleanup(context);
  }
});

test("confirmed Bootstrap atomically creates Canonical v1 and returns an idempotent Binding Packet", async () => {
  const context = await setup();
  try {
    const preview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      bootstrapRequest,
      201,
    );
    const confirmBody = {
      preview_version: preview.preview_version,
      confirmed: true,
      session_id: bootstrapRequest.session_id,
    };
    const confirmed = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/task-bootstrap/${preview.bootstrap_id}/confirm`,
      confirmBody,
    );

    assert.equal(confirmed.status, "confirmed");
    const packet = confirmed.binding_packet;
    assert.equal(packet.schema_version, "task-bootstrap-binding-v0.1");
    assert.equal(packet.bootstrap_id, preview.bootstrap_id);
    assert.equal(packet.preview_version, preview.preview_version);
    assert.equal(packet.project.project_id, preview.project.project_id);
    assert.equal(packet.task.task_id, preview.task.task_id);
    assert.equal(packet.workstream.workstream_id, preview.workstream.workstream_id);
    assert.equal(packet.target_session_id, preview.target_session_id);
    assert.ok(Number.isFinite(Date.parse(packet.binding_authorized_at)));

    const savedTask = context.app.store.listTasks(context.owner.credential.user_id)
      .find((item) => item.task_id === preview.task.task_id);
    assert.ok(savedTask);
    assert.equal(savedTask.canonical_version, 1);
    assert.equal(savedTask.project_id, project.project_id);
    assert.equal(savedTask.project_name, project.name);
    assert.equal(savedTask.title, bootstrapRequest.title);
    assert.equal(savedTask.goal, bootstrapRequest.goal);
    assert.deepEqual(savedTask.aliases, bootstrapRequest.aliases);
    assert.equal(savedTask.status, "active");
    assert.deepEqual(savedTask.progress, []);
    assert.deepEqual(savedTask.decisions, []);
    assert.deepEqual(savedTask.blockers, []);
    assert.deepEqual(savedTask.next_steps, []);
    assert.deepEqual(savedTask.resources, []);
    assert.deepEqual(savedTask.conflicts, []);
    assert.deepEqual(savedTask.workstreams, [{
      workstream_id: bootstrapRequest.workstream_id,
      name: bootstrapRequest.workstream_name,
      status: "active",
      agent_id: "chatgpt",
      device_id: "macbook-task-bootstrap-owner",
      agent_instance_id: "chatgpt-macbook-task-bootstrap-owner",
    }]);

    const revision = context.app.store.db.prepare(`
      SELECT * FROM task_canonical_revisions WHERE task_id = ?
    `).get(savedTask.task_id);
    assert.equal(revision.canonical_version_before, 0);
    assert.equal(revision.canonical_version_after, 1);
    assert.equal(revision.decision, "bootstrap_confirmed");
    assert.equal(revision.credential_id, context.owner.credential.credential_id);
    assert.ok(revision.after_hash);

    const stored = context.app.store.db.prepare(`
      SELECT * FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(preview.bootstrap_id);
    assert.equal(stored.status, "confirmed");
    assert.ok(Number.isFinite(Date.parse(stored.confirmed_at)));
    assert.deepEqual(JSON.parse(stored.binding_packet_json), packet);
    assert.equal(countRows(context.app, "resumes"), 0);
    assert.equal(countRows(context.app, "resolver_selections"), 0);
    assert.equal(countRows(context.app, "resume_injection_events"), 0);
    assert.equal(countRows(context.app, "resume_delivery_receipts"), 0);

    const replay = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/task-bootstrap/${preview.bootstrap_id}/confirm`,
      confirmBody,
    );
    assert.equal(replay.status, "confirmed");
    assert.deepEqual(replay.binding_packet, packet);
    assert.equal(countRows(context.app, "tasks"), 1);
    assert.equal(countRows(context.app, "task_canonical_revisions"), 1);
    assert.equal(context.app.store.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action = 'task.bootstrap.preview' AND target_id = ?
    `).get(preview.bootstrap_id).count, 1);
    assert.equal(context.app.store.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action = 'task.bootstrap.confirm' AND target_id = ?
    `).get(preview.bootstrap_id).count, 1);
    assert.equal(context.app.store.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action LIKE 'resume.%' AND target_id = ?
    `).get(preview.bootstrap_id).count, 0);
  } finally {
    await cleanup(context);
  }
});

test("a similar existing Task requires selection and is never overwritten or duplicated", async () => {
  const context = await setup();
  try {
    const existing = canonicalTask({
      taskId: "task-bootstrap-existing-similar",
      title: bootstrapRequest.title,
      aliases: ["Existing Bootstrap Task"],
    });
    await api(context.baseUrl, context.admin.api_key, "POST", "/v1/tasks", existing);
    const beforeTask = context.app.store.listTasks("user-local")[0];
    const before = sideEffectCounts(context.app);
    const result = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      bootstrapRequest,
      201,
    );

    assert.equal(result.status, "existing_task_selection_required");
    assert.equal(result.requires_confirmation, false);
    assert.ok(result.candidates.some((candidate) => candidate.task_id === existing.task_id));
    assert.equal(result.bootstrap_id, undefined);
    assert.deepEqual(sideEffectCounts(context.app), before);
    assert.deepEqual(context.app.store.listTasks("user-local")[0], beforeTask);
    assert.equal(countRows(context.app, "task_bootstrap_previews"), 0);
  } finally {
    await cleanup(context);
  }
});

test("confirmation loses a race to an existing Task without partially overwriting it", async () => {
  const context = await setup();
  try {
    const request = {
      ...bootstrapRequest,
      title: "Bootstrap Race Isolation v0.1",
      aliases: ["Bootstrap Race"],
      session_id: "session-task-bootstrap-race",
    };
    const preview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      request,
      201,
    );
    const occupied = canonicalTask({
      taskId: preview.task.task_id,
      title: "Administrator-created authoritative Task",
      goal: "Preserve the Task that won the creation race.",
      aliases: ["Authoritative Task"],
      workstreamId: "workstream-authoritative",
    });
    await api(context.baseUrl, context.admin.api_key, "POST", "/v1/tasks", occupied);
    const beforeTask = context.app.store.listTasks("user-local")[0];
    const beforeRevision = context.app.store.db.prepare(`
      SELECT * FROM task_canonical_revisions WHERE task_id = ?
    `).get(occupied.task_id);

    await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/task-bootstrap/${preview.bootstrap_id}/confirm`,
      {
        preview_version: preview.preview_version,
        confirmed: true,
        session_id: request.session_id,
      },
      409,
    );

    assert.deepEqual(context.app.store.listTasks("user-local")[0], beforeTask);
    assert.deepEqual(context.app.store.db.prepare(`
      SELECT * FROM task_canonical_revisions WHERE task_id = ?
    `).get(occupied.task_id), beforeRevision);
    assert.equal(countRows(context.app, "tasks"), 1);
    assert.equal(countRows(context.app, "task_canonical_revisions"), 1);
    assert.equal(countRows(context.app, "resumes"), 0);
    assert.equal(context.app.store.db.prepare(`
      SELECT status, confirmed_at, binding_packet_json
      FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(preview.bootstrap_id).status, "pending_confirmation");
  } finally {
    await cleanup(context);
  }
});

test("confirmation loses a race to a differently identified similar Task", async () => {
  const context = await setup();
  try {
    const request = {
      ...bootstrapRequest,
      title: "Bootstrap Similarity Race v0.1",
      aliases: ["Similarity Race"],
      session_id: "session-task-bootstrap-similarity-race",
    };
    const preview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      request,
      201,
    );
    const occupied = canonicalTask({
      taskId: "task-administrator-won-similarity-race",
      title: request.title,
      goal: "Remain the only Canonical Task for this work.",
      aliases: ["Authoritative Similar Task"],
      workstreamId: "workstream-authoritative-similar",
    });
    await api(context.baseUrl, context.admin.api_key, "POST", "/v1/tasks", occupied);
    const beforeTask = context.app.store.listTasks("user-local")[0];
    const beforeCounts = sideEffectCounts(context.app);

    const rejected = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/task-bootstrap/${preview.bootstrap_id}/confirm`,
      {
        preview_version: preview.preview_version,
        confirmed: true,
        session_id: request.session_id,
      },
      409,
    );

    assert.match(rejected.error, /similar Canonical Task/i);
    assert.deepEqual(context.app.store.listTasks("user-local")[0], beforeTask);
    assert.deepEqual(sideEffectCounts(context.app), beforeCounts);
    assert.equal(context.app.store.db.prepare(`
      SELECT status FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(preview.bootstrap_id).status, "pending_confirmation");
  } finally {
    await cleanup(context);
  }
});

test("confirmation fails closed when the resolved Project name changed after Preview", async () => {
  const context = await setup();
  try {
    const request = {
      ...bootstrapRequest,
      title: "Bootstrap Project Drift v0.1",
      aliases: ["Project Drift"],
      session_id: "session-task-bootstrap-project-drift",
    };
    const preview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      request,
      201,
    );
    await api(context.baseUrl, context.admin.api_key, "POST", "/v1/projects", {
      ...project,
      name: "Mnemuron Renamed",
    });
    const before = sideEffectCounts(context.app);

    const rejected = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/task-bootstrap/${preview.bootstrap_id}/confirm`,
      {
        preview_version: preview.preview_version,
        confirmed: true,
        session_id: request.session_id,
      },
      409,
    );

    assert.match(rejected.error, /Project changed/i);
    assert.deepEqual(sideEffectCounts(context.app), before);
    assert.equal(context.app.store.db.prepare(`
      SELECT status FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(preview.bootstrap_id).status, "pending_confirmation");
  } finally {
    await cleanup(context);
  }
});

test("an expired Bootstrap Preview rejects confirmation and creates no Task or revision", async () => {
  const context = await setup();
  try {
    const preview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      bootstrapRequest,
      201,
    );
    context.app.store.db.prepare(`
      UPDATE task_bootstrap_previews SET expires_at = ? WHERE bootstrap_id = ?
    `).run(new Date(Date.now() - 60_000).toISOString(), preview.bootstrap_id);
    const before = sideEffectCounts(context.app);

    const expired = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/task-bootstrap/${preview.bootstrap_id}/confirm`,
      {
        preview_version: preview.preview_version,
        confirmed: true,
        session_id: bootstrapRequest.session_id,
      },
      409,
    );
    assert.match(expired.error, /expired/i);
    assert.deepEqual(sideEffectCounts(context.app), before);

    const stored = context.app.store.db.prepare(`
      SELECT status, confirmed_at, cancelled_at, binding_packet_json
      FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(preview.bootstrap_id);
    assert.equal(stored.status, "expired");
    assert.equal(stored.confirmed_at, null);
    assert.equal(stored.cancelled_at, null);
    assert.equal(stored.binding_packet_json, null);
    assert.equal(context.app.store.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action = 'task.bootstrap.expire' AND target_id = ?
    `).get(preview.bootstrap_id).count, 1);
  } finally {
    await cleanup(context);
  }
});

test("existing credentials preview and receive Bootstrap scopes only on explicit apply", async () => {
  const context = await setup();
  try {
    const originalScopes = [
      "capture:write",
      "memory:read",
      "resume:read",
      "custom:scope-must-survive",
    ];
    const legacy = context.app.store.issueCredential({
      label: "Legacy Task Bootstrap client",
      deviceId: "legacy-task-bootstrap-device",
      agentId: "chatgpt",
      agentInstanceId: "legacy-task-bootstrap-client",
      scopes: originalScopes,
    });
    const adminAuth = context.app.store.authenticate(context.admin.api_key);

    const preview = context.app.store.updateTaskBootstrapScopes(
      adminAuth,
      "legacy-task-bootstrap-client",
    );
    assert.equal(preview.status, "preview");
    assert.equal(preview.credentials_to_update, 1);
    assert.equal(preview.applied, false);
    assert.deepEqual(preview.required_scopes, [
      "task:bootstrap:preview",
      "task:bootstrap:confirm",
    ]);
    assert.deepEqual(context.app.store.authenticate(legacy.api_key).scopes, originalScopes);

    const applied = context.app.store.updateTaskBootstrapScopes(
      adminAuth,
      "legacy-task-bootstrap-client",
      { apply: true },
    );
    assert.equal(applied.status, "updated");
    assert.equal(applied.updated_credentials, 1);
    assert.equal(applied.applied, true);
    const expectedScopes = [
      ...originalScopes,
      "task:bootstrap:preview",
      "task:bootstrap:confirm",
    ];
    assert.deepEqual(context.app.store.authenticate(legacy.api_key).scopes, expectedScopes);

    const replay = context.app.store.updateTaskBootstrapScopes(
      adminAuth,
      "legacy-task-bootstrap-client",
      { apply: true },
    );
    assert.equal(replay.status, "unchanged");
    assert.equal(replay.credentials_to_update, 0);
    assert.equal(replay.applied, false);
    assert.deepEqual(context.app.store.authenticate(legacy.api_key).scopes, expectedScopes);
    assert.equal(context.app.store.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action = 'credential.task_bootstrap_scopes.update'
        AND target_id = 'legacy-task-bootstrap-client'
    `).get().count, 1);
  } finally {
    await cleanup(context);
  }
});

test("an identical pending Bootstrap request reuses the frozen Preview", async () => {
  const context = await setup();
  try {
    const first = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      bootstrapRequest,
      201,
    );
    const repeated = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      bootstrapRequest,
      201,
    );

    assert.equal(repeated.status, "pending_confirmation");
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.bootstrap_id, first.bootstrap_id);
    assert.equal(repeated.preview_version, first.preview_version);
    assert.equal(countRows(context.app, "task_bootstrap_previews"), 1);
    assert.deepEqual(sideEffectCounts(context.app), {
      tasks: 0,
      revisions: 0,
      resumes: 0,
      resolverSelections: 0,
      injectionEvents: 0,
      deliveryReceipts: 0,
    });
    assert.equal(context.app.store.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action = 'task.bootstrap.preview' AND target_id = ?
    `).get(first.bootstrap_id).count, 1);
  } finally {
    await cleanup(context);
  }
});

test("pre-Bootstrap database migration adds the table without changing Task state or hash", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-task-bootstrap-migration-"));
  const sourcePath = path.join(root, "pre-bootstrap-source.sqlite3");
  const copyPath = path.join(root, "migration-copy.sqlite3");
  let store = new MnemuronStore(sourcePath);
  try {
    const issued = store.bootstrapAdmin();
    const admin = store.authenticate(issued.api_key);
    const existing = canonicalTask({
      taskId: "task-pre-bootstrap-migration",
      title: "Pre-Bootstrap Canonical Task",
      goal: "Remain byte-for-byte stable at the Canonical projection boundary.",
      aliases: ["Migration Sentinel"],
      workstreamId: "workstream-migration-sentinel",
    });
    store.upsertTask(admin, existing);
    const taskBefore = store.listTasks("user-local")[0];
    const taskHashBefore = createHash("sha256")
      .update(JSON.stringify(taskBefore), "utf8")
      .digest("hex");
    const revisionBefore = store.db.prepare(`
      SELECT * FROM task_canonical_revisions WHERE task_id = ?
    `).get(existing.task_id);
    store.db.exec("DROP TABLE task_bootstrap_previews");
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'task_bootstrap_previews'
    `).get().count, 0);
    store.close();
    store = null;
    const sourceHashBefore = createHash("sha256")
      .update(readFileSync(sourcePath))
      .digest("hex");
    copyFileSync(sourcePath, copyPath);

    store = new MnemuronStore(copyPath);
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'task_bootstrap_previews'
    `).get().count, 1);
    assert.equal(store.db.prepare(
      "SELECT COUNT(*) AS count FROM task_bootstrap_previews",
    ).get().count, 0);
    const taskAfter = store.listTasks("user-local")[0];
    assert.deepEqual(taskAfter, taskBefore);
    assert.equal(
      createHash("sha256").update(JSON.stringify(taskAfter), "utf8").digest("hex"),
      taskHashBefore,
    );
    assert.deepEqual(store.db.prepare(`
      SELECT * FROM task_canonical_revisions WHERE task_id = ?
    `).get(existing.task_id), revisionBefore);
    assert.deepEqual(
      new Set(store.db.prepare("PRAGMA table_info(task_bootstrap_previews)")
        .all().map((column) => column.name)),
      new Set([
        "bootstrap_id",
        "user_id",
        "requested_by_credential_id",
        "bootstrap_kind",
        "project_id",
        "proposed_task_id",
        "preview_version",
        "status",
        "preview_json",
        "binding_packet_json",
        "created_at",
        "expires_at",
        "confirmed_at",
        "cancelled_at",
      ]),
    );
    const indexNames = new Set(store.db.prepare("PRAGMA index_list(task_bootstrap_previews)")
      .all().map((index) => index.name));
    assert.ok(indexNames.has("task_bootstrap_user_created_idx"));
    assert.ok(indexNames.has("task_bootstrap_status_idx"));
    assert.ok(indexNames.has("task_bootstrap_kind_status_idx"));
    assert.equal(store.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    store.close();
    store = null;

    store = new MnemuronStore(copyPath);
    assert.equal(store.db.prepare(
      "SELECT COUNT(*) AS count FROM task_bootstrap_previews",
    ).get().count, 0);
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count FROM task_canonical_revisions WHERE task_id = ?
    `).get(existing.task_id).count, 1);
    const taskAfterReopen = store.listTasks("user-local")[0];
    assert.deepEqual(taskAfterReopen, taskBefore);
    assert.equal(
      createHash("sha256").update(JSON.stringify(taskAfterReopen), "utf8").digest("hex"),
      taskHashBefore,
    );
    store.close();
    store = null;

    assert.equal(
      createHash("sha256").update(readFileSync(sourcePath)).digest("hex"),
      sourceHashBefore,
    );
    const untouchedSource = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      assert.equal(untouchedSource.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name = 'task_bootstrap_previews'
      `).get().count, 0);
      assert.equal(untouchedSource.prepare(
        "SELECT COUNT(*) AS count FROM tasks WHERE task_id = ?",
      ).get(existing.task_id).count, 1);
    } finally {
      untouchedSource.close();
    }
  } finally {
    if (store) store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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

const bootstrapRequest = {
  project_name: "Atlas Notes",
  project_aliases: ["Atlas", " Atlas "],
  git_remotes: ["https://github.com/example/atlas-notes.git"],
  repo_fingerprints: ["sha256:atlas-notes"],
  path_hints: ["/Users/test/Documents/Atlas Notes"],
  task_title: "Build the first usable workspace",
  task_goal: "Create the Project and its first Canonical Task only after explicit confirmation.",
  task_aliases: ["Initial workspace"],
  workstream_id: "workstream-clienta",
  workstream_name: "Client A ChatGPT",
  session_id: "session-project-bootstrap-owner",
};

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-project-bootstrap-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const admin = app.store.bootstrapAdmin();
  const owner = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
    label: "Project bootstrap owner",
    device_id: "clienta-project-bootstrap-owner",
    agent_id: "chatgpt",
    agent_instance_id: "chatgpt-clienta-project-bootstrap-owner",
    scopes: ["memory:read", "project:bootstrap:preview", "project:bootstrap:confirm"],
  }, 201);
  const peer = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
    label: "Project bootstrap peer",
    device_id: "clientb-project-bootstrap-peer",
    agent_id: "chatgpt",
    agent_instance_id: "chatgpt-clientb-project-bootstrap-peer",
    scopes: ["memory:read", "project:bootstrap:preview", "project:bootstrap:confirm"],
  }, 201);
  return { root, app, baseUrl, admin, owner, peer };
}

async function cleanup(context) {
  if (context.app.server.listening) await context.app.close();
  rmSync(context.root, { recursive: true, force: true });
}

function countRows(app, table, clause = "", params = []) {
  return app.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${clause}`)
    .get(...params).count;
}

function businessCounts(app) {
  return {
    projects: countRows(app, "projects"),
    tasks: countRows(app, "tasks"),
    revisions: countRows(app, "task_canonical_revisions"),
    resumes: countRows(app, "resumes"),
    resolverSelections: countRows(app, "resolver_selections"),
    injectionEvents: countRows(app, "resume_injection_events"),
    deliveryReceipts: countRows(app, "resume_delivery_receipts"),
    checkpoints: countRows(app, "checkpoints"),
    memories: countRows(app, "memories"),
    events: countRows(app, "events"),
  };
}

test("Project Bootstrap Preview freezes Project and initial Task without business side effects", async () => {
  const context = await setup();
  try {
    const before = businessCounts(context.app);
    const preview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      bootstrapRequest,
      201,
    );

    assert.equal(preview.schema_version, "project-bootstrap-initial-task-v0.1");
    assert.equal(preview.bootstrap_kind, "project_and_initial_task");
    assert.equal(preview.status, "pending_confirmation");
    assert.equal(preview.requires_confirmation, true);
    assert.equal(preview.preview_version, 1);
    assert.match(preview.bootstrap_id, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
    assert.match(preview.project.project_id, /^project-/);
    assert.equal(preview.project.name, bootstrapRequest.project_name);
    assert.deepEqual(preview.project.aliases, ["Atlas"]);
    assert.deepEqual(preview.project.git_remotes, bootstrapRequest.git_remotes);
    assert.deepEqual(preview.project.repo_fingerprints, bootstrapRequest.repo_fingerprints);
    assert.deepEqual(preview.project.path_hints, bootstrapRequest.path_hints);
    assert.match(preview.task.task_id, /^task-/);
    assert.equal(preview.task.title, bootstrapRequest.task_title);
    assert.equal(preview.task.goal, bootstrapRequest.task_goal);
    assert.deepEqual(preview.task.aliases, bootstrapRequest.task_aliases);
    assert.equal(preview.workstream.workstream_id, bootstrapRequest.workstream_id);
    assert.equal(preview.workstream.agent_id, "chatgpt");
    assert.equal(preview.workstream.device_id, "clienta-project-bootstrap-owner");
    assert.equal(
      preview.workstream.agent_instance_id,
      "chatgpt-clienta-project-bootstrap-owner",
    );
    assert.equal(preview.target_session_id, bootstrapRequest.session_id);
    assert.equal(preview.binding_packet, undefined);
    assert.equal(preview.resume_id, undefined);
    assert.equal(Date.parse(preview.expires_at) - Date.parse(preview.created_at), 30 * 60_000);
    assert.deepEqual(businessCounts(context.app), before);

    const stored = context.app.store.db.prepare(`
      SELECT * FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(preview.bootstrap_id);
    assert.equal(stored.bootstrap_kind, "project_and_initial_task");
    assert.equal(stored.project_id, preview.project.project_id);
    assert.equal(stored.proposed_task_id, preview.task.task_id);
    assert.equal(stored.requested_by_credential_id, context.owner.credential.credential_id);
    assert.deepEqual(JSON.parse(stored.preview_json), preview);

    const status = await api(context.baseUrl, context.owner.api_key, "GET", "/v1/status");
    assert.equal(status.project_bootstrap.pending_confirmation, 1);
    assert.equal(status.task_bootstrap.pending_confirmation, 0);
    assert.equal(status.counts.project_bootstrap_previews, 1);
  } finally {
    await cleanup(context);
  }
});

test("Project Bootstrap fails closed for existing and ambiguous Project candidates", async () => {
  const context = await setup();
  try {
    const admin = context.app.store.authenticate(context.admin.api_key);
    context.app.store.upsertProject(admin, {
      project_id: "project-atlas-existing-a",
      name: "Existing A",
      aliases: ["Atlas Notes"],
      git_remotes: [],
      repo_fingerprints: [],
      path_hints: [],
    });
    context.app.store.upsertProject(admin, {
      project_id: "project-atlas-existing-b",
      name: "Existing B",
      aliases: ["Atlas Notes"],
      git_remotes: [],
      repo_fingerprints: [],
      path_hints: [],
    });
    const before = businessCounts(context.app);
    const result = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      bootstrapRequest,
      201,
    );
    assert.equal(result.status, "existing_project_selection_required");
    assert.equal(result.requires_confirmation, false);
    assert.equal(result.selection_required, true);
    assert.equal(result.candidates.length, 2);
    assert.ok(result.candidates.every((candidate) => candidate.similarity === 1));
    assert.equal(result.bootstrap_id, undefined);
    assert.deepEqual(businessCounts(context.app), before);
    assert.equal(countRows(context.app, "task_bootstrap_previews"), 0);
  } finally {
    await cleanup(context);
  }
});

test("Project Bootstrap treats alias, canonical Git remote, and fingerprint reuse as collisions", async () => {
  for (const variant of ["alias", "git", "fingerprint"]) {
    const context = await setup();
    try {
      const admin = context.app.store.authenticate(context.admin.api_key);
      context.app.store.upsertProject(admin, {
        project_id: `project-signal-${variant}`,
        name: "Existing Signal Owner",
        aliases: variant === "alias" ? ["Signal Collision Alias"] : [],
        git_remotes: variant === "git"
          ? ["https://github.com/example/signal-owner"]
          : [],
        repo_fingerprints: variant === "fingerprint" ? ["sha256:signal-owner"] : [],
        path_hints: [],
      });
      const request = {
        ...bootstrapRequest,
        project_name: variant === "alias" ? "Signal Collision Alias" : `Fresh ${variant}`,
        project_aliases: variant === "alias" ? ["Different Alias"] : [],
        git_remotes: variant === "git" ? ["git@github.com:example/signal-owner.git"] : [],
        repo_fingerprints: variant === "fingerprint" ? ["SHA256:signal-owner"] : [],
        path_hints: [],
      };
      const result = await api(
        context.baseUrl,
        context.owner.api_key,
        "POST",
        "/v1/project-bootstrap/preview",
        request,
        201,
      );
      assert.equal(result.status, "existing_project_selection_required", variant);
      assert.equal(result.candidates[0].project_id, `project-signal-${variant}`, variant);
      assert.equal(countRows(context.app, "task_bootstrap_previews"), 0, variant);
      assert.equal(countRows(context.app, "tasks"), 0, variant);
    } finally {
      await cleanup(context);
    }
  }
});

test("Project Bootstrap does not treat a matching path alone as an existing Project", async () => {
  const context = await setup();
  try {
    const admin = context.app.store.authenticate(context.admin.api_key);
    context.app.store.upsertProject(admin, {
      project_id: "project-shared-directory-owner",
      name: "Existing Unrelated Project",
      aliases: [],
      git_remotes: [],
      repo_fingerprints: [],
      path_hints: ["/Users/test/Documents/Shared Workspace/"],
    });
    const result = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      {
        ...bootstrapRequest,
        project_name: "Independent Project In Shared Workspace",
        project_aliases: [],
        git_remotes: [],
        repo_fingerprints: [],
        path_hints: ["/users/test/documents/shared workspace"],
      },
      201,
    );
    assert.equal(result.status, "pending_confirmation");
    assert.equal(result.selection_required, undefined);
    assert.equal(result.bootstrap_kind, "project_and_initial_task");
    assert.equal(countRows(context.app, "task_bootstrap_previews"), 1);
    assert.equal(countRows(context.app, "projects"), 1);
    assert.equal(countRows(context.app, "tasks"), 0);
  } finally {
    await cleanup(context);
  }
});

test("Project Bootstrap strips HTTP Git credentials and URL metadata before persistence", async () => {
  const context = await setup();
  try {
    const secret = "bootstrap-secret-token";
    const preview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      {
        ...bootstrapRequest,
        project_name: "Sanitized Remote Project",
        project_aliases: [],
        git_remotes: [
          `https://${secret}:password@example.com/org/repository.git?access_token=${secret}#${secret}`,
        ],
        repo_fingerprints: [],
        path_hints: [],
      },
      201,
    );
    assert.deepEqual(preview.project.git_remotes, [
      "https://example.com/org/repository.git",
    ]);
    assert.equal(JSON.stringify(preview).includes(secret), false);

    const storedPreview = context.app.store.db.prepare(`
      SELECT preview_json FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(preview.bootstrap_id);
    assert.equal(storedPreview.preview_json.includes(secret), false);
    assert.equal(JSON.stringify(context.app.store.db.prepare(`
      SELECT metadata_json FROM audit_events WHERE target_id = ? ORDER BY created_at
    `).all(preview.bootstrap_id)).includes(secret), false);

    await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/project-bootstrap/${preview.bootstrap_id}/confirm`,
      {
        preview_version: preview.preview_version,
        confirmed: true,
        session_id: bootstrapRequest.session_id,
      },
    );
    const savedProject = context.app.store.listProjects("user-local")[0];
    assert.deepEqual(savedProject.git_remotes, [
      "https://example.com/org/repository.git",
    ]);
    assert.equal(JSON.stringify(savedProject).includes(secret), false);
    assert.equal(JSON.stringify(context.app.store.db.prepare(`
      SELECT metadata_json FROM audit_events ORDER BY created_at
    `).all()).includes(secret), false);
  } finally {
    await cleanup(context);
  }
});

test("identical Project Bootstrap Preview is idempotent and a competing pending Preview fails closed", async () => {
  const context = await setup();
  try {
    const first = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      bootstrapRequest,
      201,
    );
    const replay = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      bootstrapRequest,
      201,
    );
    assert.equal(replay.idempotent, true);
    assert.equal(replay.bootstrap_id, first.bootstrap_id);

    const competing = await api(
      context.baseUrl,
      context.peer.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      {
        ...bootstrapRequest,
        task_title: "Competing first Task",
        task_goal: "Do not silently create a second Project from another pending proposal.",
        workstream_id: "workstream-clientb",
        workstream_name: "Client B ChatGPT",
        session_id: "session-project-bootstrap-peer",
      },
      201,
    );
    assert.equal(competing.status, "pending_project_bootstrap_selection_required");
    assert.equal(competing.requires_confirmation, false);
    assert.equal(competing.candidates.length, 1);
    assert.equal(competing.candidates[0].bootstrap_id, first.bootstrap_id);
    assert.equal(countRows(context.app, "task_bootstrap_previews"), 1);
    assert.deepEqual(businessCounts(context.app), {
      projects: 0,
      tasks: 0,
      revisions: 0,
      resumes: 0,
      resolverSelections: 0,
      injectionEvents: 0,
      deliveryReceipts: 0,
      checkpoints: 0,
      memories: 0,
      events: 0,
    });
  } finally {
    await cleanup(context);
  }
});

test("Project Bootstrap confirmation is exact by scope, Credential, Session, and version", async () => {
  const context = await setup();
  try {
    const previewOnly = context.app.store.issueCredential({
      label: "Project preview only",
      deviceId: "project-preview-only",
      agentId: "chatgpt",
      agentInstanceId: "chatgpt-project-preview-only",
      scopes: ["project:bootstrap:preview"],
    });
    const confirmOnly = context.app.store.issueCredential({
      label: "Project confirm only",
      deviceId: "project-confirm-only",
      agentId: "chatgpt",
      agentInstanceId: "chatgpt-project-confirm-only",
      scopes: ["project:bootstrap:confirm"],
    });
    await api(
      context.baseUrl,
      confirmOnly.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      bootstrapRequest,
      403,
    );
    const preview = await api(
      context.baseUrl,
      previewOnly.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      bootstrapRequest,
      201,
    );
    const endpoint = `/v1/project-bootstrap/${preview.bootstrap_id}/confirm`;
    await api(context.baseUrl, previewOnly.api_key, "POST", endpoint, {
      preview_version: 1,
      confirmed: true,
      session_id: bootstrapRequest.session_id,
    }, 403);
    await api(context.baseUrl, context.peer.api_key, "POST", endpoint, {
      preview_version: 1,
      confirmed: true,
      session_id: bootstrapRequest.session_id,
    }, 404);
    assert.deepEqual(businessCounts(context.app), {
      projects: 0,
      tasks: 0,
      revisions: 0,
      resumes: 0,
      resolverSelections: 0,
      injectionEvents: 0,
      deliveryReceipts: 0,
      checkpoints: 0,
      memories: 0,
      events: 0,
    });

    const ownerPreview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      {
        ...bootstrapRequest,
        project_name: "Scope Exact Project",
        project_aliases: [],
        git_remotes: [],
        repo_fingerprints: [],
        path_hints: [],
      },
      201,
    );
    const ownerEndpoint = `/v1/project-bootstrap/${ownerPreview.bootstrap_id}/confirm`;
    await api(context.baseUrl, context.owner.api_key, "POST", ownerEndpoint, {
      preview_version: 2,
      confirmed: true,
      session_id: bootstrapRequest.session_id,
    }, 409);
    await api(context.baseUrl, context.owner.api_key, "POST", ownerEndpoint, {
      preview_version: 1,
      confirmed: true,
      session_id: "session-project-bootstrap-wrong",
    }, 409);
    assert.equal(context.app.store.db.prepare(`
      SELECT status FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(ownerPreview.bootstrap_id).status, "pending_confirmation");
  } finally {
    await cleanup(context);
  }
});

test("confirmed Project Bootstrap atomically creates Project, Canonical Task v1, revision and audit", async () => {
  const context = await setup();
  try {
    const preview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      bootstrapRequest,
      201,
    );
    const body = {
      preview_version: preview.preview_version,
      confirmed: true,
      session_id: bootstrapRequest.session_id,
    };
    const confirmed = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/project-bootstrap/${preview.bootstrap_id}/confirm`,
      body,
    );
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.idempotent, false);
    const packet = confirmed.binding_packet;
    assert.equal(packet.schema_version, "project-bootstrap-initial-task-v0.1");
    assert.equal(packet.bootstrap_kind, "project_and_initial_task");
    assert.equal(packet.project.project_id, preview.project.project_id);
    assert.equal(packet.task.task_id, preview.task.task_id);
    assert.equal(packet.workstream.workstream_id, bootstrapRequest.workstream_id);
    assert.equal(packet.target_session_id, bootstrapRequest.session_id);

    const savedProject = context.app.store.listProjects("user-local")[0];
    assert.deepEqual(
      {
        ...savedProject,
        created_at: undefined,
        updated_at: undefined,
      },
      {
        ...preview.project,
        created_at: undefined,
        updated_at: undefined,
      },
    );
    const savedTask = context.app.store.listTasks("user-local")[0];
    assert.equal(savedTask.task_id, preview.task.task_id);
    assert.equal(savedTask.project_id, preview.project.project_id);
    assert.equal(savedTask.project_name, preview.project.name);
    assert.equal(savedTask.canonical_version, 1);
    assert.deepEqual(savedTask.progress, []);
    assert.deepEqual(savedTask.decisions, []);
    assert.deepEqual(savedTask.blockers, []);
    assert.deepEqual(savedTask.next_steps, []);
    assert.deepEqual(savedTask.resources, []);
    assert.deepEqual(savedTask.conflicts, []);
    assert.deepEqual(savedTask.workstreams, [preview.workstream]);

    const revision = context.app.store.db.prepare(`
      SELECT * FROM task_canonical_revisions WHERE task_id = ?
    `).get(savedTask.task_id);
    assert.equal(revision.canonical_version_before, 0);
    assert.equal(revision.canonical_version_after, 1);
    assert.equal(revision.decision, "project_bootstrap_confirmed");
    assert.equal(revision.credential_id, context.owner.credential.credential_id);
    assert.ok(revision.after_hash);
    assert.equal(JSON.parse(revision.operations_json)[0].bootstrap_id, preview.bootstrap_id);

    assert.equal(countRows(context.app, "resumes"), 0);
    assert.equal(countRows(context.app, "resolver_selections"), 0);
    assert.equal(countRows(context.app, "resume_injection_events"), 0);
    assert.equal(countRows(context.app, "resume_delivery_receipts"), 0);
    assert.equal(countRows(context.app, "checkpoints"), 0);
    assert.equal(countRows(context.app, "memories"), 0);
    assert.equal(countRows(context.app, "events"), 0);

    const replay = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/project-bootstrap/${preview.bootstrap_id}/confirm`,
      body,
    );
    assert.equal(replay.idempotent, true);
    assert.deepEqual(replay.binding_packet, packet);
    assert.equal(countRows(context.app, "projects"), 1);
    assert.equal(countRows(context.app, "tasks"), 1);
    assert.equal(countRows(context.app, "task_canonical_revisions"), 1);
    assert.equal(context.app.store.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action = 'project.bootstrap.confirm' AND target_id = ?
    `).get(preview.bootstrap_id).count, 1);
  } finally {
    await cleanup(context);
  }
});

test("Project Bootstrap cancellation, expiry, and creation race leave no partial Task", async () => {
  const context = await setup();
  try {
    const cancelledPreview = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      bootstrapRequest,
      201,
    );
    const cancelled = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/project-bootstrap/${cancelledPreview.bootstrap_id}/confirm`,
      { preview_version: 1, confirmed: false, session_id: bootstrapRequest.session_id },
    );
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.binding_packet, undefined);
    assert.equal(countRows(context.app, "projects"), 0);

    const expiring = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      { ...bootstrapRequest, project_name: "Expiring Project" },
      201,
    );
    context.app.store.db.prepare(`
      UPDATE task_bootstrap_previews SET expires_at = ? WHERE bootstrap_id = ?
    `).run(new Date(Date.now() - 60_000).toISOString(), expiring.bootstrap_id);
    await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/project-bootstrap/${expiring.bootstrap_id}/confirm`,
      { preview_version: 1, confirmed: true, session_id: bootstrapRequest.session_id },
      409,
    );
    assert.equal(countRows(context.app, "projects"), 0);

    const racing = await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      "/v1/project-bootstrap/preview",
      { ...bootstrapRequest, project_name: "Racing Project" },
      201,
    );
    const admin = context.app.store.authenticate(context.admin.api_key);
    context.app.store.upsertProject(admin, {
      ...racing.project,
      name: "Racing Project",
    });
    const projectBefore = context.app.store.listProjects("user-local")[0];
    await api(
      context.baseUrl,
      context.owner.api_key,
      "POST",
      `/v1/project-bootstrap/${racing.bootstrap_id}/confirm`,
      { preview_version: 1, confirmed: true, session_id: bootstrapRequest.session_id },
      409,
    );
    assert.deepEqual(context.app.store.listProjects("user-local")[0], projectBefore);
    assert.equal(countRows(context.app, "tasks"), 0);
    assert.equal(countRows(context.app, "task_canonical_revisions"), 0);
    assert.equal(context.app.store.db.prepare(`
      SELECT status FROM task_bootstrap_previews WHERE bootstrap_id = ?
    `).get(racing.bootstrap_id).status, "pending_confirmation");
  } finally {
    await cleanup(context);
  }
});

test("legacy credentials receive Project Bootstrap scopes only on explicit apply", async () => {
  const context = await setup();
  try {
    const originalScopes = ["capture:write", "memory:read", "custom:scope-must-survive"];
    const legacy = context.app.store.issueCredential({
      label: "Legacy Project Bootstrap client",
      deviceId: "legacy-project-bootstrap-device",
      agentId: "chatgpt",
      agentInstanceId: "legacy-project-bootstrap-client",
      scopes: originalScopes,
    });
    const admin = context.app.store.authenticate(context.admin.api_key);
    const preview = context.app.store.updateProjectBootstrapScopes(
      admin,
      "legacy-project-bootstrap-client",
    );
    assert.equal(preview.status, "preview");
    assert.equal(preview.applied, false);
    assert.deepEqual(preview.required_scopes, [
      "project:bootstrap:preview",
      "project:bootstrap:confirm",
    ]);
    assert.deepEqual(context.app.store.authenticate(legacy.api_key).scopes, originalScopes);

    const applied = context.app.store.updateProjectBootstrapScopes(
      admin,
      "legacy-project-bootstrap-client",
      { apply: true },
    );
    assert.equal(applied.status, "updated");
    assert.equal(applied.updated_credentials, 1);
    const expected = [
      ...originalScopes,
      "project:bootstrap:preview",
      "project:bootstrap:confirm",
    ];
    assert.deepEqual(context.app.store.authenticate(legacy.api_key).scopes, expected);
    const replay = context.app.store.updateProjectBootstrapScopes(
      admin,
      "legacy-project-bootstrap-client",
      { apply: true },
    );
    assert.equal(replay.status, "unchanged");
    assert.equal(context.app.store.db.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
      WHERE action = 'credential.project_bootstrap_scopes.update'
        AND target_id = 'legacy-project-bootstrap-client'
    `).get().count, 1);
  } finally {
    await cleanup(context);
  }
});

test("additive migration classifies legacy Task Bootstrap rows without changing business state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-project-bootstrap-migration-"));
  const sourcePath = path.join(root, "legacy-source.sqlite3");
  const copyPath = path.join(root, "migration-copy.sqlite3");
  let app = createMnemuronApp({ databasePath: sourcePath });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const owner = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "Legacy Task Bootstrap owner",
      device_id: "legacy-task-bootstrap-device",
      agent_id: "chatgpt",
      agent_instance_id: "legacy-task-bootstrap-owner",
    }, 201);
    await api(baseUrl, admin.api_key, "POST", "/v1/projects", {
      project_id: "project-legacy-bootstrap",
      name: "Legacy Bootstrap",
      aliases: [],
      git_remotes: [],
      repo_fingerprints: [],
      path_hints: [],
    });
    const legacyPreview = await api(
      baseUrl,
      owner.api_key,
      "POST",
      "/v1/task-bootstrap/preview",
      {
        project_query: "Legacy Bootstrap",
        title: "Legacy pending Task",
        goal: "Survive the additive Project Bootstrap migration.",
        aliases: [],
        workstream_id: "workstream-legacy",
        workstream_name: "Legacy",
        session_id: "session-legacy-task-bootstrap",
      },
      201,
    );
    await app.close();

    const legacyDb = new DatabaseSync(sourcePath);
    legacyDb.exec(`
      DROP INDEX task_bootstrap_kind_status_idx;
      ALTER TABLE task_bootstrap_previews DROP COLUMN bootstrap_kind;
    `);
    legacyDb.close();
    const sourceHash = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    copyFileSync(sourcePath, copyPath);

    const migrated = new MnemuronStore(copyPath);
    try {
      const columns = new Set(migrated.db.prepare("PRAGMA table_info(task_bootstrap_previews)")
        .all().map((column) => column.name));
      assert.ok(columns.has("bootstrap_kind"));
      const row = migrated.db.prepare(`
        SELECT bootstrap_kind, preview_json FROM task_bootstrap_previews WHERE bootstrap_id = ?
      `).get(legacyPreview.bootstrap_id);
      assert.equal(row.bootstrap_kind, "task");
      assert.deepEqual(JSON.parse(row.preview_json), legacyPreview);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS count FROM projects").get().count, 1);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 0);
      assert.equal(migrated.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count, 0);
      assert.ok(new Set(migrated.db.prepare("PRAGMA index_list(task_bootstrap_previews)")
        .all().map((index) => index.name)).has("task_bootstrap_kind_status_idx"));
      assert.equal(migrated.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
      assert.equal(migrated.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.deepEqual(migrated.db.prepare("PRAGMA foreign_key_check").all(), []);
    } finally {
      migrated.close();
    }
    assert.equal(createHash("sha256").update(readFileSync(sourcePath)).digest("hex"), sourceHash);
    const untouchedSource = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      const columns = new Set(untouchedSource.prepare("PRAGMA table_info(task_bootstrap_previews)")
        .all().map((column) => column.name));
      assert.equal(columns.has("bootstrap_kind"), false);
    } finally {
      untouchedSource.close();
    }
    app = null;
  } finally {
    if (app?.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

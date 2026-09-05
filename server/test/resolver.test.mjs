import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup } from "node:sqlite";
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

function task({
  taskId,
  projectId = "project-mnemuron",
  projectName = "Mnemuron",
  title,
  aliases = [],
  goal,
  status = "active",
  workstreams = [],
  conflicts = [],
}) {
  return {
    task_id: taskId,
    project_id: projectId,
    project_name: projectName,
    title,
    aliases,
    goal,
    status,
    progress: [],
    decisions: [],
    blockers: [],
    next_steps: [],
    resources: [],
    workstreams,
    conflicts,
  };
}

const sourceConflict = {
  conflict_id: "conflict-production-state",
  subject: "production_state",
  status: "unresolved",
  claims: [
    {
      value: "ready",
      workstream_id: "workstream-macmini",
      source: { device_id: "macmini-example", agent_instance_id: "chatgpt-macmini-example" },
    },
    {
      value: "not_ready",
      workstream_id: "workstream-platform",
      source: { device_id: "server-example", agent_instance_id: "mnemuron-server-example" },
    },
  ],
};

const projects = [
  {
    project_id: "project-mnemuron",
    name: "Mnemuron",
    aliases: ["Mnemuron memory", "跨 Agent 记忆共享"],
    git_remotes: ["git@github.com:example/mnemuron.git"],
    repo_fingerprints: ["sha256:mnemuron-repo"],
    path_hints: ["/Users/test/Documents/Mnemuron", "/opt/mnemuron"],
  },
  {
    project_id: "project-atlas",
    name: "Atlas",
    aliases: ["Atlas AI"],
    git_remotes: ["https://github.com/example/atlas.git"],
    repo_fingerprints: ["sha256:atlas-repo"],
    path_hints: ["/Users/test/Documents/Atlas"],
  },
];

const tasks = [
  task({
    taskId: "task-mnemuron-production-readiness-v01",
    title: "Mnemuron Production Readiness v0.1",
    aliases: ["Production Readiness", "生产就绪"],
    goal: "Complete production gates, delivery receipts, security, capacity, and stability acceptance.",
    workstreams: [
      { workstream_id: "workstream-platform", name: "central server Platform", status: "active" },
      { workstream_id: "workstream-macmini", name: "Mac mini ChatGPT", status: "active" },
    ],
    conflicts: [sourceConflict],
  }),
  task({
    taskId: "task-mnemuron-dynamic-task-scope-v01",
    title: "Mnemuron Dynamic Task Scope v0.1",
    aliases: ["Dynamic Task Scope", "Task Scope", "动态任务绑定"],
    goal: "Bind restored tasks to the destination session and workstream without duplicate Resume injection.",
    status: "completed",
    workstreams: [{ workstream_id: "workstream-chatgpt", name: "ChatGPT", status: "completed" }],
  }),
  task({
    taskId: "task-mnemuron-openclaw-adapter-v01",
    title: "Mnemuron OpenClaw Adapter v0.1",
    aliases: ["OpenClaw", "OpenClaw adapter", "OpenClaw 接入"],
    goal: "Capture Telegram OpenClaw work on CT128 and create automatic checkpoints.",
    status: "completed",
    workstreams: [{ workstream_id: "workstream-openclaw", name: "OpenClaw example client", status: "completed" }],
  }),
  task({
    taskId: "task-mnemuron-hermes-adapter-v01",
    title: "Mnemuron Hermes Adapter v0.1",
    aliases: ["Hermes", "Hermes adapter", "Hermes 接入"],
    goal: "Capture Telegram Hermes work on CT129 and create automatic checkpoints.",
    status: "completed",
    workstreams: [{ workstream_id: "workstream-hermes", name: "Hermes example client", status: "completed" }],
  }),
  task({
    taskId: "task-mnemuron-chatgpt-plugin-spike",
    title: "Mnemuron ChatGPT Plugin Spike",
    aliases: ["Mnemuron plugin", "plugin spike", "插件原型"],
    goal: "Validate cross-device ChatGPT capture, preview, confirmation, and resume delivery.",
    workstreams: [{ workstream_id: "workstream-chatgpt", name: "ChatGPT", status: "active" }],
  }),
  task({
    taskId: "task-atlas-deployment",
    projectId: "project-atlas",
    projectName: "Atlas",
    title: "Atlas Deployment",
    aliases: ["Deployment"],
    goal: "Deploy Atlas safely.",
  }),
  task({
    taskId: "task-atlas-migration",
    projectId: "project-atlas",
    projectName: "Atlas",
    title: "Atlas Migration",
    aliases: ["Migration"],
    goal: "Migrate Atlas safely.",
  }),
];

async function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-resolver-v01-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const admin = app.store.bootstrapAdmin();
  const agent = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
    label: "Resolver acceptance Agent",
    device_id: "macbook-resolver-test",
    agent_id: "chatgpt",
    agent_instance_id: "chatgpt-macbook-resolver-test",
  }, 201);
  for (const project of projects) await api(baseUrl, admin.api_key, "POST", "/v1/projects", project);
  for (const item of tasks) await api(baseUrl, admin.api_key, "POST", "/v1/tasks", item);
  return { root, app, baseUrl, adminKey: admin.api_key, agentKey: agent.api_key };
}

async function cleanup({ root, app }) {
  if (app.server.listening) await app.close();
  rmSync(root, { recursive: true, force: true });
}

test("combination Resolver uses project metadata and exact identifiers safely", async () => {
  const context = await fixture();
  try {
    const remote = await api(context.baseUrl, context.agentKey, "POST", "/v1/projects/resolve", {
      query: "继续仓库任务",
      signals: { git_remote: "https://github.com/example/mnemuron.git" },
    });
    assert.equal(remote.status, "resolved");
    assert.equal(remote.match.project_id, "project-mnemuron");
    assert.ok(remote.match.reasons.some((reason) => reason.signal === "git_remote_exact"));

    const fingerprint = await api(context.baseUrl, context.agentKey, "POST", "/v1/projects/resolve", {
      signals: { repo_fingerprint: "sha256:mnemuron-repo" },
    });
    assert.equal(fingerprint.status, "resolved");
    assert.equal(fingerprint.match.project_id, "project-mnemuron");

    const pathOnly = await api(context.baseUrl, context.agentKey, "POST", "/v1/projects/resolve", {
      query: "继续",
      signals: { cwd: "/Users/test/Documents/Mnemuron/server" },
    });
    assert.equal(pathOnly.status, "ambiguous");
    assert.equal(pathOnly.reason, "candidate_confidence_too_low");

    const exact = await api(context.baseUrl, context.agentKey, "POST", "/v1/tasks/resolve", {
      query: "继续 task-mnemuron-production-readiness-v01",
    });
    assert.equal(exact.status, "resolved");
    assert.equal(exact.match.task_id, "task-mnemuron-production-readiness-v01");
    assert.equal(exact.match.score, 1);
  } finally {
    await cleanup(context);
  }
});

test("Agent and device history combine with workstream evidence without becoming identity alone", async () => {
  const context = await fixture();
  try {
    const openclaw = await api(context.baseUrl, context.adminKey, "POST", "/v1/agent-instances/register", {
      label: "OpenClaw example client Resolver fixture",
      device_id: "openclaw-host",
      agent_id: "openclaw",
      agent_instance_id: "openclaw-local",
    }, 201);
    await api(context.baseUrl, openclaw.api_key, "POST", "/v1/events", {
      event: {
        event_id: randomUUID(),
        event_type: "assistant_message",
        captured_at: new Date().toISOString(),
        project_id: "project-mnemuron",
        task_id: "task-mnemuron-openclaw-adapter-v01",
        workstream_id: "workstream-openclaw",
        session_id: "openclaw-session-resolver",
        turn_id: "openclaw-turn-resolver",
        content: "OpenClaw example client Resolver association fixture.",
      },
    }, 202);

    const combined = await api(context.baseUrl, context.agentKey, "POST", "/v1/tasks/resolve", {
      query: "openclaw-host",
      signals: {
        device_id: "openclaw-host",
        agent_id: "openclaw",
        agent_instance_id: "openclaw-local",
      },
    });
    assert.equal(combined.status, "resolved");
    assert.equal(combined.match.task_id, "task-mnemuron-openclaw-adapter-v01");
    assert.ok(combined.match.reasons.some((reason) => reason.signal === "agent_instance_history"));
    assert.ok(combined.match.reasons.some((reason) => reason.signal === "workstream_tokens"));

    const identityOnly = await api(context.baseUrl, context.agentKey, "POST", "/v1/tasks/resolve", {
      query: "继续",
      signals: {
        device_id: "openclaw-host",
        agent_id: "openclaw",
        agent_instance_id: "openclaw-local",
      },
    });
    assert.notEqual(identityOnly.status, "resolved");
  } finally {
    await cleanup(context);
  }
});

test("at least twenty ambiguous or insufficient cases create no Resume", async () => {
  const context = await fixture();
  try {
    const cases = [
      { query: "Mnemuron" },
      { query: "继续 Mnemuron 任务" },
      { query: "Mnemuron Adapter v0.1" },
      { query: "Adapter v0.1" },
      { query: "OpenClaw Hermes" },
      { query: "Telegram Adapter" },
      { query: "task-mnemuron-does-not-exist" },
      { query: "Production Readiness", signals: { project_id: "project-does-not-exist" } },
      { query: "继续", signals: { project_id: "project-mnemuron" } },
      { query: "继续", signals: { git_remote: "git@github.com:example/mnemuron.git" } },
      { query: "继续", signals: { repo_fingerprint: "sha256:mnemuron-repo" } },
      { query: "继续", signals: { cwd: "/Users/test/Documents/Mnemuron/server" } },
      { query: "上次那个" },
      { query: "最近 active 任务" },
      { query: "openclaw-host" },
      { query: "Deployment Migration" },
      { query: "Atlas" },
      { query: "继续", signals: { project_id: "project-atlas" } },
      { query: "继续", signals: { git_remote: "https://github.com/example/atlas.git" } },
      { query: "继续", signals: { repo_fingerprint: "sha256:atlas-repo" } },
      { query: "Mnemuron v0.1" },
      { query: "Production Plugin" },
    ];
    const before = context.app.store.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count;
    const statuses = [];
    for (const resolverCase of cases) {
      const result = await api(context.baseUrl, context.agentKey, "POST", "/v1/resume/preview", resolverCase, 201);
      statuses.push({ query: resolverCase.query, status: result.status });
      assert.notEqual(result.status, "pending_confirmation", JSON.stringify({ resolverCase, result }));
      assert.ok(["ambiguous", "no_match"].includes(result.status), JSON.stringify(result));
      assert.equal(result.selection_required, true);
    }
    const after = context.app.store.db.prepare("SELECT COUNT(*) AS count FROM resumes").get().count;
    assert.equal(cases.length, 22);
    assert.equal(after, before);
    assert.ok(statuses.some((item) => item.status === "ambiguous"));
    assert.ok(statuses.some((item) => item.status === "no_match"));
  } finally {
    await cleanup(context);
  }
});

test("Preview preserves conflicts and confirmed selection becomes append-only history", async () => {
  const context = await fixture();
  try {
    const selected = await api(context.baseUrl, context.agentKey, "POST", "/v1/resume/preview", {
      query: "继续我刚才选中的工作",
      signals: {
        project_id: "project-mnemuron",
        task_id: "task-mnemuron-production-readiness-v01",
      },
    }, 201);
    assert.equal(selected.status, "pending_confirmation");
    assert.deepEqual(selected.conflicts, [sourceConflict]);
    assert.deepEqual(selected.conflict_summary, {
      count: 1,
      source_preserved: true,
      automatic_merge_performed: false,
    });

    const confirmed = await api(
      context.baseUrl,
      context.agentKey,
      "POST",
      `/v1/resume/${selected.resume_id}/confirm`,
      { preview_version: selected.preview_version, confirmed: true },
    );
    assert.equal(confirmed.status, "confirmed");
    assert.deepEqual(confirmed.resume_packet.context.conflicts, [sourceConflict]);

    const learned = await api(context.baseUrl, context.agentKey, "POST", "/v1/tasks/resolve", {
      query: "继续我刚才选中的工作",
    });
    assert.equal(learned.status, "resolved");
    assert.equal(learned.match.task_id, "task-mnemuron-production-readiness-v01");
    assert.ok(learned.match.reasons.some((reason) => reason.signal === "prior_confirmation"));

    const repeated = await api(
      context.baseUrl,
      context.agentKey,
      "POST",
      `/v1/resume/${selected.resume_id}/confirm`,
      { preview_version: selected.preview_version, confirmed: true },
    );
    assert.equal(repeated.status, "confirmed");
    const history = context.app.store.db.prepare(`
      SELECT COUNT(*) AS count FROM resolver_selections WHERE resume_id = ?
    `).get(selected.resume_id);
    assert.equal(history.count, 1);
  } finally {
    await cleanup(context);
  }
});

test("additive migration and isolated backup restore preserve existing Tasks", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-resolver-migration-"));
  const databasePath = path.join(root, "mnemuron.sqlite3");
  let store = new MnemuronStore(databasePath);
  try {
    const adminIssued = store.bootstrapAdmin();
    const admin = store.authenticate(adminIssued.api_key);
    store.upsertTask(admin, tasks[0]);
    store.db.exec("DROP TABLE resolver_selections; DROP TABLE projects;");
    store.close();
    store = new MnemuronStore(databasePath);
    const project = store.db.prepare("SELECT * FROM projects WHERE project_id = ?")
      .get("project-mnemuron");
    assert.equal(project.name, "Mnemuron");
    assert.equal(project.aliases_json, "[]");
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE task_id = ?")
        .get("task-mnemuron-production-readiness-v01").count,
      1,
    );
    assert.ok(store.db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resolver_selections'
    `).get());
    assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");

    const backupPath = path.join(root, "isolated-restore.sqlite3");
    await backup(store.db, backupPath);
    const restored = new MnemuronStore(backupPath);
    try {
      assert.equal(restored.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(
        restored.db.prepare("SELECT COUNT(*) AS count FROM projects WHERE project_id = ?")
          .get("project-mnemuron").count,
        1,
      );
      assert.equal(
        restored.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE task_id = ?")
          .get("task-mnemuron-production-readiness-v01").count,
        1,
      );
    } finally {
      restored.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("wrong Preview version remains rejected after Resolver selection", async () => {
  const context = await fixture();
  try {
    const preview = await api(context.baseUrl, context.agentKey, "POST", "/v1/resume/preview", {
      query: "task-atlas-deployment",
    }, 201);
    assert.equal(preview.status, "pending_confirmation");
    const response = await fetch(new URL(`/v1/resume/${preview.resume_id}/confirm`, context.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${context.agentKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ preview_version: preview.preview_version + 1, confirmed: true }),
    });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /version changed/i);
    assert.equal(
      context.app.store.db.prepare("SELECT COUNT(*) AS count FROM resolver_selections").get().count,
      0,
    );
  } finally {
    await cleanup(context);
  }
});

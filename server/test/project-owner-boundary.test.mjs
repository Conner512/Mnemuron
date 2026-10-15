// Owner boundary for the global project_id / task_id namespace (OWN-01..OWN-09).
// Every database here is a disposable fixture under os.tmpdir() with synthetic owners.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createMnemuronApp } from "../lib/app.mjs";
import { HandoffPolicy } from "../lib/handoff-policy.mjs";

const OWNER_A = "synthetic-owner-a";
const OWNER_B = "synthetic-owner-b";
const SQLITE_BUSY = 5;

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-project-owner-boundary-"));
  const databasePath = path.join(root, "mnemuron.sqlite3");
  const app = createMnemuronApp({ databasePath });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const a = app.store.bootstrapAdmin({ label: "Synthetic admin A", userId: OWNER_A });
  const b = app.store.bootstrapAdmin({ label: "Synthetic admin B", userId: OWNER_B });
  return {
    root,
    databasePath,
    app,
    store: app.store,
    baseUrl,
    a: { key: a.api_key, auth: a.credential },
    b: { key: b.api_key, auth: b.credential },
  };
}

async function cleanup(context) {
  if (context.app.server.listening) await context.app.close();
  rmSync(context.root, { recursive: true, force: true });
}

async function post(context, owner, endpoint, body) {
  const response = await fetch(new URL(endpoint, context.baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${owner.key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}

function projectRow(context, projectId) {
  const row = context.store.db.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId);
  return row ? { ...row } : null;
}

function taskRow(context, taskId) {
  const row = context.store.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
  return row ? { ...row } : null;
}

function count(context, sql, ...params) {
  return context.store.db.prepare(sql).get(...params).n;
}

function revisionCount(context, taskId) {
  return count(context, "SELECT COUNT(*) AS n FROM task_canonical_revisions WHERE task_id = ?", taskId);
}

function successAudits(context, userId, action) {
  return count(
    context,
    "SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND action = ? AND outcome = 'success'",
    userId,
    action,
  );
}

function taskPayload(overrides = {}) {
  return {
    task_id: "task-synthetic-a1",
    project_id: "project-synthetic-a",
    project_name: "Synthetic Project A",
    title: "Synthetic task A1",
    goal: "Exercise the owner boundary with synthetic data.",
    ...overrides,
  };
}

function seedOwnerA(context) {
  context.store.upsertProject(context.a.auth, {
    project_id: "project-synthetic-a",
    name: "Synthetic Project A",
    aliases: ["alpha-alias"],
    git_remotes: ["https://example.invalid/synthetic/a.git"],
    repo_fingerprints: ["fingerprint-a"],
    path_hints: ["/synthetic/a"],
  });
  context.store.upsertTask(context.a.auth, taskPayload());
}

function assertIdentifierUnavailable(response) {
  assert.equal(response.status, 409, response.text);
  assert.equal(response.body.error_code, "IDENTIFIER_UNAVAILABLE");
  assert.equal(response.text.includes(OWNER_A), false, "response must not reveal the other owner");
}

function assertNoOpenTransaction(context) {
  assert.equal(context.store.db.isTransaction, false);
}

test("OWN-01: another owner cannot rename or re-alias a project through POST /v1/projects", async () => {
  const context = await setup();
  try {
    seedOwnerA(context);
    const projectBefore = projectRow(context, "project-synthetic-a");
    const taskBefore = taskRow(context, "task-synthetic-a1");
    const revisionsBefore = revisionCount(context, "task-synthetic-a1");

    const response = await post(context, context.b, "/v1/projects", {
      project_id: "project-synthetic-a",
      name: "Renamed by B",
      aliases: ["b-alias"],
      git_remotes: ["https://example.invalid/synthetic/b.git"],
    });

    assertIdentifierUnavailable(response);
    assert.deepEqual(projectRow(context, "project-synthetic-a"), projectBefore);
    assert.deepEqual(taskRow(context, "task-synthetic-a1"), taskBefore);
    assert.equal(revisionCount(context, "task-synthetic-a1"), revisionsBefore);
    assert.equal(successAudits(context, OWNER_B, "project.upsert"), 0);
  } finally {
    await cleanup(context);
  }
});

test("OWN-02: another owner cannot create a task under a foreign project ID", async () => {
  const context = await setup();
  try {
    seedOwnerA(context);
    const projectBefore = projectRow(context, "project-synthetic-a");
    const tasksBefore = count(context, "SELECT COUNT(*) AS n FROM tasks");

    const response = await post(context, context.b, "/v1/tasks", taskPayload({
      task_id: "task-synthetic-b1",
      project_name: "Renamed by B",
      title: "B task under A's project",
    }));

    assertIdentifierUnavailable(response);
    assert.deepEqual(projectRow(context, "project-synthetic-a"), projectBefore);
    assert.equal(taskRow(context, "task-synthetic-b1"), null);
    assert.equal(count(context, "SELECT COUNT(*) AS n FROM tasks"), tasksBefore);
    assert.equal(revisionCount(context, "task-synthetic-b1"), 0);
    assert.equal(successAudits(context, OWNER_B, "task.upsert"), 0);
  } finally {
    await cleanup(context);
  }
});

test("OWN-03: a foreign task ID with the caller's new project ID is rejected atomically", async () => {
  const context = await setup();
  try {
    seedOwnerA(context);
    const taskBefore = taskRow(context, "task-synthetic-a1");
    const projectBefore = projectRow(context, "project-synthetic-a");
    const revisionsBefore = revisionCount(context, "task-synthetic-a1");

    const response = await post(context, context.b, "/v1/tasks", taskPayload({
      project_id: "project-synthetic-b-new",
      project_name: "Synthetic Project B",
      title: "B overwriting A's task",
    }));

    assertIdentifierUnavailable(response);
    assert.equal(projectRow(context, "project-synthetic-b-new"), null);
    assert.deepEqual(taskRow(context, "task-synthetic-a1"), taskBefore);
    assert.deepEqual(projectRow(context, "project-synthetic-a"), projectBefore);
    assert.equal(revisionCount(context, "task-synthetic-a1"), revisionsBefore);
    assert.equal(successAudits(context, OWNER_B, "task.upsert"), 0);
  } finally {
    await cleanup(context);
  }
});

test("OWN-04: direct ensureProject, upsertProject and upsertTask enforce the same boundary", async () => {
  const context = await setup();
  try {
    seedOwnerA(context);
    const projectBefore = projectRow(context, "project-synthetic-a");
    const taskBefore = taskRow(context, "task-synthetic-a1");
    const unavailable = { name: "ConflictError", errorCode: "IDENTIFIER_UNAVAILABLE", statusCode: 409 };

    assert.throws(
      () => context.store.ensureProject(context.b.auth, "project-synthetic-a", "Renamed by B"),
      unavailable,
    );
    assertNoOpenTransaction(context);
    assert.throws(
      () => context.store.upsertProject(context.b.auth, { project_id: "project-synthetic-a", name: "Renamed by B" }),
      unavailable,
    );
    assertNoOpenTransaction(context);
    assert.throws(
      () => context.store.upsertTask(context.b.auth, taskPayload({ task_id: "task-synthetic-b1", project_name: "Renamed by B" })),
      unavailable,
    );
    assertNoOpenTransaction(context);
    assert.throws(
      () => context.store.upsertTask(context.b.auth, taskPayload({ project_id: "project-synthetic-b-new" })),
      unavailable,
    );
    assertNoOpenTransaction(context);

    assert.deepEqual(projectRow(context, "project-synthetic-a"), projectBefore);
    assert.deepEqual(taskRow(context, "task-synthetic-a1"), taskBefore);
    assert.equal(projectRow(context, "project-synthetic-b-new"), null);
    assert.equal(taskRow(context, "task-synthetic-b1"), null);
  } finally {
    await cleanup(context);
  }
});

test("OWN-05: legitimate owner writes still succeed and a claimed new ID is then refused", async () => {
  const context = await setup();
  try {
    seedOwnerA(context);

    const renamed = await post(context, context.a, "/v1/projects", {
      project_id: "project-synthetic-a",
      name: "Synthetic Project A renamed",
      aliases: ["alpha-alias", "alpha-second"],
    });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.body.project.name, "Synthetic Project A renamed");
    assert.deepEqual(renamed.body.project.aliases, ["alpha-alias", "alpha-second"]);

    const updated = await post(context, context.a, "/v1/tasks", taskPayload({
      project_name: "Synthetic Project A renamed",
      goal: "Updated synthetic goal.",
    }));
    assert.equal(updated.status, 200, updated.text);
    assert.equal(updated.body.status, "saved");
    assert.equal(updated.body.canonical_version, 2);

    const createdB = await post(context, context.b, "/v1/tasks", taskPayload({
      task_id: "task-synthetic-b1",
      project_id: "project-synthetic-b",
      project_name: "Synthetic Project B",
      title: "Synthetic task B1",
    }));
    assert.equal(createdB.status, 200, createdB.text);
    assert.equal(createdB.body.status, "saved");
    assert.equal(projectRow(context, "project-synthetic-b").user_id, OWNER_B);
    assert.equal(taskRow(context, "task-synthetic-b1").user_id, OWNER_B);

    const projectB = projectRow(context, "project-synthetic-b");
    const taskB = taskRow(context, "task-synthetic-b1");
    assertIdentifierUnavailable(await post(context, context.a, "/v1/projects", {
      project_id: "project-synthetic-b",
      name: "Claimed by A",
    }));
    assertIdentifierUnavailable(await post(context, context.a, "/v1/tasks", taskPayload({
      task_id: "task-synthetic-b1",
      project_name: "Synthetic Project A renamed",
    })));
    assert.deepEqual(projectRow(context, "project-synthetic-b"), projectB);
    assert.deepEqual(taskRow(context, "task-synthetic-b1"), taskB);
  } finally {
    await cleanup(context);
  }
});

test("OWN-06: a competing writer is held off for the whole task upsert, then refused generically", async () => {
  const context = await setup();
  const competitor = new DatabaseSync(context.databasePath);
  try {
    competitor.exec("PRAGMA busy_timeout=50;");
    const timestamp = new Date().toISOString();
    const competingInsert = competitor.prepare(`
      INSERT INTO tasks (
        task_id, user_id, project_id, project_name, title, aliases_json,
        goal, status, progress_json, decisions_json, blockers_json,
        next_steps_json, resources_json, workstreams_json, conflicts_json,
        canonical_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '[]', ?, 'active', '[]', '[]', '[]', '[]', '[]', '[]', '[]', 1, ?, ?)
    `);
    let competingError = null;
    const ensureProject = context.store.ensureProject.bind(context.store);
    context.store.ensureProject = (auth, projectId, name) => {
      ensureProject(auth, projectId, name);
      try {
        competingInsert.run(
          "task-synthetic-race",
          OWNER_B,
          "project-synthetic-b-race",
          "Synthetic Project B race",
          "Competing task",
          "Competing synthetic goal.",
          timestamp,
          timestamp,
        );
      } catch (error) {
        competingError = error;
      }
    };

    const saved = context.store.upsertTask(context.a.auth, taskPayload({
      task_id: "task-synthetic-race",
      project_id: "project-synthetic-a-race",
      project_name: "Synthetic Project A race",
    }));
    delete context.store.ensureProject;

    assert.ok(competingError, "the competing insert must not succeed while the upsert is open");
    assert.equal(competingError.errcode, SQLITE_BUSY, String(competingError));
    assert.equal(saved.status, "saved");
    assertNoOpenTransaction(context);
    assert.equal(taskRow(context, "task-synthetic-race").user_id, OWNER_A);
    assert.equal(projectRow(context, "project-synthetic-a-race").user_id, OWNER_A);
    assert.equal(revisionCount(context, "task-synthetic-race"), 1);

    const refused = await post(context, context.b, "/v1/tasks", taskPayload({
      task_id: "task-synthetic-race",
      project_id: "project-synthetic-b-race",
      project_name: "Synthetic Project B race",
    }));
    assertIdentifierUnavailable(refused);
    assert.equal(projectRow(context, "project-synthetic-b-race"), null);
    assert.equal(taskRow(context, "task-synthetic-race").user_id, OWNER_A);
    assert.equal(revisionCount(context, "task-synthetic-race"), 1);
  } finally {
    competitor.close();
    await cleanup(context);
  }
});

test("OWN-07: a failure after ensureProject leaves an existing project unchanged and rolls back a new one", async (t) => {
  await t.test("canonical version conflict on an existing task", async () => {
    const context = await setup();
    try {
      seedOwnerA(context);
      const projectBefore = projectRow(context, "project-synthetic-a");
      const taskBefore = taskRow(context, "task-synthetic-a1");
      const revisionsBefore = revisionCount(context, "task-synthetic-a1");
      const taskFromRow = context.store.taskFromRow.bind(context.store);
      context.store.taskFromRow = (row) => {
        delete context.store.taskFromRow;
        context.store.db.prepare("UPDATE tasks SET canonical_version = canonical_version + 1 WHERE task_id = ?")
          .run(row.task_id);
        return taskFromRow(row);
      };

      assert.throws(
        () => context.store.upsertTask(context.a.auth, taskPayload({
          project_name: "Synthetic Project A renamed",
          goal: "A changed goal that loses the version race.",
        })),
        { name: "ConflictError", statusCode: 409 },
      );
      assertNoOpenTransaction(context);
      assert.deepEqual(projectRow(context, "project-synthetic-a"), projectBefore);
      assert.deepEqual(taskRow(context, "task-synthetic-a1"), taskBefore);
      assert.equal(revisionCount(context, "task-synthetic-a1"), revisionsBefore);
    } finally {
      await cleanup(context);
    }
  });

  await t.test("canonical revision write failure for a new project and task", async () => {
    const context = await setup();
    try {
      context.store.insertCanonicalRevision = () => {
        throw new Error("Injected canonical revision failure.");
      };
      assert.throws(
        () => context.store.upsertTask(context.a.auth, taskPayload()),
        /Injected canonical revision failure/,
      );
      delete context.store.insertCanonicalRevision;
      assertNoOpenTransaction(context);
      assert.equal(projectRow(context, "project-synthetic-a"), null);
      assert.equal(taskRow(context, "task-synthetic-a1"), null);
      assert.equal(successAudits(context, OWNER_A, "task.upsert"), 0);
    } finally {
      await cleanup(context);
    }
  });

  await t.test("raw UNIQUE failure on task insertion for a new project", async () => {
    const context = await setup();
    try {
      // A row claimed by another owner after the identifier check makes the real INSERT
      // fail on the primary key; it is written on the same connection, so it rolls back too.
      const ensureProject = context.store.ensureProject.bind(context.store);
      context.store.ensureProject = (auth, projectId, name) => {
        ensureProject(auth, projectId, name);
        const timestamp = new Date().toISOString();
        context.store.db.prepare(`
          INSERT INTO tasks (
            task_id, user_id, project_id, project_name, title, aliases_json,
            goal, status, progress_json, decisions_json, blockers_json,
            next_steps_json, resources_json, workstreams_json, conflicts_json,
            canonical_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'Injected row', '[]', 'Injected goal.', 'active',
            '[]', '[]', '[]', '[]', '[]', '[]', '[]', 1, ?, ?)
        `).run("task-synthetic-a1", OWNER_B, projectId, name, timestamp, timestamp);
      };
      assert.throws(
        () => context.store.upsertTask(context.a.auth, taskPayload()),
        (error) => error.code === "ERR_SQLITE_ERROR" && /UNIQUE/.test(error.message),
      );
      delete context.store.ensureProject;
      assertNoOpenTransaction(context);
      assert.equal(projectRow(context, "project-synthetic-a"), null);
      assert.equal(taskRow(context, "task-synthetic-a1"), null);
      assert.equal(revisionCount(context, "task-synthetic-a1"), 0);
    } finally {
      await cleanup(context);
    }
  });
});

test("OWN-08: same-owner partial rename keeps omitted fields and an identical task stays unchanged", async () => {
  const context = await setup();
  try {
    seedOwnerA(context);
    const before = projectRow(context, "project-synthetic-a");

    const renamed = await post(context, context.a, "/v1/projects", {
      project_id: "project-synthetic-a",
      name: "Synthetic Project A renamed",
    });
    assert.equal(renamed.status, 200, renamed.text);
    const after = projectRow(context, "project-synthetic-a");
    assert.equal(after.name, "Synthetic Project A renamed");
    assert.equal(after.user_id, OWNER_A);
    for (const field of ["aliases_json", "git_remotes_json", "repo_fingerprints_json", "path_hints_json", "created_at"]) {
      assert.equal(after[field], before[field], field);
    }

    // project_name is part of the canonical hash, so the unchanged task repeats the stored name.
    const stored = taskRow(context, "task-synthetic-a1");
    const revisionsBefore = revisionCount(context, "task-synthetic-a1");
    const unchanged = await post(context, context.a, "/v1/tasks", taskPayload());
    assert.equal(unchanged.status, 200, unchanged.text);
    assert.equal(unchanged.body.status, "unchanged");
    assert.equal(unchanged.body.canonical_version, stored.canonical_version);
    assert.deepEqual(taskRow(context, "task-synthetic-a1"), stored);
    assert.equal(revisionCount(context, "task-synthetic-a1"), revisionsBefore);
    assertNoOpenTransaction(context);
  } finally {
    await cleanup(context);
  }
});

test("OWN-09: a disabled handoff gate rejects own and foreign project and task writes", async () => {
  const context = await setup();
  try {
    seedOwnerA(context);
    new HandoffPolicy(context.store.db, { legacy: false, handoff: false });
    assert.equal(context.store.handoffPolicy.enabled(), false);
    const projectBefore = projectRow(context, "project-synthetic-a");
    const taskBefore = taskRow(context, "task-synthetic-a1");
    const projectsBefore = count(context, "SELECT COUNT(*) AS n FROM projects");
    const tasksBefore = count(context, "SELECT COUNT(*) AS n FROM tasks");

    const attempts = [
      [context.a, "/v1/projects", { project_id: "project-synthetic-a", name: "Own rename" }],
      [context.a, "/v1/tasks", taskPayload({ goal: "Own change while disabled." })],
      [context.b, "/v1/projects", { project_id: "project-synthetic-a", name: "Foreign rename" }],
      [context.b, "/v1/tasks", taskPayload({ task_id: "task-synthetic-b1", project_name: "Foreign rename" })],
    ];
    for (const [owner, endpoint, body] of attempts) {
      const response = await post(context, owner, endpoint, body);
      assert.equal(response.status, 409, response.text);
      assert.equal(response.body.error_code, "HANDOFF_DISABLED");
    }

    assert.deepEqual(projectRow(context, "project-synthetic-a"), projectBefore);
    assert.deepEqual(taskRow(context, "task-synthetic-a1"), taskBefore);
    assert.equal(count(context, "SELECT COUNT(*) AS n FROM projects"), projectsBefore);
    assert.equal(count(context, "SELECT COUNT(*) AS n FROM tasks"), tasksBefore);
  } finally {
    await cleanup(context);
  }
});

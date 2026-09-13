import assert from "node:assert/strict";
import { chmodSync, existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { MnemuronStore } from "../lib/store.mjs";

const [sourcePath, copyPath, userId, projectId, taskId] = process.argv.slice(2);
if (!sourcePath || !copyPath || !userId || !projectId || !taskId) {
  throw new Error("usage: node database-copy-task-branches-smoke.mjs <source.sqlite3> <new-copy.sqlite3> <user-id> <project-id> <task-id>");
}
assert.ok(!existsSync(copyPath), "copy destination must not already exist");
assert.notEqual(path.resolve(copyPath), realpathSync(sourcePath), "copy destination must differ from source");

const source = new DatabaseSync(sourcePath, { readOnly: true });
await backup(source, copyPath);
source.close();
chmodSync(copyPath, 0o600);

const store = new MnemuronStore(copyPath);
try {
  const auth = {
    user_id: userId,
    credential_id: "isolated-copy-smoke",
    device_id: "isolated-copy",
    agent_id: "test",
    agent_instance_id: "isolated-copy-smoke",
    scopes: ["resume:read"],
  };
  const counters = () => ({
    resumes: store.db.prepare("SELECT COUNT(*) count FROM resumes").get().count,
    resolver_selections: store.db.prepare("SELECT COUNT(*) count FROM resolver_selections").get().count,
    proposals: store.db.prepare("SELECT COUNT(*) count FROM task_reconciliation_proposals").get().count,
  });
  const before = counters();
  const project = store.previewProjectContext(auth, { query: projectId });
  const branches = store.previewTaskBranches(auth, {
    query: taskId,
  });
  const after = counters();
  const projectBytes = Buffer.byteLength(JSON.stringify(project));
  const branchBytes = Buffer.byteLength(JSON.stringify(branches));
  assert.equal(project.status, "project_context_preview");
  assert.equal(branches.status, "task_branches_preview");
  assert.equal(project.read_only, true);
  assert.equal(branches.read_only, true);
  assert.ok(projectBytes < 128 * 1024);
  assert.ok(branchBytes < 128 * 1024);
  assert.deepEqual(after, before);
  assert.equal(branches.safety.resume_created, false);
  assert.equal(branches.safety.task_scope_changed, false);
  assert.equal(branches.safety.canonical_task_changed, false);
  assert.equal(branches.safety.automatic_merge_performed, false);
  assert.equal(store.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
  process.stdout.write(`${JSON.stringify({
    status: "passed",
    database_copy_bytes: statSync(copyPath).size,
    project_response_bytes: projectBytes,
    branch_response_bytes: branchBytes,
    task_id: branches.task.task_id,
    branches: branches.branches.length,
    conflicts: branches.conflict_summary.count,
    counters_before: before,
    counters_after: after,
    quick_check: "ok",
    production_changed: false,
  })}\n`);
} finally {
  store.close();
}

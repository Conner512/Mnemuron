import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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

const baseTask = {
  task_id: "task-reconciliation-v01",
  project_id: "project-mnemuron",
  project_name: "Mnemuron",
  title: "Canonical Task Reconciliation v0.1",
  aliases: ["Canonical reconciliation"],
  goal: "Keep canonical Task state current without overwriting Workstream evidence.",
  status: "active",
  progress: ["Immutable Checkpoints are available."],
  decisions: ["Material canonical changes require confirmation."],
  blockers: ["Canonical Task still requires manual updates."],
  next_steps: ["Implement the reconciliation engine."],
  resources: ["docs/canonical-task-reconciliation-v0.1.md"],
  workstreams: [
    { workstream_id: "workstream-macmini", name: "Mac mini", status: "active" },
    { workstream_id: "workstream-macbook", name: "MacBook", status: "active" },
  ],
  conflicts: [],
};

async function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-reconciliation-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const admin = app.store.bootstrapAdmin();
  const mini = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
    label: "Mac mini reconciliation",
    device_id: "macmini-reconciliation",
    agent_id: "chatgpt",
    agent_instance_id: "chatgpt-macmini-reconciliation",
  }, 201);
  const book = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
    label: "MacBook reconciliation",
    device_id: "macbook-reconciliation",
    agent_id: "chatgpt",
    agent_instance_id: "chatgpt-macbook-reconciliation",
  }, 201);
  await api(baseUrl, admin.api_key, "POST", "/v1/tasks", baseTask);
  return { root, app, baseUrl, admin, mini, book };
}

async function close(context) {
  if (context.app.server.listening) await context.app.close();
  rmSync(context.root, { recursive: true, force: true });
}

test("safe derived progress auto-applies once with immutable provenance", async () => {
  const context = await setup();
  try {
    const noEffect = await api(
      context.baseUrl,
      context.mini.api_key,
      "POST",
      `/v1/tasks/${baseTask.task_id}/reconciliation/run`,
      {},
      201,
    );
    assert.equal(noEffect.status, "no_effect");
    assert.equal(noEffect.proposal.operations.length, 0);
    assert.equal(context.app.store.listTasks("user-local")[0].canonical_version, 1);

    const userEventId = randomUUID();
    const assistantEventId = randomUUID();
    const accepted = await api(context.baseUrl, context.mini.api_key, "POST", "/v1/events", {
      events: [
        {
          event_id: userEventId,
          event_type: "user_message",
          captured_at: "2026-09-03T01:00:00.000Z",
          project_id: baseTask.project_id,
          task_id: baseTask.task_id,
          workstream_id: "workstream-macmini",
          session_id: "session-reconcile-safe",
          content: "执行安全的 Canonical 进度回写测试。",
        },
        {
          event_id: assistantEventId,
          event_type: "assistant_message",
          hook_event_name: "Stop",
          captured_at: "2026-09-03T01:01:00.000Z",
          project_id: baseTask.project_id,
          task_id: baseTask.task_id,
          workstream_id: "workstream-macmini",
          session_id: "session-reconcile-safe",
          content: "已完成 Canonical Task Reconciliation 安全追加验证。",
        },
      ],
    }, 202);
    const checkpointResult = accepted.checkpoints[0];
    assert.equal(checkpointResult.status, "created");
    assert.equal(checkpointResult.reconciliation.status, "auto_applied");
    const proposal = checkpointResult.reconciliation.proposal;
    assert.equal(proposal.status, "auto_applied");
    assert.equal(proposal.operations.length, 1);
    assert.equal(proposal.operations[0].field, "progress");
    assert.equal(proposal.operations[0].automatic_eligible, true);
    assert.deepEqual(proposal.source_event_ids, [assistantEventId, userEventId].sort());
    assert.equal(proposal.source_workstreams[0].workstream_id, "workstream-macmini");
    assert.equal(
      proposal.source_workstreams[0].provenance.agent_instance_id,
      "chatgpt-macmini-reconciliation",
    );
    assert.ok(!proposal.operations.some((operation) =>
      operation.after === "Immutable Checkpoints are available."));

    const task = context.app.store.listTasks("user-local").find((item) =>
      item.task_id === baseTask.task_id);
    assert.equal(task.canonical_version, 2);
    assert.ok(task.progress.includes("已完成 Canonical Task Reconciliation 安全追加验证。"));

    const duplicate = await api(context.baseUrl, context.mini.api_key, "POST", "/v1/events", {
      events: [
        {
          event_id: userEventId,
          event_type: "user_message",
          captured_at: "2026-09-03T01:00:00.000Z",
          project_id: baseTask.project_id,
          task_id: baseTask.task_id,
          workstream_id: "workstream-macmini",
          session_id: "session-reconcile-safe",
          content: "执行安全的 Canonical 进度回写测试。",
        },
        {
          event_id: assistantEventId,
          event_type: "assistant_message",
          hook_event_name: "Stop",
          captured_at: "2026-09-03T01:01:00.000Z",
          project_id: baseTask.project_id,
          task_id: baseTask.task_id,
          workstream_id: "workstream-macmini",
          session_id: "session-reconcile-safe",
          content: "已完成 Canonical Task Reconciliation 安全追加验证。",
        },
      ],
    }, 202);
    assert.equal(duplicate.inserted, 0);
    assert.equal(duplicate.checkpoints[0].reconciliation.status, "existing");
    assert.equal(
      duplicate.checkpoints[0].reconciliation.proposal.proposal_id,
      proposal.proposal_id,
    );
    assert.equal(
      context.app.store.db.prepare(`
        SELECT COUNT(*) AS count FROM task_canonical_revisions
        WHERE task_id = ?
      `).get(baseTask.task_id).count,
      2,
    );

    const status = await api(context.baseUrl, context.mini.api_key, "GET", "/v1/status");
    assert.equal(status.canonical_reconciliation.auto_applied, 1);
    assert.equal(status.canonical_reconciliation.pending, 0);
    assert.equal(status.tasks[0].canonical_version, 2);
    const preview = await api(context.baseUrl, context.book.api_key, "POST", "/v1/resume/preview", {
      query: baseTask.task_id,
    }, 201);
    assert.equal(preview.canonical_version, 2);
    assert.equal(preview.canonical_freshness, "fresh");
    assert.equal(preview.canonical_reconciliation.pending_proposals.length, 0);
  } finally {
    await close(context);
  }
});

test("checkpoint telemetry stays immutable without becoming a canonical resource proposal", async () => {
  const context = await setup();
  try {
    const eventId = randomUUID();
    const accepted = await api(context.baseUrl, context.mini.api_key, "POST", "/v1/events", {
      event: {
        event_id: eventId,
        event_type: "assistant_message",
        hook_event_name: "Stop",
        captured_at: "2026-09-03T01:10:00.000Z",
        project_id: baseTask.project_id,
        task_id: baseTask.task_id,
        workstream_id: "workstream-macmini",
        session_id: "session-reconcile-telemetry-only",
        cwd: "/workspace/telemetry-only",
        tool_name: "apply_patch",
      },
    }, 202);
    const checkpointResult = accepted.checkpoints[0];
    assert.equal(checkpointResult.status, "created");
    assert.ok(checkpointResult.checkpoint.resources.some((item) =>
      item.source === "derived_from_event"
      && item.category === "working_directory"
      && item.text === "/workspace/telemetry-only"));
    assert.ok(checkpointResult.checkpoint.resources.some((item) =>
      item.source === "derived_from_event"
      && item.category === "tool"
      && item.text === "apply_patch"));
    assert.equal(checkpointResult.reconciliation.status, "no_effect");
    assert.deepEqual(checkpointResult.reconciliation.proposal.operations, []);
    assert.equal(
      checkpointResult.reconciliation.proposal.policy.derived_resource_telemetry_ignored,
      true,
    );
    assert.equal(
      (await api(
        context.baseUrl,
        context.book.api_key,
        "GET",
        `/v1/tasks/${baseTask.task_id}/reconciliation`,
      )).summary.pending,
      0,
    );

    const curated = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/tasks/${baseTask.task_id}/reconciliation/run`,
      {
        source_checkpoint_ids: [checkpointResult.checkpoint.checkpoint_id],
        derive_checkpoint_operations: false,
        operations: [{
          op: "append_unique",
          field: "resources",
          value: "docs/operator-approved-resource.md",
        }],
      },
      201,
    );
    assert.equal(curated.status, "awaiting_confirmation");
    assert.equal(curated.proposal.operations.length, 1);
    assert.equal(curated.proposal.operations[0].field, "resources");
    assert.equal(curated.proposal.operations[0].after, "docs/operator-approved-resource.md");
    assert.equal(curated.proposal.operations[0].sources[0].source_type, "user_requested");
  } finally {
    await close(context);
  }
});

test("material operations require exact confirmation and remain separate from Resume confirmation", async () => {
  const context = await setup();
  try {
    const proposalResult = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/tasks/${baseTask.task_id}/reconciliation/run`,
      {
        operations: [
          {
            op: "append_unique",
            field: "decisions",
            value: "Prioritize core usability over the deferred recovery profiles.",
          },
          {
            op: "remove_exact",
            field: "blockers",
            value: "Canonical Task still requires manual updates.",
          },
          {
            op: "remove_exact",
            field: "next_steps",
            value: "Implement the reconciliation engine.",
          },
          {
            op: "append_unique",
            field: "next_steps",
            value: "Run isolated Canonical reconciliation acceptance.",
          },
          {
            op: "replace_workstream_status",
            field: "workstreams",
            workstream_id: "workstream-macmini",
            value: "completed",
          },
          {
            op: "record_conflict",
            field: "conflicts",
            value: {
              conflict_id: "conflict-review-sample",
              status: "preserved",
              claims: ["Mac mini complete", "MacBook still active"],
            },
          },
        ],
      },
      201,
    );
    assert.equal(proposalResult.status, "awaiting_confirmation");
    const proposal = proposalResult.proposal;
    assert.equal(proposal.base_canonical_version, 1);
    assert.equal(proposal.operations.length, 6);
    assert.equal(context.app.store.listTasks("user-local")[0].canonical_version, 1);

    const repeatedPreview = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/tasks/${baseTask.task_id}/reconciliation/run`,
      {},
      201,
    );
    assert.equal(repeatedPreview.status, "existing");
    assert.equal(repeatedPreview.proposal.proposal_id, proposal.proposal_id);
    assert.deepEqual(repeatedPreview.deferred_checkpoint_ids, []);

    const pendingPreview = await api(
      context.baseUrl,
      context.mini.api_key,
      "POST",
      "/v1/resume/preview",
      { query: baseTask.task_id },
      201,
    );
    assert.equal(pendingPreview.canonical_freshness, "updates_pending");
    assert.equal(pendingPreview.canonical_reconciliation.pending_proposals.length, 1);
    await api(
      context.baseUrl,
      context.mini.api_key,
      "POST",
      `/v1/resume/${pendingPreview.resume_id}/confirm`,
      { preview_version: 1, confirmed: true },
    );
    assert.equal(context.app.store.listTasks("user-local")[0].canonical_version, 1);
    assert.equal(
      (await api(
        context.baseUrl,
        context.book.api_key,
        "GET",
        `/v1/tasks/${baseTask.task_id}/reconciliation`,
      )).summary.pending,
      1,
    );

    await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/task-reconciliations/${proposal.proposal_id}/resolve`,
      {
        proposal_version: 1,
        base_canonical_version: 2,
        decision: "confirm",
      },
      409,
    );
    const applied = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/task-reconciliations/${proposal.proposal_id}/resolve`,
      {
        proposal_version: 1,
        base_canonical_version: 1,
        decision: "confirm",
      },
    );
    assert.equal(applied.status, "applied");
    assert.equal(applied.task.canonical_version, 2);
    assert.equal(applied.task.blockers.length, 0);
    assert.deepEqual(applied.task.next_steps, ["Run isolated Canonical reconciliation acceptance."]);
    assert.equal(
      applied.task.workstreams.find((item) => item.workstream_id === "workstream-macmini").status,
      "completed",
    );
    assert.equal(applied.task.conflicts[0].conflict_id, "conflict-review-sample");
    assert.ok(applied.task.decisions.includes(
      "Prioritize core usability over the deferred recovery profiles.",
    ));
    assert.equal(applied.revision.canonical_version_before, 1);
    assert.equal(applied.revision.canonical_version_after, 2);
    assert.equal(applied.revision.decision, "user_confirmed");
    const revisions = await api(
      context.baseUrl,
      context.book.api_key,
      "GET",
      `/v1/tasks/${baseTask.task_id}/canonical-revisions`,
    );
    assert.equal(revisions.revisions.length, 2);
    assert.equal(revisions.revisions[0].revision_id, applied.revision.revision_id);
    assert.equal(revisions.revisions[1].decision, "task_create");

    const replay = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/task-reconciliations/${proposal.proposal_id}/resolve`,
      {
        proposal_version: 1,
        base_canonical_version: 1,
        decision: "confirm",
      },
    );
    assert.equal(replay.revision.revision_id, applied.revision.revision_id);
    assert.equal(context.app.store.listTasks("user-local")[0].canonical_version, 2);

    const rejection = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/tasks/${baseTask.task_id}/reconciliation/run`,
      {
        operations: [{
          op: "append_unique",
          field: "blockers",
          value: "Disposable review-only blocker.",
        }],
      },
      201,
    );
    const interveningStop = await api(
      context.baseUrl,
      context.mini.api_key,
      "POST",
      "/v1/events",
      {
        event: {
          event_id: randomUUID(),
          event_type: "assistant_message",
          hook_event_name: "Stop",
          captured_at: "2026-09-03T01:30:00.000Z",
          project_id: baseTask.project_id,
          task_id: baseTask.task_id,
          workstream_id: "workstream-macmini",
          session_id: "session-reconciliation-rejection-liveness",
          content: "已完成待确认 Proposal 拒绝活性验证。",
        },
      },
      202,
    );
    const deferredCheckpointId = interveningStop.checkpoints[0].checkpoint.checkpoint_id;
    assert.equal(
      interveningStop.checkpoints[0].reconciliation.status,
      "deferred_pending_confirmation",
    );
    assert.equal(
      interveningStop.checkpoints[0].reconciliation.proposal.proposal_id,
      rejection.proposal.proposal_id,
    );
    assert.deepEqual(
      interveningStop.checkpoints[0].reconciliation.deferred_checkpoint_ids,
      [deferredCheckpointId],
    );
    const rejected = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/task-reconciliations/${rejection.proposal.proposal_id}/resolve`,
      {
        proposal_version: 1,
        base_canonical_version: 2,
        decision: "reject",
      },
    );
    assert.equal(rejected.status, "rejected");
    assert.deepEqual(rejected.deferred_checkpoint_ids, [deferredCheckpointId]);
    const rejectedReplay = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/task-reconciliations/${rejection.proposal.proposal_id}/resolve`,
      {
        proposal_version: 1,
        base_canonical_version: 2,
        decision: "reject",
      },
    );
    assert.equal(rejectedReplay.status, "rejected");
    assert.equal(context.app.store.listTasks("user-local")[0].blockers.length, 0);
  } finally {
    await close(context);
  }
});

test("pending proposal stays stable while parallel Workstream checkpoints are deferred", async () => {
  const context = await setup();
  try {
    const first = await api(context.baseUrl, context.mini.api_key, "POST", "/v1/events", {
      event: {
        event_id: randomUUID(),
        event_type: "assistant_message",
        hook_event_name: "Stop",
        captured_at: "2026-09-03T02:00:00.000Z",
        project_id: baseTask.project_id,
        task_id: baseTask.task_id,
        workstream_id: "workstream-macmini",
        session_id: "session-reconcile-low-mini",
        content: "已完成 Mac mini 的低置信度来源验证。",
      },
    }, 202);
    assert.equal(first.checkpoints[0].checkpoint.generation.confidence_label, "low");
    assert.equal(first.checkpoints[0].reconciliation.status, "awaiting_confirmation");
    assert.equal(context.app.store.listTasks("user-local")[0].canonical_version, 1);

    const second = await api(context.baseUrl, context.book.api_key, "POST", "/v1/events", {
      event: {
        event_id: randomUUID(),
        event_type: "assistant_message",
        hook_event_name: "Stop",
        captured_at: "2026-09-03T02:01:00.000Z",
        project_id: baseTask.project_id,
        task_id: baseTask.task_id,
        workstream_id: "workstream-macbook",
        session_id: "session-reconcile-low-book",
        content: "已完成 MacBook 的独立低置信度来源验证。",
      },
    }, 202);
    const frozen = second.checkpoints[0].reconciliation;
    const deferredCheckpointId = second.checkpoints[0].checkpoint.checkpoint_id;
    assert.equal(frozen.status, "deferred_pending_confirmation");
    assert.equal(frozen.proposal.proposal_id, first.checkpoints[0].reconciliation.proposal.proposal_id);
    assert.equal(frozen.proposal.operations.length, 1);
    assert.deepEqual(frozen.deferred_checkpoint_ids, [deferredCheckpointId]);
    assert.equal(
      context.app.store.db.prepare(`
        SELECT status FROM task_reconciliation_proposals WHERE proposal_id = ?
      `).get(first.checkpoints[0].reconciliation.proposal.proposal_id).status,
      "awaiting_confirmation",
    );
    const frozenState = await api(
      context.baseUrl,
      context.book.api_key,
      "GET",
      `/v1/tasks/${baseTask.task_id}/reconciliation`,
    );
    assert.equal(frozenState.summary.pending, 1);
    assert.equal(frozenState.summary.deferred_checkpoints, 1);
    assert.deepEqual(frozenState.deferred_checkpoint_ids, [deferredCheckpointId]);
    const globalFrozenStatus = await api(
      context.baseUrl,
      context.book.api_key,
      "GET",
      "/v1/status",
    );
    assert.equal(globalFrozenStatus.canonical_reconciliation.pending, 1);
    assert.equal(globalFrozenStatus.canonical_reconciliation.deferred_checkpoints, 1);

    const appliedMini = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/task-reconciliations/${frozen.proposal.proposal_id}/resolve`,
      {
        proposal_version: 1,
        base_canonical_version: 1,
        decision: "confirm",
      },
    );
    assert.equal(appliedMini.status, "applied");
    assert.equal(appliedMini.task.canonical_version, 2);
    assert.deepEqual(appliedMini.deferred_checkpoint_ids, [deferredCheckpointId]);

    const regenerated = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/tasks/${baseTask.task_id}/reconciliation/run`,
      { source_checkpoint_ids: [deferredCheckpointId] },
      201,
    );
    assert.equal(regenerated.status, "awaiting_confirmation");
    assert.equal(regenerated.proposal.base_canonical_version, 2);
    assert.equal(regenerated.proposal.operations.length, 1);
    assert.equal(
      regenerated.proposal.operations[0].sources[0].workstream_id,
      "workstream-macbook",
    );
    const appliedBook = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/task-reconciliations/${regenerated.proposal.proposal_id}/resolve`,
      {
        proposal_version: 1,
        base_canonical_version: 2,
        decision: "confirm",
      },
    );
    assert.equal(appliedBook.task.canonical_version, 3);
    assert.deepEqual(appliedBook.deferred_checkpoint_ids, []);
    assert.ok(appliedBook.task.progress.includes("已完成 Mac mini 的低置信度来源验证。"));
    assert.ok(appliedBook.task.progress.includes("已完成 MacBook 的独立低置信度来源验证。"));

    const conflicted = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/tasks/${baseTask.task_id}/reconciliation/run`,
      {
        operations: [
          { op: "replace_scalar", field: "status", value: "completed" },
          { op: "replace_scalar", field: "status", value: "paused" },
        ],
      },
      201,
    );
    assert.equal(conflicted.proposal.conflicts.length, 1);
    assert.equal(
      (await api(
        context.baseUrl,
        context.mini.api_key,
        "GET",
        `/v1/tasks/${baseTask.task_id}/reconciliation`,
      )).canonical_freshness,
      "conflict_pending",
    );
    await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/task-reconciliations/${conflicted.proposal.proposal_id}/resolve`,
      {
        proposal_version: 1,
        base_canonical_version: 3,
        decision: "confirm",
      },
      409,
    );
    assert.equal(context.app.store.listTasks("user-local")[0].status, "active");
    const rejectedConflict = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/task-reconciliations/${conflicted.proposal.proposal_id}/resolve`,
      {
        proposal_version: 1,
        base_canonical_version: 3,
        decision: "reject",
      },
    );
    assert.equal(rejectedConflict.status, "rejected");

    const staleCandidate = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/tasks/${baseTask.task_id}/reconciliation/run`,
      {
        operations: [{
          op: "append_unique",
          field: "decisions",
          value: "This proposal must become stale after an admin revision.",
        }],
      },
      201,
    );
    await api(context.baseUrl, context.admin.api_key, "POST", "/v1/tasks", {
      ...baseTask,
      progress: [...baseTask.progress, "An independent admin revision was recorded."],
    });
    await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/task-reconciliations/${staleCandidate.proposal.proposal_id}/resolve`,
      {
        proposal_version: 1,
        base_canonical_version: 3,
        decision: "confirm",
      },
      409,
    );
    assert.equal(
      context.app.store.db.prepare(`
        SELECT status FROM task_reconciliation_proposals WHERE proposal_id = ?
      `).get(staleCandidate.proposal.proposal_id).status,
      "stale",
    );
    const finalTask = context.app.store.listTasks("user-local")[0];
    assert.equal(finalTask.canonical_version, 4);
    assert.ok(finalTask.progress.includes("An independent admin revision was recorded."));
    assert.ok(!finalTask.decisions.includes(
      "This proposal must become stale after an admin revision.",
    ));
  } finally {
    await close(context);
  }
});

test("curated checkpoint proposal preserves evidence without importing derived noise", async () => {
  const context = await setup();
  try {
    const first = await api(context.baseUrl, context.mini.api_key, "POST", "/v1/events", {
      event: {
        event_id: randomUUID(),
        event_type: "assistant_message",
        hook_event_name: "Stop",
        captured_at: "2026-09-03T03:00:00.000Z",
        project_id: baseTask.project_id,
        task_id: baseTask.task_id,
        workstream_id: "workstream-macmini",
        session_id: "session-curated-source-mini",
        content: "已完成 Mac mini 的低置信度来源验证。",
      },
    }, 202);
    assert.equal(first.checkpoints[0].reconciliation.status, "awaiting_confirmation");

    const second = await api(context.baseUrl, context.book.api_key, "POST", "/v1/events", {
      event: {
        event_id: randomUUID(),
        event_type: "assistant_message",
        hook_event_name: "Stop",
        captured_at: "2026-09-03T03:01:00.000Z",
        project_id: baseTask.project_id,
        task_id: baseTask.task_id,
        workstream_id: "workstream-macbook",
        session_id: "session-curated-source-book",
        content: "已完成 MacBook 的独立低置信度来源验证。",
      },
    }, 202);
    const pendingProposal = first.checkpoints[0].reconciliation.proposal;
    const evidenceCheckpoint = second.checkpoints[0].checkpoint;
    assert.equal(second.checkpoints[0].reconciliation.status, "deferred_pending_confirmation");

    const blocked = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/tasks/${baseTask.task_id}/reconciliation/run`,
      {
        source_checkpoint_ids: [evidenceCheckpoint.checkpoint_id],
        derive_checkpoint_operations: false,
        operations: [{
          op: "append_unique",
          field: "progress",
          value: "Proposal Freeze completed evidence-backed production acceptance.",
        }],
      },
      409,
    );
    assert.match(blocked.error, /Resolve the pending reconciliation proposal/);

    await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/task-reconciliations/${pendingProposal.proposal_id}/resolve`,
      {
        proposal_version: pendingProposal.proposal_version,
        base_canonical_version: pendingProposal.base_canonical_version,
        decision: "reject",
      },
    );

    const curated = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/tasks/${baseTask.task_id}/reconciliation/run`,
      {
        source_checkpoint_ids: [evidenceCheckpoint.checkpoint_id],
        derive_checkpoint_operations: false,
        operations: [{
          op: "append_unique",
          field: "progress",
          value: "Proposal Freeze completed evidence-backed production acceptance.",
        }],
      },
      201,
    );
    assert.equal(curated.status, "awaiting_confirmation");
    assert.deepEqual(curated.proposal.source_checkpoint_ids, [evidenceCheckpoint.checkpoint_id]);
    assert.deepEqual(curated.proposal.source_event_ids, evidenceCheckpoint.source_event_ids);
    assert.equal(curated.proposal.source_workstreams.length, 1);
    assert.equal(curated.proposal.source_workstreams[0].workstream_id, "workstream-macbook");
    assert.equal(curated.proposal.operations.length, 1);
    assert.equal(curated.proposal.operations[0].field, "progress");
    assert.equal(curated.proposal.operations[0].sources[0].source_type, "user_requested");
    assert.equal(curated.proposal.policy.checkpoint_operations_derived, false);
    assert.ok(!curated.proposal.operations.some((operation) => operation.field === "resources"));

    const applied = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/task-reconciliations/${curated.proposal.proposal_id}/resolve`,
      {
        proposal_version: curated.proposal.proposal_version,
        base_canonical_version: curated.proposal.base_canonical_version,
        decision: "confirm",
      },
    );
    assert.equal(applied.status, "applied");
    assert.equal(applied.task.canonical_version, 2);
    assert.ok(applied.task.progress.includes(
      "Proposal Freeze completed evidence-backed production acceptance.",
    ));
    assert.ok(!applied.task.resources.includes("Bash"));

    const missingEvidence = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/tasks/${baseTask.task_id}/reconciliation/run`,
      {
        derive_checkpoint_operations: false,
        operations: [{
          op: "append_unique",
          field: "decisions",
          value: "This must be rejected without explicit evidence Checkpoints.",
        }],
      },
      400,
    );
    assert.match(missingEvidence.error, /requires explicit operations and source_checkpoint_ids/);
  } finally {
    await close(context);
  }
});

test("reconciliation endpoints enforce read and confirmation scopes", async () => {
  const context = await setup();
  try {
    const readOnly = await api(
      context.baseUrl,
      context.admin.api_key,
      "POST",
      "/v1/agent-instances/register",
      {
        label: "Reconciliation read only",
        device_id: "readonly-reconciliation",
        agent_id: "chatgpt",
        agent_instance_id: "chatgpt-readonly-reconciliation",
        scopes: ["memory:read", "task:reconcile:read"],
      },
      201,
    );
    const state = await api(
      context.baseUrl,
      readOnly.api_key,
      "GET",
      `/v1/tasks/${baseTask.task_id}/reconciliation`,
    );
    assert.equal(state.canonical_version, 1);
    await api(
      context.baseUrl,
      readOnly.api_key,
      "POST",
      `/v1/tasks/${baseTask.task_id}/reconciliation/run`,
      {
        operations: [{
          op: "replace_scalar",
          field: "status",
          value: "completed",
        }],
      },
      403,
    );
    const proposal = await api(
      context.baseUrl,
      context.book.api_key,
      "POST",
      `/v1/tasks/${baseTask.task_id}/reconciliation/run`,
      {
        operations: [{
          op: "replace_scalar",
          field: "status",
          value: "completed",
        }],
      },
      201,
    );
    await api(
      context.baseUrl,
      readOnly.api_key,
      "POST",
      `/v1/task-reconciliations/${proposal.proposal.proposal_id}/resolve`,
      {
        proposal_version: 1,
        base_canonical_version: 1,
        decision: "confirm",
      },
      403,
    );
    assert.equal(context.app.store.listTasks("user-local")[0].status, "active");
  } finally {
    await close(context);
  }
});

test("reconciliation failure never rolls back accepted Events or Checkpoints", async () => {
  const context = await setup();
  try {
    context.app.store.runReconciliation = () => {
      throw new Error("isolated reconciliation fault");
    };
    const eventId = randomUUID();
    const accepted = await api(context.baseUrl, context.mini.api_key, "POST", "/v1/events", {
      event: {
        event_id: eventId,
        event_type: "assistant_message",
        hook_event_name: "Stop",
        captured_at: "2026-09-03T03:00:00.000Z",
        project_id: baseTask.project_id,
        task_id: baseTask.task_id,
        workstream_id: "workstream-macmini",
        session_id: "session-reconciliation-fault",
        content: "已完成故障边界验证。",
      },
    }, 202);
    assert.equal(accepted.inserted, 1);
    assert.equal(accepted.checkpoints[0].status, "created");
    assert.equal(accepted.checkpoints[0].reconciliation.status, "failed");
    assert.match(accepted.checkpoints[0].reconciliation.error, /isolated reconciliation fault/);
    assert.equal(
      context.app.store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_id = ?")
        .get(eventId).count,
      1,
    );
    assert.equal(
      context.app.store.db.prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE trigger_event_id = ?")
        .get(eventId).count,
      1,
    );
  } finally {
    await close(context);
  }
});

test("old schema migrates only on a disposable copy and baseline revision is idempotent", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-reconciliation-migration-"));
  const sourcePath = path.join(root, "old-source.sqlite3");
  const copyPath = path.join(root, "migration-copy.sqlite3");
  try {
    const old = new DatabaseSync(sourcePath);
    old.exec(`
      CREATE TABLE tasks (
        task_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        title TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        goal TEXT NOT NULL,
        status TEXT NOT NULL,
        progress_json TEXT NOT NULL,
        decisions_json TEXT NOT NULL,
        blockers_json TEXT NOT NULL,
        next_steps_json TEXT NOT NULL,
        resources_json TEXT NOT NULL,
        workstreams_json TEXT NOT NULL,
        conflicts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    old.prepare(`
      INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      baseTask.task_id,
      "user-local",
      baseTask.project_id,
      baseTask.project_name,
      baseTask.title,
      JSON.stringify(baseTask.aliases),
      baseTask.goal,
      baseTask.status,
      JSON.stringify(baseTask.progress),
      JSON.stringify(baseTask.decisions),
      JSON.stringify(baseTask.blockers),
      JSON.stringify(baseTask.next_steps),
      JSON.stringify(baseTask.resources),
      JSON.stringify(baseTask.workstreams),
      JSON.stringify(baseTask.conflicts),
      "2026-09-03T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    );
    old.close();
    const sourceHashBefore = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    copyFileSync(sourcePath, copyPath);

    let migrated = new MnemuronStore(copyPath);
    const taskBeforeReopen = migrated.listTasks("user-local")[0];
    assert.equal(taskBeforeReopen.canonical_version, 1);
    assert.deepEqual(taskBeforeReopen.progress, baseTask.progress);
    assert.deepEqual(taskBeforeReopen.blockers, baseTask.blockers);
    assert.ok(migrated.db.prepare("PRAGMA table_info(tasks)").all()
      .some((column) => column.name === "canonical_version"));
    assert.equal(
      migrated.db.prepare("SELECT COUNT(*) AS count FROM task_reconciliation_proposals").get().count,
      0,
    );
    assert.equal(
      migrated.db.prepare("SELECT COUNT(*) AS count FROM task_canonical_revisions").get().count,
      1,
    );
    assert.equal(
      migrated.db.prepare("SELECT decision FROM task_canonical_revisions").get().decision,
      "migration_baseline",
    );
    assert.equal(migrated.db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    assert.equal(migrated.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    migrated.close();

    migrated = new MnemuronStore(copyPath);
    assert.equal(
      migrated.db.prepare("SELECT COUNT(*) AS count FROM task_canonical_revisions").get().count,
      1,
    );
    assert.deepEqual(migrated.listTasks("user-local")[0].decisions, baseTask.decisions);
    migrated.close();

    const sourceHashAfter = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    assert.equal(sourceHashAfter, sourceHashBefore);
    const untouchedSource = new DatabaseSync(sourcePath, { readOnly: true });
    assert.ok(!untouchedSource.prepare("PRAGMA table_info(tasks)").all()
      .some((column) => column.name === "canonical_version"));
    assert.equal(untouchedSource.prepare("SELECT COUNT(*) AS count FROM tasks").get().count, 1);
    untouchedSource.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing credentials preview and receive reconciliation scopes only on explicit apply", async () => {
  const context = await setup();
  try {
    const legacy = context.app.store.issueCredential({
      label: "Legacy reconciliation client",
      deviceId: "legacy-device",
      agentId: "chatgpt",
      agentInstanceId: "legacy-reconciliation-client",
      scopes: [
        "capture:write",
        "memory:read",
        "memory:write",
        "resume:read",
        "resume:confirm",
      ],
    });
    const adminAuth = context.app.store.authenticate(context.admin.api_key);

    const preview = context.app.store.updateReconciliationScopes(
      adminAuth,
      "legacy-reconciliation-client",
    );
    assert.equal(preview.status, "preview");
    assert.equal(preview.credentials_to_update, 1);
    assert.equal(preview.applied, false);
    assert.ok(!context.app.store.authenticate(legacy.api_key).scopes.includes("task:reconcile:read"));

    const applied = context.app.store.updateReconciliationScopes(
      adminAuth,
      "legacy-reconciliation-client",
      { apply: true },
    );
    assert.equal(applied.status, "updated");
    assert.equal(applied.updated_credentials, 1);
    assert.deepEqual(
      context.app.store.authenticate(legacy.api_key).scopes.slice(-2),
      ["task:reconcile:read", "task:reconcile:confirm"],
    );

    const replay = context.app.store.updateReconciliationScopes(
      adminAuth,
      "legacy-reconciliation-client",
      { apply: true },
    );
    assert.equal(replay.status, "unchanged");
    assert.equal(replay.credentials_to_update, 0);
    assert.equal(replay.applied, false);
    assert.equal(
      context.app.store.db.prepare(`
        SELECT COUNT(*) AS count FROM audit_events
        WHERE action = 'credential.reconciliation_scopes.update'
          AND target_id = 'legacy-reconciliation-client'
      `).get().count,
      1,
    );
  } finally {
    await close(context);
  }
});

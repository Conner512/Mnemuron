import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  activateTaskScope,
  activateTaskBootstrapScope,
  activateTaskScopeForResume,
  armPendingResumeDeliveries,
  authorizeMcpSession,
  claimMcpResumeDelivery,
  finishMcpResumeDelivery,
  markMcpResumeContextReturned,
  pendingResumeCounts,
  queueResumeInjection,
  resolveTaskScope,
  stageTaskScopeForSession,
  taskScopeCounts,
} from "../scripts/storage.mjs";

function packet(resumeId, taskId, previewVersion = 1) {
  return {
    resume_id: resumeId,
    preview_version: previewVersion,
    project: { project_id: "project-mnemuron" },
    task: { task_id: taskId },
    selected_workstreams: [{ workstream_id: "workstream-source" }],
  };
}

function bootstrapPacket(bootstrapId, taskId, previewVersion = 1) {
  return {
    bootstrap_id: bootstrapId,
    preview_version: previewVersion,
    project: { project_id: "project-mnemuron" },
    task: { task_id: taskId },
    workstream: { workstream_id: "workstream-destination" },
  };
}

test("concurrent Sessions stay independent and same-Session supersession is exact", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-scope-concurrency-"));
  const env = {
    MNEMURON_CONFIG_PATH: path.join(dataDir, "missing-config.json"),
    MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-destination",
  };
  try {
    const firstA = stageTaskScopeForSession(
      dataDir,
      packet("resume-session-a-v1", "task-session-a-v1"),
      "session-a",
      env,
    );
    const firstB = stageTaskScopeForSession(
      dataDir,
      packet("resume-session-b-v1", "task-session-b-v1"),
      "session-b",
      env,
    );
    assert.equal(firstA.status, "pending");
    assert.equal(firstB.status, "pending");
    activateTaskScope(dataDir, "session-a", env);
    activateTaskScope(dataDir, "session-b", env);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 0, active: 2, superseded: 0 });
    assert.equal(resolveTaskScope(dataDir, "session-a", env).task_id, "task-session-a-v1");
    assert.equal(resolveTaskScope(dataDir, "session-b", env).task_id, "task-session-b-v1");

    await new Promise((resolve) => setTimeout(resolve, 2));
    const newerA = stageTaskScopeForSession(
      dataDir,
      packet("resume-session-a-v2", "task-session-a-v2"),
      "session-a",
      env,
    );
    activateTaskScope(dataDir, "session-a", env);
    assert.equal(newerA.status, "pending");
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 0, active: 2, superseded: 1 });
    assert.equal(resolveTaskScope(dataDir, "session-a", env).task_id, "task-session-a-v2");
    assert.equal(resolveTaskScope(dataDir, "session-b", env).task_id, "task-session-b-v1");

    const repeated = stageTaskScopeForSession(
      dataDir,
      packet("resume-session-a-v2", "task-session-a-v2"),
      "session-a",
      env,
    );
    assert.equal(repeated.status, "active");
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 0, active: 2, superseded: 1 });
    assert.throws(
      () => stageTaskScopeForSession(
        dataDir,
        packet("resume-session-a-v2", "task-session-a-v2"),
        "session-c",
        env,
      ),
      /already staged for a different ChatGPT session/i,
    );
    assert.equal(resolveTaskScope(dataDir, "session-a", env).task_id, "task-session-a-v2");
    assert.equal(resolveTaskScope(dataDir, "session-b", env).task_id, "task-session-b-v1");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("same-Session MCP Resume delivery is FIFO and activates the exact claimed binding", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-scope-delivery-order-"));
  const env = {
    MNEMURON_CONFIG_PATH: path.join(dataDir, "missing-config.json"),
    MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-destination",
  };
  const sessionId = "session-shared";
  try {
    authorizeMcpSession(dataDir, sessionId, {
      hookEventName: "UserPromptSubmit",
      turnId: "turn-confirm",
    });
    const olderPacket = packet("z-resume-older", "task-older");
    const olderScope = stageTaskScopeForSession(dataDir, olderPacket, sessionId, env);
    queueResumeInjection(
      dataDir,
      olderPacket,
      sessionId,
      olderScope.workstream_id,
      { injectionMethod: "codex-mcp-delivery-receipt", armed: false },
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newerPacket = packet("a-resume-newer", "task-newer");
    const newerScope = stageTaskScopeForSession(dataDir, newerPacket, sessionId, env);
    queueResumeInjection(
      dataDir,
      newerPacket,
      sessionId,
      newerScope.workstream_id,
      { injectionMethod: "codex-mcp-delivery-receipt", armed: false },
    );
    armPendingResumeDeliveries(dataDir, sessionId, "turn-confirm");

    const firstClaim = claimMcpResumeDelivery(dataDir, sessionId);
    assert.equal(firstClaim.resume_id, olderPacket.resume_id);
    const repeatedClaim = claimMcpResumeDelivery(dataDir, sessionId);
    assert.equal(repeatedClaim.receipt_id, firstClaim.receipt_id);
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 1,
      in_flight: 1,
      delivered: 0,
    });

    const firstActive = activateTaskScopeForResume(
      dataDir,
      sessionId,
      firstClaim.resume_id,
      firstClaim.preview_version,
      env,
    );
    assert.equal(firstActive.binding_id, firstClaim.resume_id);
    assert.equal(firstActive.task_id, olderPacket.task.task_id);
    assert.equal(resolveTaskScope(dataDir, sessionId, env).binding_id, firstClaim.resume_id);
    assert.equal(markMcpResumeContextReturned(dataDir, firstClaim.receipt_id).receipt_id,
      firstClaim.receipt_id);
    assert.equal(finishMcpResumeDelivery(dataDir, sessionId, "turn-first").length, 1);

    const secondClaim = claimMcpResumeDelivery(dataDir, sessionId);
    assert.equal(secondClaim.resume_id, newerPacket.resume_id);
    const secondActive = activateTaskScopeForResume(
      dataDir,
      sessionId,
      secondClaim.resume_id,
      secondClaim.preview_version,
      env,
    );
    assert.equal(secondActive.binding_id, secondClaim.resume_id);
    assert.equal(secondActive.task_id, newerPacket.task.task_id);
    assert.equal(resolveTaskScope(dataDir, sessionId, env).binding_id, secondClaim.resume_id);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 0, active: 1, superseded: 1 });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("latest same-Session Task Bootstrap wins once and older pending bindings stay superseded", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-bootstrap-arbitration-"));
  const env = {
    MNEMURON_CONFIG_PATH: path.join(dataDir, "missing-config.json"),
    MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-destination",
  };
  const sessionId = "session-bootstrap-arbitration";
  try {
    const older = bootstrapPacket("bootstrap-older", "task-bootstrap-older");
    stageTaskScopeForSession(dataDir, older, sessionId, env);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = bootstrapPacket("bootstrap-newer", "task-bootstrap-newer");
    stageTaskScopeForSession(dataDir, newer, sessionId, env);

    const active = activateTaskBootstrapScope(dataDir, sessionId, env);
    assert.equal(active.bootstrap_id, newer.bootstrap_id);
    assert.equal(active.task_id, newer.task.task_id);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 0, active: 1, superseded: 1 });
    const olderState = JSON.parse(readFileSync(
      path.join(dataDir, "task-scopes", `${older.bootstrap_id}-v1.json`),
      "utf8",
    ));
    assert.equal(olderState.status, "superseded");
    assert.equal(olderState.superseded_by, newer.bootstrap_id);

    const later = activateTaskBootstrapScope(dataDir, sessionId, env);
    assert.equal(later.bootstrap_id, newer.bootstrap_id);
    assert.equal(later.activated_at, active.activated_at);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 0, active: 1, superseded: 1 });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("exact Resume activation supersedes only same-Session pending Task Bootstrap bindings", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-resume-bootstrap-arbitration-"));
  const env = {
    MNEMURON_CONFIG_PATH: path.join(dataDir, "missing-config.json"),
    MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-destination",
  };
  const sessionId = "session-resume-wins";
  try {
    const sameSessionBootstrap = bootstrapPacket(
      "bootstrap-same-session",
      "task-bootstrap-same-session",
    );
    const otherSessionBootstrap = bootstrapPacket(
      "bootstrap-other-session",
      "task-bootstrap-other-session",
    );
    stageTaskScopeForSession(dataDir, sameSessionBootstrap, sessionId, env);
    stageTaskScopeForSession(dataDir, otherSessionBootstrap, "session-other", env);
    const resume = packet("resume-wins", "task-resume-wins");
    stageTaskScopeForSession(dataDir, resume, sessionId, env);

    const active = activateTaskScopeForResume(
      dataDir,
      sessionId,
      resume.resume_id,
      resume.preview_version,
      env,
    );
    assert.equal(active.resume_id, resume.resume_id);
    assert.equal(active.task_id, resume.task.task_id);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 1, active: 1, superseded: 1 });
    const sameSessionState = JSON.parse(readFileSync(
      path.join(dataDir, "task-scopes", `${sameSessionBootstrap.bootstrap_id}-v1.json`),
      "utf8",
    ));
    const otherSessionState = JSON.parse(readFileSync(
      path.join(dataDir, "task-scopes", `${otherSessionBootstrap.bootstrap_id}-v1.json`),
      "utf8",
    ));
    assert.equal(sameSessionState.status, "superseded");
    assert.equal(sameSessionState.superseded_by, resume.resume_id);
    assert.equal(otherSessionState.status, "pending");

    const later = activateTaskBootstrapScope(dataDir, sessionId, env);
    assert.equal(later.resume_id, resume.resume_id);
    assert.deepEqual(taskScopeCounts(dataDir), { pending: 1, active: 1, superseded: 1 });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

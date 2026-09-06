import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  pendingResumeCounts,
  queueResumeInjection,
  resolveTaskScope,
  stageTaskScope,
  taskScopeCounts,
} from "../scripts/storage.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(TEST_DIR, "..", "scripts", "launch-hook");

function runHook(dataDir, payload, extraEnv = {}) {
  return spawnSync(HOOK, [], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      MNEMURON_MODE: "local",
      MNEMURON_CONFIG_PATH: path.join(dataDir, "missing-config.json"),
      MNEMURON_SPIKE_DATA_DIR: dataDir,
      MNEMURON_DEVICE_ID: "device-test",
      MNEMURON_AGENT_ID: "chatgpt",
      MNEMURON_AGENT_INSTANCE_ID: "chatgpt-test",
      ...extraEnv,
    },
  });
}

test("captures user and assistant messages without parsing transcript files", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-hook-"));
  try {
    const user = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: "/workspace/project",
      transcript_path: "/does/not/exist.jsonl",
      prompt: "继续 Mnemuron plugin 任务",
    });
    assert.equal(user.status, 0, user.stderr);
    assert.deepEqual(JSON.parse(user.stdout), {});

    const assistant = runHook(
      dataDir,
      {
        hook_event_name: "Stop",
        session_id: "session-1",
        turn_id: "turn-1",
        cwd: "/workspace/project",
        transcript_path: "/does/not/exist.jsonl",
        last_assistant_message: "Here is the Resume Preview.",
      },
      { MNEMURON_RAW_RETENTION_DAYS: "permanent" },
    );
    assert.equal(assistant.status, 0, assistant.stderr);

    const events = readFileSync(path.join(dataDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(events.length, 2);
    assert.equal(events[0].event_type, "user_message");
    assert.equal(events[0].content, "继续 Mnemuron plugin 任务");
    assert.equal(events[0].provenance.device_id, "device-test");
    assert.equal(events[0].provenance.identity_status, "configured");
    assert.equal(events[0].capture_capability.transcript_parser_used, false);
    assert.ok(events[0].expires_at);
    assert.equal(events[1].event_type, "assistant_message");
    assert.equal(events[1].content, "Here is the Resume Preview.");
    assert.equal(events[1].expires_at, null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("keeps unbound sessions unscoped and records only explicit event scope", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-hook-unbound-"));
  const defaults = {
    MNEMURON_DEFAULT_PROJECT_ID: "project-default-must-not-bind",
    MNEMURON_DEFAULT_TASK_ID: "task-default-must-not-bind",
    MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-default-must-not-bind",
  };
  try {
    const unbound = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-unbound",
      turn_id: "turn-unbound",
      prompt: "This conversation has not confirmed a Mnemuron Task.",
    }, defaults);
    assert.equal(unbound.status, 0, unbound.stderr);

    const explicit = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-explicit",
      turn_id: "turn-explicit",
      project_id: "project-explicit",
      task_id: "task-explicit",
      workstream_id: "workstream-explicit",
      prompt: "This event carries an explicit Task scope.",
    }, defaults);
    assert.equal(explicit.status, 0, explicit.stderr);

    const events = readFileSync(path.join(dataDir, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(events[0].project_id, null);
    assert.equal(events[0].task_id, null);
    assert.equal(events[0].workstream_id, null);
    assert.deepEqual(events[0].raw_hook_payload.mnemuron_task_scope, { source: "unbound" });
    assert.equal(events[1].project_id, "project-explicit");
    assert.equal(events[1].task_id, "task-explicit");
    assert.equal(events[1].workstream_id, "workstream-explicit");
    assert.deepEqual(events[1].raw_hook_payload.mnemuron_task_scope, {
      source: "event-explicit",
      project_id: "project-explicit",
      task_id: "task-explicit",
      workstream_id: "workstream-explicit",
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("records only exact resume confirmation intents with session provenance", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-confirm-intent-"));
  try {
    const exact = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "chatgpt-session-a",
      turn_id: "turn-confirm",
      prompt: "`确认 11111111-1111-4111-8111-000000000001 v1`\n",
    });
    assert.equal(exact.status, 0, exact.stderr);
    const intentDir = path.join(dataDir, "confirmation-intents");
    const files = readdirSync(intentDir);
    assert.equal(files.length, 1);
    const intent = JSON.parse(readFileSync(path.join(intentDir, files[0]), "utf8"));
    assert.equal(intent.resume_id, "11111111-1111-4111-8111-000000000001");
    assert.equal(intent.preview_version, 1);
    assert.equal(intent.session_id, "chatgpt-session-a");
    assert.equal(intent.turn_id, "turn-confirm");

    const mentionOnly = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "chatgpt-session-b",
      prompt: "是否要确认 11111111-1111-4111-8111-000000000001 v1？",
    });
    assert.equal(mentionOnly.status, 0, mentionOnly.stderr);
    assert.equal(readdirSync(intentDir).length, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("PostToolUse compatibility mode stages, injects, and acknowledges a Resume once", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-post-tool-compat-"));
  const resumeId = "11111111-1111-4111-8111-000000000002";
  const sessionId = "chatgpt-session-post-tool-compat";
  const packet = {
    resume_id: resumeId,
    preview_version: 1,
    project: { project_id: "project-mnemuron", name: "Mnemuron" },
    task: { task_id: "task-resume-compat-v013", title: "Resume compatibility v0.1.3" },
    selected_workstreams: [{ workstream_id: "workstream-chatgpt" }],
    context: {
      goal: "Inject through a reliable PostToolUse hook.",
      progress: ["The user explicitly confirmed the Preview."],
      blockers: [],
      next_steps: ["Continue on the restored task."],
    },
    provenance: {},
    injection_authorized_at: new Date().toISOString(),
  };
  const common = {
    MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-clientb",
    CODEX_THREAD_ID: "",
    CODEX_SESSION_ID: "",
  };
  try {
    const started = runHook(dataDir, {
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
    }, common);
    assert.equal(started.status, 0, started.stderr);
    const startedOutput = JSON.parse(started.stdout);
    assert.equal(startedOutput.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(startedOutput.hookSpecificOutput.additionalContext, /mnemuron_take_pending_resume/);

    const confirmed = runHook(dataDir, {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      turn_id: "turn-confirm",
      tool_name: "mcp__mnemuron__mnemuron_confirm_resume",
      tool_input: { confirmed: true, resume_id: resumeId, preview_version: 1 },
      tool_response: {
        content: [{ type: "text", text: "confirmed" }],
        structuredContent: { status: "confirmed", resume_packet: packet },
      },
    }, common);
    assert.equal(confirmed.status, 0, confirmed.stderr);
    assert.match(
      JSON.parse(confirmed.stdout).hookSpecificOutput.additionalContext,
      /next ordinary user turn/i,
    );
    assert.deepEqual(taskScopeCounts(dataDir), {
      pending: 1,
      active: 0,
      superseded: 0,
    });
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 1,
      in_flight: 0,
      delivered: 0,
    });

    const sameTurn = runHook(dataDir, {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      turn_id: "turn-confirm",
      tool_name: "mcp__mnemuron__mnemuron_take_pending_resume",
      tool_input: {},
      tool_response: { structuredContent: { status: "probe_accepted" } },
    }, common);
    assert.equal(sameTurn.status, 0, sameTurn.stderr);
    assert.deepEqual(JSON.parse(sameTurn.stdout), {});

    const nextTurn = runHook(dataDir, {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      turn_id: "turn-resume",
      tool_name: "mcp__mnemuron__mnemuron_take_pending_resume",
      tool_input: {},
      tool_response: { structuredContent: { status: "probe_accepted" } },
    }, common);
    assert.equal(nextTurn.status, 0, nextTurn.stderr);
    const nextTurnOutput = JSON.parse(nextTurn.stdout);
    assert.equal(nextTurnOutput.hookSpecificOutput.hookEventName, "PostToolUse");
    assert.match(nextTurnOutput.hookSpecificOutput.additionalContext, new RegExp(resumeId));
    assert.equal(resolveTaskScope(dataDir, sessionId, common).task_id, "task-resume-compat-v013");
    const injection = JSON.parse(
      readFileSync(path.join(dataDir, "pending-resumes", `${resumeId}-v1.json`), "utf8"),
    );
    assert.equal(injection.status, "in_flight");
    assert.equal(injection.injection_method, "codex-post-tool-additional-context");
    assert.equal(injection.claimed_turn_id, "turn-resume");

    const stopped = runHook(dataDir, {
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: "turn-resume",
      last_assistant_message: "Restored task continued.",
    }, common);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 0,
      in_flight: 0,
      delivered: 1,
    });

    const later = runHook(dataDir, {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      turn_id: "turn-later",
      tool_name: "mnemuron_take_pending_resume",
      tool_input: {},
      tool_response: { structuredContent: { status: "probe_accepted" } },
    }, common);
    assert.equal(later.status, 0, later.stderr);
    assert.deepEqual(JSON.parse(later.stdout), {});
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("refuses to bind a confirmed resume when confirmation sessions conflict", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-confirm-conflict-"));
  const resumeId = "11111111-1111-4111-8111-000000000001";
  try {
    for (const sessionId of ["chatgpt-session-a", "chatgpt-session-b"]) {
      const result = runHook(dataDir, {
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        prompt: `确认 ${resumeId} v1`,
      });
      assert.equal(result.status, 0, result.stderr);
    }
    const taskScope = stageTaskScope(dataDir, {
      resume_id: resumeId,
      preview_version: 1,
      project: { project_id: "project-mnemuron" },
      task: { task_id: "task-mnemuron-dynamic-task-scope-v01" },
      selected_workstreams: [{ workstream_id: "workstream-chatgpt" }],
    }, {
      MNEMURON_CONFIG_PATH: path.join(dataDir, "missing-config.json"),
      MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-clientb",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
    });
    assert.equal(taskScope, null);
    assert.equal(readdirSync(path.join(dataDir, "task-scopes")).length, 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("injects a confirmed Resume Packet once and acknowledges it on Stop", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-resume-injection-"));
  const resumeId = "11111111-1111-4111-8111-000000000003";
  const sessionId = "chatgpt-session-resume";
  try {
    const intent = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-confirm",
      prompt: `确认 ${resumeId} v1`,
    });
    assert.equal(intent.status, 0, intent.stderr);
    const packet = {
      resume_id: resumeId,
      preview_version: 1,
      project: { project_id: "project-mnemuron", name: "Mnemuron" },
      task: { task_id: "task-resume-ack-v01", title: "Resume Injection ACK v0.1" },
      selected_workstreams: [{ workstream_id: "workstream-chatgpt" }],
      context: {
        goal: "Prove one-time model-visible Resume injection with a durable ACK.",
        progress: ["Preview and confirmation are complete."],
        blockers: [],
        next_steps: ["Continue on the restored task."],
      },
      provenance: {},
      injection_authorized_at: new Date().toISOString(),
    };
    const env = {
      MNEMURON_CONFIG_PATH: path.join(dataDir, "missing-config.json"),
      MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-clienta",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
    };
    const scope = stageTaskScope(dataDir, packet, env);
    assert.equal(scope.status, "pending");
    const queued = queueResumeInjection(
      dataDir,
      packet,
      scope.target_session_id,
      scope.workstream_id,
    );
    assert.equal(queued.status, "pending");

    const first = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-resume",
      prompt: "继续恢复后的任务。",
    });
    assert.equal(first.status, 0, first.stderr);
    const output = JSON.parse(first.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(output.hookSpecificOutput.additionalContext, new RegExp(resumeId));
    assert.match(output.hookSpecificOutput.additionalContext, /one-time model-visible Resume injection/);
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 0,
      in_flight: 1,
      delivered: 0,
    });
    assert.equal(resolveTaskScope(dataDir, sessionId, env).task_id, "task-resume-ack-v01");

    const stop = runHook(dataDir, {
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: "turn-resume",
      last_assistant_message: "Restored task continued.",
    });
    assert.equal(stop.status, 0, stop.stderr);
    assert.deepEqual(JSON.parse(stop.stdout), {});
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 0,
      in_flight: 0,
      delivered: 1,
    });

    const later = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-later",
      prompt: "继续持久绑定。",
    });
    assert.equal(later.status, 0, later.stderr);
    assert.deepEqual(JSON.parse(later.stdout), {});
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 0,
      in_flight: 0,
      delivered: 1,
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("does not inject or activate a pending Resume when central attestation is unavailable", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-resume-offline-"));
  const resumeId = "11111111-1111-4111-8111-000000000004";
  const sessionId = "chatgpt-session-offline-resume";
  try {
    const intent = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-confirm",
      prompt: `确认 ${resumeId} v1`,
    });
    assert.equal(intent.status, 0, intent.stderr);
    const packet = {
      resume_id: resumeId,
      preview_version: 1,
      project: { project_id: "project-mnemuron" },
      task: { task_id: "task-resume-offline" },
      selected_workstreams: [{ workstream_id: "workstream-chatgpt" }],
      context: { goal: "Wait for central injection attestation." },
    };
    const env = {
      MNEMURON_CONFIG_PATH: path.join(dataDir, "missing-config.json"),
      MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-clienta",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
    };
    const scope = stageTaskScope(dataDir, packet, env);
    queueResumeInjection(dataDir, packet, scope.target_session_id, scope.workstream_id);

    const result = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-resume",
      prompt: "继续。",
    }, {
      MNEMURON_MODE: "remote",
      MNEMURON_SERVER_URL: "http://127.0.0.1:1",
      MNEMURON_ALLOW_INSECURE_HTTP: "true",
      MNEMURON_API_KEY: "mnm_test-only-unreachable-key",
      MNEMURON_REQUEST_TIMEOUT_MS: "500",
      MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-clienta",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.match(result.stderr, /Resume injection deferred/i);
    assert.deepEqual(pendingResumeCounts(dataDir), {
      pending: 1,
      in_flight: 0,
      delivered: 0,
    });
    assert.deepEqual(taskScopeCounts(dataDir), {
      pending: 1,
      active: 0,
      superseded: 0,
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("recovers an unacknowledged attempt after restart with a fresh attempt id", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-resume-recovery-"));
  const resumeId = "11111111-1111-4111-8111-000000000005";
  const sessionId = "chatgpt-session-recovery";
  try {
    runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-confirm",
      prompt: `确认 ${resumeId} v1`,
    });
    const packet = {
      resume_id: resumeId,
      preview_version: 1,
      project: { project_id: "project-mnemuron" },
      task: { task_id: "task-resume-recovery" },
      selected_workstreams: [{ workstream_id: "workstream-chatgpt" }],
      context: { goal: "Recover safely after a restart." },
    };
    const env = {
      MNEMURON_CONFIG_PATH: path.join(dataDir, "missing-config.json"),
      MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-clienta",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
    };
    const scope = stageTaskScope(dataDir, packet, env);
    queueResumeInjection(dataDir, packet, scope.target_session_id, scope.workstream_id);
    const first = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-before-restart",
      prompt: "继续。",
    });
    assert.equal(first.status, 0, first.stderr);
    const pendingFile = path.join(dataDir, "pending-resumes", `${resumeId}-v1.json`);
    const firstAttempt = JSON.parse(readFileSync(pendingFile, "utf8")).attempt_id;

    const restarted = runHook(dataDir, {
      hook_event_name: "SessionStart",
      session_id: sessionId,
      source: "startup",
    });
    assert.equal(restarted.status, 0, restarted.stderr);
    const recovered = JSON.parse(readFileSync(pendingFile, "utf8"));
    assert.equal(recovered.status, "pending");
    assert.notEqual(recovered.attempt_id, firstAttempt);

    const retried = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: "turn-after-restart",
      prompt: "继续恢复。",
    });
    assert.equal(retried.status, 0, retried.stderr);
    assert.match(JSON.parse(retried.stdout).hookSpecificOutput.additionalContext, /Recover safely/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("does not recover another session's in-flight attempt on SessionStart", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-resume-session-isolation-"));
  const resumeId = "11111111-1111-4111-8111-000000000006";
  const deliverySessionId = "chatgpt-session-delivery";
  try {
    runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: deliverySessionId,
      turn_id: "turn-confirm",
      prompt: `确认 ${resumeId} v1`,
    });
    const packet = {
      resume_id: resumeId,
      preview_version: 1,
      project: { project_id: "project-mnemuron" },
      task: { task_id: "task-resume-session-isolation" },
      selected_workstreams: [{ workstream_id: "workstream-chatgpt" }],
      context: { goal: "Preserve an in-flight delivery across unrelated session starts." },
    };
    const env = {
      MNEMURON_CONFIG_PATH: path.join(dataDir, "missing-config.json"),
      MNEMURON_DEFAULT_WORKSTREAM_ID: "workstream-clientb",
      CODEX_THREAD_ID: "",
      CODEX_SESSION_ID: "",
    };
    const scope = stageTaskScope(dataDir, packet, env);
    queueResumeInjection(dataDir, packet, scope.target_session_id, scope.workstream_id);
    const first = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: deliverySessionId,
      turn_id: "turn-delivery",
      prompt: "继续。",
    });
    assert.equal(first.status, 0, first.stderr);
    const pendingFile = path.join(dataDir, "pending-resumes", `${resumeId}-v1.json`);
    const inFlight = JSON.parse(readFileSync(pendingFile, "utf8"));
    assert.equal(inFlight.status, "in_flight");

    const unrelatedStart = runHook(dataDir, {
      hook_event_name: "SessionStart",
      session_id: "chatgpt-session-unrelated",
      source: "compact",
    });
    assert.equal(unrelatedStart.status, 0, unrelatedStart.stderr);
    const preserved = JSON.parse(readFileSync(pendingFile, "utf8"));
    assert.equal(preserved.status, "in_flight");
    assert.equal(preserved.attempt_id, inFlight.attempt_id);
    assert.equal(preserved.claimed_session_id, deliverySessionId);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("loads device identity and retention from a local config file", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-hook-config-"));
  const configPath = path.join(dataDir, "config.json");
  const captureDir = path.join(dataDir, "capture");
  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        data_dir: captureDir,
        device_id: "clientb-test",
        agent_id: "chatgpt",
        agent_instance_id: "chatgpt-clientb-test",
        raw_retention_days: 7,
      }),
    );
    const result = spawnSync(HOOK, [], {
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "session-config",
        prompt: "config capture",
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        MNEMURON_CONFIG_PATH: configPath,
        MNEMURON_SPIKE_DATA_DIR: "",
        MNEMURON_DEVICE_ID: "",
        MNEMURON_AGENT_ID: "",
        MNEMURON_AGENT_INSTANCE_ID: "",
        MNEMURON_RAW_RETENTION_DAYS: "",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const event = JSON.parse(
      readFileSync(path.join(captureDir, "events.jsonl"), "utf8").trim(),
    );
    assert.equal(event.provenance.device_id, "clientb-test");
    assert.equal(event.provenance.identity_status, "configured");
    assert.equal(
      Date.parse(event.expires_at) - Date.parse(event.captured_at),
      7 * 86_400_000,
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("queues a remote event locally when the server is unavailable", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "mnemuron-hook-outbox-"));
  try {
    const result = runHook(dataDir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-offline",
      prompt: "preserve this while offline",
    }, {
      MNEMURON_MODE: "remote",
      MNEMURON_SERVER_URL: "http://127.0.0.1:1",
      MNEMURON_ALLOW_INSECURE_HTTP: "true",
      MNEMURON_API_KEY: "mnm_test-only-unreachable-key",
      MNEMURON_REQUEST_TIMEOUT_MS: "500",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /queued for retry/i);
    const queued = readdirSync(path.join(dataDir, "outbox")).filter(name => name.endsWith('.json'));
    assert.equal(queued.length, 1);
    const envelope = JSON.parse(
      readFileSync(path.join(dataDir, "outbox", queued[0]), "utf8"),
    );
    assert.equal(envelope.event.content, "preserve this while offline");
    const retry = JSON.parse(readFileSync(path.join(dataDir, 'outbox', queued[0] + '.state'), 'utf8'));
    assert.equal(retry.state, 'retry_wait');
    assert.equal(retry.attempt_count, 1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

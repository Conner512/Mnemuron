import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMnemuronApp } from "../../../server/lib/app.mjs";
import {
  buildHookEvent,
  buildResumeInjectionText,
  formatRawAvailabilityLine,
  MnemuronClient,
  PendingResumeStore,
  resolveAdapterConfig,
  TaskScopeStore,
} from "../dist/client.js";

test("OpenClaw manifest declares every registered Mnemuron tool", () => {
  const manifest = JSON.parse(readFileSync(
    new URL("../openclaw.plugin.json", import.meta.url),
    "utf8",
  ));
  assert.deepEqual([...manifest.contracts.tools].sort(), [
    "mnemuron_confirm_reconciliation",
    "mnemuron_confirm_resume",
    "mnemuron_preview_project_context",
    "mnemuron_preview_task_branches",
    "mnemuron_preview_reconciliation",
    "mnemuron_preview_resume",
    "mnemuron_reconciliation_status",
    "mnemuron_remember",
    "mnemuron_retract_memory",
    "mnemuron_search_memories",
    "mnemuron_status",
    "mnemuron_supersede_memory",
  ].sort());
});

test("OpenClaw status explains raw availability categories", () => {
  assert.equal(formatRawAvailabilityLine({
    raw_availability: {
      raw_events_available: 3079,
      expired_events: 1,
      unexplained_raw_unavailable: 0,
      status: "accounted",
    },
  }), "Raw：3079 可用 / 1 已过期 / 0 无法解释 / 状态 accounted");
  assert.equal(
    formatRawAvailabilityLine({}),
    "Raw：中心暂未提供可用性分类",
  );
});

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

const task = {
  task_id: "task-openclaw-adapter",
  project_id: "project-mnemuron",
  project_name: "Mnemuron",
  title: "Mnemuron OpenClaw Adapter",
  aliases: ["OpenClaw", "OpenClaw adapter"],
  goal: "Capture OpenClaw sessions and resume them on another agent.",
  status: "active",
  progress: ["Native OpenClaw hooks are available."],
  decisions: ["Resume remains preview-first."],
  blockers: [],
  next_steps: ["Validate a cross-agent preview."],
  resources: ["adapters/openclaw/README.md"],
  workstreams: [
    { workstream_id: "workstream-openclaw", name: "OpenClaw example client", status: "active" },
    { workstream_id: "workstream-macbook", name: "MacBook ChatGPT", status: "active" },
  ],
  conflicts: [],
};

function adapterConfig(root, baseUrl, apiKey) {
  const apiKeyFile = path.join(root, "mnemuron.key");
  writeFileSync(apiKeyFile, `${apiKey}\n`, { mode: 0o600 });
  chmodSync(apiKeyFile, 0o600);
  return resolveAdapterConfig({
    serverUrl: baseUrl,
    allowInsecureHttp: true,
    apiKeyFile,
    outboxDir: path.join(root, "outbox"),
    deviceId: "openclaw-host",
    agentId: "openclaw",
    agentInstanceId: "openclaw-local",
    projectId: task.project_id,
    taskId: task.task_id,
    workstreamId: "workstream-openclaw",
    rawRetentionDays: "permanent",
    requestTimeoutMs: 500,
  });
}

test("OpenClaw hooks preserve full source context, verify identity, and create a resumable checkpoint", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-openclaw-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const openclaw = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "OpenClaw example client",
      device_id: "openclaw-host",
      agent_id: "openclaw",
      agent_instance_id: "openclaw-local",
    }, 201);
    const macbook = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "MacBook ChatGPT",
      device_id: "macbook-openclaw-test",
      agent_id: "chatgpt",
      agent_instance_id: "chatgpt-macbook-openclaw-test",
    }, 201);
    await api(baseUrl, admin.api_key, "POST", "/v1/tasks", task);

    const config = adapterConfig(root, baseUrl, openclaw.api_key);
    const client = new MnemuronClient(config);
    const context = {
      runId: "run-openclaw-1",
      sessionKey: "agent:main:telegram:dm:10001",
      sessionId: "source-session-id",
      agentId: "main",
      workspaceDir: "/home/openclaw/.openclaw/workspace",
      modelProviderId: "openai",
      modelId: "gpt-test",
      messageProvider: "telegram",
      channelId: "telegram",
      chatId: "10001",
      senderId: "10001",
    };
    const incoming = buildHookEvent("message_received", {
      timestamp: Date.parse("2026-08-24T05:00:00.000Z"),
      content: "继续 Mnemuron OpenClaw 适配任务。",
      sessionKey: context.sessionKey,
    }, context, config);
    const completed = buildHookEvent("agent_end", {
      timestamp: Date.parse("2026-08-24T05:01:00.000Z"),
      runId: context.runId,
      sessionKey: context.sessionKey,
      messages: [
        { role: "user", content: "继续 Mnemuron OpenClaw 适配任务。" },
        {
          role: "assistant",
          content: "已完成 OpenClaw 原生 Hook 适配。确认采用独立设备与 Agent 身份。无阻塞。下一步从 MacBook 预览恢复。",
        },
      ],
    }, context, config);

    assert.equal(incoming.session_id, completed.session_id);
    assert.equal((await client.submitEvent(incoming)).delivery, "synchronized");
    const outcome = await client.submitEvent(completed);
    assert.equal(outcome.delivery, "synchronized");
    assert.equal(outcome.result.checkpoints[0].status, "created");
    assert.equal(outcome.result.checkpoints[0].checkpoint.provenance.device_id, "openclaw-host");
    assert.equal(outcome.result.checkpoints[0].checkpoint.provenance.agent_id, "openclaw");

    const stored = app.store.db.prepare("SELECT * FROM events WHERE event_id = ?")
      .get(completed.event_id);
    assert.equal(stored.device_id, "openclaw-host");
    assert.equal(stored.agent_instance_id, "openclaw-local");
    assert.equal(stored.expires_at, null);
    const raw = JSON.parse(stored.raw_payload_json);
    assert.equal(raw.context.messageProvider, "telegram");
    assert.equal(raw.event.messages[1].role, "assistant");
    assert.match(raw.event.messages[1].content, /下一步从 MacBook/);

    const preview = await api(baseUrl, macbook.api_key, "POST", "/v1/resume/preview", {
      query: "OpenClaw",
    }, 201);
    assert.equal(preview.status, "pending_confirmation");
    assert.equal(preview.latest_checkpoints[0].provenance.agent_instance_id, "openclaw-local");
    assert.match(preview.latest_checkpoints[0].latest_outcome.text, /原生 Hook 适配/);
    const confirmed = await api(
      baseUrl,
      macbook.api_key,
      "POST",
      `/v1/resume/${preview.resume_id}/confirm`,
      { preview_version: preview.preview_version, confirmed: true },
    );
    assert.equal(confirmed.status, "confirmed");
    assert.equal(
      confirmed.resume_packet.context.latest_checkpoints[0].provenance.device_id,
      "openclaw-host",
    );
    const repeatedConfirmation = await api(
      baseUrl,
      macbook.api_key,
      "POST",
      `/v1/resume/${preview.resume_id}/confirm`,
      { preview_version: preview.preview_version, confirmed: true },
    );
    assert.equal(repeatedConfirmation.status, "confirmed");
    assert.deepEqual(repeatedConfirmation.resume_packet, confirmed.resume_packet);

    const status = await client.status();
    assert.equal(status.identity.identity_status, "server_verified");
    assert.equal(status.adapter.queued_events, 0);
    assert.equal(status.adapter.sync_status, "synchronized");
  } finally {
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Resume Packet injection stays below the OpenClaw limit while preserving recovery context", () => {
  const repeated = "完整记录仍在 Mnemuron；注入只携带恢复所需上下文。".repeat(300);
  const packet = {
    resume_id: "resume-large-packet",
    preview_version: 1,
    project: { project_id: "project-mnemuron", name: "Mnemuron" },
    task: {
      task_id: task.task_id,
      title: task.title,
      goal: task.goal,
      status: "active",
    },
    selected_workstreams: task.workstreams,
    branch_selection: {
      schema_version: "resume-branch-selection-v0.1",
      explicit: true,
      mode: "single",
      selected_workstream_ids: ["workstream-openclaw"],
      available_workstream_ids: ["workstream-openclaw", "workstream-macbook"],
      source_preserved: true,
      automatic_merge_performed: false,
    },
    context: {
      goal: task.goal,
      progress: Array.from({ length: 30 }, (_, index) => `进度 ${index}: ${repeated}`),
      decisions: Array.from({ length: 30 }, (_, index) => `决策 ${index}: ${repeated}`),
      blockers: [],
      next_steps: ["在下一台设备继续验收。"],
      resources: ["adapters/openclaw/README.md"],
      conflicts: [],
      latest_checkpoints: [{
        checkpoint_id: "checkpoint-large",
        version: 3,
        workstream_id: "workstream-openclaw",
        session_id: "oc:agent:main:telegram:test",
        created_at: "2026-08-24T09:15:00.000Z",
        goal: repeated,
        active_request: { text: repeated, source_event_id: "event-user" },
        latest_outcome: { text: "确认后应在下一轮恢复。", source_event_id: "event-agent" },
        completed_items: Array.from({ length: 20 }, () => ({ text: repeated })),
        decisions: Array.from({ length: 20 }, () => ({ text: repeated })),
        blockers: [],
        unfinished_items: [{ text: "验证 TG 注入" }],
        recommended_next_steps: [{ text: "发送继续" }],
        source_event_ids: Array.from({ length: 80 }, (_, index) => `event-${index}`),
        provenance: {
          device_id: "openclaw-host",
          agent_id: "openclaw",
          agent_instance_id: "openclaw-local",
        },
        generation: { method: "deterministic-rules-v0.1", confidence_label: "low" },
      }],
      structured_memories: [],
      recent_activity: Array.from({ length: 20 }, (_, index) => ({
        event_id: `activity-${index}`,
        event_type: "assistant_message",
        captured_at: "2026-08-24T09:15:00.000Z",
        workstream_id: "workstream-openclaw",
        content: repeated,
      })),
    },
    provenance: {
      captured_event_count: 100,
      checkpoint_count: 1,
      identities: ["openclaw-local@openclaw-host"],
    },
    injection_authorized_at: "2026-08-24T09:15:24.479Z",
  };
  assert.ok(JSON.stringify(packet).length > 32 * 1024);
  const injection = buildResumeInjectionText(packet);
  assert.ok(injection.length <= 30 * 1024);
  assert.match(injection, /resume-large-packet/);
  assert.match(injection, /resume-branch-selection-v0\.1/);
  assert.match(injection, /在下一台设备继续验收/);
  assert.match(injection, /raw_records_remain_in_mnemuron/);
  assert.match(injection, /本轮恢复的权威上下文/);
  assert.match(injection, /不要为同一任务再次调用 mnemuron_preview_resume/);
});

test("confirmed Resume Packet waits for a real channel session and is acknowledged once", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-pending-resume-"));
  try {
    const store = new PendingResumeStore(path.join(root, "pending"));
    const packet = {
      resume_id: "resume-pending-session",
      preview_version: 1,
      project: { project_id: "project-mnemuron", name: "Mnemuron" },
      task: { task_id: task.task_id, title: task.title, goal: task.goal, status: "active" },
      selected_workstreams: task.workstreams,
      context: { goal: task.goal, next_steps: ["继续验收"] },
    };
    const queued = store.queue({
      packet,
      text: buildResumeInjectionText(packet),
      context: {
        sessionKey: "agent:main:telegram:command-only",
        channel: "telegram",
        senderId: "10001",
      },
    });
    assert.equal(queued.status, "pending");
    assert.deepEqual(store.counts(), { pending: 1, in_flight: 0, delivered: 0 });
    const [file] = readdirSync(path.join(root, "pending"));
    assert.equal(statSync(path.join(root, "pending")).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(root, "pending", file)).mode & 0o777, 0o600);

    assert.equal(store.claim({
      runId: "run-other-telegram-chat",
      sessionId: "session-other-telegram-chat",
      trigger: "user",
      sessionKey: "agent:main:telegram:default:direct:10002",
      messageProvider: "telegram",
      channelId: "10002",
    }), null);

    const claimed = store.claim({
      runId: "run-telegram-continue",
      sessionId: "session-telegram-continue",
      trigger: "user",
      sessionKey: "agent:main:telegram:default:direct:10001",
      messageProvider: "telegram",
      channelId: "10001",
    });
    assert.equal(claimed.resume_id, packet.resume_id);
    assert.equal(claimed.status, "in_flight");
    assert.match(claimed.text, /继续验收/);
    assert.deepEqual(store.counts(), { pending: 0, in_flight: 1, delivered: 0 });

    const finished = store.finish({ runId: "run-telegram-continue" }, true);
    assert.equal(finished.length, 1);
    assert.equal(finished[0].phase, "acknowledged");
    assert.deepEqual(store.counts(), { pending: 0, in_flight: 0, delivered: 1 });
    assert.equal(store.claim({
      runId: "run-telegram-second",
      channelId: "telegram",
      senderId: "10001",
    }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart retry cannot be claimed by an internal session that inherits channel identity", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-openclaw-restart-scope-"));
  try {
    const store = new PendingResumeStore(path.join(root, "pending"));
    const packet = {
      resume_id: "resume-restart-session-scope",
      preview_version: 1,
      project: { project_id: "project-mnemuron", name: "Mnemuron" },
      task: { task_id: task.task_id, title: task.title, goal: task.goal, status: "active" },
      selected_workstreams: task.workstreams,
      context: { goal: task.goal, next_steps: ["继续验收"] },
    };
    const queued = store.queue({
      packet,
      text: buildResumeInjectionText(packet),
      context: {
        sessionKey: "agent:main:main",
        channel: "telegram",
        senderId: "10001",
      },
    });
    const first = store.claim({
      runId: "run-first-telegram-attempt",
      sessionId: "session-first-telegram-attempt",
      trigger: "user",
      sessionKey: "agent:main:telegram:default:direct:10001",
      messageProvider: "telegram",
      channelId: "10001",
      senderId: "10001",
    });
    assert.equal(first.attempt_id, queued.attempt_id);

    const [failed] = store.recoverInFlight();
    assert.equal(failed.phase, "failed");
    assert.equal(failed.record.attempt_id, first.attempt_id);
    assert.equal(failed.record.error_code, "adapter_restarted");

    assert.equal(store.claim({
      runId: "run-internal-restart-recovery",
      sessionId: "session-internal-restart-recovery",
      trigger: "heartbeat",
      sessionKey: "agent:main:main",
      messageProvider: "telegram",
      channelId: "10001",
      senderId: "10001",
    }), null);

    const retry = store.claim({
      runId: "run-second-telegram-attempt",
      sessionId: "session-second-telegram-attempt",
      trigger: "user",
      sessionKey: "agent:main:telegram:default:direct:10001",
      messageProvider: "telegram",
      channelId: "10001",
      senderId: "10001",
    });
    assert.notEqual(retry.attempt_id, first.attempt_id);
    assert.equal(retry.claimed_session_id, "oc:agent:main:telegram:default:direct:10001");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic OpenClaw user session claims only the exact Telegram route", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-openclaw-generic-route-"));
  try {
    const pendingStore = new PendingResumeStore(path.join(root, "pending"));
    const scopeStore = new TaskScopeStore(path.join(root, "task-scopes"));
    const packet = {
      resume_id: "resume-generic-telegram-route",
      preview_version: 1,
      project: { project_id: "project-mnemuron", name: "Mnemuron" },
      task: { task_id: task.task_id, title: task.title, goal: task.goal, status: "active" },
      selected_workstreams: task.workstreams,
      context: { goal: task.goal, next_steps: ["继续验收"] },
    };
    const commandContext = {
      sessionKey: "agent:main:main",
      channel: "telegram",
      accountId: "default",
      senderId: "10001",
      from: "telegram:10001",
      to: "telegram:10001",
    };
    const queued = pendingStore.queue({
      packet,
      text: buildResumeInjectionText(packet),
      context: commandContext,
    });
    scopeStore.stage({ packet, context: commandContext, workstreamId: "workstream-openclaw" });

    const userTurn = {
      runId: "run-generic-telegram-route",
      sessionId: "session-generic-telegram-route",
      trigger: "user",
      agentId: "main",
      sessionKey: "agent:main:main",
      messageProvider: "telegram",
      channel: "telegram",
      accountId: "default",
      channelId: "10001",
      chatId: "10001",
      senderId: "10001",
    };
    assert.equal(pendingStore.claim({ ...userTurn, accountId: "other" }), null);
    assert.equal(scopeStore.activate({ ...userTurn, accountId: "other" }), null);
    assert.equal(pendingStore.claim({
      ...userTurn,
      channelId: "10002",
      chatId: "10002",
    }), null);
    assert.equal(scopeStore.activate({
      ...userTurn,
      channelId: "10002",
      chatId: "10002",
    }), null);
    assert.equal(pendingStore.claim({ ...userTurn, trigger: "cron" }), null);
    const { senderId: _senderId, ...withoutSender } = userTurn;
    assert.equal(pendingStore.claim(withoutSender), null);
    const { sessionId: _sessionId, ...withoutHostSession } = userTurn;
    assert.equal(pendingStore.claim(withoutHostSession), null);

    const claimed = pendingStore.claim(userTurn);
    assert.equal(claimed.attempt_id, queued.attempt_id);
    assert.equal(claimed.status, "in_flight");
    assert.equal(claimed.claimed_session_key, "agent:main:telegram:default:direct:10001");
    assert.equal(claimed.claimed_session_id, "oc:agent:main:telegram:default:direct:10001");
    assert.equal(claimed.claimed_host_session_id, "session-generic-telegram-route");
    assert.equal(claimed.claimed_turn_id, "run-generic-telegram-route");

    const active = scopeStore.activate(userTurn);
    assert.equal(active.status, "active");
    assert.equal(active.session_key, "agent:main:main");
    assert.equal(active.host_session_id, "session-generic-telegram-route");
    assert.equal(active.canonical_session_id, "oc:agent:main:telegram:default:direct:10001");
    assert.equal(scopeStore.resolve(userTurn).resume_id, packet.resume_id);
    assert.equal(scopeStore.resolve({ ...userTurn, accountId: "other" }), null);
    assert.equal(scopeStore.resolve({
      ...userTurn,
      channelId: "10002",
      chatId: "10002",
    }), null);
    assert.equal(scopeStore.resolve({
      runId: "run-other-chat",
      sessionId: userTurn.sessionId,
      sessionKey: "agent:main:main",
      channelId: "10002",
    }), null);
    assert.equal(scopeStore.resolve({
      runId: userTurn.runId,
      sessionId: userTurn.sessionId,
      sessionKey: "agent:main:main",
    }).resume_id, packet.resume_id);

    const nextUserTurn = {
      ...userTurn,
      runId: "run-generic-telegram-route-next",
    };
    const rebound = scopeStore.activate(nextUserTurn);
    assert.equal(rebound.resume_id, packet.resume_id);
    assert.equal(rebound.run_id, nextUserTurn.runId);
    assert.equal(scopeStore.resolve({
      runId: nextUserTurn.runId,
      sessionId: nextUserTurn.sessionId,
      sessionKey: "agent:main:main",
    }).resume_id, packet.resume_id);

    const config = resolveAdapterConfig({
      serverUrl: "http://127.0.0.1:47831",
      allowInsecureHttp: true,
      apiKeyFile: path.join(root, "key"),
      outboxDir: path.join(root, "outbox"),
      deviceId: "openclaw-host",
      agentId: "openclaw",
      agentInstanceId: "openclaw-local",
      projectId: "project-adapter",
      taskId: "task-adapter",
      workstreamId: "workstream-openclaw",
    });
    const captured = buildHookEvent(
      "message_received",
      { content: "继续" },
      userTurn,
      config,
      active,
    );
    assert.equal(captured.session_id, "oc:agent:main:telegram:default:direct:10001");
    assert.equal(captured.task_id, task.task_id);
    assert.equal(captured.workstream_id, "workstream-openclaw");

    const [finished] = pendingStore.finish({
      runId: userTurn.runId,
      sessionId: userTurn.sessionId,
      messageProvider: "telegram",
      channelId: "10001",
      senderId: "10001",
    }, true);
    assert.equal(finished.phase, "acknowledged");
    assert.equal(finished.record.status, "delivered");
    assert.deepEqual(pendingStore.counts(), { pending: 0, in_flight: 0, delivered: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routed Telegram group claims require the exact sender, thread, and user trigger", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-openclaw-group-route-"));
  try {
    const store = new PendingResumeStore(path.join(root, "pending"));
    const packet = {
      resume_id: "resume-telegram-group-route",
      preview_version: 1,
      project: { project_id: "project-mnemuron", name: "Mnemuron" },
      task: { task_id: task.task_id, title: task.title, goal: task.goal, status: "active" },
      selected_workstreams: task.workstreams,
      context: { goal: task.goal },
    };
    store.queue({
      packet,
      text: buildResumeInjectionText(packet),
      context: {
        sessionKey: "agent:main:main",
        channel: "telegram",
        accountId: "default",
        senderId: "10001",
        from: "telegram:10001",
        to: "telegram:20001",
        peerType: "group",
        messageThreadId: "30001",
      },
    });
    const base = {
      runId: "run-telegram-group-route",
      sessionId: "session-telegram-group-route",
      trigger: "user",
      sessionKey: "agent:main:telegram:default:group:20001",
      messageProvider: "telegram",
      accountId: "default",
      channelId: "20001",
      chatId: "20001",
      peerType: "group",
      messageThreadId: "30001",
    };
    assert.equal(store.claim(base), null);
    assert.equal(store.claim({ ...base, senderId: "10002" }), null);
    assert.equal(store.claim({
      ...base,
      senderId: "10001",
      messageThreadId: "30002",
    }), null);
    assert.equal(store.claim({
      ...base,
      senderId: "10001",
      trigger: "heartbeat",
    }), null);

    const claimed = store.claim({ ...base, senderId: "10001" });
    assert.equal(claimed.status, "in_flight");
    assert.equal(
      claimed.claimed_session_key,
      "agent:main:telegram:default:group:20001:sender:10001:thread:30001",
    );
    assert.equal(
      claimed.claimed_session_id,
      "oc:agent:main:telegram:default:group:20001:sender:10001:thread:30001",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw reports an independently verifiable Resume injection ACK", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-openclaw-ack-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const openclaw = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "OpenClaw example client",
      device_id: "openclaw-host",
      agent_id: "openclaw",
      agent_instance_id: "openclaw-local",
    }, 201);
    await api(baseUrl, admin.api_key, "POST", "/v1/tasks", task);
    const config = adapterConfig(root, baseUrl, openclaw.api_key);
    const client = new MnemuronClient(config);
    const preview = await client.request("POST", "/v1/resume/preview", { query: task.task_id });
    const confirmed = await client.request(
      "POST",
      `/v1/resume/${encodeURIComponent(preview.resume_id)}/confirm`,
      { preview_version: preview.preview_version, confirmed: true },
    );
    const store = new PendingResumeStore(config.pendingResumeDir, {
      workstreamId: config.workstreamId,
    });
    store.queue({
      packet: confirmed.resume_packet,
      text: buildResumeInjectionText(confirmed.resume_packet),
      context: {
        sessionKey: "agent:main:telegram:default:direct:10001",
        channel: "telegram",
        senderId: "10001",
      },
    });
    const context = {
      runId: "run-openclaw-ack",
      sessionId: "session-openclaw-ack",
      trigger: "user",
      sessionKey: "agent:main:telegram:default:direct:10001",
      messageProvider: "telegram",
      channelId: "10001",
      senderId: "10001",
    };
    const claimed = store.claim(context);
    await client.submitInjectionRecord(claimed, "injected");
    let delivery = app.store.injectionStatus(
      app.store.authenticate(openclaw.api_key),
      preview.resume_id,
    );
    assert.equal(delivery.status, "in_flight");
    const [finished] = store.finish(context, true);
    await client.submitInjectionRecord(finished.record, finished.phase);
    delivery = app.store.injectionStatus(
      app.store.authenticate(openclaw.api_key),
      preview.resume_id,
    );
    assert.equal(delivery.status, "acknowledged");
    assert.equal(delivery.ack_complete, true);
    assert.equal(delivery.latest_attempt.provenance.agent_instance_id, "openclaw-local");
    assert.equal(delivery.latest_attempt.turn_id, "run-openclaw-ack");
  } finally {
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("confirmed Resume activates a durable conversation task scope without reinjecting the Packet", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-openclaw-task-scope-"));
  try {
    const store = new TaskScopeStore(path.join(root, "task-scopes"));
    const packet = {
      resume_id: "resume-task-scope-a",
      preview_version: 1,
      project: { project_id: "project-restored", name: "Restored Project" },
      task: { task_id: "task-restored", title: "Restored Task", goal: "Continue", status: "active" },
    };
    const commandContext = {
      sessionKey: "agent:main:telegram:command-only",
      channel: "telegram",
      senderId: "10001",
    };
    const staged = store.stage({ packet, context: commandContext, workstreamId: "workstream-openclaw" });
    assert.equal(staged.status, "pending");
    assert.equal(store.activate({
      sessionKey: "agent:main:telegram:default:direct:10002",
      messageProvider: "telegram",
      channelId: "10002",
    }), null);
    const turnContext = {
      runId: "run-restored",
      sessionKey: "agent:main:telegram:default:direct:10001",
      messageProvider: "telegram",
      channelId: "10001",
      senderId: "10001",
    };
    const active = store.activate(turnContext);
    assert.equal(active.status, "active");
    assert.equal(active.task_id, "task-restored");
    assert.deepEqual(store.counts(), { pending: 0, active: 1, superseded: 0 });

    const config = resolveAdapterConfig({
      serverUrl: "http://127.0.0.1:47831",
      allowInsecureHttp: true,
      apiKeyFile: path.join(root, "key"),
      outboxDir: path.join(root, "outbox"),
      deviceId: "openclaw-host",
      agentId: "openclaw",
      agentInstanceId: "openclaw-local",
      projectId: "project-adapter",
      taskId: "task-adapter",
      workstreamId: "workstream-openclaw",
    });
    const event = buildHookEvent("message_received", { content: "继续" }, turnContext, config, active);
    assert.equal(event.project_id, "project-restored");
    assert.equal(event.task_id, "task-restored");
    assert.equal(event.workstream_id, "workstream-openclaw");
    assert.equal(event.provenance.agent_instance_id, "openclaw-local");
    assert.equal(event.raw_hook_payload.context.mnemuron_task_scope.source, "confirmed-resume");
    assert.equal(store.resolve({ sessionKey: turnContext.sessionKey }).resume_id, packet.resume_id);

    const toolContext = {
      runId: "run-restored",
      sessionKey: "agent:main:telegram:default:direct:10001",
      sessionId: "session-restored",
      channelId: "10001",
    };
    const toolScope = store.resolve(toolContext);
    assert.equal(toolScope.resume_id, packet.resume_id);
    const toolEvent = buildHookEvent("after_tool_call", {
      toolName: "mnemuron_status",
      params: {},
      result: { ok: true },
    }, toolContext, config, toolScope);
    assert.equal(toolEvent.task_id, "task-restored");
    assert.equal(toolEvent.workstream_id, "workstream-openclaw");
    assert.equal(toolEvent.raw_hook_payload.context.mnemuron_task_scope.source, "confirmed-resume");
    assert.equal(store.resolve({
      sessionKey: "agent:main:telegram:default:direct:10002",
      channelId: "10002",
    }), null);
    assert.equal(statSync(path.join(root, "task-scopes")).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw adapter queues events while offline and flushes them without duplication", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-openclaw-outbox-"));
  const app = createMnemuronApp({ databasePath: path.join(root, "mnemuron.sqlite3") });
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const admin = app.store.bootstrapAdmin();
    const openclaw = await api(baseUrl, admin.api_key, "POST", "/v1/agent-instances/register", {
      label: "OpenClaw example client",
      device_id: "openclaw-host",
      agent_id: "openclaw",
      agent_instance_id: "openclaw-local",
    }, 201);
    await api(baseUrl, admin.api_key, "POST", "/v1/tasks", task);

    const liveConfig = adapterConfig(root, baseUrl, openclaw.api_key);
    const offlineConfig = {
      ...liveConfig,
      serverUrl: new URL("http://127.0.0.1:1"),
      requestTimeoutMs: 250,
    };
    const event = buildHookEvent("message_received", {
      content: "网络中断期间也要保存。",
      sessionKey: "agent:main:telegram:dm:10002",
    }, { sessionKey: "agent:main:telegram:dm:10002" }, liveConfig);

    const queued = await new MnemuronClient(offlineConfig).submitEvent(event);
    assert.equal(queued.delivery, "queued");
    const recovered = await new MnemuronClient(liveConfig).flushOutbox();
    assert.equal(recovered.queued_before, 1);
    assert.equal(recovered.flushed, 1);
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE event_id = ?")
      .get(event.event_id).count, 1);
  } finally {
    if (app.server.listening) await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("OpenClaw outbox quarantines a permanent 413 and continues later events", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mnemuron-openclaw-quarantine-"));
  try {
    const config = adapterConfig(root, "http://127.0.0.1:1", "mnm_test-quarantine");
    const client = new MnemuronClient(config);
    client.queueEnvelope({
      event: { event_id: "event-413-a", session_id: "lane-bad" },
      raw_retention_days: 1,
    });
    client.queueEnvelope({
      event: { event_id: "event-valid-z", session_id: "lane-good" },
      raw_retention_days: 1,
    });
    const delivered = [];
    client.request = async (method, _endpoint, envelope) => {
      if (method === "GET") return { mode: "remote-v0.1", production_ready: false };
      if (envelope.event.event_id === "event-413-a") {
        const error = new Error("Request body is too large.");
        error.statusCode = 413;
        throw error;
      }
      delivered.push(envelope.event.event_id);
      return { status: "accepted", received: 1, inserted: 1, duplicate: 0 };
    };

    assert.deepEqual(await client.flushOutbox(), {
      queued_before: 2,
      flushed: 1,
      quarantined: 1,
      blocked: 0,
    });
    assert.deepEqual(delivered, ["event-valid-z"]);
    assert.equal(client.outboxFiles().length, 0);
    assert.deepEqual(
      client.outboxQuarantineFiles().map((file) => path.basename(file)),
      ["event-413-a.json", "event-413-a.terminal.json"],
    );
    const [terminal] = client.quarantinedOutboxItems();
    assert.equal(terminal.event_id, "event-413-a");
    assert.equal(terminal.reason, "permanent_http_413");
    assert.equal(terminal.http_status, 413);
    assert.equal(statSync(config.outboxQuarantineDir).mode & 0o777, 0o700);
    assert.equal(
      statSync(path.join(config.outboxQuarantineDir, "event-413-a.json")).mode & 0o777,
      0o600,
    );
    const status = await client.status();
    assert.equal(status.adapter.queued_events, 0);
    assert.equal(status.adapter.quarantined_events, 1);
    assert.equal(status.adapter.sync_status, "degraded");
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(config.outboxQuarantineDir, "event-413-a.json"), "utf8")),
      { event: { event_id: "event-413-a", session_id: "lane-bad" }, raw_retention_days: 1 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

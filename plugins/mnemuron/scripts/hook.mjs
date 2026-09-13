#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  flushDeliveryReceiptOutbox,
  flushInjectionEventOutbox,
  flushOutbox,
  submitEvent,
  submitDeliveryReceipt,
  submitInjectionEvent,
  eventEnvelope,
} from "./remote-client.mjs";
import {
  appendJsonLine,
  acquireMcpResumeDeliveryLock,
  applyMcpDeliveryAcknowledgementIntents,
  activateTaskBootstrapScope,
  activateTaskScopeForResume,
  armPendingResumeDeliveries,
  authorizeMcpSession,
  claimResumeInjection,
  deliveryReceiptPayload,
  enqueueDeliveryReceipt,
  enqueueInjectionEvent,
  enqueueOutbox,
  failResumeInjection,
  finishResumeInjection,
  finishMcpResumeDelivery,
  hasPendingResumeInjection,
  hasUnreturnedMcpResumeDelivery,
  injectionEventPayload,
  loadRuntimeEnv,
  markMcpDeliveryAcknowledgementReported,
  pendingResumeCounts,
  pendingMcpDeliveryAcknowledgements,
  queueResumeInjection,
  recordMcpDeliveryAcknowledgementIntent,
  recordResumeConfirmationIntent,
  recoverResumeInjections,
  recoverMcpResumeDeliveries,
  releaseMcpResumeDeliveryLock,
  resolveDataDir,
  resolveTaskScope,
  returnedMcpResumeDeliveryForSession,
  runtimeMode,
  stageTaskScopeForSession,
} from "./storage.mjs";

const EVENT_TYPE = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_message",
  PostToolUse: "tool_result",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  Stop: "assistant_message",
  SessionEnd: "session_end",
};

const COMPATIBILITY_INJECTION_METHOD = "codex-post-tool-additional-context";

function matchesMnemuronTool(payload, toolName) {
  const actual = String(payload?.tool_name || "");
  return actual === toolName || actual.endsWith(`__${toolName}`);
}

function structuredToolResponse(payload) {
  let response = payload?.tool_response;
  if (typeof response === "string") {
    try {
      response = JSON.parse(response);
    } catch {
      return null;
    }
  }
  if (!response || typeof response !== "object") return null;
  if (response.structuredContent && typeof response.structuredContent === "object") {
    return response.structuredContent;
  }
  if (response.status) return response;
  const textBlock = Array.isArray(response.content)
    ? response.content.find((block) => block?.type === "text" && typeof block.text === "string")
    : null;
  if (!textBlock) return null;
  try {
    const parsed = JSON.parse(textBlock.text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function compatibilitySessionContext(sessionId) {
  return [
    "Mnemuron ChatGPT MCP Delivery Receipt mode v0.1.4 is active for this session.",
    `The exact hook-attested session_id is ${sessionId}.`,
    "When calling mnemuron_confirm_resume, always pass this exact session_id together with the Resume ID, preview version, and confirmation choice.",
    "At the beginning of every ordinary user turn, before acting on the request, call mnemuron_take_pending_resume exactly once with this exact session_id.",
    "A confirmed Resume is armed only after the confirmation turn stops. The next ordinary turn may receive authoritative Resume context directly in the MCP tool result after central server accepts a delivery receipt.",
    "Never call mnemuron_take_pending_resume again during the same confirmation turn. If the tool returns no resume_context, continue the ordinary user request normally.",
  ].join("\n");
}

function shouldRecoverInterruptedDelivery(payload) {
  return payload?.hook_event_name === "SessionStart"
    && payload?.source !== "compact";
}

function stageConfirmedResume(dataDir, payload, runtimeEnv) {
  if (payload?.hook_event_name !== "PostToolUse"
      || !matchesMnemuronTool(payload, "mnemuron_confirm_resume")) return null;
  const response = structuredToolResponse(payload);
  const input = payload.tool_input;
  if (response?.status !== "confirmed"
      || !response.resume_packet
      || input?.confirmed !== true
      || input.resume_id !== response.resume_packet.resume_id
      || input.preview_version !== response.resume_packet.preview_version
      || typeof payload.session_id !== "string"
      || typeof payload.turn_id !== "string") return null;
  const taskScope = stageTaskScopeForSession(
    dataDir,
    response.resume_packet,
    payload.session_id,
    runtimeEnv,
  );
  const adapterInjection = queueResumeInjection(
    dataDir,
    response.resume_packet,
    taskScope.target_session_id,
    taskScope.workstream_id,
    {
      injectionMethod: COMPATIBILITY_INJECTION_METHOD,
      confirmationTurnId: payload.turn_id,
    },
  );
  return { taskScope, adapterInjection };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(input || "{}"));
      } catch (error) {
        reject(new Error(`Invalid hook JSON: ${error.message}`));
      }
    });
    process.stdin.on("error", reject);
  });
}

function retentionExpiry(env, capturedAt) {
  const configured = String(env.MNEMURON_RAW_RETENTION_DAYS || "30").toLowerCase();
  if (["permanent", "forever", "infinite"].includes(configured)) {
    return null;
  }
  const days = Number(configured);
  if (!Number.isInteger(days) || days < 1) {
    throw new Error("MNEMURON_RAW_RETENTION_DAYS must be an integer >= 1 or 'permanent'.");
  }
  return new Date(Date.parse(capturedAt) + days * 86_400_000).toISOString();
}

function identity(env) {
  const host = os.hostname();
  const configured = Boolean(
    env.MNEMURON_DEVICE_ID &&
      env.MNEMURON_AGENT_ID &&
      env.MNEMURON_AGENT_INSTANCE_ID,
  );
  return {
    device_id: env.MNEMURON_DEVICE_ID || host,
    agent_id: env.MNEMURON_AGENT_ID || "chatgpt",
    agent_instance_id:
      env.MNEMURON_AGENT_INSTANCE_ID || `chatgpt:${host}`,
    identity_status: configured ? "configured" : "fallback",
  };
}

export function normalizeHookEvent(payload, env = process.env, now = new Date(), taskScope = null) {
  const hookName = payload.hook_event_name;
  if (!hookName || !EVENT_TYPE[hookName]) {
    throw new Error(`Unsupported or missing hook_event_name: ${hookName || "<missing>"}`);
  }
  const capturedAt = now.toISOString();
  const content =
    hookName === "UserPromptSubmit"
      ? payload.prompt ?? null
      : hookName === "Stop"
        ? payload.last_assistant_message ?? null
        : null;
  const explicitScope = {
    project_id: payload.project_id ?? null,
    task_id: payload.task_id ?? null,
    workstream_id: payload.workstream_id ?? null,
  };
  const resolvedScope = taskScope ? {
    project_id: taskScope.project_id ?? null,
    task_id: taskScope.task_id ?? null,
    workstream_id: taskScope.workstream_id ?? null,
  } : explicitScope;
  const scopeEvidence = taskScope ? {
    schema_version: taskScope.schema_version,
    source: taskScope.binding_kind === "task_bootstrap"
      ? "confirmed-task-bootstrap"
      : "confirmed-resume",
    binding_kind: taskScope.binding_kind || "resume",
    binding_id: taskScope.binding_id || taskScope.resume_id,
    resume_id: taskScope.resume_id || null,
    bootstrap_id: taskScope.bootstrap_id || null,
    preview_version: taskScope.preview_version,
    ...resolvedScope,
    activated_at: taskScope.activated_at,
  } : Object.values(explicitScope).some(Boolean) ? {
    source: "event-explicit",
    ...resolvedScope,
  } : { source: "unbound" };

  return {
    schema_version: "0.1.0",
    event_id: randomUUID(),
    event_type: EVENT_TYPE[hookName],
    hook_event_name: hookName,
    captured_at: capturedAt,
    expires_at: retentionExpiry(env, capturedAt),
    session_id: payload.session_id ?? null,
    turn_id: payload.turn_id ?? null,
    project_id: resolvedScope.project_id,
    task_id: resolvedScope.task_id,
    workstream_id: resolvedScope.workstream_id,
    cwd: payload.cwd ?? null,
    model: payload.model ?? null,
    tool_name: payload.tool_name ?? null,
    tool_use_id: payload.tool_use_id ?? null,
    content,
    provenance: identity(env),
    capture_capability: {
      user_messages: true,
      assistant_messages: true,
      tool_events: true,
      transcript_parser_used: false,
    },
    raw_hook_payload: {
      ...payload,
      mnemuron_task_scope: scopeEvidence,
    },
  };
}

async function main() {
  const payload = await readStdin();
  const runtimeEnv = loadRuntimeEnv();
  const dataDir = resolveDataDir(runtimeEnv);
  if (typeof payload.session_id === "string" && payload.session_id.trim()) {
    authorizeMcpSession(dataDir, payload.session_id, {
      hookEventName: payload.hook_event_name || null,
      turnId: typeof payload.turn_id === "string" ? payload.turn_id : null,
    });
  }
  if (payload.hook_event_name === "Stop"
      && typeof payload.session_id === "string"
      && typeof payload.turn_id === "string") {
    recordMcpDeliveryAcknowledgementIntent(
      dataDir,
      payload.session_id,
      payload.turn_id,
    );
  }
  if (payload.hook_event_name === "SessionStart"
      && typeof payload.session_id === "string"
      && payload.session_id.trim()) {
    const recoverInterruptedDelivery = shouldRecoverInterruptedDelivery(payload);
    const recoveryLock = acquireMcpResumeDeliveryLock(dataDir, payload.session_id);
    if (recoveryLock) {
      try {
        applyMcpDeliveryAcknowledgementIntents(dataDir, payload.session_id);
        for (const recovered of recoverInterruptedDelivery
          ? recoverMcpResumeDeliveries(dataDir, payload.session_id)
          : []) {
          const failed = deliveryReceiptPayload(recovered, "failed", {
            turnId: recovered.claimed_turn_id || null,
            occurredAt: recovered.failed_at,
          });
          if (runtimeMode(runtimeEnv) === "remote") {
            try {
              await submitDeliveryReceipt(recovered.resume_id, failed, runtimeEnv);
            } catch (error) {
              enqueueDeliveryReceipt(dataDir, recovered.resume_id, failed);
              process.stderr.write(
                `Mnemuron recovered delivery receipt queued: ${error.message}\n`,
              );
            }
          }
        }
      } finally {
        releaseMcpResumeDeliveryLock(recoveryLock);
      }
    } else {
      process.stderr.write(
        "Mnemuron MCP delivery recovery deferred: a live delivery owns this Session.\n",
      );
    }
    for (const recovered of recoverInterruptedDelivery
      ? recoverResumeInjections(dataDir, payload.session_id)
      : []) {
      const failed = injectionEventPayload(recovered, "failed", recovered.failed_at);
      if (runtimeMode(runtimeEnv) === "remote") {
        try {
          await submitInjectionEvent(recovered.resume_id, failed, runtimeEnv);
        } catch (error) {
          enqueueInjectionEvent(dataDir, recovered.resume_id, failed);
          process.stderr.write(`Mnemuron recovered injection event queued: ${error.message}\n`);
        }
      }
    }
  }
  if (runtimeMode(runtimeEnv) === "remote") {
    for (const acknowledgement of pendingMcpDeliveryAcknowledgements(dataDir)) {
      enqueueDeliveryReceipt(
        dataDir,
        acknowledgement.resume_id,
        acknowledgement.payload,
      );
    }
  }
  let injectionTransportReady = true;
  if (runtimeMode(runtimeEnv) === "remote") {
    try {
      await flushDeliveryReceiptOutbox(runtimeEnv);
    } catch (error) {
      process.stderr.write(`Mnemuron delivery-receipt synchronization unavailable: ${error.message}\n`);
    }
    try {
      const sync=await flushInjectionEventOutbox(runtimeEnv);
      injectionTransportReady=sync.blocked===0 && sync.quarantined===0;
    } catch (error) {
      injectionTransportReady = false;
      process.stderr.write(`Mnemuron injection-event synchronization unavailable: ${error.message}\n`);
    }
  }
  if (payload.hook_event_name === "UserPromptSubmit") {
    recordResumeConfirmationIntent(dataDir, payload);
  }
  let compatibilityStage = null;
  let compatibilityStageError = null;
  if (payload.hook_event_name === "PostToolUse"
      && matchesMnemuronTool(payload, "mnemuron_confirm_resume")) {
    try {
      compatibilityStage = stageConfirmedResume(dataDir, payload, runtimeEnv);
    } catch (error) {
      compatibilityStageError = error;
      process.stderr.write(`Mnemuron compatibility staging failed: ${error.message}\n`);
    }
  }
  const compatibilityProbe = payload.hook_event_name === "PostToolUse"
    && matchesMnemuronTool(payload, "mnemuron_take_pending_resume");
  const claimEvent = payload.hook_event_name === "UserPromptSubmit" || compatibilityProbe;
  let claimedInjection = null;
  let injectionDeferred = false;
  if (claimEvent
      && injectionTransportReady
      && typeof payload.session_id === "string"
      && typeof payload.turn_id === "string") {
    claimedInjection = claimResumeInjection(
      dataDir,
      payload.session_id,
      payload.turn_id,
      runtimeEnv,
      compatibilityProbe ? COMPATIBILITY_INJECTION_METHOD : null,
    );
    if (claimedInjection && runtimeMode(runtimeEnv) === "remote") {
      try {
        await submitInjectionEvent(
          claimedInjection.resume_id,
          injectionEventPayload(claimedInjection, "injected", claimedInjection.injected_at),
          runtimeEnv,
        );
      } catch (error) {
        const failed = failResumeInjection(dataDir, claimedInjection.attempt_id, {
          errorMessage: `central server did not confirm the injection declaration: ${error.message}`,
        });
        if (failed) {
          enqueueInjectionEvent(
            dataDir,
            failed.resume_id,
            injectionEventPayload(failed, "failed", failed.failed_at),
          );
        }
        claimedInjection = null;
        injectionDeferred = true;
        process.stderr.write(`Mnemuron Resume injection deferred: ${error.message}\n`);
      }
    }
  }
  if (claimEvent
      && !injectionTransportReady
      && typeof payload.session_id === "string") {
    injectionDeferred = compatibilityProbe
      ? hasPendingResumeInjection(dataDir, payload.session_id, runtimeEnv)
      : pendingResumeCounts(dataDir).pending > 0;
  }
  const returnedMcpDelivery = typeof payload.session_id === "string"
    ? returnedMcpResumeDeliveryForSession(dataDir, payload.session_id)
    : null;
  const mcpResumeBlocksTaskScope = !returnedMcpDelivery
    && typeof payload.session_id === "string"
    && hasUnreturnedMcpResumeDelivery(dataDir, payload.session_id);
  const taskScope = returnedMcpDelivery
    ? activateTaskScopeForResume(
      dataDir,
      payload.session_id,
      returnedMcpDelivery.resume_id,
      returnedMcpDelivery.preview_version,
      runtimeEnv,
    )
    : mcpResumeBlocksTaskScope
      ? null
      : claimedInjection
        ? activateTaskScopeForResume(
          dataDir,
          payload.session_id,
          claimedInjection.resume_id,
          claimedInjection.preview_version,
          runtimeEnv,
        )
        : payload.hook_event_name === "UserPromptSubmit"
          ? injectionDeferred
            ? resolveTaskScope(dataDir, payload.session_id, runtimeEnv)
            : activateTaskBootstrapScope(dataDir, payload.session_id, runtimeEnv)
          : resolveTaskScope(dataDir, payload.session_id, runtimeEnv);
  const record = normalizeHookEvent(payload, runtimeEnv, new Date(), taskScope);
  if (runtimeMode(runtimeEnv) === "remote") {
    enqueueOutbox(dataDir, eventEnvelope(record, runtimeEnv));
    try {
      const sync=await flushOutbox(runtimeEnv);
      if(sync.blocked || sync.quarantined)process.stderr.write('Mnemuron event queued for retry or isolated; inspect sync_state.\n');
    } catch (error) {
      process.stderr.write(`Mnemuron event queued for retry: ${error.message}\n`);
    }
  } else {
    appendJsonLine(dataDir, "events.jsonl", record);
  }
  if (payload.hook_event_name === "Stop"
      && typeof payload.session_id === "string"
      && typeof payload.turn_id === "string") {
    let mcpDeliveries = [];
    const stopDeliveryLock = acquireMcpResumeDeliveryLock(dataDir, payload.session_id);
    if (stopDeliveryLock) {
      try {
        mcpDeliveries = applyMcpDeliveryAcknowledgementIntents(
          dataDir,
          payload.session_id,
        );
      } finally {
        releaseMcpResumeDeliveryLock(stopDeliveryLock);
      }
    } else {
      process.stderr.write(
        "Mnemuron MCP Delivery Receipt ACK deferred: this Session delivery is still locked.\n",
      );
    }
    for (const delivery of mcpDeliveries) {
      const ack = delivery.delivery_ack_payload || deliveryReceiptPayload(
        delivery,
        "acknowledged",
        {
          turnId: payload.turn_id,
          occurredAt: delivery.delivered_at,
        },
      );
      if (runtimeMode(runtimeEnv) === "remote") {
        try {
          await submitDeliveryReceipt(delivery.resume_id, ack, runtimeEnv);
          markMcpDeliveryAcknowledgementReported(dataDir, ack.receipt_event_id);
        } catch (error) {
          enqueueDeliveryReceipt(dataDir, delivery.resume_id, ack);
          process.stderr.write(`Mnemuron Delivery Receipt ACK queued: ${error.message}\n`);
        }
      }
    }
    const finished = finishResumeInjection(dataDir, payload.session_id, payload.turn_id);
    for (const injection of finished) {
      const ack = injectionEventPayload(injection, "acknowledged", injection.delivered_at);
      if (runtimeMode(runtimeEnv) === "remote") {
        try {
          await submitInjectionEvent(injection.resume_id, ack, runtimeEnv);
        } catch (error) {
          enqueueInjectionEvent(dataDir, injection.resume_id, ack);
          process.stderr.write(`Mnemuron Resume acknowledgement queued: ${error.message}\n`);
        }
      }
    }
    armPendingResumeDeliveries(dataDir, payload.session_id, payload.turn_id);
  }
  let additionalContext = null;
  if (claimedInjection) {
    additionalContext = claimedInjection.text;
  } else if (compatibilityProbe && injectionDeferred) {
    additionalContext = [
      "Mnemuron has a confirmed Resume pending for this session, but central server did not accept the injection declaration.",
      "Do not treat the restored task as active and do not infer the Resume Packet from prior messages.",
      "Tell the user the Resume remains pending and can be retried on a later ordinary turn.",
    ].join("\n");
  } else if (compatibilityStageError) {
    additionalContext = [
      "Mnemuron confirmation succeeded, but local compatibility staging failed.",
      "Do not treat the Resume as injected or the restored Task Scope as active.",
      "Report that the ChatGPT adapter needs repair before the next-turn restore can continue.",
    ].join("\n");
  } else if (compatibilityStage) {
    additionalContext = [
      "Mnemuron staged the confirmed Resume for this exact ChatGPT session.",
      "Do not call mnemuron_take_pending_resume again during this confirmation turn.",
      "The next ordinary user turn must call the probe once before acting; only then may the Resume be injected and the Task Scope activated.",
    ].join("\n");
  } else if (payload.hook_event_name === "SessionStart") {
    additionalContext = compatibilitySessionContext(payload.session_id);
  }
  const output = additionalContext ? {
    hookSpecificOutput: {
      hookEventName: payload.hook_event_name,
      additionalContext,
    },
  } : {};
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    process.stderr.write(`Mnemuron hook failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

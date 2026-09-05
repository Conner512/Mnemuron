import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  buildHookEvent,
  buildResumeInjectionText,
  formatRawAvailabilityLine,
  MnemuronClient,
  PendingResumeStore,
  resolveAdapterConfig,
  TaskScopeStore,
} from "./client.js";

const objectSchema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function checkpointLine(checkpoint) {
  if (!checkpoint) return "Checkpoint：无";
  const warningCount = checkpoint.generation?.warnings?.length || 0;
  return [
    `Checkpoint：v${checkpoint.version} / ${checkpoint.workstream_id}`,
    `来源：${checkpoint.provenance?.agent_instance_id}@${checkpoint.provenance?.device_id}`,
    `Session：${checkpoint.session_id}`,
    `生成：${checkpoint.generation?.method} / ${checkpoint.generation?.confidence_label}`,
    `来源事件：${checkpoint.source_event_ids?.length || 0}，限制提示：${warningCount}`,
  ].join("\n");
}

function formatPreview(preview) {
  if (preview.status !== "pending_confirmation") return JSON.stringify(preview, null, 2);
  const checkpoints = preview.latest_checkpoints || [];
  const checkpointText = checkpoints.length
    ? checkpoints.map(checkpointLine).join("\n\n")
    : "Checkpoint：无；当前 Preview 来自 canonical Task、显式 Memory 和最近活动。";
  return [
    "Mnemuron Resume Preview（尚未确认）",
    `项目：${preview.project?.name}`,
    `任务：${preview.task?.title}`,
    `来源分支：${(preview.branch_selection?.selected_workstream_ids || [])
      .join("；") || "全部"} (${preview.branch_selection?.mode || "all"})`,
    `目标：${preview.task?.goal}`,
    `进度：${(preview.progress || []).join("；") || "无"}`,
    `阻塞：${(preview.blockers || []).join("；") || "无"}`,
    `下一步：${(preview.next_steps || []).join("；") || "无"}`,
    checkpointText,
    `Resume ID：${preview.resume_id}`,
    `版本：${preview.preview_version}`,
    `确认：/mnemuron confirm ${preview.resume_id} ${preview.preview_version}`,
    "确认前不会注入 Resume Packet。",
  ].join("\n");
}

function formatStatus(status) {
  return [
    `Mnemuron：${status.mode}`,
    `身份：${status.identity?.agent_instance_id}@${status.identity?.device_id} (${status.identity?.identity_status})`,
    `同步：${status.adapter?.sync_status}，队列 ${status.adapter?.queued_events}`,
    `数据：${status.counts?.events || 0} Event / ${status.counts?.checkpoints || 0} Checkpoint / ${status.counts?.tasks || 0} Task`,
    formatRawAvailabilityLine(status),
  ].join("\n");
}

function formatProjectContext(preview) {
  if (preview.status !== "project_context_preview") return JSON.stringify(preview, null, 2);
  const taskLines = (preview.tasks || []).map((task) =>
    `- ${task.title} [${task.status}] ${task.task_id} / Canonical v${task.canonical_version ?? "?"}`);
  const memoryLines = (preview.structured_memories || []).slice(0, 10)
    .map((memory) => `- ${memory.content}`);
  return [
    "Mnemuron Project Memory Preview（只读）",
    `项目：${preview.project?.name} (${preview.project?.project_id})`,
    `任务：${preview.source_summary?.task_count || 0}，活跃 ${preview.source_summary?.active_task_count || 0}`,
    ...(taskLines.length ? taskLines : ["- 当前项目没有 Task"]),
    `显式记忆：${preview.source_summary?.structured_memory_count || 0}`,
    ...(memoryLines.length ? memoryLines : ["- 无显式项目记忆"]),
    `最新 Checkpoint：${preview.source_summary?.latest_checkpoint_count || 0}`,
    `最近来源：${(preview.source_summary?.identities || []).join("；") || "无"}`,
    "本次只读取项目上下文；没有创建 Resume、切换 Task Scope 或注入内容。",
    taskLines.length ? "如需继续，请从上面的 Task ID 创建 Resume Preview。" : "当前没有可恢复 Task。",
  ].join("\n");
}

function formatTaskBranches(preview) {
  if (preview.status !== "task_branches_preview") return JSON.stringify(preview, null, 2);
  const branchLines = (preview.branches || []).flatMap((branch) => [
    `- ${branch.name || branch.workstream_id} [${branch.status || "unknown"}]`,
    `  Workstream：${branch.workstream_id}`,
    `  Checkpoint：${branch.latest_checkpoint
      ? `v${branch.latest_checkpoint.version} / ${branch.latest_checkpoint.created_at}`
      : "无"}`,
    `  来源：${(branch.source_identities || []).map((identity) =>
      `${identity.agent_instance_id}@${identity.device_id}`).join("；") || "无"}`,
  ]);
  const conflictLines = (preview.conflicts || []).map((conflict, index) =>
    `- 冲突 ${index + 1}：${JSON.stringify(conflict)}`);
  return [
    "Mnemuron Task Branches Preview（只读）",
    `项目：${preview.project?.name} (${preview.project?.project_id})`,
    `任务：${preview.task?.title} (${preview.task?.task_id})`,
    `Canonical：v${preview.task?.canonical_version ?? "?"} / ${preview.task?.canonical_freshness || "unknown"}`,
    `Workstream：${preview.source_summary?.observed_workstream_count || 0}`,
    ...(branchLines.length ? branchLines : ["- 无 Workstream"]),
    `冲突：${preview.conflict_summary?.count || 0}`,
    ...(conflictLines.length ? conflictLines : ["- 无记录冲突"]),
    "本次只读取分支与冲突；没有合并、创建 Resume、切换 Task Scope 或注入内容。",
  ].join("\n");
}

function formatReconciliation(result) {
  const proposal = result.proposal || result;
  if (!proposal?.proposal_id) return JSON.stringify(result, null, 2);
  const operationLines = (proposal.operations || []).map((operation) =>
    `- ${operation.op} ${operation.field}: ${JSON.stringify(operation.before)} -> ${JSON.stringify(operation.after)}`);
  return [
    "Mnemuron Canonical Reconciliation",
    `状态：${proposal.status}`,
    `Proposal：${proposal.proposal_id} v${proposal.proposal_version}`,
    `Canonical 基线：v${proposal.base_canonical_version}`,
    `变更：${proposal.operations?.length || 0}，冲突：${proposal.conflicts?.length || 0}`,
    ...operationLines,
    proposal.status === "awaiting_confirmation"
      ? `确认：/mnemuron reconcile-confirm ${proposal.proposal_id} ${proposal.proposal_version} ${proposal.base_canonical_version}`
      : "无需确认。",
  ].join("\n");
}

function commandParts(args = "") {
  const trimmed = args.trim();
  if (!trimmed) return { action: "status", rest: "" };
  const [first, ...remaining] = trimmed.split(/\s+/u);
  const aliases = {
    status: "status",
    "状态": "status",
    continue: "continue",
    resume: "continue",
    "继续": "continue",
    load: "load-project",
    project: "load-project",
    "加载": "load-project",
    "项目": "load-project",
    branches: "branches",
    branch: "branches",
    "分支": "branches",
    confirm: "confirm",
    "确认": "confirm",
    cancel: "cancel",
    "取消": "cancel",
    remember: "remember",
    "记住": "remember",
    reconcile: "reconcile",
    "对账": "reconcile",
    "reconcile-confirm": "reconcile-confirm",
    "确认对账": "reconcile-confirm",
    "reconcile-reject": "reconcile-reject",
    "拒绝对账": "reconcile-reject",
    help: "help",
    "帮助": "help",
  };
  return aliases[first.toLowerCase()]
    ? { action: aliases[first.toLowerCase()], rest: remaining.join(" ") }
    : { action: "continue", rest: trimmed };
}

function helpText() {
  return [
    "/mnemuron status",
    "/mnemuron continue <任务> [--from <workstream_id[,workstream_id]>]",
    "/mnemuron load project <项目>",
    "/mnemuron branches <任务>",
    "/mnemuron confirm <resume_id> <version>",
    "/mnemuron cancel <resume_id> <version>",
    "/mnemuron remember <内容>",
    "/mnemuron reconcile <task_id>",
    "/mnemuron reconcile-confirm <proposal_id> <proposal_version> <base_version>",
    "/mnemuron reconcile-reject <proposal_id> <proposal_version> <base_version>",
  ].join("\n");
}

function parseContinueSelection(value) {
  const match = String(value || "").match(/^(.*?)\s+--from\s+([^\s]+)\s*$/u);
  if (!match) return { query: String(value || "").trim(), sourceWorkstreamIds: null };
  return {
    query: match[1].trim(),
    sourceWorkstreamIds: [...new Set(
      match[2].split(",").map((item) => item.trim()).filter(Boolean),
    )],
  };
}

export default definePluginEntry({
  id: "mnemuron",
  name: "Mnemuron",
  description: "Cross-agent memory and preview-first task handoff.",
  register(api) {
    const config = () => resolveAdapterConfig(api.pluginConfig || {});
    const client = () => new MnemuronClient(config());
    const pendingResumes = () => {
      const current = config();
      return new PendingResumeStore(current.pendingResumeDir, {
        workstreamId: current.workstreamId,
      });
    };
    const taskScopes = () => new TaskScopeStore(config().taskScopeDir);

    const capture = (name) => async (event, context) => {
      try {
        const currentClient = client();
        const scopeStore = taskScopes();
        const taskScope = ["message_received", "session_start"].includes(name)
          ? scopeStore.activate(context)
          : scopeStore.resolve(context);
        const record = buildHookEvent(name, event, context, currentClient.config, taskScope);
        const result = await currentClient.submitEvent(record);
        if (result.delivery === "queued") {
          api.logger.warn(`Mnemuron queued ${name} for retry: ${result.error}`);
        }
      } catch (error) {
        api.logger.warn(`Mnemuron ${name} capture failed: ${error.message}`);
      }
    };

    for (const name of [
      "message_received",
      "after_tool_call",
      "agent_end",
      "message_sent",
      "session_start",
      "session_end",
      "before_compaction",
      "after_compaction",
    ]) {
      api.on(name, capture(name), { timeoutMs: 8000 });
    }
    api.on("gateway_start", async () => {
      try {
        const currentClient = client();
        const recovered = pendingResumes().recoverInFlight();
        for (const item of recovered) {
          try {
            await currentClient.submitInjectionRecord(item.record, item.phase);
          } catch {
            currentClient.queueInjectionRecord(item.record, item.phase);
          }
        }
        if (recovered.length) api.logger.info(`Mnemuron recovered ${recovered.length} pending Resume injection(s).`);
        const injectionResult = await currentClient.flushInjectionEventOutbox();
        if (injectionResult.flushed) {
          api.logger.info(`Mnemuron synchronized ${injectionResult.flushed} queued injection event(s).`);
        }
        const result = await currentClient.flushOutbox();
        if (result.flushed) api.logger.info(`Mnemuron synchronized ${result.flushed} queued events.`);
      } catch (error) {
        api.logger.warn(`Mnemuron startup synchronization unavailable: ${error.message}`);
      }
    }, { timeoutMs: 8000 });

    api.on("before_prompt_build", async (_event, context) => {
      const store = pendingResumes();
      let pending = null;
      try {
        const currentClient = client();
        await currentClient.flushInjectionEventOutbox();
        pending = store.claim(context);
        if (!pending) {
          taskScopes().activate(context);
          return undefined;
        }
        await currentClient.submitInjectionRecord(pending, "injected");
        taskScopes().activate(context);
        api.logger.info(`Mnemuron injecting confirmed Resume Packet ${pending.resume_id} v${pending.preview_version}.`);
        return { prependContext: pending.text };
      } catch (error) {
        if (pending) {
          const failed = store.fail(pending.attempt_id, {
            errorMessage: `The Mnemuron server did not confirm the injection declaration: ${error.message}`,
          });
          if (failed) client().queueInjectionRecord(failed.record, failed.phase);
        }
        api.logger.warn(`Mnemuron pending Resume injection unavailable: ${error.message}`);
        return undefined;
      }
    }, { priority: 100, timeoutMs: 5000 });

    api.on("agent_end", async (event, context) => {
      try {
        const currentClient = client();
        const finished = pendingResumes().finish(
          { ...context, runId: event.runId || context.runId },
          event.success !== false,
        );
        for (const item of finished) {
          try {
            await currentClient.submitInjectionRecord(item.record, item.phase);
          } catch (error) {
            currentClient.queueInjectionRecord(item.record, item.phase);
            api.logger.warn(`Mnemuron queued Resume ${item.phase} event: ${error.message}`);
          }
        }
      } catch (error) {
        api.logger.warn(`Mnemuron Resume injection acknowledgement failed: ${error.message}`);
      }
    }, { timeoutMs: 5000 });

    api.registerTool((toolContext) => ({
      name: "mnemuron_status",
      label: "Mnemuron status",
      description: "Show Mnemuron server identity, capture counts, checkpoints, and local synchronization state.",
      parameters: objectSchema({}),
      async execute(_toolCallId, _params, signal) {
        return toolResult(await client().status(signal));
      },
    }), { names: ["mnemuron_status"] });

    api.registerTool((toolContext) => ({
      name: "mnemuron_preview_resume",
      label: "Preview Mnemuron resume",
      description: "Create an immutable Resume Preview. Never confirms or injects a Resume Packet.",
      parameters: objectSchema({
        query: { type: "string", minLength: 1 },
        source_workstream_ids: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1 },
        },
      }, ["query"]),
      async execute(_toolCallId, params, signal) {
        return toolResult(await client().request("POST", "/v1/resume/preview", {
          query: params.query,
          ...(params.source_workstream_ids === undefined
            ? {}
            : { source_workstream_ids: params.source_workstream_ids }),
        }, signal));
      },
    }), { names: ["mnemuron_preview_resume"] });

    api.registerTool(() => ({
      name: "mnemuron_preview_project_context",
      label: "Preview Mnemuron project memory",
      description: "Read shared project Tasks, Workstreams, memories, Checkpoints, and sources exactly once per user turn without creating a Resume or changing Task Scope.",
      parameters: objectSchema({
        query: { type: "string", minLength: 1 },
        signals: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            git_remote: { type: "string" },
            repo_fingerprint: { type: "string" },
            cwd: { type: "string" },
          },
          additionalProperties: false,
        },
      }, ["query"]),
      async execute(_toolCallId, params, signal) {
        return toolResult(await client().request("POST", "/v1/project-context/preview", {
          query: params.query,
          signals: params.signals || {},
        }, signal));
      },
    }), { names: ["mnemuron_preview_project_context"] });

    api.registerTool(() => ({
      name: "mnemuron_preview_task_branches",
      label: "Preview Mnemuron task branches",
      description: "Read one Task's parallel Workstreams, latest Checkpoints, source provenance, and recorded conflicts exactly once per user turn without merging or creating a Resume.",
      parameters: objectSchema({
        query: { type: "string", minLength: 1 },
        signals: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            task_id: { type: "string" },
          },
          additionalProperties: false,
        },
      }, ["query"]),
      async execute(_toolCallId, params, signal) {
        return toolResult(await client().request("POST", "/v1/task-branches/preview", {
          query: params.query,
          signals: params.signals || {},
        }, signal));
      },
    }), { names: ["mnemuron_preview_task_branches"] });

    api.registerTool((toolContext) => ({
      name: "mnemuron_confirm_resume",
      label: "Confirm Mnemuron resume",
      description: "Confirm or cancel an already displayed Resume Preview using its exact ID and version.",
      parameters: objectSchema({
        resume_id: { type: "string", minLength: 1 },
        preview_version: { type: "integer", minimum: 1 },
        confirmed: { type: "boolean" },
      }, ["resume_id", "preview_version", "confirmed"]),
      async execute(_toolCallId, params, signal) {
        const currentClient = client();
        const result = await currentClient.request(
          "POST",
          `/v1/resume/${encodeURIComponent(params.resume_id)}/confirm`,
          { preview_version: params.preview_version, confirmed: params.confirmed },
          signal,
        );
        if (params.confirmed && result.resume_packet) {
          result.task_scope = taskScopes().stage({
            packet: result.resume_packet,
            context: toolContext || {},
            workstreamId: currentClient.config.workstreamId,
          });
          result.adapter_injection = pendingResumes().queue({
            packet: result.resume_packet,
            text: buildResumeInjectionText(result.resume_packet),
            context: toolContext || {},
          });
        }
        return toolResult(result);
      },
    }), { names: ["mnemuron_confirm_resume"] });

    api.registerTool((toolContext) => ({
      name: "mnemuron_remember",
      label: "Remember in Mnemuron",
      description: "Explicitly save a fact, decision, constraint, or next step to shared Mnemuron memory.",
      parameters: objectSchema({
        content: { type: "string", minLength: 1 },
        scope: { type: "string", enum: ["user", "project", "task", "workstream", "session"] },
        project_id: { type: "string" },
        task_id: { type: "string" },
        workstream_id: { type: "string" },
        session_id: { type: "string" },
        memory_type: {
          type: "string",
          enum: ["goal", "fact", "constraint", "decision", "completed", "blocker", "remaining", "next_step"],
        },
        topic: { type: "string", minLength: 1, maxLength: 120 },
      }, ["content", "scope"]),
      async execute(_toolCallId, params, signal) {
        const currentClient = client();
        const activeScope = taskScopes().resolve(toolContext || {});
        return toolResult(await client().request("POST", "/v1/memories", {
          ...params,
          project_id: params.project_id || activeScope?.project_id || currentClient.config.projectId,
          task_id: params.task_id || activeScope?.task_id || currentClient.config.taskId,
          workstream_id: params.workstream_id || activeScope?.workstream_id || currentClient.config.workstreamId,
          source: "explicit-openclaw",
        }, signal));
      },
    }), { names: ["mnemuron_remember"] });

    api.registerTool(() => ({
      name: "mnemuron_search_memories",
      label: "Search Mnemuron memories",
      description: "Read-only bounded Structured Memory search with ranking, lifecycle state, provenance, and topic-keyed cross-Workstream conflict presentation.",
      parameters: objectSchema({
        query: { type: "string", minLength: 1, maxLength: 4096 },
        project_id: { type: "string" },
        task_id: { type: "string" },
        source_workstream_ids: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1 },
        },
        session_id: { type: "string" },
        memory_types: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "string",
            enum: ["goal", "fact", "constraint", "decision", "completed", "blocker", "remaining", "next_step"],
          },
        },
        statuses: {
          type: "array",
          minItems: 1,
          maxItems: 3,
          items: { type: "string", enum: ["active", "superseded", "retracted"] },
        },
        include_shared: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      }, ["query"]),
      async execute(_toolCallId, params, signal) {
        return toolResult(await client().request("POST", "/v1/memories/query", params, signal));
      },
    }), { names: ["mnemuron_search_memories"] });

    api.registerTool(() => ({
      name: "mnemuron_supersede_memory",
      label: "Correct Mnemuron memory",
      description: "Use only for an explicit user correction; preserve the old Memory and create one provenance-linked replacement.",
      parameters: objectSchema({
        memory_id: { type: "string", minLength: 1 },
        content: { type: "string", minLength: 1, maxLength: 4096 },
        reason: { type: "string", minLength: 1, maxLength: 1000 },
        memory_type: {
          type: "string",
          enum: ["goal", "fact", "constraint", "decision", "completed", "blocker", "remaining", "next_step"],
        },
        topic: {
          anyOf: [
            { type: "string", minLength: 1, maxLength: 120 },
            { type: "null" },
          ],
        },
      }, ["memory_id", "content"]),
      async execute(_toolCallId, params, signal) {
        const { memory_id: memoryId, ...body } = params;
        return toolResult(await client().request(
          "POST",
          `/v1/memories/${encodeURIComponent(memoryId)}/supersede`,
          body,
          signal,
        ));
      },
    }), { names: ["mnemuron_supersede_memory"] });

    api.registerTool(() => ({
      name: "mnemuron_retract_memory",
      label: "Retract Mnemuron memory",
      description: "Use only for an explicit user retraction; retain a tombstone and provenance instead of physically deleting the Memory.",
      parameters: objectSchema({
        memory_id: { type: "string", minLength: 1 },
        reason: { type: "string", minLength: 1, maxLength: 1000 },
      }, ["memory_id"]),
      async execute(_toolCallId, params, signal) {
        return toolResult(await client().request(
          "POST",
          `/v1/memories/${encodeURIComponent(params.memory_id)}/retract`,
          params.reason === undefined ? {} : { reason: params.reason },
          signal,
        ));
      },
    }), { names: ["mnemuron_retract_memory"] });

    api.registerTool(() => ({
      name: "mnemuron_reconciliation_status",
      label: "Mnemuron reconciliation status",
      description: "Show one Task's canonical version, pending proposals, conflicts, and latest revision.",
      parameters: objectSchema({ task_id: { type: "string", minLength: 1 } }, ["task_id"]),
      async execute(_toolCallId, params, signal) {
        return toolResult(await client().request(
          "GET",
          `/v1/tasks/${encodeURIComponent(params.task_id)}/reconciliation`,
          undefined,
          signal,
        ));
      },
    }), { names: ["mnemuron_reconciliation_status"] });

    api.registerTool(() => ({
      name: "mnemuron_preview_reconciliation",
      label: "Preview Mnemuron reconciliation",
      description: "Create or reuse a source-backed Canonical Task reconciliation proposal without silently applying material changes.",
      parameters: objectSchema({
        task_id: { type: "string", minLength: 1 },
        source_checkpoint_ids: {
          type: "array",
          maxItems: 50,
          items: { type: "string" },
        },
        derive_checkpoint_operations: { type: "boolean" },
        operations: {
          type: "array",
          maxItems: 50,
          items: { type: "object" },
        },
      }, ["task_id"]),
      async execute(_toolCallId, params, signal) {
        return toolResult(await client().request(
          "POST",
          `/v1/tasks/${encodeURIComponent(params.task_id)}/reconciliation/run`,
          {
            ...(params.source_checkpoint_ids === undefined
              ? {}
              : { source_checkpoint_ids: params.source_checkpoint_ids }),
            ...(params.derive_checkpoint_operations === undefined
              ? {}
              : { derive_checkpoint_operations: params.derive_checkpoint_operations }),
            ...(params.operations === undefined ? {} : { operations: params.operations }),
          },
          signal,
        ));
      },
    }), { names: ["mnemuron_preview_reconciliation"] });

    api.registerTool(() => ({
      name: "mnemuron_confirm_reconciliation",
      label: "Confirm Mnemuron reconciliation",
      description: "Confirm or reject an exact displayed Canonical Task proposal. This never confirms or injects a Resume.",
      parameters: objectSchema({
        proposal_id: { type: "string", minLength: 1 },
        proposal_version: { type: "integer", minimum: 1 },
        base_canonical_version: { type: "integer", minimum: 1 },
        confirmed: { type: "boolean" },
      }, ["proposal_id", "proposal_version", "base_canonical_version", "confirmed"]),
      async execute(_toolCallId, params, signal) {
        return toolResult(await client().request(
          "POST",
          `/v1/task-reconciliations/${encodeURIComponent(params.proposal_id)}/resolve`,
          {
            proposal_version: params.proposal_version,
            base_canonical_version: params.base_canonical_version,
            decision: params.confirmed ? "confirm" : "reject",
          },
          signal,
        ));
      },
    }), { names: ["mnemuron_confirm_reconciliation"] });

    api.registerCommand({
      name: "mnemuron",
      nativeNames: { default: "mnemuron" },
      description: "查看或恢复 Mnemuron 跨 Agent 任务",
      acceptsArgs: true,
      requireAuth: true,
      agentPromptGuidance: [
        "For natural-language task continuation without an already confirmed Mnemuron Resume Packet in context, use Mnemuron preview first and do not confirm in the same turn. If a confirmed Resume Packet is present, continue from it directly and do not preview or confirm it again.",
      ],
      handler: async (context) => {
        const { action, rest } = commandParts(context.args);
        const currentClient = client();
        if (action === "help") return { text: helpText() };
        if (action === "status") return { text: formatStatus(await currentClient.status()) };
        if (action === "continue") {
          if (!rest) return { text: "请提供任务名称：/mnemuron continue <任务>" };
          const selection = parseContinueSelection(rest);
          if (!selection.query || selection.sourceWorkstreamIds?.length === 0) {
            return {
              text: "用法：/mnemuron continue <任务> [--from <workstream_id[,workstream_id]>]",
            };
          }
          const preview = await currentClient.request("POST", "/v1/resume/preview", {
            query: selection.query,
            ...(selection.sourceWorkstreamIds
              ? { source_workstream_ids: selection.sourceWorkstreamIds }
              : {}),
          });
          return { text: formatPreview(preview) };
        }
        if (action === "load-project") {
          const query = rest.replace(/^(?:project|项目)\s+/iu, "").trim();
          if (!query) return { text: "请提供项目名称：/mnemuron load project <项目>" };
          const preview = await currentClient.request(
            "POST",
            "/v1/project-context/preview",
            { query },
          );
          return { text: formatProjectContext(preview) };
        }
        if (action === "branches") {
          if (!rest) return { text: "请提供任务名称：/mnemuron branches <任务>" };
          const preview = await currentClient.request(
            "POST",
            "/v1/task-branches/preview",
            { query: rest },
          );
          return { text: formatTaskBranches(preview) };
        }
        if (action === "remember") {
          if (!rest) return { text: "请提供要保存的内容：/mnemuron remember <内容>" };
          const activeScope = taskScopes().resolve(context);
          const saved = await currentClient.request("POST", "/v1/memories", {
            content: rest,
            scope: "task",
            project_id: activeScope?.project_id || currentClient.config.projectId,
            task_id: activeScope?.task_id || currentClient.config.taskId,
            workstream_id: activeScope?.workstream_id || currentClient.config.workstreamId,
            session_id: context.sessionId || null,
            source: "explicit-openclaw-command",
          });
          return { text: `已保存到 Mnemuron：${saved.memory?.memory_id}` };
        }
        if (action === "reconcile") {
          if (!rest) return { text: "请提供 Task ID：/mnemuron reconcile <task_id>" };
          const result = await currentClient.request(
            "POST",
            `/v1/tasks/${encodeURIComponent(rest)}/reconciliation/run`,
            {},
          );
          return { text: formatReconciliation(result) };
        }
        if (["reconcile-confirm", "reconcile-reject"].includes(action)) {
          const [proposalId, proposalVersionText, baseVersionText] = rest.split(/\s+/u);
          const proposalVersion = Number(proposalVersionText);
          const baseCanonicalVersion = Number(baseVersionText);
          if (!proposalId || !Number.isInteger(proposalVersion)
              || !Number.isInteger(baseCanonicalVersion)) {
            return {
              text: `/mnemuron ${action} <proposal_id> <proposal_version> <base_version>`,
            };
          }
          const result = await currentClient.request(
            "POST",
            `/v1/task-reconciliations/${encodeURIComponent(proposalId)}/resolve`,
            {
              proposal_version: proposalVersion,
              base_canonical_version: baseCanonicalVersion,
              decision: action === "reconcile-confirm" ? "confirm" : "reject",
            },
          );
          return { text: formatReconciliation(result) };
        }
        const [resumeId, versionText] = rest.split(/\s+/u);
        const previewVersion = Number(versionText);
        if (!resumeId || !Number.isInteger(previewVersion) || previewVersion < 1) {
          return { text: `/mnemuron ${action} <resume_id> <version>` };
        }
        const confirmed = action === "confirm";
        const result = await currentClient.request(
          "POST",
          `/v1/resume/${encodeURIComponent(resumeId)}/confirm`,
          { preview_version: previewVersion, confirmed },
        );
        if (!confirmed) return { text: `Resume Preview 已取消：${resumeId}` };
        if (!context.sessionKey) {
          return { text: "Resume Packet 已确认，但当前通道没有可注入的 Session；请使用自然语言恢复工具。" };
        }
        const packet = result.resume_packet;
        taskScopes().stage({
          packet,
          context,
          workstreamId: currentClient.config.workstreamId,
        });
        const pending = pendingResumes().queue({
          packet,
          text: buildResumeInjectionText(packet),
          context,
        });
        return {
          text: pending.status === "delivered"
            ? "Resume Packet 已在此前的 Agent 轮次中完成注入，无需重复恢复。"
            : "Resume Packet 已确认并进入待恢复队列。请发送一条普通消息“继续”，它会在下一轮一次性注入。",
        };
      },
    });
  },
});

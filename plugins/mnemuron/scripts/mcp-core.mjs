import { randomUUID } from "node:crypto";
import os from "node:os";
import {
  appendJsonLine,
  appendPreviewIndex,
  acquireMcpResumeDeliveryLock,
  activateTaskScopeForResume,
  claimMcpResumeDelivery,
  deliveryReceiptPayload,
  enqueueDeliveryReceipt,
  listDeliveryReceiptOutbox,
  listPreviews,
  listInjectionEventOutbox,
  listOutboxQuarantine,
  loadRuntimeEnv,
  readJsonLines,
  readPreview,
  readTasks,
  markMcpResumeContextReturned,
  pendingMcpDeliveryAcknowledgements,
  pendingResumeCounts,
  queueResumeInjection,
  releaseMcpResumeDeliveryLock,
  requireCurrentMcpSessionAuthorization,
  resolveDataDir,
  resolveTaskScope,
  ownsMcpResumeDeliveryLock,
  stageTaskScopeForSession,
  taskScopeCounts,
  writePreview,
} from "./storage.mjs";
import { listOutbox, runtimeMode } from "./storage.mjs";
import {
  flushDeliveryReceiptOutbox,
  flushInjectionEventOutbox,
  flushOutbox,
  rememberRemote,
  remoteRequest,
  localSyncSummary,
  submitDeliveryReceipt,
} from "./remote-client.mjs";

export const PLUGIN_VERSION = "0.1.14+codex.20260904233116";
const RESUME_INJECTION_MODE = "chatgpt-mcp-delivery-receipt-v0.1.4";

export const TOOLS = [
  {
    name: "mnemuron_status",
    description: "Show Mnemuron spike identity, capture counts, tasks, and preview state.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_preview_resume",
    description: "Find one specific task to continue and create an immutable Resume Preview. Never use this tool for `/Mnemuron load project <project>` or read-only project-memory inspection; use mnemuron_preview_project_context instead. This never returns an injectable Resume Packet.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Specific Task title, Task alias, exact Task ID, or natural-language task description. A Project name alone is not a request to create a Resume Preview.",
        },
        signals: {
          type: "object",
          description: "Optional versioned Resolver context. Path is never sufficient by itself.",
          properties: {
            project_id: { type: "string" },
            task_id: { type: "string" },
            git_remote: { type: "string" },
            repo_fingerprint: { type: "string" },
            cwd: { type: "string" },
            device_id: { type: "string" },
            agent_id: { type: "string" },
            agent_instance_id: { type: "string" },
            session_id: { type: "string" },
          },
          additionalProperties: false,
        },
        source_workstream_ids: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1 },
          description: "Optional exact source Workstream IDs selected after a branches preview. One selects a single branch; multiple create a source-preserving combined view without automatic merge.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_preview_project_context",
    description: "Required tool for the exact command `/Mnemuron load project <project>` and for read-only shared project-memory inspection. Call exactly once per user turn. Resolve and show canonical Tasks, Workstreams, memories, Checkpoints, and recent sources. Never substitute mnemuron_preview_resume. This is read-only and never creates or confirms a Resume.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Project name, alias, exact project ID, or natural-language description.",
        },
        signals: {
          type: "object",
          description: "Optional Resolver context. A path is never sufficient by itself.",
          properties: {
            project_id: { type: "string" },
            git_remote: { type: "string" },
            repo_fingerprint: { type: "string" },
            cwd: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_preview_task_branches",
    description: "Required read-only tool for `/Mnemuron branches <task>`. Call exactly once per user turn. Show the canonical Task, parallel Workstreams, latest Checkpoint and source provenance per branch, and every recorded conflict without merging, creating a Resume, changing Task Scope, or injecting context.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Exact Task ID, Task title, alias, or task-specific natural-language description.",
        },
        signals: {
          type: "object",
          properties: {
            project_id: { type: "string" },
            task_id: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_preview_project_bootstrap",
    description: "Create an immutable Preview for one brand-new Project together with its first Canonical Task. This creates no Project, Task, Scope, Resume, or context. Any matching, ambiguous, or already pending Project fails closed.",
    inputSchema: {
      type: "object",
      properties: {
        project_name: { type: "string", minLength: 1, maxLength: 200 },
        project_aliases: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
        git_remotes: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 2048 },
        },
        repo_fingerprints: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 512 },
        },
        path_hints: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 4096 },
        },
        task_title: { type: "string", minLength: 1, maxLength: 200 },
        task_goal: { type: "string", minLength: 1, maxLength: 4096 },
        task_aliases: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
        session_id: {
          type: "string",
          description: "Exact hook-attested session_id supplied by Mnemuron SessionStart context.",
        },
      },
      required: ["project_name", "task_title", "task_goal", "session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_confirm_project_bootstrap",
    description: "Confirm or cancel one displayed Project Bootstrap Preview for the exact hook-attested session. Confirmation atomically creates the Project, its first Canonical Task v1 and initial Workstream, then stages a Task Bootstrap Scope for the next ordinary user turn. It never creates or injects a Resume.",
    inputSchema: {
      type: "object",
      properties: {
        bootstrap_id: { type: "string" },
        preview_version: { type: "integer", minimum: 1 },
        confirmed: { type: "boolean" },
        session_id: {
          type: "string",
          description: "Exact hook-attested session_id supplied by Mnemuron SessionStart context.",
        },
      },
      required: ["bootstrap_id", "preview_version", "confirmed", "session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_preview_task_bootstrap",
    description: "Create an immutable preview for a brand-new Canonical Task inside one existing Project. This does not create the Task, bind the session, create a Resume, or inject context. Similar existing Tasks fail closed with candidates.",
    inputSchema: {
      type: "object",
      properties: {
        project_query: {
          type: "string",
          description: "Existing Project name, alias, or exact Project ID.",
        },
        title: { type: "string", minLength: 1, maxLength: 200 },
        goal: { type: "string", minLength: 1, maxLength: 4096 },
        aliases: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
        workstream_name: { type: "string", minLength: 1, maxLength: 200 },
        session_id: {
          type: "string",
          description: "Exact hook-attested session_id supplied by Mnemuron SessionStart context.",
        },
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
      },
      required: ["project_query", "title", "goal", "session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_confirm_task_bootstrap",
    description: "Confirm or cancel one previously displayed Task Bootstrap Preview for the exact hook-attested session. Confirmation creates Canonical Task v1 and stages a local Task Scope that activates on the next ordinary user turn; it never creates or injects a Resume.",
    inputSchema: {
      type: "object",
      properties: {
        bootstrap_id: { type: "string" },
        preview_version: { type: "integer", minimum: 1 },
        confirmed: { type: "boolean" },
        session_id: {
          type: "string",
          description: "Exact hook-attested session_id supplied by Mnemuron SessionStart context.",
        },
      },
      required: ["bootstrap_id", "preview_version", "confirmed", "session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_confirm_resume",
    description: "Confirm or cancel a previously displayed Resume Preview for the exact hook-attested ChatGPT session. Confirmation stages delivery for the next ordinary user turn and never returns injectable Resume context.",
    inputSchema: {
      type: "object",
      properties: {
        resume_id: { type: "string" },
        preview_version: { type: "integer", minimum: 1 },
        confirmed: { type: "boolean" },
        session_id: {
          type: "string",
          description: "Exact hook-attested session_id supplied by Mnemuron SessionStart context.",
        },
      },
      required: ["resume_id", "preview_version", "confirmed", "session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_take_pending_resume",
    description: "Deliver one session-scoped pending Resume through an MCP tool result only after central server records a delivery receipt. Call exactly once at the beginning of each ordinary user turn using the exact hook-attested session_id.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Exact hook-attested session_id supplied by Mnemuron SessionStart context.",
        },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_remember",
    description: "Explicitly save an important Mnemuron fact, decision, constraint, or next step. Reuse operation_id and the same payload when retrying an uncertain remote save; separate saves use separate keys.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1 },
        scope: {
          type: "string",
          enum: ["user", "project", "task", "workstream", "session"],
        },
        task_id: { type: "string" },
        project_id: { type: "string" },
        workstream_id: { type: "string" },
        session_id: { type: "string" },
        memory_type: {
          type: "string",
          enum: ["goal", "fact", "constraint", "decision", "completed", "blocker", "remaining", "next_step"],
        },
        topic: { type: "string", minLength: 1, maxLength: 120 },
        operation_id: { type: "string", minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]*$" },
      },
      required: ["content", "scope"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_search_memories",
    description: "Read-only bounded search over Structured Memory with deterministic ranking, lifecycle state, provenance, and topic-keyed cross-Workstream conflict presentation.",
    inputSchema: {
      type: "object",
      properties: {
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
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_supersede_memory",
    description: "Use only for an explicit user correction. Preserve the exact old Memory as superseded and create one provenance-linked replacement; never overwrite Canonical Task state.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string" },
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
      },
      required: ["memory_id", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_retract_memory",
    description: "Use only for an explicit user retraction. Keep a tombstone and full provenance instead of physically deleting the Memory.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: { type: "string" },
        reason: { type: "string", minLength: 1, maxLength: 1000 },
      },
      required: ["memory_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_reconciliation_status",
    description: "Show the canonical Task version, pending reconciliation proposals, conflicts, and latest applied revision for one Task.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_preview_reconciliation",
    description: "Create or reuse a source-backed Canonical Task reconciliation proposal. Safe additive progress may apply automatically; material changes remain pending confirmation.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        source_checkpoint_ids: {
          type: "array",
          maxItems: 50,
          items: { type: "string" },
        },
        derive_checkpoint_operations: {
          type: "boolean",
          description: "Set false only with explicit operations and source_checkpoint_ids to create a curated evidence-backed proposal without importing rule-derived checkpoint operations.",
        },
        operations: {
          type: "array",
          maxItems: 50,
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: [
                  "append_unique",
                  "remove_exact",
                  "replace_scalar",
                  "replace_workstream_status",
                  "record_conflict",
                ],
              },
              field: { type: "string" },
              value: {},
              workstream_id: { type: "string" },
            },
            required: ["op", "field", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "mnemuron_confirm_reconciliation",
    description: "Confirm or reject an exact displayed Canonical Task reconciliation proposal and base version. This does not confirm or deliver a Resume.",
    inputSchema: {
      type: "object",
      properties: {
        proposal_id: { type: "string" },
        proposal_version: { type: "integer", minimum: 1 },
        base_canonical_version: { type: "integer", minimum: 1 },
        confirmed: { type: "boolean" },
      },
      required: [
        "proposal_id",
        "proposal_version",
        "base_canonical_version",
        "confirmed",
      ],
      additionalProperties: false,
    },
  },
];

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

function memoryScope(args, activeScope = {}, validateRequired = true) {
  if (!validateRequired && [args.project_id, args.task_id, args.workstream_id].some(value => value !== undefined && value !== null)) {
    activeScope = {};
  }
  const resolved = {
    project_id: args.project_id ?? activeScope.project_id ?? null,
    task_id: args.task_id ?? activeScope.task_id ?? null,
    workstream_id: args.workstream_id ?? activeScope.workstream_id ?? null,
    session_id: args.session_id ?? null,
  };
  const requiredField = {
    project: "project_id",
    task: "task_id",
    workstream: "workstream_id",
    session: "session_id",
  }[args.scope];
  if (validateRequired && requiredField && !resolved[requiredField]) {
    throw new Error(
      `${requiredField} is required for ${args.scope}-scoped memory when no confirmed Task Scope is active.`,
    );
  }
  return resolved;
}

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const LOCAL_RESOLVER_VERSION = "combination-resolver-v0.1";
const LOCAL_NOISE = new Set([
  "a", "an", "continue", "last", "previous", "project", "resume", "task", "the", "work",
  "上一个", "上次", "任务", "继续", "那个", "项目",
]);

function resolverTokens(value) {
  return normalize(value).split(" ").filter(Boolean);
}

function localTaskTokens(task, query) {
  const projectTokens = new Set(resolverTokens(task.project_name));
  return resolverTokens(query)
    .filter((token) => !LOCAL_NOISE.has(token) && !projectTokens.has(token));
}

function localField(task, value) {
  const projectTokens = new Set(resolverTokens(task.project_name));
  return resolverTokens(value).filter((token) => !projectTokens.has(token)).join(" ");
}

function tokenOverlap(queryTokens, values) {
  if (!queryTokens.length) return 0;
  const fields = new Set(values.flatMap(resolverTokens));
  return queryTokens.filter((token) => fields.has(token)).length / queryTokens.length;
}

function explicitTaskIds(query) {
  return [...String(query ?? "").matchAll(/\btask-[a-zA-Z0-9][a-zA-Z0-9_-]*\b/giu)]
    .map((match) => match[0].toLowerCase());
}

function localTaskCandidate(task, query) {
  const queryTokens = localTaskTokens(task, query);
  const queryText = queryTokens.join(" ");
  const titleFields = [task.title, ...(task.aliases || [])]
    .map((value) => localField(task, value))
    .filter(Boolean);
  const reasons = [];
  let score = 0;
  let strong = false;
  if (queryText && titleFields.includes(queryText)) {
    score += 0.85;
    reasons.push({ signal: "task_title_exact", weight: 0.85, detail: "task title or alias" });
    strong = true;
  } else if (queryText && titleFields.some((field) => field.includes(queryText)
    || ((resolverTokens(field).length >= 2 || /\p{Script=Han}{2,}/u.test(field))
      && queryText.includes(field)))) {
    score += 0.7;
    reasons.push({ signal: "task_title_phrase", weight: 0.7, detail: "task title or alias phrase" });
    strong = true;
  } else {
    const overlap = tokenOverlap(queryTokens, titleFields) * 0.55;
    if (overlap) {
      score += overlap;
      reasons.push({ signal: "task_title_tokens", weight: Number(overlap.toFixed(4)), detail: "task token overlap" });
    }
  }
  const content = [
    task.goal,
    ...(task.progress || []),
    ...(task.decisions || []),
    ...(task.blockers || []),
    ...(task.next_steps || []),
  ].map((value) => typeof value === "string" ? value : JSON.stringify(value));
  const contentOverlap = tokenOverlap(queryTokens, content) * 0.25;
  if (contentOverlap) {
    score += contentOverlap;
    reasons.push({ signal: "task_content_tokens", weight: Number(contentOverlap.toFixed(4)), detail: "goal or task-history token overlap" });
  }
  const workstreams = (task.workstreams || []).flatMap((workstream) => [
    workstream.workstream_id,
    workstream.name,
  ]).filter(Boolean);
  const workstreamOverlap = tokenOverlap(queryTokens, workstreams) * 0.45;
  if (workstreamOverlap) {
    score += workstreamOverlap;
    reasons.push({ signal: "workstream_tokens", weight: Number(workstreamOverlap.toFixed(4)), detail: "workstream token overlap" });
  }
  if (score && task.status === "active") {
    score += 0.03;
    reasons.push({ signal: "active_status_tiebreak", weight: 0.03, detail: "active Task tie-break only" });
  }
  return {
    task,
    score: Number(Math.min(1, score).toFixed(4)),
    strong,
    reasons,
  };
}

function publicLocalCandidate(candidate) {
  return {
    task_id: candidate.task.task_id,
    title: candidate.task.title,
    project_id: candidate.task.project_id,
    project_name: candidate.task.project_name,
    task_status: candidate.task.status,
    conflict_count: (candidate.task.conflicts || []).length,
    conflicts: candidate.task.conflicts || [],
    score: candidate.score,
    reasons: candidate.reasons,
  };
}

function resolveLocalTasks(tasks, query, signals = {}) {
  const scoped = signals.project_id
    ? tasks.filter((task) => task.project_id === signals.project_id)
    : tasks;
  if (signals.project_id && !scoped.length) {
    return { status: "no_match", reason: "explicit_project_identifier_not_found", candidates: [] };
  }
  const requestedIds = signals.task_id ? [signals.task_id] : explicitTaskIds(query);
  if (requestedIds.length) {
    const exact = scoped.filter((task) => requestedIds.includes(task.task_id));
    if (!exact.length) {
      return { status: "no_match", reason: "explicit_identifier_not_found", candidates: [] };
    }
    const candidates = exact.map((task) => publicLocalCandidate({
      task,
      score: 1,
      strong: true,
      reasons: [{ signal: "task_id_exact", weight: 1, detail: "explicit task_id" }],
    }));
    return { status: "resolved", candidates, match: candidates[0], selection_required: false };
  }
  const projectMentioned = scoped.some((task) => {
    const project = normalize(task.project_name);
    const normalizedQuery = normalize(query);
    return project && (project === normalizedQuery || normalizedQuery.includes(project));
  });
  if ((signals.project_id || projectMentioned)
      && scoped.every((task) => localTaskTokens(task, query).length === 0)) {
    return {
      status: "ambiguous",
      reason: "project_scope_has_no_task_signal",
      selection_required: true,
      candidates: scoped.slice(0, 10).map((task) => publicLocalCandidate({
        task,
        score: 0,
        strong: false,
        reasons: [{ signal: "project_scope_only", weight: 0, detail: "explicit task selection required" }],
      })),
    };
  }
  const scored = scoped.map((task) => localTaskCandidate(task, query))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.task.task_id.localeCompare(right.task.task_id));
  if (!scored.length) return { status: "no_match", candidates: [], selection_required: true };
  const [top, second] = scored;
  const margin = second ? Number((top.score - second.score).toFixed(4)) : top.score;
  const candidates = scored.slice(0, 10).map(publicLocalCandidate);
  if ((top.strong || top.score >= 0.7) && (!second || margin >= 0.15)) {
    return { status: "resolved", candidates, match: candidates[0], selection_required: false, margin };
  }
  return {
    status: "ambiguous",
    reason: top.score >= 0.7 ? "candidate_margin_too_small" : "candidate_confidence_too_low",
    candidates,
    selection_required: true,
    margin,
  };
}

function resolveLocalProjects(tasks, query, signals = {}) {
  const projects = [...new Map(tasks.map((task) => [task.project_id, {
    project_id: task.project_id,
    name: task.project_name,
  }])).values()];
  const explicitId = signals.project_id
    || [...String(query).matchAll(/\bproject-[a-zA-Z0-9][a-zA-Z0-9_-]*\b/giu)][0]?.[0]
    || null;
  if (explicitId) {
    const project = projects.find((candidate) => candidate.project_id === explicitId);
    if (!project) return { status: "no_match", reason: "explicit_identifier_not_found", candidates: [] };
    return {
      status: "resolved",
      selection_required: false,
      match: { ...project, score: 1, reasons: [{ signal: "project_id_exact", weight: 1 }] },
      candidates: [{ ...project, score: 1, reasons: [{ signal: "project_id_exact", weight: 1 }] }],
    };
  }
  const queryText = normalize(query);
  const candidates = projects.map((project) => {
    const projectName = normalize(project.name);
    const exact = queryText === projectName;
    const phrase = projectName && queryText.includes(projectName);
    return {
      ...project,
      score: exact ? 0.8 : phrase ? 0.6 : 0,
      reasons: exact
        ? [{ signal: "project_name_exact", weight: 0.8 }]
        : phrase ? [{ signal: "project_name_phrase", weight: 0.6 }] : [],
    };
  }).filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);
  if (candidates.length === 1 && candidates[0].score >= 0.75) {
    return { status: "resolved", selection_required: false, match: candidates[0], candidates };
  }
  return {
    status: candidates.length ? "ambiguous" : "no_match",
    selection_required: true,
    reason: candidates.length ? "candidate_confidence_too_low" : "no_candidate_reached_minimum_signal",
    candidates,
  };
}

function buildLocalProjectContext(tasks, memories, events, query, signals = {}) {
  const resolution = {
    ...resolveLocalProjects(tasks, query, signals),
    resolver_version: LOCAL_RESOLVER_VERSION,
    query,
  };
  if (resolution.status !== "resolved") return resolution;
  const projectTasks = tasks.filter((task) => task.project_id === resolution.match.project_id);
  const projectTaskIds = new Set(projectTasks.map((task) => task.task_id));
  const projectMemories = memories.filter((memory) =>
    memory.project_id === resolution.match.project_id
    || (memory.task_id && projectTaskIds.has(memory.task_id)));
  const projectEvents = events.filter((event) =>
    event.project_id === resolution.match.project_id
    || (event.task_id && projectTaskIds.has(event.task_id)));
  return {
    schema_version: "project-memory-preview-v0.1",
    status: "project_context_preview",
    read_only: true,
    created_at: new Date().toISOString(),
    query,
    resolver_request: { query, signals },
    resolution,
    project: {
      project_id: resolution.match.project_id,
      name: resolution.match.name,
    },
    tasks: projectTasks.slice(0, 10).map((task) => ({
      task_id: task.task_id,
      project_id: task.project_id,
      project_name: task.project_name,
      title: task.title,
      aliases: (task.aliases || []).slice(0, 5),
      goal: String(task.goal || "").slice(0, 600),
      status: task.status,
      progress: (task.progress || []).slice(0, 4),
      decisions: (task.decisions || []).slice(0, 4),
      blockers: (task.blockers || []).slice(0, 4),
      next_steps: (task.next_steps || []).slice(0, 4),
      resources: (task.resources || []).slice(0, 4),
      workstreams: (task.workstreams || []).slice(0, 10),
      conflicts: (task.conflicts || []).slice(0, 5),
      canonical_freshness: "local_fixture_unversioned",
      latest_checkpoints: [],
    })),
    structured_memories: projectMemories.slice(-10).reverse(),
    recent_activity: projectEvents.slice(-20).reverse(),
    source_summary: {
      task_count: projectTasks.length,
      active_task_count: projectTasks.filter((task) => task.status === "active").length,
      structured_memory_count: projectMemories.length,
      latest_checkpoint_count: 0,
      recent_activity_count: projectEvents.length,
      fixture_data: true,
    },
    projection: {
      response_budget_bytes: 128 * 1024,
      task_limit: 10,
      memory_limit: 10,
      activity_limit: 20,
      tasks_truncated: projectTasks.length > 10,
      raw_payload_included: false,
      fixture_data: true,
    },
    safety: {
      resume_created: false,
      task_scope_changed: false,
      context_injected: false,
      task_selection_required_before_resume: projectTasks.length !== 1,
    },
    next_action: projectTasks.length
      ? { type: "select_task_for_resume_preview", task_ids: projectTasks.map((task) => task.task_id) }
      : { type: "no_task_in_project", task_ids: [] },
  };
}

function buildLocalTaskBranches(tasks, query, signals = {}) {
  const resolution = {
    ...resolveLocalTasks(tasks, query, signals),
    resolver_version: LOCAL_RESOLVER_VERSION,
    query,
  };
  if (resolution.status !== "resolved") return resolution;
  const task = tasks.find((candidate) => candidate.task_id === resolution.match.task_id);
  const branches = (task.workstreams || []).slice(0, 20).map((workstream) => ({
    workstream_id: typeof workstream === "string" ? workstream : workstream.workstream_id,
    name: typeof workstream === "string" ? workstream : workstream.name,
    status: typeof workstream === "string" ? "declared" : workstream.status,
    canonical_declared: true,
    canonical: workstream,
    latest_checkpoint: null,
    latest_activity_at: null,
    sampled_event_count: 0,
    recent_sessions: [],
    source_identities: [],
  }));
  const conflicts = (task.conflicts || []).slice(0, 20);
  return {
    schema_version: "task-branches-preview-v0.1",
    status: "task_branches_preview",
    read_only: true,
    created_at: new Date().toISOString(),
    query,
    resolver_request: { query, signals },
    resolution,
    project: { project_id: task.project_id, name: task.project_name },
    task: {
      task_id: task.task_id,
      title: task.title,
      goal: String(task.goal || "").slice(0, 600),
      status: task.status,
      canonical_version: task.canonical_version || 1,
      canonical_freshness: "local_fixture_unversioned",
    },
    branches,
    conflicts,
    conflict_summary: {
      count: (task.conflicts || []).length,
      included_count: conflicts.length,
      source_preserved: true,
      automatic_merge_performed: false,
    },
    source_summary: {
      canonical_workstream_count: (task.workstreams || []).length,
      observed_workstream_count: branches.length,
      included_branch_count: branches.length,
      latest_checkpoint_count: 0,
      sampled_event_count: 0,
      fixture_data: true,
    },
    projection: {
      response_budget_bytes: 128 * 1024,
      branch_limit: 20,
      raw_payload_included: false,
      fixture_data: true,
    },
    safety: {
      resume_created: false,
      resolver_selection_recorded: false,
      task_scope_changed: false,
      context_injected: false,
      canonical_task_changed: false,
      automatic_merge_performed: false,
    },
    next_action: {
      type: conflicts.length ? "review_conflicts_before_resume" : "create_resume_preview_later",
      task_id: task.task_id,
    },
  };
}

function buildPreview(task, query, events, resolution, signals = {}, sourceWorkstreamIds = null) {
  const createdAt = new Date();
  const availableWorkstreamIds = [...new Set(
    (task.workstreams || []).map((workstream) => workstream.workstream_id).filter(Boolean),
  )].sort();
  const requestedWorkstreamIds = sourceWorkstreamIds === null
    ? null
    : [...new Set(sourceWorkstreamIds.map((value) => value.trim()))];
  if (requestedWorkstreamIds?.some((workstreamId) =>
    !availableWorkstreamIds.includes(workstreamId))) {
    throw new Error("Unknown source Workstream.");
  }
  const selectedWorkstreamIds = requestedWorkstreamIds || availableWorkstreamIds;
  const selectedSet = new Set(selectedWorkstreamIds);
  const selectedWorkstreams = (task.workstreams || [])
    .filter((workstream) => selectedSet.has(workstream.workstream_id));
  const selectedEvents = requestedWorkstreamIds
    ? events.filter((event) => selectedSet.has(event.workstream_id))
    : events;
  return {
    resume_id: randomUUID(),
    preview_version: 1,
    status: "pending_confirmation",
    requires_confirmation: true,
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + 10 * 60_000).toISOString(),
    query,
    resolver_request: { query, signals },
    resolution: {
      ...resolution,
      resolver_version: LOCAL_RESOLVER_VERSION,
      query,
    },
    match: {
      score: resolution.match.score,
      reason: "versioned local-safe combination Resolver",
      resolver_version: LOCAL_RESOLVER_VERSION,
      reasons: resolution.match.reasons,
    },
    project: {
      project_id: task.project_id,
      name: task.project_name,
    },
    task: {
      task_id: task.task_id,
      title: task.title,
      goal: task.goal,
      status: task.status,
    },
    progress: task.progress,
    decisions: task.decisions,
    blockers: task.blockers,
    next_steps: task.next_steps,
    resources: task.resources,
    workstreams: selectedWorkstreams,
    branch_selection: {
      schema_version: "resume-branch-selection-v0.1",
      explicit: Boolean(requestedWorkstreamIds),
      mode: requestedWorkstreamIds
        ? requestedWorkstreamIds.length === 1 ? "single" : "combined_view"
        : "all",
      selected_workstream_ids: selectedWorkstreamIds,
      available_workstream_ids: availableWorkstreamIds,
      source_preserved: true,
      automatic_merge_performed: false,
    },
    conflicts: task.conflicts,
    conflict_summary: {
      count: (task.conflicts || []).length,
      source_preserved: true,
      automatic_merge_performed: false,
    },
    source_summary: {
      captured_event_count: selectedEvents.length,
      fixture_task: true,
      identities: [...new Set(selectedEvents.map((event) =>
        `${event.provenance?.agent_instance_id || "unknown"}@${event.provenance?.device_id || "unknown"}`,
      ))],
    },
  };
}

function resumePacket(preview) {
  return {
    resume_id: preview.resume_id,
    preview_version: preview.preview_version,
    project: preview.project,
    task: preview.task,
    selected_workstreams: preview.workstreams,
    branch_selection: preview.branch_selection,
    context: {
      goal: preview.task.goal,
      progress: preview.progress,
      decisions: preview.decisions,
      blockers: preview.blockers,
      next_steps: preview.next_steps,
      resources: preview.resources,
      conflicts: preview.conflicts,
    },
    provenance: preview.source_summary,
    injection_authorized_at: new Date().toISOString(),
  };
}

function requireSessionId(args) {
  if (typeof args.session_id !== "string" || !args.session_id.trim()) {
    throw new Error("session_id is required and must come from Mnemuron SessionStart context.");
  }
  return args.session_id;
}

function publicStagedDelivery(record) {
  if (!record) return null;
  return {
    resume_id: record.resume_id,
    preview_version: record.preview_version,
    receipt_id: record.receipt_id,
    target_session_id: record.target_session_id,
    workstream_id: record.workstream_id,
    status: record.status,
    armed: record.armed,
    injection_method: record.injection_method,
  };
}

function stageConfirmedPacket(dataDir, packet, sessionId, runtimeEnv) {
  requireCurrentMcpSessionAuthorization(dataDir, sessionId, runtimeEnv);
  const taskScope = stageTaskScopeForSession(
    dataDir,
    packet,
    sessionId,
    runtimeEnv,
  );
  const adapterInjection = queueResumeInjection(
    dataDir,
    packet,
    taskScope.target_session_id,
    taskScope.workstream_id,
    {
      injectionMethod: "codex-mcp-delivery-receipt",
      armed: false,
    },
  );
  return { taskScope, adapterInjection };
}

function centralDeliveryAcceptance(claimed, response) {
  const delivery = response?.delivery;
  const acceptedWrite = response?.inserted === 1 || response?.duplicate === 1;
  if (!acceptedWrite) return { accepted: false, reason: "receipt_write_not_confirmed" };
  if (delivery?.resume_id !== claimed.resume_id
      || delivery?.preview_version !== claimed.preview_version) {
    return { accepted: false, reason: "resume_identity_mismatch" };
  }
  if (delivery?.latest_receipt?.receipt_id !== claimed.receipt_id) {
    return { accepted: false, reason: "receipt_identity_mismatch" };
  }
  if (delivery.status !== "in_flight" || delivery.ack_complete !== false) {
    return { accepted: false, reason: "central_delivery_state_not_deliverable" };
  }
  return { accepted: true, reason: null };
}

function deliveryReconciliationResult(claimed, centralReceipt, reason) {
  return {
    status: "delivery_reconciliation_required",
    resume_id: claimed.resume_id,
    preview_version: claimed.preview_version,
    receipt_id: claimed.receipt_id,
    resume_packet_returned: false,
    retryable: false,
    reconciliation_required: true,
    reconciliation: {
      reason,
      central_status: centralReceipt?.delivery?.status || null,
      central_ack_complete: centralReceipt?.delivery?.ack_complete ?? null,
      central_receipt_id: centralReceipt?.delivery?.latest_receipt?.receipt_id || null,
    },
    compatibility_mode: RESUME_INJECTION_MODE,
  };
}

async function takePendingResume(args, runtimeEnv) {
  const sessionId = requireSessionId(args);
  const dataDir = resolveDataDir(runtimeEnv);
  requireCurrentMcpSessionAuthorization(dataDir, sessionId, runtimeEnv);
  const deliveryLock = acquireMcpResumeDeliveryLock(dataDir, sessionId);
  if (!deliveryLock) {
    return {
      status: "delivery_in_progress",
      resume_packet_returned: false,
      retryable: true,
      compatibility_mode: RESUME_INJECTION_MODE,
    };
  }
  try {
    const claimed = claimMcpResumeDelivery(dataDir, sessionId);
    if (!claimed) {
      return {
        status: "no_pending_resume",
        resume_packet_returned: false,
        compatibility_mode: RESUME_INJECTION_MODE,
      };
    }
    if (claimed.context_returned_at) {
      return {
        status: "already_delivered_this_turn",
        resume_id: claimed.resume_id,
        preview_version: claimed.preview_version,
        receipt_id: claimed.receipt_id,
        resume_packet_returned: false,
        compatibility_mode: RESUME_INJECTION_MODE,
      };
    }
    const receipt = deliveryReceiptPayload(claimed, "delivered", {
      occurredAt: claimed.delivery_declared_at,
    });
    let centralReceipt = null;
    if (runtimeMode(runtimeEnv) === "remote") {
      try {
        centralReceipt = await submitDeliveryReceipt(claimed.resume_id, receipt, runtimeEnv);
      } catch (error) {
        return {
          status: "delivery_deferred",
          resume_id: claimed.resume_id,
          preview_version: claimed.preview_version,
          receipt_id: claimed.receipt_id,
          resume_packet_returned: false,
          retryable: true,
          error: error.message,
          compatibility_mode: RESUME_INJECTION_MODE,
        };
      }
      const acceptance = centralDeliveryAcceptance(claimed, centralReceipt);
      if (!acceptance.accepted) {
        return deliveryReconciliationResult(
          claimed,
          centralReceipt,
          acceptance.reason,
        );
      }
    }
    if (!ownsMcpResumeDeliveryLock(deliveryLock)) {
      return {
        status: "delivery_in_progress",
        resume_id: claimed.resume_id,
        preview_version: claimed.preview_version,
        receipt_id: claimed.receipt_id,
        resume_packet_returned: false,
        retryable: true,
        compatibility_mode: RESUME_INJECTION_MODE,
      };
    }
    const taskScope = activateTaskScopeForResume(
      dataDir,
      sessionId,
      claimed.resume_id,
      claimed.preview_version,
      runtimeEnv,
    );
    if (!taskScope) {
      throw new Error(
        "Mnemuron accepted the Delivery Receipt but no matching pending Task Scope exists.",
      );
    }
    const delivered = markMcpResumeContextReturned(dataDir, claimed.receipt_id);
    if (!delivered) throw new Error("Mnemuron could not finalize the local MCP delivery receipt.");
    return {
      status: "delivered",
      resume_id: delivered.resume_id,
      preview_version: delivered.preview_version,
      receipt_id: delivered.receipt_id,
      resume_packet_returned: true,
      resume_context: delivered.text,
      task_scope: taskScope,
      delivery_receipt: centralReceipt?.delivery || {
        protocol: RESUME_INJECTION_MODE,
        status: "in_flight",
        ack_complete: false,
      },
      compatibility_mode: RESUME_INJECTION_MODE,
    };
  } finally {
    releaseMcpResumeDeliveryLock(deliveryLock);
  }
}

export async function callTool(name, args = {}, env = process.env) {
  const runtimeEnv = loadRuntimeEnv(env);
  if (name === "mnemuron_take_pending_resume") {
    return takePendingResume(args, runtimeEnv);
  }
  if (runtimeMode(runtimeEnv) === "remote") {
    return callRemoteTool(name, args, runtimeEnv);
  }
  if ([
    "mnemuron_preview_project_bootstrap",
    "mnemuron_confirm_project_bootstrap",
    "mnemuron_preview_task_bootstrap",
    "mnemuron_confirm_task_bootstrap",
    "mnemuron_search_memories",
    "mnemuron_supersede_memory",
    "mnemuron_retract_memory",
    "mnemuron_reconciliation_status",
    "mnemuron_preview_reconciliation",
    "mnemuron_confirm_reconciliation",
  ].includes(name)) {
    throw new Error("This operation requires Mnemuron remote mode.");
  }
  const dataDir = resolveDataDir(runtimeEnv);
  const events = readJsonLines(dataDir, "events.jsonl");
  const memories = readJsonLines(dataDir, "memories.jsonl");
  const tasks = readTasks(dataDir);

  if (name === "mnemuron_status") {
    return {
      mode: "local-spike",
      plugin_version: PLUGIN_VERSION,
      resume_injection_mode: RESUME_INJECTION_MODE,
      production_ready: false,
      identity: identity(runtimeEnv),
      resolver: {
        schema_version: LOCAL_RESOLVER_VERSION,
        local_safe_subset: true,
        project_path_is_sufficient_alone: false,
        ambiguous_preview_created: false,
        source_conflicts_auto_merged: false,
      },
      counts: {
        events: events.length,
        memories: memories.length,
        tasks: tasks.length,
        previews: listPreviews(dataDir).length,
      },
      task_scope_bindings: taskScopeCounts(dataDir),
      pending_resume_injections: pendingResumeCounts(dataDir),
      tasks: tasks.map(({ task_id, project_name, title, status }) => ({
        task_id,
        project_name,
        title,
        status,
      })),
    };
  }

  if (name === "mnemuron_preview_resume") {
    if (typeof args.query !== "string" || !args.query.trim()) {
      throw new Error("query is required.");
    }
    if (args.signals !== undefined
        && (!args.signals || typeof args.signals !== "object" || Array.isArray(args.signals))) {
      throw new Error("signals must be an object.");
    }
    if (args.source_workstream_ids !== undefined
        && (!Array.isArray(args.source_workstream_ids)
          || args.source_workstream_ids.length < 1
          || args.source_workstream_ids.length > 20
          || args.source_workstream_ids.some((value) =>
            typeof value !== "string" || !value.trim()))) {
      throw new Error("source_workstream_ids must be a non-empty array of Workstream IDs.");
    }
    const signals = args.signals || {};
    const resolution = {
      ...resolveLocalTasks(tasks, args.query, signals),
      resolver_version: LOCAL_RESOLVER_VERSION,
      query: args.query,
    };
    if (resolution.status !== "resolved") return resolution;
    const task = tasks.find((candidate) => candidate.task_id === resolution.match.task_id);
    const preview = buildPreview(
      task,
      args.query,
      events,
      resolution,
      signals,
      args.source_workstream_ids || null,
    );
    writePreview(dataDir, preview);
    appendPreviewIndex(dataDir, preview);
    return preview;
  }

  if (name === "mnemuron_preview_project_context") {
    if (typeof args.query !== "string" || !args.query.trim()) {
      throw new Error("query is required.");
    }
    if (args.signals !== undefined
        && (!args.signals || typeof args.signals !== "object" || Array.isArray(args.signals))) {
      throw new Error("signals must be an object.");
    }
    return buildLocalProjectContext(tasks, memories, events, args.query, args.signals || {});
  }

  if (name === "mnemuron_preview_task_branches") {
    if (typeof args.query !== "string" || !args.query.trim()) {
      throw new Error("query is required.");
    }
    if (args.signals !== undefined
        && (!args.signals || typeof args.signals !== "object" || Array.isArray(args.signals))) {
      throw new Error("signals must be an object.");
    }
    return buildLocalTaskBranches(tasks, args.query, args.signals || {});
  }

  if (name === "mnemuron_confirm_resume") {
    if (
      typeof args.resume_id !== "string" ||
      !Number.isInteger(args.preview_version) ||
      typeof args.confirmed !== "boolean"
    ) {
      throw new Error("resume_id, preview_version, and confirmed are required.");
    }
    const sessionId = requireSessionId(args);
    requireCurrentMcpSessionAuthorization(dataDir, sessionId, runtimeEnv);
    const preview = readPreview(dataDir, args.resume_id);
    if (!preview) {
      throw new Error("Resume Preview not found.");
    }
    if (preview.preview_version !== args.preview_version) {
      throw new Error("Resume Preview version changed; create and show a fresh preview.");
    }
    if (preview.status === "confirmed" && args.confirmed) {
      const { taskScope, adapterInjection } = stageConfirmedPacket(
        dataDir,
        preview.resume_packet,
        sessionId,
        runtimeEnv,
      );
      return {
        status: "confirmed",
        resume_id: preview.resume_id,
        preview_version: preview.preview_version,
        resume_packet_returned: false,
        task_scope: taskScope,
        adapter_injection: publicStagedDelivery(adapterInjection),
      };
    }
    if (preview.status !== "pending_confirmation") {
      throw new Error(`Resume Preview is already ${preview.status}.`);
    }
    if (Date.parse(preview.expires_at) <= Date.now()) {
      throw new Error("Resume Preview expired; create and show a fresh preview.");
    }
    if (!args.confirmed) {
      const cancelled = {
        ...preview,
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
      };
      writePreview(dataDir, cancelled);
      return { status: "cancelled", resume_id: preview.resume_id };
    }
    const packet = resumePacket(preview);
    const confirmed = {
      ...preview,
      status: "confirmed",
      confirmed_at: packet.injection_authorized_at,
      resume_packet: packet,
    };
    writePreview(dataDir, confirmed);
    const { taskScope, adapterInjection } = stageConfirmedPacket(
      dataDir,
      packet,
      sessionId,
      runtimeEnv,
    );
    return {
      status: "confirmed",
      resume_id: packet.resume_id,
      preview_version: packet.preview_version,
      resume_packet_returned: false,
      task_scope: taskScope,
      adapter_injection: publicStagedDelivery(adapterInjection),
    };
  }

  if (name === "mnemuron_remember") {
    if (args.operation_id !== undefined) {
      throw new Error("operation_id requires remote mode; local-spike does not provide atomic retry deduplication.");
    }
    if (typeof args.content !== "string" || !args.content.trim()) {
      throw new Error("content is required.");
    }
    const allowedScopes = new Set(["user", "project", "task", "workstream", "session"]);
    if (!allowedScopes.has(args.scope)) {
      throw new Error("scope must be user, project, task, workstream, or session.");
    }
    const activeScope = resolveTaskScope(dataDir, runtimeEnv.CODEX_THREAD_ID, runtimeEnv) || {};
    const resolvedScope = memoryScope(args, activeScope);
    const memory = {
      memory_id: randomUUID(),
      content: args.content.trim(),
      scope: args.scope,
      ...resolvedScope,
      created_at: new Date().toISOString(),
      provenance: identity(runtimeEnv),
      source: "explicit",
      memory_type: args.memory_type || "fact",
      topic: args.topic || null,
    };
    appendJsonLine(dataDir, "memories.jsonl", memory);
    return { status: "saved", memory };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function callRemoteTool(name, args, runtimeEnv) {
  if (name === "mnemuron_status") {
    const dataDir = resolveDataDir(runtimeEnv);
    const sync = {status:'not_run_read_only'}, injectionEventSync = sync, deliveryReceiptSync = sync;
    const syncState = localSyncSummary(runtimeEnv);
    const queued = listOutbox(dataDir).length;
    const quarantined = listOutboxQuarantine(dataDir).length;
    const queuedInjectionEvents = listInjectionEventOutbox(dataDir).length;
    const queuedDeliveryReceipts = listDeliveryReceiptOutbox(dataDir).length;
    const taskScopes = taskScopeCounts(dataDir);
    const pendingInjections = pendingResumeCounts(dataDir);
    let status;
    try {
      status = await remoteRequest(runtimeEnv, "GET", "/v1/status");
    } catch (error) {
      return {
        mode: "remote-v0.1",
        production_ready: false,
        cross_device_ready: false,
        server_reachable: false,
        identity: identity(runtimeEnv),
        adapter: {
          mode: "remote",
          plugin_version: PLUGIN_VERSION,
          resume_injection_mode: RESUME_INJECTION_MODE,
          local_identity: identity(runtimeEnv),
          server_url: runtimeEnv.MNEMURON_SERVER_URL,
          queued_events: queued,
          quarantined_events: quarantined,
          queued_injection_events: queuedInjectionEvents,
          queued_delivery_receipts: queuedDeliveryReceipts,
          sync_status: "unavailable",
          injection_event_sync_status: queuedInjectionEvents ? "pending" : "unavailable",
          delivery_receipt_sync_status: queuedDeliveryReceipts ? "pending" : "unavailable",
          error: error.message,
          last_flush: sync,
          sync_state: syncState,
          last_injection_event_flush: injectionEventSync,
          last_delivery_receipt_flush: deliveryReceiptSync,
          task_scope_bindings: taskScopes,
          pending_resume_injections: pendingInjections,
        },
      };
    }
    return {
      ...status,
      server_reachable: true,
      adapter: {
        mode: "remote",
        plugin_version: PLUGIN_VERSION,
        resume_injection_mode: RESUME_INJECTION_MODE,
        local_identity: identity(runtimeEnv),
        server_url: runtimeEnv.MNEMURON_SERVER_URL,
        queued_events: queued,
        quarantined_events: quarantined,
        queued_injection_events: queuedInjectionEvents,
        queued_delivery_receipts: queuedDeliveryReceipts,
        sync_status: queued || queuedInjectionEvents || queuedDeliveryReceipts
          ? "pending"
          : quarantined
            ? "degraded"
            : sync.error || injectionEventSync.error || deliveryReceiptSync.error
              ? "unavailable"
              : "synchronized",
        injection_event_sync_status: queuedInjectionEvents
          ? "pending"
          : injectionEventSync.error
            ? "unavailable"
            : "synchronized",
        delivery_receipt_sync_status: queuedDeliveryReceipts
          ? "pending"
          : deliveryReceiptSync.error
            ? "unavailable"
            : "synchronized",
        last_flush: sync,
        sync_state: syncState,
        last_injection_event_flush: injectionEventSync,
        last_delivery_receipt_flush: deliveryReceiptSync,
        task_scope_bindings: taskScopes,
        pending_resume_injections: pendingInjections,
      },
    };
  }
  if (name === "mnemuron_preview_resume") {
    if (typeof args.query !== "string" || !args.query.trim()) {
      throw new Error("query is required.");
    }
    return remoteRequest(runtimeEnv, "POST", "/v1/resume/preview", {
      query: args.query,
      signals: args.signals || {},
      ...(args.source_workstream_ids === undefined
        ? {}
        : { source_workstream_ids: args.source_workstream_ids }),
    });
  }
  if (name === "mnemuron_preview_project_context") {
    if (typeof args.query !== "string" || !args.query.trim()) {
      throw new Error("query is required.");
    }
    return remoteRequest(runtimeEnv, "POST", "/v1/project-context/preview", {
      query: args.query,
      signals: args.signals || {},
    });
  }
  if (name === "mnemuron_preview_task_branches") {
    if (typeof args.query !== "string" || !args.query.trim()) {
      throw new Error("query is required.");
    }
    return remoteRequest(runtimeEnv, "POST", "/v1/task-branches/preview", {
      query: args.query,
      signals: args.signals || {},
    });
  }
  if (name === "mnemuron_preview_project_bootstrap") {
    if (typeof args.project_name !== "string" || !args.project_name.trim()
        || typeof args.task_title !== "string" || !args.task_title.trim()
        || typeof args.task_goal !== "string" || !args.task_goal.trim()) {
      throw new Error("project_name, task_title, and task_goal are required.");
    }
    const sessionId = requireSessionId(args);
    const dataDir = resolveDataDir(runtimeEnv);
    requireCurrentMcpSessionAuthorization(dataDir, sessionId, runtimeEnv);
    const workstreamId = runtimeEnv.MNEMURON_DEFAULT_WORKSTREAM_ID;
    if (typeof workstreamId !== "string" || !workstreamId.trim()) {
      throw new Error("MNEMURON_DEFAULT_WORKSTREAM_ID is required for Project Bootstrap.");
    }
    return remoteRequest(runtimeEnv, "POST", "/v1/project-bootstrap/preview", {
      project_name: args.project_name,
      project_aliases: args.project_aliases || [],
      git_remotes: args.git_remotes || [],
      repo_fingerprints: args.repo_fingerprints || [],
      path_hints: args.path_hints || [],
      task_title: args.task_title,
      task_goal: args.task_goal,
      task_aliases: args.task_aliases || [],
      workstream_id: workstreamId,
      workstream_name: `${runtimeEnv.MNEMURON_DEVICE_ID || os.hostname()} ${runtimeEnv.MNEMURON_AGENT_ID || "chatgpt"}`,
      session_id: sessionId,
    });
  }
  if (name === "mnemuron_confirm_project_bootstrap") {
    if (typeof args.bootstrap_id !== "string" || !args.bootstrap_id.trim()
        || !Number.isInteger(args.preview_version)
        || typeof args.confirmed !== "boolean") {
      throw new Error("bootstrap_id, preview_version, and confirmed are required.");
    }
    const sessionId = requireSessionId(args);
    const dataDir = resolveDataDir(runtimeEnv);
    requireCurrentMcpSessionAuthorization(dataDir, sessionId, runtimeEnv);
    const result = await remoteRequest(
      runtimeEnv,
      "POST",
      `/v1/project-bootstrap/${encodeURIComponent(args.bootstrap_id)}/confirm`,
      {
        preview_version: args.preview_version,
        confirmed: args.confirmed,
        session_id: sessionId,
      },
    );
    if (!args.confirmed || !result.binding_packet) return result;
    const taskScope = stageTaskScopeForSession(
      dataDir,
      result.binding_packet,
      sessionId,
      runtimeEnv,
    );
    return {
      status: "confirmed",
      bootstrap_id: result.binding_packet.bootstrap_id,
      preview_version: result.binding_packet.preview_version,
      idempotent: result.idempotent === true,
      binding_packet_returned: false,
      project: result.binding_packet.project,
      task: result.binding_packet.task,
      task_scope: taskScope,
      safety: {
        resume_created: false,
        resume_packet_returned: false,
        context_injected: false,
        historical_events_rebound: false,
      },
    };
  }
  if (name === "mnemuron_preview_task_bootstrap") {
    if (typeof args.project_query !== "string" || !args.project_query.trim()
        || typeof args.title !== "string" || !args.title.trim()
        || typeof args.goal !== "string" || !args.goal.trim()) {
      throw new Error("project_query, title, and goal are required.");
    }
    const sessionId = requireSessionId(args);
    const dataDir = resolveDataDir(runtimeEnv);
    requireCurrentMcpSessionAuthorization(dataDir, sessionId, runtimeEnv);
    const workstreamId = runtimeEnv.MNEMURON_DEFAULT_WORKSTREAM_ID;
    if (typeof workstreamId !== "string" || !workstreamId.trim()) {
      throw new Error("MNEMURON_DEFAULT_WORKSTREAM_ID is required for Task Bootstrap.");
    }
    return remoteRequest(runtimeEnv, "POST", "/v1/task-bootstrap/preview", {
      project_query: args.project_query,
      title: args.title,
      goal: args.goal,
      aliases: args.aliases || [],
      workstream_id: workstreamId,
      workstream_name: args.workstream_name
        || `${runtimeEnv.MNEMURON_DEVICE_ID || os.hostname()} ${runtimeEnv.MNEMURON_AGENT_ID || "chatgpt"}`,
      session_id: sessionId,
      signals: args.signals || {},
    });
  }
  if (name === "mnemuron_confirm_task_bootstrap") {
    if (typeof args.bootstrap_id !== "string" || !args.bootstrap_id.trim()
        || !Number.isInteger(args.preview_version)
        || typeof args.confirmed !== "boolean") {
      throw new Error("bootstrap_id, preview_version, and confirmed are required.");
    }
    const sessionId = requireSessionId(args);
    const dataDir = resolveDataDir(runtimeEnv);
    requireCurrentMcpSessionAuthorization(dataDir, sessionId, runtimeEnv);
    const result = await remoteRequest(
      runtimeEnv,
      "POST",
      `/v1/task-bootstrap/${encodeURIComponent(args.bootstrap_id)}/confirm`,
      {
        preview_version: args.preview_version,
        confirmed: args.confirmed,
        session_id: sessionId,
      },
    );
    if (!args.confirmed || !result.binding_packet) return result;
    const taskScope = stageTaskScopeForSession(
      dataDir,
      result.binding_packet,
      sessionId,
      runtimeEnv,
    );
    return {
      status: "confirmed",
      bootstrap_id: result.binding_packet.bootstrap_id,
      preview_version: result.binding_packet.preview_version,
      idempotent: result.idempotent === true,
      binding_packet_returned: false,
      task_scope: taskScope,
      safety: {
        resume_created: false,
        resume_packet_returned: false,
        context_injected: false,
        historical_events_rebound: false,
      },
    };
  }
  if (name === "mnemuron_confirm_resume") {
    if (
      typeof args.resume_id !== "string" ||
      !Number.isInteger(args.preview_version) ||
      typeof args.confirmed !== "boolean"
    ) {
      throw new Error("resume_id, preview_version, and confirmed are required.");
    }
    const sessionId = requireSessionId(args);
    const dataDir = resolveDataDir(runtimeEnv);
    requireCurrentMcpSessionAuthorization(dataDir, sessionId, runtimeEnv);
    const result = await remoteRequest(
      runtimeEnv,
      "POST",
      `/v1/resume/${encodeURIComponent(args.resume_id)}/confirm`,
      {
        preview_version: args.preview_version,
        confirmed: args.confirmed,
      },
    );
    if (args.confirmed && result.resume_packet) {
      const { taskScope, adapterInjection } = stageConfirmedPacket(
        dataDir,
        result.resume_packet,
        sessionId,
        runtimeEnv,
      );
      return {
        status: "confirmed",
        resume_id: result.resume_packet.resume_id,
        preview_version: result.resume_packet.preview_version,
        resume_packet_returned: false,
        task_scope: taskScope,
        adapter_injection: publicStagedDelivery(adapterInjection),
      };
    }
    return result;
  }
  if (name === "mnemuron_remember") {
    const activeScope = resolveTaskScope(
      resolveDataDir(runtimeEnv), runtimeEnv.CODEX_THREAD_ID, runtimeEnv,
    ) || {};
    const resolvedScope = memoryScope(args, activeScope, false);
    return rememberRemote(runtimeEnv, {
      content: args.content,
      scope: args.scope,
      ...(args.memory_type === undefined ? {} : { memory_type: args.memory_type }),
      ...(args.topic === undefined ? {} : { topic: args.topic }),
      ...(args.operation_id === undefined ? {} : { operation_id: args.operation_id }),
      ...resolvedScope,
    });
  }
  if (name === "mnemuron_search_memories") {
    if (typeof args.query !== "string" || !args.query.trim()) {
      throw new Error("query is required.");
    }
    return remoteRequest(runtimeEnv, "POST", "/v1/memories/query", {
      query: args.query,
      ...(args.project_id === undefined ? {} : { project_id: args.project_id }),
      ...(args.task_id === undefined ? {} : { task_id: args.task_id }),
      ...(args.source_workstream_ids === undefined
        ? {}
        : { source_workstream_ids: args.source_workstream_ids }),
      ...(args.session_id === undefined ? {} : { session_id: args.session_id }),
      ...(args.memory_types === undefined ? {} : { memory_types: args.memory_types }),
      ...(args.statuses === undefined ? {} : { statuses: args.statuses }),
      ...(args.include_shared === undefined ? {} : { include_shared: args.include_shared }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });
  }
  if (name === "mnemuron_supersede_memory") {
    if (typeof args.memory_id !== "string" || !args.memory_id.trim()
        || typeof args.content !== "string" || !args.content.trim()) {
      throw new Error("memory_id and content are required.");
    }
    return remoteRequest(
      runtimeEnv,
      "POST",
      `/v1/memories/${encodeURIComponent(args.memory_id)}/supersede`,
      {
        content: args.content,
        ...(args.reason === undefined ? {} : { reason: args.reason }),
        ...(args.memory_type === undefined ? {} : { memory_type: args.memory_type }),
        ...(args.topic === undefined ? {} : { topic: args.topic }),
      },
    );
  }
  if (name === "mnemuron_retract_memory") {
    if (typeof args.memory_id !== "string" || !args.memory_id.trim()) {
      throw new Error("memory_id is required.");
    }
    return remoteRequest(
      runtimeEnv,
      "POST",
      `/v1/memories/${encodeURIComponent(args.memory_id)}/retract`,
      args.reason === undefined ? {} : { reason: args.reason },
    );
  }
  if (name === "mnemuron_reconciliation_status") {
    if (typeof args.task_id !== "string" || !args.task_id.trim()) {
      throw new Error("task_id is required.");
    }
    return remoteRequest(
      runtimeEnv,
      "GET",
      `/v1/tasks/${encodeURIComponent(args.task_id)}/reconciliation`,
    );
  }
  if (name === "mnemuron_preview_reconciliation") {
    if (typeof args.task_id !== "string" || !args.task_id.trim()) {
      throw new Error("task_id is required.");
    }
    return remoteRequest(
      runtimeEnv,
      "POST",
      `/v1/tasks/${encodeURIComponent(args.task_id)}/reconciliation/run`,
      {
        ...(args.source_checkpoint_ids === undefined
          ? {}
          : { source_checkpoint_ids: args.source_checkpoint_ids }),
        ...(args.derive_checkpoint_operations === undefined
          ? {}
          : { derive_checkpoint_operations: args.derive_checkpoint_operations }),
        ...(args.operations === undefined ? {} : { operations: args.operations }),
      },
    );
  }
  if (name === "mnemuron_confirm_reconciliation") {
    if (typeof args.proposal_id !== "string"
        || !Number.isInteger(args.proposal_version)
        || !Number.isInteger(args.base_canonical_version)
        || typeof args.confirmed !== "boolean") {
      throw new Error(
        "proposal_id, proposal_version, base_canonical_version, and confirmed are required.",
      );
    }
    return remoteRequest(
      runtimeEnv,
      "POST",
      `/v1/task-reconciliations/${encodeURIComponent(args.proposal_id)}/resolve`,
      {
        proposal_version: args.proposal_version,
        base_canonical_version: args.base_canonical_version,
        decision: args.confirmed ? "confirm" : "reject",
      },
    );
  }
  throw new Error(`Unknown tool: ${name}`);
}

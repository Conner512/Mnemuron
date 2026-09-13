export const RESOLVER_VERSION = "combination-resolver-v0.1";

const PROJECT_THRESHOLD = 0.75;
const TASK_THRESHOLD = 0.7;
const MIN_MARGIN = 0.15;
const QUERY_NOISE = new Set([
  "a",
  "an",
  "continue",
  "last",
  "previous",
  "project",
  "resume",
  "task",
  "the",
  "work",
  "上一个",
  "上次",
  "任务",
  "继续",
  "那个",
  "项目",
]);

export function normalizeResolverText(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokens(value) {
  return normalizeResolverText(value).split(" ").filter(Boolean);
}

function normalizedArray(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(normalizeResolverText).filter(Boolean))]
    : [];
}

function normalizedPath(value) {
  const text = String(value ?? "").trim().replace(/\\/gu, "/").replace(/\/+$/u, "");
  return text ? text.toLowerCase().normalize("NFKC") : "";
}

function normalizedRemote(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^git@([^:]+):/u, "https://$1/")
    .replace(/^ssh:\/\/git@/u, "https://")
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
}

function overlapRatio(queryTokens, fields) {
  if (!queryTokens.length) return 0;
  const fieldTokens = new Set(fields.flatMap(tokens));
  const overlap = queryTokens.filter((token) => fieldTokens.has(token)).length;
  return overlap / queryTokens.length;
}

function roundScore(value) {
  return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}

function addReason(reasons, signal, weight, detail) {
  if (!(weight > 0)) return 0;
  reasons.push({ signal, weight: roundScore(weight), detail });
  return weight;
}

function candidateResult(status, query, candidates, extra = {}) {
  return {
    status,
    resolver_version: RESOLVER_VERSION,
    query,
    selection_required: status !== "resolved",
    candidates,
    ...extra,
  };
}

function finalize(query, candidates, {
  threshold,
  scopeOnly = false,
  hardMiss = false,
  emptyCandidates = [],
} = {}) {
  const ordered = candidates
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score
      || String(left.id).localeCompare(String(right.id)));
  if (hardMiss || (!ordered.length && !scopeOnly)) {
    return candidateResult("no_match", query, ordered.slice(0, 5), {
      reason: hardMiss ? "explicit_identifier_not_found" : "no_candidate_reached_minimum_signal",
    });
  }
  if (scopeOnly) {
    return candidateResult("ambiguous", query, emptyCandidates.slice(0, 10), {
      reason: "project_scope_has_no_task_signal",
    });
  }
  const [top, second] = ordered;
  const margin = second ? roundScore(top.score - second.score) : top.score;
  const qualified = top.strong || top.score >= threshold;
  if (qualified && (!second || margin >= MIN_MARGIN)) {
    return candidateResult("resolved", query, ordered.slice(0, 5), {
      match: top,
      confidence: top.strong ? "high" : "medium",
      margin,
    });
  }
  return candidateResult("ambiguous", query, ordered.slice(0, 10), {
    reason: qualified ? "candidate_margin_too_small" : "candidate_confidence_too_low",
    margin,
  });
}

function explicitIdentifier(query, prefix) {
  const expression = new RegExp(`\\b${prefix}-[a-zA-Z0-9][a-zA-Z0-9_-]*\\b`, "giu");
  return [...String(query ?? "").matchAll(expression)].map((match) => match[0].toLowerCase());
}

export function resolveProjectCandidates({
  projects,
  query,
  signals = {},
  historyByProject = new Map(),
}) {
  const explicitId = signals.project_id || explicitIdentifier(query, "project")[0] || null;
  if (explicitId) {
    const match = projects.find((project) => project.project_id === explicitId);
    if (!match) return finalize(query, [], { threshold: PROJECT_THRESHOLD, hardMiss: true });
    return finalize(query, [{
      id: match.project_id,
      project_id: match.project_id,
      name: match.name,
      score: 1,
      strong: true,
      reasons: [{ signal: "project_id_exact", weight: 1, detail: "explicit project_id" }],
    }], { threshold: PROJECT_THRESHOLD });
  }

  const normalizedQuery = normalizeResolverText(query);
  const queryTokens = tokens(query).filter((token) => !QUERY_NOISE.has(token));
  const inputRemote = normalizedRemote(signals.git_remote);
  const inputFingerprint = normalizeResolverText(signals.repo_fingerprint);
  const inputPath = normalizedPath(signals.cwd);
  const candidates = projects.map((project) => {
    const reasons = [];
    let score = 0;
    let strong = false;
    const names = normalizedArray([project.name, ...(project.aliases || [])]);
    if (normalizedQuery && names.includes(normalizedQuery)) {
      score += addReason(reasons, "project_name_exact", 0.8, "project name or alias");
      strong = true;
    } else if (normalizedQuery && names.some((name) => normalizedQuery.includes(name))) {
      score += addReason(reasons, "project_name_phrase", 0.6, "project name or alias in query");
    } else {
      const overlap = overlapRatio(queryTokens, names);
      score += addReason(reasons, "project_name_tokens", overlap * 0.35, "project token overlap");
    }

    if (inputRemote && (project.git_remotes || []).map(normalizedRemote).includes(inputRemote)) {
      score += addReason(reasons, "git_remote_exact", 0.9, "repository remote");
      strong = true;
    }
    if (inputFingerprint && normalizedArray(project.repo_fingerprints).includes(inputFingerprint)) {
      score += addReason(reasons, "repo_fingerprint_exact", 0.95, "repository fingerprint");
      strong = true;
    }
    if (inputPath) {
      const pathMatch = (project.path_hints || [])
        .map(normalizedPath)
        .filter(Boolean)
        .some((hint) => inputPath === hint || inputPath.startsWith(`${hint}/`) || hint.startsWith(`${inputPath}/`));
      if (pathMatch) score += addReason(reasons, "path_hint", 0.25, "cwd/path hint; never sufficient alone");
    }
    const priorSelections = Number(historyByProject.get(project.project_id) || 0);
    if (priorSelections > 0) {
      score += addReason(
        reasons,
        "prior_confirmation",
        Math.min(0.9, 0.75 + (priorSelections - 1) * 0.05),
        `${priorSelections} matching confirmation(s)`,
      );
    }
    return {
      id: project.project_id,
      project_id: project.project_id,
      name: project.name,
      score: roundScore(score),
      strong,
      reasons,
    };
  });
  return finalize(query, candidates, { threshold: PROJECT_THRESHOLD });
}

function taskText(task) {
  return [
    task.goal,
    ...(task.progress || []),
    ...(task.decisions || []),
    ...(task.blockers || []),
    ...(task.next_steps || []),
  ].map((value) => typeof value === "string" ? value : JSON.stringify(value));
}

function taskQueryTokens(query, project) {
  const projectTokens = new Set([
    project?.name,
    ...(project?.aliases || []),
  ].flatMap(tokens));
  return tokens(query).filter((token) => !QUERY_NOISE.has(token) && !projectTokens.has(token));
}

function cleanedFieldTokens(value, project) {
  const projectTokens = new Set([
    project?.name,
    ...(project?.aliases || []),
  ].flatMap(tokens));
  return tokens(value).filter((token) => !projectTokens.has(token));
}

function cleanedText(value, project) {
  return cleanedFieldTokens(value, project).join(" ");
}

export function resolveTaskCandidates({
  tasks,
  projectsById = new Map(),
  query,
  signals = {},
  selectedProjectId = null,
  historyByTask = new Map(),
  associationsByTask = new Map(),
}) {
  const explicitIds = signals.task_id
    ? [signals.task_id]
    : explicitIdentifier(query, "task");
  const scopedTasks = selectedProjectId
    ? tasks.filter((task) => task.project_id === selectedProjectId)
    : tasks;
  if (explicitIds.length) {
    const matches = scopedTasks.filter((task) => explicitIds.includes(task.task_id));
    if (!matches.length) return finalize(query, [], { threshold: TASK_THRESHOLD, hardMiss: true });
    const exact = matches.map((task) => ({
      id: task.task_id,
      task_id: task.task_id,
      title: task.title,
      project_id: task.project_id,
      project_name: task.project_name,
      task_status: task.status,
      conflict_count: (task.conflicts || []).length,
      score: 1,
      strong: true,
      reasons: [{ signal: "task_id_exact", weight: 1, detail: "explicit task_id" }],
    }));
    return finalize(query, exact, { threshold: TASK_THRESHOLD });
  }

  const queryHasAnyTaskSignal = scopedTasks.some((task) => {
    const project = projectsById.get(task.project_id) || { name: task.project_name, aliases: [] };
    return taskQueryTokens(query, project).length > 0;
  });
  if (selectedProjectId && !queryHasAnyTaskSignal) {
    const candidates = scopedTasks
      .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))
      .map((task) => ({
        id: task.task_id,
        task_id: task.task_id,
        title: task.title,
        project_id: task.project_id,
        project_name: task.project_name,
        task_status: task.status,
        conflict_count: (task.conflicts || []).length,
        score: 0,
        strong: false,
        reasons: [{ signal: "project_scope_only", weight: 0, detail: "explicit task selection required" }],
      }));
    return finalize(query, [], { threshold: TASK_THRESHOLD, scopeOnly: true, emptyCandidates: candidates });
  }

  const candidates = scopedTasks.map((task) => {
    const project = projectsById.get(task.project_id) || { name: task.project_name, aliases: [] };
    const queryTokens = taskQueryTokens(query, project);
    const queryText = queryTokens.join(" ");
    const title = cleanedText(task.title, project);
    const aliases = (task.aliases || []).map((alias) => cleanedText(alias, project)).filter(Boolean);
    const titleFields = [title, ...aliases].filter(Boolean);
    const reasons = [];
    let score = 0;
    let strong = false;
    if (queryText && titleFields.includes(queryText)) {
      score += addReason(reasons, "task_title_exact", 0.85, "task title or alias");
      strong = true;
    } else if (queryText && titleFields.some((field) => field.includes(queryText)
      || ((tokens(field).length >= 2 || /\p{Script=Han}{2,}/u.test(field))
        && queryText.includes(field)))) {
      score += addReason(reasons, "task_title_phrase", 0.7, "task title or alias phrase");
      strong = true;
    } else {
      const overlap = overlapRatio(queryTokens, titleFields);
      score += addReason(reasons, "task_title_tokens", overlap * 0.55, "task title or alias token overlap");
    }

    const contentOverlap = overlapRatio(queryTokens, taskText(task));
    score += addReason(reasons, "task_content_tokens", contentOverlap * 0.25, "goal or task-history token overlap");
    const workstreamFields = (task.workstreams || []).flatMap((workstream) => [
      workstream.workstream_id,
      workstream.name,
    ]).filter(Boolean);
    const workstreamOverlap = overlapRatio(queryTokens, workstreamFields);
    score += addReason(reasons, "workstream_tokens", workstreamOverlap * 0.45, "workstream token overlap");

    const association = associationsByTask.get(task.task_id) || {};
    if (association.agent_instance_hits > 0) {
      score += addReason(reasons, "agent_instance_history", 0.3, "current Agent instance previously wrote this Task");
    } else if (association.device_hits > 0) {
      score += addReason(reasons, "device_history", 0.12, "current device previously wrote this Task");
    } else if (association.agent_hits > 0) {
      score += addReason(reasons, "agent_history", 0.06, "current Agent type previously wrote this Task");
    }
    const recentAt = association.recent_activity_at;
    if (recentAt && Date.now() - Date.parse(recentAt) <= 7 * 86_400_000) {
      score += addReason(reasons, "recent_activity", 0.08, "activity within seven days");
    }
    const priorSelections = Number(historyByTask.get(task.task_id) || 0);
    if (priorSelections > 0) {
      score += addReason(
        reasons,
        "prior_confirmation",
        Math.min(0.85, 0.7 + (priorSelections - 1) * 0.05),
        `${priorSelections} matching confirmation(s)`,
      );
    }
    if (score > 0 && task.status === "active") {
      score += addReason(reasons, "active_status_tiebreak", 0.03, "active Task tie-break only");
    }
    return {
      id: task.task_id,
      task_id: task.task_id,
      title: task.title,
      project_id: task.project_id,
      project_name: task.project_name,
      task_status: task.status,
      conflict_count: (task.conflicts || []).length,
      score: roundScore(score),
      strong,
      reasons,
    };
  });
  return finalize(query, candidates, { threshold: TASK_THRESHOLD });
}

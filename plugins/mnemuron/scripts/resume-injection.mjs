function text(value, limit) {
  const rendered = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
  if (rendered.length <= limit) return rendered;
  return `${rendered.slice(0, Math.max(0, limit - 12))}…[truncated]`;
}

function items(values, limit, textLimit) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, limit).map((value) => {
    if (typeof value === "string") return text(value, textLimit);
    if (!value || typeof value !== "object") return value;
    return {
      text: text(value.text ?? value.content ?? value, textLimit),
      source_event_id: value.source_event_id ?? undefined,
      source_status: value.source_status ?? undefined,
    };
  });
}

function checkpoint(value) {
  return {
    checkpoint_id: value?.checkpoint_id,
    version: value?.version,
    workstream_id: value?.workstream_id,
    session_id: value?.session_id,
    created_at: value?.created_at,
    goal: text(value?.goal, 1_000),
    latest_outcome: text(value?.latest_outcome, 1_200),
    blockers: items(value?.blockers, 8, 400),
    unfinished_items: items(value?.unfinished_items, 8, 400),
    recommended_next_steps: items(value?.recommended_next_steps, 8, 400),
    provenance: value?.provenance,
    generation: value?.generation,
  };
}

export function buildResumeInjectionText(packet, maxChars = 24 * 1024) {
  if (!packet || typeof packet !== "object") throw new Error("Resume Packet is invalid.");
  const context = packet.context || {};
  const summary = {
    schema_version: "mnemuron-resume-injection-v0.1",
    resume_id: packet.resume_id,
    preview_version: packet.preview_version,
    project: packet.project,
    task: packet.task,
    selected_workstreams: packet.selected_workstreams,
    branch_selection: packet.branch_selection,
    context: {
      goal: text(context.goal, 1_800),
      progress: items(context.progress, 20, 700),
      decisions: items(context.decisions, 16, 700),
      blockers: items(context.blockers, 12, 700),
      next_steps: items(context.next_steps, 16, 700),
      resources: items(context.resources, 20, 500),
      conflicts: items(context.conflicts, 12, 700),
      latest_checkpoints: Array.isArray(context.latest_checkpoints)
        ? context.latest_checkpoints.slice(0, 4).map(checkpoint)
        : [],
      structured_memories: Array.isArray(context.structured_memories)
        ? context.structured_memories.slice(0, 8).map((memory) => ({
          memory_id: memory?.memory_id,
          scope: memory?.scope,
          content: text(memory?.content, 700),
          provenance: memory?.provenance,
        }))
        : [],
      recent_activity: Array.isArray(context.recent_activity)
        ? context.recent_activity.slice(-8).map((activity) => ({
          event_id: activity?.event_id,
          event_type: activity?.event_type,
          captured_at: activity?.captured_at,
          workstream_id: activity?.workstream_id,
          content: text(activity?.content, 500),
          provenance: activity?.provenance,
        }))
        : [],
    },
    provenance: packet.provenance,
    injection_authorized_at: packet.injection_authorized_at,
    compaction: {
      source_packet_chars: JSON.stringify(packet).length,
      selective_context: true,
      raw_records_remain_in_mnemuron: true,
    },
  };
  const render = () => [
    "Mnemuron Resume Packet（用户已确认；选择性上下文）",
    "该 Packet 已通过 Preview 和用户显式确认，是本轮恢复的权威开发者上下文。",
    "请直接基于它继续任务；不要为同一 Task 再次 Preview 或 Confirm。",
    JSON.stringify(summary, null, 2),
  ].join("\n");
  let rendered = render();
  if (rendered.length > maxChars) {
    summary.context.recent_activity = [];
    summary.context.structured_memories = [];
    summary.compaction.secondary_context_omitted = true;
    rendered = render();
  }
  if (rendered.length > maxChars) {
    summary.context.progress = summary.context.progress.slice(0, 8);
    summary.context.decisions = summary.context.decisions.slice(0, 8);
    summary.context.resources = summary.context.resources.slice(0, 8);
    summary.context.latest_checkpoints = summary.context.latest_checkpoints.map((item) => ({
      checkpoint_id: item.checkpoint_id,
      version: item.version,
      workstream_id: item.workstream_id,
      created_at: item.created_at,
      latest_outcome: item.latest_outcome,
      blockers: item.blockers,
      unfinished_items: item.unfinished_items,
      recommended_next_steps: item.recommended_next_steps,
      provenance: item.provenance,
    }));
    summary.compaction.canonical_context_reduced = true;
    rendered = render();
  }
  if (rendered.length > maxChars) {
    throw new Error(`Selective Resume Packet still exceeds ${maxChars} characters.`);
  }
  return rendered;
}

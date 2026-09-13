import test from "node:test";
import assert from "node:assert/strict";
import { prepareTool } from "../src/tools.mjs";

test("oversized project previews preserve read-only memory references within the full wire budget", async () => {
  const original = {
    schema_version: "project-memory-preview-v0.1", status: "project_context_preview", read_only: true,
    project: { project_id: "project-example", name: "Example" }, query: "Example",
    tasks: [{ task_id: "task-example", title: "Example", status: "active", canonical_version: 3,
      canonical_freshness: "updates_pending", conflicts: ["review needed"], progress: ["x".repeat(20000)],
      latest_checkpoints: [{ checkpoint_id: "checkpoint-example", content: "y".repeat(20000) }] }],
    structured_memories: [{ memory_id: "memory-example", content: "😀记忆".repeat(200),
      project_id: "project-example", workstream_id: "branch-example", status: "active", source: "explicit",
      provenance: { agent_instance_id: "agent-example" }, content_truncated: false }],
    recent_activity: [{ content: "z".repeat(20000) }],
    source_summary: { task_count: 1, latest_checkpoint_count: 1, structured_memory_count: 1 },
    projection: { fallback_compaction_applied: false },
    next_action: { type: "select_task_for_resume_preview" },
  };
  const saved = structuredClone(original);
  const config = { tool_profile: "readonly", limits: { tool_response_bytes: 8192 } };
  const context = { config, auth: { scopes: new Set(["project:read"]) }, core: { call: async () => original }, id: "bounded" };
  const result = await prepareTool("mnemuron_preview_project_context", { query: "Example" }, context);
  assert.deepEqual(original, saved);
  assert.equal(result.tasks[0].canonical_version, 3);
  assert.equal(result.tasks[0].has_conflicts, true);
  assert.equal(result.tasks[0].canonical_freshness, "updates_pending");
  assert.deepEqual(result.structured_memories[0].provenance, original.structured_memories[0].provenance);
  assert.equal(result.structured_memories[0].memory_id, "memory-example");
  assert.equal(Array.from(result.structured_memories[0].content).length, 160);
  assert.equal(result.structured_memories[0].content_truncated, true);
  assert.equal(result.projection.full_context_returned, false);
  assert.deepEqual(result.tasks[0].field_availability.progress, { recorded: true, item_count: 1, returned: 'omitted' });
  assert.deepEqual(result.tasks[0].field_availability.goal, { recorded: null, item_count: null, returned: 'omitted' });
  assert.equal(result.task_detail_action, undefined);
  assert.equal(result.next_action.tool, "mnemuron_get_memory");
  assert.deepEqual(result.safety, { resume_created: false, task_scope_changed: false, context_injected: false });
  const wire = { jsonrpc: "2.0", id: "bounded", result: { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] } };
  assert(Buffer.byteLength(JSON.stringify(wire)) <= config.limits.tool_response_bytes);
  config.limits.tool_response_bytes = 1024;
  await assert.rejects(prepareTool("mnemuron_preview_project_context", { query: "Example" }, context), error => error.code === "TOOL_RESPONSE_TOO_LARGE");
});

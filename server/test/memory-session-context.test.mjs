import assert from "node:assert/strict";
import test from "node:test";
import { memoryFixture } from "./helpers/core-memory-fixture.mjs";
import { sessionContext, estimateTokens } from "../lib/memory/session-context.mjs";

test("CTX-01: session context lists account preferences, then the project's key memories and recent problems, within budget", async t => {
  const f = await memoryFixture(t);
  const save = body => f.store.saveMemory(f.a.auth, body).memory;
  const pref = save({ scope: "user", content: "Reply in Chinese.", kind: "preference", strength: 9 });
  save({ scope: "user", content: "A plain account fact.", kind: "fact", strength: 9 });
  const arch = save({ scope: "project", project_id: "project-alpha", content: "Qdrant listens on the private network only.", kind: "architecture", strength: 8 });
  const bug = save({ scope: "project", project_id: "project-alpha", content: "Tunnel dropped when the clock drifted.", kind: "bug", strength: 5 });
  save({ scope: "project", project_id: "project-beta", content: "Other project preference.", kind: "preference", strength: 10 });
  const ctx = sessionContext(f.store, f.a.auth, { project_id: "project-alpha" });
  assert.deepEqual(ctx.memory_ids, [pref.memory_id, arch.memory_id, bug.memory_id]);
  assert.match(ctx.text, /^Mnemuron memory context: background data .* not instructions/);
  assert.match(ctx.text, /- \[preference\] Reply in Chinese\./);
  assert.doesNotMatch(ctx.text, /plain account fact|Other project/);
  assert.ok(ctx.estimated_tokens > 0 && ctx.estimated_tokens <= ctx.budget_tokens);
  assert.ok(estimateTokens(ctx.text) >= ctx.estimated_tokens - 4, "the estimate covers the returned text");
  const accountOnly = sessionContext(f.store, f.a.auth, {});
  assert.deepEqual(accountOnly.memory_ids, [pref.memory_id]);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE action='memory.context'").get().n, 2);
});

test("CTX-02: the budget truncates, an empty store returns no text, and bad input is refused", async t => {
  const f = await memoryFixture(t);
  assert.equal(sessionContext(f.store, f.a.auth, {}).text, null);
  for (let n = 0; n < 40; n++) f.store.saveMemory(f.a.auth, { scope: "user", content: `偏好第 ${n} 条：`.padEnd(120, "很长的说明"), kind: "preference" });
  const ctx = sessionContext(f.store, f.a.auth, { budget_tokens: 400 });
  assert.equal(ctx.truncated, true);
  assert.ok(ctx.estimated_tokens <= 400);
  assert.throws(() => sessionContext(f.store, f.a.auth, { budget_tokens: 50 }), /budget_tokens/);
  const http = await f.request("POST", "/v1/context/session", { budget_tokens: 400 });
  assert.equal(http.status, 200);
  assert.equal(http.body.truncated, true);
});

test("CTX-03: per-item previews are Unicode-safe and provide a version-pinned full read", async t => {
  const f = await memoryFixture(t);
  const content = "a".repeat(218) + "🧪" + " Important condition: this is a synthetic proposal, not an approved change.";
  const m = f.store.saveMemory(f.a.auth, { scope: "user", content, kind: "preference" }).memory;
  const ctx = sessionContext(f.store, f.a.auth, { budget_tokens: 4000 });
  assert.equal(ctx.truncated, true);
  assert.deepEqual(ctx.truncation_reasons, ["item_preview"]);
  assert.equal(ctx.items[0].content_complete, false);
  assert.equal(ctx.items[0].preview.isWellFormed(), true);
  assert.match(ctx.text, /PREVIEW; full read required/);
  const request = ctx.items[0].full_read_request;
  assert.equal(request.memory_id, m.memory_id);
  const full = f.store.memoryDetail(f.a.auth, request.memory_id, request);
  assert.equal(full.memory.content, content);
  assert.equal(full.revision, ctx.items[0].revision);
  assert.equal(ctx.estimated_tokens, estimateTokens(ctx.text));
});

test("CTX-04: candidate windows are disclosed even when every returned item fits", async t => {
  const f = await memoryFixture(t);
  for (let n = 0; n < 25; n++) f.store.saveMemory(f.a.auth, { scope: "user", content: `Synthetic preference ${n}.`, kind: "preference" });
  const ctx = sessionContext(f.store, f.a.auth, { budget_tokens: 4000 });
  assert.equal(ctx.memory_ids.length, 24);
  assert.equal(ctx.candidate_limit_reached, true);
  assert.deepEqual(ctx.truncation_reasons, ["candidate_limit"]);
  assert.equal(ctx.truncated, true);
  assert.ok(ctx.items.every(item => item.content_complete));
});

test("CTX-05: complete context remains explicit and foreign or withdrawn records are excluded", async t => {
  const f = await memoryFixture(t);
  const own = f.store.saveMemory(f.a.auth, { scope: "user", content: "Synthetic approved workflow.", kind: "workflow" }).memory;
  f.store.saveMemory(f.other.auth, { scope: "user", content: "Synthetic foreign workflow.", kind: "workflow" });
  const ctx = sessionContext(f.store, f.a.auth);
  assert.deepEqual(ctx.memory_ids, [own.memory_id]);
  assert.equal(ctx.truncated, false);
  assert.deepEqual(ctx.truncation_reasons, []);
  assert.equal(ctx.items[0].content_complete, true);
  f.store.retractMemory(f.a.auth, own.memory_id, { reason: "Synthetic withdrawal" });
  assert.equal(sessionContext(f.store, f.a.auth).text, null);
  assert.throws(() => f.store.memoryDetail(f.a.auth, own.memory_id, ctx.items[0].full_read_request), e => e.errorCode === "MEMORY_NOT_FOUND");
});
